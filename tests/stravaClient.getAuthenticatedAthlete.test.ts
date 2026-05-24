import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthenticatedAthlete, stravaApi } from "../src/stravaClient.ts";

describe("getAuthenticatedAthlete", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("accepts athlete profiles that omit weight", async () => {
        vi.spyOn(stravaApi, "get").mockResolvedValue({
            data: {
                id: 42,
                resource_state: 3,
                username: "test",
                firstname: "Test",
                lastname: "Runner",
                city: null,
                state: null,
                country: null,
                sex: null,
                premium: false,
                summit: false,
                created_at: "2024-01-01T00:00:00Z",
                updated_at: "2024-01-02T00:00:00Z",
                profile_medium: "https://example.com/medium.jpg",
                profile: "https://example.com/profile.jpg",
                measurement_preference: "meters",
            },
        } as any);

        const athlete = await getAuthenticatedAthlete("fake-token");

        expect(athlete.id).toBe(42);
        expect(athlete.firstname).toBe("Test");
        expect(athlete.weight).toBeUndefined();
    });
});
