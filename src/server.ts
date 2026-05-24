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
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { clearConfig, hasClientCredentials, loadConfig, saveClientCredentials, saveConfig } from "./config.js";
import { registerStravaTools } from "./mcpTools.js";
import { loadRuntimeConfig, assertHttpsPublicUrl } from "./runtime.js";
import { PersonalOAuthProvider } from "./auth/provider.js";
import { refreshAccessToken } from "./stravaClient.js";
import { requestStravaOAuthToken } from "./stravaOAuth.js";
import type { PendingAuthorizationContext } from "./auth/provider.js";
import {
    chatgptLoginErrorPage,
    chatgptLoginPage,
    credentialsExistPage,
    errorPage,
    setupPage,
    successPage,
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
    if (config.clientId) {
        process.env.STRAVA_CLIENT_ID = config.clientId;
    }
    if (config.clientSecret) {
        process.env.STRAVA_CLIENT_SECRET = config.clientSecret;
    }
    if (config.accessToken) {
        process.env.STRAVA_ACCESS_TOKEN = config.accessToken;
    }
    if (config.refreshToken) {
        process.env.STRAVA_REFRESH_TOKEN = config.refreshToken;
    }
}

async function ensureFreshStravaAccessToken(): Promise<void> {
    const config = await loadConfig();
    const tokenIsStale = !config.accessToken || !config.expiresAt || config.expiresAt <= Date.now() + 60_000;

    if (!tokenIsStale) {
        return;
    }

    if (!config.refreshToken || !config.clientId || !config.clientSecret) {
        return;
    }

    try {
        await refreshAccessToken();
    } catch (error) {
        console.error(
            `Unable to refresh Strava access token at startup: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function persistBootstrapConfig(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): Promise<void> {
    const bootstrapConfig = {
        clientId: config.stravaClientId,
        clientSecret: config.stravaClientSecret,
        refreshToken: config.stravaRefreshToken,
    };
    if (
        bootstrapConfig.clientId ||
        bootstrapConfig.clientSecret ||
        bootstrapConfig.refreshToken
    ) {
        await saveConfig(bootstrapConfig);
    }
}

function routePath(basePath: string, suffix: string): string {
    const cleanBase = basePath.replace(/\/+$/, "");
    if (!suffix) {
        return cleanBase || "/";
    }

    const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
    return `${cleanBase}${cleanSuffix}` || cleanSuffix;
}

function buildPublicUrl(baseUrl: URL, path: string): string {
    return `${baseUrl.origin}${path}`;
}

function buildStravaAuthorizeUrl(clientId: string, redirectUri: string): string {
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        approval_prompt: "force",
        scope: "profile:read_all,activity:read_all,activity:read,profile:write",
    });
    return `https://www.strava.com/oauth/authorize?${params.toString()}`;
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
    const rootMcpPath = routePath(runtime.publicBasePath, "");
    const ssePath = routePath(runtime.publicBasePath, "/sse");
    const mcpSsePath = routePath(mcpPath, "/sse");
    const messagesPath = routePath(runtime.publicBasePath, "/messages");
    const mcpMessagesPath = routePath(mcpPath, "/messages");
    const authRouterOptions = {
        provider,
        issuerUrl: runtime.authBaseUrl!,
        baseUrl: runtime.authBaseUrl!,
        resourceServerUrl: runtime.publicBaseUrl!,
        resourceName: "Strava Coach",
        serviceDocumentationUrl: runtime.publicBaseUrl,
        scopesSupported: MCP_SCOPES,
    };
    const rootTokenPath = routePath(runtime.publicBasePath, "/token");
    const authTokenPath = routePath(runtime.publicBasePath, "/auth/token");
    const rootAuthMountPath = routePath(runtime.publicBasePath, "");
    const authMountPath = routePath(runtime.publicBasePath, "/auth");
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(runtime.publicBaseUrl!);
    const stravaRootPath = routePath(runtime.publicBasePath, "/strava");
    const stravaSetupPath = routePath(stravaRootPath, "/setup");
    const stravaAuthPath = routePath(stravaRootPath, "/auth");
    const stravaCallbackPath = routePath(stravaRootPath, "/callback");
    const stravaRedirectUri = process.env.STRAVA_REDIRECT_URI?.trim() || buildPublicUrl(runtime.publicBaseUrl!, stravaCallbackPath);

    app.set("trust proxy", 1);
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.json({ limit: "1mb" }));
    app.use(express.urlencoded({ extended: false, limit: "16kb" }));
    app.use(cookieParser());
    app.use(rootTokenPath, attachBasicClientCredentials);
    if (authTokenPath !== rootTokenPath) {
        app.use(authTokenPath, attachBasicClientCredentials);
    }

    app.use(rootAuthMountPath, mcpAuthRouter(authRouterOptions));
    if (authMountPath !== rootAuthMountPath) {
        app.use(authMountPath, mcpAuthRouter(authRouterOptions));
    }

    app.get(stravaRootPath, (_req, res) => {
        res.redirect(302, stravaSetupPath);
    });

    app.get(stravaSetupPath, async (req, res) => {
        if (req.query.reset === "true") {
            await clearConfig();
        }

        const config = await loadConfig();
        res.setHeader("Cache-Control", "no-store");

        if (hasClientCredentials(config)) {
            res.status(200).type("html").send(credentialsExistPage(config.clientId!, stravaRootPath));
            return;
        }

        res.status(200).type("html").send(setupPage(undefined, stravaRootPath));
    });

    app.post(stravaSetupPath, async (req, res) => {
        const clientId = String(req.body.clientId ?? "").trim();
        const clientSecret = String(req.body.clientSecret ?? "").trim();

        if (!clientId || !clientSecret) {
            res.status(200).type("html").send(setupPage("Please enter both Client ID and Client Secret.", stravaRootPath));
            return;
        }

        await saveClientCredentials(clientId, clientSecret);
        res.redirect(302, stravaAuthPath);
    });

    app.get(stravaAuthPath, async (_req, res) => {
        const config = await loadConfig();
        if (!hasClientCredentials(config)) {
            res.redirect(302, stravaSetupPath);
            return;
        }

        const authUrl = buildStravaAuthorizeUrl(config.clientId!, stravaRedirectUri);
        res.redirect(302, authUrl);
    });

    app.get(stravaCallbackPath, async (req, res) => {
        const error = String(req.query.error ?? "").trim();
        const code = String(req.query.code ?? "").trim();

        if (error) {
            await clearConfig();
            res.status(200).type("html").send(errorPage("Authorization denied", error, stravaRootPath));
            return;
        }

        if (!code) {
            await clearConfig();
            res.status(200).type("html").send(errorPage("No authorization code received", undefined, stravaRootPath));
            return;
        }

        try {
            const config = await loadConfig();
            if (!config.clientId || !config.clientSecret) {
                throw new Error("Missing Strava client credentials.");
            }

            const tokenResponse = await requestStravaOAuthToken({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                code,
                grantType: "authorization_code",
            });

            const { access_token, refresh_token, expires_at, athlete } = tokenResponse;
            if (!access_token || !refresh_token) {
                throw new Error("Strava did not return access and refresh tokens.");
            }

            await saveConfig({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                accessToken: access_token,
                refreshToken: refresh_token,
                expiresAt: expires_at,
            });

            process.env.STRAVA_ACCESS_TOKEN = access_token;
            process.env.STRAVA_REFRESH_TOKEN = refresh_token;

            const athleteName = athlete ? `${String(athlete.firstname ?? "").trim()} ${String(athlete.lastname ?? "").trim()}`.trim() || undefined : undefined;
            res.status(200).type("html").send(successPage(athleteName));
        } catch (error) {
            await clearConfig();
            const errorMsg = error instanceof Error ? error.message : String(error);
            res.status(200).type("html").send(errorPage("Failed to exchange authorization code", errorMsg, stravaRootPath));
        }
    });

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

    const handleMcpRequest: RequestHandler = async (req, res) => {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        const mcpServer = buildMcpServer(version, true);
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
        }
    };

    app.all(
        rootMcpPath,
        MCP_RATE_LIMIT,
        requireBearerAuth({
            verifier: provider,
            requiredScopes: MCP_SCOPES,
            resourceMetadataUrl,
        }),
        handleMcpRequest,
    );

    if (mcpPath !== rootMcpPath) {
        app.all(
            mcpPath,
            MCP_RATE_LIMIT,
            requireBearerAuth({
                verifier: provider,
                requiredScopes: MCP_SCOPES,
                resourceMetadataUrl,
            }),
            handleMcpRequest,
        );
    }

    const sseTransports = new Map<string, SSEServerTransport>();
    const createSseRequestHandler = (endpointPath: string): RequestHandler => {
        return async (_req, res) => {
            const transport = new SSEServerTransport(endpointPath, res);
            const sessionId = transport.sessionId;
            const mcpServer = buildMcpServer(version, true);
            let cleanedUp = false;

            const cleanup = () => {
                if (cleanedUp) {
                    return;
                }
                cleanedUp = true;
                sseTransports.delete(sessionId);
                void transport.close();
                void mcpServer.close();
            };

            try {
                sseTransports.set(sessionId, transport);
                res.on("close", cleanup);
                await mcpServer.connect(transport);
            } catch (error) {
                console.error("SSE MCP request failed.");
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
            }
        };
    };

    const handleSsePost: RequestHandler = async (req, res) => {
        try {
            const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
            if (!sessionId) {
                res.status(400).send("Missing sessionId parameter");
                return;
            }

            const transport = sseTransports.get(sessionId);
            if (!transport) {
                res.status(404).send("Session not found");
                return;
            }

            await transport.handlePostMessage(req, res, req.body);
        } catch (error) {
            console.error("SSE message handling failed.");
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
        }
    };

    const sseAuthMiddleware = requireBearerAuth({
        verifier: provider,
        requiredScopes: MCP_SCOPES,
        resourceMetadataUrl,
    });

    app.get(ssePath, MCP_RATE_LIMIT, sseAuthMiddleware, createSseRequestHandler(messagesPath));
    app.post(messagesPath, MCP_RATE_LIMIT, sseAuthMiddleware, handleSsePost);

    if (mcpSsePath !== ssePath) {
        app.get(mcpSsePath, MCP_RATE_LIMIT, sseAuthMiddleware, createSseRequestHandler(mcpMessagesPath));
    }

    if (mcpMessagesPath !== messagesPath) {
        app.post(mcpMessagesPath, MCP_RATE_LIMIT, sseAuthMiddleware, handleSsePost);
    }

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
            await ensureFreshStravaAccessToken();
            const refreshedConfig = await loadConfig();
            applyBootstrappedStravaEnv(refreshedConfig);

            if (!refreshedConfig.accessToken || !refreshedConfig.refreshToken) {
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
