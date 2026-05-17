import crypto from "node:crypto";
import type { Response } from "express";
import {
    type OAuthClientInformationFull,
    type OAuthTokenRevocationRequest,
    type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { loadSecretState, updateSecretState } from "../secretStore.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 10 * 60;
const registeredClientsCache = new Map<string, OAuthClientInformationFull>();

export interface PersonalOAuthProviderOptions {
    authBaseUrl: URL;
    resourceServerUrl: URL;
    allowedUserEmail: string;
    sessionSecret: string;
    nodeEnv: string;
}

function randomToken(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function isHttpsOrLocalhost(url: URL): boolean {
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function parseRedirectUri(value: string | URL): URL {
    return value instanceof URL ? value : new URL(value);
}

function secureRedirect(target: URL, res: Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, target.toString());
}

function appendPath(baseUrl: URL, suffix: string): URL {
    const next = new URL(baseUrl.toString());
    const basePath = next.pathname.replace(/\/+$/, "");
    const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
    next.pathname = `${basePath}${cleanSuffix}`;
    return next;
}

function timingSafeEqualStrings(left: string, right: string): boolean {
    const leftBuf = Buffer.from(left, "utf8");
    const rightBuf = Buffer.from(right, "utf8");
    if (leftBuf.length !== rightBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuf, rightBuf);
}

export class PersonalOAuthProvider implements OAuthServerProvider {
    public readonly skipLocalPkceValidation = false;

    private readonly authBaseUrl: URL;
    private readonly resourceServerUrl: URL;
    private readonly allowedUserEmail: string;
    private readonly sessionSecret: string;
    private readonly nodeEnv: string;

    private readonly clientsStoreImpl: OAuthRegisteredClientsStore = {
        getClient: async (clientId: string) => {
            const cachedClient = registeredClientsCache.get(clientId);
            if (cachedClient) {
                return cachedClient;
            }
            const state = await loadSecretState();
            const storedClient = state.oauth.clients[clientId];
            if (storedClient) {
                registeredClientsCache.set(clientId, storedClient);
            }
            return storedClient;
        },
        registerClient: async (client: any) => {
            const redirectUris = (client.redirect_uris ?? []).map((redirectUri: string | URL) =>
                parseRedirectUri(redirectUri),
            );
            if (redirectUris.length === 0) {
                throw new Error("At least one redirect_uri is required.");
            }

            for (const redirectUri of redirectUris) {
                if (!isHttpsOrLocalhost(redirectUri) && this.nodeEnv === "production") {
                    throw new Error("redirect_uri must use https in production.");
                }
            }

            const existingClient = client as OAuthClientInformationFull & { client_id?: string };
            const clientId = existingClient.client_id ?? crypto.randomUUID();
            const clientRecord: OAuthClientInformationFull = {
                ...client,
                client_id: clientId,
                client_id_issued_at: Math.floor(Date.now() / 1000),
            };

            await updateSecretState((state) => {
                state.oauth.clients[clientId] = clientRecord;
            });
            registeredClientsCache.set(clientId, clientRecord);

            return clientRecord;
        },
    };

    constructor(options: PersonalOAuthProviderOptions) {
        this.authBaseUrl = options.authBaseUrl;
        this.resourceServerUrl = options.resourceServerUrl;
        this.allowedUserEmail = options.allowedUserEmail.toLowerCase();
        this.sessionSecret = options.sessionSecret;
        this.nodeEnv = options.nodeEnv;
    }

    get clientsStore(): OAuthRegisteredClientsStore {
        return this.clientsStoreImpl;
    }

    async authorize(
        client: OAuthClientInformationFull,
        params: {
            state?: string;
            scopes?: string[];
            codeChallenge: string;
            redirectUri: string;
            resource?: URL;
        },
        res: Response,
    ): Promise<void> {
        const requestId = crypto.randomUUID();
        const pendingPath = appendPath(this.authBaseUrl, "/login");
        pendingPath.searchParams.set("request_id", requestId);

        await updateSecretState((state) => {
            state.oauth.pending[requestId] = {
                clientId: client.client_id,
                redirectUri: params.redirectUri,
                codeChallenge: params.codeChallenge,
                scopes: params.scopes ?? [],
                state: params.state,
                resource: params.resource?.toString(),
                createdAt: Date.now(),
                email: this.allowedUserEmail,
            };
        });

        secureRedirect(pendingPath, res);
    }

    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<string> {
        const state = await loadSecretState();
        const record = state.oauth.codes[authorizationCode];
        if (!record || record.clientId !== client.client_id) {
            throw new Error("Invalid authorization code");
        }
        return record.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        const state = await loadSecretState();
        const record = state.oauth.codes[authorizationCode];

        if (!record) {
            throw new Error("Invalid authorization code");
        }
        if (record.clientId !== client.client_id) {
            throw new Error("Authorization code was not issued to this client.");
        }
        if (record.expiresAt < Date.now()) {
            throw new Error("Authorization code has expired.");
        }
        if (redirectUri && redirectUri !== record.redirectUri) {
            throw new Error("redirect_uri mismatch.");
        }
        if (resource && record.resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: record.resource })) {
            throw new Error("resource mismatch.");
        }

        const accessToken = randomToken("mcp_at");
        const refreshToken = randomToken("mcp_rt");
        const now = Date.now();
        const scopes = record.scopes;
        const resolvedResource = record.resource ? new URL(record.resource) : resource;

        await updateSecretState(async (next) => {
            delete next.oauth.codes[authorizationCode];
            next.oauth.accessTokens[accessToken] = {
                clientId: client.client_id,
                scopes,
                resource: resolvedResource?.toString(),
                email: record.email,
                createdAt: now,
                expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
                refreshToken,
            };
            next.oauth.refreshTokens[refreshToken] = {
                clientId: client.client_id,
                scopes,
                resource: resolvedResource?.toString(),
                email: record.email,
                createdAt: now,
                expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
                accessToken,
            };
        });

        return {
            access_token: accessToken,
            token_type: "bearer",
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            scope: scopes.join(" "),
            refresh_token: refreshToken,
        };
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        const state = await loadSecretState();
        const record = state.oauth.refreshTokens[refreshToken];

        if (!record) {
            throw new Error("Invalid refresh token");
        }
        if (record.clientId !== client.client_id) {
            throw new Error("Refresh token was not issued to this client.");
        }
        if (record.expiresAt < Date.now()) {
            throw new Error("Refresh token has expired.");
        }
        if (resource && record.resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: record.resource })) {
            throw new Error("resource mismatch.");
        }

        const requestedScopes = scopes && scopes.length > 0 ? scopes : record.scopes;
        const resolvedResource = resource ?? (record.resource ? new URL(record.resource) : undefined);
        const accessToken = randomToken("mcp_at");
        const nextRefreshToken = randomToken("mcp_rt");
        const now = Date.now();

        await updateSecretState(async (next) => {
            delete next.oauth.accessTokens[record.accessToken];
            delete next.oauth.refreshTokens[refreshToken];
            next.oauth.accessTokens[accessToken] = {
                clientId: client.client_id,
                scopes: requestedScopes,
                resource: resolvedResource?.toString(),
                email: record.email,
                createdAt: now,
                expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
                refreshToken: nextRefreshToken,
            };
            next.oauth.refreshTokens[nextRefreshToken] = {
                clientId: client.client_id,
                scopes: requestedScopes,
                resource: resolvedResource?.toString(),
                email: record.email,
                createdAt: now,
                expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
                accessToken,
            };
        });

        return {
            access_token: accessToken,
            token_type: "bearer",
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            scope: requestedScopes.join(" "),
            refresh_token: nextRefreshToken,
        };
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const state = await loadSecretState();
        const record = state.oauth.accessTokens[token];

        if (!record) {
            throw new Error("Invalid access token");
        }
        if (record.expiresAt < Date.now()) {
            throw new Error("Access token has expired");
        }

        return {
            token,
            clientId: record.clientId,
            scopes: record.scopes,
            expiresAt: Math.floor(record.expiresAt / 1000),
            resource: record.resource ? new URL(record.resource) : undefined,
            extra: {
                email: record.email,
            },
        };
    }

    async revokeToken(
        _client: OAuthClientInformationFull,
        request: OAuthTokenRevocationRequest,
    ): Promise<void> {
        const state = await loadSecretState();
        const accessRecord = state.oauth.accessTokens[request.token];
        const refreshRecord = state.oauth.refreshTokens[request.token];

        if (!accessRecord && !refreshRecord) {
            return;
        }

        await updateSecretState(async (next) => {
            if (accessRecord) {
                delete next.oauth.refreshTokens[accessRecord.refreshToken];
                delete next.oauth.accessTokens[request.token];
            }
            if (refreshRecord) {
                delete next.oauth.accessTokens[refreshRecord.accessToken];
                delete next.oauth.refreshTokens[request.token];
            }
        });
    }

    async finalizeAuthorization(
        requestId: string,
        email: string,
    ): Promise<string> {
        const state = await loadSecretState();
        let pending = state.oauth.pending[requestId];
        if (!pending) {
            const pendingEntries = Object.entries(state.oauth.pending);
            pending = pendingEntries.find(([, record]) => record.email?.toLowerCase() === email.toLowerCase())?.[1];
        }
        if (!pending) {
            const pendingEntries = Object.values(state.oauth.pending);
            if (pendingEntries.length === 1) {
                pending = pendingEntries[0];
            }
        }

        if (!pending) {
            throw new Error("Authorization request expired or not found.");
        }
        if (pending.email && pending.email.toLowerCase() !== email.toLowerCase()) {
            throw new Error("Email mismatch.");
        }

        const code = randomToken("mcp_code");
        await updateSecretState(async (next) => {
            next.oauth.codes[code] = {
                clientId: pending.clientId,
                redirectUri: pending.redirectUri,
                codeChallenge: pending.codeChallenge,
                scopes: pending.scopes,
                resource: pending.resource,
                state: pending.state,
                email,
                createdAt: Date.now(),
                expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
            };
            delete next.oauth.pending[requestId];
        });

        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set("code", code);
        if (pending.state) {
            redirectUrl.searchParams.set("state", pending.state);
        }
        return redirectUrl.toString();
    }

    validateLogin(email: string, password: string): boolean {
        if (email.toLowerCase() !== this.allowedUserEmail) {
            return false;
        }
        return timingSafeEqualStrings(password, this.sessionSecret);
    }

    get allowedEmail(): string {
        return this.allowedUserEmail;
    }

    get resourceUrl(): URL {
        return this.resourceServerUrl;
    }

    get authUrl(): URL {
        return this.authBaseUrl;
    }
}
