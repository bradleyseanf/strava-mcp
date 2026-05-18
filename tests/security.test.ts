import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
        previous[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

describe("runtime config", () => {
    it("derives app routes from a root PUBLIC_BASE_URL", async () => {
        const { loadRuntimeConfig } = await import("../src/runtime.js");

        await withEnv(
            {
                PUBLIC_BASE_URL: "https://c7c6e3f4-9f97-4d6e-a3b2-8c4d7f1e52ab.integratecore.net",
                MCP_SECRET_PATH: path.join(os.tmpdir(), "strava-mcp-test", "secrets.enc.json"),
            },
            async () => {
                const runtime = loadRuntimeConfig();
                expect(runtime.publicBasePath).toBe("");
                expect(runtime.mcpUrl?.pathname).toBe("/mcp");
                expect(runtime.authBaseUrl?.pathname).toBe("/auth");
            },
        );
    });
});

describe("session cookies", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("round-trips a signed session cookie", async () => {
        const { createSessionCookie, verifySessionCookie } = await import("../src/auth/session.js");

        const cookie = createSessionCookie("user@example.com", "super-secret", 60);
        const claims = verifySessionCookie(cookie, "super-secret");

        expect(claims?.email).toBe("user@example.com");
        expect(claims?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(verifySessionCookie(cookie, "different-secret")).toBeNull();
    });
});

describe("encrypted secret store", () => {
    it("persists and reloads encrypted Strava credentials", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strava-mcp-secrets-"));
        const secretPath = path.join(tempDir, "secrets.enc.json");

        await withEnv(
            {
                MCP_SECRET_PATH: secretPath,
                TOKEN_ENCRYPTION_KEY: "test-encryption-key",
                SESSION_SECRET: "test-session-secret",
                NODE_ENV: "development",
            },
            async () => {
                const { saveConfig, loadConfig, getConfigPath } = await import("../src/config.js");
                await saveConfig({
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    accessToken: "access-token",
                    refreshToken: "refresh-token",
                    expiresAt: 123,
                });

                const stored = await loadConfig();
                expect(stored.clientId).toBe("client-id");
                expect(stored.clientSecret).toBe("client-secret");
                expect(stored.accessToken).toBe("access-token");
                expect(stored.refreshToken).toBe("refresh-token");
                expect(getConfigPath()).toBe(secretPath);

                const raw = await fs.readFile(secretPath, "utf8");
                expect(raw).not.toContain("access-token");
                expect(raw).not.toContain("refresh-token");
            },
        );
    });
});

describe("oauth client registration", () => {
    it("accepts string redirect URIs from the MCP registration flow", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strava-mcp-oauth-"));
        const secretPath = path.join(tempDir, "secrets.enc.json");

        await withEnv(
            {
                MCP_SECRET_PATH: secretPath,
                TOKEN_ENCRYPTION_KEY: "test-encryption-key",
                SESSION_SECRET: "test-session-secret",
                NODE_ENV: "production",
            },
            async () => {
                const { PersonalOAuthProvider } = await import("../src/auth/provider.js");
                const provider = new PersonalOAuthProvider({
                    authBaseUrl: new URL("https://example.com/auth"),
                    resourceServerUrl: new URL("https://example.com/mcp"),
                    allowedUserEmail: "user@example.com",
                    sessionSecret: "test-session-secret",
                    nodeEnv: "production",
                });

                const client = await provider.clientsStore.registerClient({
                    redirect_uris: ["https://chatgpt.com/aip/test/oauth/callback"],
                    token_endpoint_auth_method: "none",
                    grant_types: ["authorization_code"],
                    response_types: ["code"],
                    client_name: "ChatGPT",
                    scope: "mcp:tools",
                });

                expect(client.client_id).toBeTruthy();
                expect(client.redirect_uris[0].toString()).toBe("https://chatgpt.com/aip/test/oauth/callback");
            },
        );
    });

    it("stores DCR clients as public PKCE clients when auth method is omitted", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strava-mcp-oauth-public-"));
        const secretPath = path.join(tempDir, "secrets.enc.json");

        await withEnv(
            {
                MCP_SECRET_PATH: secretPath,
                TOKEN_ENCRYPTION_KEY: "test-encryption-key",
                SESSION_SECRET: "test-session-secret",
                NODE_ENV: "production",
            },
            async () => {
                const { PersonalOAuthProvider } = await import("../src/auth/provider.js");
                const provider = new PersonalOAuthProvider({
                    authBaseUrl: new URL("https://example.com/auth"),
                    resourceServerUrl: new URL("https://example.com/mcp"),
                    allowedUserEmail: "user@example.com",
                    sessionSecret: "test-session-secret",
                    nodeEnv: "production",
                });

                const client = await provider.clientsStore.registerClient({
                    redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
                    grant_types: ["authorization_code"],
                    response_types: ["code"],
                    client_name: "ChatGPT",
                    client_secret: "sdk-generated-secret",
                    client_secret_expires_at: 123,
                    scope: "mcp:tools",
                });

                expect(client.token_endpoint_auth_method).toBe("none");
                expect(client.client_secret).toBeUndefined();
                expect(client.client_secret_expires_at).toBeUndefined();

                const storedClient = await provider.clientsStore.getClient(client.client_id);
                expect(storedClient?.token_endpoint_auth_method).toBe("none");
                expect(storedClient?.client_secret).toBeUndefined();
            },
        );
    });
});
