import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

function registerTool(server: McpServer, tool: ToolDefinition): void {
    server.tool(
        tool.name,
        tool.description,
        tool.inputSchema?.shape ?? {},
        tool.execute,
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
