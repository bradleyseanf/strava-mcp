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
    it("derives the private app routes from PUBLIC_BASE_URL", async () => {
        const { loadRuntimeConfig } = await import("../src/runtime.js");

        await withEnv(
            {
                PUBLIC_BASE_URL: "https://integratecore.net/a7f7v7902-djhfhee723-dhd8333v",
                MCP_SECRET_PATH: path.join(os.tmpdir(), "strava-mcp-test", "secrets.enc.json"),
            },
            async () => {
                const runtime = loadRuntimeConfig();
                expect(runtime.publicBasePath).toBe("/a7f7v7902-djhfhee723-dhd8333v");
                expect(runtime.mcpUrl?.pathname).toBe("/a7f7v7902-djhfhee723-dhd8333v/mcp");
                expect(runtime.authBaseUrl?.pathname).toBe("/a7f7v7902-djhfhee723-dhd8333v/auth");
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

