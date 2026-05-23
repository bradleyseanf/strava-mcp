import axios from "axios";

export type StravaOAuthGrantType = "authorization_code" | "refresh_token";

export interface StravaOAuthTokenRequest {
    clientId: string;
    clientSecret: string;
    grantType: StravaOAuthGrantType;
    code?: string;
    refreshToken?: string;
}

export interface StravaOAuthTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    expires_in: number;
    token_type: string;
    scope?: string;
    athlete?: Record<string, unknown>;
}

function buildTokenFormBody(request: StravaOAuthTokenRequest): URLSearchParams {
    const body = new URLSearchParams({
        client_id: request.clientId,
        client_secret: request.clientSecret,
        grant_type: request.grantType,
    });

    if (request.code) {
        body.set("code", request.code);
    }
    if (request.refreshToken) {
        body.set("refresh_token", request.refreshToken);
    }

    return body;
}

export async function requestStravaOAuthToken(
    request: StravaOAuthTokenRequest,
): Promise<StravaOAuthTokenResponse> {
    const response = await axios.post<StravaOAuthTokenResponse>(
        "https://www.strava.com/oauth/token",
        buildTokenFormBody(request),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        },
    );

    return response.data;
}
