import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { CodexService } from "../src/codexService.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { createExecutionRuntime } from "../src/executionRuntime.js";
import { ChildProcessCodexExecutionService } from "../src/executionServiceProcess.js";
import type { ExecutionPeer } from "../src/executionTransport.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BRIDGE_SKILL_LIMITS } from "../src/skillLibrary.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { DASHBOARD_CARD_URI } from "../src/dashboardCard.js";
import type {
  CodexInteractionResponse,
  CodexPendingInteraction,
  CodexProgress,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";
import { tombstoneProjectForTest } from "./helpers/sqliteSettings.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const metadata = { "openai/session": "current-tool-contract-test" };
const fixtureThreadId = "99999999-9999-4999-8999-999999999999";
const fixtureTurnId = "fixture-turn";

type HeldFixtureCall = {
  started: () => void;
  result: Promise<ToolResult>;
  release: (result: ToolResult) => void;
  onProgress?: (progress: CodexProgress) => void;
  onAssigned?: (assignment: UpstreamWorkerAssignment) => void;
};

class FixtureUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly interactionResponses: Array<{ interactionId: string; response: CodexInteractionResponse }> = [];
  private heldCall?: HeldFixtureCall;
  private nextThreadId?: string;

  setNextThreadId(threadId: string): void {
    this.nextThreadId = threadId;
  }

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }] };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const held = this.heldCall;
    if (held) {
      this.heldCall = undefined;
      held.onProgress = onProgress;
      held.onAssigned = onAssigned;
      held.started();
      return held.result;
    }
    const threadId = this.nextThreadId || fixtureThreadId;
    this.nextThreadId = undefined;
    return {
      structuredContent: { threadId, content: "Completed fixture work." },
      content: [{ type: "text", text: "Completed fixture work." }]
    };
  }

  holdNextCall(): {
    started: Promise<void>;
    assign(threadId: string, upstreamRequestId?: string): void;
    progress(progress: CodexProgress): void;
    release(result?: ToolResult): void;
  } {
    let started!: () => void;
    let release!: (result: ToolResult) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<ToolResult>((resolve) => { release = resolve; });
    const heldCall: HeldFixtureCall = { started, result, release };
    this.heldCall = heldCall;
    return {
      started: startedPromise,
      assign: (threadId, upstreamRequestId = fixtureTurnId) => {
        if (!heldCall.onAssigned) {
          throw new Error("The held upstream call has not registered its assignment callback.");
        }
        heldCall.onAssigned({
          backendKind: "app-server",
          workerId: "fixture-worker",
          workerGeneration: 1,
          threadId,
          upstreamRequestId
        });
      },
      progress: (progress) => {
        if (!heldCall.onProgress) {
          throw new Error("The held upstream call has not registered its progress callback.");
        }
        heldCall.onProgress(progress);
      },
      release: (result) => release(result || {
        structuredContent: { threadId: "tool-contract-thread", content: "Completed delayed fixture work." },
        content: [{ type: "text", text: "Completed delayed fixture work." }]
      })
    };
  }

  async respondToInteraction(interactionId: string, response: CodexInteractionResponse): Promise<void> {
    this.interactionResponses.push({ interactionId, response });
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
  let config: ReturnType<typeof loadConfig>;
  let client: Client;
  let server: BridgeHttpServer;
  let upstream: FixtureUpstream;
  let endpoint: URL;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "current-tools-"));
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    config = loadConfig({
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
    endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  it("exposes legacy project recovery in Settings and restores the original identity through the application service", async () => {
    const project = settings.current.projects[0]!;
    const activity = state.createActivity({ scopeId: "11111111-1111-4111-8111-111111111111",
      projectId: project.id, projectName: project.name, projectCwd: project.cwd });
    tombstoneProjectForTest(path.join(root, "state.sqlite"), project.id);
    const view = await server.applicationService.settingsSnapshot();
    expect(view.settings.projects).toEqual([]);
    expect(view.capabilities.recoverableProjects).toEqual([expect.objectContaining({
      id: project.id, projectRef: project.projectRef
    })]);
    const updated = await server.applicationService.updateSettings({
      expectedRegistryRevision: view.settings.registryRevision,
      operation: { kind: "patch", settings: { projectOperations: [{ kind: "restore", projectId: project.id }] } }
    });
    expect(updated.settings.projects[0]).toMatchObject({ id: project.id, projectRef: project.projectRef });
    expect(updated.capabilities.recoverableProjects).toEqual([]);
    expect(state.getActivityProjectAdmission(activity.activityId)?.projectId).toBe(project.id);
    expect(updated.settings.settingsRevision).toBe(view.settings.settingsRevision);
  });

  it("revalidates the runtime credential boundary when restoring a deleted project without an explicit cwd", async () => {
    const project = settings.current.projects[0]!;
    tombstoneProjectForTest(path.join(root, "state.sqlite"), project.id);
    const priorEnv = process.env.CODEX_MCP_BRIDGE_ENV_FILE;
    process.env.CODEX_MCP_BRIDGE_ENV_FILE = path.join(root, "runtime.env");
    try {
      await expect(server.applicationService.updateSettings({
        expectedRegistryRevision: settings.current.registryRevision,
        operation: { kind: "patch", settings: { projectOperations: [{ kind: "restore", projectId: project.id }] } }
      })).rejects.toThrow("RUNTIME_ENV_PROJECT_CONFLICT");
      expect(settings.current.projects).toEqual([]);
    } finally {
      if (priorEnv === undefined) delete process.env.CODEX_MCP_BRIDGE_ENV_FILE;
      else process.env.CODEX_MCP_BRIDGE_ENV_FILE = priorEnv;
    }
  });

  it("publishes one current tool surface without compatibility tiers", async () => {
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const current of ["codex_task", "codex_cancel", "codex_models", "codex_settings", "codex_dashboard", "codex_ui_read", "bridge_skill", "bridge_skill_manage"]) {
      expect(names.has(current)).toBe(true);
    }
    for (const retired of [
      "codex_skill",
      "codex_skill_manage",
      "codex_dashboard_snapshot",
      "codex_settings_snapshot",
      "codex_question_card",
      "codex_question_submit",
      "codex_question_notify",
      "codex_ui_stop",
      "codex_decision",
      "codex_decision_result",
      "codex_ui_decision"
    ]) expect(names.has(retired)).toBe(false);
    const bridgeSkill = tools.tools.find((tool) => tool.name === "bridge_skill")!;
    const bridgeSkillManage = tools.tools.find((tool) => tool.name === "bridge_skill_manage")!;
    const status = tools.tools.find((tool) => tool.name === "codex_status")!;
    expect(JSON.stringify(bridgeSkill.inputSchema)).not.toContain('"project"');
    expect(JSON.stringify(bridgeSkillManage.inputSchema)).toContain('"content"');
    expect(JSON.stringify(bridgeSkillManage.inputSchema)).not.toContain('"document"');
    expect(JSON.stringify(status.inputSchema)).toContain("defaults to 20000 milliseconds");
    expect(status.description).toContain("terminal wait wakes only for terminal lifecycle state");
    expect(status.description).toContain("do not keep a parallel terminal wait");
    expect(tools.tools.some((tool) => "codex/registrationTier" in (tool._meta || {}))).toBe(false);
  });

  it("verifies the execution owner before looking up a saved Agent or admitting a Job", async () => {
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    config.codexService = new CodexService({ HOME: root,
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") });
    const verify = vi.spyOn(config.codexService, "assertCurrentAdmission").mockRejectedValue(
      new Error("CODEX_AUTH_POLICY_UNAVAILABLE: synthetic managed policy changed"));
    const requestId = randomUUID();
    const blocked = await client.callTool({ name: "codex_task", arguments: {
      scopeId: "aaaa1111-aaaa-4111-8111-aaaaaaaaaaaa",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Continue an owned session only after checking the active policy.",
      agent: { mode: "existing", id: randomUUID(), context: "continue" }
    }, _meta: metadata });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain("CODEX_AUTH_POLICY_UNAVAILABLE");
    expect(blocked.structuredContent).toMatchObject({ error: { retryable: true } });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(state.listJobs().filter(job => job.requestId === requestId)).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "keeps an original Job's %s result and session with its owner through an external login change and commit retry",
    async (terminalStatus) => {
      const home = path.join(root, ".codex");
      const authFile = path.join(home, "auth.json");
      await mkdir(home);
      const login = (userId: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: {
        account_id: "shared-workspace", id_token: syntheticIdToken(userId, "shared-workspace")
      } });
      await writeFile(authFile, login("user-a"));
      const service = new CodexService({ HOME: root, CODEX_HOME: home, PATH: "",
        CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") });
      config.codexService = service;
      await service.assertCurrentAdmission();

      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      upstream = new FixtureUpstream();
      const acknowledgeExecution = vi.fn();
      Object.assign(upstream, {
        supportsExecutionRecovery: () => true,
        ownsRetainedResult: (_jobId: string, assignment: UpstreamWorkerAssignment) =>
          assignment.threadId === "tool-contract-thread" && assignment.upstreamRequestId === fixtureTurnId,
        acknowledgeExecution
      });
      server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
      client = new Client(
        { name: "original-job-completion-owner-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(endpoint));

      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
      const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
      const project = settings.current.projects[0]!;
      const hold = upstream.holdNextCall();
      const admitted = await client.callTool({ name: "codex_task", arguments: {
        scopeId: randomUUID(), requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Return a synthetic result from the original Job.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      }, _meta: metadata });
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      const jobId = (admitted.structuredContent as { jobId: string }).jobId;
      await hold.started;
      hold.assign("tool-contract-thread");
      const originalOwner = state.listJobs().find((job) => job.jobId === jobId)?.authBoundary;
      expect(originalOwner).toMatch(/^[a-f0-9]{64}$/);
      expect((state.listSessions() as Array<{ threadId: string; authBoundary: string }>))
        .toContainEqual(expect.objectContaining({ threadId: "tool-contract-thread", authBoundary: originalOwner }));

      await writeFile(authFile, login("user-b"));
      expect(service.sessionAuthBoundary().key).not.toBe(originalOwner);
      await expect(service.assertCurrentAdmission()).rejects.toThrow("CODEX_AUTH_CHANGED");
      expect(service.currentExecutionAuthBoundary()).toBeNull();

      const persistJob = state.upsertJob.bind(state);
      let failedOnce = false;
      vi.spyOn(state, "upsertJob").mockImplementation((job) => {
        if (!failedOnce && job.status === terminalStatus) {
          failedOnce = true;
          throw new Error("synthetic terminal commit outage");
        }
        persistJob(job);
      });
      hold.release({
        structuredContent: { threadId: "tool-contract-thread",
          turnStatus: terminalStatus === "interrupted" ? "interrupted" : "completed" },
        content: [{ type: "text", text: "Synthetic original Job result." }],
        ...(terminalStatus === "failed" ? { isError: true } : {})
      });
      await eventually(() => state.listJobs().some((job) =>
        job.jobId === jobId && job.status === terminalStatus
      ), 5_000);
      expect(failedOnce).toBe(true);
      expect(upstream.calls).toHaveLength(1);
      expect(state.listJobs().find((job) => job.jobId === jobId)?.authBoundary).toBe(originalOwner);
      expect((state.listSessions() as Array<{ threadId: string; authBoundary: string }>))
        .toContainEqual(expect.objectContaining({ threadId: "tool-contract-thread", authBoundary: originalOwner }));
      expect((state.listSessions() as Array<{ threadId: string; authBoundary: string }>))
        .not.toContainEqual(expect.objectContaining({ threadId: "tool-contract-thread",
          authBoundary: service.sessionAuthBoundary().key }));
      expect(acknowledgeExecution).toHaveBeenCalledExactlyOnceWith(jobId);
    }
  );

  it.each(["queued request", "completed response"] as const)(
    "preserves the original Job through a lost %s, external auth change and transport ACK retries", async phase => {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
      vi.spyOn(CodexRuntimeManager.prototype, "acquire").mockResolvedValue({
        selection: { id: "fixture", source: "terminal", command, physicalPath: command, version: "0.153.3" },
        release: async () => {}
      });
      const home = path.join(root, "transport-home");
      const turns = path.join(root, "transport-turns.jsonl");
      await mkdir(home);
      const login = (user: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: {
        account_id: "transport-workspace", id_token: syntheticIdToken(user, "transport-workspace")
      } });
      const authFile = path.join(home, "auth.json");
      await writeFile(authFile, login("user-a"));
      const environment = { PATH: process.env.PATH || "", HOME: root, CODEX_HOME: home,
        CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
        CODEX_TEST_ACCOUNT_ID: "transport-workspace", CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1",
        CODEX_TEST_TURN_OBSERVATION: turns };
      config.upstreamPoolSize = 1;
      const runtime = createExecutionRuntime(config, {}, environment, { isolateCodexExecution: true });
      await runtime.prepareExecution({ backendKind: "app-server", contextMode: "fresh" });
      const execution = (runtime as unknown as {
        backends: Map<string, { instance: ChildProcessCodexExecutionService }>
      }).backends.get("app-server")!.instance;
      const peer = (execution as unknown as { child: ExecutionPeer }).child;
      const generation = execution.health().generation;
      const executorPid = execution.processId;
      const requests: Array<{ requestId: string; generation: string; args: unknown[] }> = [];
      const acks: Array<{ requestId: string; generation: string }> = [];
      const acknowledgedOwners: Array<{ status: string; authBoundary?: string }> = [];
      let queued = false, dropQueued = phase === "queued request", jobId = "";
      let droppedResult = false, droppedAck = false, droppedReply = false, reconnectedAck = false;
      const send = peer.send.bind(peer);
      peer.send = (message: any, callback) => {
        if (message.type === "request" && message.retained) {
          requests.push(structuredClone(message));
          if (dropQueued) { queued = true; callback?.(); return true; }
        }
        if (message.type === "acknowledge" && message.requestId === jobId) {
          acks.push(structuredClone(message));
          const persisted = state.listJobs().find(job => job.jobId === jobId)!;
          acknowledgedOwners.push({ status: persisted.status, authBoundary: persisted.authBoundary });
          if (!droppedAck) { droppedAck = true; callback?.(); return true; }
        }
        return send(message, callback);
      };
      const receiver = execution as unknown as { onMessage(message: any): void };
      const receive = receiver.onMessage.bind(execution);
      receiver.onMessage = message => {
        if (message.type === "response" && message.requestId === jobId && !droppedResult) {
          droppedResult = true; peer.disconnect(); return;
        }
        if (message.type === "acknowledged" && message.requestId === jobId) {
          if (!droppedReply) { droppedReply = true; return; }
          if (!reconnectedAck) { reconnectedAck = true; peer.disconnect(); return; }
        }
        receive(message);
      };
      server = createHttpServer(config, runtime, new FixtureCatalog(), { stateStore: state });
      client = new Client({ name: "auth-transport-owner-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      try {
        const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
        const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
        const project = settings.current.projects[0]!;
        const arguments_ = { scopeId: randomUUID(), requestId: randomUUID(),
          taskContractVersion: properties.taskContractVersion?.const,
          executionEnvelopeRef: properties.executionEnvelopeRef?.const,
          prompt: phase === "queued request" ? "original queued transport work" : "hold original transport work",
          project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
          selection };
        const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
        expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
        jobId = (admitted.structuredContent as { jobId: string }).jobId;
        await eventually(() => phase === "queued request" ? queued : Boolean(
          state.listJobs().find(job => job.jobId === jobId)?.upstreamRequestId));
        const original = state.listJobs().find(job => job.jobId === jobId)!;
        expect(original.authBoundary).toMatch(/^[a-f0-9]{64}$/);
        await writeFile(authFile, login("user-b"));
        const foreign = await client.callTool({ name: "codex_task", _meta: metadata,
          arguments: { ...arguments_, requestId: randomUUID(), prompt: "new owner must not execute" } });
        expect(foreign.isError).toBe(true);
        expect(JSON.stringify(foreign)).toContain("CODEX_AUTH_CHANGED");
        expect(config.codexService!.currentExecutionAuthBoundary()).toBeNull();
        expect(state.listJobs()).toHaveLength(1);
        if (phase === "queued request") { dropQueued = false; peer.disconnect(); }
        else await runtime.steerThread(original.threadId!, "finish the original transport Job");
        await eventually(() => state.listJobs().some(job => job.jobId === jobId && job.status === "completed"), 10_000);
        await eventually(() => droppedAck && droppedReply && reconnectedAck &&
          execution.health().pendingAcknowledgements === 0, 10_000);
        const completed = state.listJobs().find(job => job.jobId === jobId)!;
        expect(completed.authBoundary).toBe(original.authBoundary);
        if (phase === "completed response") expect(completed).toMatchObject({
          workerId: original.workerId, workerGeneration: original.workerGeneration,
          upstreamRequestId: original.upstreamRequestId, threadId: original.threadId
        });
        expect(completed.result).toBeDefined();
        expect(state.listSessions()).toContainEqual(expect.objectContaining({
          threadId: completed.threadId, authBoundary: original.authBoundary
        }));
        expect(droppedResult).toBe(true);
        expect(requests.length).toBeGreaterThan(1);
        expect(requests.every(request => request.requestId === jobId && request.generation === generation &&
          JSON.stringify(request.args) === JSON.stringify(requests[0]!.args))).toBe(true);
        expect(acks.length).toBeGreaterThanOrEqual(4);
        expect(acks.every(ack => ack.requestId === jobId && ack.generation === generation)).toBe(true);
        expect(acknowledgedOwners.every(owner => owner.status === "completed" &&
          owner.authBoundary === original.authBoundary)).toBe(true);
        expect(execution.processId).toBe(executorPid);
        expect(execution.health().generation).toBe(generation);
        const observed = (await readFile(turns, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ threadId: completed.threadId, turnId: completed.upstreamRequestId });
        const status = await client.callTool({ name: "codex_status", _meta: metadata,
          arguments: { query: { kind: "job", id: jobId } } });
        expect(status.isError, JSON.stringify(status)).not.toBe(true);
        expect(status.structuredContent).toMatchObject({ items: [expect.objectContaining({ id: jobId, state: "completed" })] });
        expect((await readFile(turns, "utf8")).trim().split("\n")).toHaveLength(1);
      } finally {
        dropQueued = false;
        peer.send = send;
        receiver.onMessage = receive;
        await runtime.close();
        vi.restoreAllMocks();
      }
    }, 25_000
  );

  it.each(["host-accepted", "acceptance-unknown"] as const)(
    "retains an original %s completion receipt through a new login and lost result response", async deliveryState => {
      const stateFile = path.join(root, "state.sqlite");
      const homeA = path.join(root, "profile-a");
      const homeB = path.join(root, "profile-b");
      const project = settings.current.projects[0]!;
      for (const [home, user] of [[homeA, "user-a"], [homeB, "user-b"]]) {
        await mkdir(home!);
        await writeFile(path.join(home!, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {
          account_id: "shared-workspace", id_token: syntheticIdToken(user!, "shared-workspace")
        } }));
      }
      const reopen = async (home: string, nextUpstream: FixtureUpstream) => {
        await client.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        state.close();
        config.codexService = new CodexService({ HOME: root, CODEX_HOME: home, PATH: "",
          CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") });
        await config.codexService.assertCurrentAdmission();
        state = new BridgeStateStore({ file: stateFile });
        upstream = nextUpstream;
        server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
        client = new Client({ name: "retained-completion-owner-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
        await client.connect(new StreamableHTTPClientTransport(endpoint));
      };
      await reopen(homeA, new FixtureUpstream());
      const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
      const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
      const arguments_ = {
        scopeId: randomUUID(), requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Retain this original result across a separate login.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      };
      const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      const jobId = (admitted.structuredContent as { jobId: string }).jobId;
      await eventually(() => state.listJobs().some(job => job.jobId === jobId && job.status === "completed"));
      const original = state.listJobs().find(job => job.jobId === jobId)!;
      const scopeId = original.scopeId!;
      expect(original.authBoundary).toMatch(/^[a-f0-9]{64}$/);
      const leaseOwner = randomUUID();
      const leased = state.claimJobCompletionDelivery(jobId, scopeId, leaseOwner)!;
      const lease = { jobId, scopeId, leaseOwner, receipt: leased.receipt };
      if (deliveryState === "host-accepted") state.markJobCompletionHostAccepted(lease);
      else state.markJobCompletionAcceptanceUnknown(lease);
      const originalDelivery = state.getJobCompletionDelivery(jobId, scopeId)!;
      expect(state.retentionProtection(jobId)).toContain("undelivered-chatgpt-result");

      const recoverExecution = vi.fn();
      const acknowledgeExecution = vi.fn();
      const nextUpstream = new FixtureUpstream();
      Object.assign(nextUpstream, { supportsExecutionRecovery: () => true, recoverExecution, acknowledgeExecution });
      await reopen(homeB, nextUpstream);
      expect(config.codexService!.currentExecutionAuthBoundary()).not.toBe(original.authBoundary);
      expect(state.getJobCompletionDelivery(jobId, scopeId)).toEqual(originalDelivery);
      expect(state.listJobs()).toContainEqual(expect.objectContaining({
        jobId, status: "completed", authBoundary: original.authBoundary, result: original.result
      }));

      let loseResultResponse = true;
      const lossyFetch: typeof globalThis.fetch = async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (loseResultResponse && typeof init?.body === "string" && init.body.includes(leased.receipt)) {
          loseResultResponse = false;
          await response.body?.cancel();
          throw new TypeError("synthetic lost completion response");
        }
        return response;
      };
      const lossyClient = new Client({ name: "retained-completion-response-loss", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));
      try {
        await expect(lossyClient.callTool({ name: "codex_status", _meta: metadata,
          arguments: { scopeId, query: { kind: "completion", receipt: leased.receipt } } }))
          .rejects.toThrow("synthetic lost completion response");
      } finally { await lossyClient.close(); }
      const offered = state.getJobCompletionDelivery(jobId, scopeId)!;
      expect(offered).toMatchObject({ state: deliveryState, receipt: leased.receipt,
        attemptCount: 1, completionResultOfferedAt: expect.any(Number) });
      expect(offered.resultReadAt).toBeUndefined();

      const recovered = await client.callTool({ name: "codex_status", _meta: metadata,
        arguments: { scopeId, query: { kind: "completion", receipt: leased.receipt } } });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({ kind: "job", items: [expect.objectContaining({
        id: jobId, state: "completed", answer: expect.stringContaining("Completed fixture work.")
      })] });
      expect(state.getJobCompletionDelivery(jobId, scopeId)?.completionResultOfferedAt)
        .toBe(offered.completionResultOfferedAt);
      const foreign = await client.callTool({ name: "codex_status",
        _meta: { "openai/session": "foreign-retained-result" },
        arguments: { query: { kind: "completion", receipt: leased.receipt } } });
      expect(foreign.isError).toBe(true);
      const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(replay.isError).toBe(true);
      expect(JSON.stringify(replay)).toContain("CODEX_AUTH_JOB_BOUNDARY");
      expect(state.listJobs()).toHaveLength(1);
      expect(nextUpstream.calls).toHaveLength(0);
      expect(recoverExecution).not.toHaveBeenCalled();
      expect(acknowledgeExecution).not.toHaveBeenCalled();
    }
  );

  it("recovers an original Job through HTTP only after a restarted bridge confirms its owner", async () => {
    const home = path.join(root, ".codex");
    const authFile = path.join(home, "auth.json");
    const stateFile = path.join(root, "state.sqlite");
    const environment = { HOME: root, CODEX_HOME: home, PATH: "",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") };
    const login = (userId: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: {
      account_id: "shared-workspace", id_token: syntheticIdToken(userId, "shared-workspace")
    } });
    await mkdir(home);
    await writeFile(authFile, login("user-a"));
    config.codexService = new CodexService(environment);
    await config.codexService.assertCurrentAdmission();

    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    upstream = new FixtureUpstream();
    Object.assign(upstream, { supportsExecutionRecovery: () => true });
    server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
    client = new Client({ name: "original-job-before-restart", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({ name: "codex_task", arguments: {
      scopeId: randomUUID(), requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Keep the original Job running across a bridge restart.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    }, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;
    hold.assign("original-restart-thread");
    const original = state.listJobs().find(job => job.jobId === jobId)!;
    const assignment: UpstreamWorkerAssignment = {
      backendKind: "app-server", workerId: "fixture-worker", workerGeneration: 1,
      upstreamRequestId: fixtureTurnId, threadId: "original-restart-thread"
    };
    expect(original.authBoundary).toMatch(/^[a-f0-9]{64}$/);
    expect(original).toMatchObject({ status: "running", threadId: assignment.threadId,
      workerId: assignment.workerId, workerGeneration: assignment.workerGeneration });

    const reopen = async (userId: string, nextUpstream: FixtureUpstream) => {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      state.close();
      await writeFile(authFile, login(userId));
      config.codexService = new CodexService(environment);
      const startupAdmission = vi.spyOn(config.codexService, "assertCurrentAdmission");
      state = new BridgeStateStore({ file: stateFile });
      upstream = nextUpstream;
      server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
      client = new Client({ name: `original-job-after-restart-${userId}`, version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      return startupAdmission;
    };

    const wrongOwnerRecovery = vi.fn();
    const wrongOwner = new FixtureUpstream();
    Object.assign(wrongOwner, { supportsExecutionRecovery: () => true,
      recoverExecution: wrongOwnerRecovery });
    const foreignAdmission = await reopen("user-b", wrongOwner);
    await eventually(() => foreignAdmission.mock.calls.length === 1);
    await foreignAdmission.mock.results[0]!.value;
    await Promise.resolve();
    expect(config.codexService!.currentExecutionAuthBoundary()).not.toBe(original.authBoundary);
    expect(wrongOwnerRecovery).not.toHaveBeenCalled();
    expect(state.listJobs()).toContainEqual(expect.objectContaining({
      jobId, status: "running", authBoundary: original.authBoundary
    }));
    const foreignStatus = await client.callTool({ name: "codex_status", _meta: metadata,
      arguments: { query: { kind: "job", id: jobId } } });
    expect(foreignStatus.isError, JSON.stringify(foreignStatus)).not.toBe(true);
    expect(foreignStatus.structuredContent).toMatchObject({ items: [expect.objectContaining({
      id: jobId, state: "running"
    })] });

    const recoverExecution = vi.fn((_jobId: string, _onProgress: (progress: CodexProgress) => void,
      onAssigned: (value: UpstreamWorkerAssignment) => void) => {
      onAssigned(assignment);
      return Promise.resolve({ structuredContent: { threadId: assignment.threadId, turnStatus: "completed" },
        content: [{ type: "text" as const, text: "Original retained result after restart." }] });
    });
    const acknowledgeExecution = vi.fn();
    const sameOwner = new FixtureUpstream();
    Object.assign(sameOwner, { supportsExecutionRecovery: () => true, recoverExecution,
      ownsRetainedResult: (_jobId: string, value: UpstreamWorkerAssignment) =>
        _jobId === jobId && value.workerId === assignment.workerId &&
        value.workerGeneration === assignment.workerGeneration &&
        value.upstreamRequestId === assignment.upstreamRequestId &&
        value.threadId === assignment.threadId,
      acknowledgeExecution });
    await reopen("user-a", sameOwner);
    await eventually(() => state.listJobs().some(job => job.jobId === jobId && job.status === "completed"), 5_000);
    expect(recoverExecution).toHaveBeenCalledExactlyOnceWith(jobId, expect.any(Function), expect.any(Function));
    expect(state.listJobs()).toContainEqual(expect.objectContaining({
      jobId, status: "completed", authBoundary: original.authBoundary,
      result: expect.objectContaining({ content: [{ type: "text", text: "Original retained result after restart." }] })
    }));
    expect(state.listSessions()).toContainEqual(expect.objectContaining({
      threadId: assignment.threadId, authBoundary: original.authBoundary
    }));
    await eventually(() => acknowledgeExecution.mock.calls.length === 1);
    expect(acknowledgeExecution).toHaveBeenCalledExactlyOnceWith(jobId);
    expect(sameOwner.calls).toHaveLength(0);
    const recoveredStatus = await client.callTool({ name: "codex_status", _meta: metadata,
      arguments: { query: { kind: "job", id: jobId } } });
    expect(recoveredStatus.isError, JSON.stringify(recoveredStatus)).not.toBe(true);
    expect(recoveredStatus.structuredContent).toMatchObject({ items: [expect.objectContaining({
      id: jobId, state: "completed", answer: expect.stringContaining("Original retained result after restart.")
    })] });
  });

  it.each([
    { scenario: "live original worker", initialWorkerProof: true, loseReply: false },
    { scenario: "worker proof recovered before send", initialWorkerProof: false, loseReply: false },
    { scenario: "answer sent but reply lost", initialWorkerProof: true, loseReply: true }
  ])("keeps the original Job question and ACK after an external login change: $scenario", async ({ initialWorkerProof, loseReply }) => {
    const home = path.join(root, ".codex");
    const authFile = path.join(home, "auth.json");
    await mkdir(home);
    const login = (userId: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: {
      account_id: "shared-workspace", id_token: syntheticIdToken(userId, "shared-workspace")
    } });
    await writeFile(authFile, login("user-a"));
    const service = new CodexService({ HOME: root, CODEX_HOME: home, PATH: "",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") });
    config.codexService = service;
    await service.assertCurrentAdmission();

    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream = new FixtureUpstream();
    let originalWorkerLive = false;
    const acknowledgeExecution = vi.fn();
    Object.assign(upstream, {
      supportsExecutionRecovery: () => true,
      ownsActiveExecution: (_jobId: string, assignment: UpstreamWorkerAssignment) =>
        originalWorkerLive && assignment.workerId === "fixture-worker" &&
        assignment.workerGeneration === 1 && assignment.threadId === "tool-contract-thread" &&
        assignment.upstreamRequestId === fixtureTurnId,
      ownsRetainedResult: (_jobId: string, assignment: UpstreamWorkerAssignment) =>
        assignment.workerId === "fixture-worker" && assignment.workerGeneration === 1 &&
        assignment.threadId === "tool-contract-thread" && assignment.upstreamRequestId === fixtureTurnId,
      respondToInteraction: async (interactionId: string, response: CodexInteractionResponse) => {
        upstream.interactionResponses.push({ interactionId, response });
        if (loseReply) throw new Error("Synthetic reply lost after the answer reached the original worker.");
      },
      acknowledgeExecution
    });
    server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
    client = new Client(
      { name: "original-job-question-owner-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({ name: "codex_task", arguments: {
      scopeId: randomUUID(), requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Wait for the original worker's synthetic question.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    }, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;
    hold.assign("tool-contract-thread");
    const originalOwner = state.listJobs().find(job => job.jobId === jobId)?.authBoundary;
    expect(originalOwner).toMatch(/^[a-f0-9]{64}$/);
    const interactionId = "fixture-worker:1:question-original";
    hold.progress({ progress: 0.5, event: {
      eventId: "question-original", type: "input-required", phase: "waiting",
      createdAt: Date.now(), summary: "Original worker question", details: { interaction: {
        interactionId, kind: "user-input", origin: "codex-question",
        threadId: "tool-contract-thread", turnId: fixtureTurnId,
        itemId: "question-item", summary: "Original worker question",
        questions: [{ id: "answer", question: "Continue?", isSecret: false }]
      } }
    } });
    const input = await client.callTool({ name: "codex_status", _meta: metadata,
      arguments: { query: { kind: "input", jobId } } });
    expect(input.isError, JSON.stringify(input)).not.toBe(true);
    const questionRef = (input.structuredContent as { questions?: Array<{ questionRef?: string }> })
      .questions?.[0]?.questionRef;
    expect(questionRef, JSON.stringify(input.structuredContent)).toBeTruthy();

    await writeFile(authFile, login("user-b"));
    await expect(service.assertCurrentAdmission()).rejects.toThrow("CODEX_AUTH_CHANGED");
    expect(service.currentExecutionAuthBoundary()).toBeNull();
    const respond = (requestId: string) => client.callTool({ name: "codex_answer", _meta: metadata,
      arguments: { requestId, jobId, questionRef, answers: { answer: ["yes"] } } });
    originalWorkerLive = initialWorkerProof;
    const answerRequestId = randomUUID();
    const answered = await respond(answerRequestId);
    expect(answered.isError, JSON.stringify(answered)).not.toBe(true);
    expect(answered.structuredContent).toMatchObject({
      delivery: !initialWorkerProof ? "not-delivered" : loseReply ? "uncertain" : "delivered",
      answersPersisted: false
    });
    expect(upstream.interactionResponses).toHaveLength(initialWorkerProof ? 1 : 0);
    if (!initialWorkerProof) {
      const stillBlocked = await respond(answerRequestId);
      expect(stillBlocked.structuredContent).toMatchObject({ delivery: "not-delivered" });
      expect(upstream.interactionResponses).toHaveLength(0);
      const differentRequest = await respond(randomUUID());
      expect(differentRequest.isError).toBe(true);
      expect(JSON.stringify(differentRequest)).toContain("QUESTION_ALREADY_DISPATCHED");
      originalWorkerLive = true;
      const recovered = await respond(answerRequestId);
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({ delivery: "delivered" });
    } else if (loseReply) {
      const repeated = await respond(answerRequestId);
      expect(repeated.structuredContent).toMatchObject({ delivery: "uncertain" });
      const differentRequest = await respond(randomUUID());
      expect(differentRequest.isError).toBe(true);
      expect(JSON.stringify(differentRequest)).toContain("QUESTION_ALREADY_DISPATCHED");
    }
    expect(upstream.interactionResponses).toEqual([{
      interactionId, response: { answers: { answer: ["yes"] } }
    }]);
    hold.release({
      structuredContent: { threadId: "tool-contract-thread", turnStatus: "completed" },
      content: [{ type: "text", text: "Original worker result." }]
    });
    await eventually(() => state.listJobs().some(job => job.jobId === jobId && job.status === "completed"), 5_000);
    expect((state.listSessions() as Array<{ threadId: string; authBoundary: string }>))
      .toContainEqual(expect.objectContaining({ threadId: "tool-contract-thread", authBoundary: originalOwner }));
    expect(acknowledgeExecution).toHaveBeenCalledExactlyOnceWith(jobId);
  });

  it("cancels an original Job after an external login change only with live proof of its worker", async () => {
    const home = path.join(root, ".codex");
    const authFile = path.join(home, "auth.json");
    await mkdir(home);
    const login = (userId: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: {
      account_id: "shared-workspace", id_token: syntheticIdToken(userId, "shared-workspace")
    } });
    await writeFile(authFile, login("user-a"));
    const service = new CodexService({ HOME: root, CODEX_HOME: home, PATH: "",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime") });
    config.codexService = service;
    await service.assertCurrentAdmission();

    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream = new FixtureUpstream();
    let originalWorkerLive = false;
    const forceTerminateWorker = vi.fn(async (assignment: UpstreamWorkerAssignment) => ({
      ...assignment, mode: "turn-interrupt" as const, exited: true, workerExited: false, escalated: false
    }));
    Object.assign(upstream, {
      supportsExecutionRecovery: () => true,
      ownsActiveExecution: (_jobId: string, assignment: UpstreamWorkerAssignment) =>
        originalWorkerLive && assignment.workerId === "fixture-worker" &&
        assignment.workerGeneration === 1 && assignment.threadId === "tool-contract-thread" &&
        assignment.upstreamRequestId === fixtureTurnId,
      forceTerminateWorker
    });
    server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
    client = new Client({ name: "original-job-cancellation-owner-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({ name: "codex_task", arguments: {
      scopeId: randomUUID(), requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Hold a synthetic original Job for cancellation.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    }, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;
    hold.assign("tool-contract-thread");
    const originalOwner = state.listJobs().find(job => job.jobId === jobId)?.authBoundary;
    await writeFile(authFile, login("user-b"));
    await expect(service.assertCurrentAdmission()).rejects.toThrow("CODEX_AUTH_CHANGED");
    const cancel = (requestId: string) => client.callTool({ name: "codex_cancel", _meta: metadata,
      arguments: { requestId, target: { kind: "job", id: jobId },
        expectedVersion: state.listJobs().find(job => job.jobId === jobId)?.version,
        reason: "Stop the original synthetic Job." } });
    try {
      const blocked = await cancel(randomUUID());
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain("CODEX_AUTH_JOB_BOUNDARY");
      expect(forceTerminateWorker).not.toHaveBeenCalled();
      expect(state.listJobs().find(job => job.jobId === jobId)?.status).toBe("running");
      originalWorkerLive = true;
      const stopped = await cancel(randomUUID());
      expect(stopped.isError, JSON.stringify(stopped)).not.toBe(true);
      expect(state.listJobs().find(job => job.jobId === jobId)).toMatchObject({
        status: "cancelled", authBoundary: originalOwner
      });
      expect(forceTerminateWorker).toHaveBeenCalledTimes(1);
      expect(forceTerminateWorker.mock.calls[0]?.[0]).toMatchObject({
        workerId: "fixture-worker", workerGeneration: 1, upstreamRequestId: fixtureTurnId
      });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
    }
  });

  it("keeps physical background-read slots across repeated native snapshot timeouts", async () => {
    const scopeId = randomUUID();
    for (let index = 0; index < 80; index++) {
      const agent = state.createAgent({ scopeId, agentName: `retention-${index}` });
      state.linkAgentThread({ agentId: agent.agentId, threadId: `retention-thread-${index}`,
        backendKind: "app-server", cwd: root, sandbox: "read-only", contextMode: "fresh" });
    }
    const releases: Array<() => void> = [];
    let blocked = true;
    const inspect = vi.fn(() => blocked ? new Promise<[]>(resolve => releases.push(() => resolve([]))) : Promise.resolve([]));
    Object.assign(upstream, { listLoadedBackgroundTerminals: inspect });
    vi.useFakeTimers();
    try {
      for (let index = 0; index < 5; index++) {
        const pending = server.applicationService.runtimeSnapshot({ inspectBackgroundProcesses: true });
        await vi.advanceTimersByTimeAsync(1600);
        expect((await pending).backgroundProcessState).toBe("unknown");
        expect(inspect).toHaveBeenCalledTimes(8);
      }
      blocked = false; for (const release of releases) release();
      await vi.advanceTimersByTimeAsync(1);
      expect((await server.applicationService.runtimeSnapshot({ inspectBackgroundProcesses: true })).backgroundProcessState).toBe("confirmed");
    } finally { for (const release of releases) release(); vi.useRealTimers(); }
  });

  it("explains removed Agent archive as a structured error without mutating history", async () => {
    const result = await client.callTool({ name: "codex_agent", _meta: metadata,
      arguments: { requestId: randomUUID(), agentId: randomUUID(), operation: { kind: "archive" } } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "AGENT_ARCHIVE_REMOVED" });
    expect(upstream.calls).toHaveLength(0);
    expect(state.listJobs()).toHaveLength(0);
  });

  it("rejects stale Decision Card calls without changing Codex or state", async () => {
    const retired = [
      {
        name: "codex_decision",
        arguments: {
          operation: "create", requestId: randomUUID(), title: "Former card",
          html: '<label>Plan <input name="plan" value="staged"></label>'
        }
      },
      {
        name: "codex_decision_result",
        arguments: { receipt: `decision_${"a".repeat(64)}` }
      },
      {
        name: "codex_ui_decision",
        arguments: {
          operation: "submit", cardId: randomUUID(), cardVersion: 1,
          presentationRef: "b".repeat(64), widgetInstanceId: randomUUID(),
          submissionId: randomUUID(), intent: "confirm",
          fields: [{ name: "plan", values: ["staged"] }]
        }
      }
    ];
    const listed = (await client.listTools()).tools.map(tool => tool.name);
    const resources = (await client.listResources()).resources.map(resource => resource.uri);
    for (const { name, arguments: args } of retired) {
      expect(listed).not.toContain(name);
      await expect(client.callTool({ name, arguments: args, _meta: metadata }))
        .rejects.toThrow(/not found/i);
    }
    expect(resources.some(uri => uri.includes("/decision/"))).toBe(false);
    const database = new Database(path.join(root, "state.sqlite"), { readonly: true });
    try {
      for (const table of ["decision_cards", "decision_card_versions", "decision_card_requests", "decision_submissions"]) {
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
          .toBeUndefined();
      }
    } finally {
      database.close();
    }
    expect(state.listJobs()).toEqual([]);
    expect(state.listActivities()).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it("lets GPT search, read, and version Bridge Markdown skills without starting Codex", async () => {
    const originalContent = "# Evidence review\n\n| Claim | Evidence | Risk |\n| --- | --- | --- |";
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: "Evidence review",
        description: "Review reports with an evidence table.",
        content: originalContent,
        files: [{ path: "references/policy.md", content: "# Policy\n\nKeep the immutable evidence chain." }]
      }
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const createdSkill = (created.structuredContent as any).skill;
    const createdReference = { skillId: createdSkill.skillId, source: createdSkill.source, version: createdSkill.version };

    const found = await client.callTool({ name: "bridge_skill", arguments: { operation: "search", query: "evidence report" } });
    expect(found.isError, JSON.stringify(found)).not.toBe(true);
    const candidates = (found.structuredContent as any).skills;
    expect(candidates).toEqual([expect.objectContaining({ skillId: createdSkill.skillId, source: "bridge", version: "1" })]);

    const read = await client.callTool({ name: "bridge_skill", arguments: { operation: "read", skill: createdReference } });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      kind: "skill",
      skill: {
        name: "Evidence review",
        content: originalContent,
        format: "markdown",
        legacy: false,
        sourceSnapshot: "versioned-bridge-record",
        files: [expect.objectContaining({ path: "references/policy.md", format: "markdown" })]
      }
    });
    expect(JSON.parse((read.content[0] as any).text)).toEqual(read.structuredContent);

    const fileRead = await client.callTool({
      name: "bridge_skill",
      arguments: { operation: "read-file", skill: createdReference, path: "references/policy.md" }
    });
    expect(fileRead.isError, JSON.stringify(fileRead)).not.toBe(true);
    expect(fileRead.structuredContent).toMatchObject({
      kind: "skill-file",
      path: "references/policy.md",
      content: expect.stringContaining("immutable evidence chain"),
      format: "markdown"
    });
    expect(JSON.parse((fileRead.content[0] as any).text)).toEqual(fileRead.structuredContent);

    const oldReferenceOperation = await client.callTool({
      name: "bridge_skill", arguments: { operation: "reference", skill: createdReference, referenceId: "unused" }
    });
    expect(oldReferenceOperation.isError).toBe(true);

    const updated = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "update", requestId: randomUUID(), skillId: createdSkill.skillId,
        expectedVersion: createdSkill.version, content: "# Evidence review\n\nUpdated Markdown body.",
        files: {
          remove: ["references/policy.md"],
          upsert: [{ path: "references/current.md", content: "# Current policy" }]
        }
      }
    });
    expect(updated.isError, JSON.stringify(updated)).not.toBe(true);
    const updatedSkill = (updated.structuredContent as any).skill;
    expect(updatedSkill.version).toBe("2");

    const versions = await client.callTool({ name: "bridge_skill", arguments: { operation: "versions", skillId: createdSkill.skillId } });
    expect(versions.structuredContent).toMatchObject({ kind: "skill-versions", currentVersion: "2" });
    expect((versions.structuredContent as any).versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: "2", format: "markdown", legacy: false }),
      expect.objectContaining({ version: "1", format: "markdown", legacy: false })
    ]));

    const archived = await client.callTool({
      name: "bridge_skill_manage",
      arguments: { operation: "set-enabled", requestId: randomUUID(), skillId: createdSkill.skillId, expectedVersion: updatedSkill.version, enabled: false }
    });
    expect((archived.structuredContent as any).skill).toMatchObject({ enabled: false, availability: "disabled" });
    const historical = await client.callTool({ name: "bridge_skill", arguments: { operation: "read", skill: createdReference } });
    expect(historical.structuredContent).toMatchObject({ skill: { content: originalContent } });
    expect(upstream.calls).toEqual([]);
  });

  it("uses Unicode-scalar name limits and exact opaque Bridge references", async () => {
    const name = "😀".repeat(BRIDGE_SKILL_LIMITS.nameMaxCharacters);
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name,
        content: "# Unicode scalar boundary"
      }
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const skill = (created.structuredContent as any).skill;
    expect(skill.name).toBe(name);

    const overflow = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: `${name}😀`,
        content: "# Too long"
      }
    });
    expect(overflow.isError).toBe(true);

    const paddedReference = await client.callTool({
      name: "bridge_skill",
      arguments: {
        operation: "read",
        skill: { skillId: ` ${skill.skillId}`, source: "bridge", version: skill.version }
      }
    });
    expect(paddedReference.isError).toBe(true);
  });

  it("keeps Bridge skills outside the Codex task schema and prompt", async () => {
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: "Local review",
        description: "Review a local report before editing it.",
        content: "Inspect the report, then make only evidence-backed edits."
      }
    });
    const skill = (created.structuredContent as any).skill;
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;

    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "73737373-7373-4737-8737-737373737373",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Review the local report.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await eventually(() => upstream.calls.length === 1);
    const dispatched = upstream.calls[0]!.args;
    expect(properties).not.toHaveProperty("requiredSkills");
    expect(dispatched.prompt).toBe("Review the local report.");
    expect(dispatched.prompt).not.toContain("evidence-backed edits");
    expect(dispatched).not.toHaveProperty("skillInputs");
    const job = state.listJobs().find((candidate) => candidate.requestId === (result.structuredContent as any).requestId)!;
    expect(job.sessionDecision).not.toHaveProperty("requiredSkills");
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
    expect(settingsView.settings).not.toHaveProperty("dashboardAutoOpen");
    expect(settingsView.settings).not.toHaveProperty("completionFollowUp");
    expect(settingsView.settings).not.toHaveProperty("activityCardVisibility");
    expect(settingsView.settings).not.toHaveProperty("completionHandoff");
    expect(settingsView.capabilities).not.toHaveProperty("availableActivityCardVisibilities");
    expect(settingsView.capabilities).not.toHaveProperty("availableCompletionHandoffs");
  });

  it("keeps developer-only startup diagnostics out of normal Settings", async () => {
    const diagnostic = "This development build explicitly targets the stable state profile.";
    config.developerStartupWarnings.push(diagnostic);

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "settings" }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect((result.structuredContent as { warnings: string[] }).warnings).not.toContain(diagnostic);
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
        selection
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

  it("keeps created-time representatives and exact historical recovery metadata in bounded Dashboard reads", async () => {
    const scopeId = "78787878-7878-4787-8787-787878787878";
    const agentId = "79797979-7979-4797-8797-797979797979";
    const olderFailedJobId = randomUUID();
    const newerCompletedJobId = randomUUID();
    const base = Date.now() - 1_000;
    state.createAgent({
      scopeId,
      agentId,
      agentName: "dashboard-selection-fixture",
      now: base
    });
    state.upsertJob({
      jobId: olderFailedJobId,
      scopeId,
      requestId: randomUUID(),
      status: "failed",
      agentId,
      createdAt: base + 10,
      updatedAt: base + 100
    });
    state.upsertJob({
      jobId: newerCompletedJobId,
      scopeId,
      requestId: randomUUID(),
      status: "completed",
      agentId,
      createdAt: base + 20,
      updatedAt: base + 90
    });
    state.deleteJob(olderFailedJobId);
    state.deleteJob(newerCompletedJobId);

    const recovery = state.automaticRecovery.begin({
      key: "a".repeat(64),
      scopeId,
      agentId,
      jobId: olderFailedJobId,
      kind: "retry-stop"
    }, base + 110)!;
    state.automaticRecovery.finish(recovery.key, recovery.attempts, {
      resolved: false,
      reason: "fixture-blocked",
      retryable: false
    }, base + 111);

    const bounded = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "problems",
        enrich: false,
        includeHistory: false
      }
    });
    expect(bounded.isError, JSON.stringify(bounded)).not.toBe(true);
    expect((bounded.structuredContent as any).statusRows.some((row: any) =>
      row.agentName === "dashboard-selection-fixture"
    )).toBe(false);

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: true,
        problems: {
          view: "automatic",
          review: "pending",
          kind: "all",
          offset: 0
        }
      }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const dashboard = result.structuredContent as any;
    const representative = dashboard.terminalRows.find((row: any) =>
      row.agentName === "dashboard-selection-fixture"
    );
    expect(representative?.latestTurn).toMatchObject({
      status: "completed",
      startedAt: new Date(base + 20).toISOString(),
      updatedAt: new Date(base + 90).toISOString()
    });
    expect(dashboard.problems.automaticCount).toBe(1);
    expect(dashboard.problems.rows).toHaveLength(1);
    expect(dashboard.problems.rows[0]).toMatchObject({
      source: "recovery",
      automatic: {
        kind: "retry-stop",
        state: "blocked",
        reason: "fixture-blocked"
      },
      row: {
        status: "failed",
        createdAt: new Date(base + 10).toISOString(),
        updatedAt: new Date(base + 100).toISOString(),
        latestTurn: {
          status: "failed",
          startedAt: new Date(base + 10).toISOString(),
          updatedAt: new Date(base + 100).toISOString()
        }
      }
    });
  });

  it("keeps Dashboard summary and deferred history on the same representative beyond the twelve-row boundary", async () => {
    const scopeId = "80808080-8080-4080-8080-808080808080";
    const agentId = "81818181-8181-4181-8181-818181818181";
    const base = Date.now() - 10_000;
    state.createAgent({
      scopeId,
      agentId,
      agentName: "dashboard-history-boundary",
      now: base
    });
    for (let index = 1; index <= 13; index += 1) {
      const jobId = `history-boundary-old-${String(index).padStart(2, "0")}`;
      state.upsertJob({
        jobId,
        scopeId,
        requestId: randomUUID(),
        status: "failed",
        agentId,
        createdAt: base + index,
        updatedAt: base + 2_000 + index
      });
      state.deleteJob(jobId);
    }
    state.upsertJob({
      jobId: "history-boundary-newest-run",
      scopeId,
      requestId: randomUUID(),
      status: "completed",
      agentId,
      createdAt: base + 1_000,
      updatedAt: base + 1_001
    });
    state.deleteJob("history-boundary-newest-run");

    const summaryResult = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: true
      }
    });
    expect(summaryResult.isError, JSON.stringify(summaryResult)).not.toBe(true);
    const summary = (summaryResult.structuredContent as any).terminalRows.find((row: any) =>
      row.agentName === "dashboard-history-boundary"
    );
    expect(summary?.latestTurn).toMatchObject({
      status: "completed",
      startedAt: new Date(base + 1_000).toISOString(),
      updatedAt: new Date(base + 1_001).toISOString()
    });
    expect(summary?.historyRevision).toEqual(expect.any(String));

    const detailResult = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard-history",
        rowKey: summary.rowKey,
        widgetInstanceId: randomUUID(),
        scope: "all"
      }
    });
    expect(detailResult.isError, JSON.stringify(detailResult)).not.toBe(true);
    const detail = detailResult.structuredContent as any;
    expect(detail.historyRevision).toBe(summary.historyRevision);
    expect(detail.historyCount).toBe(13);
    expect(detail.history).toHaveLength(12);
    expect(detail.history.map((turn: any) => turn.startedAt)).toEqual(
      Array.from({length: 12}, (_, index) =>
        new Date(base + 13 - index).toISOString()
      )
    );
  });

  it("publishes draft-2020-12-compatible v6 asynchronous task input without retired fields", async () => {
    const tools = await client.listTools();
    const task = tools.tools.find((tool) => tool.name === "codex_task")!;
    const properties = task.inputSchema.properties as Record<string, { const?: string }>;
    expect(properties.taskContractVersion?.const).toBe("6");
    expect(properties.executionEnvelopeRef?.const).toMatch(/^[a-f0-9]{64}$/);
    expect(properties).toHaveProperty("project");
    for (const retired of ["projectLookup", "sandbox", "executionPolicyRef", "presentationId", "waitToken", "executionMode"]) {
      expect(properties).not.toHaveProperty(retired);
    }
    const status = tools.tools.find((tool) => tool.name === "codex_status")!;
    expect(status.inputSchema.properties).not.toHaveProperty("includeAllScopes");
  });

  it("admits a current v6 task and returns the durable asynchronous admission contract", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      contractVersion: "4",
      state: "running",
      terminal: false,
      completionDeliveryPolicy: "live-card",
      jobId: expect.any(String),
      requestId: expect.any(String),
      threadId: null,
      resultAvailability: "pending"
    });
    expect(result.structuredContent).not.toHaveProperty("waitContext");
    expect(result._meta).not.toHaveProperty("openai/outputTemplate");
    await hold.started;
    expect(upstream.calls).toHaveLength(1);
    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === (result.structuredContent as any).jobId && job.status === "completed"
    ));
  });

  it("reports an exact owner result awaiting terminal storage without claiming the Job is still executing", async () => {
    const acknowledgeExecution = vi.fn();
    Object.assign(upstream, {
      supportsExecutionRecovery: () => true,
      acknowledgeExecution
    });
    const originalUpsert = state.upsertJob.bind(state);
    let blockTerminal = true;
    let commitAttempts = 0;
    vi.spyOn(state, "upsertJob").mockImplementation(value => {
      if (blockTerminal && (value as { status?: unknown }).status === "completed") {
        commitAttempts += 1;
        throw new Error("injected busy terminal transaction");
      }
      return originalUpsert(value);
    });

    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: randomUUID(),
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete the retained owner result fixture.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;

    const running = await client.callTool({
      name: "codex_status", arguments: { query: { kind: "job", id: jobId } }, _meta: metadata
    });
    expect(running.structuredContent).toMatchObject({ items: [expect.objectContaining({
      completionEvidence: expect.objectContaining({
        ownerTerminalResult: null
      })
    })] });

    hold.release();
    await eventually(() => commitAttempts > 0);
    const pending = await client.callTool({
      name: "codex_status", arguments: { query: { kind: "job", id: jobId } }, _meta: metadata
    });
    expect(pending.isError, JSON.stringify(pending)).not.toBe(true);
    expect(pending.structuredContent).toMatchObject({ items: [expect.objectContaining({
      state: "running",
      completionEvidence: expect.objectContaining({
        jobRecord: "active-last-known",
        ownerObservation: null,
        ownerTerminalResult: { origin: "normal-completion", observedAt: expect.any(String) },
        terminalOrigin: null,
        resultOffer: "none",
        activityLifecycle: "open"
      }),
      message: expect.stringContaining("durable Job storage is still pending")
    })] });
    expect(state.listJobs()).toContainEqual(expect.objectContaining({ jobId, status: "running" }));
    expect(acknowledgeExecution).not.toHaveBeenCalled();

    blockTerminal = false;
    await eventually(() => state.listJobs().some(job => job.jobId === jobId && job.status === "completed"));
    const committed = await client.callTool({
      name: "codex_status", arguments: { query: { kind: "job", id: jobId } }, _meta: metadata
    });
    expect(committed.isError, JSON.stringify(committed)).not.toBe(true);
    expect(committed.structuredContent).toMatchObject({ items: [expect.objectContaining({
      state: "completed",
      completionEvidence: expect.objectContaining({
        jobRecord: "terminal-committed",
        ownerTerminalResult: null,
        terminalOrigin: "normal-completion",
        activityLifecycle: "open"
      }),
      answer: expect.stringContaining("Completed delayed fixture work")
    })] });
    expect(upstream.calls).toHaveLength(1);
    await eventually(() => acknowledgeExecution.mock.calls.length === 1);
    expect(acknowledgeExecution).toHaveBeenCalledWith(jobId);
  });

  it("snapshots experimental direct-result delivery per Job and keeps the default live-card path unchanged", async () => {
    const descriptorBefore = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptorBefore.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const enabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: {
          kind: "patch",
          settings: { experimentalDirectResultDelivery: true }
        }
      },
      _meta: metadata
    });
    expect(enabled.isError, JSON.stringify(enabled)).not.toBe(true);
    expect(enabled.structuredContent).toHaveProperty(
      "settings.experimentalDirectResultDelivery",
      true
    );
    const enabledRevision = (enabled.structuredContent as any).settings.settingsRevision as number;
    const descriptorAfter = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect((descriptorAfter.inputSchema.properties as any).executionEnvelopeRef.const)
      .toBe(properties.executionEnvelopeRef?.const);
    expect(descriptorAfter.description).toContain("Follow the returned Job's completionDeliveryPolicy and nextActions");
    expect(descriptorAfter.description).toContain("repeat that same Job wait after timeout or host abort");

    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const argumentsValue = {
      scopeId: "78787878-7878-4878-8878-787878787878",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Complete the direct-result fixture work.",
      project: {
        name: project.name,
        projectRef: project.projectRef,
        projectRevision: project.projectRevision
      },
      selection
    };
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: argumentsValue,
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    await hold.started;
    const task = admitted.structuredContent as any;
    expect(task).toMatchObject({
      contractVersion: "4",
      state: "running",
      completionDeliveryPolicy: "direct-wait"
    });
    expect(task.nextActions).toContainEqual(expect.objectContaining({
      kind: "tool",
      tool: "codex_status",
      arguments: {
        query: {
          kind: "job",
          id: task.jobId,
          waitFor: "terminal",
          waitMs: 60_000
        }
      }
    }));
    expect(task.nextActions.some((action: any) => action.tool === "codex_dashboard")).toBe(false);
    expect(JSON.stringify(admitted.content)).toContain("Required before replying:");
    expect(JSON.stringify(admitted.content)).toContain("codex_status");

    const timedOut = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: task.jobId, waitFor: "terminal", waitMs: 1 }
      },
      _meta: metadata
    });
    expect(timedOut.isError, JSON.stringify(timedOut)).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: task.jobId,
        state: "running",
        completionDeliveryPolicy: "direct-wait",
        completionEvidence: expect.objectContaining({
          jobRecord: "active-last-known",
          terminalOrigin: null,
          deliveryRecord: null,
          resultOffer: "none",
          activityLifecycle: "open"
        }),
        wait: expect.objectContaining({ waitFor: "terminal", timedOut: true }),
        nextActions: expect.arrayContaining([expect.objectContaining({
          tool: "codex_status",
          arguments: { query: expect.objectContaining({ id: task.jobId, waitFor: "terminal" }) }
        })])
      })]
    });

    const replay = await client.callTool({
      name: "codex_task",
      arguments: argumentsValue,
      _meta: metadata
    });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      jobId: task.jobId,
      replay: true,
      completionDeliveryPolicy: "direct-wait"
    });
    expect(upstream.calls).toHaveLength(1);

    const disabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: enabledRevision,
        operation: {
          kind: "patch",
          settings: { experimentalDirectResultDelivery: false }
        }
      },
      _meta: metadata
    });
    expect(disabled.isError, JSON.stringify(disabled)).not.toBe(true);
    expect(disabled.structuredContent).toHaveProperty(
      "settings.experimentalDirectResultDelivery",
      false
    );

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === task.jobId && job.status === "completed"
    ));
    const terminal = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: task.jobId, waitFor: "terminal", waitMs: 60_000 }
      },
      _meta: metadata
    });
    expect(terminal.isError, JSON.stringify(terminal)).not.toBe(true);
    expect(terminal.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: task.jobId,
        state: "completed",
        completionDeliveryPolicy: "direct-wait",
        completionEvidence: expect.objectContaining({
          jobRecord: "terminal-committed",
          ownerObservation: null,
          terminalOrigin: "normal-completion",
          deliveryRecord: "pending",
          resultOffer: "none",
          activityLifecycle: "open"
        }),
        answer: expect.stringContaining("Completed delayed fixture work")
      })]
    });
    const directDelivery = state.getJobCompletionDelivery(task.jobId)!;
    expect(directDelivery).toMatchObject({
      state: "pending",
      attemptCount: 0,
      directResultOfferedAt: expect.any(Number)
    });
    const offeredAgain = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: task.jobId } },
      _meta: metadata
    });
    expect(offeredAgain.isError, JSON.stringify(offeredAgain)).not.toBe(true);
    expect(offeredAgain.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: task.jobId,
        completionEvidence: expect.objectContaining({
          jobRecord: "terminal-committed",
          resultOffer: "direct-query",
          deliveryRecord: "pending",
          activityLifecycle: "open"
        })
      })]
    });
    expect(state.claimJobCompletionDelivery(
      task.jobId,
      directDelivery.scopeId,
      randomUUID()
    )).toBeUndefined();

    const defaultTask = await client.callTool({
      name: "codex_task",
      arguments: {
        ...argumentsValue,
        requestId: randomUUID(),
        prompt: "Complete the default delivery fixture work."
      },
      _meta: metadata
    });
    expect(defaultTask.isError, JSON.stringify(defaultTask)).not.toBe(true);
    expect(defaultTask.structuredContent).toMatchObject({
      state: "running",
      completionDeliveryPolicy: "live-card",
      nextActions: expect.arrayContaining([expect.objectContaining({ tool: "codex_dashboard" })])
    });
  });

  it("keeps a direct-wait Job pending at an unapproved Codex command boundary", async () => {
    const enabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: { kind: "patch", settings: { experimentalDirectResultDelivery: true } }
      },
      _meta: metadata
    });
    expect(enabled.isError, JSON.stringify(enabled)).not.toBe(true);
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Wait at a fixture command approval; do not continue automatically.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    expect(admitted.structuredContent).toMatchObject({ completionDeliveryPolicy: "direct-wait" });
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;
    hold.assign(fixtureThreadId, fixtureTurnId);
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.threadId === fixtureThreadId
    ));

    const approval: CodexPendingInteraction = {
      interactionId: "fixture-command-approval",
      kind: "command-approval",
      origin: "app-approval",
      isBlocking: true,
      threadId: fixtureThreadId,
      turnId: fixtureTurnId,
      itemId: "fixture-command-item",
      summary: "A fixture command requires the user's approval."
    };
    hold.progress({
      progress: 1,
      event: {
        eventId: "fixture-command-approval",
        type: "approval-required",
        phase: "updated",
        createdAt: Date.now(),
        summary: approval.summary,
        details: { interaction: approval }
      }
    });
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.pendingInteractions.some((input) => input.interactionId === approval.interactionId)
    ));

    const input = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "input", jobId } },
      _meta: metadata
    });
    expect(input.isError, JSON.stringify(input)).not.toBe(true);
    expect(input.structuredContent).toMatchObject({
      kind: "codex-input",
      active: true,
      questions: [],
      approvals: [{ kind: "command-approval", isBlocking: true, reason: "approval-path-required" }]
    });
    const wait = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 1 } },
      _meta: metadata
    });
    expect(wait.isError, JSON.stringify(wait)).not.toBe(true);
    expect(wait.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: jobId,
        state: "running",
        completionDeliveryPolicy: "direct-wait",
        wait: expect.objectContaining({ timedOut: true })
      })]
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.interactionResponses).toEqual([]);
    expect(state.listJobs().filter((job) => job.jobId === jobId)).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  });

  it("recovers a direct-wait Job by exact identity after the host aborts a status read", async () => {
    const enabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: { kind: "patch", settings: { experimentalDirectResultDelivery: true } }
      },
      _meta: metadata
    });
    expect(enabled.isError, JSON.stringify(enabled)).not.toBe(true);
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Continue after a fixture host read abort.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    expect(admitted.structuredContent).toMatchObject({ completionDeliveryPolicy: "direct-wait" });
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await hold.started;
    try {
      const projectRevisionReads = vi.spyOn(state, "getProjectRegistryRevision");
      projectRevisionReads.mockClear();
      const controller = new AbortController();
      const waiting = client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 5_000 } },
        _meta: metadata
      }, { signal: controller.signal });
      await eventually(() => projectRevisionReads.mock.calls.length > 0);
      controller.abort();
      await expect(waiting).rejects.toThrow();
      await eventually(() => state.listTransportObservations("status-wait-aborted")
        .some((observation) => observation.jobId === jobId));
      expect(state.listTransportObservations("status-wait-aborted")).toContainEqual(
        expect.objectContaining({
          jobId,
          toolName: "codex_status",
          reasonCode: "host-aborted-read-wait"
        })
      );

      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 1 } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [expect.objectContaining({
          id: jobId,
          state: "running",
          completionDeliveryPolicy: "direct-wait",
          wait: expect.objectContaining({ timedOut: true })
        })]
      });
      expect(state.listJobs().filter((job) => job.jobId === jobId)).toHaveLength(1);
      expect(state.listJobs().find((job) => job.jobId === jobId)?.cancelRequestedAt).toBeUndefined();
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
      await eventually(() => state.listJobs().some((job) =>
        job.jobId === jobId && job.status === "completed"
      ));
    }
    const terminal = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 1 } },
      _meta: metadata
    });
    expect(terminal.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({ id: jobId, state: "completed", completionDeliveryPolicy: "direct-wait" })]
    });
  });

  it("returns durable admission immediately while the admitted Job runs for more than one minute", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const startedAt = Date.now();
    let jobId: string | undefined;

    try {
      const admitted = await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
          requestId,
          taskContractVersion: properties.taskContractVersion?.const,
          executionEnvelopeRef: properties.executionEnvelopeRef?.const,
          prompt: "Remain active for the long asynchronous admission acceptance fixture.",
          project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
          selection
        },
        _meta: metadata
      });
      const admissionElapsedMs = Date.now() - startedAt;
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      expect(admissionElapsedMs).toBeLessThan(5_000);
      jobId = (admitted.structuredContent as { jobId: string }).jobId;
      await hold.started;

      await new Promise<void>((resolve) => setTimeout(resolve, 61_000));

      expect(state.listJobs().find((job) => job.jobId === jobId)).toMatchObject({
        requestId,
        status: "running"
      });
      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [{ id: jobId, state: "running" }]
      });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  }, 75_000);

  it("does not admit a task when transport fails before dispatch and admits it once on exact retry", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover a request that was lost before durable admission.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let dropBeforeDispatch = false;
    const lossyFetch: typeof globalThis.fetch = async (input, init) => {
      if (
        dropBeforeDispatch &&
        typeof init?.body === "string" &&
        init.body.includes('"name":"codex_task"')
      ) {
        dropBeforeDispatch = false;
        throw new TypeError("simulated pre-admission transport loss");
      }
      return globalThis.fetch(input, init);
    };
    const lossyClient = new Client(
      { name: "pre-admission-loss-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));

    try {
      dropBeforeDispatch = true;
      await expect(lossyClient.callTool({
        name: "codex_task",
        arguments: arguments_,
        _meta: metadata
      })).rejects.toThrow("simulated pre-admission transport loss");
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toEqual([]);
      expect(upstream.calls).toHaveLength(0);

      const missing = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("HANDLE_UNAVAILABLE");

      const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      await eventually(() => state.listJobs().some((job) =>
        job.requestId === requestId && job.status === "completed"
      ));
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toHaveLength(1);
      expect(upstream.calls).toHaveLength(1);
    } finally {
      await lossyClient.close();
    }
  });

  it("recovers a durable Job when the admission response is lost in transport", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover this Job after its durable admission response is lost.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let dropTaskResponse = false;
    const lossyFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (
        dropTaskResponse &&
        typeof init?.body === "string" &&
        init.body.includes('"name":"codex_task"')
      ) {
        dropTaskResponse = false;
        await response.body?.cancel();
        throw new TypeError("simulated lost admission response");
      }
      return response;
    };
    const lossyClient = new Client(
      { name: "admission-response-loss-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));
    let jobId: string | undefined;

    try {
      dropTaskResponse = true;
      await expect(lossyClient.callTool({
        name: "codex_task",
        arguments: arguments_,
        _meta: metadata
      })).rejects.toThrow("simulated lost admission response");
      await hold.started;
      const admitted = state.listJobs().filter((job) => job.requestId === requestId);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({ status: "running" });
      jobId = admitted[0]!.jobId;

      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [{ id: jobId, state: "running" }]
      });

      const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
      expect(replay.structuredContent).toMatchObject({ jobId, replay: true, state: "running" });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
      await lossyClient.close();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  });

  it("deduplicates concurrent exact retries into one durable Job and one upstream execution", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Deduplicate simultaneous durable admission retries.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let jobId: string | undefined;

    try {
      const [first, second] = await Promise.all([
        client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata }),
        client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata })
      ]);
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
      const firstResult = first.structuredContent as { jobId: string; replay: boolean; state: string };
      const secondResult = second.structuredContent as { jobId: string; replay: boolean; state: string };
      expect(firstResult.jobId).toBe(secondResult.jobId);
      expect([firstResult.replay, secondResult.replay].sort()).toEqual([false, true]);
      expect(firstResult.state).toBe("running");
      expect(secondResult.state).toBe("running");
      jobId = firstResult.jobId;
      await hold.started;
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toHaveLength(1);
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  });

  it("recovers an admitted Job by requestId and rejects conflicting reuse without redispatch", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "79797979-7979-4797-8797-797979797979",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover this durable admission after a lost response.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };

    const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    await hold.started;
    const jobId = (admitted.structuredContent as any).jobId as string;

    const recovered = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "request", requestId } },
      _meta: metadata
    });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      kind: "job",
      items: [{ id: jobId, state: "running" }]
    });

    const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ jobId, replay: true, state: "running" });
    expect(upstream.calls).toHaveLength(1);

    const conflict = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_, prompt: "A different task must not reuse this requestId." },
      _meta: metadata
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("requestId was already used");
    expect(upstream.calls).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((job) => job.jobId === jobId && job.status === "completed"));
  });

  it("recovers an approved second turn after response loss and repeated parent reads without stalling independent work", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const scopeId = randomUUID();
    const common = {
      scopeId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const
    };
    const parent = await client.callTool({
      name: "codex_task",
      arguments: {
        ...common,
        requestId: randomUUID(),
        prompt: "Read the harmless fixture value for stage A.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(parent.isError, JSON.stringify(parent)).not.toBe(true);
    const parentJob = parent.structuredContent as { jobId: string; agentId: string; activityId: string };
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === parentJob.jobId && job.status === "completed"
    ));
    const readParent = () => client.callTool({
      name: "codex_status",
      arguments: { scopeId, query: { kind: "job", id: parentJob.jobId } },
      _meta: metadata
    });
    const firstParentRead = await readParent();
    expect(firstParentRead.isError, JSON.stringify(firstParentRead)).not.toBe(true);

    const followUpRequestId = randomUUID();
    const followUp = {
      ...common,
      requestId: followUpRequestId,
      prompt: "Review the stage A fixture value for stage B.",
      activity: { mode: "existing", id: parentJob.activityId },
      agent: { mode: "existing", id: parentJob.agentId, context: "continue" }
    };
    const hold = upstream.holdNextCall();
    let loseFollowUpResponse = true;
    const lossyFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (
        loseFollowUpResponse &&
        typeof init?.body === "string" &&
        init.body.includes('"name":"codex_task"')
      ) {
        loseFollowUpResponse = false;
        await response.body?.cancel();
        throw new TypeError("simulated lost follow-up admission response");
      }
      return response;
    };
    const lossyClient = new Client(
      { name: "follow-up-response-loss-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));
    let followUpJobId: string | undefined;
    try {
      await expect(lossyClient.callTool({
        name: "codex_task", arguments: followUp, _meta: metadata
      })).rejects.toThrow("simulated lost follow-up admission response");
      await hold.started;
      const secondParentRead = await readParent();
      expect((secondParentRead.structuredContent as any).items[0]).toMatchObject({
        id: parentJob.jobId,
        state: "completed",
        answer: (firstParentRead.structuredContent as any).items[0].answer,
        result: (firstParentRead.structuredContent as any).items[0].result
      });

      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { scopeId, query: { kind: "request", requestId: followUpRequestId } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      followUpJobId = (recovered.structuredContent as any).items[0].id;
      expect((recovered.structuredContent as any).items[0].state).toBe("running");

      const retries = await Promise.all([0, 1].map(() => client.callTool({
        name: "codex_task", arguments: followUp, _meta: metadata
      })));
      for (const retry of retries) {
        expect(retry.isError, JSON.stringify(retry)).not.toBe(true);
        expect(retry.structuredContent).toMatchObject({ jobId: followUpJobId, replay: true });
      }
      const conflict = await client.callTool({
        name: "codex_task",
        arguments: { ...followUp, prompt: "A different stage cannot reuse B's request ID." },
        _meta: metadata
      });
      expect(conflict.isError).toBe(true);
      expect(state.listJobs().filter((job) => job.requestId === followUpRequestId)).toHaveLength(1);
      expect(upstream.calls).toHaveLength(2);

      upstream.setNextThreadId(randomUUID());
      const independent = await client.callTool({
        name: "codex_task",
        arguments: {
          ...common,
          requestId: randomUUID(),
          prompt: "Document a separate harmless fixture value.",
          project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
          activity: { mode: "new", title: "Independent fixture branch" },
          agent: { mode: "new", name: "Independent fixture agent" },
          selection
        },
        _meta: metadata
      });
      expect(independent.isError, JSON.stringify(independent)).not.toBe(true);
      await eventually(() => state.listJobs().some((job) =>
        job.jobId === (independent.structuredContent as any).jobId &&
        ["completed", "failed", "interrupted", "cancelled"].includes(job.status)
      ));
      const independentJob = state.listJobs().find((job) =>
        job.jobId === (independent.structuredContent as any).jobId
      );
      expect(independentJob?.error).toBeUndefined();
      expect(independentJob?.status).toBe("completed");
      expect(upstream.calls).toHaveLength(3);
    } finally {
      hold.release();
      await lossyClient.close();
    }
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === followUpJobId && job.status === "completed"
    ));
    const terminal = await client.callTool({
      name: "codex_status",
      arguments: { scopeId, query: { kind: "request", requestId: followUpRequestId } },
      _meta: metadata
    });
    expect(terminal.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({ id: followUpJobId, state: "completed", result: { availability: "delivered", omitted: false } })]
    });

    // A fresh ID remains available for a separately approved rerun. If a host
    // accidentally changes B's ID after replaying A, current admission cannot
    // distinguish that mistake from this legitimate new turn.
    const rerunRequestId = randomUUID();
    upstream.setNextThreadId("tool-contract-thread");
    const rerun = await client.callTool({
      name: "codex_task",
      arguments: { ...followUp, requestId: rerunRequestId },
      _meta: metadata
    });
    expect(rerun.isError, JSON.stringify(rerun)).not.toBe(true);
    expect((rerun.structuredContent as any).jobId).not.toBe(followUpJobId);
    await eventually(() => state.listJobs().some((job) =>
      job.requestId === rerunRequestId && job.status === "completed"
    ));
    expect(upstream.calls).toHaveLength(4);

    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    settings = new UserSettingsStore(config, { stateStore: state });
    upstream = new FixtureUpstream();
    server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
    client = new Client(
      { name: "follow-up-restart-recovery-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const afterRestart = await client.callTool({
      name: "codex_status",
      arguments: { scopeId, query: { kind: "request", requestId: followUpRequestId } },
      _meta: metadata
    });
    expect(afterRestart.isError, JSON.stringify(afterRestart)).not.toBe(true);
    expect(afterRestart.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({ id: followUpJobId, state: "completed", result: { availability: "delivered", omitted: false } })]
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it("recovers a scoped terminal admission fact after its result expires and the bridge restarts", async () => {
    settings.update({ experimentalDirectResultDelivery: true }, settings.current.revision);
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const scopeId = randomUUID();
    const parent = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId,
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Produce the harmless parent result before stage B.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(parent.isError, JSON.stringify(parent)).not.toBe(true);
    const parentJob = parent.structuredContent as { jobId: string; agentId: string; activityId: string };
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === parentJob.jobId && job.status === "completed"
    ));
    const parentResult = await client.callTool({
      name: "codex_status",
      arguments: { scopeId, query: { kind: "job", id: parentJob.jobId } },
      _meta: metadata
    });
    expect(parentResult.isError, JSON.stringify(parentResult)).not.toBe(true);
    const requestId = randomUUID();
    const arguments_ = {
      scopeId,
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Review the parent result in stage B before retention expires.",
      activity: { mode: "existing", id: parentJob.activityId },
      agent: { mode: "existing", id: parentJob.agentId, context: "continue" }
    };
    const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const jobId = (admitted.structuredContent as any).jobId as string;
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
    const admittedScopeId = state.listJobs().find((job) => job.jobId === jobId)!.scopeId;

    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(state.deleteJob(jobId)).toBe(true);
    expect(state.getArchivedJobAdmissionReceipt(admittedScopeId, { kind: "request", requestId }))
      .toMatchObject({ jobId, requestId, status: "completed" });
    state.maintainRetention(Date.now() + 100 * 86_400_000);
    expect(state.getArchivedJobAdmissionReceipt(admittedScopeId, { kind: "request", requestId }))
      .toMatchObject({ jobId, requestId, status: "completed" });
    state.close();

    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    settings = new UserSettingsStore(config, { stateStore: state });
    upstream = new FixtureUpstream();
    server = createHttpServer(config, upstream, new FixtureCatalog(), { stateStore: state });
    client = new Client(
      { name: "expired-result-recovery-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    for (const query of [
      { kind: "request", requestId },
      { kind: "job", id: jobId, waitFor: "terminal", waitMs: 1 }
    ]) {
      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { scopeId, query },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [expect.objectContaining({
          id: jobId,
          state: "completed",
          terminal: true,
          replay: true,
          result: { availability: "omitted", omitted: true },
          message: expect.stringContaining("result body is no longer retained")
        })]
      });
      expect(JSON.stringify(recovered)).not.toContain("Completed fixture work.");
    }

    const foreignMetadata = { "openai/session": "foreign-expired-result-test" };
    const unavailableText = async (id: string) => {
      const result = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId: id } },
        _meta: foreignMetadata
      });
      expect(result.isError).toBe(true);
      return JSON.stringify(result.content);
    };
    const [foreign, missing] = await Promise.all([
      unavailableText(requestId),
      unavailableText(randomUUID())
    ]);
    expect(foreign).toBe(missing);
    expect(foreign).toContain("HANDLE_UNAVAILABLE");

    const repeatedTask = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(repeatedTask.isError).toBe(true);
    expect(JSON.stringify(repeatedTask)).toContain("codex_status query kind='request'");
    expect(state.listJobs().filter((job) => job.requestId === requestId)).toHaveLength(0);
    expect(upstream.calls).toHaveLength(0);
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
        selection
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
      threadId: null,
      jobVersion: expect.any(Number)
    });
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === handles.jobId && job.status === "completed" && Boolean(job.threadId)
    ));
    const durableHandles = state.listJobs().find((job) => job.jobId === handles.jobId)!;
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
      { query: { kind: "thread", id: durableHandles.threadId } },
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
        expectedVersion: durableHandles.version, reason: "fixture"
      },
      {
        requestId: randomUUID(), target: { kind: "job", id: "missing-job" },
        expectedVersion: durableHandles.version, reason: "fixture"
      }
    );
    await expectSameUnavailable(
      "codex_activity_update",
      {
        activityId: handles.activityId, expectedVersion: 1,
        operation: { kind: "set-policy", policy: { kind: "review" } }
      },
      {
        activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedVersion: 1,
        operation: { kind: "set-policy", policy: { kind: "review" } }
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
    const arguments_ = {
      scopeId: "77777777-7777-4777-8777-777777777777",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Keep this task alive while the HTTP response is detached.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    const pending = client.callTool({
      name: "codex_task",
      arguments: arguments_,
      _meta: metadata
    }, { signal: controller.signal });
    const outcome = pending.then(
      () => "completed" as const,
      () => "detached" as const
    );
    await hold.started;
    controller.abort();

    const disposition = await outcome;
    expect(["completed", "detached"]).toContain(disposition);
    const admitted = state.listJobs().find((item) =>
      (item as { requestId?: unknown }).requestId === requestId
    ) as { status?: unknown; cancelRequestedAt?: unknown } | undefined;
    expect(admitted).toMatchObject({ status: "running" });
    expect(admitted?.cancelRequestedAt).toBeFalsy();

    const recovered = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "request", requestId } },
      _meta: metadata
    });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      kind: "job",
      items: [{ id: (admitted as { jobId: string }).jobId, state: "running" }]
    });
    const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      jobId: (admitted as { jobId: string }).jobId,
      replay: true,
      state: "running"
    });
    expect(upstream.calls).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((item) =>
      (item as { requestId?: unknown; status?: unknown }).requestId === requestId &&
      (item as { status?: unknown }).status === "completed"
    ));
  });

  it("records an aborted exact status wait while the same Job keeps running", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const task = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Stay active while an exact status read is aborted.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });
    expect(task.isError, JSON.stringify(task)).not.toBe(true);
    await hold.started;
    const jobId = (task.structuredContent as { jobId: string }).jobId;
    try {
      const projectRevisionReads = vi.spyOn(state, "getProjectRegistryRevision");
      projectRevisionReads.mockClear();
      const controller = new AbortController();
      const waiting = client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 5_000 } },
        _meta: metadata
      }, { signal: controller.signal });
      await eventually(() => projectRevisionReads.mock.calls.length > 0);
      controller.abort();

      await expect(waiting).rejects.toThrow();
      await eventually(() => state.listTransportObservations("status-wait-aborted").length === 1);
      expect(state.listTransportObservations("status-wait-aborted")).toEqual([
        expect.objectContaining({
          kind: "status-wait-aborted",
          jobId,
          toolName: "codex_status",
          reasonCode: "host-aborted-read-wait"
        })
      ]);
      expect(state.listJobs().find((job) => job.jobId === jobId)).toMatchObject({
        status: "running"
      });
      expect(state.listJobs().find((job) => job.jobId === jobId)?.cancelRequestedAt)
        .toBeUndefined();
    } finally {
      hold.release();
      await eventually(() => state.listJobs().some((job) =>
        job.jobId === jobId && job.status === "completed"
      )).catch(() => undefined);
    }
  });

  it("keeps an asynchronous admission valid before App Server assigns its thread", async () => {
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
        selection
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

  it("automatically opens the originating conversation Dashboard for admitted work and queues completion delivery", async () => {
    const tools = await client.listTools();
    const descriptor = tools.tools.find((tool) => tool.name === "codex_task")!;
    const statusDescriptor = tools.tools.find((tool) => tool.name === "codex_status")!;
    const dashboardDescriptor = tools.tools.find((tool) => tool.name === "codex_dashboard")!;
    expect(statusDescriptor.description).toContain(
      "does not prove GPT received the result and does not settle or cancel live-card delivery"
    );
    expect(statusDescriptor.description).not.toContain("settles any still-pending live-card follow-up");
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    expect((dashboardDescriptor._meta as Record<string, any>)["openai/outputTemplate"])
      .toBe(DASHBOARD_CARD_URI);
    expect((dashboardDescriptor._meta as Record<string, any>).ui)
      .toMatchObject({ resourceUri: DASHBOARD_CARD_URI });
    const hold = upstream.holdNextCall();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "88888888-8888-4888-8888-888888888888",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        activity: {
          mode: "new",
          title: "Fixture completion delivery"
        },
        selection
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await hold.started;
    expect(result._meta || {}).not.toHaveProperty("openai/outputTemplate");
    expect(result._meta || {}).not.toHaveProperty("codex/dashboardOpen@1");
    const task = result.structuredContent as any;
    const renderAction = task.nextActions.find((action: any) =>
      action.kind === "tool" &&
      action.tool === "codex_dashboard" &&
      action.arguments.scope === "conversation" &&
      action.arguments.jobId === task.jobId
    );
    expect(renderAction).toMatchObject({
      kind: "tool",
      tool: "codex_dashboard",
      arguments: {
        scope: "conversation",
        jobId: task.jobId,
        presentationRef: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      message: expect.stringContaining("originating Dashboard")
    });
    const origin = state.listJobs().find((job) =>
      job.jobId === task.jobId
    );
    expect(origin).toBeDefined();
    const runningStatus = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: origin!.jobId } },
      _meta: metadata
    });
    expect(runningStatus.isError, JSON.stringify(runningStatus)).not.toBe(true);
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toBeUndefined();

    const mismatchedDashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        presentationRef: "0".repeat(64)
      },
      _meta: metadata
    });
    expect(mismatchedDashboardOpen.isError).toBe(true);

    const dashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: renderAction.arguments,
      _meta: metadata
    });
    expect(dashboardOpen.isError, JSON.stringify(dashboardOpen)).not.toBe(true);
    expect(dashboardOpen._meta || {}).not.toHaveProperty("openai/outputTemplate");
    const dashboardOpenMeta = dashboardOpen._meta as Record<string, any>;
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).toMatchObject({
      scope: "conversation",
      automatic: true,
      presentationRef: renderAction.arguments.presentationRef,
      completionDeliveryRoute: "live-card"
    });
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("presentationToken");
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("jobId");
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("scopeId");

    const repeatedDashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: renderAction.arguments,
      _meta: metadata
    });
    expect(repeatedDashboardOpen.isError, JSON.stringify(repeatedDashboardOpen)).not.toBe(true);
    expect((repeatedDashboardOpen._meta as Record<string, any>)["codex/dashboardOpen@1"])
      .toEqual(dashboardOpenMeta["codex/dashboardOpen@1"]);

    const differentJobWithSameReference = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        jobId: randomUUID()
      },
      _meta: metadata
    });
    expect(differentJobWithSameReference.isError).toBe(true);

    const foreignConversationWithOriginFallback = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        scopeId: origin!.scopeId
      },
      _meta: { "openai/session": "foreign-tool-contract-test" }
    });
    expect(foreignConversationWithOriginFallback.isError).toBe(true);

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === origin!.jobId && job.status === "completed"
    ));
    const completedActivity = state.getActivity(origin!.activityId);
    expect(completedActivity).toMatchObject({
      lifecycle: "open",
      handoffPolicy: "none",
      completionTrigger: "manual"
    });
    const completionDelivery = state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)!;
    expect(completionDelivery).toMatchObject({
      jobId: origin!.jobId,
      scopeId: origin!.scopeId,
      state: "pending",
      attemptCount: 0,
      receipt: expect.stringMatching(/^completion-[0-9a-f]{64}$/)
    });
    const widgetInstanceId = randomUUID();
    const claimedCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId
      },
      _meta: metadata
    });
    expect(claimedCompletion.isError, JSON.stringify(claimedCompletion)).not.toBe(true);
    expect(claimedCompletion.structuredContent).toMatchObject({
      kind: "job-completion-delivery",
      state: "claimed",
      receipt: completionDelivery.receipt,
      attempt: 1,
      deliveryState: "leased"
    });
    const directReadAfterLease = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: origin!.jobId } },
      _meta: metadata
    });
    expect(directReadAfterLease.isError, JSON.stringify(directReadAfterLease)).not.toBe(true);
    expect(directReadAfterLease.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: origin!.jobId,
        completionEvidence: expect.objectContaining({
          jobRecord: "terminal-committed",
          deliveryRecord: "leased",
          resultOffer: "none",
          activityLifecycle: "open"
        })
      })]
    });
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toMatchObject({
      state: "leased",
      directResultOfferedAt: expect.any(Number),
      resultReadSource: undefined
    });
    const foreignCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId: randomUUID()
      },
      _meta: { "openai/session": "foreign-completion-contract-test" }
    });
    expect(foreignCompletion.isError).toBe(true);
    const acceptedCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "accepted",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId,
        receipt: completionDelivery.receipt
      },
      _meta: metadata
    });
    expect(acceptedCompletion.isError, JSON.stringify(acceptedCompletion)).not.toBe(true);
    expect(acceptedCompletion.structuredContent).toMatchObject({
      state: "settled",
      deliveryState: "host-accepted"
    });
    const explicitScopeIsNotAuthority = await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: origin!.scopeId,
        query: { kind: "completion", receipt: completionDelivery.receipt }
      }
    });
    expect(explicitScopeIsNotAuthority.isError).toBe(true);
    const exactCompletion = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "completion", receipt: completionDelivery.receipt } },
      _meta: metadata
    });
    expect(exactCompletion.isError, JSON.stringify(exactCompletion)).not.toBe(true);
    expect(exactCompletion.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: origin!.jobId,
        state: "completed",
        completionEvidence: expect.objectContaining({
          terminalOrigin: "normal-completion",
          deliveryRecord: "host-accepted",
          resultOffer: "direct-query",
          activityLifecycle: "open"
        })
      })]
    });
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toMatchObject({
      state: "host-accepted",
      completionResultOfferedAt: expect.any(Number),
      resultReadSource: undefined
    });
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const dashboard = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId,
        scope: "conversation"
      },
      _meta: metadata
    });
    expect(dashboard.isError, JSON.stringify(dashboard)).not.toBe(true);
    expect((dashboard.structuredContent as any)).not.toHaveProperty("completionDelivery");
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const leaseOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const nativeEvents = await server.applicationService.claimNativeCompletionNotifications!({
      leaseOwner,
      limit: 10
    });
    expect(nativeEvents).toEqual([]);
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const settingsUpdate = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: { kind: "patch", settings: { dashboardAutoOpen: false } }
      },
      _meta: metadata
    });
    expect(settingsUpdate.isError).toBe(true);

    const secondTask = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "99999999-9999-4999-8999-999999999999",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete another background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(secondTask.isError, JSON.stringify(secondTask)).not.toBe(true);
    expect(secondTask._meta).not.toHaveProperty("openai/outputTemplate");
    expect(secondTask._meta).not.toHaveProperty("codex/dashboardOpen@1");
    const secondRenderAction = (secondTask.structuredContent as any).nextActions.find(
      (action: any) =>
        action.kind === "tool" &&
        action.tool === "codex_dashboard" &&
        action.arguments.jobId === (secondTask.structuredContent as any).jobId
    );
    expect(secondRenderAction).toMatchObject({
      kind: "tool",
      tool: "codex_dashboard",
      arguments: expect.objectContaining({
        scope: "conversation",
        jobId: (secondTask.structuredContent as any).jobId,
        presentationRef: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    });
    const secondJob = state.listJobs().find((job) =>
      job.jobId === (secondTask.structuredContent as any).jobId
    );
    expect(secondJob).toBeDefined();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === secondJob!.jobId && job.status === "completed"
    ));
    expect(state.getActivity(secondJob!.activityId)).toMatchObject({
      handoffPolicy: "none",
      completionTrigger: "manual"
    });
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending"
    });
    const explicitScopeRead = await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: secondJob!.scopeId,
        query: { kind: "job", id: secondJob!.jobId }
      }
    });
    expect(explicitScopeRead.isError, JSON.stringify(explicitScopeRead)).not.toBe(true);
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending",
      directResultOfferedAt: undefined,
      resultReadSource: undefined
    });
    const authenticatedDirectRead = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: secondJob!.jobId } },
      _meta: metadata
    });
    expect(authenticatedDirectRead.isError, JSON.stringify(authenticatedDirectRead)).not.toBe(true);
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending",
      directResultOfferedAt: expect.any(Number),
      resultReadSource: undefined,
      attemptCount: 0
    });
    const claimedAfterDirectOffer = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: secondJob!.jobId,
        presentationRef: secondRenderAction.arguments.presentationRef,
        widgetInstanceId: randomUUID()
      },
      _meta: metadata
    });
    expect(claimedAfterDirectOffer.isError, JSON.stringify(claimedAfterDirectOffer)).not.toBe(true);
    expect(claimedAfterDirectOffer.structuredContent).toMatchObject({
      state: "claimed",
      deliveryState: "leased",
      receipt: expect.stringMatching(/^completion-[0-9a-f]{64}$/)
    });
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
