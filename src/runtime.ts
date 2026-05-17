import os from "node:os";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PUBLIC_BASE_URL: z.string().trim().url().optional(),
    MCP_SECRET_PATH: z.string().trim().min(1).optional(),
    SESSION_SECRET: z.string().trim().min(1).optional(),
    TOKEN_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
    ALLOWED_USER_EMAIL: z.string().trim().email().optional(),
    STRAVA_CLIENT_ID: z.string().trim().optional(),
    STRAVA_CLIENT_SECRET: z.string().trim().optional(),
    STRAVA_ACCESS_TOKEN: z.string().trim().optional(),
    STRAVA_REFRESH_TOKEN: z.string().trim().optional(),
});

export type RuntimeEnv = z.infer<typeof EnvSchema>;

export interface RuntimeConfig {
    nodeEnv: RuntimeEnv["NODE_ENV"];
    publicBaseUrl?: URL;
    publicBasePath: string;
    mcpUrl?: URL;
    healthUrl?: URL;
    authBaseUrl?: URL;
    authUrl?: URL;
    tokenUrl?: URL;
    loginUrl?: URL;
    secretStorePath: string;
    sessionSecret?: string;
    tokenEncryptionKey?: string;
    allowedUserEmail?: string;
    stravaClientId?: string;
    stravaClientSecret?: string;
    stravaAccessToken?: string;
    stravaRefreshToken?: string;
    isRemoteMode: boolean;
}

function normalizeBasePath(basePath: string): string {
    if (!basePath || basePath === "/") {
        return "";
    }
    return basePath.replace(/\/+$/, "");
}

function resolveSecretStorePath(rawPath?: string): string {
    const defaultPath = path.join(os.homedir(), ".config", "strava-mcp", "secrets.enc.json");
    if (!rawPath) {
        return defaultPath;
    }

    const expanded = rawPath.startsWith("~")
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;

    if (path.extname(expanded)) {
        return expanded;
    }

    return path.join(expanded, "secrets.enc.json");
}

function joinUrl(baseUrl: URL, suffixPath: string): URL {
    const url = new URL(baseUrl.toString());
    const basePath = normalizeBasePath(url.pathname);
    const cleanSuffix = suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
    url.pathname = `${basePath}${cleanSuffix}`;
    url.search = "";
    url.hash = "";
    return url;
}

export function loadRuntimeConfig(): RuntimeConfig {
    const env = EnvSchema.parse(process.env);
    const publicBaseUrl = env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL) : undefined;
    const publicBasePath = normalizeBasePath(publicBaseUrl?.pathname ?? "");
    const isRemoteMode = Boolean(publicBaseUrl);

    return {
        nodeEnv: env.NODE_ENV,
        publicBaseUrl,
        publicBasePath,
        mcpUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/mcp") : undefined,
        healthUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/health") : undefined,
        authBaseUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/auth") : undefined,
        authUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/auth/authorize") : undefined,
        tokenUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/auth/token") : undefined,
        loginUrl: publicBaseUrl ? joinUrl(publicBaseUrl, "/auth/login") : undefined,
        secretStorePath: resolveSecretStorePath(env.MCP_SECRET_PATH),
        sessionSecret: env.SESSION_SECRET,
        tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
        allowedUserEmail: env.ALLOWED_USER_EMAIL,
        stravaClientId: env.STRAVA_CLIENT_ID,
        stravaClientSecret: env.STRAVA_CLIENT_SECRET,
        stravaAccessToken: env.STRAVA_ACCESS_TOKEN,
        stravaRefreshToken: env.STRAVA_REFRESH_TOKEN,
        isRemoteMode,
    };
}

export function assertHttpsPublicUrl(config: RuntimeConfig): void {
    if (!config.publicBaseUrl) {
        return;
    }

    if (config.nodeEnv === "production" && config.publicBaseUrl.protocol !== "https:") {
        throw new Error("PUBLIC_BASE_URL must use https in production.");
    }

    if (config.publicBasePath === "") {
        throw new Error("PUBLIC_BASE_URL must include the private app path.");
    }
}

