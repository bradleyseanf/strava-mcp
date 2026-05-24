import { describe, expect, it, vi } from "vitest";

import { registerStravaTools } from "../src/mcpTools.ts";

describe("registerStravaTools", () => {
    it("registers every tool with an output schema", () => {
        const registrations: Array<{ name: string; config: any }> = [];
        const server = {
            registerTool: vi.fn((name: string, config: any) => {
                registrations.push({ name, config });
                return {};
            }),
        } as any;

        registerStravaTools(server);

        expect(registrations.length).toBeGreaterThan(0);
        for (const registration of registrations) {
            expect(registration.config.outputSchema).toBeDefined();
            expect(registration.config.outputSchema.summary).toBeDefined();
            expect(registration.config.outputSchema.isError).toBeDefined();
            expect(registration.config.outputSchema.contentCount).toBeDefined();
        }
    });
});
