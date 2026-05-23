import { loadRuntimeConfig } from "./runtime.js";
import {
    getSecretStorePath,
    loadSecretState,
    updateSecretState,
} from "./secretStore.js";

export interface StravaConfig {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
}

function normalizeOptionalString(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function mergeConfig(
    stored: StravaConfig,
    env: ReturnType<typeof loadRuntimeConfig>,
): StravaConfig {
    return {
        clientId: normalizeOptionalString(env.stravaClientId) ?? stored.clientId,
        clientSecret: normalizeOptionalString(env.stravaClientSecret) ?? stored.clientSecret,
        accessToken: normalizeOptionalString(env.stravaAccessToken) ?? stored.accessToken,
        refreshToken: normalizeOptionalString(env.stravaRefreshToken) ?? stored.refreshToken,
        expiresAt: stored.expiresAt,
    };
}

export async function loadConfig(): Promise<StravaConfig> {
    const storedState = await loadSecretState();
    const runtime = loadRuntimeConfig();

    return mergeConfig(storedState.strava, runtime);
}

export async function saveConfig(config: StravaConfig): Promise<void> {
    await updateSecretState((state) => {
        if (config.clientId !== undefined) {
            state.strava.clientId = config.clientId;
        }
        if (config.clientSecret !== undefined) {
            state.strava.clientSecret = config.clientSecret;
        }
        if (config.accessToken !== undefined) {
            state.strava.accessToken = config.accessToken;
        }
        if (config.refreshToken !== undefined) {
            state.strava.refreshToken = config.refreshToken;
        }
        if (config.expiresAt !== undefined) {
            state.strava.expiresAt = config.expiresAt;
        }
    });
}

export async function updateTokens(
    accessToken: string,
    refreshToken: string,
    expiresAt?: number,
): Promise<void> {
    process.env.STRAVA_ACCESS_TOKEN = accessToken;
    process.env.STRAVA_REFRESH_TOKEN = refreshToken;

    await saveConfig({
        accessToken,
        refreshToken,
        expiresAt,
    });
}

export async function saveClientCredentials(
    clientId: string,
    clientSecret: string,
): Promise<void> {
    await saveConfig({
        clientId,
        clientSecret,
    });
}

export function hasClientCredentials(config: StravaConfig): boolean {
    return !!(config.clientId && config.clientSecret);
}

export function hasValidTokens(config: StravaConfig): boolean {
    return !!(config.accessToken && config.refreshToken);
}

export function getConfigPath(): string {
    return getSecretStorePath();
}

export async function clearConfig(): Promise<void> {
    await updateSecretState((state) => {
        state.strava = {};
    });
}

export async function clearClientCredentials(): Promise<void> {
    await updateSecretState((state) => {
        delete state.strava.clientId;
        delete state.strava.clientSecret;
    });
}
