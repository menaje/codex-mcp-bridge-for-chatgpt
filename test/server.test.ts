import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BRIDGE_MCP_INSTRUCTIONS,
  createHttpServer,
  type BridgeHttpRuntimeOptions
} from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";
import { PRODUCT_INFO } from "../src/productInfo.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRESENTATION_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

class FakeUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> {
    return { tools: [] };
  }

  async callTool(): Promise<ToolResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }

  async close(): Promise<void> {}
}

class DeferredUpstream extends FakeUpstream {
  private pending: Array<(result: ToolResult) => void> = [];

  get pendingCount(): number {
    return this.pending.length;
  }

  override async callTool(): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.pending.push(resolve);
    });
  }

  resolveNext(): void {
    const resolve = this.pending.shift();
    if (!resolve) {
      throw new Error("No pending upstream call.");
    }
    resolve({
      content: [
        {
          type: "text",
          text: JSON.stringify({ threadId: "thread-1", content: "done" })
        }
      ]
    });
  }
}

class ThreadUpstream extends FakeUpstream {
  private nextThread = 1;

  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const threadId =
      name === "codex-reply" && typeof args.threadId === "string"
        ? args.threadId
        : `http-thread-${this.nextThread++}`;
    return {
      content: [{ type: "text", text: "done" }],
      structuredContent: { threadId, content: "done" }
    };
  }
}

class FakeModelCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    validatedAt: "2026-08-23T00:00:00.000Z",
    fingerprint: "c".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [{ effort: "high" }, { effort: "max" }],
        isDefault: true,
        serviceTiers: [],
        inputModalities: ["text"]
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ effort: "high" }],
        serviceTiers: [],
        inputModalities: ["text"]
      }
    ]
  };

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    return { ...this.snapshot, models: this.snapshot.models.map((model) => ({ ...model })) };
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return { ...this.snapshot, models: this.snapshot.models.map((model) => ({ ...model })) };
  }
}

const servers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("http server", () => {
  it("publishes the Agent-first public routing contract in server instructions", () => {
    expect(BRIDGE_MCP_INSTRUCTIONS.slice(0, 512)).toContain("scope-owned Activity and Agent");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("nested discriminated inputs");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("continuationOf");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("context='continue'");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("primary-role");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("commit atomically");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toContain("ACTIVITY_METADATA_REQUIRED");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("projectId exposed by the current codex_task descriptor");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("admission-time project");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("programmatic tool calling");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never call codex_activity after codex_task");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("exact authoritative version");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("codex_activity_cancel");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toMatch(/\bsessionMode\b|\badoptThread\b|\bthreadId\b|\bcwd\b/);
  });

  it("serves health without auth", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      name: PRODUCT_INFO.runtimeName,
      title: PRODUCT_INFO.displayName,
      build: { version: PRODUCT_INFO.version, id: expect.any(String), sourceHash: expect.any(String) }
    });
  });

  it("exposes only the supplied aggregate runtime diagnostics through health", async () => {
    const baseUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new FakeUpstream(),
      undefined,
      {
        healthDiagnostics: () => ({
          appServerLateResponses: {
            retained: 2,
            totals: { observed: 7, success: 5, error: 2 },
            latest: { method: "turn/start", outcome: "success", reconciliation: "identifier-recorded" }
          }
        })
      }
    );

    const body = await (await fetch(`${baseUrl}/healthz`)).json() as Record<string, any>;
    expect(body.diagnostics.appServerLateResponses).toEqual({
      retained: 2,
      totals: { observed: 7, success: 5, error: 2 },
      latest: { method: "turn/start", outcome: "success", reconciliation: "identifier-recorded" }
    });
  });

  it("leaves an injected production state store open for upstream shutdown", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-shared-state-"));
    const stateStore = new BridgeStateStore({ file: path.join(stateDirectory, "state.sqlite") });
    try {
      await start(
        { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
        new FakeUpstream(),
        stateDirectory,
        { stateStore }
      );

      await stopLastServer();
      expect(stateStore.getMeta("schema_version")).toMatch(/^\d+$/);
    } finally {
      stateStore.close();
    }
  });

  it("returns JSON for OAuth metadata probes in no-auth tunnel mode", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("requires bearer token on /mcp when configured", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_TOKEN: "secret"
    });

    const denied = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(allowed.status).not.toBe(401);
  });

  it("projects a saved model policy on the next stateless HTTP tools/list", async () => {
    const baseUrl = await start({ CODEX_GPT_BRIDGE_NO_AUTH: "1" });
    const client = new Client({ name: "http-schema-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const initialTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(initialTask.inputSchema.properties).toHaveProperty("selection");
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            modelPolicy: {
              mode: "fixed",
              selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
              constraints: { allowDelegation: true }
            }
          }
        }
      }
    });
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        policyActivation: {
          policyRevision: 1,
          executionPolicyActive: true,
          schemaRefreshRequested: true,
          schemaRefreshGuaranteed: false
        }
      });

    const refreshedTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(refreshedTask.inputSchema).toMatchObject({ additionalProperties: false });
    expect(refreshedTask.inputSchema.properties).not.toHaveProperty("selection");
    expect(refreshedTask.inputSchema.properties).not.toHaveProperty("modelPolicyRevision");
    await client.close();
  });

  it("keeps async Codex jobs across stateless HTTP MCP requests", async () => {
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1"
      },
      upstream
    );
    const client = new Client({
      name: "http-test-client",
      version: "0.0.0"
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    await registerProject(client, mkdtempSync(path.join(tmpdir(), "bridge-http-project-")));

    const policy = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: {} })
    );
    expect(policy.stateStorage).toMatchObject({
      backend: "sqlite",
      transactional: true,
      schemaVersion: 7,
      bridgeInstanceId: expect.any(String),
      activityFoundation: "schema-v7-cancellation-provenance-scope-agent-manager",
      activityPersistent: true
    });

    const started = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: REQUEST_A,
          activityPresentationId: PRESENTATION_A,
          prompt: "slow",
          activity: {
            mode: "new",
            title: "Slow HTTP task",
            policy: { kind: "implementation" }
          },
          agent: { mode: "new", name: "HTTP Agent" }
        }
      })
    );
    expect(started.status).toBe("running");
    expect(typeof started.jobId).toBe("string");

    upstream.resolveNext();
    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed.status).toBe("completed");
    expect(JSON.stringify(completed.result)).toContain("thread-1");

    await client.close();
  });

  it("keeps a foreground job running to completion after its HTTP response detaches", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-http-detach-state-"));
    const stateStore = new BridgeStateStore({ file: path.join(stateDirectory, "state.sqlite") });
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      upstream,
      stateDirectory,
      { stateStore }
    );
    const client = new Client({ name: "http-detach-client", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      await registerProject(client, mkdtempSync(path.join(tmpdir(), "bridge-http-detach-project-")));
      const controller = new AbortController();
      const foreground = rawToolCall(
        baseUrl,
        1201,
        "codex_task",
        {
          scopeId: SCOPE_A,
          requestId: "12121212-1212-4212-8212-121212121212",
          activityPresentationId: "13131313-1313-4313-8313-131313131313",
          prompt: "finish after the foreground caller detaches",
          activity: {
            mode: "new",
            title: "Detached foreground task",
            policy: { kind: "implementation" }
          },
          agent: { mode: "new", name: "Detached HTTP Agent" },
          executionMode: "foreground"
        },
        controller.signal
      );
      await eventually(() => upstream.pendingCount === 1 && stateStore.listJobs().length === 1);
      const running = stateStore.listJobs()[0] as Record<string, any>;
      expect(running).toMatchObject({ status: "running", executionMode: "foreground" });
      controller.abort();
      await expect(foreground).rejects.toThrow();
      await eventually(() => stateStore.listTransportObservations().some((entry) =>
        entry.kind === "http-request-aborted" || entry.kind === "http-response-detached"
      ));
      expect(stateStore.listJobs()).toEqual([
        expect.objectContaining({
          jobId: running.jobId,
          status: "running"
        })
      ]);
      expect(stateStore.listJobs()[0]).not.toHaveProperty("cancellationIntentId");
      expect(stateStore.listCancellationIntents({ jobId: running.jobId })).toHaveLength(0);

      upstream.resolveNext();
      await eventually(() => (stateStore.listJobs()[0] as Record<string, any>)?.status === "completed");
      expect(stateStore.listJobs()).toEqual([
        expect.objectContaining({
          jobId: running.jobId,
          status: "completed",
          terminalOrigin: "normal-completion"
        })
      ]);
      expect(stateStore.listJobs()[0]).not.toHaveProperty("cancellationIntentId");
    } finally {
      await client.close().catch(() => undefined);
      await stopLastServer();
      stateStore.close();
    }
  }, 15_000);

  it("treats an aborted read-only status wait as observation only", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-http-wait-state-"));
    const stateStore = new BridgeStateStore({ file: path.join(stateDirectory, "state.sqlite") });
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      upstream,
      stateDirectory,
      { stateStore }
    );
    const client = new Client({ name: "http-wait-abort-client", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      await registerProject(client, mkdtempSync(path.join(tmpdir(), "bridge-http-wait-project-")));
      const started = parseToolJson(await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: "14141414-1414-4414-8414-141414141414",
          activityPresentationId: "15151515-1515-4515-8515-151515151515",
          prompt: "remain active while status waiting detaches",
          activity: { mode: "new", title: "Read wait task" },
          agent: { mode: "new", name: "Read Wait Agent" },
          executionMode: "background"
        }
      }));
      await eventually(() => upstream.pendingCount === 1);
      const before = stateStore.listJobs()[0] as Record<string, any>;
      const controller = new AbortController();
      const wait = rawToolCall(
        baseUrl,
        1401,
        "codex_status",
        {
          scopeId: SCOPE_A,
          query: { kind: "job", id: started.jobId, waitFor: "terminal", waitMs: 1_000 }
        },
        controller.signal
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await expect(wait).rejects.toThrow();
      await eventually(() => stateStore.listTransportObservations("status-wait-aborted").length > 0);
      expect(stateStore.listJobs()).toEqual([
        expect.objectContaining({
          jobId: started.jobId,
          status: "running",
          version: before.version
        })
      ]);
      expect(stateStore.listJobs()[0]).not.toHaveProperty("cancellationIntentId");
      expect(stateStore.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);

      upstream.resolveNext();
      await eventually(() => (stateStore.listJobs()[0] as Record<string, any>)?.status === "completed");
    } finally {
      await client.close().catch(() => undefined);
      await stopLastServer();
      stateStore.close();
    }
  }, 15_000);

  it("keeps a host-derived scope stable across stateless requests and bridge restarts", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-derived-scope-state-"));
    const metadata = {
      "openai/organization": "http-org",
      "openai/subject": "http-subject",
      "openai/session": "http-session"
    };
    const firstUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const firstClient = new Client({ name: "http-derived-client", version: "0.0.0" });
    await firstClient.connect(new StreamableHTTPClientTransport(new URL(`${firstUrl}/mcp`)));
    await registerProject(
      firstClient,
      mkdtempSync(path.join(tmpdir(), "bridge-derived-scope-project-"))
    );
    const started = await firstClient.callTool({
      name: "codex_task",
      arguments: {
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        activityPresentationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        prompt: "derive scope",
        activity: {
          mode: "new",
          title: "Derive HTTP scope",
          policy: { kind: "investigation" }
        },
        agent: { mode: "new", name: "HTTP Derived Agent" },
        executionMode: "foreground"
      },
      _meta: metadata
    });
    const scopeId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeSession?.scopeId;
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;
    expect(scopeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    await firstClient.close();
    await stopLastServer();

    const secondUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const secondClient = new Client({ name: "http-derived-client", version: "0.0.0" });
    await secondClient.connect(new StreamableHTTPClientTransport(new URL(`${secondUrl}/mcp`)));
    const restored = parseToolJson(
      await secondClient.callTool({ name: "codex_status", arguments: {}, _meta: metadata })
    );
    expect(restored.scopeView).toMatchObject({
      mode: "scoped",
      scopeId,
      source: "host-metadata"
    });
    expect(restored.scopeCounts).toMatchObject({ sessions: 1, jobs: 1 });
    expect(restored.agents).toEqual([
      expect.objectContaining({
        agentId,
        lifecycle: "idle",
        hasCurrentThread: true,
        threadHistoryCount: 1,
        currentThread: expect.objectContaining({ threadId: "http-thread-1" })
      })
    ]);
    expect(JSON.stringify(restored)).not.toContain("http-session");
    expect(JSON.stringify(restored)).not.toContain("http-subject");
    expect(JSON.stringify(restored)).not.toContain("http-org");
    await secondClient.close();
  });

  it("persists explicit Activity attachment and lifecycle updates across HTTP restarts", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-activity-tool-state-"));
    const firstUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const firstClient = new Client({ name: "http-activity-client", version: "0.0.0" });
    await firstClient.connect(new StreamableHTTPClientTransport(new URL(`${firstUrl}/mcp`)));
    await registerProject(
      firstClient,
      mkdtempSync(path.join(tmpdir(), "bridge-activity-project-"))
    );
    const started = await firstClient.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        activityPresentationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        prompt: "persist Activity",
        agent: { mode: "new", name: "HTTP Persistent Agent" },
        executionMode: "foreground",
        activity: {
          mode: "new",
          title: "Persistent Activity",
          policy: { kind: "review", handoff: "none", completion: "manual" }
        }
      }
    });
    const activityId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId;
    expect(activityId).toMatch(/^[0-9a-f-]{36}$/);
    await firstClient.close();
    await stopLastServer();

    const secondUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const secondClient = new Client({ name: "http-activity-client", version: "0.0.0" });
    await secondClient.connect(new StreamableHTTPClientTransport(new URL(`${secondUrl}/mcp`)));
    const beforeUpdate = parseToolJson(await secondClient.callTool({
      name: "codex_status",
      arguments: { scopeId: SCOPE_A, query: { kind: "activity", id: activityId } }
    }));
    const updated = parseToolJson(await secondClient.callTool({
      name: "codex_activity_update",
      arguments: {
        scopeId: SCOPE_A,
        activityId,
        expectedVersion: beforeUpdate.activity.version,
        operation: { kind: "set-policy", policy: { handoff: "notify" } }
      }
    }));
    expect(updated.activity).toMatchObject({
      activityId,
      title: "Persistent Activity",
      kind: "review",
      handoffPolicy: "notify",
      lifecycle: "open",
      counts: { completed: 1 }
    });
    const completed = parseToolJson(await secondClient.callTool({
      name: "codex_activity_update",
      arguments: {
        scopeId: SCOPE_A,
        activityId,
        expectedVersion: updated.activity.version,
        operation: { kind: "complete" }
      }
    }));
    expect(completed.activity).toMatchObject({ lifecycle: "completed", completionVersion: 1 });
    await secondClient.close();
    await stopLastServer();

    const thirdUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const thirdClient = new Client({ name: "http-activity-client", version: "0.0.0" });
    await thirdClient.connect(new StreamableHTTPClientTransport(new URL(`${thirdUrl}/mcp`)));
    const deniedAttachment = await thirdClient.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        activityPresentationId: "99999999-9999-4999-8999-999999999999",
        prompt: "must not attach to completed Activity",
        activity: { mode: "existing", id: activityId }
      }
    });
    expect(deniedAttachment.isError).toBe(true);
    expect(JSON.stringify(deniedAttachment)).toContain("only to an open Activity");
    await thirdClient.close();
  });
});

async function start(
  env: NodeJS.ProcessEnv,
  upstream: CodexUpstream = new FakeUpstream(),
  stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-state-")),
  runtimeOptions: BridgeHttpRuntimeOptions = {}
): Promise<string> {
  const config = loadConfig({
    ...env,
    CODEX_GPT_BRIDGE_HOST: "127.0.0.1",
    CODEX_GPT_BRIDGE_PORT: "1",
    CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(stateDirectory, "settings.json"),
    CODEX_MCP_BRIDGE_SESSION_STATE_FILE: path.join(stateDirectory, "sessions.json"),
    CODEX_MCP_BRIDGE_JOB_STATE_FILE: path.join(stateDirectory, "jobs.json"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(stateDirectory, "state.sqlite")
  });
  const server = createHttpServer(config, upstream, new FakeModelCatalog(), runtimeOptions);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function stopLastServer(): Promise<void> {
  const server = servers.pop();
  if (!server) throw new Error("Expected a running HTTP test server.");
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

async function registerProject(client: Client, cwd: string): Promise<void> {
  const opened = await client.callTool({ name: "codex_settings", arguments: {} });
  const revision = (opened as { structuredContent?: Record<string, any> })
    .structuredContent?.settings?.revision;
  if (!Number.isInteger(revision)) throw new Error("Expected Settings revision.");
  const saved = await client.callTool({
    name: "codex_update_settings",
    arguments: {
      expectedRevision: revision,
      operation: {
        kind: "patch",
        settings: {
          projectOperations: [
            { kind: "add", project: { id: "test-project", label: "Test project", cwd } }
          ]
        }
      }
    }
  });
  if (saved.isError) throw new Error(JSON.stringify(saved));
}

function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text || "{}");
}

function rawToolCall(
  baseUrl: string,
  id: string | number,
  name: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: arguments_ }
    }),
    signal
  }).then(async (response) => {
    const body = await response.text();
    if (!response.ok) throw new Error(`Raw MCP request failed with ${response.status}: ${body}`);
    return body;
  });
}

async function waitForJobStatus(client: Client, jobId: string, expected: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: {
          scopeId: SCOPE_A,
          query: { kind: "job", id: jobId }
        }
      })
    );
    if (status.status === expected) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job status ${expected}.`);
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for expected HTTP bridge state.");
}
