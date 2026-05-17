import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadRuntimeConfig } from "./runtime.js";

export interface StravaSecretState {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
}

export interface OAuthPendingAuthorization {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    state?: string;
    resource?: string;
    createdAt: number;
    email?: string;
}

export interface OAuthAuthorizationCodeRecord {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource?: string;
    state?: string;
    email: string;
    createdAt: number;
    expiresAt: number;
}

export interface OAuthAccessTokenRecord {
    clientId: string;
    scopes: string[];
    resource?: string;
    email: string;
    createdAt: number;
    expiresAt: number;
    refreshToken: string;
}

export interface OAuthRefreshTokenRecord {
    clientId: string;
    scopes: string[];
    resource?: string;
    email: string;
    createdAt: number;
    expiresAt: number;
    accessToken: string;
}

export interface AppSecretState {
    strava: StravaSecretState;
    oauth: {
        clients: Record<string, OAuthClientInformationFull>;
        pending: Record<string, OAuthPendingAuthorization>;
        codes: Record<string, OAuthAuthorizationCodeRecord>;
        accessTokens: Record<string, OAuthAccessTokenRecord>;
        refreshTokens: Record<string, OAuthRefreshTokenRecord>;
    };
}

const EMPTY_STATE: AppSecretState = {
    strava: {},
    oauth: {
        clients: {},
        pending: {},
        codes: {},
        accessTokens: {},
        refreshTokens: {},
    },
};

let writeQueue: Promise<void> = Promise.resolve();

function getSecretPath(): string {
    return loadRuntimeConfig().secretStorePath;
}

function getEncryptionKey(): Buffer {
    const config = loadRuntimeConfig();
    const rawKey = config.tokenEncryptionKey || config.sessionSecret || "";
    if (!rawKey) {
        if (config.nodeEnv === "production") {
            throw new Error("TOKEN_ENCRYPTION_KEY is required in production.");
        }
        return crypto.createHash("sha256").update("strava-mcp-dev-key").digest();
    }

    return crypto.createHash("sha256").update(rawKey).digest();
}

function getFallbackDir(filePath: string): string {
    return path.dirname(filePath);
}

async function ensureParentDir(filePath: string): Promise<void> {
    await fs.mkdir(getFallbackDir(filePath), { recursive: true });
}

function encryptState(state: AppSecretState): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(state), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: ciphertext.toString("base64"),
    });
}

function decryptState(blob: string): AppSecretState {
    const parsed = JSON.parse(blob) as { version?: number; iv: string; tag: string; data: string };
    if (parsed.version !== 1) {
        throw new Error("Unsupported secret store version.");
    }

    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(parsed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
    ]);

    const state = JSON.parse(decrypted.toString("utf8")) as Partial<AppSecretState>;
    return {
        strava: {
            ...(state.strava ?? {}),
        },
        oauth: {
            clients: state.oauth?.clients ?? {},
            pending: state.oauth?.pending ?? {},
            codes: state.oauth?.codes ?? {},
            accessTokens: state.oauth?.accessTokens ?? {},
            refreshTokens: state.oauth?.refreshTokens ?? {},
        },
    };
}

export async function loadSecretState(): Promise<AppSecretState> {
    const secretPath = getSecretPath();
    try {
        const content = await fs.readFile(secretPath, "utf8");
        return decryptState(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return structuredClone(EMPTY_STATE);
        }
        throw error;
    }
}

export async function saveSecretState(state: AppSecretState): Promise<void> {
    const secretPath = getSecretPath();
    await ensureParentDir(secretPath);
    const serialized = encryptState(state);
    await fs.writeFile(secretPath, serialized, { mode: 0o600 });
    try {
        await fs.chmod(secretPath, 0o600);
    } catch {
        // Best effort only.
    }
}

export async function updateSecretState(
    updater: (state: AppSecretState) => Promise<void> | void,
): Promise<AppSecretState> {
    let resultState: AppSecretState = structuredClone(EMPTY_STATE);
    writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
            const state = await loadSecretState();
            await updater(state);
            await saveSecretState(state);
            resultState = state;
        })
        .then(() => undefined, () => undefined);
    await writeQueue;
    return resultState;
}

export function getSecretStorePath(): string {
    return getSecretPath();
}
