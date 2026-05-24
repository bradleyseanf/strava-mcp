import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearConfig } from "../src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");

async function stripStravaTokensFromEnv(): Promise<boolean> {
    try {
        const envContent = await fs.readFile(envPath, "utf8");
        const lines = envContent.split("\n");
        const nextLines: string[] = [];
        let changed = false;

        for (const line of lines) {
            if (line.startsWith("STRAVA_ACCESS_TOKEN=") || line.startsWith("STRAVA_REFRESH_TOKEN=")) {
                changed = true;
                continue;
            }
            if (line.trim() !== "") {
                nextLines.push(line);
            }
        }

        if (changed) {
            await fs.writeFile(envPath, `${nextLines.join("\n").trim()}\n`);
        }

        return changed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function main(): Promise<void> {
    await clearConfig();
    const envChanged = await stripStravaTokensFromEnv();

    console.log("Cleared Strava tokens from the encrypted secret store.");
    if (envChanged) {
        console.log("Removed STRAVA_ACCESS_TOKEN and STRAVA_REFRESH_TOKEN from .env.");
    } else {
        console.log("No Strava token lines were present in .env.");
    }
    console.log("Run `npm run setup-auth` next to mint a fresh Strava refresh token.");
}

void main().catch((error) => {
    console.error(`Failed to reset Strava credentials: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
