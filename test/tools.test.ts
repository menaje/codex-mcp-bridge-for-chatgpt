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
import { DASHBOARD_CARD_URI } from "../src/dashboardCard.js";
import type { CodexProgress, CodexUpstream, ToolResult, UpstreamWorkerAssignment } from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const metadata = { "openai/session": "current-tool-contract-test" };
const fixtureThreadId = "99999999-9999-4999-8999-999999999999";

class FixtureUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private heldCall?: {
    started: () => void;
    result: Promise<ToolResult>;
    release: (result: ToolResult) => void;
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void;
  };

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }] };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const held = this.heldCall;
    if (held) {
      this.heldCall = undefined;
      held.onAssigned = onAssigned;
      held.started();
      return held.result;
    }
    return {
      structuredContent: { threadId: fixtureThreadId, content: "Completed fixture work." },
      content: [{ type: "text", text: "Completed fixture work." }]
    };
  }

  holdNextCall(): { started: Promise<void>; assign(threadId: string): void; release(): void } {
    let started!: () => void;
    let release!: (result: ToolResult) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<ToolResult>((resolve) => { release = resolve; });
    const heldCall = { started, result, release };
    this.heldCall = heldCall;
    return {
      started: startedPromise,
      assign: (threadId) => {
        if (!heldCall.onAssigned) {
          throw new Error("The held upstream call has not registered its assignment callback.");
        }
        heldCall.onAssigned({
          backendKind: "app-server",
          workerId: "fixture-worker",
          workerGeneration: 1,
          threadId
        });
      },
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
      defaultServiceTier: undefined,
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
      completionFollowUp: true,
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

  it("publishes Settings hydration without undefined optional catalog fields", async () => {
    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "settings" }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toStrictEqual(result.structuredContent);
    const settingsView = result.structuredContent as any;
    expect(settingsView.catalog.models[0]).not.toHaveProperty("defaultServiceTier");
    expect(settingsView.settings).toMatchObject({
      dashboardAutoOpenBackground: true,
      completionFollowUp: true
    });
    expect(settingsView.settings).not.toHaveProperty("activityCardVisibility");
    expect(settingsView.settings).not.toHaveProperty("completionHandoff");
    expect(settingsView.capabilities).not.toHaveProperty("availableActivityCardVisibilities");
    expect(settingsView.capabilities).not.toHaveProperty("availableCompletionHandoffs");
  });

  it("publishes Dashboard hydration without undefined thread-handoff fields", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const task = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Create a completed Dashboard handoff fixture.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection,
        executionMode: "background"
      },
      _meta: metadata
    });
    expect(task.isError, JSON.stringify(task)).not.toBe(true);
    const admitted = task.structuredContent as { jobId: string };
    await hold.started;
    hold.assign(fixtureThreadId);
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.threadId === fixtureThreadId
    ));

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: false
      }
    });
    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.status === "completed"
    ));

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toStrictEqual(result.structuredContent);
    const dashboard = result.structuredContent as any;
    const rows = [
      ...dashboard.activeRows,
      ...dashboard.terminalRows,
      ...dashboard.idleRows,
      ...(dashboard.statusRows || [])
    ];
    const row = rows.find((candidate: any) =>
      candidate.codexThreadUrl === `codex://threads/${fixtureThreadId}`
    );
    expect(row).toBeDefined();
    expect(row?.handoff).toMatchObject({
      phase: "connected",
      requested: false,
      canOpen: false
    });
    expect(row?.handoff).not.toHaveProperty("reason");
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
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ contractVersion: "2", state: "completed" });
    expect(result.structuredContent).not.toHaveProperty("waitContext");
    expect(result._meta).not.toHaveProperty("openai/outputTemplate");
    expect(upstream.calls).toHaveLength(1);
  });

  it("does not distinguish scope-mismatched handles from missing handles", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Create handles for the scope-isolation fixture.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "foreground"
      },
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const handles = admitted.structuredContent as {
      jobId: string | null;
      activityId: string | null;
      agentId: string | null;
      threadId: string | null;
      jobVersion: number | null;
    };
    expect(handles).toMatchObject({
      jobId: expect.any(String),
      activityId: expect.any(String),
      agentId: expect.any(String),
      threadId: expect.any(String),
      jobVersion: expect.any(Number)
    });
    const foreignMetadata = { "openai/session": "foreign-tool-contract-test" };
    const errorText = async (name: string, arguments_: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: arguments_, _meta: foreignMetadata });
      expect(result.isError, JSON.stringify(result)).toBe(true);
      const content = result.content || [];
      return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    };
    const expectSameUnavailable = async (
      name: string,
      foreignArguments: Record<string, unknown>,
      missingArguments: Record<string, unknown>
    ) => {
      const [foreign, missing] = await Promise.all([
        errorText(name, foreignArguments),
        errorText(name, missingArguments)
      ]);
      expect(foreign).toContain("HANDLE_UNAVAILABLE");
      expect(foreign).toBe(missing);
      expect(foreign).not.toMatch(/another conversation|does not exist|unknown/i);
    };

    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "job", id: handles.jobId } },
      { query: { kind: "job", id: "missing-job" } }
    );
    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "activity", id: handles.activityId } },
      { query: { kind: "activity", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }
    );
    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "thread", id: handles.threadId } },
      { query: { kind: "thread", id: "missing-thread" } }
    );
    await expectSameUnavailable(
      "codex_agent",
      { agentId: handles.agentId, requestId: randomUUID(), operation: { kind: "rename", name: "Foreign" } },
      {
        agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        requestId: randomUUID(), operation: { kind: "rename", name: "Missing" }
      }
    );
    await expectSameUnavailable(
      "codex_cancel",
      {
        requestId: randomUUID(), target: { kind: "job", id: handles.jobId },
        expectedVersion: handles.jobVersion, reason: "fixture"
      },
      {
        requestId: randomUUID(), target: { kind: "job", id: "missing-job" },
        expectedVersion: handles.jobVersion, reason: "fixture"
      }
    );
    await expectSameUnavailable(
      "codex_activity_update",
      {
        activityId: handles.activityId, expectedVersion: 1,
        operation: { kind: "set-policy", policy: { executionMode: "foreground" } }
      },
      {
        activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedVersion: 1,
        operation: { kind: "set-policy", policy: { executionMode: "foreground" } }
      }
    );
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

  it("keeps a background admission valid before App Server assigns its thread", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "78787878-7878-4787-8787-787878787878",
        requestId,
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Wait for an App Server thread assignment.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "background"
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await hold.started;
    const admitted = result.structuredContent as { jobId: string; state: string; threadId: string | null };
    expect(admitted).toMatchObject({
      jobId: expect.any(String),
      state: "running",
      threadId: null
    });
    const pendingJob = state.listJobs().find((job) => job.jobId === admitted.jobId);
    expect(pendingJob?.threadId ?? null).toBeNull();

    hold.assign("assigned-after-admission-thread");
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.threadId === "assigned-after-admission-thread"
    ));
    const status = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: admitted.jobId } },
      _meta: metadata
    });
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      kind: "job",
      items: [{
        threadId: "assigned-after-admission-thread",
        state: "running"
      }]
    });

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.status === "completed"
    ));
  });

  it("automatically opens the originating conversation Dashboard only for background work", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "88888888-8888-4888-8888-888888888888",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "background"
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const hydration = result._meta as Record<string, any>;
    expect(hydration["openai/outputTemplate"])
      .toBe(DASHBOARD_CARD_URI);
    expect(hydration["codex/dashboardOpen@1"]).toMatchObject({
      scope: "conversation",
      automatic: true,
      completionDeliveryRoute: "dashboard",
      presentationToken: expect.any(String)
    });
    expect(hydration["openai/outputTemplate"]).not.toMatch(/activity|question/);

    const origin = state.listJobs().find((job) =>
      job.jobId === (result.structuredContent as { jobId?: string }).jobId
    );
    expect(origin).toBeDefined();
    const completionActivityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    state.createActivity({
      activityId: completionActivityId,
      scopeId: origin!.scopeId,
      handoffPolicy: "notify",
      completionTrigger: "sealed-jobs-terminal"
    });
    state.upsertJob({
      jobId: "dashboard-completion-job",
      requestId: "dashboard-completion-request",
      scopeId: origin!.scopeId,
      activityId: completionActivityId,
      status: "completed",
      updatedAt: Date.now()
    });
    state.sealActivity(completionActivityId);
    const [outbox] = state.listPendingCompletionOutbox(origin!.scopeId);
    expect(outbox).toMatchObject({ activityId: completionActivityId });

    const widgetInstanceId = randomUUID();
    const dashboard = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId,
        scope: "conversation",
        presentationToken: hydration["codex/dashboardOpen@1"].presentationToken
      },
      _meta: metadata
    });
    expect(dashboard.isError, JSON.stringify(dashboard)).not.toBe(true);
    const completion = (dashboard.structuredContent as any).completionDelivery;
    expect(completion).toMatchObject({ route: "dashboard", events: [{ outboxId: outbox!.outboxId }] });

    const claimed = await client.callTool({
      name: "codex_ui_problem",
      arguments: {
        action: "completion-claim",
        outboxIds: [outbox!.outboxId],
        presentationToken: hydration["codex/dashboardOpen@1"].presentationToken,
        widgetInstanceId
      },
      _meta: metadata
    });
    expect(claimed.isError, JSON.stringify(claimed)).not.toBe(true);
    expect(claimed.structuredContent).toMatchObject({
      kind: "completion-delivery",
      state: "claimed",
      events: [{ outboxId: outbox!.outboxId }]
    });
    const uncertain = await client.callTool({
      name: "codex_ui_problem",
      arguments: {
        action: "completion-uncertain",
        outboxIds: [outbox!.outboxId],
        presentationToken: hydration["codex/dashboardOpen@1"].presentationToken,
        widgetInstanceId
      },
      _meta: metadata
    });
    expect(uncertain.isError, JSON.stringify(uncertain)).not.toBe(true);
    expect(uncertain.structuredContent).toMatchObject({ state: "uncertain" });
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const settingsUpdate = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: { kind: "patch", settings: { dashboardAutoOpenBackground: false } }
      },
      _meta: metadata
    });
    expect(settingsUpdate.isError, JSON.stringify(settingsUpdate)).not.toBe(true);

    const suppressed = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "99999999-9999-4999-8999-999999999999",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete hidden background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection,
        executionMode: "background"
      },
      _meta: metadata
    });
    expect(suppressed.isError, JSON.stringify(suppressed)).not.toBe(true);
    expect(suppressed._meta).not.toHaveProperty("openai/outputTemplate");
    expect(suppressed._meta).not.toHaveProperty("codex/dashboardOpen@1");
    expect((suppressed.structuredContent as any).warnings).toContain(
      "Completion follow-up is queued because no verified host event or automatic Dashboard presentation is available."
    );
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
