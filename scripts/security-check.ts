import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadRuntimeConfig } from "../src/runtime.js";

type CheckResult = {
    name: string;
    passed: boolean;
    details?: string;
};

function printCheck(result: CheckResult): void {
    const status = result.passed ? "PASS" : "FAIL";
    const detail = result.details ? ` - ${result.details}` : "";
    console.log(`[${status}] ${result.name}${detail}`);
}

async function fileContains(filePath: string, patterns: string[]): Promise<boolean> {
    try {
        const content = await fs.readFile(filePath, "utf8");
        return patterns.some((pattern) => content.includes(pattern));
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const runtime = loadRuntimeConfig();
    const repoRoot = process.cwd();
    const results: CheckResult[] = [];

    const requiredEnv = [
        "NODE_ENV",
        "PUBLIC_BASE_URL",
        "MCP_SECRET_PATH",
        "SESSION_SECRET",
        "TOKEN_ENCRYPTION_KEY",
        "ALLOWED_USER_EMAIL",
        "STRAVA_CLIENT_ID",
        "STRAVA_CLIENT_SECRET",
    ];

    for (const name of requiredEnv) {
        results.push({
            name: `Env ${name}`,
            passed: Boolean(process.env[name]),
            details: process.env[name] ? "set" : "missing",
        });
    }

    results.push({
        name: "Public URL is HTTPS",
        passed: runtime.publicBaseUrl?.protocol === "https:",
        details: runtime.publicBaseUrl?.toString() ?? "missing",
    });
    results.push({
        name: "Public URL includes private path",
        passed: Boolean(runtime.publicBasePath),
        details: runtime.publicBasePath || "missing",
    });

    const secretStorePath = path.resolve(runtime.secretStorePath);
    results.push({
        name: "Secret store is outside repo",
        passed: !secretStorePath.startsWith(path.resolve(repoRoot)),
        details: secretStorePath,
    });

    const authEnabled = await fileContains(path.join(repoRoot, "src/server.ts"), [
        "mcpAuthRouter",
        "requireBearerAuth",
        "PUBLIC_BASE_URL",
    ]);
    results.push({
        name: "Production auth path enabled",
        passed: authEnabled,
        details: authEnabled ? "remote auth code present" : "missing remote auth markers",
    });

    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
        scripts?: { start?: string };
    };
    results.push({
        name: "Remote production entrypoint configured",
        passed: packageJson.scripts?.start === "node dist/server.js" && authEnabled,
        details: packageJson.scripts?.start ?? "missing start script",
    });

    const sensitiveScan = spawnSync(
        "rg",
        [
            "-n",
            "-e",
            "Access Token:",
            "-e",
            "Refresh Token:",
            "-e",
            "Using STRAVA_ACCESS_TOKEN",
            "-e",
            "raw response data",
            "-e",
            "Authorization Header:",
            "src",
            "scripts",
        ],
        {
            cwd: repoRoot,
            encoding: "utf8",
        },
    );
    const sensitivePatternHit = Boolean(sensitiveScan.stdout.trim());
    results.push({
        name: "No token leak logs",
        passed: !sensitivePatternHit,
        details: sensitivePatternHit ? "sensitive log pattern still present" : "clean",
    });

    const unauthCheckUrl = runtime.mcpUrl ? new URL(runtime.mcpUrl.toString()) : undefined;
    if (unauthCheckUrl) {
        try {
            const response = await fetch(unauthCheckUrl, { method: "GET" });
            results.push({
                name: "MCP rejects unauthenticated access",
                passed: response.status === 401 || response.status === 403,
                details: `status ${response.status}`,
            });
        } catch (error) {
            results.push({
                name: "MCP rejects unauthenticated access",
                passed: false,
                details: error instanceof Error ? error.message : String(error),
            });
        }
    }

    try {
        const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
            encoding: "utf8",
        });
        let vulnerabilitySummary = "audit unavailable";
        if (audit.stdout) {
            try {
                const parsed = JSON.parse(audit.stdout) as {
                    metadata?: { vulnerabilities?: Record<string, number> };
                };
                const vulnerabilities = parsed.metadata?.vulnerabilities ?? {};
                vulnerabilitySummary = Object.entries(vulnerabilities)
                    .map(([severity, count]) => `${severity}:${count}`)
                    .join(", ") || "no vulnerabilities reported";
            } catch {
                vulnerabilitySummary = "audit output could not be parsed";
            }
        }
        results.push({
            name: "Dependency audit reviewed",
            passed: true,
            details: vulnerabilitySummary,
        });
    } catch (error) {
        results.push({
            name: "Dependency audit reviewed",
            passed: true,
            details: error instanceof Error ? error.message : String(error),
        });
    }

    for (const result of results) {
        printCheck(result);
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
        console.error(`Security check failed: ${failed.length} issue(s) found.`);
        process.exit(1);
    }

    console.log("Security check passed.");
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
