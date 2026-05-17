import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function appendPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const cleanBase = url.pathname.replace(/\/+$/, "");
  const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  url.pathname = `${cleanBase}${cleanSuffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function expectHealth(baseUrl: string): Promise<void> {
  const response = await fetch(appendPath(baseUrl, "/health"));
  if (!response.ok) {
    throw new Error(`Health check failed with ${response.status}`);
  }
  const body = await response.json() as { ok?: boolean };
  if (!body.ok) {
    throw new Error("Health endpoint did not return ok=true");
  }
  console.log("Health endpoint OK.");
}

async function expectUnauthorizedMcp(baseUrl: string): Promise<void> {
  const response = await fetch(appendPath(baseUrl, "/mcp"), {
    method: "GET",
  });
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`Expected unauthenticated MCP request to fail, got ${response.status}`);
  }
  console.log("Unauthenticated MCP request rejected as expected.");
}

async function expectAuthenticatedMcp(baseUrl: string, token: string): Promise<void> {
  const client = new Client(
    { name: "strava-mcp-endpoint-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  const transport = new StreamableHTTPClientTransport(new URL(appendPath(baseUrl, "/mcp")), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "get-server-version")) {
      throw new Error("Authenticated MCP call succeeded, but expected tool was not listed.");
    }
    console.log(`Authenticated MCP request succeeded with ${tools.tools.length} tools.`);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("PUBLIC_BASE_URL is required.");
  }

  await expectHealth(baseUrl);
  await expectUnauthorizedMcp(baseUrl);

  const token = process.env.MCP_TEST_BEARER_TOKEN;
  if (token) {
    await expectAuthenticatedMcp(baseUrl, token);
  } else {
    console.log("Skipping authenticated MCP check because MCP_TEST_BEARER_TOKEN is not set.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

