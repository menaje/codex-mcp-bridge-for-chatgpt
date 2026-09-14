import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

const CURRENT_PROTOCOL = "2026-07-28";

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

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
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

function currentEnvelope() {
  return {
    "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
    "io.modelcontextprotocol/clientInfo": { name: "raw-current-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

function currentRequest(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: "raw-" + method,
    method,
    params: { ...params, _meta: currentEnvelope() }
  };
}

async function start(options: Record<string, string> = {}): Promise<RunningServer> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-2026-http-"));
  const config = loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    ...options
  });
  const server = createHttpServer(config, new FixtureUpstream(), new FixtureCatalog());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const item = { root, server, baseUrl: `http://127.0.0.1:${port}` };
  running.push(item);
  return item;
}

describe("MCP 2026-07-28 HTTP server", () => {
  it("discovers and serves only the current tools and resources", async () => {
    const { baseUrl } = await start();
    const client = currentClient("current-http-client");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((tool) => tool.name));
      for (const current of ["codex_task", "codex_models", "codex_ui_read", "codex_question_action"]) {
        expect(names.has(current)).toBe(true);
      }
      for (const retired of [
        "codex_dashboard_snapshot",
        "codex_settings_snapshot",
        "codex_question_card",
        "codex_question_submit",
        "codex_question_notify"
      ]) expect(names.has(retired)).toBe(false);

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
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL
    };
    const discover = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "mcp-method": "server/discover" },
      body: JSON.stringify(currentRequest("server/discover"))
    });
    expect(discover.status).toBe(200);
    expect((await discover.json()).result).toBeTruthy();

    const methodMismatch = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "mcp-method": "tools/list" },
      body: JSON.stringify(currentRequest("server/discover"))
    });
    expect(methodMismatch.status).toBe(400);
    expect((await methodMismatch.json()).error?.code).toBe(-32020);

    const nameMismatch = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-method": "tools/call",
        "mcp-name": "codex_status"
      },
      body: JSON.stringify(currentRequest("tools/call", {
        name: "codex_models",
        arguments: { refresh: true }
      }))
    });
    expect(nameMismatch.status).toBe(400);
    expect((await nameMismatch.json()).error?.code).toBe(-32020);

    const missingEnvelope = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "mcp-method": "tools/list" },
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

  it("applies the explicit origin allowlist before MCP dispatch", async () => {
    const { baseUrl } = await start({ CODEX_MCP_BRIDGE_ALLOWED_ORIGINS: "chatgpt.com" });
    const denied = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test"
      },
      body: "{}"
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
});
