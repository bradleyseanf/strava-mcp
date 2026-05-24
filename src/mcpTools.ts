import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getAthleteProfile } from "./tools/getAthleteProfile.js";
import { getAthleteStatsTool } from "./tools/getAthleteStats.js";
import { getActivityDetailsTool } from "./tools/getActivityDetails.js";
import { getRecentActivities } from "./tools/getRecentActivities.js";
import { listAthleteClubs } from "./tools/listAthleteClubs.js";
import { listStarredSegments } from "./tools/listStarredSegments.js";
import { getSegmentTool } from "./tools/getSegment.js";
import { exploreSegments } from "./tools/exploreSegments.js";
import { starSegment } from "./tools/starSegment.js";
import { getSegmentEffortTool } from "./tools/getSegmentEffort.js";
import { listSegmentEffortsTool } from "./tools/listSegmentEfforts.js";
import { listAthleteRoutesTool } from "./tools/listAthleteRoutes.js";
import { getRouteTool } from "./tools/getRoute.js";
import { exportRouteGpx } from "./tools/exportRouteGpx.js";
import { exportRouteTcx } from "./tools/exportRouteTcx.js";
import { getActivityStreamsTool } from "./tools/getActivityStreams.js";
import { getActivityLapsTool } from "./tools/getActivityLaps.js";
import { getAthleteZonesTool } from "./tools/getAthleteZones.js";
import { getAthleteShoesTool } from "./tools/getAthleteShoes.js";
import { getAllActivities } from "./tools/getAllActivities.js";
import { getActivityPhotosTool } from "./tools/getActivityPhotos.js";
import { getServerVersionTool } from "./tools/getServerVersion.js";
import {
    connectStravaTool,
    disconnectStravaTool,
    checkStravaConnectionTool,
} from "./tools/connectStrava.js";
import { getSegmentLeaderboardTool } from "./tools/getSegmentLeaderboard.js";

type ToolDefinition = {
    name: string;
    description: string;
    inputSchema?: { shape?: Record<string, unknown> } | undefined;
    execute: (...args: any[]) => any;
};

const GenericToolOutputSchema: any = {
    summary: z.string(),
    isError: z.boolean(),
    contentCount: z.number().int().nonnegative(),
};

function summarizeToolResult(toolName: string, result: any): string {
    if (typeof result?.structuredContent?.summary === "string" && result.structuredContent.summary.trim()) {
        return result.structuredContent.summary.trim();
    }

    const content = Array.isArray(result?.content) ? result.content : [];
    const textItems = content
        .filter((item: any) => item?.type === "text" && typeof item.text === "string")
        .map((item: any) => item.text.trim())
        .filter(Boolean);

    if (textItems.length > 0) {
        const firstText = textItems.join("\n\n").trim();
        return firstText.length > 220 ? `${firstText.slice(0, 217)}...` : firstText;
    }

    if (result?.isError) {
        return `${toolName} failed`;
    }

    return `${toolName} completed`;
}

function normalizeToolResult(toolName: string, result: any): any {
    if (!result || typeof result !== "object") {
        const text = String(result);
        return {
            content: [{ type: "text", text }],
            structuredContent: {
                summary: text.length > 220 ? `${text.slice(0, 217)}...` : text,
                isError: false,
                contentCount: 1,
            },
        };
    }

    const contentCount = Array.isArray(result.content) ? result.content.length : 0;
    const normalized = { ...result };
    normalized.structuredContent = {
        summary: summarizeToolResult(toolName, result),
        isError: Boolean(result.isError),
        contentCount,
    };
    return normalized;
}

function registerTool(server: McpServer, tool: ToolDefinition): void {
    const inputSchema = tool.inputSchema?.shape;
    const registerToolFn = server.registerTool as any;
    registerToolFn(
        tool.name,
        {
            description: tool.description,
            inputSchema: inputSchema ?? {},
            outputSchema: GenericToolOutputSchema,
        },
        async (args: any, extra: any) => normalizeToolResult(tool.name, await tool.execute(args, extra)),
    );
}

export function registerStravaTools(
    server: McpServer,
    options: { includeAdminTools?: boolean } = {},
): void {
    const includeAdminTools = options.includeAdminTools ?? false;

    [
        getAthleteProfile,
        getAthleteStatsTool,
        getActivityDetailsTool,
        getRecentActivities,
        listAthleteClubs,
        listStarredSegments,
        getSegmentTool,
        exploreSegments,
        starSegment,
        getSegmentEffortTool,
        listSegmentEffortsTool,
        listAthleteRoutesTool,
        getRouteTool,
        exportRouteGpx,
        exportRouteTcx,
        getActivityStreamsTool,
        getActivityLapsTool,
        getAthleteZonesTool,
        getAthleteShoesTool,
        getAllActivities,
        getActivityPhotosTool,
        getServerVersionTool,
        getSegmentLeaderboardTool,
    ].forEach((tool) => registerTool(server, tool));

    if (includeAdminTools) {
        registerTool(server, connectStravaTool);
        registerTool(server, disconnectStravaTool);
        registerTool(server, checkStravaConnectionTool);
    }
}
