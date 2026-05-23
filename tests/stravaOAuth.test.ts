import axios from "axios";
import { describe, expect, it, vi } from "vitest";

import { requestStravaOAuthToken } from "../src/stravaOAuth.js";

describe("requestStravaOAuthToken", () => {
    it("sends a form-encoded payload to Strava", async () => {
        const postSpy = vi.spyOn(axios, "post").mockResolvedValue({
            data: {
                access_token: "access-token",
                refresh_token: "refresh-token",
                expires_at: 123,
                expires_in: 21600,
                token_type: "Bearer",
            },
        } as never);

        await requestStravaOAuthToken({
            clientId: "client-id",
            clientSecret: "client-secret",
            code: "authorization-code",
            grantType: "authorization_code",
        });

        expect(postSpy).toHaveBeenCalledTimes(1);
        const [url, body, config] = postSpy.mock.calls[0]!;
        expect(url).toBe("https://www.strava.com/oauth/token");
        expect(body).toBeInstanceOf(URLSearchParams);
        expect((body as URLSearchParams).toString()).toBe(
            "client_id=client-id&client_secret=client-secret&grant_type=authorization_code&code=authorization-code",
        );
        expect(config).toEqual(
            expect.objectContaining({
                headers: expect.objectContaining({
                    "Content-Type": "application/x-www-form-urlencoded",
                }),
            }),
        );
    });
});
