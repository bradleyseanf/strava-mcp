import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAllActivities as getAllActivitiesTool } from "../src/tools/getAllActivities.ts";
import { stravaApi } from "../src/stravaClient.ts";

describe("get-all-activities tool", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("filters by activityTypes using preserved activity.type", async () => {
        const previousToken = process.env.STRAVA_ACCESS_TOKEN;
        process.env.STRAVA_ACCESS_TOKEN = "test-token";

        try {
            vi.spyOn(stravaApi, "get").mockResolvedValue({
                data: [
                    {
                        id: 1234567890,
                        name: "Test Run",
                        distance: 5000,
                        start_date: new Date("2024-12-03T20:02:12.000Z").toISOString(),
                        type: "Run",
                        sport_type: "Run",
                        moving_time: 4237,
                    },
                ],
            } as any);

            const result = await getAllActivitiesTool.execute({
                startDate: "2024-12-03",
                endDate: "2024-12-04",
                activityTypes: ["Run"],
                maxActivities: 500,
                maxApiCalls: 1,
                perPage: 200,
            });

            const text = result.content[0]?.text ?? "";
            expect(text).toContain("**Found 1 activities**");
            expect(text).toContain("ID: 1234567890");
            expect(text).toContain("Run Test Run");
        } finally {
            process.env.STRAVA_ACCESS_TOKEN = previousToken;
        }
    });

    it("paginates page by page without duplicating results", async () => {
        const previousToken = process.env.STRAVA_ACCESS_TOKEN;
        process.env.STRAVA_ACCESS_TOKEN = "test-token";

        try {
            vi.spyOn(stravaApi, "get").mockImplementation(async (_url, config) => {
                const page = Number(config?.params?.page ?? 1);
                if (page === 1) {
                    return {
                        data: [
                            {
                                id: 111,
                                name: "Page One Run",
                                distance: 5000,
                                start_date: new Date("2024-12-03T20:02:12.000Z").toISOString(),
                                type: "Run",
                                sport_type: "Run",
                                moving_time: 3600,
                            },
                        ],
                    } as any;
                }
                if (page === 2) {
                    return {
                        data: [
                            {
                                id: 222,
                                name: "Page Two Ride",
                                distance: 20000,
                                start_date: new Date("2024-12-04T20:02:12.000Z").toISOString(),
                                type: "Ride",
                                sport_type: "Ride",
                                moving_time: 5400,
                            },
                        ],
                    } as any;
                }
                return { data: [] } as any;
            });

            const result = await getAllActivitiesTool.execute({
                maxActivities: 10,
                maxApiCalls: 3,
                perPage: 1,
            });

            const text = result.content[0]?.text ?? "";
            expect(text).toContain("**Found 2 activities**");
            expect(text).toContain("ID: 111");
            expect(text).toContain("ID: 222");
        } finally {
            process.env.STRAVA_ACCESS_TOKEN = previousToken;
        }
    });
});
