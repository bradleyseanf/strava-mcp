#!/usr/bin/env node
import dotenv from "dotenv";
import express from "express";
import type { RequestHandler } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadConfig, saveConfig } from "./config.js";
import { registerStravaTools } from "./mcpTools.js";
import { loadRuntimeConfig, assertHttpsPublicUrl } from "./runtime.js";
import { PersonalOAuthProvider } from "./auth/provider.js";
import type { PendingAuthorizationContext } from "./auth/provider.js";
import {
    chatgptLoginErrorPage,
    chatgptLoginPage,
} from "./auth/pages.js";
import {
    createSessionCookie,
    verifySessionCookie,
} from "./auth/session.js";
import { getServerInfo, SERVER_NAME } from "./serverInfo.js";

dotenv.config();

const SESSION_COOKIE_NAME = "strava_mcp_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MCP_SCOPES = ["mcp:tools"];
const LOGIN_RATE_LIMIT = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
});
const MCP_RATE_LIMIT = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
});

type LoginFormInput = {
    requestId?: string;
    email?: string;
    password?: string;
    clientId?: string;
    redirectUri?: string;
    codeChallenge?: string;
    scopes?: string;
    state?: string;
    resource?: string;
};

function decodeFormComponent(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
        return value;
    }
}

const attachBasicClientCredentials: RequestHandler = (req, _res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Basic ")) {
        next();
        return;
    }

    const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
        next();
        return;
    }

    const body = req.body as Record<string, string | undefined>;
    body.client_id ??= decodeFormComponent(decoded.slice(0, separator));
    body.client_secret ??= decodeFormComponent(decoded.slice(separator + 1));
    next();
};

function buildMcpServer(version: string, includeAdminTools: boolean): McpServer {
    const server = new McpServer({
        name: SERVER_NAME,
        version,
    });

    registerStravaTools(server, { includeAdminTools });
    return server;
}

function applyBootstrappedStravaEnv(config: Awaited<ReturnType<typeof loadConfig>>): void {
    if (config.clientId && !process.env.STRAVA_CLIENT_ID) {
        process.env.STRAVA_CLIENT_ID = config.clientId;
    }
    if (config.clientSecret && !process.env.STRAVA_CLIENT_SECRET) {
        process.env.STRAVA_CLIENT_SECRET = config.clientSecret;
    }
    if (config.accessToken && !process.env.STRAVA_ACCESS_TOKEN) {
        process.env.STRAVA_ACCESS_TOKEN = config.accessToken;
    }
    if (config.refreshToken && !process.env.STRAVA_REFRESH_TOKEN) {
        process.env.STRAVA_REFRESH_TOKEN = config.refreshToken;
    }
}

async function persistBootstrapConfig(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): Promise<void> {
    const bootstrapConfig = {
        clientId: config.stravaClientId,
        clientSecret: config.stravaClientSecret,
        accessToken: config.stravaAccessToken,
        refreshToken: config.stravaRefreshToken,
    };
    if (
        bootstrapConfig.clientId ||
        bootstrapConfig.clientSecret ||
        bootstrapConfig.accessToken ||
        bootstrapConfig.refreshToken
    ) {
        await saveConfig(bootstrapConfig);
    }
}

function routePath(basePath: string, suffix: string): string {
    const cleanBase = basePath.replace(/\/+$/, "");
    const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
    return `${cleanBase}${cleanSuffix}` || cleanSuffix;
}

function parsePendingAuthorization(form: LoginFormInput): PendingAuthorizationContext | null {
    const requestId = String(form.requestId ?? "");
    const clientId = String(form.clientId ?? "");
    const redirectUri = String(form.redirectUri ?? "");
    const codeChallenge = String(form.codeChallenge ?? "");
    if (!requestId || !clientId || !redirectUri || !codeChallenge) {
        return null;
    }

    return {
        requestId,
        clientId,
        redirectUri,
        codeChallenge,
        scopes: String(form.scopes ?? "")
            .split(" ")
            .map((scope) => scope.trim())
            .filter(Boolean),
        state: String(form.state ?? "") || undefined,
        resource: String(form.resource ?? "") || undefined,
    };
}

function renderLoginForRequest(
    requestId: string,
    allowedEmail: string,
    pending?: PendingAuthorizationContext | null,
    error?: string,
): string {
    return chatgptLoginPage({
        requestId,
        allowedEmail,
        pending: pending ?? undefined,
        error,
    });
}

async function startRemoteServer(
    runtime: Awaited<ReturnType<typeof loadRuntimeConfig>>,
    provider: PersonalOAuthProvider,
    version: string,
): Promise<void> {
    assertHttpsPublicUrl(runtime);

    const app = express();
    const authPath = routePath(runtime.publicBasePath, "/auth");
    const loginPath = routePath(authPath, "/login");
    const healthPath = routePath(runtime.publicBasePath, "/health");
    const mcpPath = routePath(runtime.publicBasePath, "/mcp");

    app.set("trust proxy", 1);
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.json({ limit: "1mb" }));
    app.use(express.urlencoded({ extended: false, limit: "16kb" }));
    app.use(cookieParser());
    app.use("/token", attachBasicClientCredentials);

    app.use(
        mcpAuthRouter({
            provider,
            issuerUrl: runtime.authBaseUrl!,
            baseUrl: runtime.authBaseUrl!,
            resourceServerUrl: runtime.mcpUrl!,
            resourceName: "Strava Coach",
            serviceDocumentationUrl: runtime.publicBaseUrl,
            scopesSupported: MCP_SCOPES,
        }),
    );

    app.get(healthPath, (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json({
            ok: true,
            mode: "remote",
            version,
            mcpUrl: runtime.mcpUrl?.toString(),
        });
    });

    app.get(loginPath, async (req, res) => {
        const requestId = String(req.query.request_id ?? "");
        if (!requestId) {
            res.status(400).type("html").send(chatgptLoginErrorPage("Missing request_id."));
            return;
        }

        const pending = await provider.getPendingAuthorization(requestId);

        const session = verifySessionCookie(req.cookies[SESSION_COOKIE_NAME], runtime.sessionSecret!);
        if (session?.email) {
            try {
                const redirectUrl = await provider.finalizeAuthorization(requestId, session.email);
                res.redirect(302, redirectUrl);
                return;
            } catch (error) {
                res.status(400).type("html").send(chatgptLoginErrorPage(error instanceof Error ? error.message : String(error)));
                return;
            }
        }

        res.type("html").send(renderLoginForRequest(requestId, provider.allowedEmail, pending));
    });

    app.post(loginPath, LOGIN_RATE_LIMIT, async (req, res) => {
        const form = req.body as LoginFormInput;
        const { requestId, email, password } = form;
        if (!requestId || !email || !password) {
            res.status(400).type("html").send(chatgptLoginErrorPage("Missing requestId, email, or password."));
            return;
        }

        const pending = parsePendingAuthorization(form) ?? await provider.getPendingAuthorization(requestId);

        if (!provider.validateLogin(email, password)) {
            res.status(401).type("html").send(renderLoginForRequest(requestId, provider.allowedEmail, pending, "Invalid email or session secret."));
            return;
        }

        const sessionCookie = createSessionCookie(email.toLowerCase(), runtime.sessionSecret!, SESSION_COOKIE_MAX_AGE_SECONDS);
        res.cookie(SESSION_COOKIE_NAME, sessionCookie, {
            httpOnly: true,
            secure: runtime.publicBaseUrl?.protocol === "https:",
            sameSite: "lax",
            maxAge: SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
            path: authPath,
        });

        try {
            const redirectUrl = pending
                ? await provider.finalizeAuthorizationFromContext(pending, email)
                : await provider.finalizeAuthorization(requestId, email);
            res.redirect(302, redirectUrl);
        } catch (error) {
            res.status(400).type("html").send(renderLoginForRequest(requestId, provider.allowedEmail, pending, error instanceof Error ? error.message : String(error)));
        }
    });

    app.all(
        mcpPath,
        MCP_RATE_LIMIT,
        requireBearerAuth({
            verifier: provider,
            requiredScopes: MCP_SCOPES,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(runtime.mcpUrl!),
        }),
        async (req, res) => {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            const mcpServer = buildMcpServer(version, false);
            const cleanup = () => {
                void transport.close();
                void mcpServer.close();
            };

            try {
                res.on("close", cleanup);
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error("MCP request failed.");
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32603,
                            message: "Internal server error",
                        },
                        id: null,
                    });
                }
                cleanup();
                return;
            }
        },
    );

    const port = Number(process.env.PORT ?? 3000);
    await new Promise<void>((resolve, reject) => {
        const listener = app.listen(port, () => {
            console.error(`Remote MCP server listening on ${runtime.publicBaseUrl?.origin ?? "http://localhost"}:${port}${runtime.publicBasePath}`);
            resolve();
        });

        listener.on("error", (error) => {
            reject(error);
        });

        process.on("SIGINT", () => {
            listener.close(() => process.exit(0));
        });
        process.on("SIGTERM", () => {
            listener.close(() => process.exit(0));
        });
    });
}

async function startStdioServer(version: string): Promise<void> {
    const server = buildMcpServer(version, true);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} v${version} connected via stdio.`);
}

async function main(): Promise<void> {
    try {
        const runtime = loadRuntimeConfig();
        const { version: serverVersion } = getServerInfo();

        if (runtime.nodeEnv !== "production") {
            console.error("Warning: running in non-production mode.");
        }
        if (runtime.nodeEnv === "production" && !runtime.isRemoteMode) {
            throw new Error("PUBLIC_BASE_URL is required in production. Stdio mode is development-only.");
        }
        if (runtime.isRemoteMode) {
            if (!runtime.publicBaseUrl) {
                throw new Error("PUBLIC_BASE_URL is required for remote mode.");
            }
            if (!runtime.authBaseUrl || !runtime.mcpUrl || !runtime.healthUrl) {
                throw new Error("Failed to derive remote app URLs.");
            }
            if (!runtime.sessionSecret) {
                throw new Error("SESSION_SECRET is required for remote mode.");
            }
            if (!runtime.tokenEncryptionKey) {
                throw new Error("TOKEN_ENCRYPTION_KEY is required for remote mode.");
            }
            if (!runtime.allowedUserEmail) {
                throw new Error("ALLOWED_USER_EMAIL is required for remote mode.");
            }
            await persistBootstrapConfig(runtime);
            const storedConfig = await loadConfig();
            applyBootstrappedStravaEnv(storedConfig);

            if (!storedConfig.accessToken || !storedConfig.refreshToken) {
                console.error("Warning: no Strava access/refresh tokens are configured yet. Bootstrap them before using the MCP tools.");
            }

            const provider = new PersonalOAuthProvider({
                authBaseUrl: runtime.authBaseUrl,
                resourceServerUrl: runtime.mcpUrl,
                allowedUserEmail: runtime.allowedUserEmail,
                sessionSecret: runtime.sessionSecret,
                nodeEnv: runtime.nodeEnv,
            });

            await startRemoteServer(runtime, provider, serverVersion);
            return;
        }

        const storedConfig = await loadConfig();
        applyBootstrappedStravaEnv(storedConfig);
        await startStdioServer(serverVersion);
    } catch (error) {
        console.error("Failed to start server.");
        if (error instanceof Error) {
            console.error(error.message);
        }
        process.exit(1);
    }
}

void main();
