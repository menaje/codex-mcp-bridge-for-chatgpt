import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const metadata = { "openai/session": "current-tool-contract-test" };

class FixtureUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private heldCall?: {
    started: () => void;
    result: Promise<ToolResult>;
    release: (result: ToolResult) => void;
  };

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const held = this.heldCall;
    if (held) {
      this.heldCall = undefined;
      held.started();
      return held.result;
    }
    return {
      structuredContent: { threadId: "tool-contract-thread", content: "Completed fixture work." },
      content: [{ type: "text", text: "Completed fixture work." }]
    };
  }

  holdNextCall(): { started: Promise<void>; release(): void } {
    let started!: () => void;
    let release!: (result: ToolResult) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<ToolResult>((resolve) => { release = resolve; });
    this.heldCall = { started, result, release };
    return {
      started: startedPromise,
      release: () => release({
        structuredContent: { threadId: "tool-contract-thread", content: "Completed delayed fixture work." },
        content: [{ type: "text", text: "Completed delayed fixture work." }]
      })
    };
  }

  async close(): Promise<void> {}
}

class FixtureCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-14T00:00:00.000Z",
    validatedAt: "2026-09-14T00:00:00.000Z",
    fingerprint: "f".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: selection.model,
      displayName: "Fixture Sol",
      defaultReasoningEffort: selection.reasoningEffort,
      supportedReasoningEfforts: [{ effort: selection.reasoningEffort }],
      isDefault: true,
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

describe("current bridge tool contracts", () => {
  let root: string;
  let state: BridgeStateStore;
  let settings: UserSettingsStore;
  let client: Client;
  let server: BridgeHttpServer;
  let upstream: FixtureUpstream;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "current-tools-"));
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    });
    settings = new UserSettingsStore(config, { stateStore: state });
    settings.update({
      modelPolicy: {
        mode: "automatic",
        constraints: { allowDelegation: false },
        allowedSelections: { kind: "explicit", selections: [selection] }
      }
    }, settings.current.revision);
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Fixture", cwd: root } }],
      undefined,
      settings.current.registryRevision
    );
    upstream = new FixtureUpstream();
    server = createHttpServer(
      config,
      upstream,
      new FixtureCatalog(),
      { stateStore: state }
    );
    client = new Client(
      { name: "current-tool-contract-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes one current tool surface without compatibility tiers", async () => {
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const current of ["codex_task", "codex_models", "codex_settings", "codex_dashboard", "codex_ui_read"]) {
      expect(names.has(current)).toBe(true);
    }
    for (const retired of [
      "codex_dashboard_snapshot",
      "codex_settings_snapshot",
      "codex_question_card",
      "codex_question_submit",
      "codex_question_notify"
    ]) expect(names.has(retired)).toBe(false);
    expect(tools.tools.some((tool) => "codex/registrationTier" in (tool._meta || {}))).toBe(false);
  });

  it("publishes draft-2020-12-compatible v3 task input without retired fields", async () => {
    const tools = await client.listTools();
    const task = tools.tools.find((tool) => tool.name === "codex_task")!;
    const properties = task.inputSchema.properties as Record<string, { const?: string }>;
    expect(properties.taskContractVersion?.const).toBe("3");
    expect(properties.executionEnvelopeRef?.const).toMatch(/^[a-f0-9]{64}$/);
    expect(properties).toHaveProperty("project");
    for (const retired of ["projectLookup", "sandbox", "executionPolicyRef", "presentationId", "waitToken"]) {
      expect(properties).not.toHaveProperty(retired);
    }
    const status = tools.tools.find((tool) => tool.name === "codex_status")!;
    expect(status.inputSchema.properties).not.toHaveProperty("includeAllScopes");
  });

  it("admits a current v3 task and returns the current terminal result contract", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "foreground"
      },
      _meta: metadata
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ contractVersion: "2", state: "completed" });
    expect(result.structuredContent).not.toHaveProperty("waitContext");
    expect(upstream.calls).toHaveLength(1);
  });

  it("does not disclose copied handle existence outside the current conversation scope", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const sourceScopeInput = "77777777-7777-4777-8777-777777777777";
    const source = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: sourceScopeInput,
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Create scoped handles for access isolation.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "foreground"
      },
      _meta: { "openai/session": "handle-isolation-source" }
    });
    expect(source.isError).not.toBe(true);
    const handles = source.structuredContent as {
      jobId: string;
      jobVersion: number;
      activityId: string;
      activityVersion: number;
      agentId: string;
      threadId: string;
    };
    for (const key of ["jobId", "jobVersion", "activityId", "activityVersion", "agentId", "threadId"] as const) {
      expect(handles[key]).toBeTruthy();
    }

    const foreignMeta = { "openai/session": "handle-isolation-foreign" };
    const unavailable = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args, _meta: foreignMeta });
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === "text")?.text;
      expect(text).toMatch(/^HANDLE_UNAVAILABLE:/);
      expect(text).not.toMatch(/another conversation|unknown .*id/i);
      return text;
    };

    const foreignJob = await unavailable("codex_status", {
      scopeId: sourceScopeInput,
      query: { kind: "job", id: handles.jobId }
    });
    const missingJob = await unavailable("codex_status", {
      scopeId: sourceScopeInput,
      query: { kind: "job", id: "job-not-retained" }
    });
    expect(foreignJob).toBe(missingJob);

    await unavailable("codex_status", {
      scopeId: sourceScopeInput,
      query: { kind: "thread", id: handles.threadId }
    });
    await unavailable("codex_task", {
      scopeId: sourceScopeInput,
      requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Attempt to reuse an inaccessible Activity.",
      activity: { mode: "existing", id: handles.activityId },
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection,
      executionMode: "foreground"
    });
    await unavailable("codex_task", {
      scopeId: sourceScopeInput,
      requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Attempt to reuse an inaccessible Agent.",
      agent: { mode: "existing", id: handles.agentId },
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection,
      executionMode: "foreground"
    });
    await unavailable("codex_activity_update", {
      scopeId: sourceScopeInput,
      activityId: handles.activityId,
      expectedVersion: handles.activityVersion,
      operation: { kind: "seal" }
    });
    await unavailable("codex_cancel", {
      requestId: randomUUID(),
      target: { kind: "job", id: handles.jobId },
      expectedVersion: handles.jobVersion,
      reason: "foreign scope access test"
    });
  });

  it("records a detached HTTP task call without turning it into cancellation", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const controller = new AbortController();
    const requestId = randomUUID();
    const pending = client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId,
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Keep this task alive while the HTTP response is detached.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "foreground"
      },
      _meta: metadata
    }, { signal: controller.signal });
    const outcome = pending.then(
      () => "completed" as const,
      () => "detached" as const
    );
    await hold.started;
    controller.abort();

    await eventually(() => state.listTransportObservations("mcp-handler-aborted").length === 1);
    const admitted = state.listJobs().find((item) =>
      (item as { requestId?: unknown }).requestId === requestId
    ) as { status?: unknown; cancelRequestedAt?: unknown } | undefined;
    expect(admitted).toMatchObject({ status: "running" });
    expect(admitted?.cancelRequestedAt).toBeFalsy();

    hold.release();
    expect(await outcome).toBe("detached");
    await eventually(() => state.listJobs().some((item) =>
      (item as { requestId?: unknown; status?: unknown }).requestId === requestId &&
      (item as { status?: unknown }).status === "completed"
    ));
  });
});

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for asynchronous bridge state.");
}
