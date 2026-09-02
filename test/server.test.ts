import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { ACTIVITY_VIEW_METADATA_KEY } from "../src/activityCard.js";
import { validateActivityViewPrivateMetadata } from "../src/tools.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import { SdkToolDescriptorCoordinator } from "../src/modelPolicyTransport.js";

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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("task contract v2");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("executionEnvelopeRef");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("do not require a ChatGPT developer-mode Refresh");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("Refresh only after EXECUTION_ENVELOPE_CHANGED");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("projectLookup in the same conversation");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("mandatory even when only one project is registered");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never infer a first, sole, default, slug");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "Never call codex_settings merely because a conversation starts or this plugin is attached"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "Lookup admits no Activity, Agent, Job, session, or upstream work"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "admits no Activity, Agent, Job, session, or upstream work"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("exposes no Activity-card UI");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("A changed or stale selector uses the same projectLookup recovery");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("opens Settings only as its returned recovery action");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("opaque projectRef");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("projectRevision");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("private project identity and cwd snapshot");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("pre-v2 cached executionPolicyRef");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("same v2 contract with a new requestId and without Refresh");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("stable v2 descriptor always exposes generic bounded selection");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toContain("exact saved fallback");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toContain("based on the task requirements");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "codex_task is execution-only and never mounts an Activity card"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "call codex_activity at most once using mode compact-monitor"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain(
      "Never call the compact presenter once per Task or Agent"
    );
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("default full-history mode");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toContain("activityPresentationId");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("current/action-needed Activity rows");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("scoped paginated full Activity view");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("structured answer");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never contain Job answer bodies");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never start another codex_task merely to reconstruct");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("exact authoritative version");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("codex_activity_cancel");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("Use codex_steer only");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never automatically retry DELIVERY_UNCERTAIN");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("never relay its instructions automatically");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("serialized waves or worktree isolation");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toMatch(/\bsessionMode\b|\badoptThread\b|\bthreadId\b/);
  });

  it("serves health without auth", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_NO_AUTH: "1"
    });

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: PRODUCT_INFO.runtimeName,
      title: PRODUCT_INFO.displayName
    });
  });

  it("does not expose supplied operator diagnostics through health", async () => {
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
    expect(body).toEqual({
      ok: true,
      name: PRODUCT_INFO.runtimeName,
      title: PRODUCT_INFO.displayName
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

  it("keeps the stateless HTTP task descriptor stable after a saved model-policy change", async () => {
    const baseUrl = await start({ CODEX_GPT_BRIDGE_NO_AUTH: "1" });
    const client = new Client({ name: "http-schema-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });

    const initialTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(initialTask.inputSchema.properties).toHaveProperty("selection");
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
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
    expect(parseToolJson(saved)).toMatchObject({
      settings: {
        settingsRevision: 1,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
        }
      },
      policyActivation: {
        policyRevision: 1
      }
    });
    expect((saved as { _meta?: Record<string, any> })._meta?.["codex/settingsView"])
      .toMatchObject({
        policyActivation: {
          policyRevision: 1,
          executionPolicyActive: true,
          descriptorProjectionUpdated: false,
          developerModeRefreshRequired: false
        }
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listChanged).toBe(0);

    const refreshedTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(refreshedTask.inputSchema).toMatchObject({ additionalProperties: false });
    expect(refreshedTask).toEqual(initialTask);
    expect(refreshedTask.inputSchema.properties).toHaveProperty("selection");
    expect(refreshedTask.inputSchema.properties).not.toHaveProperty("modelPolicyRevision");
    await client.close();
  });

  it("keeps one opt-in stateful HTTP session without a descriptor change for settings", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "stateful-schema-client", version: "0.0.0" });
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const initialTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(initialTask.inputSchema.properties).toHaveProperty("selection");
    // The initialized notification opens the standalone GET SSE stream
    // asynchronously. Give it one event-loop turn before publishing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listChanged).toBe(0);
    const refreshedTask = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(refreshedTask).toEqual(initialTask);

    await client.close();
    const reconnect = new AbortController();
    const stream = await openStatefulSse(baseUrl, sessionId as string, reconnect.signal);
    expect(stream.status).toBe(200);
    reconnect.abort();

    const listed = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 701,
      method: "tools/list",
      params: {}
    }, sessionId);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("codex_task");
  });

  it("keeps one descriptor epoch across two active sessions after settings change", async () => {
    const coordinator = new SdkToolDescriptorCoordinator();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
      },
      new FakeUpstream(),
      undefined,
      { descriptorCoordinator: coordinator }
    );
    const first = new Client({ name: "stateful-shared-first", version: "0.0.0" });
    const second = new Client({ name: "stateful-shared-second", version: "0.0.0" });
    let firstChanged = 0;
    let secondChanged = 0;
    first.setNotificationHandler(ToolListChangedNotificationSchema, () => { firstChanged += 1; });
    second.setNotificationHandler(ToolListChangedNotificationSchema, () => { secondChanged += 1; });
    await Promise.all([
      first.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))),
      second.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
    ]);
    const firstBefore = (await first.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const secondBefore = (await second.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(firstBefore.inputSchema).toEqual(secondBefore.inputSchema);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await first.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstChanged).toBe(0);
    expect(secondChanged).toBe(0);
    expect(coordinator.status).toMatchObject({
      bindingCount: 2,
      descriptorEpoch: 1,
      notificationAttemptCount: 0
    });

    const firstAfter = (await first.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const secondAfter = (await second.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(firstAfter.inputSchema).toEqual(secondAfter.inputSchema);
    expect(firstAfter).toEqual(firstBefore);
    expect(secondAfter).toEqual(secondBefore);
    expect(coordinator.status).toMatchObject({
      clientRelistObservationCount: expect.any(Number),
      clientRelistedSessionCount: 2,
      lastClientRelistedEpoch: coordinator.status.descriptorEpoch
    });

    await Promise.all([first.close(), second.close()]);
  });

  it("keeps the descriptor stable while runtime project availability changes", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "bridge-availability-"));
    const projectRoot = path.join(parent, "project");
    const offlineRoot = path.join(parent, "project-offline");
    mkdirSync(projectRoot);
    const coordinator = new SdkToolDescriptorCoordinator();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
      },
      new FakeUpstream(),
      undefined,
      {
        descriptorCoordinator: coordinator,
        descriptorReconcileIntervalMs: 60_000
      }
    );
    const client = new Client({ name: "stateful-availability-client", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      await registerProject(client, projectRoot);
      const before = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      const contract = await currentTaskContract(client);
      const selector = contract.project;
      const initialEpoch = coordinator.status.descriptorEpoch;

      renameSync(projectRoot, offlineRoot);
      servers.at(-1)?.reconcileMcpDescriptorAvailability();
      expect(coordinator.status.descriptorEpoch).toBe(initialEpoch);
      // An unrelated catalog-driven full descriptor rebuild must use the same
      // stable availability projection rather than bypassing the debounce.
      await client.callTool({ name: "codex_models", arguments: {} });
      expect(coordinator.status.descriptorEpoch).toBe(initialEpoch);
      const transient = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(transient).toEqual(before);

      servers.at(-1)?.reconcileMcpDescriptorAvailability();
      expect(coordinator.status.descriptorEpoch).toBe(initialEpoch);
      const unavailable = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(unavailable).toEqual(before);
      const unavailableLookup = parseToolJson(await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: randomUUID(),
          taskContractVersion: contract.taskContractVersion,
          executionEnvelopeRef: contract.executionEnvelopeRef,
          prompt: "check unavailable project",
          projectLookup: { name: selector.name }
        }
      }));
      expect(unavailableLookup.error).toMatchObject({ code: "PROJECT_UNAVAILABLE" });

      renameSync(offlineRoot, projectRoot);
      servers.at(-1)?.reconcileMcpDescriptorAvailability();
      expect(coordinator.status.descriptorEpoch).toBe(initialEpoch);
      servers.at(-1)?.reconcileMcpDescriptorAvailability();
      const restored = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(restored).toEqual(before);
      expect(coordinator.status.descriptorEpoch).toBe(initialEpoch);
      expect((await currentTaskContract(client)).project).toEqual(selector);
    } finally {
      await client.close().catch(() => undefined);
      if (existsSync(offlineRoot) && !existsSync(projectRoot)) {
        renameSync(offlineRoot, projectRoot);
      }
    }
  });

  it("rejects missing and invalid stateful session IDs and terminates an exact session", async () => {
    const coordinator = new SdkToolDescriptorCoordinator();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
      },
      new FakeUpstream(),
      undefined,
      { descriptorCoordinator: coordinator }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "stateful-routing-client", version: "0.0.0" });
    await client.connect(transport);
    const sessionId = transport.sessionId as string;
    await client.listTools();
    expect(coordinator.status).toMatchObject({
      bindingCount: 1,
      notificationEligibleBindingCount: 1,
      clientRelistedSessionCount: 1
    });

    const missing = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 702,
      method: "tools/list",
      params: {}
    });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Mcp-Session-Id");

    const invalid = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 703,
      method: "tools/list",
      params: {}
    }, "00000000-0000-4000-8000-000000000000");
    expect(invalid.status).toBe(404);
    expect(await invalid.text()).toContain("Session not found");

    const missingGet = await fetch(`${baseUrl}/mcp`, {
      headers: { accept: "text/event-stream" }
    });
    expect(missingGet.status).toBe(400);
    const invalidDelete = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" }
    });
    expect(invalidDelete.status).toBe(404);

    await client.close();
    const terminated = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId }
    });
    expect(terminated.status).toBe(200);
    await eventually(() => coordinator.status.bindingCount === 0);
    expect(coordinator.status.clientRelistedSessionCount).toBe(0);
    const afterTermination = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 704,
      method: "tools/list",
      params: {}
    }, sessionId);
    expect(afterTermination.status).toBe(404);
  });

  it("bounds stateful sessions, expires idle sessions, and admits a replacement", async () => {
    let now = 1_000;
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful",
        CODEX_MCP_BRIDGE_MCP_SESSION_IDLE_TTL_MS: "1000",
        CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS: "1"
      },
      new FakeUpstream(),
      undefined,
      {
        mcpSessionNow: () => now,
        mcpSessionSweepIntervalMs: 60_000
      }
    );
    const firstTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const first = new Client({ name: "stateful-capacity-first", version: "0.0.0" });
    await first.connect(firstTransport);
    const firstSessionId = firstTransport.sessionId as string;

    const secondTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const second = new Client({ name: "stateful-capacity-second", version: "0.0.0" });
    await expect(second.connect(secondTransport)).rejects.toThrow(/503|capacity/i);
    await second.close().catch(() => undefined);

    now = 2_001;
    await servers.at(-1)?.sweepMcpSessions();
    // A long-lived GET SSE stream is observation state, so it does not keep an
    // otherwise idle session alive forever.
    await first.close();
    const expired = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 705,
      method: "tools/list",
      params: {}
    }, firstSessionId);
    expect(expired.status).toBe(404);

    const replacementTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const replacement = new Client({ name: "stateful-capacity-replacement", version: "0.0.0" });
    await replacement.connect(replacementTransport);
    expect(replacementTransport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await replacement.close();
  });

  it("releases stateful capacity when initialization detaches after session registration", async () => {
    const coordinator = new SdkToolDescriptorCoordinator();
    const controller = new AbortController();
    let now = 1_000;
    let generatedSessionCount = 0;
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful",
        CODEX_MCP_BRIDGE_MAX_MCP_SESSIONS: "1"
      },
      new FakeUpstream(),
      undefined,
      {
        descriptorCoordinator: coordinator,
        mcpSessionNow: () => now,
        mcpSessionSweepIntervalMs: 60_000,
        mcpSessionIdGenerator: () => {
          generatedSessionCount += 1;
          if (generatedSessionCount === 1) {
            // Session registration happens synchronously after generation. The
            // SDK then yields before producing the initialize response, giving
            // this abort a deterministic post-registration boundary.
            queueMicrotask(() => controller.abort());
          }
          return `00000000-0000-4000-8000-${String(generatedSessionCount).padStart(12, "0")}`;
        }
      }
    );

    const detachedInitialize = fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 706,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "detached-initialize", version: "0.0.0" }
        }
      }),
      signal: controller.signal
    });
    await expect(detachedInitialize).rejects.toThrow();
    await eventually(() => generatedSessionCount === 1 && coordinator.status.bindingCount === 1);
    // An initialize response can finish server-side just before peer abort is
    // observable. Such a session never sends notifications/initialized, so it
    // receives a short handshake grace instead of consuming the full idle TTL.
    now = 11_001;
    await servers.at(-1)?.sweepMcpSessions();
    await eventually(() => coordinator.status.bindingCount === 0);

    const replacementTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const replacement = new Client({ name: "post-detach-replacement", version: "0.0.0" });
    await replacement.connect(replacementTransport);
    expect(replacementTransport.sessionId).toBe("00000000-0000-4000-8000-000000000002");
    await replacement.close();
  });

  it("closes active stateful SSE sessions during ordinary HTTP server shutdown", async () => {
    const baseUrl = await start({
      CODEX_GPT_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
    });
    const client = new Client({ name: "stateful-shutdown-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    await Promise.race([
      stopLastServer(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Stateful HTTP shutdown timed out.")), 2_000);
      })
    ]);
    await client.close().catch(() => undefined);
  });

  it("treats stateful DELETE as transport cleanup without cancelling an admitted Job", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-stateful-delete-state-"));
    const stateStore = new BridgeStateStore({ file: path.join(stateDirectory, "state.sqlite") });
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
      },
      upstream,
      stateDirectory,
      { stateStore }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "stateful-delete-client", version: "0.0.0" });
    try {
      await client.connect(transport);
      await registerProject(
        client,
        mkdtempSync(path.join(tmpdir(), "bridge-stateful-delete-project-"))
      );
      const taskContract = await currentTaskContract(client);
      const started = parseToolJson(await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: "71717171-7171-4171-8171-717171717171",
          activityPresentationId: "72727272-7272-4272-8272-727272727272",
          prompt: "continue after the MCP session is deleted",
          ...taskContract,
          activity: { mode: "new", title: "Stateful delete task" },
          agent: { mode: "new", name: "Stateful Delete Agent" },
          executionMode: "background"
        }
      }));
      await eventually(() => upstream.pendingCount === 1);
      const sessionId = transport.sessionId as string;
      await client.close();

      const terminated = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId }
      });
      expect(terminated.status).toBe(200);
      expect(stateStore.listJobs()).toEqual([
        expect.objectContaining({ jobId: started.jobId, status: "running" })
      ]);
      expect(stateStore.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);
      expect(stateStore.listCancellationOperations(SCOPE_A)).toHaveLength(0);

      upstream.resolveNext();
      await eventually(() => (stateStore.listJobs()[0] as Record<string, any>)?.status === "completed");
      expect(stateStore.listJobs()[0]).toMatchObject({
        jobId: started.jobId,
        status: "completed",
        terminalOrigin: "normal-completion"
      });
      expect(stateStore.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);
    } finally {
      await client.close().catch(() => undefined);
      await stopLastServer();
      stateStore.close();
    }
  }, 15_000);

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
    const taskContract = await currentTaskContract(client);

    const diagnostics = parseToolJson(
      await client.callTool({ name: "codex_diagnostics", arguments: {} })
    );
    expect(diagnostics.storage).toMatchObject({
      backend: "sqlite",
      transactional: true,
      schemaVersion: 12,
      activityPersistent: true,
      sessionPersistent: true,
      settingsPersistent: true
    });
    expect(diagnostics.forensics.bridgeInstanceId).toEqual(expect.any(String));

    const started = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: REQUEST_A,
          activityPresentationId: PRESENTATION_A,
          prompt: "slow",
          ...taskContract,
          activity: {
            mode: "new",
            title: "Slow HTTP task",
            policy: { kind: "implementation" }
          },
          agent: { mode: "new", name: "HTTP Agent" }
        }
      })
    );
    expect(started.state).toBe("running");
    expect(typeof started.jobId).toBe("string");

    upstream.resolveNext();
    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed.state).toBe("completed");
    expect(completed.result).toMatchObject({
      availability: "delivered",
      omitted: false
    });
    expect(JSON.stringify(completed.result)).not.toContain("done");

    await client.close();
  });

  it("does not enable descriptor notifications until notifications/initialized arrives", async () => {
    const coordinator = new SdkToolDescriptorCoordinator();
    const baseUrl = await start(
      {
        CODEX_GPT_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_MCP_TRANSPORT_MODE: "stateful"
      },
      new FakeUpstream(),
      undefined,
      { descriptorCoordinator: coordinator }
    );
    const initializedResponse = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 601,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "manual-readiness-client", version: "0.0.0" }
      }
    });
    const sessionId = initializedResponse.headers.get("mcp-session-id");
    expect(initializedResponse.status).toBe(200);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await initializedResponse.text();
    expect(coordinator.status).toMatchObject({
      bindingCount: 1,
      notificationEligibleBindingCount: 0,
      notificationAttemptCount: 0
    });

    coordinator.publish({
      ...coordinator.current!,
      description: `${coordinator.current?.description || "codex_task"} before initialized`
    });
    coordinator.flushNotifications();
    expect(coordinator.status).toMatchObject({
      notificationEligibleBindingCount: 0,
      notificationAttemptCount: 0
    });

    const ready = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }, sessionId as string);
    expect(ready.status).toBeGreaterThanOrEqual(200);
    expect(ready.status).toBeLessThan(300);
    await ready.text();
    await eventually(() => coordinator.status.notificationEligibleBindingCount === 1);
    await eventually(() => coordinator.status.notificationAttemptCount === 1);

    const latestList = await rawMcpRequest(baseUrl, {
      jsonrpc: "2.0",
      id: 602,
      method: "tools/list",
      params: {}
    }, sessionId as string);
    expect(latestList.status).toBe(200);
    expect(await latestList.text()).toContain("before initialized");

    coordinator.publish({
      ...coordinator.current!,
      description: `${coordinator.current?.description || "codex_task"} after initialized`
    });
    coordinator.flushNotifications();
    expect(coordinator.status.notificationAttemptCount).toBe(2);

    // The SDK stores the notification above, but a fresh standalone GET has no
    // priming Last-Event-ID anchor. The bridge must re-signal the still-unlisted
    // epoch after attaching the new stream instead of assuming stored delivery.
    const reconnected = await openStatefulSse(
      baseUrl,
      sessionId as string,
      new AbortController().signal
    );
    expect(reconnected.status).toBe(200);
    const reconnectReader = reconnected.body!.getReader();
    const reconnectChunk = await Promise.race([
      reconnectReader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for reconnect list change.")), 2_000);
      })
    ]);
    const reconnectEvent = new TextDecoder().decode(reconnectChunk.value);
    expect(reconnectEvent).toContain("notifications/tools/list_changed");
    const lastEventId = /^id: ([^\n]+)/m.exec(reconnectEvent)?.[1];
    expect(lastEventId).toMatch(/^evt_/);
    expect(coordinator.status.notificationAttemptCount).toBe(3);
    await reconnectReader.cancel();

    coordinator.publish({
      ...coordinator.current!,
      description: `${coordinator.current?.description || "codex_task"} after reconnect`
    });
    coordinator.flushNotifications();
    expect(coordinator.status.notificationAttemptCount).toBe(4);

    const replay = await openStatefulReplaySse(
      baseUrl,
      sessionId as string,
      lastEventId as string
    );
    expect(replay.status).toBe(200);
    const replayReader = replay.body!.getReader();
    const replayChunk = await Promise.race([
      replayReader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for replayed list change.")), 2_000);
      })
    ]);
    expect(new TextDecoder().decode(replayChunk.value)).toContain(
      "notifications/tools/list_changed"
    );
    await replayReader.cancel();

    const terminated = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId as string }
    });
    expect(terminated.status).toBe(200);
    await eventually(() => coordinator.status.bindingCount === 0);
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
      const taskContract = await currentTaskContract(client);
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
          ...taskContract,
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
      expect(stateStore.listCancellationOperations(SCOPE_A)).toHaveLength(0);
      const eventTypes = stateStore.listJobEvents(running.jobId)
        .map((event) => event.eventType);
      expect(eventTypes).not.toContain("cancellation-intent-recorded");
      expect(eventTypes).not.toContain("job-terminating");
      expect(eventTypes).not.toContain("job-cancelled");

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
      expect(stateStore.listCancellationIntents({ jobId: running.jobId })).toHaveLength(0);
      expect(stateStore.listCancellationOperations(SCOPE_A)).toHaveLength(0);
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
      const taskContract = await currentTaskContract(client);
      const started = parseToolJson(await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: "14141414-1414-4414-8414-141414141414",
          activityPresentationId: "15151515-1515-4515-8515-151515151515",
          prompt: "remain active while status waiting detaches",
          ...taskContract,
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
      expect(stateStore.listCancellationOperations(SCOPE_A)).toHaveLength(0);

      upstream.resolveNext();
      await eventually(() => (stateStore.listJobs()[0] as Record<string, any>)?.status === "completed");
      expect(stateStore.listJobs()[0]).toMatchObject({
        jobId: started.jobId,
        status: "completed",
        terminalOrigin: "normal-completion"
      });
      expect(stateStore.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);
      expect(stateStore.listCancellationOperations(SCOPE_A)).toHaveLength(0);
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
    const firstTaskContract = await currentTaskContract(firstClient);
    const started = await firstClient.callTool({
      name: "codex_task",
      arguments: {
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        activityPresentationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        prompt: "derive scope",
        ...firstTaskContract,
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
    const startedStructured = parseToolJson(started);
    const agentId = startedStructured.agentId;
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
    expect(restored.scope).toMatchObject({
      mode: "scoped",
      source: "host-metadata"
    });
    expect(restored.counts).toMatchObject({ sessions: 1, jobs: 1 });
    expect(restored.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent", id: agentId, state: "idle" }),
      expect.objectContaining({ type: "job", agentId, threadId: "http-thread-1" })
    ]));
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
    const firstTaskContract = await currentTaskContract(firstClient);
    const started = await firstClient.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        activityPresentationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        prompt: "persist Activity",
        ...firstTaskContract,
        agent: { mode: "new", name: "HTTP Persistent Agent" },
        executionMode: "foreground",
        activity: {
          mode: "new",
          title: "Persistent Activity",
          policy: { kind: "review", handoff: "none", completion: "manual" }
        }
      }
    });
    const activityId = parseToolJson(started).activityId;
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
        expectedVersion: statusItem(beforeUpdate, "activity", activityId).version,
        operation: { kind: "set-policy", policy: { handoff: "notify" } }
      }
    }));
    expect(updated).toMatchObject({
      target: { type: "activity", id: activityId, state: "open" },
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
    });
    const updatedView = privateActivityView(await secondClient.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A, activityId }
    }));
    expect(updatedView.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activityId,
        title: "Persistent Activity",
        lifecycle: "open",
        counts: expect.objectContaining({ completed: 1 })
      })
    ]));
    const completed = parseToolJson(await secondClient.callTool({
      name: "codex_activity_update",
      arguments: {
        scopeId: SCOPE_A,
        activityId,
        expectedVersion: updated.target.version,
        operation: { kind: "complete" }
      }
    }));
    expect(completed.target).toMatchObject({
      type: "activity",
      id: activityId,
      state: "completed"
    });
    await secondClient.close();
    await stopLastServer();
    const persistedStore = new BridgeStateStore({
      file: path.join(stateDirectory, "state.sqlite")
    });
    expect(persistedStore.getActivity(activityId)).toMatchObject({
      lifecycle: "completed",
      handoffPolicy: "notify",
      completionVersion: 1
    });
    persistedStore.close();

    const thirdUrl = await start(
      { CODEX_GPT_BRIDGE_NO_AUTH: "1" },
      new ThreadUpstream(),
      stateDirectory
    );
    const thirdClient = new Client({ name: "http-activity-client", version: "0.0.0" });
    await thirdClient.connect(new StreamableHTTPClientTransport(new URL(`${thirdUrl}/mcp`)));
    const thirdTaskContract = await currentTaskContract(thirdClient);
    const completedView = privateActivityView(await thirdClient.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A, activityId }
    }));
    expect(completedView.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId, lifecycle: "completed" })
    ]));
    const deniedAttachment = await thirdClient.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        activityPresentationId: "99999999-9999-4999-8999-999999999999",
        prompt: "must not attach to completed Activity",
        taskContractVersion: thirdTaskContract.taskContractVersion,
        executionEnvelopeRef: thirdTaskContract.executionEnvelopeRef,
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
  const revision = parseToolJson(opened).revisions?.registry;
  if (!Number.isInteger(revision)) throw new Error("Expected project registry revision.");
  const saved = await client.callTool({
    name: "codex_update_settings",
    arguments: {
      expectedRegistryRevision: revision,
      operation: {
        kind: "patch",
        settings: {
          projectOperations: [
            { kind: "add", project: { name: "Test Project", cwd } }
          ]
        }
      }
    }
  });
  if (saved.isError) throw new Error(JSON.stringify(saved));
}

function parseToolJson(result: unknown): Record<string, any> {
  return (result as { structuredContent?: Record<string, any> }).structuredContent || {};
}

function statusItem(
  status: Record<string, any>,
  type: "activity" | "agent" | "job" | "thread",
  id?: string
): Record<string, any> {
  const item = status.items?.find((entry: Record<string, any>) =>
    entry.type === type && (id === undefined || entry.id === id)
  );
  if (!item) throw new Error(`Expected ${type} status item${id ? ` ${id}` : ""}.`);
  return item;
}

function privateActivityView(result: unknown): Record<string, any> {
  const metadata = (result as { _meta?: Record<string, unknown> })._meta;
  return validateActivityViewPrivateMetadata(metadata?.[ACTIVITY_VIEW_METADATA_KEY]).view;
}

async function currentTaskContract(client: Client): Promise<{
  taskContractVersion: "2";
  executionEnvelopeRef: string;
  project: { name: string; projectRef: string; projectRevision: number };
}> {
  const task = (await client.listTools()).tools.find((tool) => tool.name === "codex_task");
  const properties = task?.inputSchema.properties as Record<string, any> | undefined;
  const taskContractVersion = properties?.taskContractVersion?.const;
  const executionEnvelopeRef = properties?.executionEnvelopeRef?.const;
  if (
    taskContractVersion !== "2" ||
    typeof executionEnvelopeRef !== "string"
  ) {
    throw new Error("The current codex_task descriptor did not expose stable contract v2.");
  }
  const lookup = parseToolJson(await client.callTool({
    name: "codex_task",
    arguments: {
      scopeId: SCOPE_A,
      requestId: randomUUID(),
      taskContractVersion,
      executionEnvelopeRef,
      prompt: "resolve the exact Test Project selector without admitting work",
      projectLookup: { name: "Test Project" }
    }
  }));
  const action = lookup.nextActions?.find(
    (entry: unknown): entry is string => typeof entry === "string" && entry.includes("project={")
  );
  const encoded = action && /project=(\{.*?\}) and a new requestId\./.exec(action)?.[1];
  if (!encoded) throw new Error(`Project lookup omitted an exact selector: ${JSON.stringify(lookup)}`);
  const project = JSON.parse(encoded) as { name: string; projectRef: string; projectRevision: number };
  return {
    taskContractVersion,
    executionEnvelopeRef,
    project
  };
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

function rawMcpRequest(
  baseUrl: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body)
  });
}

async function openStatefulSse(
  baseUrl: string,
  sessionId: string,
  signal: AbortSignal
): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId
      },
      signal
    });
    if (response.status !== 409) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the previous stateful SSE stream to detach.");
}

async function openStatefulReplaySse(
  baseUrl: string,
  sessionId: string,
  lastEventId: string
): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": lastEventId,
        "mcp-session-id": sessionId
      }
    });
    if (response.status !== 409) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the previous replay SSE stream to detach.");
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
    const job = statusItem(status, "job", jobId);
    if (job.state === expected) {
      return job;
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
