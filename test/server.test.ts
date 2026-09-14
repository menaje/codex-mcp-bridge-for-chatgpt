import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import {
  createHttpServer,
  type BridgeHttpRuntimeOptions,
  type BridgeHttpServer
} from "../src/server.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot,
  ModelCatalogOptions
} from "../src/modelCatalog.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

const CURRENT_PROTOCOL = "2026-07-28";
const CURRENT_TOOL_ORDER = [
  "codex_answer",
  "codex_ask_user",
  "codex_user_answer",
  "codex_question_action",
  "codex_dashboard",
  "codex_status",
  "codex_activity",
  "codex_activity_rehydrate",
  "codex_activity_snapshot",
  "codex_activity_handoff",
  "codex_agent",
  "codex_background_process_terminate",
  "codex_cancel",
  "codex_activity_job_cancel",
  "codex_interaction_respond",
  "codex_steer",
  "codex_job_steer",
  "codex_activity_update",
  "codex_models",
  "codex_settings",
  "codex_update_settings",
  "codex_task",
  "codex_ui_read",
  "codex_ui_problem",
  "codex_ui_history",
  "codex_ui_stop"
] as const;

class FixtureUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> {
    return { tools: [] };
  }

  async callTool(): Promise<ToolResult> {
    return { content: [{ type: "text", text: "fixture" }] };
  }

  async close(): Promise<void> {}
}

class FixtureCatalog implements CodexModelCatalogProvider {
  readonly requests: ModelCatalogOptions[] = [];
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-14T00:00:00.000Z",
    validatedAt: "2026-09-14T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "Fixture Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }],
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };

  async getCatalog(options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    this.requests.push({ ...options });
    return this.snapshot;
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.snapshot;
  }
}

type RunningServer = {
  root: string;
  server: BridgeHttpServer;
  baseUrl: string;
  catalog: FixtureCatalog;
};

const running: RunningServer[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    await rm(item.root, { recursive: true, force: true });
  }
});

function currentClient(name: string): Client {
  return new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: CURRENT_PROTOCOL } } }
  );
}

function currentEnvelope(protocolVersion = CURRENT_PROTOCOL) {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": { name: "raw-current-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

function currentRequest(
  method: string,
  params: Record<string, unknown> = {},
  protocolVersion = CURRENT_PROTOCOL
) {
  return {
    jsonrpc: "2.0",
    id: "raw-" + method,
    method,
    params: { ...params, _meta: currentEnvelope(protocolVersion) }
  };
}

function currentHeaders(
  method: string,
  name?: string,
  additional: Record<string, string> = {}
) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "mcp-protocol-version": CURRENT_PROTOCOL,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
    ...additional
  };
}

async function postWithHost(endpoint: string, host: string): Promise<number> {
  const body = JSON.stringify(currentRequest("server/discover"));
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(endpoint, {
      method: "POST",
      headers: {
        ...currentHeaders("server/discover"),
        host,
        "content-length": String(Buffer.byteLength(body, "utf8"))
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function start(
  options: Record<string, string> = {},
  runtimeOptions: BridgeHttpRuntimeOptions = {}
): Promise<RunningServer> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-2026-http-"));
  const config = loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    ...options
  });
  const catalog = new FixtureCatalog();
  const server = createHttpServer(config, new FixtureUpstream(), catalog, runtimeOptions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const item = { root, server, baseUrl: `http://127.0.0.1:${port}`, catalog };
  running.push(item);
  return item;
}

describe("MCP 2026-07-28 HTTP server", () => {
  it("keeps conformance fixtures opt-in and checks required client capabilities", async () => {
    const normal = await start();
    const normalList = await fetch(`${normal.baseUrl}/mcp`, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(currentRequest("tools/list"))
    });
    const normalNames = ((await normalList.json()).result.tools as Array<{ name: string }>)
      .map((tool) => tool.name);
    expect(normalNames).not.toContain("test_missing_capability");

    const fixtures = await start({}, { conformanceFixtures: true });
    const fixtureList = await fetch(`${fixtures.baseUrl}/mcp`, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(currentRequest("tools/list"))
    });
    const fixtureNames = ((await fixtureList.json()).result.tools as Array<{ name: string }>)
      .map((tool) => tool.name);
    expect(fixtureNames).toEqual(expect.arrayContaining([
      "test_missing_capability",
      "test_streaming_elicitation",
      "test_logging_tool",
      "test_trigger_tool_change"
    ]));

    const missingCapability = await fetch(`${fixtures.baseUrl}/mcp`, {
      method: "POST",
      headers: currentHeaders("tools/call", "test_missing_capability"),
      body: JSON.stringify(currentRequest("tools/call", {
        name: "test_missing_capability",
        arguments: {}
      }))
    });
    expect(missingCapability.status).toBe(400);
    expect((await missingCapability.json()).error).toEqual(expect.objectContaining({
      code: -32021,
      data: expect.objectContaining({ requiredCapabilities: { sampling: {} } })
    }));
  });

  it("discovers and serves only the current tools and resources", async () => {
    const { baseUrl } = await start();
    const client = currentClient("current-http-client");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(CURRENT_TOOL_ORDER);
      for (const current of ["codex_task", "codex_models", "codex_ui_read", "codex_question_action"]) {
        expect(names).toContain(current);
      }
      for (const retired of [
        "codex_dashboard_snapshot",
        "codex_settings_snapshot",
        "codex_question_card",
        "codex_question_submit",
        "codex_question_notify"
      ]) expect(names).not.toContain(retired);

      const task = tools.tools.find((tool) => tool.name === "codex_task");
      expect(task?.inputSchema.properties).toEqual(expect.objectContaining({
        taskContractVersion: expect.any(Object),
        executionEnvelopeRef: expect.any(Object),
        project: expect.any(Object)
      }));
      for (const retired of ["sandbox", "executionPolicyRef", "projectLookup", "presentationId"]) {
        expect(task?.inputSchema.properties).not.toHaveProperty(retired);
      }

      const models = await client.callTool({ name: "codex_models", arguments: { refresh: true } });
      expect(models.isError).not.toBe(true);
      expect(models.structuredContent).toMatchObject({ contractVersion: "2" });

      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(4);
      const activity = resources.resources.find((resource) => resource.name === "codex-activity-card");
      expect(activity?.uri).toMatch(/^ui:\/\/codex-mcp-bridge\/activity\/[a-f0-9]{12}\.html$/);
      expect((await client.readResource({ uri: activity!.uri })).contents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("rejects the retired initialize handshake and stateful HTTP verbs", async () => {
    const { baseUrl } = await start();
    const legacy = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "retired-client", version: "1" }
        }
      })
    });
    expect(legacy.ok).toBe(false);
    expect(await legacy.text()).toMatch(/legacy|2026-07-28|unsupported|protocol/i);

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp`, { method });
      expect(response.ok).toBe(false);
    }
  });

  it("uses the current request envelope and rejects protocol/header mismatches", async () => {
    const { baseUrl } = await start();
    const endpoint = baseUrl + "/mcp";
    const discover = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("server/discover"),
      body: JSON.stringify(currentRequest("server/discover"))
    });
    expect(discover.status).toBe(200);
    const discoverResult = (await discover.json()).result;
    expect(discoverResult).toEqual(expect.objectContaining({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      supportedVersions: [CURRENT_PROTOCOL],
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true }
      }
    }));

    const toolsList = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(currentRequest("tools/list"))
    });
    expect(toolsList.status).toBe(200);
    const toolsListResult = (await toolsList.json()).result;
    expect(toolsListResult).toEqual(expect.objectContaining({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private"
    }));
    expect(toolsListResult.tools.map((tool: { name: string }) => tool.name)).toEqual(
      CURRENT_TOOL_ORDER
    );

    const methodMismatch = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(currentRequest("server/discover"))
    });
    expect(methodMismatch.status).toBe(400);
    expect((await methodMismatch.json()).error?.code).toBe(-32020);

    const nameMismatch = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/call", "codex_status"),
      body: JSON.stringify(currentRequest("tools/call", {
        name: "codex_models",
        arguments: { refresh: true }
      }))
    });
    expect(nameMismatch.status).toBe(400);
    expect((await nameMismatch.json()).error?.code).toBe(-32020);

    const missingMethod = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list", undefined, { "mcp-method": "" }),
      body: JSON.stringify(currentRequest("tools/list"))
    });
    expect(missingMethod.status).toBe(400);
    expect((await missingMethod.json()).error?.code).toBe(-32020);

    const unsupportedVersion = "2026-08-01";
    const unsupported = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list", undefined, {
        "mcp-protocol-version": unsupportedVersion
      }),
      body: JSON.stringify(currentRequest("tools/list", {}, unsupportedVersion))
    });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toEqual(expect.objectContaining({
      code: -32022,
      data: {
        requested: unsupportedVersion,
        supported: [CURRENT_PROTOCOL]
      }
    }));

    const missingEnvelope = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "raw-missing-envelope",
        method: "tools/list",
        params: {}
      })
    });
    expect(missingEnvelope.status).toBe(400);
    expect((await missingEnvelope.json()).error?.code).toBe(-32602);
  });

  it("accepts optional client identity and pins current wire-only behavior", async () => {
    const { baseUrl, catalog } = await start();
    const endpoint = `${baseUrl}/mcp`;
    const optionalIdentityRequest = currentRequest("server/discover");
    delete (optionalIdentityRequest.params._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientInfo"
    ];
    const discover = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("server/discover"),
      body: JSON.stringify(optionalIdentityRequest)
    });
    expect(discover.status).toBe(200);
    const discoverResult = (await discover.json()).result;
    expect(discoverResult._meta?.["io.modelcontextprotocol/serverInfo"])
      .toEqual(expect.objectContaining({ name: expect.any(String), version: expect.any(String) }));

    const dashboard = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/call", "codex_dashboard"),
      body: JSON.stringify(currentRequest("tools/call", {
        name: "codex_dashboard",
        arguments: {}
      }))
    });
    expect(dashboard.status).toBe(200);
    const dashboardResult = (await dashboard.json()).result;
    expect(dashboardResult).toEqual(expect.objectContaining({ resultType: "complete" }));
    expect(dashboardResult._meta).toEqual(expect.objectContaining({
      "io.modelcontextprotocol/serverInfo": expect.objectContaining({
        name: expect.any(String), version: expect.any(String)
      }),
      "openai/locale": "en"
    }));

    const tracedList = currentRequest("tools/list");
    Object.assign(tracedList.params._meta as Record<string, unknown>, {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "fixture=value",
      baggage: "fixture=value",
      "io.modelcontextprotocol/logLevel": "debug"
    });
    const traced = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(tracedList)
    });
    expect(traced.status).toBe(200);
    expect((await traced.json()).result).toEqual(expect.objectContaining({ resultType: "complete" }));

    for (const method of ["ping", "logging/setLevel"]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: currentHeaders(method),
        body: JSON.stringify(currentRequest(method))
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error?.code).toBe(-32601);
    }

    const missingResource = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("resources/read", "ui://codex-mcp-bridge/not-retained.html"),
      body: JSON.stringify(currentRequest("resources/read", {
        uri: "ui://codex-mcp-bridge/not-retained.html"
      }))
    });
    const missingResourceBody = await missingResource.json();
    expect(missingResource.status).toBe(200);
    expect(missingResourceBody.error?.code).toBe(-32602);

    const callsBefore = catalog.requests.length;
    const models = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/call", "codex_models", {
        "mcp-param-refresh": "false"
      }),
      body: JSON.stringify(currentRequest("tools/call", {
        name: "codex_models",
        arguments: { refresh: true }
      }))
    });
    expect(models.status).toBe(200);
    expect((await models.json()).result).toEqual(expect.objectContaining({ resultType: "complete" }));
    expect(catalog.requests.slice(callsBefore)).toContainEqual(
      expect.objectContaining({ refresh: true })
    );

    const listedTools = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("tools/list"),
      body: JSON.stringify(currentRequest("tools/list"))
    });
    const listedModels = ((await listedTools.json()).result.tools as Array<Record<string, unknown>>)
      .find((tool) => tool.name === "codex_models");
    expect(JSON.stringify(listedModels)).not.toContain("x-mcp-header");
  });

  it("keeps discovery lists stable across conversation scopes", async () => {
    const { baseUrl } = await start();
    const endpoint = `${baseUrl}/mcp`;
    const listFor = async (method: "tools/list" | "resources/list", session: string) => {
      const request = currentRequest(method);
      (request.params._meta as Record<string, unknown>)["openai/session"] = session;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: currentHeaders(method),
        body: JSON.stringify(request)
      });
      expect(response.status).toBe(200);
      return (await response.json()).result as Record<string, unknown>;
    };

    const firstSession = "list-scope-a";
    const secondSession = "list-scope-b";
    const [firstTools, secondTools, firstResources, secondResources] = await Promise.all([
      listFor("tools/list", firstSession),
      listFor("tools/list", secondSession),
      listFor("resources/list", firstSession),
      listFor("resources/list", secondSession)
    ]);

    expect(firstTools).toEqual(secondTools);
    expect(firstResources).toEqual(secondResources);
    expect(firstTools).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect(firstResources).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect((firstTools.tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(CURRENT_TOOL_ORDER);
    const resourceUris = (firstResources.resources as Array<{ uri: string }>).map((resource) => resource.uri);
    expect(resourceUris).toEqual([...resourceUris].sort());
  });

  it("opens, closes, and reopens current change subscriptions", async () => {
    const { baseUrl } = await start();
    const client = currentClient("current-subscription-client");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const filter = { toolsListChanged: true, resourcesListChanged: true };
      const first = await client.listen(filter, { timeout: 2_000 });
      expect(first.honoredFilter).toEqual(filter);
      await first.close();
      await expect(first.closed).resolves.toBe("local");

      const reopened = await client.listen(filter, { timeout: 2_000 });
      expect(reopened.honoredFilter).toEqual(filter);
      await reopened.close();
      await expect(reopened.closed).resolves.toBe("local");
    } finally {
      await client.close();
    }
  });

  it("enforces host and origin allowlists before MCP dispatch", async () => {
    const { baseUrl } = await start({
      CODEX_MCP_BRIDGE_ALLOWED_HOSTS: "127.0.0.1",
      CODEX_MCP_BRIDGE_ALLOWED_ORIGINS: "chatgpt.com"
    });
    const endpoint = `${baseUrl}/mcp`;

    for (const additional of [{}, { origin: "https://chatgpt.com" }]) {
      const allowed = await fetch(endpoint, {
        method: "POST",
        headers: currentHeaders("server/discover", undefined, additional),
        body: JSON.stringify(currentRequest("server/discover"))
      });
      expect(allowed.status).toBe(200);
    }

    const denied = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test"
      },
      body: "{}"
    });
    expect(denied.status).toBe(403);

    expect(await postWithHost(endpoint, "example.test")).toBe(403);
  });

  it("requires the configured bearer token", async () => {
    const { baseUrl } = await start({
      CODEX_MCP_BRIDGE_NO_AUTH: "0",
      CODEX_MCP_BRIDGE_TOKEN: "test-token"
    });
    const endpoint = `${baseUrl}/mcp`;

    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: currentHeaders(
          "server/discover",
          undefined,
          authorization ? { authorization } : {}
        ),
        body: JSON.stringify(currentRequest("server/discover"))
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "unauthorized" });
    }

    const allowed = await fetch(endpoint, {
      method: "POST",
      headers: currentHeaders("server/discover", undefined, {
        authorization: "Bearer test-token"
      }),
      body: JSON.stringify(currentRequest("server/discover"))
    });
    expect(allowed.status).toBe(200);
  });
});
