import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  type Progress
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { HARD_MAX_CONCURRENT_JOBS, loadConfig } from "../src/config.js";
import {
  modelCatalogAdmissionFingerprint,
  modelCatalogFingerprint,
  type CodexModelCatalogProvider,
  type CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { projectNameKey } from "../src/projectRegistry.js";
import { SCOPE_ID_PATTERN, SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import {
  ACTIVITY_BOOTSTRAP_METADATA_KEY,
  ACTIVITY_CARD_CONTRACT_GENERATION,
  ACTIVITY_CARD_URI,
  ACTIVITY_VIEW_METADATA_KEY
} from "../src/activityCard.js";
import {
  SETTINGS_CARD_CONTRACT_GENERATION,
  SETTINGS_CARD_URI
} from "../src/settingsCard.js";
import {
  DASHBOARD_CARD_CONTRACT_GENERATION,
  DASHBOARD_CARD_URI,
  DASHBOARD_VIEW_METADATA_KEY
} from "../src/dashboardCard.js";
import {
  CodexJobRegistry,
  CODEX_TASK_INPUT_CONTRACT_VERSION,
  CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES,
  MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES,
  validateActivityViewPrivateMetadata,
  validateDashboardViewPrivateMetadata
} from "../src/tools.js";
import { uiResourceRevisions } from "../src/uiResources.js";
import {
  MAX_CODEX_INTERACTION_QUESTIONS,
  type CodexBackgroundTerminal,
  type CodexInteractionDecision,
  type CodexProgress,
  type CodexThreadResumeProbe,
  type CodexThreadForkRequest,
  type CodexUpstream,
  type CodexWeeklyUsage,
  type ToolResult,
  type UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const UPPERCASE_SCOPE = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
let requestSequence = 0;
let dashboardWidgetSequence = 0;

class FakeUpstream implements CodexUpstream {
  public calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private nextThread = 1;

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }, { name: "codex-reply" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const threadId =
      name === "codex-reply" && typeof args.threadId === "string" ? args.threadId : `thread-${this.nextThread++}`;
    return fakeCodexResult(threadId);
  }

  async close(): Promise<void> {}
}

class WeeklyUsageUpstream extends FakeUpstream {
  public usageReads = 0;

  async readAccountRateLimits(): Promise<CodexWeeklyUsage> {
    this.usageReads += 1;
    return {
      limitId: "codex",
      usedPercent: 35.5,
      remainingPercent: 64.5,
      windowDurationMins: 10_080,
      resetsAt: 1_900_604_800,
      observedAt: 1_900_000_000_000
    };
  }
}

class FailingInventoryUpstream extends FakeUpstream {
  public inventoryCalls = 0;

  override async listTools(): Promise<unknown> {
    this.inventoryCalls += 1;
    throw new Error("fixture upstream inventory unavailable");
  }
}

class DeferredUpstream extends FakeUpstream {
  public aborts = 0;
  protected pending: Array<{
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: CodexProgress) => void;
  }> = [];

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    onAssigned?.({
      backendKind: "mcp-server",
      workerId: "fake-0",
      workerGeneration: 1,
      workerPid: 999_001,
      processGroupId: 999_001
    });
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.push({ resolve, reject, onProgress });
    });
  }

  async forceTerminateWorker() {
    this.aborts += 1;
    for (const pending of this.pending.splice(0)) pending.reject(new Error("worker force-stopped"));
    return {
      pid: 999_001,
      processGroupId: 999_001,
      exited: true,
      escalated: false,
      signal: "SIGTERM" as const,
      mode: "process-group" as const,
      workerExited: true
    };
  }

  progressNext(progress: Progress): void {
    const pending = this.pending[0];
    if (!pending) throw new Error("No pending upstream call.");
    pending.onProgress?.(progress);
  }

  resolveNext(result: ToolResult = fakeCodexResult("thread-1")): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending upstream call.");
    pending.resolve(result);
  }

  rejectNext(error = new Error("upstream failed")): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending upstream call.");
    pending.reject(error);
  }
}

class CodexSessionDeferredUpstream extends DeferredUpstream {
  constructor(
    readonly threadId: string,
    readonly sessionId: string
  ) {
    super();
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    onAssigned?.({
      backendKind: "app-server",
      workerId: "app-session-link-0",
      workerGeneration: 1,
      workerPid: 999_101,
      processGroupId: 999_101,
      upstreamRequestId: "app-session-link-turn-1",
      threadId: this.threadId,
      sessionId: this.sessionId
    });
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.push({ resolve, reject, onProgress });
    });
  }
}

class MultiTurnAppUpstream extends FakeUpstream {
  public forceCalls: UpstreamWorkerAssignment[] = [];
  private nextTurn = 1;

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const turn = this.nextTurn++;
    onAssigned?.({
      backendKind: "app-server",
      workerId: "app-shared-0",
      workerGeneration: 4,
      workerPid: 4400,
      processGroupId: 4400,
      upstreamRequestId: `app-turn-${turn}`,
      threadId: `app-thread-${turn}`
    });
    return new Promise<ToolResult>(() => undefined);
  }

  async forceTerminateWorker(assignment: UpstreamWorkerAssignment) {
    this.forceCalls.push(assignment);
    return {
      pid: 4400,
      processGroupId: 4400,
      exited: true,
      escalated: false,
      signal: "SIGTERM" as const,
      mode: "turn-interrupt" as const,
      workerExited: false
    };
  }
}

class CrashThenResumeBridgeUpstream extends FakeUpstream {
  private crashed = false;

  capabilities() {
    return {
      selectionScope: "turn" as const,
      supportsModelOverrideOnContinue: true,
      supportsEffortOverrideOnContinue: true,
      supportsServiceTierOverrideOnContinue: true,
      supportsFork: true
    };
  }

  canResumeThread(threadId: string): boolean {
    return threadId === "bridge-crash-thread";
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const threadId = name === "codex-reply"
      ? String(args.threadId)
      : "bridge-crash-thread";
    onAssigned?.({
      backendKind: "app-server",
      workerId: this.crashed ? "app-replacement-0" : "app-crashed-0",
      workerGeneration: this.crashed ? 2 : 1,
      upstreamRequestId: this.crashed ? "bridge-resume-turn" : "bridge-crash-turn",
      threadId
    });
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("App Server worker crashed after turn admission.");
    }
    return {
      content: [{ type: "text", text: "resumed after worker crash" }],
      structuredContent: {
        threadId,
        turnId: "bridge-resume-turn",
        turnStatus: "completed",
        backendKind: "app-server",
        sessionId: "bridge-crash-session"
      }
    };
  }
}

class ForkLifecycleUpstream extends FakeUpstream {
  public archivedThreads: string[] = [];
  public restoredThreads: string[] = [];

  capabilities() {
    return {
      selectionScope: "turn",
      supportsModelOverrideOnContinue: true,
      supportsEffortOverrideOnContinue: true,
      supportsServiceTierOverrideOnContinue: true,
      supportsFork: true
    };
  }

  async forkThread(input: CodexThreadForkRequest): Promise<ToolResult> {
    this.calls.push({ name: "codex-fork", args: { ...input } });
    return {
      ...fakeCodexResult("thread-forked"),
      structuredContent: {
        threadId: "thread-forked",
        content: "done",
        backendKind: "app-server",
        sessionId: "session-tree-1",
        forkedFromThreadId: input.threadId
      }
    };
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
  }

  async restoreThread(threadId: string): Promise<void> {
    this.restoredThreads.push(threadId);
  }
}

class ManagedDeferredUpstream extends DeferredUpstream {
  public archivedThreads: string[] = [];
  public restoredThreads: string[] = [];

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
  }

  async restoreThread(threadId: string): Promise<void> {
    this.restoredThreads.push(threadId);
  }
}

class InteractionUpstream extends DeferredUpstream {
  public interactionResponses: Array<{
    interactionId: string;
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> };
  }> = [];
  public steeringRequests: Array<{ threadId: string; prompt: string }> = [];
  public steeringAvailable = true;

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    onAssigned?.({
      backendKind: "app-server",
      workerId: "app-interaction-0",
      workerGeneration: 1,
      workerPid: 999_002,
      processGroupId: 999_002,
      upstreamRequestId: "app-interaction-turn-1",
      threadId: "thread-1"
    });
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.push({ resolve, reject, onProgress });
    });
  }

  async respondToInteraction(
    interactionId: string,
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
  ): Promise<void> {
    this.interactionResponses.push({ interactionId, response });
  }

  canSteerThread(threadId: string): boolean {
    return this.steeringAvailable && threadId === "thread-1";
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    this.steeringRequests.push({ threadId, prompt });
    return { turnId: "turn-1" };
  }
}

class BackgroundTerminalUpstream extends FakeUpstream {
  public terminationCalls: Array<{ threadId: string; processId: string }> = [];
  public beforeNextList?: () => void;
  private readonly terminals = new Map<string, CodexBackgroundTerminal[]>();

  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await super.callTool(name, args);
    const threadId = (result.structuredContent as { threadId: string }).threadId;
    this.terminals.set(threadId, [
      {
        processId: "background-process-1",
        itemId: "background-item-1",
        command: "private background command",
        cwd: "/private/background/path",
        osPid: 12345
      },
      {
        processId: "legacy-background-process-2",
        itemId: "legacy-background-item-2",
        command: "private legacy background command",
        cwd: "/private/legacy/background/path",
        osPid: 12346
      }
    ]);
    return result;
  }

  async listBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    const terminals = [...(this.terminals.get(threadId) || [])];
    const beforeListReturns = this.beforeNextList;
    this.beforeNextList = undefined;
    beforeListReturns?.();
    await Promise.resolve();
    return terminals;
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string
  ): Promise<{ terminated: boolean }> {
    this.terminationCalls.push({ threadId, processId });
    const terminals = this.terminals.get(threadId) || [];
    const remaining = terminals.filter((terminal) => terminal.processId !== processId);
    this.terminals.set(threadId, remaining);
    return { terminated: remaining.length !== terminals.length };
  }
}

class LargeResultUpstream extends FakeUpstream {
  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    return {
      structuredContent: { threadId: "large-thread", content: "x".repeat(2000) },
      content: [{ type: "text", text: "x".repeat(2000) }]
    };
  }
}

class RestartAwareUpstream extends FakeUpstream {
  constructor(private readonly unavailableThreads: Set<string>) {
    super();
  }

  canResumeThread(threadId: string): boolean {
    return !this.unavailableThreads.has(threadId);
  }
}

class ProbeAwareUpstream extends FakeUpstream {
  public probeCalls: string[] = [];
  public hangProbe = false;
  public probe: CodexThreadResumeProbe = {
    state: "resumable",
    runtimeStatus: "idle",
    threadId: "thread-1"
  };

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    this.probeCalls.push(threadId);
    if (this.hangProbe) return new Promise(() => undefined);
    return { ...this.probe, threadId } as CodexThreadResumeProbe;
  }
}

class DeferredProbeUpstream extends FakeUpstream {
  public probeCalls: string[] = [];
  private pendingProbe?: {
    threadId: string;
    resolve: (probe: CodexThreadResumeProbe) => void;
  };

  get hasPendingProbe(): boolean {
    return this.pendingProbe !== undefined;
  }

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    this.probeCalls.push(threadId);
    return new Promise<CodexThreadResumeProbe>((resolve) => {
      this.pendingProbe = { threadId, resolve };
    });
  }

  resolveProbe(probe: Omit<CodexThreadResumeProbe, "threadId">): void {
    const pending = this.pendingProbe;
    if (!pending) throw new Error("No pending thread probe.");
    this.pendingProbe = undefined;
    pending.resolve({ ...probe, threadId: pending.threadId } as CodexThreadResumeProbe);
  }
}

class RunningProbeUpstream extends InteractionUpstream {
  public probe: CodexThreadResumeProbe = {
    state: "busy",
    runtimeStatus: "active",
    threadId: "thread-1",
    retryable: true
  };

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    return { ...this.probe, threadId } as CodexThreadResumeProbe;
  }

  async listBackgroundTerminals(): Promise<CodexBackgroundTerminal[]> {
    return [];
  }
}

class FakeModelCatalog implements CodexModelCatalogProvider {
  public calls: Array<{ refresh?: boolean }> = [];

  protected snapshot(cached: boolean): CodexModelCatalogSnapshot {
    const models = [
      model("gpt-5.6-sol", "max", ["low", "medium", "high", "xhigh", "max", "ultra"], true, "GPT-5.6 Sol"),
      model("gpt-5.6-terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"], false, "GPT-5.6 Terra"),
      model("gpt-5.5", "medium", ["low", "medium", "high", "xhigh"], false, "GPT-5.5")
    ];
    return {
      source: "codex-cli",
      fetchedAt: "2026-08-21T00:00:00.000Z",
      validatedAt: "2026-08-21T00:00:00.000Z",
      fingerprint: "f".repeat(64),
      cached,
      stale: false,
      validation: "valid",
      models
    };
  }

  async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    return this.snapshot(this.calls.length > 1);
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.snapshot(true);
  }
}

class MutatingModelCatalog extends FakeModelCatalog {
  public beforeRefresh?: () => void;

  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    if (options.refresh === true && this.beforeRefresh) {
      const mutate = this.beforeRefresh;
      this.beforeRefresh = undefined;
      mutate();
    }
    return super.getCatalog(options);
  }
}

class AdmissionMutatingModelCatalog extends FakeModelCatalog {
  public beforeGet?: () => void;

  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    if (this.beforeGet) {
      const mutate = this.beforeGet;
      this.beforeGet = undefined;
      mutate();
    }
    return super.getCatalog(options);
  }
}

class DriftingModelCatalog extends FakeModelCatalog {
  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    const current = this.snapshot(false);
    return {
      ...current,
      fingerprint: "d".repeat(64),
      models: current.models.filter((entry) => entry.id !== "gpt-5.6-terra")
    };
  }
}

class TieredModelCatalog extends FakeModelCatalog {
  protected override snapshot(cached: boolean): CodexModelCatalogSnapshot {
    const snapshot = super.snapshot(cached);
    return {
      ...snapshot,
      fingerprint: "e".repeat(64),
      models: snapshot.models.map((entry) => entry.id === "gpt-5.6-sol"
        ? {
            ...entry,
            serviceTiers: [{ id: "priority", name: "Priority" }]
          }
        : entry)
    };
  }
}

class FullModelCatalog extends FakeModelCatalog {
  protected override snapshot(cached: boolean): CodexModelCatalogSnapshot {
    const snapshot = super.snapshot(cached);
    return {
      ...snapshot,
      models: [
        snapshot.models[0],
        snapshot.models[1],
        model("gpt-5.6-luna", "medium", ["low", "medium", "high", "xhigh", "max"], false, "GPT-5.6 Luna"),
        snapshot.models[2],
        model("gpt-5.4", "medium", ["low", "medium", "high", "xhigh"], false, "GPT-5.4"),
        model("gpt-5.4-mini", "medium", ["low", "medium", "high", "xhigh"], false, "GPT-5.4 Mini"),
        model("gpt-5.3-codex-spark", "medium", ["low", "medium", "high", "xhigh"], false, "GPT-5.3 Codex Spark")
      ]
    };
  }
}

class DescriptionRefreshingModelCatalog extends FakeModelCatalog {
  private refreshed = false;

  protected override snapshot(cached: boolean): CodexModelCatalogSnapshot {
    const snapshot = super.snapshot(cached);
    const models = snapshot.models.map((entry) => entry.id === "gpt-5.6-sol" && this.refreshed
      ? {
          ...entry,
          description: "Updated Sol guidance from the refreshed backend catalog.",
          supportedReasoningEfforts: entry.supportedReasoningEfforts.map((effort) =>
            effort.effort === "max"
              ? { ...effort, description: "Updated maximum-effort guidance." }
              : effort
          )
        }
      : entry);
    return { ...snapshot, fingerprint: modelCatalogFingerprint(models), models };
  }

  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    if (options.refresh === true) this.refreshed = true;
    return this.snapshot(this.calls.length > 1);
  }
}

class TaskRefreshingModelCatalog extends FakeModelCatalog {
  private refreshed = false;
  private readonly listeners = new Set<(event: {
    backendKind: "mcp-server";
    previousFingerprint?: string;
    snapshot: CodexModelCatalogSnapshot;
  }) => void>();

  protected override snapshot(cached: boolean): CodexModelCatalogSnapshot {
    const snapshot = super.snapshot(cached);
    const models = snapshot.models.map((entry) => entry.id === "gpt-5.6-sol" && this.refreshed
      ? { ...entry, description: "Catalog changed while resolving codex_task." }
      : entry);
    return { ...snapshot, fingerprint: modelCatalogFingerprint(models), models };
  }

  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    if (!this.refreshed) {
      const previousFingerprint = this.snapshot(true).fingerprint;
      this.refreshed = true;
      const snapshot = this.snapshot(false);
      for (const listener of this.listeners) {
        listener({ backendKind: "mcp-server", previousFingerprint, snapshot });
      }
      return snapshot;
    }
    return this.snapshot(true);
  }

  subscribe(listener: (event: {
    backendKind: "mcp-server";
    previousFingerprint?: string;
    snapshot: CodexModelCatalogSnapshot;
  }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class UnavailableModelCatalog implements CodexModelCatalogProvider {
  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    throw new Error("catalog transport unavailable");
  }
}

class StaleModelCatalog extends FakeModelCatalog {
  override async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    return {
      ...this.snapshot(true),
      stale: true,
      validation: "temporarily-unverified-with-last-known-good"
    };
  }
}

describe("bridge tools", () => {
  it("publishes the consolidated Activity, settings, and Codex tools", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "codex_activity",
      "codex_activity_cancel",
      "codex_activity_handoff",
      "codex_activity_job_cancel",
      "codex_activity_rehydrate",
      "codex_activity_snapshot",
      "codex_activity_update",
      "codex_agent",
      "codex_agent_recovery_detach",
      "codex_background_process_terminate",
      "codex_cancel",
      "codex_dashboard",
      "codex_dashboard_snapshot",
      "codex_diagnostics",
      "codex_interaction_respond",
      "codex_job_steer",
      "codex_models",
      "codex_settings",
      "codex_settings_snapshot",
      "codex_status",
      "codex_steer",
      "codex_task",
      "codex_update_settings"
    ]);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const typelessModelLiterals: string[] = [];
    const openInputObjects: string[] = [];
    const visitPublishedSchema = (
      value: unknown,
      pointer: string,
      options: { requireLiteralType: boolean; requireClosedObjects: boolean }
    ): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) =>
          visitPublishedSchema(entry, `${pointer}/${index}`, options)
        );
        return;
      }
      const object = value as Record<string, unknown>;
      const literals = Object.prototype.hasOwnProperty.call(object, "const")
        ? [object.const]
        : Array.isArray(object.enum)
          ? object.enum
          : [];
      const declaredTypes = new Set(
        Array.isArray(object.type) ? object.type : [object.type]
      );
      const hasLiteralType = (entry: unknown) => {
        if (entry === null) return declaredTypes.has("null");
        if (typeof entry === "number") {
          return declaredTypes.has("number") || declaredTypes.has("integer");
        }
        return declaredTypes.has(typeof entry);
      };
      if (options.requireLiteralType && literals.some((entry) => !hasLiteralType(entry))) {
        typelessModelLiterals.push(pointer);
      }
      if (
        options.requireClosedObjects &&
        object.properties &&
        object.additionalProperties !== false
      ) openInputObjects.push(pointer);
      for (const [key, entry] of Object.entries(object)) {
        visitPublishedSchema(entry, `${pointer}/${key}`, options);
      }
    };
    for (const tool of tools.tools) {
      const meta = (tool._meta || {}) as Record<string, any>;
      const declaredVisibility = Array.isArray(meta.ui?.visibility)
        ? meta.ui.visibility as string[]
        : undefined;
      const modelVisible = declaredVisibility
        ? declaredVisibility.includes("model")
        : meta["openai/visibility"] !== "private";
      visitPublishedSchema(tool.inputSchema, `${tool.name}/inputSchema`, {
        requireLiteralType: modelVisible,
        requireClosedObjects: true
      });
      if (modelVisible) {
        visitPublishedSchema(tool.outputSchema, `${tool.name}/outputSchema`, {
          requireLiteralType: true,
          requireClosedObjects: false
        });
      }
    }
    expect(typelessModelLiterals).toEqual([]);
    expect(openInputObjects).toEqual([]);
    for (const tool of tools.tools) {
      expect(tool.inputSchema, `${tool.name} must reject unknown root inputs`).toMatchObject({
        type: "object",
        additionalProperties: false
      });
      expect(tool.outputSchema, `${tool.name} must declare structuredContent`).toMatchObject({
        type: "object",
        additionalProperties: false
      });
    }
    expect(byName.get("codex_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    });
    expect(byName.get("codex_dashboard")).toMatchObject({
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: { resourceUri: DASHBOARD_CARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": DASHBOARD_CARD_URI,
        "openai/widgetAccessible": true,
        "codex/uiContractGeneration": DASHBOARD_CARD_CONTRACT_GENERATION
      }
    });
    expect(byName.get("codex_dashboard_snapshot")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
    });
    expect(byName.get("codex_diagnostics")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
    });
    expect(byName.get("codex_status")?.inputSchema).toMatchObject({
      properties: {
        query: {
          oneOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                kind: { type: "string", const: "page" },
                collection: { type: "string", enum: ["sessions", "jobs", "activities"] }
              })
            })
          ])
        }
      }
    });
    const statusQueryVariants = (
      byName.get("codex_status")?.inputSchema.properties?.query as {
        oneOf?: Array<Record<string, any>>;
      }
    )?.oneOf || [];
    const statusJobQueryVariants = statusQueryVariants.filter(
      (variant) => variant.properties?.kind?.const === "job"
    );
    expect(statusJobQueryVariants).toHaveLength(2);
    const immediateJobQuery = statusJobQueryVariants.find(
      (variant) => !variant.properties?.waitFor
    );
    expect(Object.keys(immediateJobQuery?.properties || {}).sort()).toEqual(["id", "kind"]);
    expect(immediateJobQuery?.required?.sort()).toEqual(["id", "kind"]);
    const waitingJobQuery = statusJobQueryVariants.find(
      (variant) => variant.properties?.waitFor
    );
    expect(waitingJobQuery).toMatchObject({
      required: expect.arrayContaining(["kind", "id", "waitFor"]),
      properties: {
        kind: { type: "string", const: "job" },
        waitFor: {
          type: "string",
          enum: ["change", "terminal"],
          description: expect.any(String)
        },
        waitMs: expect.objectContaining({ maximum: 60000 })
      },
      additionalProperties: false
    });
    for (const hiddenCardField of [
      "scopeId",
      "includeAllScopes",
      "jobId",
      "activityId",
      "threadId",
      "waitFor",
      "waitMs",
      "sessionLimit",
      "sessionOffset",
      "sessionCursor",
      "jobLimit",
      "jobOffset",
      "jobCursor",
      "activityLimit",
      "activityOffset",
      "activityCursor",
      "activityView",
      "mountedActivityId",
      "cardGeneration",
      "activityPresentationId",
      "presentationKind",
      "afterVersion"
    ]) {
      expect(byName.get("codex_status")?.inputSchema.properties)
        .not.toHaveProperty(hiddenCardField);
    }
    expect(Object.keys(byName.get("codex_activity")?.inputSchema.properties || {}).sort())
      .toEqual(["activityId", "mode", "presentationId"]);
    expect(byName.get("codex_task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(byName.get("codex_task")?._meta).toBeUndefined();
    expect(byName.get("codex_activity")?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": ACTIVITY_CARD_URI
    });
    expect(byName.get("codex_task")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        contractVersion: { type: "string", enum: ["1"] },
        state: expect.any(Object),
        executionMode: expect.any(Object),
        resultAvailability: expect.any(Object),
        error: expect.objectContaining({ type: ["object", "null"] })
      }
    });
    expect((byName.get("codex_task")?.outputSchema as any).required.sort())
      .toEqual(Object.keys((byName.get("codex_task")?.outputSchema as any).properties).sort());
    for (const retired of ["bridgeSession", "bridgeActivity", "activityTracking"]) {
      expect((byName.get("codex_task")?.outputSchema as any).properties)
        .not.toHaveProperty(retired);
    }
    expect(byName.get("codex_activity")?.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["kind", "scopeVersion", "counts"]),
      additionalProperties: false
    });
    expect((byName.get("codex_activity")?.outputSchema as any).properties)
      .not.toHaveProperty("feed");
    expect(byName.get("codex_activity_snapshot")?.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["scopeVersion", "watcherPolicy", "feed"]),
      properties: {
        mountedPresentation: expect.any(Object),
        watcherPolicy: expect.any(Object),
        feed: expect.any(Object)
      }
    });
    expect(byName.get("codex_activity_rehydrate")?.outputSchema).toEqual(
      byName.get("codex_activity_snapshot")?.outputSchema
    );
    for (const cardOriginTool of [
      "codex_activity_handoff",
      "codex_background_process_terminate",
      "codex_cancel",
      "codex_interaction_respond",
      "codex_job_steer"
    ]) {
      expect(byName.get(cardOriginTool)?.outputSchema).toMatchObject({ type: "object" });
    }
    expect(byName.get("codex_task")?.inputSchema).toMatchObject({
      required: expect.arrayContaining([
        "taskContractVersion",
        "executionEnvelopeRef",
        "requestId",
        "prompt"
      ])
    });
    expect((byName.get("codex_task")?.inputSchema as { required?: string[] }).required)
      .not.toContain("activityPresentationId");
    expect((byName.get("codex_task")?.inputSchema as any)).not.toHaveProperty("allOf");
    expect((byName.get("codex_task")?.inputSchema as { required?: string[] }).required)
      .not.toContain("scopeId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("taskKey");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("cwd");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("threadId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("sessionMode");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("adoptThread");
    expect(byName.get("codex_cancel")?.inputSchema.properties).not.toHaveProperty("scopeId");
    expect(byName.get("codex_cancel")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["requestId", "jobId", "expectedVersion", "reason"])
    });
    expect(byName.get("codex_cancel")?.inputSchema.properties?.reason)
      .toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(Object.keys(byName.get("codex_steer")?.inputSchema.properties || {}).sort())
      .toEqual(["expectedJobVersion", "jobId", "prompt", "requestId"]);
    expect(byName.get("codex_steer")?.inputSchema).toMatchObject({
      required: ["requestId", "jobId", "expectedJobVersion", "prompt"],
      additionalProperties: false
    });
    expect(byName.get("codex_steer")?.inputSchema.properties).not.toHaveProperty("scopeId");
    for (const forbidden of [
      "activityId",
      "agentId",
      "threadId",
      "turnId",
      "card",
      "sandbox",
      "model",
      "project",
      "interactionId",
      "response"
    ]) {
      expect(byName.get("codex_steer")?.inputSchema.properties).not.toHaveProperty(forbidden);
    }
    expect(byName.get("codex_steer")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(byName.get("codex_steer")?._meta).not.toMatchObject({
      "openai/visibility": "private"
    });
    expect(byName.get("codex_activity_job_cancel")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_task")?.inputSchema.properties).toMatchObject({
      activity: { oneOf: expect.any(Array) },
      agent: { oneOf: expect.any(Array) },
      executionMode: { enum: ["foreground", "background"] },
      requestId: expect.any(Object),
      taskContractVersion: { const: CODEX_TASK_INPUT_CONTRACT_VERSION },
      executionEnvelopeRef: expect.objectContaining({ const: expect.any(String) }),
      project: expect.objectContaining({ additionalProperties: false }),
      projectLookup: expect.objectContaining({ additionalProperties: false }),
      selection: expect.objectContaining({ additionalProperties: false }),
      prompt: expect.any(Object)
    });
    expect(byName.get("codex_task")?.inputSchema.properties)
      .not.toHaveProperty("executionPolicyRef");
    expect(byName.get("codex_task")?.inputSchema.properties)
      .not.toHaveProperty("activityPresentationId");
    for (const hiddenTaskField of [
      "scopeId",
      "modelPolicyRevision",
      "activityId",
      "continuationOfActivityId",
      "activityTitle",
      "activityKind",
      "handoffPolicy",
      "completionTrigger",
      "agentId",
      "agentName",
      "agentRole",
      "contextMode"
    ]) {
      expect(byName.get("codex_task")?.inputSchema.properties)
        .not.toHaveProperty(hiddenTaskField);
    }
    const taskProperties = byName.get("codex_task")?.inputSchema.properties as
      | Record<string, any>
      | undefined;
    expect(taskProperties?.executionMode?.description).toContain(
      "Controls Codex execution timing, not Activity-card visibility"
    );
    expect(taskProperties?.executionMode?.description).toContain(
      "default a new Activity to background"
    );
    expect(taskProperties?.requestId?.description).toContain(
      "Never reuse it to group different tasks or multiple calls in one GPT response"
    );
    expect(taskProperties).not.toHaveProperty("projectId");
    expect(taskProperties?.project?.description).toContain("Exact current selector");
    expect(taskProperties?.project).toMatchObject({
      required: ["name", "projectRef", "projectRevision"],
      properties: {
        name: { type: "string" },
        projectRef: { type: "string" },
        projectRevision: { type: "integer" }
      }
    });
    expect(Object.keys(taskProperties?.project?.properties || {}).sort())
      .toEqual(["name", "projectRef", "projectRevision"]);
    expect(JSON.stringify(taskProperties?.project)).not.toContain("Test Project");
    const activityVariants = taskProperties?.activity?.oneOf as Array<Record<string, any>>;
    expect(activityVariants.map((variant) => variant.properties?.mode?.const).sort())
      .toEqual(["existing", "new"]);
    expect(activityVariants.find((variant) => variant.properties?.mode?.const === "existing"))
      .toMatchObject({ required: expect.arrayContaining(["mode", "id"]) });
    const newActivityVariant = activityVariants.find(
      (variant) => variant.properties?.mode?.const === "new"
    );
    expect(newActivityVariant).toMatchObject({
      properties: {
        continuationOf: expect.any(Object),
        title: expect.any(Object),
        policy: expect.any(Object)
      }
    });
    expect(newActivityVariant?.properties?.policy?.properties?.kind?.enum)
      .toEqual(["discussion", "investigation", "review", "implementation", "other"]);
    expect(newActivityVariant?.properties?.policy?.properties?.handoff?.enum)
      .toEqual(["none", "notify", "verify"]);
    expect(newActivityVariant?.properties?.policy?.properties?.completion?.enum)
      .toEqual(["manual", "sealed-jobs-terminal"]);
    const agentVariants = taskProperties?.agent?.oneOf as Array<Record<string, any>>;
    expect(agentVariants.map((variant) => variant.properties?.mode?.const).sort())
      .toEqual(["existing", "new"]);
    expect(agentVariants.find((variant) => variant.properties?.mode?.const === "existing"))
      .toMatchObject({
        required: expect.arrayContaining(["mode", "id"]),
        properties: { context: { enum: ["continue", "fork", "fresh"] } }
      });
    expect(agentVariants.find((variant) => variant.properties?.mode?.const === "new")?.properties)
      .not.toHaveProperty("context");
    const agentInputProperties = byName.get("codex_agent")?.inputSchema.properties as
      | Record<string, any>
      | undefined;
    expect(agentInputProperties).toMatchObject({
      agentId: expect.any(Object),
      requestId: expect.any(Object),
      operation: expect.any(Object)
    });
    const agentOperationVariants = agentInputProperties?.operation?.oneOf as
      | Array<Record<string, any>>
      | undefined;
    expect(agentOperationVariants?.map((variant) => variant.properties?.kind?.const).sort())
      .toEqual(["archive", "rename", "restore"]);
    expect(agentOperationVariants?.find((variant) => variant.properties?.kind?.const === "rename"))
      .toMatchObject({
        required: expect.arrayContaining(["kind", "name"]),
        properties: { name: expect.any(Object) }
      });
    expect(Object.keys(byName.get("codex_agent")?.inputSchema.properties || {}).sort())
      .toEqual(["agentId", "operation", "requestId"]);
    expect(byName.get("codex_agent")?.inputSchema.properties).not.toHaveProperty("activityId");
    expect(byName.get("codex_agent")?.inputSchema.properties).not.toHaveProperty("processId");
    expect(byName.get("codex_agent")?.inputSchema.properties).not.toHaveProperty("action");
    expect(byName.get("codex_agent_recovery_detach")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
    });
    expect(byName.get("codex_background_process_terminate")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(byName.get("codex_background_process_terminate")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
    });
    for (const appTool of [
      "codex_activity_rehydrate",
      "codex_activity_snapshot",
      "codex_interaction_respond",
      "codex_job_steer"
    ]) {
      expect(byName.get(appTool)?._meta).toMatchObject({
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
        "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
      });
    }
    expect(byName.get("codex_activity_snapshot")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["card"]),
      properties: {
        afterVersion: { minimum: 0 },
        cursor: { maxLength: 256, type: "string" },
        waitMs: { maximum: 60000 },
        widgetInstanceId: { type: "string", pattern: expect.stringContaining("[0-9a-f]") },
        card: expect.any(Object)
      }
    });
    expect(byName.get("codex_activity_rehydrate")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["jobId", "requestId"]),
      properties: {
        jobId: expect.any(Object),
        requestId: expect.any(Object),
        widgetInstanceId: { type: "string", pattern: expect.stringContaining("[0-9a-f]") }
      }
    });
    const interactionResponseSchema = byName.get("codex_interaction_respond")
      ?.inputSchema.properties?.response as {
        anyOf?: Array<Record<string, any>>;
        oneOf?: Array<Record<string, any>>;
      };
    const answerResponseVariant = (
      interactionResponseSchema.anyOf || interactionResponseSchema.oneOf || []
    ).find((variant) => variant.properties?.answers);
    expect(answerResponseVariant?.properties?.answers).toMatchObject({
      type: "object",
      maxProperties: MAX_CODEX_INTERACTION_QUESTIONS
    });
    expect(byName.get("codex_activity_handoff")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["action", "outboxIds", "card"]),
      properties: {
        action: { enum: ["claim-batch", "delivered-batch", "release-batch"] }
      }
    });
    expect(byName.get("codex_activity_handoff")?.inputSchema.properties)
      .not.toHaveProperty("outboxId");
    expect(byName.get("codex_cancel")?.inputSchema.properties?.acknowledgeAffectedJobIds)
      .toMatchObject({ maxItems: HARD_MAX_CONCURRENT_JOBS });
    expect(byName.get("codex_activity_cancel")?.inputSchema.properties?.acknowledgeAffectedJobIds)
      .toMatchObject({ maxItems: HARD_MAX_CONCURRENT_JOBS });
    expect(byName.get("codex_activity_update")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    const activityUpdateProperties = byName.get("codex_activity_update")?.inputSchema.properties as
      | Record<string, any>
      | undefined;
    expect(Object.keys(activityUpdateProperties || {}).sort()).toEqual([
      "activityId",
      "expectedVersion",
      "operation"
    ]);
    const activityOperationVariants = activityUpdateProperties?.operation?.oneOf as
      | Array<Record<string, any>>
      | undefined;
    expect(activityOperationVariants?.flatMap((variant) => {
      const discriminator = variant.properties?.kind;
      return discriminator?.const ? [discriminator.const] : discriminator?.enum || [];
    }).sort()).toEqual([
      "abandon",
      "complete",
      "seal",
      "set-policy",
      "start-verification",
      "verification-failed",
      "verification-passed"
    ]);
    expect(activityOperationVariants?.find(
      (variant) => variant.properties?.kind?.const === "verification-passed"
    )).toMatchObject({
      required: expect.arrayContaining(["kind", "evidence"])
    });
    expect(activityOperationVariants?.find(
      (variant) => variant.properties?.kind?.const === "verification-failed"
    )).toMatchObject({
      required: expect.arrayContaining(["kind", "reason"])
    });
    expect(activityOperationVariants?.find(
      (variant) => variant.properties?.kind?.const === "set-policy"
    )).toMatchObject({
      required: expect.arrayContaining(["kind", "policy"]),
      properties: { policy: expect.objectContaining({ minProperties: 1 }) }
    });
    expect(byName.get("codex_activity_cancel")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(Object.keys(byName.get("codex_activity_cancel")?.inputSchema.properties || {}).sort())
      .toEqual([
        "acknowledgeAffectedJobIds",
        "activityId",
        "expectedVersion",
        "reason",
        "requestId"
      ]);
    expect(byName.get("codex_activity_cancel")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["requestId", "activityId", "expectedVersion", "reason"])
    });
    expect(byName.get("codex_activity_cancel")?.inputSchema.properties?.reason)
      .toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(byName.get("codex_activity_job_cancel")?.inputSchema.properties)
      .not.toHaveProperty("reason");
    expect(byName.get("codex_settings")?._meta).toMatchObject({
      ui: { resourceUri: SETTINGS_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": SETTINGS_CARD_URI,
      "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_settings_snapshot")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_update_settings")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
    });
    expect(byName.get("codex_update_settings")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    });
    const updateSettingsSchema = byName.get("codex_update_settings")?.inputSchema as any;
    expect(Object.keys(updateSettingsSchema.properties).sort()).toEqual([
      "expectedRegistryRevision",
      "expectedSettingsRevision",
      "operation"
    ]);
    expect(updateSettingsSchema.required).toEqual(["operation"]);
    expect(updateSettingsSchema.properties.operation.oneOf.map(
      (variant: any) => variant.properties.kind.const
    )).toEqual(["reset", "patch"]);
    const settingsPatchSchema = updateSettingsSchema.properties.operation.oneOf[1]
      .properties.settings;
    expect(settingsPatchSchema).toMatchObject({
      minProperties: 1,
      properties: {
        accessStrategy: { enum: ["read-only", "adaptive"] },
        uiLocalePreference: {
          enum: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"]
        },
        activityCard: {
          minProperties: 1,
          properties: {
            visibility: { enum: ["always", "background-only", "never"] },
            completionHandoff: { enum: ["off", "auto-handoff"] }
          }
        }
      }
    });
    const policyVariants = settingsPatchSchema.properties.modelPolicy.oneOf ||
      settingsPatchSchema.properties.modelPolicy.anyOf;
    const automaticPolicySchema = policyVariants.find(
      (variant: any) => variant.properties.mode.const === "automatic"
    );
    expect(automaticPolicySchema.required).toEqual(expect.arrayContaining([
      "mode",
      "fallbackSelection",
      "allowedSelections",
      "constraints"
    ]));
    expect(settingsPatchSchema.properties.projectOperations.items.oneOf.map(
      (variant: any) => variant.properties.kind.const
    )).toEqual(["add", "rename", "relocate", "archive", "restore", "delete"]);
    expect(settingsPatchSchema.properties).not.toHaveProperty("defaultProjectId");
    expect(updateSettingsSchema.properties).not.toHaveProperty("projects");
    expect(updateSettingsSchema.properties).not.toHaveProperty("defaultCwd");
    expect(updateSettingsSchema.properties).not.toHaveProperty("reset");
    expect(updateSettingsSchema.properties).not.toHaveProperty("activityCardView");
    expect(JSON.stringify(byName.get("codex_update_settings")?.inputSchema)).not.toContain('"all"');
    expect(byName.get("codex_update_settings")?.inputSchema.properties)
      .not.toHaveProperty("defaultSessionMode");
    expect(byName.get("codex_update_settings")?.inputSchema.properties)
      .not.toHaveProperty("autoResumeTtlMs");

    const discoveryInventory = tools.tools.map((tool) => {
      const meta = (tool._meta || {}) as Record<string, any>;
      const declaredVisibility = Array.isArray(meta.ui?.visibility)
        ? meta.ui.visibility as string[]
        : undefined;
      const properties = Object.keys(tool.inputSchema.properties || {}).sort();
      return {
        name: tool.name,
        visibility: {
          model: declaredVisibility
            ? declaredVisibility.includes("model")
            : meta["openai/visibility"] !== "private",
          app: declaredVisibility
            ? declaredVisibility.includes("app")
            : meta["openai/widgetAccessible"] === true,
          operatorCapability: tool.name === "codex_agent_recovery_detach"
        },
        propertyCount: properties.length,
        properties,
        schemaBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8"),
        annotations: {
          readOnly: tool.annotations?.readOnlyHint ?? null,
          destructive: tool.annotations?.destructiveHint ?? null,
          idempotent: tool.annotations?.idempotentHint ?? null,
          openWorld: tool.annotations?.openWorldHint ?? null
        }
      };
    });
    const taskDescriptor = byName.get("codex_task")!;
    const taskContractBytes = Buffer.byteLength(
      JSON.stringify(taskDescriptor.inputSchema),
      "utf8"
    ) + Buffer.byteLength(JSON.stringify(taskDescriptor.outputSchema), "utf8");
    const taskOutputBytes = Buffer.byteLength(
      JSON.stringify(taskDescriptor.outputSchema),
      "utf8"
    );
    expect(taskContractBytes).toBeLessThanOrEqual(9_500);
    expect(taskOutputBytes).toBeLessThanOrEqual(2_500);
    expect(discoveryInventory).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_dashboard",
          "properties": [],
          "propertyCount": 0,
          "schemaBytes": 114,
          "visibility": {
            "app": true,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_dashboard_snapshot",
          "properties": [
            "conversationOffset",
            "idleOffset",
            "limit",
            "projectOffset",
            "scopeId",
            "terminalOffset",
            "widgetInstanceId",
          ],
          "propertyCount": 7,
          "schemaBytes": 815,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_status",
          "properties": [
            "query",
          ],
          "propertyCount": 1,
          "schemaBytes": 1992,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_diagnostics",
          "properties": [],
          "propertyCount": 0,
          "schemaBytes": 114,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_activity",
          "properties": [
            "activityId",
            "mode",
            "presentationId",
          ],
          "propertyCount": 3,
          "schemaBytes": 831,
          "visibility": {
            "app": true,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_activity_rehydrate",
          "properties": [
            "jobId",
            "limit",
            "requestId",
            "scopeId",
            "widgetInstanceId",
          ],
          "propertyCount": 5,
          "schemaBytes": 930,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": true,
          },
          "name": "codex_activity_snapshot",
          "properties": [
            "afterVersion",
            "card",
            "cursor",
            "limit",
            "scopeId",
            "waitMs",
            "widgetInstanceId",
          ],
          "propertyCount": 7,
          "schemaBytes": 1584,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_activity_handoff",
          "properties": [
            "action",
            "card",
            "outboxIds",
            "widgetInstanceId",
          ],
          "propertyCount": 4,
          "schemaBytes": 1340,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_agent",
          "properties": [
            "agentId",
            "operation",
            "requestId",
          ],
          "propertyCount": 3,
          "schemaBytes": 1137,
          "visibility": {
            "app": true,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_agent_recovery_detach",
          "properties": [
            "activityId",
            "agentId",
            "expectedAgentVersion",
            "requestId",
            "scopeId",
          ],
          "propertyCount": 5,
          "schemaBytes": 1066,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": true,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_background_process_terminate",
          "properties": [
            "agentId",
            "card",
            "expectedAgentVersion",
            "processId",
            "requestId",
            "scopeId",
            "widgetInstanceId",
          ],
          "propertyCount": 7,
          "schemaBytes": 2001,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_cancel",
          "properties": [
            "acknowledgeAffectedJobIds",
            "expectedVersion",
            "jobId",
            "reason",
            "requestId",
          ],
          "propertyCount": 5,
          "schemaBytes": 1083,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_activity_job_cancel",
          "properties": [
            "acknowledgeAffectedJobIds",
            "card",
            "expectedJobVersion",
            "jobId",
            "requestId",
            "scopeId",
            "widgetInstanceId",
          ],
          "propertyCount": 7,
          "schemaBytes": 1820,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_interaction_respond",
          "properties": [
            "card",
            "expectedJobVersion",
            "interactionId",
            "jobId",
            "requestId",
            "response",
            "scopeId",
            "widgetInstanceId",
          ],
          "propertyCount": 8,
          "schemaBytes": 2272,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_steer",
          "properties": [
            "expectedJobVersion",
            "jobId",
            "prompt",
            "requestId",
          ],
          "propertyCount": 4,
          "schemaBytes": 792,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_job_steer",
          "properties": [
            "card",
            "expectedJobVersion",
            "jobId",
            "prompt",
            "requestId",
            "scopeId",
            "widgetInstanceId",
          ],
          "propertyCount": 7,
          "schemaBytes": 1771,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": false,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_activity_update",
          "properties": [
            "activityId",
            "expectedVersion",
            "operation",
          ],
          "propertyCount": 3,
          "schemaBytes": 2476,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": true,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_activity_cancel",
          "properties": [
            "acknowledgeAffectedJobIds",
            "activityId",
            "expectedVersion",
            "reason",
            "requestId",
          ],
          "propertyCount": 5,
          "schemaBytes": 1158,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": true,
            "readOnly": true,
          },
          "name": "codex_models",
          "properties": [
            "refresh",
          ],
          "propertyCount": 1,
          "schemaBytes": 244,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": true,
            "readOnly": true,
          },
          "name": "codex_settings",
          "properties": [
            "refreshModels",
          ],
          "propertyCount": 1,
          "schemaBytes": 232,
          "visibility": {
            "app": true,
            "model": true,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": true,
            "openWorld": true,
            "readOnly": true,
          },
          "name": "codex_settings_snapshot",
          "properties": [
            "refreshModels",
          ],
          "propertyCount": 1,
          "schemaBytes": 233,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": true,
            "idempotent": false,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_update_settings",
          "properties": [
            "expectedRegistryRevision",
            "expectedSettingsRevision",
            "operation",
          ],
          "propertyCount": 3,
          "schemaBytes": 5089,
          "visibility": {
            "app": true,
            "model": false,
            "operatorCapability": false,
          },
        },
        {
          "annotations": {
            "destructive": false,
            "idempotent": false,
            "openWorld": false,
            "readOnly": false,
          },
          "name": "codex_task",
          "properties": [
            "activity",
            "agent",
            "executionEnvelopeRef",
            "executionMode",
            "project",
            "projectLookup",
            "prompt",
            "requestId",
            "sandbox",
            "selection",
            "taskContractVersion",
          ],
          "propertyCount": 11,
          "schemaBytes": 5475,
          "visibility": {
            "app": false,
            "model": true,
            "operatorCapability": false,
          },
        },
      ]
    `);

    await close();
  });

  it("rejects unknown root inputs and oversized interaction answer maps", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const card = {
      activityId: SCOPE_A,
      generation: ACTIVITY_CARD_CONTRACT_GENERATION,
      presentation: { kind: "explicit" }
    };
    const unknownRootCalls = [
      { name: "codex_models", arguments: { unexpectedTypo: true } },
      { name: "codex_settings", arguments: { unexpectedTypo: true } },
      {
        name: "codex_agent_recovery_detach",
        arguments: {
          requestId: "10101010-1010-4010-8010-101010101010",
          agentId: "11111111-1010-4010-8010-101010101010",
          activityId: "12121212-1010-4010-8010-101010101010",
          expectedAgentVersion: 1,
          unexpectedTypo: true
        }
      },
      {
        name: "codex_background_process_terminate",
        arguments: {
          requestId: "13131313-1010-4010-8010-101010101010",
          agentId: "14141414-1010-4010-8010-101010101010",
          expectedAgentVersion: 1,
          processId: "background-process",
          card,
          unexpectedTypo: true
        }
      }
    ];
    for (const request of unknownRootCalls) {
      const result = await client.callTool(request);
      expect(result.isError, request.name).toBe(true);
      expect(JSON.stringify(result), request.name).toContain("unexpectedTypo");
    }

    const oversizedAnswers = Object.fromEntries(
      Array.from(
        { length: MAX_CODEX_INTERACTION_QUESTIONS + 1 },
        (_, index) => [`question-${index + 1}`, ["answer"]]
      )
    );
    const oversized = await client.callTool({
      name: "codex_interaction_respond",
      arguments: {
        requestId: "15151515-1010-4010-8010-101010101010",
        jobId: "job-input-bound",
        expectedJobVersion: 1,
        interactionId: "interaction-input-bound",
        response: { answers: oversizedAnswers },
        card
      }
    });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized)).toContain(
      `At most ${MAX_CODEX_INTERACTION_QUESTIONS} interaction questions`
    );
    await close();
  });

  it("rejects expired runtime fields and malformed retired presentation inputs at parsing", async () => {
    const root = temporaryRoot();
    const { rawCallTool, jobs, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const missing = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "24242424-0000-4000-8000-000000000001",
        prompt: "stale descriptor call",
        activityTitle: "Stale descriptor",
        activityKind: "investigation",
        agentName: "Stale Descriptor Agent",
        agentRole: "investigation",
        contextMode: "fresh"
      }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("Unrecognized keys");
    expect(JSON.stringify(missing)).toContain("activityTitle");
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);

    const invalid = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "24242424-0000-4000-8000-000000000002",
        activityPresentationId: "not-a-uuid",
        prompt: "invalid presentation UUID"
      }
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain("activityPresentationId");
    expect(JSON.stringify(invalid)).toContain("Expected a UUID-formatted");

    const presentationFreeTask = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "24242424-0000-4000-8000-000000000003",
        prompt: "current execution-only contract without presentation correlation",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new" },
        agent: { mode: "new" }
      }
    });
    expect(presentationFreeTask.isError).not.toBe(true);
    expect((presentationFreeTask as { structuredContent?: Record<string, unknown> }).structuredContent)
      .toMatchObject({ kind: "task", state: "running" });
    expect((presentationFreeTask as { _meta?: Record<string, unknown> })._meta)
      .toBeUndefined();

    for (const retired of [
      {
        name: "codex_status",
        arguments: { scopeId: SCOPE_A, jobId: "retired-job" },
        field: "jobId"
      },
      {
        name: "codex_activity",
        arguments: { scopeId: SCOPE_A, forceNewCard: true },
        field: "forceNewCard"
      },
      {
        name: "codex_activity_handoff",
        arguments: {
          scopeId: SCOPE_A,
          action: "claim",
          outboxId: 1,
          presentationKind: "automatic",
          activityPresentationId: SCOPE_B
        },
        field: "outboxId"
      },
      {
        name: "codex_agent",
        arguments: { requestId: SCOPE_B, agentId: SCOPE_A, action: "archive" },
        field: "action"
      },
      {
        name: "codex_activity_update",
        arguments: { activityId: SCOPE_A, action: "seal" },
        field: "action"
      },
      {
        name: "codex_update_settings",
        arguments: { expectedRevision: 0, reset: true },
        field: "reset"
      }
    ]) {
      const result = await rawCallTool({ name: retired.name, arguments: retired.arguments });
      expect(result.isError, retired.name).toBe(true);
      expect(JSON.stringify(result), retired.name).toContain(retired.field);
    }
    await close();
  });

  it("applies neutral creation defaults and preserves explicit nested routing across follow-ups", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "1",
        CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS: "1"
      }),
      upstream
    );

    const defaulted = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "10101010-1010-4010-8010-101010101010",
        activityPresentationId: "10101010-1010-4010-8010-101010101010",
        prompt: "review the design",
        project: { name: "Test Project", registryRevision: 1 },
        executionMode: "foreground"
      }
    });
    const defaultActivityId = taskActivityId(defaulted);
    const defaultAgentId = parseToolJson(defaulted).agentId as string;
    expect(jobs.getActivity(defaultActivityId)).toMatchObject({
      title: "Codex activity",
      kind: "other",
      executionMode: "foreground",
      handoffPolicy: "none",
      completionTrigger: "manual"
    });
    expect(jobs.getAgent(defaultAgentId)).toMatchObject({
      agentName: "Codex Agent 10101010-1010-4010-8010-101010101010"
    });
    expect(jobs.listActivityAgentAssignments(defaultActivityId, defaultAgentId)).toEqual([
      expect.objectContaining({ role: "primary", contextMode: "fresh" })
    ]);

    const named = await runTask(client, {
      prompt: "review the design",
      activity: {
        mode: "new",
        title: "Design review",
        policy: { kind: "review", handoff: "verify", completion: "manual" }
      },
      agent: { mode: "new", name: "민아" }
    });
    const agentId = parseToolJson(named).agentId as string;
    expect(jobs.getAgent(agentId)).toMatchObject({ agentName: "민아" });
    expect(jobs.getActivity(taskActivityId(named))).toMatchObject({
      title: "Design review",
      kind: "review",
      handoffPolicy: "verify",
      completionTrigger: "manual"
    });
    expect(jobs.listActivityAgentAssignments(undefined, agentId)).toEqual([
      expect.objectContaining({ role: "primary" })
    ]);

    await runTask(client, {
      prompt: "continue the review",
      activity: { mode: "existing", id: taskActivityId(named) },
      agent: { mode: "existing", id: agentId }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ agentName: "민아" });
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(2);

    const defaultedSecondAgent = await runTask(client, {
      prompt: "independent review",
      activity: { mode: "existing", id: taskActivityId(named) },
      agent: { mode: "new" }
    });
    const secondAgentId = parseToolJson(defaultedSecondAgent).agentId as string;
    expect(jobs.getAgent(secondAgentId)?.agentName)
      .toMatch(/^Codex Agent [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(3);
    await close();
  });

  it("rejects mixed task routing contracts and ignores retired host card correlation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    const mixed = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "40404040-4040-4040-8040-404040404040",
        activityPresentationId: "40404040-4040-4040-8040-404040404040",
        prompt: "mixed routing must fail",
        activity: { mode: "new" },
        activityTitle: "Legacy title"
      }
    });
    expect(mixed.isError).toBe(true);
    expect(JSON.stringify(mixed)).toContain("Unrecognized key");
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);

    const invalidNewAgentContext = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "41414141-4141-4141-8141-414141414141",
        activityPresentationId: "41414141-4141-4141-8141-414141414141",
        prompt: "new Agent cannot fork",
        activity: { mode: "new" },
        agent: { mode: "new", context: "fork" }
      }
    });
    expect(invalidNewAgentContext.isError).toBe(true);
    expect(upstream.calls).toEqual([]);

    const hostPresentationId = "42424242-4242-4242-8242-424242424242";
    const hostCorrelated = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "43434343-4343-4343-8343-434343434343",
        prompt: "use host presentation correlation",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new" },
        agent: { mode: "new" },
        executionMode: "foreground"
      },
      _meta: { "codex/activityPresentationId": hostPresentationId }
    });
    const hostCorrelatedTask = (hostCorrelated as {
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    });
    expect(hostCorrelatedTask.structuredContent).toMatchObject({ kind: "task", state: "completed" });
    expect(hostCorrelatedTask._meta).toBeUndefined();
    expect(jobs.get(String(hostCorrelatedTask.structuredContent?.jobId))?.activityPresentationId)
      .toBeUndefined();
    await close();
  });

  it("serves the self-contained MCP Apps settings card resource", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const resource = await client.readResource({ uri: SETTINGS_CARD_URI });
    const contents = resource.contents[0] as {
      mimeType?: string;
      text?: string;
      _meta?: Record<string, any>;
    };
    expect(contents.mimeType).toBe("text/html;profile=mcp-app");
    expect(contents.text).toContain("Codex Bridge 설정");
    expect(contents.text).toContain("window.openai.callTool");
    expect(contents.text).toContain("codex_update_settings");
    expect(contents.text).toContain('callTool("codex_settings_snapshot"');
    expect(contents.text).not.toContain('callTool("codex_settings",');
    expect(contents.text).not.toContain('message.method==="ui/notifications/tool-result"');
    expect(contents.text).toContain('id="settings-form" hidden');
    expect(contents.text).toContain('id="settings-loading"');
    expect(contents.text).not.toContain("localStorage");
    expect(contents.text).toContain('id="ui-language"');
    expect(contents.text).toContain('ko:"한국어"');
    expect(contents.text).not.toContain('id="resume-hours"');
    expect(contents.text).not.toContain('id="timeout-minutes"');
    expect(contents.text).toContain('id="concurrency" type="number" min="1" step="1" required');
    expect(contents.text).toContain("const REQUEST_TIMEOUT_MS = 90000;");
    expect(contents.text).toContain('rpcRequest("ui/initialize"');
    expect(contents.text).toContain('rpcNotification("ui/notifications/initialized"');
    expect(contents.text).toContain("ui/notifications/host-context-changed");
    expect(contents.text).toContain("uiBridgeErrorMessage(message.error");
    expect(contents.text).not.toContain("new Error(message.error.message");
    expect(contents.text).toContain("result&&result.isError");
    expect(contents.text).toContain("function parsedToolText(result)");
    expect(contents.text).toContain("if(text&&!parsed)throw new Error(text)");
    expect(contents.text).toContain("!elements.form.reportValidity()");
    expect(contents.text).toContain("Number.isSafeInteger(value)");
    expect(contents.text).toContain("if(modelPolicyDirty)settings.modelPolicy=buildModelPolicy()");
    expect(contents.text).toContain("settings.legacyPreferredModel");
    expect(contents.text).toContain('id="allowed-models"');
    expect(contents.text).toContain('id="effort-groups"');
    expect(contents.text).toContain('id="use-priority-service-tier" type="checkbox"');
    expect(contents.text).toContain('id="project-list"');
    expect(contents.text).toContain('id="add-project" type="button"');
    expect(contents.text).not.toContain('id="default-project"');
    expect(contents.text).not.toContain('id="allowed-roots"');
    expect(contents.text).not.toContain('id="allowed-root-list"');
    expect(contents.text).toContain('data-i18n="settings.resetHint"');
    expect(contents.text).toContain('t["settings.addFirstProject"]');
    expect(contents.text).not.toContain('id="default-cwd"');
    expect(contents.text).not.toContain('className="project-id-input"');
    expect(contents.text).not.toContain('projectField("settings.projectId"');
    expect(contents.text).not.toContain("allocateProjectId");
    expect(contents.text).toContain('operations.push({kind:"add",project:{name:project.name,cwd:project.cwd}})');
    expect(contents.text).toContain('operations.push({kind:"delete",projectId:project.id})');
    expect(contents.text).not.toContain('confirm(t["settings.deleteProjectConfirm"])');
    expect(contents.text).toContain('className="project-delete-confirm"');
    expect(contents.text).toContain('className="project-pending-message"');
    expect(contents.text).toContain('row.dataset.confirmDelete="true"');
    expect(contents.text).toContain('classList.toggle("project-changes-pending",count>0)');
    expect(contents.text).toContain('t["settings.removeProject"]');
    expect(contents.text).toContain("projectOperations=buildProjectOperations(projectSettings.projects)");
    expect(contents.text).not.toContain("defaultProjectId");
    expect(contents.text).toContain('operation:{kind:"patch",settings}');
    expect(contents.text).toContain('operation:{kind:"reset"}');
    expect(contents.text).toContain("expectedSettingsRevision:view.settings.settingsRevision");
    expect(contents.text).toContain("expectedRegistryRevision:view.settings.registryRevision");
    expect(contents.text).not.toContain('id="policy-service-tier"');
    expect(contents.text).toContain('all.dataset.action="all-efforts"');
    expect(contents.text).toContain('id="retry-models"');
    expect(contents.text).not.toContain('id="refresh"');
    expect(contents.text).toContain('aria-describedby="access-hint full-warning"');
    expect(contents.text).not.toContain("view.settings.defaultReasoningEffort = null");
    expect(contents._meta).toMatchObject({
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        domain: "https://web-sandbox.oaiusercontent.com"
      },
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com",
      "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
    });

    await close();
  });

  it("serves every retained Settings, Activity, and Dashboard UI revision through MCP", async () => {
    const root = temporaryRoot();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream()
    );
    const listed = await client.listResources();
    const listedUris = new Set(listed.resources.map((resource) => resource.uri));

    for (const [name, currentUri] of [
      ["settings", SETTINGS_CARD_URI],
      ["activity", ACTIVITY_CARD_URI],
      ["dashboard", DASHBOARD_CARD_URI]
    ] as const) {
      const revisions = uiResourceRevisions(name);
      expect(revisions.length).toBeGreaterThanOrEqual(1);
      expect(new Set(revisions.map((revision) => revision.uri)).size).toBe(revisions.length);
      expect(revisions.every((revision) =>
        revision.uri.startsWith(`ui://codex-mcp-bridge/${name}/`)
      )).toBe(true);
      expect(revisions.length).toBeGreaterThan(1);
      expect(revisions[0].uri).toBe(currentUri);
      for (const revision of revisions) {
        expect(listedUris).toContain(revision.uri);
        const resource = await client.readResource({ uri: revision.uri });
        expect(resource.contents[0]).toMatchObject({
          uri: revision.uri,
          mimeType: "text/html;profile=mcp-app"
        });
        const html = (resource.contents[0] as { text?: string }).text || "";
        expect(html).toContain("<!doctype html>");
        expect(html).not.toContain("Plugin refresh required");
        if (name === "settings") {
          expect(html).not.toContain('id="default-project"');
          expect(html).not.toContain("defaultProjectId");
          if (revision.uri === currentUri) {
            expect(html).toContain('callTool("codex_settings_snapshot"');
            expect(html).not.toContain('callTool("codex_settings",');
            expect(html).not.toContain('message.method==="ui/notifications/tool-result"');
          }
        }
        if (name === "activity") {
          expect(html).toContain('callTool("codex_activity_snapshot"');
          expect(html).toContain("afterVersion");
          expect(html).toContain("waitMs");
          expect(html).toContain("consumeToolOutput");
          if (revision.uri === currentUri) {
            expect(html).toContain('id="weekly-usage"');
            expect(html).toContain('data-i18n="usage.weeklyRemaining"');
            expect(html).toContain("renderWeeklyUsage(next.weeklyUsage)");
            expect(html).toContain("function appendCancellations(parent,row)");
            expect(html).toContain('node("details","cancellation")');
            expect(html).toContain('callTool("codex_activity_rehydrate"');
            expect(html).toContain('mountedPresentation.kind==="historical"');
            expect(html).toContain('callTool("codex_background_process_terminate"');
            expect(html).toContain('callTool("codex_activity_job_cancel"');
            expect(html).not.toContain('callTool("codex_cancel"');
            expect(html).not.toContain('callTool("codex_agent"');
            expect(html).toContain('callTool("codex_interaction_respond"');
          }
          expect(html).not.toContain('callTool("codex_status",Object.assign({activityView:true');
        } else if (name === "dashboard") {
          expect(html).toContain('callTool("codex_dashboard_snapshot"');
          expect(html).toContain('window.addEventListener("pageshow"');
          if (revision.uri === currentUri) {
            expect(html).toContain('id="weekly-usage"');
            expect(html).toContain('data-i18n="usage.weeklyRemaining"');
            expect(html).toContain("renderWeeklyUsage(next.weeklyUsage)");
            expect(html).toContain("function appendCancellation(parent,cancellation,key)");
            expect(html).toContain('node("details","cancellation")');
            expect(html).toContain("function executionText(execution)");
            expect(html).toContain("function appendExecution(parent,execution,next=false)");
            expect(html).toContain("function renderActivityRows(parent,rows)");
            expect(html).toContain('node("details","history")');
            expect(html).toContain("new Intl.RelativeTimeFormat");
            expect(html).toContain("function normalizeHostToolResult");
            expect(html).toContain("function hostToolResultMetadata");
            expect(html).toContain("function callUiToolWithFallback");
            expect(html).toContain("function standardToolCall(name,args)");
            expect(html).toContain("standardBridgeReady=beginStandardBridge()");
            expect(html).toContain("compatibilityTimeoutMs:TOOL_CALL_TIMEOUT_MS");
            expect(html).toContain("mcp_tool_result");
            expect(html).toContain('id="dashboard-content" hidden');
            expect(html).toContain('data-i18n="common.loading"');
            expect(html).toContain("function createWidgetInstanceId");
            expect(html).not.toContain("function consumeHostResult(");
            expect(html).not.toContain('message.method==="ui/notifications/tool-result"');
            expect(html).not.toContain('id="view-project"');
            expect(html).not.toContain('id="view-conversation"');
            expect(html).not.toContain('id="view-status"');
            expect(html).toContain('id="status-idle-toggle"');
            expect(html).toContain('aria-expanded="false"');
            expect(html).toContain('id="status-idle-panel" hidden');
            expect(html).toContain("statusIdleExpanded=false");
            expect(html).toContain('id="terminal-more"');
            expect(html).toContain('id="idle-more"');
            expect(html).toContain('data-i18n="dashboard.loadMore"');
            expect(html).toContain("async function loadMore(bucket)");
            expect(html).toContain("function mergeRows(current,incoming)");
            expect(html).toContain("function syncDisclosure()");
            expect(html).not.toContain("dashboardViewMode");
            expect(html).not.toContain("api.setWidgetState");
            expect(html).toContain("function dispatchDashboardExternalUrl(");
            expect(html).toContain(
              "dispatchDashboardExternalUrl(event,url,window.openai,openConversationFallback)"
            );
            expect(html).toContain("safeCodexThreadUrl(row.codexThreadUrl)");
            expect((resource.contents[0] as { _meta?: Record<string, unknown> })._meta)
              .toMatchObject({
                "openai/widgetCSP": {
                  redirect_domains: ["https://chatgpt.com", "codex://threads"]
                }
              });
          }
          expect(html).not.toContain('callTool("codex_cancel"');
          expect(html).not.toContain('callTool("codex_steer"');
          expect(html).not.toContain('callTool("codex_activity_handoff"');
          expect(html).not.toContain("localStorage");
        } else if (name === "settings" && revision.uri === currentUri) {
          expect(html).toContain('operation:{kind:"patch",settings}');
          expect(html).toContain('operation:{kind:"reset"}');
          expect(html).not.toContain("projects:projectSettings.projects");
          expect(html).not.toContain("reset:true");
        }
        expect((resource.contents[0] as { _meta?: Record<string, unknown> })._meta)
          .toMatchObject({
            "codex/uiContractGeneration": revision.contractGeneration ||
              (name === "activity"
                ? ACTIVITY_CARD_CONTRACT_GENERATION
                : name === "dashboard"
                  ? DASHBOARD_CARD_CONTRACT_GENERATION
                  : SETTINGS_CARD_CONTRACT_GENERATION)
          });
      }
    }

    const task = parseToolJson(await runTask(client, {
      prompt: "exercise every retained Activity snapshot client"
    }));
    const explicit = parseToolJson(await rawCallTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A, activityId: task.activityId }
    }));
    const card = {
      activityId: task.activityId,
      generation: explicit.mountedActivity.cardGeneration,
      presentation: { kind: "explicit" as const }
    };
    for (const [index, revision] of uiResourceRevisions("activity").entries()) {
      const widgetInstanceId = `retained-activity-${index}`;
      const initial = await rawCallTool({
        name: "codex_activity_snapshot",
        arguments: { scopeId: SCOPE_A, card, limit: 30 },
        _meta: { "openai/widgetSessionId": widgetInstanceId }
      });
      const initialView = parseToolJson(initial);
      expect(initialView).toMatchObject({
        mountedActivity: { activityId: task.activityId },
        mountedPresentation: { kind: "explicit" }
      });
      expect(validateActivityViewPrivateMetadata(
        (initial as { _meta?: Record<string, unknown> })._meta?.[ACTIVITY_VIEW_METADATA_KEY]
      )).toMatchObject({ source: "codex_activity_snapshot" });
      const refreshed = parseToolJson(await rawCallTool({
        name: "codex_activity_snapshot",
        arguments: {
          scopeId: SCOPE_A,
          card,
          limit: 30,
          afterVersion: initialView.scopeVersion,
          waitMs: 1
        },
        _meta: { "openai/widgetSessionId": widgetInstanceId }
      }));
      expect(refreshed.wait).toMatchObject({ timedOut: true, changed: false });
      expect(revision.uri).toMatch(/^ui:\/\/codex-mcp-bridge\/activity\//);
      jobs.releaseActivityCardLease(
        SCOPE_A,
        card.activityId,
        card.generation,
        widgetInstanceId,
        card.presentation
      );
    }

    await close();
  });

  it("hydrates account-wide weekly Codex usage only into Dashboard and Activity cards", async () => {
    const root = temporaryRoot();
    const upstream = new WeeklyUsageUpstream();
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);

    const dashboardResult = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    const dashboardPublic = (dashboardResult as { structuredContent?: Record<string, unknown> })
      .structuredContent!;
    expect(dashboardPublic).not.toHaveProperty("weeklyUsage");
    expect((dashboardResult as { _meta?: Record<string, unknown> })._meta)
      .not.toHaveProperty(DASHBOARD_VIEW_METADATA_KEY);
    expect(upstream.usageReads).toBe(0);

    const { view: dashboardView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(dashboardView.weeklyUsage).toEqual({
      source: "codex-account-rate-limits",
      limitId: "codex",
      usedPercent: 35.5,
      remainingPercent: 64.5,
      windowDurationMins: 10_080,
      resetsAt: new Date(1_900_604_800_000).toISOString(),
      observedAt: new Date(1_900_000_000_000).toISOString()
    });

    const activityResult = await rawCallTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A, mode: "full-history" }
    });
    const activityPublic = (activityResult as { structuredContent?: Record<string, unknown> })
      .structuredContent!;
    const activityPrivate = validateActivityViewPrivateMetadata(
      (activityResult as { _meta?: Record<string, unknown> })
        ._meta?.[ACTIVITY_VIEW_METADATA_KEY]
    );
    expect(activityPublic).not.toHaveProperty("weeklyUsage");
    expect(activityPrivate.view.weeklyUsage).toEqual(dashboardView.weeklyUsage);
    expect(upstream.usageReads).toBe(2);

    await close();
  });

  it("shows every bridge-tracked conversation through a read-only Codex-runtime-only Dashboard", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const completed = parseToolJson(await runTask(client, {
      prompt: "private completed payload must not enter the dashboard",
      activityTitle: "Scope A completed turn",
      handoffPolicy: "verify",
      executionMode: "background",
      selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
    }));
    upstream.resolveNext(fakeCodexResult("scope-a-private-thread"));
    await waitForJobStatus(client, completed.jobId, "completed");

    const project = settings.current.projects[0]!;
    const running = parseToolJson(await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "44444444-4444-4444-8444-444444444444",
        activityPresentationId: "55555555-5555-4555-8555-555555555555",
        prompt: "private running payload must not enter the dashboard",
        project: { name: project.name, registryRevision: settings.current.registryRevision },
        activity: { mode: "new", title: "Scope B running turn" },
        agent: { mode: "new", name: "Scope B Agent" },
        executionMode: "background",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    }));

    upstream.progressNext({
      progress: 1,
      message: "model rerouted",
      event: {
        eventId: "reroute:dashboard-running",
        type: "model",
        phase: "updated",
        createdAt: Date.now(),
        summary: "Model rerouted.",
        details: {
          kind: "rerouted",
          fromModel: "gpt-5.6-sol",
          toModel: "gpt-5.6-terra",
          reason: "fixture-policy"
        }
      }
    });

    const opened = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    expect((opened as { structuredContent?: unknown }).structuredContent).toMatchObject({
      kind: "dashboard",
      scope: "bridge-wide",
      readOnly: true,
      statusSource: "codex-runtime-only",
      summary: expect.stringMatching(
        /^2 tracked retained conversations; 1 active; 1 running; 0 needing attention;/
      )
    });
    expect((opened as { _meta?: Record<string, unknown> })._meta)
      .not.toHaveProperty(DASHBOARD_VIEW_METADATA_KEY);
    const { view } = await freshDashboardSnapshot(rawCallTool, { scopeId: SCOPE_A });
    expect(view).toMatchObject({
      kind: "dashboard",
      scope: "bridge-wide",
      statusSource: "codex-runtime-only",
      coverage: "bridge-known-retained",
      counts: {
        trackedProjects: 1,
        trackedConversations: 2,
        retainedJobs: 2,
        active: 1,
        running: 1,
        completed: 1
      }
    });
    expect(view.activeRows).toEqual([
      expect.objectContaining({
        activityTitle: "Scope B running turn",
        agentName: "Scope B Agent",
        projectName: project.name,
        status: "running",
        execution: {
          model: "gpt-5.6-sol",
          modelDisplayName: "GPT-5.6 Sol",
          reasoningEffort: "max",
          reroutedModel: "gpt-5.6-terra",
          reroutedModelDisplayName: "GPT-5.6 Terra",
          isCurrent: true
        }
      })
    ]);
    expect(view.terminalRows).toEqual([
      expect.objectContaining({
        activityTitle: "Scope A completed turn",
        agentName: "Codex Agent",
        projectName: project.name,
        status: "completed",
        execution: {
          model: "gpt-5.6-terra",
          modelDisplayName: "GPT-5.6 Terra",
          reasoningEffort: "high",
          isCurrent: false
        }
      })
    ]);
    expect(view).not.toHaveProperty("projects");
    expect(view).not.toHaveProperty("conversations");
    expect(view.pagination).not.toHaveProperty("projects");
    expect(view.pagination).not.toHaveProperty("conversations");
    expect([...view.activeRows, ...view.terminalRows].every((row) =>
      /^[0-9a-f]{32}$/.test(row.rowKey) &&
      /^[0-9a-f]{32}$/.test(row.activityKey) &&
      /^[0-9a-f]{32}$/.test(row.projectKey)
    )).toBe(true);
    expect(JSON.stringify((opened as { structuredContent?: unknown }).structuredContent))
      .not.toContain("gpt-5.6");
    const aliases = new Set(
      [...view.activeRows, ...view.terminalRows].map((row) => row.sessionAlias)
    );
    expect(aliases.size).toBe(2);
    expect([...aliases].every((alias) => /^Session [0-9A-F]{8}$/.test(alias))).toBe(true);

    const serialized = JSON.stringify(view);
    for (const privateValue of [
      SCOPE_A,
      SCOPE_B,
      completed.jobId,
      running.jobId,
      root,
      "scope-a-private-thread",
      "private completed payload",
      "private running payload"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    for (const excludedState of [
      '"lifecycle"',
      '"waitingOn"',
      '"verification"',
      '"handoff"',
      '"scopeId"',
      '"threadId"',
      '"jobId"',
      '"activityId"',
      '"agentId"',
      '"projectId"'
    ]) {
      expect(serialized).not.toContain(excludedState);
    }

    jobs.startActivityVerification(completed.activityId);
    const { view: afterView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_B
    });
    expect(afterView.terminalRows.find((row) =>
      row.activityTitle === "Scope A completed turn"
    )?.status).toBe("completed");

    const unmounted = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: { limit: 20 }
    });
    expect(unmounted.isError).toBe(true);
    expect(JSON.stringify(unmounted)).toContain("MOUNTED_WIDGET_REQUIRED");

    const refreshed = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        widgetInstanceId: "33333333-3333-4333-8333-333333333333",
        limit: 20
      }
    });
    const refreshedView = (refreshed as { structuredContent?: any }).structuredContent;
    expect(refreshedView).toMatchObject({
      kind: "dashboard",
      statusSource: "codex-runtime-only",
      counts: { trackedConversations: 2 }
    });
    expect(validateDashboardViewPrivateMetadata(
      (refreshed as { _meta?: Record<string, unknown> })._meta?.[DASHBOARD_VIEW_METADATA_KEY]
    ).view).toEqual(refreshedView);
    expect(refreshedView).not.toHaveProperty("controls");
    expect(refreshedView).not.toHaveProperty("leases");
    expect(refreshedView).not.toHaveProperty("pendingHandoffs");
    expect(refreshedView).not.toHaveProperty("nextActions");

    const malformedHostScope = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        widgetInstanceId: "33333333-3333-4333-8333-333333333333",
        limit: 20
      },
      _meta: { "openai/session": "" }
    });
    expect(malformedHostScope.isError).toBe(true);
    expect(JSON.stringify(malformedHostScope)).toContain("non-empty bounded string");

    upstream.resolveNext(fakeCodexResult("scope-b-private-thread"));
    await vi.waitFor(() => expect(jobs.get(running.jobId)?.status).toBe("completed"));
    const { view: afterCompletionView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(afterCompletionView.terminalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentName: "Scope B Agent",
        status: "completed",
        execution: expect.objectContaining({
          model: "gpt-5.6-sol",
          reasoningEffort: "max",
          reroutedModel: "gpt-5.6-terra",
          isCurrent: false
        })
      })
    ]));
    expect(afterCompletionView.idleRows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentName: "Scope B Agent" })
    ]));
    await close();
  });

  it("links an active App Server Agent to its validated local Codex thread", async () => {
    const root = temporaryRoot();
    const threadId = "41414141-4141-4141-8141-414141414141";
    const sessionId = "42424242-4242-4242-8242-424242424242";
    const upstream = new CodexSessionDeferredUpstream(threadId, sessionId);
    const { client, rawCallTool, jobs, sessions, settings, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    settings.update(
      { showBridgeThreadsInCodexApp: true },
      settings.current.revision
    );
    const task = parseToolJson(await runTask(client, {
      prompt: "keep the Codex deep-link fixture active",
      executionMode: "background"
    }));
    await vi.waitFor(() => {
      expect(jobs.get(task.jobId)?.threadId).toBe(threadId);
      expect(sessions.get(threadId)?.sessionId).toBe(sessionId);
      expect(sessions.get(threadId)?.visibleInCodexApp).toBe(true);
    });

    const opened = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    const { view: activeView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(activeView.activeRows).toEqual([
      expect.objectContaining({
        status: "running",
        codexThreadUrl: `codex://threads/${threadId}`
      })
    ]);
    expect(JSON.stringify((opened as { structuredContent?: unknown }).structuredContent))
      .not.toContain(threadId);

    upstream.resolveNext({
      content: [{ type: "text", text: "done" }],
      structuredContent: {
        threadId,
        sessionId,
        backendKind: "app-server",
        content: "done"
      }
    });
    await vi.waitFor(() => expect(jobs.get(task.jobId)?.status).toBe("completed"));
    const { view: completedView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(completedView.terminalRows).toEqual([
      expect.objectContaining({ codexThreadUrl: `codex://threads/${threadId}` })
    ]);
    await close();
  });

  it("omits a Codex deep link for an App Server Agent created as hidden", async () => {
    const root = temporaryRoot();
    const threadId = "43434343-4343-4343-8343-434343434343";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const upstream = new CodexSessionDeferredUpstream(threadId, sessionId);
    const { client, rawCallTool, jobs, sessions, settings, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    expect(settings.current.showBridgeThreadsInCodexApp).toBe(false);
    const task = parseToolJson(await runTask(client, {
      prompt: "keep the hidden Codex thread fixture active",
      executionMode: "background"
    }));
    await vi.waitFor(() => {
      expect(jobs.get(task.jobId)?.threadId).toBe(threadId);
      expect(sessions.get(threadId)?.visibleInCodexApp).toBe(false);
    });

    const { view: activeView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(activeView.activeRows).toEqual([
      expect.not.objectContaining({ codexThreadUrl: expect.any(String) })
    ]);

    settings.update(
      { showBridgeThreadsInCodexApp: true },
      settings.current.revision
    );
    const { view: reopenedView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(reopenedView.activeRows).toEqual([
      expect.not.objectContaining({ codexThreadUrl: expect.any(String) })
    ]);

    const hiddenSession = sessions.get(threadId);
    expect(hiddenSession).toBeDefined();
    sessions.restoreInMemory(threadId);
    const { view: missingVisibilityProvenanceView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(missingVisibilityProvenanceView.activeRows).toEqual([
      expect.not.objectContaining({ codexThreadUrl: expect.any(String) })
    ]);
    sessions.restoreInMemory(threadId, hiddenSession);

    upstream.resolveNext({
      content: [{ type: "text", text: "done" }],
      structuredContent: { threadId, sessionId, backendKind: "app-server", content: "done" }
    });
    await vi.waitFor(() => expect(jobs.get(task.jobId)?.status).toBe("completed"));
    await close();
  });

  it("keeps GPT conversation and project context while grouping Agent rows by Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const conversationId = "12121212-1212-4212-8212-121212121212";
    const metadata = { "openai/session": conversationId };
    expect(settings.current.showBridgeThreadsInCodexApp).toBe(false);
    const project = settings.current.projects[0]!;
    const start = async (
      requestId: string,
      presentationId: string,
      name: string,
      activityId?: string
    ) =>
      parseToolJson(await rawCallTool({
        name: "codex_task",
        arguments: {
          requestId,
          activityPresentationId: presentationId,
          prompt: `keep ${name} active for conversation grouping`,
          project: { name: project.name, registryRevision: settings.current.registryRevision },
          activity: activityId
            ? { mode: "existing", id: activityId }
            : { mode: "new", title: `${name} activity` },
          agent: { mode: "new", name },
          executionMode: "background"
        },
        _meta: metadata
      }));
    const first = await start(
      "13131313-1313-4313-8313-131313131313",
      "14141414-1414-4414-8414-141414141414",
      "Conversation Agent One"
    );
    const second = await start(
      "15151515-1515-4515-8515-151515151515",
      "16161616-1616-4616-8616-161616161616",
      "Conversation Agent Two",
      first.activityId
    );
    const additional = [
      await start(
        "17171717-1717-4717-8717-171717171717",
        "18181818-1818-4818-8818-181818181818",
        "Conversation Agent Three"
      ),
      await start(
        "19191919-1919-4919-8919-191919191919",
        "20202020-2020-4020-8020-202020202020",
        "Conversation Agent Four"
      ),
      await start(
        "21212121-2121-4121-8121-212121212121",
        "22222222-2222-4222-8222-222222222222",
        "Conversation Agent Five"
      ),
      await start(
        "23232323-2323-4323-8323-232323232323",
        "24242424-2424-4424-8424-242424242424",
        "Conversation Agent Six"
      )
    ];
    const tasks = [first, second, ...additional];

    const opened = await rawCallTool({
      name: "codex_dashboard",
      arguments: {},
      _meta: metadata
    });
    const { view } = await freshDashboardSnapshot(rawCallTool, {
      metadata
    });
    expect(view.activeRows).toHaveLength(6);
    expect(new Set(view.activeRows.map((row) => row.sessionAlias)).size).toBe(1);
    expect(view.activeRows.map((row) => row.agentName)).toEqual(expect.arrayContaining([
      "Conversation Agent One",
      "Conversation Agent Two"
    ]));
    const sharedActivityRows = view.activeRows.filter((row) =>
      row.agentName === "Conversation Agent One" || row.agentName === "Conversation Agent Two"
    );
    expect(sharedActivityRows).toHaveLength(2);
    expect(new Set(sharedActivityRows.map((row) => row.activityKey)).size).toBe(1);
    expect(new Set(view.activeRows.map((row) => row.activityKey)).size).toBe(5);
    expect(view.activeRows.every((row) =>
      row.conversationUrl === `https://chatgpt.com/c/${conversationId}`
    )).toBe(true);
    expect(view.pagination.active).toMatchObject({
      total: 6,
      returned: 6,
      conversationTotal: 1,
      returnedConversations: 1
    });
    expect(view.activeRows.every((row) =>
      row.projectName === project.name && row.bucket === "active"
    )).toBe(true);
    expect(view).not.toHaveProperty("projects");
    expect(view).not.toHaveProperty("conversations");

    const snapshotResult = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        widgetInstanceId: "25252525-2525-4525-8525-252525252525",
        limit: 5
      },
      _meta: metadata
    });
    const snapshot = (snapshotResult as { structuredContent?: any }).structuredContent;
    expect(snapshot.activeRows).toHaveLength(6);
    expect(snapshot).not.toHaveProperty("projects");
    expect(snapshot).not.toHaveProperty("conversations");
    const legacySnapshotResult = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        widgetInstanceId: "25252525-2525-4525-8525-252525252525",
        limit: 5,
        projectOffset: 0,
        conversationOffset: 0
      },
      _meta: metadata
    });
    const legacySnapshot = (legacySnapshotResult as { structuredContent?: any }).structuredContent;
    expect(legacySnapshot.projects).toHaveLength(1);
    expect(legacySnapshot.conversations).toHaveLength(1);
    expect(legacySnapshot.pagination.projects.returnedAgents).toBe(5);
    expect(legacySnapshot.pagination.conversations.returnedAgents).toBe(5);
    expect(JSON.stringify((opened as { structuredContent?: unknown }).structuredContent))
      .not.toContain(conversationId);

    for (const [index] of tasks.entries()) {
      upstream.resolveNext(fakeCodexResult(`conversation-agent-${index + 1}`));
    }
    for (const task of tasks) {
      await vi.waitFor(() => expect(jobs.get(task.jobId)?.status).toBe("completed"));
    }
    let terminalOffset = 0;
    let foundCompleteSharedActivity = false;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const terminalPageResult = await rawCallTool({
        name: "codex_dashboard_snapshot",
        arguments: {
          widgetInstanceId: "25252525-2525-4525-8525-252525252526",
          limit: 5,
          terminalOffset
        },
        _meta: metadata
      });
      const terminalPage = (terminalPageResult as { structuredContent?: any }).structuredContent;
      const sharedRows = terminalPage.terminalRows.filter((row: { activityKey: string }) =>
        row.activityKey === sharedActivityRows[0].activityKey
      );
      if (sharedRows.length > 0) {
        expect(sharedRows).toHaveLength(2);
        foundCompleteSharedActivity = true;
      }
      if (!terminalPage.pagination.terminal.hasNext) break;
      terminalOffset = terminalPage.pagination.terminal.offset +
        terminalPage.pagination.terminal.returned;
    }
    expect(foundCompleteSharedActivity).toBe(true);
    await close();
  });

  it("shows project identity on rows sharing one GPT conversation", async () => {
    const root = temporaryRoot();
    const secondRoot = path.join(root, "second-project");
    mkdirSync(secondRoot);
    const upstream = new DeferredUpstream();
    const { rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const firstProject = settings.current.projects[0]!;
    const added = await rawCallTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: settings.current.registryRevision,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "Second Project", cwd: secondRoot } }
            ]
          }
        }
      }
    });
    expect(added.isError).not.toBe(true);
    const secondProject = settings.current.projects.find(
      (project) => project.name === "Second Project"
    )!;
    const conversationId = "27272727-2727-4727-8727-272727272727";
    const metadata = { "openai/session": conversationId };
    const start = async (
      projectName: string,
      requestId: string,
      presentationId: string,
      agentName: string
    ) => parseToolJson(await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId,
        activityPresentationId: presentationId,
        prompt: `track ${agentName} in the project-first dashboard`,
        project: {
          name: projectName,
          registryRevision: settings.current.registryRevision
        },
        activity: { mode: "new", title: `${agentName} activity` },
        agent: { mode: "new", name: agentName },
        executionMode: "background"
      },
      _meta: metadata
    }));
    const completed = await start(
      firstProject.name,
      "28282828-2828-4828-8828-282828282828",
      "29292929-2929-4929-8929-292929292929",
      "First Project Agent"
    );
    const running = await start(
      secondProject.name,
      "30303030-3030-4030-8030-303030303030",
      "31313131-3131-4131-8131-313131313131",
      "Second Project Agent"
    );
    upstream.resolveNext(fakeCodexResult("first-project-thread"));
    await vi.waitFor(() => expect(jobs.get(completed.jobId)?.status).toBe("completed"));

    const { view } = await freshDashboardSnapshot(rawCallTool, { metadata });
    expect(view.counts).toMatchObject({ trackedProjects: 2, trackedConversations: 1 });
    expect(view.activeRows).toEqual([
      expect.objectContaining({
        agentName: "Second Project Agent",
        projectName: "Second Project",
        status: "running",
        conversationUrl: `https://chatgpt.com/c/${conversationId}`
      })
    ]);
    expect(view.terminalRows).toEqual([
      expect.objectContaining({
        agentName: "First Project Agent",
        projectName: firstProject.name,
        status: "completed",
        conversationUrl: `https://chatgpt.com/c/${conversationId}`
      })
    ]);
    expect(new Set([...view.activeRows, ...view.terminalRows].map(
      (row) => row.conversationKey
    )).size).toBe(1);
    expect(new Set([...view.activeRows, ...view.terminalRows].map(
      (row) => row.projectKey
    )).size).toBe(2);
    expect(view).not.toHaveProperty("projects");
    expect(view).not.toHaveProperty("conversations");

    upstream.resolveNext(fakeCodexResult("second-project-thread"));
    await vi.waitFor(() => expect(jobs.get(running.jobId)?.status).toBe("completed"));
    await close();
  });

  it("counts only active registered projects while retaining archived and deleted project rows", async () => {
    const root = temporaryRoot();
    const unusedRoot = path.join(root, "unused-project");
    mkdirSync(unusedRoot);
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const retainedProject = settings.current.projects[0]!;
    const task = parseToolJson(await runTask(client, {
      prompt: "retain this project row after registry archive and delete",
      activityTitle: "Retained project history",
      agentName: "Retained Project Agent",
      executionMode: "background"
    }));
    upstream.resolveNext(fakeCodexResult("retained-project-thread"));
    await vi.waitFor(() => expect(jobs.get(task.jobId)?.status).toBe("completed"));

    const added = await rawCallTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: settings.current.registryRevision,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "Unused Active Project", cwd: unusedRoot } }
            ]
          }
        }
      }
    });
    expect(added.isError).not.toBe(true);
    const beforeArchive = await freshDashboardSnapshot(rawCallTool, { scopeId: SCOPE_A });
    expect(beforeArchive.view.counts.trackedProjects).toBe(2);
    expect(beforeArchive.view.terminalRows).toEqual([
      expect.objectContaining({
        agentName: "Retained Project Agent",
        projectName: retainedProject.name,
        status: "completed"
      })
    ]);

    const archived = await rawCallTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: settings.current.registryRevision,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "archive", projectId: retainedProject.id }]
          }
        }
      }
    });
    expect(archived.isError).not.toBe(true);
    const afterArchive = await freshDashboardSnapshot(rawCallTool, { scopeId: SCOPE_A });
    expect(afterArchive.view.counts.trackedProjects).toBe(1);
    expect(afterArchive.view.terminalRows).toEqual([
      expect.objectContaining({
        agentName: "Retained Project Agent",
        projectName: retainedProject.name
      })
    ]);

    const deleted = await rawCallTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: settings.current.registryRevision,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "delete", projectId: retainedProject.id }]
          }
        }
      }
    });
    expect(deleted.isError).not.toBe(true);
    const afterDelete = await freshDashboardSnapshot(rawCallTool, { scopeId: SCOPE_A });
    expect(afterDelete.view.counts.trackedProjects).toBe(1);
    expect(afterDelete.view.terminalRows).toEqual([
      expect.objectContaining({
        agentName: "Retained Project Agent",
        projectName: retainedProject.name
      })
    ]);

    await close();
  });

  it("defers Dashboard runtime probes until mount and reports not-loaded, unknown, and orphaned evidence", async () => {
    const root = temporaryRoot();
    const upstream = new ProbeAwareUpstream();
    const { client, rawCallTool, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const task = parseToolJson(await runTask(client, {
      prompt: "create one App Server thread for Dashboard probing"
    }));
    expect(task.status).toBe("completed");

    upstream.probe = {
      state: "resumable",
      runtimeStatus: "notLoaded",
      threadId: "thread-1"
    };
    const opened = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    expect(upstream.probeCalls).toEqual([]);
    expect((opened as { structuredContent?: any }).structuredContent?.summary)
      .toContain("1 App Server runtime checks deferred");
    expect((opened as { _meta?: Record<string, unknown> })._meta)
      .not.toHaveProperty(DASHBOARD_VIEW_METADATA_KEY);

    const snapshotArguments = {
      scopeId: SCOPE_A,
      widgetInstanceId: "34343434-3434-4434-8434-343434343434",
      limit: 20
    };
    const notLoaded = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: snapshotArguments
    });
    expect(upstream.probeCalls).toEqual(["thread-1"]);
    expect((notLoaded as { structuredContent?: any }).structuredContent?.counts).toMatchObject({
      backgroundProcesses: 0,
      runtimeUnknownAgents: 0,
      runtimeProbeSkippedAgents: 0
    });

    upstream.probe = {
      state: "unknown",
      reason: "transient",
      threadId: "thread-1",
      retryable: true
    };
    const unknown = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: snapshotArguments
    });
    expect((unknown as { structuredContent?: any }).structuredContent?.counts)
      .toMatchObject({ runtimeUnknownAgents: 1, runtimeProbeSkippedAgents: 0 });

    upstream.hangProbe = true;
    const timeoutStartedAt = Date.now();
    const timedOut = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: snapshotArguments
    });
    expect(Date.now() - timeoutStartedAt).toBeLessThan(3_000);
    expect((timedOut as { structuredContent?: any }).structuredContent?.counts)
      .toMatchObject({ runtimeUnknownAgents: 1, runtimeProbeSkippedAgents: 1 });
    upstream.hangProbe = false;

    upstream.probe = {
      state: "orphaned",
      reason: "missing",
      threadId: "thread-1",
      retryable: false
    };
    const orphaned = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: snapshotArguments
    });
    const orphanedView = (orphaned as { structuredContent?: any }).structuredContent;
    expect(orphanedView.counts).toMatchObject({ needsAttention: 1, orphanedAgents: 1 });
    expect(orphanedView.activeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "orphaned" })
    ]));

    const future = vi.spyOn(Date, "now")
      .mockReturnValue(Date.now() + 7 * 60 * 60 * 1_000);
    try {
      upstream.probe = {
        state: "resumable",
        runtimeStatus: "notLoaded",
        threadId: "thread-1"
      };
      upstream.probeCalls.length = 0;
      const afterJobExpiry = await rawCallTool({
        name: "codex_dashboard_snapshot",
        arguments: snapshotArguments
      });
      expect(upstream.probeCalls).toEqual(["thread-1"]);
      const expiredView = (afterJobExpiry as { structuredContent?: any }).structuredContent;
      expect(expiredView.counts)
        .toMatchObject({ retainedJobs: 1, runtimeProbeSkippedAgents: 0 });
      expect(expiredView.idleRows).toEqual([
        expect.objectContaining({
          status: "idle",
          execution: expect.objectContaining({ isCurrent: true }),
          latestTurn: expect.objectContaining({ status: "completed" })
        })
      ]);
    } finally {
      future.mockRestore();
    }

    await close();
  });

  it("marks a retained running Job as liveness-unknown when App Server reports an idle thread", async () => {
    const root = temporaryRoot();
    const upstream = new RunningProbeUpstream();
    const { client, rawCallTool, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "keep one App Server Job running for a liveness check",
        agentName: "Runtime mismatch Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));

    upstream.probe = {
      state: "resumable",
      runtimeStatus: "idle",
      threadId: "thread-1"
    };
    const mismatch = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        widgetInstanceId: "35353535-3535-4535-8535-353535353535",
        limit: 20
      }
    });
    const mismatchView = (mismatch as { structuredContent?: any }).structuredContent;
    expect(mismatchView.counts).toMatchObject({ running: 0, needsAttention: 1 });
    expect(mismatchView.activeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentName: "Runtime mismatch Agent",
        status: "liveness-unknown"
      })
    ]));

    upstream.probe = {
      state: "busy",
      runtimeStatus: "active",
      threadId: "thread-1",
      retryable: true
    };
    const confirmed = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        widgetInstanceId: "35353535-3535-4535-8535-353535353535",
        limit: 20
      }
    });
    const confirmedView = (confirmed as { structuredContent?: any }).structuredContent;
    expect(confirmedView.counts).toMatchObject({ running: 1, needsAttention: 0 });
    expect(confirmedView.activeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "running" })
    ]));

    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, running.jobId, "completed");
    await close();
  });

  it("counts only the latest retained outcome per Agent as needing attention", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

    const failed = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "fail the first dashboard attempt",
        activity: { mode: "new", title: "Dashboard retry outcome" },
        agent: { mode: "new", name: "Dashboard retry Agent" },
        executionMode: "background",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    }));
    upstream.rejectNext(new Error("first dashboard attempt failed"));
    await waitForJobStatus(client, failed.jobId, "failed");

    const failedOverview = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    expect((failedOverview as { structuredContent?: any }).structuredContent?.summary)
      .toContain("1 needing attention");

    const retry = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "succeed on the retry",
        activity: { mode: "existing", id: failed.activityId },
        agent: { mode: "existing", id: failed.agentId, context: "fresh" },
        executionMode: "background",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    }));
    const runningOverview = await rawCallTool({
      name: "codex_dashboard",
      arguments: { scopeId: SCOPE_A }
    });
    expect((runningOverview as { structuredContent?: any }).structuredContent?.summary)
      .toContain("1 active; 1 running; 0 needing attention");
    const { view: runningView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(runningView.activeRows).toEqual([
      expect.objectContaining({
        agentName: "Dashboard retry Agent",
        latestTurn: expect.objectContaining({ status: "running" }),
        historyCount: 1,
        history: [expect.objectContaining({
          status: "failed",
          execution: expect.objectContaining({
            model: "gpt-5.6-terra",
            reasoningEffort: "high",
            isCurrent: false
          })
        })]
      })
    ]);
    expect(runningView.counts.retainedJobs).toBe(2);
    expect(runningView.terminalRows).toEqual([]);

    upstream.resolveNext(fakeCodexResult("dashboard-retry-thread"));
    await waitForJobStatus(client, retry.jobId, "completed");
    const observedAt = Date.now();
    const failedJob = jobs.get(failed.jobId)!;
    failedJob.createdAt = observedAt - 30 * 60_000;
    failedJob.updatedAt = observedAt - 25 * 60_000;
    const retryJob = jobs.get(retry.jobId)!;
    retryJob.createdAt = observedAt - 10 * 60_000;
    retryJob.updatedAt = observedAt - 2 * 60_000;
    const { view: completedView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(completedView.counts).toMatchObject({
      retainedJobs: 2,
      failed: 1,
      completed: 1,
      needsAttention: 0
    });
    expect(completedView.terminalRows).toEqual([
      expect.objectContaining({
        agentName: "Dashboard retry Agent",
        status: "completed",
        elapsedMs: 8 * 60_000,
        latestTurn: expect.objectContaining({
          status: "completed",
          startedAt: new Date(observedAt - 10 * 60_000).toISOString(),
          endedAt: new Date(observedAt - 2 * 60_000).toISOString(),
          durationMs: 8 * 60_000
        }),
        historyCount: 1,
        history: [expect.objectContaining({
          status: "failed",
          startedAt: new Date(observedAt - 30 * 60_000).toISOString(),
          endedAt: new Date(observedAt - 25 * 60_000).toISOString(),
          durationMs: 5 * 60_000
        })]
      })
    ]);
    expect(completedView.idleRows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentName: "Dashboard retry Agent" })
    ]));
    expect(JSON.stringify(completedView)).not.toContain(failed.agentId);

    await close();
  });

  it("projects private Activity metadata only from the dedicated presentation tool", async () => {
    const root = temporaryRoot();
    const { client, rawCallTool, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream()
    );

    const taskResult = await runTask(client, { prompt: "run without mounting an Activity card" });
    const taskStructured = parseToolJson(taskResult);
    const publicTask = (taskResult as { structuredContent?: Record<string, unknown> }).structuredContent!;
    const taskMeta = (taskResult as { _meta?: Record<string, unknown> })._meta || {};
    expect(taskMeta).not.toHaveProperty(ACTIVITY_BOOTSTRAP_METADATA_KEY);
    expect(Object.keys(publicTask)).not.toEqual(expect.arrayContaining([
      "bridgeSession",
      "bridgeActivity",
      "activityTracking",
      "activityPresentationId"
    ]));

    const presentationId = "31313131-3131-4131-8131-313131313131";
    const compactResult = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "compact-monitor",
        presentationId,
        activityId: taskStructured.activityId
      }
    });
    const compactView = validateActivityViewPrivateMetadata(
      (compactResult as { _meta?: Record<string, unknown> })
        ._meta?.[ACTIVITY_VIEW_METADATA_KEY]
    );
    expect(compactView).toMatchObject({
      source: "codex_activity",
      correlation: {
        presentation: {
          kind: "automatic",
          activityPresentationId: presentationId,
          reservationOwnerId: presentationId
        }
      },
      view: {
        feed: { mode: "compact" },
        watcherPolicy: { ownsCompletionHandoff: true }
      }
    });

    const activityResult = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "full-history",
        activityId: taskStructured.activityId
      }
    });
    const publicActivity = (activityResult as { structuredContent?: Record<string, unknown> })
      .structuredContent!;
    const activityStructured = parseToolJson(activityResult);
    const activityMeta = (activityResult as { _meta?: Record<string, unknown> })._meta || {};
    const privateView = validateActivityViewPrivateMetadata(
      activityMeta[ACTIVITY_VIEW_METADATA_KEY]
    );
    expect(privateView).toMatchObject({
      kind: "codex/activityView",
      version: 11,
      purpose: "presentation-hydration-only",
      source: "codex_activity",
      correlation: {
        scopeVersion: activityStructured.scopeVersion,
        activity: {
          activityId: taskStructured.activityId,
          cardGeneration: activityStructured.mountedActivity.cardGeneration
        },
        presentation: { kind: "explicit" }
      }
    });
    expect(privateView.view).toEqual(activityStructured);
    expect(publicActivity).toMatchObject({
      kind: "activity",
      scopeVersion: privateView.view.scopeVersion,
      activityId: taskStructured.activityId,
      counts: expect.any(Object)
    });
    expect(Object.keys(publicActivity)).not.toContain("feed");

    const snapshotResult = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: {
          activityId: taskStructured.activityId,
          generation: activityStructured.mountedActivity.cardGeneration,
          presentation: { kind: "explicit" }
        }
      },
      _meta: { "openai/widgetSessionId": "generation-11-private-view" }
    });
    const snapshotMeta = (snapshotResult as { _meta?: Record<string, unknown> })._meta || {};
    expect(validateActivityViewPrivateMetadata(snapshotMeta[ACTIVITY_VIEW_METADATA_KEY]))
      .toMatchObject({ source: "codex_activity_snapshot" });
    expect(parseToolJson(snapshotResult)).toEqual(
      (snapshotMeta[ACTIVITY_VIEW_METADATA_KEY] as { view: Record<string, unknown> }).view
    );

    await close();
  });

  it("rehydrates a cold task shell as a one-shot read-only historical Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const activityPresentationId = "37373737-3737-4737-8737-373737373737";
    const taskResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "retain this Activity for a cold historical remount",
        executionMode: "background",
        activityPresentationId
      }
    });
    const task = parseToolJson(taskResult);
    const publicTask = (taskResult as { structuredContent?: Record<string, unknown> })
      .structuredContent!;
    expect(publicTask).toMatchObject({
      kind: "task",
      jobId: task.jobId,
      requestId: task.requestId,
      activityId: task.activityId
    });
    expect(publicTask).not.toHaveProperty("bridgeActivity");

    const presentationState = jobs as unknown as {
      activeWatchers: number;
      watcherLeases: Set<string>;
      activityCardLeases: Map<string, number>;
      activityCardReservations: Map<string, unknown>;
      latestAutomaticPresentationByScope: Map<string, unknown>;
    };
    const before = {
      jobs: jobs.sizeForScope(SCOPE_A),
      activeWatchers: presentationState.activeWatchers,
      watcherLeases: presentationState.watcherLeases.size,
      cardLeases: presentationState.activityCardLeases.size,
      reservations: presentationState.activityCardReservations.size,
      latestAutomatic: presentationState.latestAutomaticPresentationByScope.size
    };
    const rehydrateRequest = {
      name: "codex_activity_rehydrate",
      arguments: {
        scopeId: SCOPE_A,
        jobId: task.jobId,
        requestId: task.requestId,
        limit: 30
      },
      _meta: { "openai/widgetSessionId": "historical-widget" }
    } as const;
    const historicalResult = await rawCallTool(rehydrateRequest);
    expect(historicalResult.isError).not.toBe(true);
    const historical = parseToolJson(historicalResult);
    expect(historical).toMatchObject({
      mountedActivity: {
        activityId: task.activityId,
        cardGeneration: expect.any(Number)
      },
      mountedPresentation: {
        kind: "historical",
        jobId: task.jobId,
        requestId: task.requestId
      },
      watcherPolicy: {
        presentationKind: "historical",
        mode: "one-shot",
        live: false,
        stopped: false,
        ownsCompletionHandoff: false
      },
      pendingHandoffs: []
    });
    expect((historicalResult as { _meta?: Record<string, any> })._meta)
      .toMatchObject({ interactionControls: { agents: [] } });
    expect(validateActivityViewPrivateMetadata(
      (historicalResult as { _meta?: Record<string, any> })
        ._meta?.[ACTIVITY_VIEW_METADATA_KEY]
    )).toMatchObject({
      source: "codex_activity_rehydrate",
      correlation: {
        activity: { activityId: task.activityId },
        presentation: {
          kind: "historical",
          jobId: task.jobId,
          requestId: task.requestId
        }
      }
    });

    const repeated = parseToolJson(await rawCallTool(rehydrateRequest));
    expect(repeated).toMatchObject({
      scopeVersion: historical.scopeVersion,
      mountedPresentation: historical.mountedPresentation,
      watcherPolicy: { mode: "one-shot", live: false }
    });
    expect({
      jobs: jobs.sizeForScope(SCOPE_A),
      activeWatchers: presentationState.activeWatchers,
      watcherLeases: presentationState.watcherLeases.size,
      cardLeases: presentationState.activityCardLeases.size,
      reservations: presentationState.activityCardReservations.size,
      latestAutomatic: presentationState.latestAutomaticPresentationByScope.size
    }).toEqual(before);

    const noLeaseMutation = await rawCallTool({
      name: "codex_activity_job_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "37373737-3737-4737-8737-373737373738",
        jobId: task.jobId,
        expectedJobVersion: task.jobVersion,
        acknowledgeAffectedJobIds: [task.jobId],
        card: {
          activityId: task.activityId,
          generation: historical.mountedActivity.cardGeneration,
          presentation: { kind: "explicit" }
        }
      },
      _meta: { "openai/widgetSessionId": "historical-widget" }
    });
    expect(noLeaseMutation.isError).toBe(true);
    expect(JSON.stringify(noLeaseMutation)).toContain("CARD_LEASE_REQUIRED");

    for (const unavailable of [
      {
        scopeId: SCOPE_B,
        jobId: task.jobId,
        requestId: task.requestId
      },
      {
        scopeId: SCOPE_A,
        jobId: task.jobId,
        requestId: "37373737-3737-4737-8737-373737373739"
      },
      {
        scopeId: SCOPE_A,
        jobId: "37373737-3737-4737-8737-373737373740",
        requestId: task.requestId
      }
    ]) {
      const rejected = await rawCallTool({
        name: "codex_activity_rehydrate",
        arguments: unavailable,
        _meta: { "openai/widgetSessionId": "historical-invalid-widget" }
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain("ACTIVITY_REHYDRATE_UNAVAILABLE");
    }
    const unmounted = await rawCallTool({
      name: "codex_activity_rehydrate",
      arguments: {
        scopeId: SCOPE_A,
        jobId: task.jobId,
        requestId: task.requestId
      }
    });
    expect(unmounted.isError).toBe(true);
    expect(JSON.stringify(unmounted)).toContain("CARD_REHYDRATE_WIDGET_REQUIRED");

    const promoted = parseToolJson(await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: {
          activityId: task.activityId,
          generation: historical.mountedActivity.cardGeneration,
          presentation: { kind: "explicit" }
        }
      },
      _meta: { "openai/widgetSessionId": "historical-widget" }
    }));
    expect(promoted).toMatchObject({
      mountedPresentation: { kind: "explicit" },
      watcherPolicy: { live: true, ownsCompletionHandoff: false }
    });
    expect(() => jobs.requireActivityCardLease(
      SCOPE_A,
      task.activityId,
      historical.mountedActivity.cardGeneration,
      "historical-widget",
      { kind: "explicit" }
    )).not.toThrow();
    jobs.releaseActivityCardLease(
      SCOPE_A,
      task.activityId,
      historical.mountedActivity.cardGeneration,
      "historical-widget",
      { kind: "explicit" }
    );

    upstream.resolveNext(fakeCodexResult("historical-thread"));
    await waitForJobStatus(client, task.jobId, "completed");
    await close();
  });

  it("elects only one historical shell for sibling tasks in an assistant response", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, close } = await connectTestClient(configFor(root), upstream);
    const activityPresentationId = "37373737-3737-4737-8737-373737373741";
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "first historical sibling",
        executionMode: "background",
        activityPresentationId
      }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "second historical sibling",
        executionMode: "background",
        activityPresentationId
      }
    }));
    const results = await Promise.all([first, second].map((task, index) => rawCallTool({
      name: "codex_activity_rehydrate",
      arguments: {
        scopeId: SCOPE_A,
        jobId: task.jobId,
        requestId: task.requestId
      },
      _meta: { "openai/widgetSessionId": `historical-sibling-${index}` }
    })));
    expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
    const duplicate = results.find((result) => result.isError === true);
    expect(JSON.stringify(duplicate)).toContain("ACTIVITY_REHYDRATE_DUPLICATE");
    const elected = results.find((result) => result.isError !== true)!;
    expect(parseToolJson(elected)).toMatchObject({
      mountedPresentation: {
        kind: "historical",
        jobId: expect.stringMatching(SCOPE_ID_PATTERN)
      },
      watcherPolicy: {
        mode: "one-shot",
        live: false,
        ownsCompletionHandoff: false
      }
    });

    upstream.resolveNext(fakeCodexResult("historical-sibling-thread-1"));
    upstream.resolveNext(fakeCodexResult("historical-sibling-thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("marks codex_task as stateful and filesystem-destructive only when write policy is enabled", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: "workspace-write"
    });
    const { client, rawCallTool, close } = await connectTestClient(config, new FakeUpstream());
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "codex_task");

    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await close();
  });

  it("keeps conservative task annotations stable across saved access changes", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());
    const taskAnnotations = async () =>
      (await client.listTools()).tools.find((entry) => entry.name === "codex_task")?.annotations;
    const taskDescriptor = async () =>
      (await client.listTools()).tools.find((entry) => entry.name === "codex_task");

    const before = await taskDescriptor();
    expect(await taskAnnotations()).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
    const settingsMutation = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_update_settings"
    ) as any;
    expect(settingsMutation.inputSchema.properties.operation.oneOf[1]
      .properties.settings.properties.accessStrategy.enum)
      .toEqual(["read-only", "adaptive", "always-full"]);
    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: { kind: "patch", settings: { accessStrategy: "read-only" } }
      }
    });
    expect(await taskAnnotations()).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        operation: { kind: "patch", settings: { accessStrategy: "always-full" } }
      }
    });
    expect(await taskAnnotations()).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
    expect(await taskDescriptor()).toEqual(before);
    await close();
  });

  it("validates and persists named projects through the app-only Settings mutation", async () => {
    const root = temporaryRoot();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const movedApi = path.join(root, "moved-api");
    mkdirSync(web);
    mkdirSync(api);
    mkdirSync(movedApi);
    const upstream = new FakeUpstream();
    const { client, rawCallTool, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new FakeModelCatalog(),
      undefined,
      undefined,
      false
    );

    const initialResult = await client.callTool({
      name: "codex_settings",
      arguments: {}
    });
    expect((initialResult as { _meta?: Record<string, unknown> })._meta)
      .not.toHaveProperty("codex/settingsView");
    const initial = privateSettingsView(await client.callTool({
      name: "codex_settings_snapshot",
      arguments: {}
    }));
    expect(JSON.stringify((initialResult as { structuredContent?: unknown }).structuredContent))
      .not.toContain(realpathSync(root));
    expect(initial.settings).toMatchObject({
      settingsRevision: 0,
      registryRevision: 0,
      projects: []
    });
    expect(initial.capabilities.projectAvailability).toEqual([]);

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "웹 앱", cwd: web } },
              { kind: "add", project: { name: "API 서비스", cwd: api } }
            ]
          }
        }
      }
    });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const view = privateSettingsView(saved);
    expect(view.settings).toMatchObject({
      settingsRevision: 0,
      registryRevision: 1,
      projects: [
        { name: "웹 앱", cwd: realpathSync(web) },
        { name: "API 서비스", cwd: realpathSync(api) }
      ]
    });
    const [webProject, apiProject] = view.settings.projects as Array<Record<string, any>>;
    expect(webProject.id).toMatch(SCOPE_ID_PATTERN);
    expect(apiProject.id).toMatch(SCOPE_ID_PATTERN);
    const compatibilitySaved = JSON.stringify(saved.content);
    expect(compatibilitySaved).not.toContain(webProject.id);
    expect(compatibilitySaved).not.toContain(apiProject.id);
    expect(compatibilitySaved).not.toContain(realpathSync(web));
    expect(compatibilitySaved).not.toContain(realpathSync(api));
    const privateStructuredSaved = JSON.stringify(
      (saved as { structuredContent?: unknown }).structuredContent
    );
    expect(privateStructuredSaved).toContain(webProject.id);
    expect(privateStructuredSaved).toContain(apiProject.id);
    expect(privateStructuredSaved).toContain(realpathSync(web));
    expect(privateStructuredSaved).toContain(realpathSync(api));
    expect(view.capabilities.projectAvailability).toEqual([
      { projectId: webProject.id, name: "웹 앱", available: true, archived: false },
      { projectId: apiProject.id, name: "API 서비스", available: true, archived: false }
    ]);

    const duplicateName = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "  웹   앱  ", cwd: movedApi } }
            ]
          }
        }
      }
    });
    expect(duplicateName.isError).toBe(true);
    expect(JSON.stringify(duplicateName)).toContain("PROJECT_NAME_CONFLICT");

    const duplicatePath = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "Other", cwd: web } }
            ]
          }
        }
      }
    });
    expect(duplicatePath.isError).toBe(true);
    expect(JSON.stringify(duplicatePath)).toContain("PROJECT_CWD_CONFLICT");
    expect(privateSettingsView(await client.callTool({
      name: "codex_settings_snapshot",
      arguments: {}
    }))
      .settings.registryRevision).toBe(1);

    const retiredDefault = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
        operation: {
          kind: "patch",
          settings: { defaultProjectId: "missing" }
        }
      }
    });
    expect(retiredDefault.isError).toBe(true);
    expect(JSON.stringify(retiredDefault)).toContain("Unrecognized key");

    const edited = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "rename", projectId: webProject.id, name: "Web Application" },
              { kind: "relocate", projectId: apiProject.id, cwd: movedApi }
            ]
          }
        }
      }
    });
    expect(privateSettingsView(edited).settings)
      .toMatchObject({
        settingsRevision: 0,
        registryRevision: 2,
        projects: [
          { id: webProject.id, name: "Web Application", cwd: realpathSync(web) },
          { id: apiProject.id, name: "API 서비스", cwd: realpathSync(movedApi) }
        ]
      });

    const archived = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 2,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "archive", projectId: webProject.id }]
          }
        }
      }
    });
    expect(privateSettingsView(archived).settings).toMatchObject({
      registryRevision: 3,
      projects: expect.arrayContaining([
        expect.objectContaining({ id: webProject.id, name: "Web Application", archivedAt: expect.any(Number) })
      ])
    });
    const archivedDescriptor = (await client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    );
    expect(JSON.stringify(archivedDescriptor?.inputSchema)).not.toContain('"const":"Web Application"');
    const archivedAdmission = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "51515151-5151-4151-8151-515151515151",
        activityPresentationId: "52525252-5252-4252-8252-525252525252",
        prompt: "an archived project cannot admit fresh work",
        project: { name: "Web Application", registryRevision: 3 },
        activity: { mode: "new" },
        agent: { mode: "new", name: "Archived Project Agent" },
        executionMode: "foreground"
      }
    });
    expect(archivedAdmission.isError).toBe(true);
    expect(JSON.stringify(archivedAdmission)).toContain("PROJECT_NOT_FOUND");
    expect(upstream.calls).toEqual([]);

    const restored = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 3,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "restore", projectId: webProject.id }]
          }
        }
      }
    });
    expect(privateSettingsView(restored).settings).toMatchObject({
      registryRevision: 4,
      projects: expect.arrayContaining([
        expect.objectContaining({ id: webProject.id, name: "Web Application", cwd: realpathSync(web) })
      ])
    });

    const activeDelete = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 4,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "delete", projectId: webProject.id }]
          }
        }
      }
    });
    expect(activeDelete.isError).toBe(true);
    expect(JSON.stringify(activeDelete)).toContain("PROJECT_DELETE_REQUIRES_ARCHIVE");

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 4,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "archive", projectId: webProject.id }]
          }
        }
      }
    });
    const deleted = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 5,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [{ kind: "delete", projectId: webProject.id }]
          }
        }
      }
    });
    const deletedView = privateSettingsView(deleted);
    expect(deletedView.settings).toMatchObject({
      registryRevision: 6,
      projects: [expect.objectContaining({ id: apiProject.id })]
    });
    expect(deletedView.capabilities.projectAvailability).toEqual([
      expect.objectContaining({ projectId: apiProject.id })
    ]);
    expect(existsSync(web)).toBe(true);
    await close();
  });

  it("uses the registry's Unicode code-point bound for project mutations and task selectors", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const connection = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new FakeModelCatalog(),
      undefined,
      undefined,
      false
    );
    const addedName = "😀".repeat(61);
    const renamedName = "🧠".repeat(61);
    const restoredName = "🚀".repeat(61);
    try {
      const added = await connection.client.callTool({
        name: "codex_update_settings",
        arguments: {
          expectedRegistryRevision: 0,
          operation: {
            kind: "patch",
            settings: {
              projectOperations: [{ kind: "add", project: { name: addedName, cwd: root } }]
            }
          }
        }
      });
      expect(added.isError).not.toBe(true);
      const project = connection.settings.current.projects[0]!;
      const task = (await connection.client.listTools()).tools.find(
        (entry) => entry.name === "codex_task"
      )!;
      expect(JSON.stringify(task.inputSchema)).not.toContain(addedName);
      const discovered = await connection.client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "resolve the astral Unicode project selector without running",
          projectLookup: { name: addedName }
        }
      });
      expect(discovered).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "PROJECT_SELECTION_REQUIRED", retryable: true },
          nextActions: [expect.stringContaining(addedName)]
        }
      });
      expect(upstream.calls).toHaveLength(0);
      const executed = await runTask(connection.client, {
        prompt: "accept the runtime-resolved astral Unicode selector",
        executionMode: "foreground"
      });
      expect((executed as { isError?: boolean }).isError).not.toBe(true);
      expect(parseToolJson(executed).projectName).toBe(addedName);

      const renamed = await connection.client.callTool({
        name: "codex_update_settings",
        arguments: {
          expectedRegistryRevision: 1,
          operation: {
            kind: "patch",
            settings: {
              projectOperations: [{ kind: "rename", projectId: project.id, name: renamedName }]
            }
          }
        }
      });
      expect(renamed.isError).not.toBe(true);
      await connection.client.callTool({
        name: "codex_update_settings",
        arguments: {
          expectedRegistryRevision: 2,
          operation: {
            kind: "patch",
            settings: { projectOperations: [{ kind: "archive", projectId: project.id }] }
          }
        }
      });
      const restored = await connection.client.callTool({
        name: "codex_update_settings",
        arguments: {
          expectedRegistryRevision: 3,
          operation: {
            kind: "patch",
            settings: {
              projectOperations: [{
                kind: "restore",
                projectId: project.id,
                name: restoredName
              }]
            }
          }
        }
      });
      expect(restored.isError).not.toBe(true);
      expect(connection.settings.current.projects[0]?.name).toBe(restoredName);
    } finally {
      await connection.close();
    }
  });

  it("onboards arbitrary PC folders from Settings and preserves them when general defaults are restored", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const opened = parseToolJson(await client.callTool({
      name: "codex_settings",
      arguments: {}
    }));
    expect(opened.revisions).toMatchObject({
      settings: 0,
      registry: 0
    });
    expect(opened.projects).toEqual([]);
    expect(opened).not.toHaveProperty("capabilities");

    const firstSave = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "First", cwd: first } }
            ]
          }
        }
      }
    });
    expect(privateSettingsView(firstSave).settings)
      .toMatchObject({ registryRevision: 1, projects: [{ name: "First", cwd: realpathSync(first) }] });

    const secondSave = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
        expectedRegistryRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            uiLocalePreference: "ko",
            projectOperations: [
              { kind: "add", project: { name: "Second", cwd: second } }
            ]
          }
        }
      }
    });
    const beforeReset = privateSettingsView(secondSave).settings;
    const restored = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 1,
        operation: { kind: "reset" }
      }
    });
    expect(privateSettingsView(restored).settings)
      .toMatchObject({
        settingsRevision: 2,
        registryRevision: 2,
        uiLocalePreference: "auto",
        modelPolicy: {
          mode: "automatic",
          fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
        },
        projects: beforeReset.projects
      });

    const task = await runTask(client, { prompt: "work here", projectId: "first" });
    expect(parseToolJson(task).projectName).toBe("First");
    await close();
  });

  it("exposes recovery availability without leaking validation reasons into capabilities", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const stateFile = path.join(temporaryRoot(), "settings.json");
    const broadConfig = configFor(first, {
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const original = new UserSettingsStore(broadConfig, { stateFile });
    original.update({
      projects: [
        { id: "active", label: "Active", cwd: first },
        { id: "recovery", label: "Recovery", cwd: second }
      ]
    }, 0);
    const narrowConfig = configFor(first);
    const recovered = new UserSettingsStore(narrowConfig, { stateFile });
    const { client, jobs, close } = await connectTestClient(
      narrowConfig,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      recovered
    );

    const view = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(view.projects).toEqual([
      { name: "Active", available: true, archived: false },
      { name: "Recovery", available: false, archived: false }
    ]);
    expect(JSON.stringify(view.projects)).not.toContain(second);
    expect(JSON.stringify(view.projects)).not.toContain("unavailableReason");
    expect(view.projects).toContainEqual({
      name: "Recovery",
      available: false,
      archived: false
    });
    expect(privateSettingsView(await client.callTool({
      name: "codex_settings_snapshot",
      arguments: {}
    })).settings.projects).toContainEqual({
      id: expect.stringMatching(SCOPE_ID_PATTERN),
      projectRef: expect.stringMatching(/^prj_[A-Za-z0-9_-]{22}$/),
      projectRevision: 1,
      name: "Recovery",
      label: "Recovery",
      nameKey: "recovery",
      cwd: realpathSync(second),
      sortOrder: 1,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number)
    });
    await close();
  });

  it("keeps the path-free task descriptor stable when a project disappears and recovers", async () => {
    const root = temporaryRoot();
    const project = path.join(root, "alpha-workspace");
    const displaced = path.join(root, "alpha-workspace.unavailable");
    mkdirSync(project);
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    settings.update({
      projects: [{ id: "alpha", label: "Alpha Workspace", cwd: project }]
    }, settings.current.revision);
    const upstream = new FakeUpstream();
    const { client, rawCallTool, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
    const taskDescriptor = async () =>
      (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;

    const initial = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const baselineNotifications = listChanged;
    expect(initial.projects).toEqual([
      { name: "Alpha Workspace", available: true, archived: false }
    ]);
    const initialDescriptor = await taskDescriptor();
    expect(JSON.stringify(initialDescriptor.inputSchema.properties?.project))
      .not.toContain('"Alpha Workspace"');
    expect(JSON.stringify(initialDescriptor)).not.toContain(realpathSync(project));

    renameSync(project, displaced);
    const unavailable = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unavailable.projects).toEqual([
      { name: "Alpha Workspace", available: false, archived: false }
    ]);
    expect(listChanged).toBe(baselineNotifications);
    const unavailableDescriptor = await taskDescriptor();
    const unavailableSchema = unavailableDescriptor.inputSchema as Record<string, any>;
    expect(unavailableDescriptor).toEqual(initialDescriptor);
    expect(unavailableSchema.properties?.project).toMatchObject({
      type: "object",
      required: ["name", "projectRef", "projectRevision"],
      additionalProperties: false
    });
    expect(unavailableSchema).not.toHaveProperty("allOf");
    expect(unavailableDescriptor._meta).toBeUndefined();
    expect(unavailableDescriptor.description).toContain("projectLookup.name");
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(project);
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(displaced);
    const unavailableStatus = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: {} })
    );
    expect(unavailableStatus).not.toHaveProperty("projects");
    expect(JSON.stringify(unavailableStatus)).not.toContain(project);
    expect(JSON.stringify(unavailableStatus)).not.toContain(displaced);
    const staleExplicitSelection = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "71717171-7171-4171-8171-717171717171",
        activityPresentationId: "72727272-7272-4272-8272-727272727272",
        prompt: "do not run through a stale unavailable project descriptor",
        project: { name: "Alpha Workspace", registryRevision: 1 },
        activity: { mode: "new" },
        agent: { mode: "new", name: "Stale Descriptor Agent" },
        executionMode: "foreground"
      }
    });
    const staleSerialized = JSON.stringify(staleExplicitSelection);
    expect(staleExplicitSelection.isError).toBe(true);
    expect(staleSerialized).toContain("PROJECT_UNAVAILABLE");
    expect(staleSerialized).not.toContain(project);
    expect(staleSerialized).not.toContain(displaced);
    expect(upstream.calls).toEqual([]);

    renameSync(displaced, project);
    const recovered = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recovered.projects).toEqual([
      { name: "Alpha Workspace", available: true, archived: false }
    ]);
    expect(listChanged).toBe(baselineNotifications);
    const recoveredDescriptor = await taskDescriptor();
    expect(recoveredDescriptor).toEqual(initialDescriptor);
    expect(JSON.stringify(recoveredDescriptor)).not.toContain(realpathSync(project));
    await close();
  });

  it("reports bridge policy and path-free project/session policy", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({
      kind: "overview",
      scopeCounts: { sessions: 0, jobs: 0, runningJobs: 0, activities: 0, agents: 0 },
      sessions: [],
      jobs: [],
      activities: [],
      agents: [],
      warnings: expect.any(Array)
    });
    for (const diagnosticField of [
      "appServerPolicy",
      "modelCatalogStatus",
      "upstreamPoolSize",
      "maxRetainedJobs",
      "maxJobResultBytes",
      "stateStorage",
      "concurrencyPolicy",
      "sessionPolicy"
    ]) expect(status).not.toHaveProperty(diagnosticField);
    expect(JSON.stringify(status)).not.toContain(realpathSync(root));
    expect(status.sessions).toEqual([]);

    await close();
  });

  it("reports an empty project registry when multiple roots have no registered projects", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      undefined,
      undefined,
      false
    );

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).not.toHaveProperty("projects");
    expect(status).not.toHaveProperty("defaultProjectId");
    expect(status).not.toHaveProperty("allowedRootCount");
    await close();
  });

  it("keeps routine status independent from upstream inventory diagnostics", async () => {
    const root = temporaryRoot();
    const upstream = new FailingInventoryUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({ kind: "overview", scopeCounts: { jobs: 0 } });
    expect(upstream.inventoryCalls).toBe(0);

    const diagnostics = parseToolJson(
      await client.callTool({ name: "codex_diagnostics", arguments: {} })
    );
    expect(diagnostics).toMatchObject({
      kind: "diagnostics",
      upstream: {
        tools: null,
        error: expect.stringContaining("fixture upstream inventory unavailable")
      },
      descriptorDiscovery: {
        epoch: expect.any(Number),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        activeBindings: 1,
        notificationEligibleBindings: 1,
        notificationAttempts: expect.any(Number),
        clientRelistObservations: expect.any(Number),
        currentEpochRelistedSessions: 0,
        adoptionState: "unknown"
      }
    });
    expect(upstream.inventoryCalls).toBe(1);
    await close();
  });

  it("returns the dynamic model and effort catalog", async () => {
    const root = temporaryRoot();
    const catalog = new FakeModelCatalog();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream(), undefined, catalog);

    const result = parseToolJson(
      await client.callTool({ name: "codex_models", arguments: { refresh: true } })
    );
    expect(result).toMatchObject({
      source: "codex-cli",
      stale: false,
      warning: null,
      policy: { mode: "automatic", delegation: true },
      priority: false
    });
    expect(result).not.toHaveProperty("fingerprint");
    expect(result.models.find((entry: { id: string }) => entry.id === "gpt-5.6-sol"))
      .toMatchObject({
      name: "GPT-5.6 Sol",
      efforts: expect.arrayContaining(["high", "max"])
    });
    expect(result.models.every((entry: Record<string, unknown>) =>
      !("defaultEffort" in entry) && !("isDefault" in entry)
    )).toBe(true);
    expect(result.models.map((entry: { id: string }) => entry.id)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ]);
    expect(catalog.calls).toEqual([{ refresh: true, backendKind: "mcp-server" }]);

    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    const selection = task.inputSchema.properties?.selection as {
      description?: string;
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(selection.description).toContain("live catalog");
    expect(selection.description).toContain("without exposing its fallback");
    expect(selection).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false,
      properties: {
        model: { type: "string" },
        reasoningEffort: { type: "string" }
      }
    });
    expect(JSON.stringify(selection)).not.toMatch(/gpt-5\.6-sol|frontier agentic coding/);

    await close();
  });

  it("publishes exactly the 17 currently allowed Sol, Terra, and Luna pairs", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream(),
      undefined,
      new FullModelCatalog()
    );
    const effortsByModel = {
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"]
    } as const;
    const allowedSelections = Object.entries(effortsByModel).flatMap(
      ([model, efforts]) => efforts.map((reasoningEffort) => ({ model, reasoningEffort }))
    );

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            modelPolicy: {
              mode: "automatic",
              fallbackSelection: allowedSelections[0],
              allowedSelections: { kind: "explicit", selections: allowedSelections },
              constraints: { allowDelegation: true }
            }
          }
        }
      }
    });

    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    const selection = task.inputSchema.properties?.selection;
    expect(JSON.stringify(selection)).not.toMatch(
      /gpt-5\.6-sol|gpt-5\.6-terra|gpt-5\.6-luna/
    );

    const listed = parseToolJson(await client.callTool({ name: "codex_models", arguments: {} }));
    expect(listed.policy).toMatchObject({
      mode: "automatic",
      allowed: "explicit",
      allowedCount: 17
    });
    const listedCounts = Object.fromEntries(
      listed.models.map((entry: { id: string; efforts: string[] }) => [entry.id, entry.efforts.length])
    );
    expect(listedCounts).toEqual({
      "gpt-5.6-luna": 5,
      "gpt-5.6-sol": 6,
      "gpt-5.6-terra": 6
    });
    expect(Object.values(listedCounts as Record<string, number>)
      .reduce((sum, count) => sum + count, 0)).toBe(17);
    await close();
  });

  it("keeps the task descriptor stable when only catalog guidance changes", async () => {
    const root = temporaryRoot();
    const catalog = new DescriptionRefreshingModelCatalog();
    const { client, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream(),
      undefined,
      catalog
    );
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });

    const before = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(JSON.stringify(before.inputSchema)).not.toContain("Latest frontier agentic coding model");

    await client.callTool({ name: "codex_models", arguments: { refresh: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect(listChanged).toBe(0);
    expect(after).toEqual(before);
    await close();
  });

  it("uses catalog changes discovered through task resolution without changing the descriptor", async () => {
    const root = temporaryRoot();
    const catalog = new TaskRefreshingModelCatalog();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      catalog
    );
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
    const before = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    expect(JSON.stringify(before.inputSchema)).not.toContain(
      "Catalog changed while resolving codex_task"
    );

    const admitted = await runTask(client, {
      prompt: "refresh catalog through task admission",
      agentName: "Catalog Refresh Agent",
      contextMode: "fresh"
    });
    expect(admitted.isError).not.toBe(true);
    expect(upstream.calls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    expect(after).toEqual(before);
    expect(listChanged).toBe(0);
    await close();
  });

  it("keeps an exact legacy model-only preference private to Settings hydration", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(temporaryRoot(), "settings.json");
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const initial = new UserSettingsStore(config, { stateFile });
    initial.update({ uiLocalePreference: "ko" }, 0);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    persisted.settings.legacyPreferredModel = "gpt-private-legacy-default";
    persisted.settings.modelPolicy = {
      mode: "automatic",
      allowedSelections: { kind: "catalog-visible" },
      constraints: { allowDelegation: true }
    };
    writeFileSync(stateFile, JSON.stringify(persisted));
    const settings = new UserSettingsStore(config, { stateFile });
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      settings
    );

    const result = await client.callTool({ name: "codex_settings", arguments: {} });
    const publicView = (result as { structuredContent?: Record<string, any> }).structuredContent!;
    expect((result as { _meta?: Record<string, unknown> })._meta)
      .not.toHaveProperty("codex/settingsView");
    const privateView = privateSettingsView(await client.callTool({
      name: "codex_settings_snapshot",
      arguments: {}
    }));
    expect(JSON.stringify(publicView)).not.toContain("gpt-private-legacy-default");
    expect(publicView.warnings).toContain(
      "Legacy model-only preference remains active; its exact value is available only in " +
      "Settings. Save an exact model/reasoning fallback to complete migration."
    );
    expect(privateView.warnings.join(" ")).toContain("gpt-private-legacy-default");
    expect(privateView.warnings.join(" ")).toContain("이전 모델 전용 설정");
    expect(privateView.warnings.join(" ")).not.toContain("Legacy model-only preference");
    expect(privateView.warnings.join(" ")).toContain(
      "기존 Agent 스레드는 처음 사용한 백엔드에 계속 고정"
    );
    await close();
  });

  it("keeps the full-catalog task descriptor generic and bounded", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream(),
      undefined,
      new FullModelCatalog()
    );
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    const selection = task.inputSchema.properties?.selection;
    expect(selection).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false
    });
    expect(JSON.stringify(selection)).not.toMatch(/gpt-5\.|task fit|ranking|recommendation/i);
    const contractBytes = Buffer.byteLength(JSON.stringify(task.inputSchema), "utf8") +
      Buffer.byteLength(JSON.stringify(task.outputSchema), "utf8");
    expect(contractBytes).toBeLessThanOrEqual(9_500);
    await close();
  });

  it("bounds the worst-case 100-project and full-model task descriptor", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const projects = Array.from({ length: 100 }, (_, index) => {
      const cwd = path.join(root, `project-${String(index).padStart(3, "0")}`);
      mkdirSync(cwd);
      return {
        name: `${"🧭".repeat(117)}${String(index).padStart(3, "0")}`,
        cwd
      };
    });
    settings.update({ projects }, settings.current.revision);
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FullModelCatalog(),
      settings
    );
    const task = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    const contractBytes = Buffer.byteLength(JSON.stringify(task.inputSchema), "utf8") +
      Buffer.byteLength(JSON.stringify(task.outputSchema), "utf8");
    const completeDescriptorBytes = Buffer.byteLength(JSON.stringify(task), "utf8");
    if (process.env.CODEX_ISSUE43_AUDIT === "1") {
      console.log("ISSUE43_DESCRIPTOR_METRICS", JSON.stringify({
        projectCount: 100,
        modelCount: 7,
        contractBytes,
        completeDescriptorBytes,
        descriptorLimitBytes: CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES
      }));
    }
    expect(contractBytes).toBeLessThanOrEqual(CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES);
    expect(completeDescriptorBytes).toBeGreaterThan(contractBytes);
    expect(completeDescriptorBytes).toBeLessThanOrEqual(CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES);
    expect(task.inputSchema.properties?.project).toMatchObject({
      type: "object",
      required: ["name", "projectRef", "projectRevision"],
      additionalProperties: false
    });
    expect(JSON.stringify(task)).not.toContain(projects[0]?.name);
    expect(JSON.stringify(task)).not.toContain(realpathSync(root));
    await close();
  });

  it("opens Settings through the normal catalog cache path and forces refresh only for retry", async () => {
    const root = temporaryRoot();
    const catalog = new FakeModelCatalog();
    const { client, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream(),
      undefined,
      catalog
    );

    await client.callTool({ name: "codex_settings", arguments: {} });
    await client.callTool({ name: "codex_settings", arguments: { refreshModels: true } });
    expect(catalog.calls).toEqual([
      { refresh: false, backendKind: "mcp-server" },
      { refresh: true, backendKind: "mcp-server" }
    ]);
    await close();
  });

  it("does not encode the saved automatic fallback in the GPT task input schema", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const allowedSelections = [
      { model: "gpt-5.6-sol", reasoningEffort: "max" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" }
    ];

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "automatic",
          allowedSelections: { kind: "explicit", selections: allowedSelections },
          fallbackSelection: allowedSelections[0],
          constraints: { allowDelegation: true }
        }
      }
    });
    const firstSchema = (await client.listTools()).tools
      .find((entry) => entry.name === "codex_task")!.inputSchema;

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        modelPolicy: {
          mode: "automatic",
          allowedSelections: { kind: "explicit", selections: allowedSelections },
          fallbackSelection: allowedSelections[1],
          constraints: { allowDelegation: true }
        }
      }
    });
    const secondSchema = (await client.listTools()).tools
      .find((entry) => entry.name === "codex_task")!.inputSchema;

    // Contract v2 never encodes the fallback or a mutable policy reference.
    expect(secondSchema).toEqual(firstSchema);
    expect(firstSchema.properties).not.toHaveProperty("executionPolicyRef");
    expect(JSON.stringify(secondSchema)).not.toContain("fallbackSelection");

    const publicModels = parseToolJson(
      await client.callTool({ name: "codex_models", arguments: {} })
    );
    const publicSettings = parseToolJson(
      await client.callTool({ name: "codex_settings", arguments: {} })
    );
    for (const summary of [publicModels.policy, publicSettings.policy.model]) {
      expect(summary).toMatchObject({ mode: "automatic", allowed: "explicit" });
      expect(summary).not.toHaveProperty("model");
      expect(summary).not.toHaveProperty("reasoningEffort");
    }
    expect(publicModels.models.every((model: Record<string, unknown>) =>
      !("defaultEffort" in model) && !("isDefault" in model)
    )).toBe(true);
    await close();
  });

  it("keeps one stable selection schema while enforcing current model policy", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, settings, close } = await connectTestClient(configFor(root), upstream);
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });

    let task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    const stableDescriptor = structuredClone(task);
    const staleExecutionPolicyRef = settings.executionPolicyRef(
      settings.current,
      modelCatalogAdmissionFingerprint(new FakeModelCatalog().getCachedCatalog().models)
    );
    expect(task.inputSchema).toMatchObject({ additionalProperties: false });
    expect(task.inputSchema.properties).not.toHaveProperty("model");
    expect(task.inputSchema.properties).not.toHaveProperty("reasoningEffort");
    expect(task.inputSchema.properties?.selection).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false
    });

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(privateSettingsView(saved)).toMatchObject({
      policyActivation: {
          policyRevision: 1,
          executionPolicyActive: true,
          descriptorProjectionUpdated: false,
          developerModeRefreshRequired: false
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listChanged).toBe(0);

    task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task).toEqual(stableDescriptor);
    expect(task.inputSchema.properties).toHaveProperty("selection");
    expect(task.inputSchema.properties).not.toHaveProperty("modelPolicyRevision");
    expect(task.inputSchema).toMatchObject({ additionalProperties: false });

    const staleOverride = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "stale override",
        executionPolicyRef: staleExecutionPolicyRef,
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    });
    expect(staleOverride.isError).toBe(true);
    expect(staleOverride).toMatchObject({
      structuredContent: {
        error: {
          code: "EXECUTION_POLICY_CHANGED",
          retryable: true
        },
        nextActions: expect.arrayContaining([expect.stringContaining("pre-v2 descriptor")])
      }
    });
    expect(upstream.calls).toHaveLength(0);

    const forbiddenOverride = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "current fixed override",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    });
    expect(forbiddenOverride).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "MODEL_SELECTION_FORBIDDEN" },
        nextActions: [expect.stringContaining("Omit selection")]
      }
    });
    const staleLegacyOverride = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "stale legacy override",
        model: "gpt-5.6-terra",
        reasoningEffort: "high"
      }
    });
    expect(staleLegacyOverride.isError).toBe(true);
    expect(JSON.stringify(staleLegacyOverride)).toContain("Unrecognized keys");
    expect(upstream.calls).toHaveLength(0);

    const fixed = await runTask(client, { prompt: "fixed execution", sessionMode: "new" });
    expect((fixed as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        actualModel: "gpt-5.6-sol",
        actualReasoningEffort: "max",
        rerouted: false
      });
    expect(upstream.calls[0]).toMatchObject({
      args: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } }
    });

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        modelPolicy: {
          mode: "automatic",
          allowedSelections: {
            kind: "explicit",
            selections: [{ model: "gpt-5.6-terra", reasoningEffort: "high" }]
          },
          fallbackSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task).toEqual(stableDescriptor);

    const retiredRevision = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "retired policy revision",
        modelPolicyRevision: 1,
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    });
    expect(retiredRevision.isError).toBe(true);
    expect(JSON.stringify(retiredRevision)).toContain("Unrecognized key");
    expect(JSON.stringify(retiredRevision)).toContain("modelPolicyRevision");
    await close();
  });

  it("keeps Priority private from GPT and injects it only into Codex calls", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new TieredModelCatalog()
    );
    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        usePriorityServiceTier: true,
        modelPolicy: {
          mode: "automatic",
          fallbackSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          allowedSelections: {
            kind: "explicit",
            selections: [
              { model: "gpt-5.6-sol", reasoningEffort: "high" },
              { model: "gpt-5.6-sol", reasoningEffort: "max" }
            ]
          },
          constraints: { allowDelegation: true }
        }
      }
    });
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    const selectionSchema = task.inputSchema.properties?.selection;
    expect(JSON.stringify(selectionSchema)).not.toContain("serviceTier");
    expect(selectionSchema).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false
    });
    expect(JSON.stringify(selectionSchema)).not.toContain("gpt-5.6-sol");

    await runTask(client, {
      prompt: "priority high",
      sessionMode: "new",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "high" }
    });
    await runTask(client, {
      prompt: "priority max",
      sessionMode: "new",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
    });
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.map((call) => call.args)).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "high", service_tier: "priority" }
      }),
      expect.objectContaining({
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "max", service_tier: "priority" }
      })
    ]);

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, usePriorityServiceTier: false }
    });
    await runTask(client, {
      prompt: "standard high",
      sessionMode: "new",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "high" }
    });
    expect(upstream.calls[2].args).toMatchObject({
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "high" }
    });
    expect((upstream.calls[2].args.config as Record<string, unknown>))
      .not.toHaveProperty("service_tier");

    const unsupportedPriority = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 2,
        usePriorityServiceTier: true,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(unsupportedPriority.isError).toBe(true);
    expect(JSON.stringify(unsupportedPriority)).toContain("MODEL_UNAVAILABLE");
    expect(JSON.stringify(unsupportedPriority)).toContain("Priority");
    const settings = await client.callTool({ name: "codex_settings", arguments: {} });
    expect(parseToolJson(settings)).toMatchObject({
      revisions: { settings: 2 },
      policy: { priority: false }
    });
    await close();
  });

  it("validates a generic stable selection against catalog drift at runtime", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new DriftingModelCatalog()
    );
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(JSON.stringify(task.inputSchema)).not.toContain("gpt-5.6-terra");

    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "catalog drift",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MODEL_UNAVAILABLE"
        },
        nextActions: expect.any(Array)
      }
    });
    expect(upstream.calls).toHaveLength(0);
    await close();
  });

  it("accepts an automatic policy when catalog drift leaves a non-empty intersection", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new DriftingModelCatalog()
    );
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "automatic",
          fallbackSelection: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
          allowedSelections: {
            kind: "explicit",
            selections: [
              { model: "gpt-5.6-sol", reasoningEffort: "max" },
              { model: "gpt-5.6-terra", reasoningEffort: "medium" }
            ]
          },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(saved.isError).not.toBe(true);
    expect(parseToolJson(saved)).toMatchObject({
      settings: {
        settingsRevision: 1,
        modelPolicy: { mode: "automatic" }
      }
    });

    const task = await runTask(client, { prompt: "use surviving selection", sessionMode: "new" });
    expect((task as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        actualModel: "gpt-5.6-sol",
        actualReasoningEffort: "max",
        rerouted: false
      });
    await close();
  });

  it("warns and uses a transient compatible fallback when a fixed selection disappears", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    settings.update({
      modelPolicy: {
        mode: "fixed",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
        constraints: { allowDelegation: true }
      }
    }, 0);
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new DriftingModelCatalog(),
      settings
    );
    const opened = await client.callTool({ name: "codex_settings", arguments: {} });
    expect((opened as { structuredContent?: Record<string, any> }).structuredContent?.warnings)
      .toEqual(expect.arrayContaining([expect.stringContaining("MODEL_UNAVAILABLE")]));
    const task = await runTask(client, {
      prompt: "fixed selection removed without descriptor refresh",
      agentName: "Fallback Agent",
      contextMode: "fresh"
    });
    expect((task as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      actualModel: "gpt-5.6-sol",
      actualReasoningEffort: "max",
      rerouted: false,
      warnings: [expect.stringContaining("unsupported by the current catalog")]
    });
    expect(upstream.calls).toEqual([
      expect.objectContaining({
        name: "codex",
        args: expect.objectContaining({ model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } })
      })
    ]);
    await close();
  });

  it("returns structured unavailable errors and preserves policy when catalog loading fails", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new UnavailableModelCatalog()
    );
    const unavailableDescriptor = (await client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    )!;
    const unavailableSchema = unavailableDescriptor.inputSchema as Record<string, any>;
    expect(unavailableSchema.properties?.selection).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false
    });
    expect(unavailableSchema).not.toHaveProperty("allOf");
    const task = await runTask(client, { prompt: "catalog required", sessionMode: "new" });
    expect(task).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "MODEL_UNAVAILABLE" }
      }
    });
    const staleSelection = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "catalog required for a stale exact choice",
        sessionMode: "new",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    });
    expect(staleSelection).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "MODEL_UNAVAILABLE" }
      }
    });
    const update = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(update.isError).toBe(true);
    expect(JSON.stringify(update)).toContain("MODEL_UNAVAILABLE");
    expect(JSON.stringify(update)).toContain("policy revision 1");
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({ kind: "overview", scopeCounts: { jobs: 0 } });
    expect(upstream.calls).toHaveLength(0);
    await close();
  });

  it("reads and saves validated defaults through the settings-card tools", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const settings = new UserSettingsStore(config);
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    const opened = await client.callTool({ name: "codex_settings", arguments: {} });
    expect((opened as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      revisions: { settings: 0, registry: 1, policy: 0 },
      policy: {
        access: "adaptive",
          model: {
            mode: "automatic",
            allowed: "catalog-visible"
          },
        maxConcurrentJobs: 30,
        activityVisibility: "always",
        completionHandoff: "off"
      },
      projects: [{ name: "Test Project", available: true, archived: false }],
      catalog: { stale: false, modelCount: 3 }
    });
    const openedSnapshot = await client.callTool({
      name: "codex_settings_snapshot",
      arguments: {}
    });
    expect(privateSettingsView(openedSnapshot)).toMatchObject({
      capabilities: {
        availableAccessStrategies: ["read-only", "adaptive", "always-full"],
        availableUiLocalePreferences: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"],
        availableActivityCardVisibilities: ["always", "background-only", "never"],
        availableCompletionHandoffs: ["off", "auto-handoff"],
        maxConcurrentJobs: 30,
        allowDangerFullAccess: true
      }
    });
    expect(JSON.stringify((opened as { structuredContent?: unknown }).structuredContent))
      .not.toContain(realpathSync(root));
    expect(privateSettingsView(openedSnapshot).settings).toMatchObject({
      settingsRevision: 0,
      registryRevision: 1,
      projects: [{ name: "Test Project", cwd: realpathSync(root) }]
    });

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        accessStrategy: "always-full",
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        },
        uiLocalePreference: "ko",
        maxConcurrentJobs: 12,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      }
    });
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      settings: {
        settingsRevision: 1,
        accessStrategy: "always-full",
        modelPolicy: {
          mode: "fixed",
          selection: {
            model: "gpt-5.6-terra",
            reasoningEffort: "high"
          }
        },
        maxConcurrentJobs: 12,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      }
    });
    expect(privateSettingsView(saved).settings).toMatchObject({
      uiLocalePreference: "ko",
      activityCardVisibility: "background-only",
      completionHandoff: "auto-handoff"
    });

    const localizedSettings = await client.callTool({
      name: "codex_settings",
      arguments: {},
      _meta: { "openai/locale": "en-US" }
    });
    expect((localizedSettings as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "en-US"
    });
    const localizedActivity = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A },
      _meta: { "openai/locale": "en-US" }
    });
    expect((localizedActivity as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "en-US"
    });

    await runTask(client, {
      prompt: "use saved defaults",
      agentName: "Saved Defaults",
      contextMode: "fresh"
    });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: {
        cwd: realpathSync(root),
        sandbox: "danger-full-access",
        model: "gpt-5.6-terra",
        config: { model_reasoning_effort: "high" },
        "approval-policy": "never"
      }
    });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({ kind: "overview", scopeCounts: { runningJobs: 0 } });
    expect(status).not.toHaveProperty("fastReturnMs");
    await close();
  });

  it("rejects stale settings cards and unavailable saved exact selections", async () => {
    const root = temporaryRoot();
    const config = configFor(root, { CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" });
    const catalog = new FakeModelCatalog();
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      catalog
    );

    const descriptor = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_update_settings"
    )!;
    expect(descriptor.inputSchema.properties).toHaveProperty("expectedSettingsRevision");
    expect(descriptor.inputSchema.properties).toHaveProperty("expectedRegistryRevision");
    expect(descriptor.inputSchema.properties).not.toHaveProperty("expectedRevision");
    const missingRevision = await client.callTool({
      name: "codex_update_settings",
      arguments: { uiLocalePreference: "ko" }
    });
    expect(missingRevision.isError).toBe(true);

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: { kind: "patch", settings: { uiLocalePreference: "ko" } }
      }
    });
    const refreshesBeforeStaleSave = catalog.calls.filter((call) => call.refresh === true).length;
    const stale = await client.callTool({
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
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("SETTINGS_REVISION_CONFLICT");
    expect(JSON.stringify(stale)).not.toContain("expected revision");
    expect(JSON.stringify(stale)).not.toContain("current revision");
    expect(catalog.calls.filter((call) => call.refresh === true)).toHaveLength(
      refreshesBeforeStaleSave
    );

    const unsupported = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            modelPolicy: {
              mode: "fixed",
              selection: { model: "gpt-5.5", reasoningEffort: "max" },
              constraints: { allowDelegation: true }
            }
          }
        }
      }
    });
    expect(unsupported.isError).toBe(true);
    expect(JSON.stringify(unsupported)).toContain("MODEL_UNAVAILABLE");
    await close();
  });

  it("distinguishes reset from patch and rejects mixed or empty Settings operations", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            uiLocalePreference: "ko",
            showBridgeThreadsInCodexApp: true,
            activityCard: { visibility: "background-only", completionHandoff: "auto-handoff" }
          }
        }
      }
    });
    expect(privateSettingsView(saved).settings)
      .toMatchObject({
        settingsRevision: 1,
        uiLocalePreference: "ko",
        showBridgeThreadsInCodexApp: true,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      });

    const emptyPatch = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        operation: { kind: "patch", settings: {} }
      }
    });
    expect(emptyPatch.isError).toBe(true);
    expect(JSON.stringify(emptyPatch)).toContain("SETTINGS_PATCH_EMPTY");

    const mixed = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        operation: { kind: "reset" },
        uiLocalePreference: "en"
      }
    });
    expect(mixed.isError).toBe(true);
    expect(JSON.stringify(mixed)).toContain("Unrecognized key");

    const reset = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, operation: { kind: "reset" } }
    });
    expect(privateSettingsView(reset).settings)
      .toMatchObject({
        settingsRevision: 2,
        uiLocalePreference: "auto",
        showBridgeThreadsInCodexApp: false,
        activityCardVisibility: "always",
        completionHandoff: "off"
      });
    await close();
  });

  it("rechecks the Settings revision immediately before commit after catalog validation", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const catalog = new MutatingModelCatalog();
    catalog.beforeRefresh = () => settings.update({ uiLocalePreference: "ko" }, 0);
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      catalog,
      settings
    );

    const raced = await client.callTool({
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
    expect(raced.isError).toBe(true);
    expect(JSON.stringify(raced)).toContain("SETTINGS_REVISION_CONFLICT");
    expect(settings.current).toMatchObject({
      revision: 1,
      uiLocalePreference: "ko",
      modelPolicy: { mode: "automatic" }
    });
    await close();
  });

  it("rejects an expired Activity layout sent by a stale Settings card", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        activityCardView: "activity-summary",
        uiLocalePreference: "ko"
      }
    });
    expect(saved.isError).toBe(true);
    expect(JSON.stringify(saved)).toContain("Unrecognized key");

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).not.toHaveProperty("activityCardView");
    await close();
  });

  it("saves unrelated preferences without reactivating an unchanged model policy", async () => {
    const root = temporaryRoot();
    const catalog = new StaleModelCatalog();
    const { client, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream(),
      undefined,
      catalog
    );
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        uiLocalePreference: "ko"
      }
    });
    expect(saved.isError).not.toBe(true);
    expect(privateSettingsView(saved).settings)
      .toMatchObject({ settingsRevision: 1, uiLocalePreference: "ko" });
    expect(catalog.calls.some((call) => call.refresh === true)).toBe(false);

    const changed = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("fresh backend model catalog");
    await close();
  });

  it("keeps Activity card visibility independent from foreground/background execution", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const { client, rawCallTool, close } = await connectTestClient(config, new FakeUpstream());
    const stableTaskDescriptor = structuredClone(
      (await client.listTools()).tools.find((tool) => tool.name === "codex_task")
    );

    const alwaysForeground = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "discuss with a visible card",
        sessionMode: "new",
        activityKind: "discussion",
        executionMode: "foreground"
      }
    });
    expect(parseToolJson(alwaysForeground)).toMatchObject({
      executionMode: "foreground"
    });
    expect((alwaysForeground as { _meta?: Record<string, unknown> })._meta).toBeUndefined();
    const alwaysActivityId = parseToolJson(alwaysForeground).activityId as string;
    const alwaysCard = await presentCompactActivity(
      client,
      alwaysActivityId,
      "23232323-2323-4323-8323-232323232323"
    );
    expect(privateActivityView(alwaysCard)).toMatchObject({
      mountedPresentation: { kind: "automatic" },
      watcherPolicy: { ownsCompletionHandoff: true },
      feed: { mode: "compact" }
    });

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, activityCardVisibility: "background-only" }
    });
    const backgroundOnlyTools = await client.listTools();
    const backgroundOnlyTaskDescriptor = backgroundOnlyTools.tools.find(
      (tool) => tool.name === "codex_task"
    );
    expect(backgroundOnlyTaskDescriptor?._meta).toBeUndefined();
    expect(backgroundOnlyTaskDescriptor).toEqual(stableTaskDescriptor);
    const groupedPresentation = "24242424-0000-4000-8000-000000000010";
    const backgroundOnlyForeground = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "foreground without automatic card",
        sessionMode: "new",
        executionMode: "foreground"
      }
    });
    const backgroundOnlyForegroundTask = parseToolJson(backgroundOnlyForeground);
    expect(backgroundOnlyForegroundTask.nextActions.join(" ")).not.toContain(
      "render at most one compact Activity card"
    );
    expect((backgroundOnlyForeground as { _meta?: Record<string, unknown> })._meta)
      .toBeUndefined();
    const foregroundPresentation = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "compact-monitor",
        presentationId: groupedPresentation,
        activityId: backgroundOnlyForegroundTask.activityId
      }
    });
    expect(foregroundPresentation.isError).toBe(true);
    expect(JSON.stringify(foregroundPresentation)).toContain("ACTIVITY_CARD_VISIBILITY_DISABLED");

    const backgroundOnlyBackgroundResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "background with automatic card",
        sessionMode: "new"
      }
    });
    const backgroundOnlyBackground = parseToolJson(backgroundOnlyBackgroundResult);
    expect(backgroundOnlyBackground).toMatchObject({
      status: "running",
      executionMode: "background"
    });
    expect(backgroundOnlyBackground.nextActions.join(" ")).toContain(
      "render at most one compact Activity card"
    );
    expect((backgroundOnlyBackgroundResult as { _meta?: Record<string, unknown> })._meta)
      .toBeUndefined();
    const backgroundPresentation = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "compact-monitor",
        presentationId: groupedPresentation,
        activityId: backgroundOnlyBackground.activityId
      }
    });
    expect(backgroundPresentation.isError).not.toBe(true);
    expect(privateActivityView(backgroundPresentation)).toMatchObject({
      mountedPresentation: {
        kind: "automatic",
        activityPresentationId: groupedPresentation
      },
      watcherPolicy: { live: true, ownsCompletionHandoff: true },
      feed: { mode: "compact" }
    });
    const secondBackgroundResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "same response second background call",
        sessionMode: "new"
      }
    });
    expect((secondBackgroundResult as { _meta?: Record<string, unknown> })._meta).toBeUndefined();

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, activityCardVisibility: "never", completionHandoff: "off" }
    });
    const neverTools = await client.listTools();
    expect(neverTools.tools.find((tool) => tool.name === "codex_task")?._meta)
      .toBeUndefined();
    const neverTaskDescriptor = neverTools.tools.find((tool) => tool.name === "codex_task");
    expect(neverTaskDescriptor).toEqual(stableTaskDescriptor);
    expect((neverTaskDescriptor?.inputSchema as { required?: string[] }).required)
      .not.toContain("activityPresentationId");
    const neverBackgroundResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "background without automatic card",
        sessionMode: "new"
      }
    });
    expect(parseToolJson(neverBackgroundResult)).toMatchObject({
      state: "running",
      executionMode: "background"
    });
    const neverBackground = parseToolJson(neverBackgroundResult);
    expect((neverBackgroundResult as { _meta?: Record<string, unknown> })._meta)
      .toBeUndefined();
    const neverPresentation = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "compact-monitor",
        presentationId: "25252525-2525-4525-8525-252525252525",
        activityId: neverBackground.activityId
      }
    });
    expect(neverPresentation.isError).toBe(true);
    expect(JSON.stringify(neverPresentation)).toContain("ACTIVITY_CARD_VISIBILITY_DISABLED");
    const neverWithoutPresentationResult = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "24242424-0000-4000-8000-000000000012",
        prompt: "never accepts a stale descriptor without presentation",
        project: { name: "Test Project", registryRevision: 1 },
        activity: {
          mode: "new",
          title: "Never visibility current contract",
          policy: { kind: "other" }
        },
        agent: { mode: "new", name: "Never Visibility Agent" }
      }
    });
    expect(parseToolJson(neverWithoutPresentationResult).state).toBe("running");
    expect((neverWithoutPresentationResult as { _meta?: Record<string, unknown> })._meta || {})
      .not.toHaveProperty(ACTIVITY_BOOTSTRAP_METADATA_KEY);
    const explicitCard = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A }
    });
    expect(parseToolJson(explicitCard))
      .toMatchObject({ activityCardVisibility: "never", activities: expect.any(Array) });

    const impossible = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 2, completionHandoff: "auto-handoff" }
    });
    expect(impossible.isError).toBe(true);
    expect(JSON.stringify(impossible)).toContain("requires the Activity card");
    const restored = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 2, activityCardVisibility: "always" }
    });
    expect(restored.isError).not.toBe(true);
    expect((await client.listTools()).tools.find((tool) => tool.name === "codex_task")?._meta)
      .toBeUndefined();
    await close();
  });

  it("exposes only policy-permitted sandbox values", async () => {
    const root = temporaryRoot();
    const readClient = await connectTestClient(configFor(root), new FakeUpstream());
    let schema = (await readClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual(["read-only"]);
    await readClient.close();

    const writeClient = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      new FakeUpstream()
    );
    schema = (await writeClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual(["read-only", "workspace-write"]);
    await writeClient.close();

    const fullClient = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
      }),
      new FakeUpstream()
    );
    schema = (await fullClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access"
    ]);
    await fullClient.close();
  });

  it("keeps a stable sandbox field and rejects overrides in fixed access modes", async () => {
    const root = temporaryRoot();
    const readConfig = configFor(root);
    const readSettings = new UserSettingsStore(readConfig);
    readSettings.update({ accessStrategy: "read-only" }, readSettings.current.revision);
    const readUpstream = new FakeUpstream();
    const readClient = await connectTestClient(
      readConfig,
      readUpstream,
      undefined,
      new FakeModelCatalog(),
      readSettings
    );
    let task = (await readClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties?.sandbox).toMatchObject({ enum: ["read-only"] });
    expect(task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    });
    const staleReadOverride = await readClient.client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "stale override",
        sandbox: "read-only"
      }
    });
    expect(staleReadOverride.isError).toBe(true);
    expect(JSON.stringify(staleReadOverride)).toContain("SANDBOX_OVERRIDE_UNAVAILABLE");
    await runTask(readClient.client, {
      prompt: "fixed read",
      agentName: "Read Agent",
      contextMode: "fresh"
    });
    expect(readUpstream.calls[0]?.args.sandbox).toBe("read-only");
    await readClient.close();

    const fullConfig = configFor(root, { CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" });
    const fullSettings = new UserSettingsStore(fullConfig);
    fullSettings.update({ accessStrategy: "always-full" }, fullSettings.current.revision);
    const fullUpstream = new FakeUpstream();
    const fullClient = await connectTestClient(
      fullConfig,
      fullUpstream,
      undefined,
      new FakeModelCatalog(),
      fullSettings
    );
    task = (await fullClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties?.sandbox).toMatchObject({
      enum: ["read-only", "danger-full-access"]
    });
    expect(task.inputSchema.properties).not.toHaveProperty("cwd");
    expect(task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
    await runTask(fullClient.client, {
      prompt: "fixed full",
      agentName: "Full Agent",
      contextMode: "fresh"
    });
    expect(fullUpstream.calls[0]?.args.sandbox).toBe("danger-full-access");
    await fullClient.close();
  });

  it("rejects a stale read-only descriptor before an always-full call can admit side effects", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".env"), "SECRET=must-not-be-scanned-by-stale-call\n");
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
    });
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, settings, close } = await connectTestClient(config, upstream);
    const staleRef = settings.executionPolicyRef(
      settings.current,
      modelCatalogAdmissionFingerprint(new FakeModelCatalog().getCachedCatalog().models)
    );
    const target = settings.current.projects[0]!;
    const project = {
      name: target.name,
      projectRef: target.projectRef,
      projectRevision: target.projectRevision
    };

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        accessStrategy: "always-full"
      }
    });
    const rejected = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "28282828-2828-4828-8828-282828282828",
        prompt: "must not reinterpret stale omission as full access",
        executionPolicyRef: staleRef,
        project,
        activity: { mode: "new" },
        agent: { mode: "new", name: "Stale Policy Agent" },
        executionMode: "foreground"
      }
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "EXECUTION_POLICY_CHANGED", retryable: true }
      }
    });
    expect(JSON.stringify(rejected)).not.toContain("sensitive");
    expect(upstream.calls).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listForScope(SCOPE_A)).toEqual([]);
    await close();
  });

  it("invalidates the stable envelope when the operator disables sensitive-file preflight", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".env"), "SECRET=operator-policy-race\n");

    const guarded = await connectTestClient(configFor(root), new FakeUpstream());
    const guardedTask = (await guarded.client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    const staleEnvelopeRef = (
      guardedTask.inputSchema.properties?.executionEnvelopeRef as { const: string }
    ).const;
    await guarded.close();

    const upstream = new FakeUpstream();
    const unguarded = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN: "1" }),
      upstream
    );
    const currentTask = (await unguarded.client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    const currentEnvelopeRef = (
      currentTask.inputSchema.properties?.executionEnvelopeRef as { const: string }
    ).const;
    expect(currentEnvelopeRef).not.toBe(staleEnvelopeRef);
    const target = unguarded.settings.current.projects[0]!;
    const project = {
      name: target.name,
      projectRef: target.projectRef,
      projectRevision: target.projectRevision
    };

    const rejected = await unguarded.bareCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "29292929-2929-4929-8929-292929292929",
        prompt: "the old preflight policy must not cross the restart boundary",
        taskContractVersion: CODEX_TASK_INPUT_CONTRACT_VERSION,
        executionEnvelopeRef: staleEnvelopeRef,
        project,
        activity: { mode: "new" },
        agent: { mode: "new", name: "Preflight Policy Agent" },
        executionMode: "foreground"
      }
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "EXECUTION_ENVELOPE_CHANGED", retryable: true }
      }
    });
    expect(upstream.calls).toEqual([]);
    expect(unguarded.jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
    expect(unguarded.jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(unguarded.jobs.listForScope(SCOPE_A)).toEqual([]);
    await unguarded.close();
  });

  it("rejects a missing execution policy reference before project availability probing", async () => {
    const root = temporaryRoot();
    const displaced = `${root}-offline`;
    const upstream = new FakeUpstream();
    const connection = await connectTestClient(configFor(root), upstream);
    try {
      const target = connection.settings.current.projects[0]!;
      const project = {
        name: target.name,
        projectRef: target.projectRef,
        projectRevision: target.projectRevision
      };
      renameSync(root, displaced);

      const rejected = await connection.bareCallTool({
        name: "codex_task",
        arguments: {
          scopeId: SCOPE_A,
          requestId: "30303030-3030-4030-8030-303030303030",
          prompt: "a pre-reference call must not probe the project folder",
          project,
          activity: { mode: "new" },
          agent: { mode: "new", name: "Missing Policy Ref Agent" },
          executionMode: "foreground"
        }
      });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "EXECUTION_POLICY_CHANGED", retryable: true }
        }
      });
      expect(JSON.stringify(rejected)).not.toContain("PROJECT_UNAVAILABLE");
      expect(upstream.calls).toEqual([]);
      expect(connection.jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
      expect(connection.jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
      expect(connection.jobs.listForScope(SCOPE_A)).toEqual([]);
    } finally {
      if (existsSync(displaced) && !existsSync(root)) renameSync(displaced, root);
      await connection.close();
    }
  });

  it("keeps the complete task descriptor stable across presentation-only settings changes", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, settings, close } = await connectTestClient(configFor(root), upstream);
    const before = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    const beforePolicyRef = settings.executionPolicyRef();
    settings.update({
      uiLocalePreference: "ko",
      activityCardVisibility: "never"
    }, settings.current.revision);
    await client.callTool({ name: "codex_models", arguments: {} });
    const after = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    expect(after).toEqual(before);
    expect(settings.executionPolicyRef()).toBe(beforePolicyRef);
    expect(after.description).not.toContain("visibility policy is 'never'");

    settings.update({ maxConcurrentJobs: 2 }, settings.current.revision);
    expect(settings.executionPolicyRef()).not.toBe(beforePolicyRef);
    expect((await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )).toEqual(before);

    const executed = await runTask(client, {
      prompt: "presentation-only change keeps execution admission valid"
    });
    expect(executed.isError).not.toBe(true);
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("keys execution policy refs per installation and canonicalizes selection sets", () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const sharedState = new BridgeStateStore({ file: ":memory:" });
    const otherState = new BridgeStateStore({ file: ":memory:" });
    try {
      const first = new UserSettingsStore(config, { stateStore: sharedState });
      const restarted = new UserSettingsStore(config, { stateStore: sharedState });
      const otherInstall = new UserSettingsStore(config, { stateStore: otherState });
      expect(restarted.executionPolicyRef()).toBe(first.executionPolicyRef());
      expect(otherInstall.executionPolicyRef()).not.toBe(first.executionPolicyRef());
      expect(first.executionPolicyRef(first.current, "a".repeat(64)))
        .not.toBe(first.executionPolicyRef(first.current, "b".repeat(64)));

      const choices = [
        { model: "gpt-5.6-sol", reasoningEffort: "max" },
        { model: "gpt-5.6-terra", reasoningEffort: "high" }
      ];
      const policyBase = {
        mode: "automatic" as const,
        fallbackSelection: choices[0],
        constraints: { allowDelegation: false }
      };
      const forward = {
        ...first.current,
        modelPolicy: {
          ...policyBase,
          allowedSelections: { kind: "explicit" as const, selections: choices }
        }
      };
      const reversed = {
        ...forward,
        modelPolicy: {
          ...policyBase,
          allowedSelections: { kind: "explicit" as const, selections: [...choices].reverse() }
        }
      };
      expect(first.executionPolicyRef(reversed)).toBe(first.executionPolicyRef(forward));
    } finally {
      sharedState.close();
      otherState.close();
    }
  });

  it("projects and enforces the immutable exact operator model ceiling", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING:
        '[{"model":"gpt-5.6-sol","reasoningEffort":"max"}]'
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties?.selection).toMatchObject({
      type: "object",
      required: ["model", "reasoningEffort"],
      additionalProperties: false
    });
    expect(JSON.stringify(task.inputSchema.properties?.selection)).not.toContain("gpt-5.6-sol");
    const settings = await client.callTool({ name: "codex_settings_snapshot", arguments: {} });
    expect(privateSettingsView(settings))
      .toMatchObject({
        capabilities: {
          operatorModelCeiling: [{ model: "gpt-5.6-sol", reasoningEffort: "max" }]
        }
      });
    const widened = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(widened.isError).toBe(true);
    expect(JSON.stringify(widened)).toContain("MODEL_POLICY_CHANGED");
    await close();
  });

  it("starts a sanitized read-only session by default", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", sessionMode: "new" }
    });
    expect(upstream.calls).toEqual([
      {
        name: "codex",
        args: {
          prompt: "inspect",
          cwd: realpathSync(root),
          sandbox: "read-only",
          "approval-policy": "on-request",
          model: "gpt-5.6-sol",
          config: { model_reasoning_effort: "max" }
        }
      }
    ]);

    await close();
  });

  it("maps the Codex-app visibility preference only to new App Server threads", async () => {
    const root = temporaryRoot();
    const config = configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" });
    const upstream = new FakeUpstream();
    const settings = new UserSettingsStore(config);
    settings.update({ showBridgeThreadsInCodexApp: false }, settings.current.revision);
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    await runTask(client, { prompt: "hidden App Server thread", sessionMode: "new" });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: { ephemeral: true }
    });

    settings.update({ showBridgeThreadsInCodexApp: true }, settings.current.revision);
    // This preference is app-private. A normal Settings-card save publishes
    // immediately; this fixture mutates the store directly, so use the normal
    // catalog/reconcile path to project the new complete descriptor.
    await client.callTool({ name: "codex_models", arguments: {} });
    await runTask(client, { prompt: "visible App Server thread", sessionMode: "new" });
    expect(upstream.calls[1]).toMatchObject({
      name: "codex",
      args: { ephemeral: false }
    });
    await close();

    const mcpUpstream = new FakeUpstream();
    const mcpConfig = configFor(root);
    const mcpSettings = new UserSettingsStore(mcpConfig);
    mcpSettings.update({ showBridgeThreadsInCodexApp: false }, mcpSettings.current.revision);
    const mcpClient = await connectTestClient(
      mcpConfig,
      mcpUpstream,
      undefined,
      new FakeModelCatalog(),
      mcpSettings
    );
    await runTask(mcpClient.client, { prompt: "MCP thread", sessionMode: "new" });
    expect(mcpUpstream.calls[0]?.args).not.toHaveProperty("ephemeral");
    await mcpClient.close();
  });

  it("creates and reuses one explicit Activity across parallel background Codex jobs", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    const firstResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel part one",
        agentName: "Investigator One",
        contextMode: "fresh",
        activityTitle: "Parallel investigation",
        activityKind: "investigation",
        executionMode: "background",
        handoffPolicy: "none",
        completionTrigger: "manual"
      }
    });
    const first = parseToolJson(firstResult);
    expect(first).toMatchObject({
      status: "running",
      terminal: false,
      executionMode: "background"
    });
    expect((firstResult as { _meta?: Record<string, unknown> })._meta).toBeUndefined();
    expect(first.activityId).toMatch(SCOPE_ID_PATTERN);
    expect(jobs.getActivity(first.activityId)).toMatchObject({
      title: "Parallel investigation",
      kind: "investigation",
      executionMode: "background",
      handoffPolicy: "none",
      completionTrigger: "manual",
      lifecycle: "open",
      waitingOn: "codex",
      counts: { total: 1, running: 1 }
    });

    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel part two",
        agentName: "Investigator Two",
        contextMode: "fresh",
        activityId: first.activityId,
        executionMode: "background"
      }
    }));
    expect(second.activityId).toBe(first.activityId);
    expect(second.jobId).not.toBe(first.jobId);
    expect(jobs.getActivity(first.activityId)).toMatchObject({ counts: { total: 2, running: 2 } });
    const compactPresentation = await presentCompactActivity(
      client,
      first.activityId,
      "53535353-5353-4353-8353-535353535353"
    );
    expect(privateActivityView(compactPresentation)).toMatchObject({
      mountedPresentation: { kind: "automatic" },
      feed: {
        mode: "compact",
        active: [expect.objectContaining({
          activityId: first.activityId,
          agents: expect.arrayContaining([
            expect.objectContaining({ agentName: "Investigator One" }),
            expect.objectContaining({ agentName: "Investigator Two" })
          ])
        })]
      }
    });

    const policyInjection = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must not mutate policy",
        activity: { mode: "existing", id: first.activityId, policy: { handoff: "notify" } }
      }
    });
    expect(policyInjection.isError).toBe(true);
    expect(JSON.stringify(policyInjection)).toContain("Unrecognized key");
    expect(upstream.calls).toHaveLength(2);

    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await waitForJobStatus(client, first.jobId, "completed");
    await waitForJobStatus(client, second.jobId, "completed");
    expect(jobs.getActivity(first.activityId)).toMatchObject({
      lifecycle: "open",
      waitingOn: "orchestrator",
      handoffPolicy: "none",
      counts: { total: 2, completed: 2, terminal: 2 }
    });

    const stalePolicy = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: 1,
        operation: { kind: "set-policy", policy: { handoff: "notify" } }
      }
    });
    expect(stalePolicy.isError).toBe(true);
    expect(JSON.stringify(stalePolicy)).toContain("Activity version changed");
    expect(jobs.getActivity(first.activityId)).toMatchObject({ handoffPolicy: "none" });

    const missingVersion = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        operation: { kind: "set-policy", policy: { handoff: "notify" } }
      }
    });
    expect(missingVersion.isError).toBe(true);
    expect(JSON.stringify(missingVersion)).toContain("expectedVersion");
    const mixedContract = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: jobs.getActivity(first.activityId)?.version,
        operation: { kind: "set-policy", policy: { handoff: "notify" } },
        handoffPolicy: "verify"
      }
    });
    expect(mixedContract.isError).toBe(true);
    expect(JSON.stringify(mixedContract)).toContain("Unrecognized key");
    const emptyPolicy = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: jobs.getActivity(first.activityId)?.version,
        operation: { kind: "set-policy", policy: {} }
      }
    });
    expect(emptyPolicy.isError).toBe(true);
    expect(JSON.stringify(emptyPolicy)).toContain("requires at least one Activity policy field");
    const updatedPolicy = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: jobs.getActivity(first.activityId)?.version,
        operation: { kind: "set-policy", policy: { handoff: "notify" } }
      }
    }));
    expect(updatedPolicy).toMatchObject({
      target: { type: "activity", id: first.activityId, state: "open", version: expect.any(Number) },
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
    });
    expect(jobs.getActivity(first.activityId)).toMatchObject({ handoffPolicy: "notify" });

    const completed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: updatedPolicy.target.version,
        operation: {
          kind: "complete",
          reason: "The orchestrator accepted both investigation results"
        }
      }
    }));
    expect(completed).toMatchObject({
      action: "complete",
      target: { type: "activity", id: first.activityId, state: "completed" },
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
    });
    expect(jobs.getActivity(first.activityId)).toMatchObject({
      lifecycle: "completed",
      waitingOn: "none",
      completionVersion: 1
    });
    await close();
  });

  it("reuses one Agent across linked Activities and maps continue, fork, and fresh context exactly", async () => {
    const root = temporaryRoot();
    const upstream = new ForkLifecycleUpstream();
    const { client, jobs, settings, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const project = settings.current.projects[0];

    const first = await runTask(client, {
      prompt: "establish context",
      agentName: "Long-lived Agent",
      contextMode: "fresh",
      activityTitle: "Original Activity"
    });
    const firstStructured = parseToolJson(first);
    const sourceActivityId = firstStructured.activityId;
    const agentId = firstStructured.agentId;
    expect(firstStructured.threadId).toBe("thread-1");
    expect(firstStructured.projectName).toBe("Test Project");
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "thread-1" });
    expect(jobs.listActivityAgentAssignments(sourceActivityId, agentId)).toEqual([
      expect.objectContaining({ contextMode: "fresh", releasedAt: expect.any(Number) })
    ]);

    await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: sourceActivityId,
        expectedVersion: jobs.getActivity(sourceActivityId)?.version,
        operation: { kind: "complete", reason: "Original goal accepted" }
      }
    });
    const linked = await runTask(client, {
      prompt: "continue into a separately verifiable goal",
      continuationOfActivityId: sourceActivityId,
      activityTitle: "Linked Activity",
      agentId,
      contextMode: "continue"
    });
    const linkedStructured = parseToolJson(linked);
    const linkedActivityId = linkedStructured.activityId;
    expect(linkedActivityId).not.toBe(sourceActivityId);
    expect(linkedStructured.threadId).toBe("thread-1");
    expect(jobs.getActivity(sourceActivityId)).toMatchObject({ lifecycle: "completed" });
    expect(jobs.getActivity(linkedActivityId)).toMatchObject({
      lifecycle: "open",
      continuationOfActivityId: sourceActivityId,
      projectId: project.id,
      projectLabel: "Test Project",
      cardGeneration: 1
    });
    expect(upstream.calls[1]).toMatchObject({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "continue into a separately verifiable goal" }
    });

    const forkRequestId = "35353535-3535-4535-8535-353535353535";
    const forkArguments = {
      requestId: forkRequestId,
      prompt: "independently verify the approach",
      activityId: linkedActivityId,
      agentId,
      contextMode: "fork"
    };
    const forked = await runTask(client, forkArguments);
    const forkedStructured = parseToolJson(forked);
    expect(forkedStructured.threadId).toBe("thread-forked");
    expect(forkedStructured.projectName).toBe("Test Project");
    expect(upstream.calls[2]).toMatchObject({
      name: "codex-fork",
      args: { threadId: "thread-1", prompt: "independently verify the approach" }
    });
    const forkRetry = await runTask(client, {
      ...forkArguments,
      activityPresentationId: "36363636-3636-4636-8636-363636363636"
    });
    expect(parseToolJson(forkRetry)).toMatchObject({
      threadId: "thread-forked",
      activityId: linkedActivityId,
      jobId: forkedStructured.jobId
    });
    expect(upstream.calls).toHaveLength(3);

    const fresh = await runTask(client, {
      prompt: "start unrelated context with the same logical Agent",
      activityTitle: "Fresh Activity",
      agentId,
      contextMode: "fresh"
    });
    expect((fresh as { structuredContent?: Record<string, any> }).structuredContent?.threadId)
      .toBe("thread-2");
    expect(upstream.calls[3]?.name).toBe("codex");
    const history = jobs.listAgentThreads(agentId);
    expect(history).toHaveLength(3);
    expect(history.find((thread) => thread.threadId === "thread-1")).toMatchObject({
      isCurrent: false,
      contextMode: "fresh",
      projectId: project.id,
      projectLabel: "Test Project"
    });
    expect(history.find((thread) => thread.threadId === "thread-forked")).toMatchObject({
      isCurrent: false,
      contextMode: "fork",
      sessionId: "session-tree-1",
      projectId: project.id,
      projectLabel: "Test Project",
      forkedFromThreadId: "thread-1"
    });
    expect(history.find((thread) => thread.threadId === "thread-2")).toMatchObject({
      isCurrent: true,
      contextMode: "fresh",
      projectId: project.id,
      projectLabel: "Test Project"
    });
    expect(jobs.getAgent(agentId)).toMatchObject({
      agentId,
      agentName: "Long-lived Agent",
      lifecycle: "idle",
      currentThreadId: "thread-2"
    });
    await close();
  });

  it("keeps an MCP Agent pinned and requires an explicit summary-only handoff for a fresh App Server thread", async () => {
    const root = realpathSync(temporaryRoot());
    const config = configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" });
    const upstream = new FakeUpstream();
    const stateStore = new BridgeStateStore({ file: ":memory:" });
    const settings = new UserSettingsStore(config, { stateStore });
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Pinned Project", cwd: root } }],
      undefined,
      0
    );
    const project = settings.current.projects[0];
    const sessions = new SessionRegistry({ allowedRoots: [root], stateStore });
    const jobs = new CodexJobRegistry({ allowedRoots: [root], stateStore });
    const agent = jobs.createAgent({ scopeId: SCOPE_A, agentName: "Pinned MCP Agent" });
    jobs.linkAgentThread({
      agentId: agent.agentId,
      threadId: "mcp-thread",
      projectId: project.id,
      projectLabel: project.name,
      backendKind: "mcp-server",
      cwd: root,
      sandbox: "read-only",
      contextMode: "fresh"
    });
    sessions.record({
      threadId: "mcp-thread",
      scopeId: SCOPE_A,
      backendKind: "mcp-server",
      cwd: root,
      projectId: project.id,
      projectLabel: project.name,
      sandbox: "read-only",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      policyRevision: 0,
      updatedAt: 1,
      createdAt: 1,
      lastUsedAt: 1
    });
    const { client, close } = await connectTestClient(
      config,
      upstream,
      sessions,
      new FakeModelCatalog(),
      settings,
      jobs
    );

    const settingsResult = await client.callTool({ name: "codex_settings", arguments: {} });
    expect((settingsResult as { structuredContent?: Record<string, any> }).structuredContent?.warnings)
      .toEqual(expect.arrayContaining([
        expect.stringContaining("Existing Agent threads remain pinned"),
        expect.stringContaining("handoffSummary")
      ]));

    const continued = await runTask(client, {
      prompt: "continue on the pinned backend",
      activityTitle: "Pinned continuation",
      agent: { mode: "existing", id: agent.agentId, context: "continue" }
    });
    expect(continued).toMatchObject({ structuredContent: { threadId: "mcp-thread" } });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex-reply",
      args: { threadId: "mcp-thread", prompt: "continue on the pinned backend" }
    });

    const missing = await runTask(client, {
      prompt: "move to the configured backend",
      activityTitle: "Backend handoff",
      agent: { mode: "existing", id: agent.agentId, context: "fresh" }
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "BACKEND_HANDOFF_SUMMARY_REQUIRED",
          contextContinuity: "not-migrated"
        }
      }
    });
    expect(upstream.calls).toHaveLength(1);

    const summary = "Completed repository audit; continue with the two remaining implementation gaps.";
    const handoffRequestId = "82828282-8282-4282-8282-828282828282";
    const handoffArgs = {
      requestId: handoffRequestId,
      activityPresentationId: handoffRequestId,
      prompt: "implement the remaining gaps",
      activityTitle: "Backend handoff",
      agent: {
        mode: "existing",
        id: agent.agentId,
        context: "fresh",
        handoffSummary: summary
      }
    };
    const handedOff = await runTask(client, handoffArgs);
    const handedOffStructured = parseToolJson(handedOff);
    expect(handedOffStructured).toMatchObject({ threadId: "thread-1" });
    expect(jobs.get(handedOffStructured.jobId)?.sessionDecision).toMatchObject({
      handoff: {
        sourceBackend: "mcp-server",
        targetBackend: "app-server",
        sourceThreadId: "mcp-thread",
        continuity: "explicit-summary-only",
        summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    });
    expect(upstream.calls[1]).toMatchObject({ name: "codex" });
    expect(String(upstream.calls[1]?.args.prompt)).toContain("No transcript, hidden context");
    expect(String(upstream.calls[1]?.args.prompt)).toContain(summary);
    expect(JSON.stringify(handedOff)).not.toContain(summary);
    const exactRetry = await runTask(client, handoffArgs);
    expect(exactRetry).toMatchObject({ structuredContent: { threadId: "thread-1" } });
    const changedSummary = await runTask(client, {
      ...handoffArgs,
      agent: { ...handoffArgs.agent, handoffSummary: `${summary} changed` }
    });
    expect(changedSummary.isError).toBe(true);
    expect(JSON.stringify(changedSummary)).toContain("already used for a different Codex task");
    expect(upstream.calls).toHaveLength(2);
    expect(jobs.listAgentThreads(agent.agentId)).toEqual([
      expect.objectContaining({
        threadId: "mcp-thread",
        backendKind: "mcp-server",
        isCurrent: false
      }),
      expect.objectContaining({
        threadId: "thread-1",
        backendKind: "app-server",
        contextMode: "fresh",
        isCurrent: true
      })
    ]);
    await close();
    stateStore.close();
  });

  it("manages Agent lifecycle through one scope-local idempotent tool without deleting history", async () => {
    const root = temporaryRoot();
    const upstream = new ManagedDeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ENABLE_RECOVERY_TOOLS: "1" }),
      upstream
    );
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "long-running turn",
        agentName: "Managed Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const agentId = started.agentId;
    const busyRequestId = "10101010-1010-4010-8010-101010101010";
    const busy = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: { requestId: busyRequestId, agentId, action: "archive" }
    }));
    expect(busy).toMatchObject({
      ok: false,
      code: "AGENT_BUSY",
      nextActions: [`codex_cancel(${started.jobId})`],
      warnings: [expect.stringContaining("does not roll back filesystem changes")]
    });

    const activeDetach = await client.callTool({
      name: "codex_agent_recovery_detach",
      arguments: {
        requestId: "11111111-2020-4020-8020-202020202020",
        agentId,
        activityId: started.activityId,
        expectedAgentVersion: jobs.getAgent(agentId)?.version
      }
    });
    expect(activeDetach.isError).toBe(true);
    expect(JSON.stringify(activeDetach)).toContain("AGENT_BUSY");
    expect(jobs.listActivityAgentAssignments(started.activityId, agentId)[0]?.releasedAt)
      .toBeUndefined();

    upstream.resolveNext(fakeCodexResult("managed-thread"));
    await waitForJobStatus(client, started.jobId, "completed");
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "managed-thread" });
    expect(jobs.listActivityAgentAssignments(started.activityId, agentId)[0]?.releasedAt)
      .toEqual(expect.any(Number));
    const busyReplay = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: { requestId: busyRequestId, agentId, action: "archive" }
    }));
    expect(busyReplay).toEqual(busy);
    expect(jobs.getAgent(agentId)?.lifecycle).toBe("idle");

    const detachedActivity = jobs.createActivity({ scopeId: SCOPE_A, title: "Detached assignment" });
    jobs.assignAgent({ activityId: detachedActivity.activityId, agentId, contextMode: "continue" });
    const detachVersion = jobs.getAgent(agentId)?.version as number;
    const detached = parseToolJson(await client.callTool({
      name: "codex_agent_recovery_detach",
      arguments: {
        requestId: "20202020-2020-4020-8020-202020202020",
        agentId,
        activityId: detachedActivity.activityId,
        expectedAgentVersion: detachVersion
      }
    }));
    expect(detached).toMatchObject({
      ok: true,
      action: "recovery-detach",
      alreadyReleased: false,
      historyPreserved: true,
      agent: { version: detachVersion + 1 }
    });
    expect(jobs.listActivityAgentAssignments(detachedActivity.activityId, agentId)[0]?.releasedAt)
      .toEqual(expect.any(Number));
    const detachReplay = parseToolJson(await client.callTool({
      name: "codex_agent_recovery_detach",
      arguments: {
        requestId: "20202020-2020-4020-8020-202020202020",
        agentId,
        activityId: detachedActivity.activityId,
        expectedAgentVersion: detachVersion
      }
    }));
    expect(detachReplay).toEqual(detached);

    const renameArguments = {
      requestId: "30303030-3030-4030-8030-303030303030",
      agentId,
      operation: { kind: "rename", name: "Renamed Agent" }
    } as const;
    const renamed = parseToolJson(await client.callTool({ name: "codex_agent", arguments: renameArguments }));
    const renameReplay = parseToolJson(await client.callTool({ name: "codex_agent", arguments: renameArguments }));
    expect(renameReplay).toEqual(renamed);
    expect(renamed).toMatchObject({
      ok: true,
      action: "rename",
      target: { type: "agent", id: agentId }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ agentName: "Renamed Agent" });
    expect(jobs.listAgentThreads(agentId)).toHaveLength(1);
    const changedRetry = await client.callTool({
      name: "codex_agent",
      arguments: {
        ...renameArguments,
        operation: { kind: "rename", name: "Different Name" }
      }
    });
    expect(changedRetry.isError).toBe(true);
    expect(JSON.stringify(changedRetry)).toContain("already used for a different Agent mutation");
    const mixedContract = await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "31313131-3131-4131-8131-313131313131",
        agentId,
        operation: { kind: "rename", name: "Nested Name" },
        agentName: "Legacy Name"
      }
    });
    expect(mixedContract.isError).toBe(true);
    expect(JSON.stringify(mixedContract)).toContain("Unrecognized key");

    jobs.setAgentExecutionState(agentId, "orphaned", {
      orphanedReason: "Transient session metadata was unavailable before recovery."
    });

    const archived = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "40404040-4040-4040-8040-404040404040",
        agentId,
        operation: { kind: "archive" }
      }
    }));
    expect(archived).toMatchObject({
      ok: true,
      target: { type: "agent", id: agentId, state: "archived" }
    });
    expect(upstream.archivedThreads).toEqual([]);
    const card = await client.callTool({ name: "codex_activity", arguments: {} });
    const cardView = parseToolJson(card);
    expect(cardView.agents).not.toEqual(expect.arrayContaining([expect.objectContaining({ agentId })]));
    expect(cardView.archivedAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId, canRestore: true })
    ]));

    const restored = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "50505050-5050-4050-8050-505050505050",
        agentId,
        operation: { kind: "restore" }
      }
    }));
    expect(restored).toMatchObject({
      ok: true,
      target: { type: "agent", id: agentId, state: "idle" }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({
      agentName: "Renamed Agent",
      lifecycle: "idle"
    });
    expect(upstream.restoredThreads).toEqual([]);

    const crossScope = await rawCallTool({
      name: "codex_agent",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "60606060-6060-4060-8060-606060606060",
        agentId,
        operation: { kind: "archive" }
      }
    });
    expect(crossScope.isError).toBe(true);
    expect(JSON.stringify(crossScope)).toContain("another conversation scope");
    expect(jobs.getAgent(agentId)).toMatchObject({
      lifecycle: "idle",
      currentThreadId: "managed-thread",
      agentName: "Renamed Agent"
    });
    await close();
  });

  it("keeps recovery detach disabled without explicit operator capability", async () => {
    const root = temporaryRoot();
    const { client, jobs, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const activity = jobs.createActivity({ scopeId: SCOPE_A, title: "Disabled recovery" });
    const agent = jobs.createAgent({ scopeId: SCOPE_A, agentName: "Disabled Recovery Agent" });
    jobs.assignAgent({ activityId: activity.activityId, agentId: agent.agentId, contextMode: "fresh" });

    const denied = await client.callTool({
      name: "codex_agent_recovery_detach",
      arguments: {
        requestId: "29292929-2929-4929-8929-292929292929",
        agentId: agent.agentId,
        activityId: activity.activityId,
        expectedAgentVersion: agent.version
      }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("RECOVERY_OPERATION_DISABLED");
    expect(jobs.listActivityAgentAssignments(activity.activityId, agent.agentId)[0]?.releasedAt)
      .toBeUndefined();
    await close();
  });

  it("archives a logical Agent without archiving an upstream thread that has a fork descendant", async () => {
    const root = temporaryRoot();
    const upstream = new ManagedDeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const sourceAgent = jobs.createAgent({ scopeId: SCOPE_A, agentName: "Source Agent" });
    jobs.linkAgentThread({
      agentId: sourceAgent.agentId,
      threadId: "source-thread",
      backendKind: "app-server",
      cwd: root,
      sandbox: "read-only",
      contextMode: "fresh"
    });
    const forkAgent = jobs.createAgent({ scopeId: SCOPE_A, agentName: "Fork Agent" });
    jobs.linkAgentThread({
      agentId: forkAgent.agentId,
      threadId: "fork-thread",
      backendKind: "app-server",
      cwd: root,
      sandbox: "read-only",
      contextMode: "fork",
      forkedFromThreadId: "source-thread"
    });

    const archived = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "61616161-6161-4161-8161-616161616161",
        agentId: sourceAgent.agentId,
        action: "archive"
      }
    }));
    expect(archived).toMatchObject({
      ok: true,
      target: { type: "agent", id: sourceAgent.agentId, state: "archived" }
    });
    expect(jobs.getAgent(sourceAgent.agentId)).toMatchObject({ lifecycle: "archived" });
    expect(jobs.listAgentThreads(sourceAgent.agentId)).toHaveLength(1);
    expect(upstream.archivedThreads).toEqual([]);
    expect(jobs.getAgent(forkAgent.agentId)).toMatchObject({
      lifecycle: "idle",
      currentThreadId: "fork-thread"
    });
    expect(jobs.listAgentThreads(forkAgent.agentId)).toEqual([
      expect.objectContaining({
        threadId: "fork-thread",
        forkedFromThreadId: "source-thread",
        isCurrent: true
      })
    ]);

    const restored = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "62626262-6262-4262-8262-626262626262",
        agentId: sourceAgent.agentId,
        action: "restore"
      }
    }));
    expect(restored).toMatchObject({
      ok: true,
      target: { type: "agent", id: sourceAgent.agentId, state: "idle" }
    });
    expect(upstream.restoredThreads).toEqual([]);
    expect(jobs.getAgent(sourceAgent.agentId)).toMatchObject({
      lifecycle: "idle",
      currentThreadId: "source-thread"
    });
    expect(jobs.listAgentThreads(sourceAgent.agentId)).toEqual([
      expect.objectContaining({ threadId: "source-thread", isCurrent: true })
    ]);
    await close();
  });

  it("separates terminal Agent state from remaining App Server background processes and stops them exactly", async () => {
    const root = temporaryRoot();
    const upstream = new BackgroundTerminalUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const completedResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "leave one background process",
        agentName: "Process Agent",
        contextMode: "fresh",
        executionMode: "foreground"
      }
    });
    const completed = parseToolJson(completedResult);
    const agentId = completed.agentId as string;
    const activityId = completed.activityId as string;
    expect(agentId).toEqual(expect.any(String));
    expect((completedResult as { _meta?: unknown })._meta).toBeUndefined();
    const automaticView = await presentCompactActivity(
      client,
      activityId,
      "71717171-7171-4171-8171-717171717170"
    );
    expect(automaticView.isError, JSON.stringify(automaticView)).not.toBe(true);
    expect(privateActivityView(automaticView).feed).toMatchObject({
        mode: "compact",
        active: [expect.objectContaining({
          activityId,
          displayState: "running",
          agents: [expect.objectContaining({ backgroundProcessCount: 2 })]
        })]
      });

    const widgetSessionId = "71717171-7171-4171-8171-717171717171";
    const card = await client.callTool({
      name: "codex_activity",
      arguments: { activityId },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    const view = parseToolJson(card);
    expect(view.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId,
        lifecycle: "idle",
        backgroundProcessState: "running",
        backgroundProcessCount: 2,
        canArchive: false
      })
    ]));
    expect((card as { _meta?: Record<string, any> })._meta?.interactionControls.agents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId,
          backgroundProcesses: [
            { processId: "background-process-1" },
            { processId: "legacy-background-process-2" }
          ]
        })
      ]));
    expect(JSON.stringify(card)).not.toContain("private background command");
    expect(JSON.stringify(card)).not.toContain("/private/background/path");

    const dashboard = await rawCallTool({
      name: "codex_dashboard_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        widgetInstanceId: "73737373-7373-4373-8373-737373737373",
        limit: 20
      }
    });
    expect(dashboard.isError, JSON.stringify(dashboard)).not.toBe(true);
    const dashboardView = (dashboard as { structuredContent?: any }).structuredContent;
    expect(dashboardView.counts).toMatchObject({
      backgroundProcesses: 2,
      backgroundProcessAgents: 1,
      runtimeUnknownAgents: 0,
      runtimeProbeSkippedAgents: 0
    });
    expect(dashboardView.activeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentName: "Process Agent",
        status: "background-process-running",
        backgroundProcessCount: 2
      })
    ]));
    expect(JSON.stringify(dashboard)).not.toContain("background-process-1");
    expect(JSON.stringify(dashboard)).not.toContain("private background command");
    expect(JSON.stringify(dashboard)).not.toContain("/private/background/path");

    const processControl = (card as { _meta?: Record<string, any> })._meta
      ?.interactionControls?.agents?.find((entry: Record<string, unknown>) => entry.agentId === agentId);
    const mountedActivity = view.mountedActivity;
    const mountedPresentation = view.mountedPresentation;
    expect(processControl).toMatchObject({ agentId, agentVersion: expect.any(Number) });
    expect(mountedActivity).toMatchObject({ activityId, cardGeneration: expect.any(Number) });
    expect(mountedPresentation).toEqual({ kind: "explicit" });

    const archiveConflict = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "70707070-7070-4070-8070-707070707070",
        agentId,
        action: "archive"
      }
    }));
    expect(archiveConflict).toMatchObject({
      ok: false,
      code: "AGENT_BACKGROUND_PROCESS"
    });

    const terminateArguments = {
      requestId: "80808080-8080-4080-8080-808080808080",
      agentId,
      expectedAgentVersion: processControl.agentVersion,
      processId: "background-process-1",
      card: {
        activityId: mountedActivity.activityId,
        generation: mountedActivity.cardGeneration,
        presentation: mountedPresentation
      }
    };
    const withoutLease = await client.callTool({
      name: "codex_background_process_terminate",
      arguments: {
        ...terminateArguments,
        requestId: "81818181-8181-4181-8181-818181818181"
      }
    });
    expect(withoutLease.isError).toBe(true);
    expect(JSON.stringify(withoutLease)).toContain("CARD_LEASE_REQUIRED");

    await client.callTool({
      name: "codex_activity_snapshot",
      arguments: { card: terminateArguments.card, widgetInstanceId: widgetSessionId }
    });

    const staleAgent = await client.callTool({
      name: "codex_background_process_terminate",
      arguments: {
        ...terminateArguments,
        requestId: "82828282-8282-4282-8282-828282828282",
        expectedAgentVersion: processControl.agentVersion + 1
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(staleAgent.isError).toBe(true);
    expect(JSON.stringify(staleAgent)).toContain("AGENT_VERSION_CHANGED");

    const activeAgent = jobs.setAgentExecutionState(agentId, "active", {
      currentJobId: "racing-codex-turn"
    });
    const activeCard = await client.callTool({
      name: "codex_activity_snapshot",
      arguments: { card: terminateArguments.card },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    const activeProcessControl = (activeCard as { _meta?: Record<string, any> })._meta
      ?.interactionControls?.agents?.find((entry: Record<string, unknown>) => entry.agentId === agentId);
    expect(activeProcessControl).not.toHaveProperty("backgroundProcesses");
    expect((activeCard as { structuredContent?: Record<string, any> }).structuredContent?.feed)
      .toMatchObject({
        active: [expect.objectContaining({
          activityId,
          agents: [expect.objectContaining({ backgroundProcessCount: 2 })]
        })]
      });
    const whileActive = await client.callTool({
      name: "codex_background_process_terminate",
      arguments: {
        ...terminateArguments,
        requestId: "83838383-8383-4383-8383-838383838383",
        expectedAgentVersion: activeAgent.version
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(whileActive.isError).toBe(true);
    expect(JSON.stringify(whileActive)).toContain("AGENT_BUSY");
    const idleAgent = jobs.setAgentExecutionState(agentId, "idle");
    upstream.beforeNextList = () => {
      jobs.setAgentExecutionState(agentId, "active", { currentJobId: "raced-codex-turn" });
    };
    const racedTurn = await client.callTool({
      name: "codex_background_process_terminate",
      arguments: {
        ...terminateArguments,
        requestId: "85858585-8585-4585-8585-858585858585",
        expectedAgentVersion: idleAgent.version
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(racedTurn.isError).toBe(true);
    expect(JSON.stringify(racedTurn)).toContain("AGENT_VERSION_CHANGED");
    expect(upstream.terminationCalls).toEqual([]);
    const finalIdleAgent = jobs.setAgentExecutionState(agentId, "idle");
    terminateArguments.expectedAgentVersion = finalIdleAgent.version;

    const terminated = parseToolJson(await client.callTool({
      name: "codex_background_process_terminate",
      arguments: terminateArguments,
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    const replay = parseToolJson(await client.callTool({
      name: "codex_background_process_terminate",
      arguments: terminateArguments,
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    expect(terminated).toMatchObject({ ok: true, terminated: true, historyPreserved: true });
    expect(replay).toEqual(terminated);
    expect(upstream.terminationCalls).toEqual([
      { threadId: "thread-1", processId: "background-process-1" }
    ]);

    const retiredTermination = await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "84848484-8484-4484-8484-848484848484",
        agentId,
        action: "terminate-background-process",
        processId: "legacy-background-process-2"
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(retiredTermination.isError).toBe(true);
    expect(JSON.stringify(retiredTermination)).toContain("Unrecognized key");
    expect(upstream.terminationCalls).toEqual([
      { threadId: "thread-1", processId: "background-process-1" }
    ]);

    const secondTermination = parseToolJson(await client.callTool({
      name: "codex_background_process_terminate",
      arguments: {
        ...terminateArguments,
        requestId: "86868686-8686-4686-8686-868686868686",
        processId: "legacy-background-process-2"
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    expect(secondTermination).toMatchObject({ ok: true, terminated: true });
    expect(upstream.terminationCalls).toEqual([
      { threadId: "thread-1", processId: "background-process-1" },
      { threadId: "thread-1", processId: "legacy-background-process-2" }
    ]);

    const after = await client.callTool({ name: "codex_activity", arguments: {} });
    expect(privateActivityView(after).agents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId,
          backgroundProcessState: "none",
          backgroundProcessCount: 0,
          canArchive: true
        })
      ]));
    await close();
  });

  it("lets the model steer only an exact active App Server Job with durable replay", async () => {
    const root = temporaryRoot();
    const upstream = new InteractionUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "hold while sibling verification completes",
        agentName: "Public Steering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const pending = {
      interactionId: "steering-pending-input",
      kind: "user-input" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      summary: "Input still pending",
      questions: [{
        id: "choice",
        header: "Choice",
        question: "Which option?",
        isSecret: false
      }]
    };
    upstream.progressNext({
      progress: 1,
      message: pending.summary,
      event: {
        eventId: "steering-pending-event",
        type: "input-required",
        phase: "waiting",
        createdAt: Date.now(),
        summary: pending.summary,
        details: { interaction: pending }
      }
    });
    const expectedJobVersion = jobs.get(started.jobId)?.version as number;
    const prompt =
      "Verified sibling result: parser v2 is required. Stop adding the legacy fallback, but keep this Job running.";
    const steeringRequest = {
      requestId: "90909090-9090-4090-8090-909090909090",
      jobId: started.jobId,
      expectedJobVersion,
      prompt
    };
    const executionBoundaryBefore = structuredClone({
      activityId: jobs.get(started.jobId)?.activityId,
      agentId: jobs.get(started.jobId)?.agentId,
      projectId: jobs.get(started.jobId)?.projectId,
      cwd: jobs.get(started.jobId)?.cwd,
      backendKind: jobs.get(started.jobId)?.backendKind,
      sandbox: jobs.get(started.jobId)?.sandbox,
      selectionKey: jobs.get(started.jobId)?.selectionKey,
      executionDecision: jobs.get(started.jobId)?.executionDecision
    });

    const injectedAuthority = await client.callTool({
      name: "codex_steer",
      arguments: {
        ...steeringRequest,
        requestId: "90909090-9090-4090-8090-909090909091",
        threadId: "caller-selected-thread",
        activityId: started.activityId,
        sandbox: "danger-full-access"
      }
    });
    expect(injectedAuthority.isError).toBe(true);
    expect(JSON.stringify(injectedAuthority)).toContain("Unrecognized key");
    expect(upstream.steeringRequests).toEqual([]);
    expect(jobs.listSteeringDeliveries(SCOPE_A)).toEqual([]);

    const [firstCall, concurrentReplayCall] = await Promise.all([
      client.callTool({
        name: "codex_steer",
        arguments: steeringRequest
      }),
      client.callTool({
        name: "codex_steer",
        arguments: steeringRequest
      })
    ]);
    const first = parseToolJson(firstCall);
    const concurrentReplay = parseToolJson(concurrentReplayCall);
    const replay = parseToolJson(await client.callTool({
      name: "codex_steer",
      arguments: steeringRequest
    }));
    expect(firstCall.isError).not.toBe(true);
    expect(first).toMatchObject({
      kind: "mutation",
      ok: true,
      action: "steer",
      code: null,
      job: {
        jobId: started.jobId,
        activityId: started.activityId,
        agentId: started.agentId,
        status: "running"
      },
      promptPersistedByBridge: false,
      steeringScope: "active-codex-turn-only",
      delivery: { status: "delivered" }
    });
    expect(concurrentReplay).toEqual(first);
    expect(replay).toEqual(first);
    expect(upstream.steeringRequests).toEqual([{ threadId: "thread-1", prompt }]);
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([pending]);
    expect(jobs.listCancellationIntents({ jobId: started.jobId })).toEqual([]);
    expect({
      activityId: jobs.get(started.jobId)?.activityId,
      agentId: jobs.get(started.jobId)?.agentId,
      projectId: jobs.get(started.jobId)?.projectId,
      cwd: jobs.get(started.jobId)?.cwd,
      backendKind: jobs.get(started.jobId)?.backendKind,
      sandbox: jobs.get(started.jobId)?.sandbox,
      selectionKey: jobs.get(started.jobId)?.selectionKey,
      executionDecision: jobs.get(started.jobId)?.executionDecision
    }).toEqual(executionBoundaryBefore);
    const delivery = jobs.listSteeringDeliveries(SCOPE_A)[0]!;
    expect(delivery).toMatchObject({
      requestId: steeringRequest.requestId,
      jobId: started.jobId,
      expectedJobVersion,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      status: "delivered",
      result: first
    });
    expect(JSON.stringify(delivery)).not.toContain(prompt);

    const conflictCall = await client.callTool({
      name: "codex_steer",
      arguments: { ...steeringRequest, prompt: "different payload" }
    });
    expect(conflictCall.isError).toBe(true);
    expect(parseToolJson(conflictCall)).toMatchObject({
      ok: false,
      code: "STEERING_REQUEST_CONFLICT",
      delivery: { status: "not-delivered" }
    });
    expect(upstream.steeringRequests).toHaveLength(1);

    const staleCall = await client.callTool({
      name: "codex_steer",
      arguments: {
        requestId: "91919191-9191-4191-8191-919191919190",
        jobId: started.jobId,
        expectedJobVersion,
        prompt: "This stale guidance must not dispatch."
      }
    });
    expect(staleCall.isError).toBe(true);
    expect(parseToolJson(staleCall)).toMatchObject({
      code: "STALE_JOB_VERSION",
      delivery: { status: "not-delivered" }
    });

    const scopeMismatch = await rawCallTool({
      name: "codex_steer",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "92929292-9292-4292-8292-929292929290",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        prompt: "Cross-scope guidance must fail."
      }
    });
    expect(scopeMismatch.isError).toBe(true);
    expect(parseToolJson(scopeMismatch)).toMatchObject({
      code: "JOB_SCOPE_MISMATCH",
      job: null,
      delivery: { status: "not-delivered" }
    });

    upstream.steeringAvailable = false;
    const inactiveTurn = await client.callTool({
      name: "codex_steer",
      arguments: {
        requestId: "93939393-9393-4393-8393-939393939390",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        prompt: "No active upstream turn means no queue."
      }
    });
    expect(inactiveTurn.isError).toBe(true);
    expect(parseToolJson(inactiveTurn)).toMatchObject({
      code: "JOB_NOT_ACTIVE",
      delivery: { status: "not-delivered" }
    });
    upstream.steeringAvailable = true;

    const cancelled = parseToolJson(await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "94949494-9494-4494-8494-949494949489",
        jobId: started.jobId,
        expectedVersion: jobs.get(started.jobId)?.version,
        reason: "The user stopped the active App Server job"
      }
    }));
    expect(cancelled).toMatchObject({
      ok: true,
      action: "cancel-job",
      target: { type: "job", id: started.jobId, state: "cancelled" }
    });
    const terminalRace = await client.callTool({
      name: "codex_steer",
      arguments: {
        requestId: "94949494-9494-4494-8494-949494949490",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        prompt: "A terminal Job must not receive future queued work."
      }
    });
    expect(terminalRace.isError).toBe(true);
    expect(parseToolJson(terminalRace)).toMatchObject({
      code: "JOB_NOT_ACTIVE",
      job: { status: "cancelled" },
      delivery: { status: "not-delivered" }
    });
    expect(upstream.steeringRequests).toHaveLength(1);
    await close();
  });

  it("redacts exact steering input echoed by Codex from Bridge-owned state and output", async () => {
    const root = temporaryRoot();
    const databaseFile = path.join(
      mkdtempSync(path.join(tmpdir(), "steering-echo-")),
      "state.sqlite"
    );
    const stateStore = new BridgeStateStore({ file: databaseFile });
    const config = configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" });
    const upstream = new InteractionUpstream();
    const settings = new UserSettingsStore(config, { stateStore });
    const jobs = new CodexJobRegistry({
      maxConcurrentJobs: config.maxConcurrentJobs,
      ttlMs: config.jobTtlMs,
      maxJobs: config.maxRetainedJobs,
      maxResultBytes: config.maxJobResultBytes,
      staleAfterMs: config.jobStaleAfterMs,
      allowedRoots: config.allowedRoots,
      stateStore
    });
    const connected = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings,
      jobs
    );
    const prompt = "RAW_STEERING_ECHO_7f4c1d9a must never enter Bridge SQLite or output";
    const started = parseToolJson(await connected.client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "wait for an adversarial steering echo probe",
        agentName: "Steering Echo Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const expectedJobVersion = jobs.get(started.jobId)?.version as number;
    const steered = parseToolJson(await connected.client.callTool({
      name: "codex_steer",
      arguments: {
        requestId: "97979797-9797-4797-8797-979797979790",
        jobId: started.jobId,
        expectedJobVersion,
        prompt
      }
    }));
    expect(steered).toMatchObject({
      ok: true,
      delivery: { status: "delivered" },
      promptPersistedByBridge: false
    });

    upstream.progressNext({
      progress: 2,
      message: `progress echoed ${prompt}`,
      event: {
        eventId: "steering-echo-event",
        type: "agent-message",
        phase: "updated",
        createdAt: Date.now(),
        summary: `event echoed ${prompt}`,
        details: { echo: prompt, nested: [prompt], [prompt]: "echo-key" }
      }
    });
    upstream.resolveNext({
      content: [{ type: "text", text: `final answer echoed ${prompt}` }],
      structuredContent: {
        threadId: "thread-1",
        turnId: "turn-1",
        turnStatus: "completed",
        echo: prompt,
        [prompt]: "echo-key"
      }
    });
    await waitForJobStatus(connected.client, started.jobId, "completed");

    const persistedJob = jobs.get(started.jobId);
    expect(JSON.stringify(persistedJob)).not.toContain(prompt);
    expect(JSON.stringify(persistedJob)).toContain("[steering input omitted]");
    expect(JSON.stringify(jobs.listSteeringDeliveries(SCOPE_A))).not.toContain(prompt);
    const exactStatus = await connected.client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: started.jobId } }
    });
    expect(JSON.stringify(exactStatus)).not.toContain(prompt);
    expect(JSON.stringify(exactStatus)).toContain("[steering input omitted]");

    await connected.close();
    stateStore.close();
    expect(readFileSync(databaseFile).includes(Buffer.from(prompt))).toBe(false);
  });

  it("derives scope for the public four-field steering call from host metadata", async () => {
    const root = temporaryRoot();
    const upstream = new InteractionUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const metadata = {
      "openai/organization": "steering-org",
      "openai/subject": "steering-user",
      "openai/session": "steering-session"
    };
    const started = parseToolJson(await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "98989898-9898-4898-8898-989898989890",
        prompt: "host-derived steering target",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new", title: "Host-derived steering" },
        agent: { mode: "new", name: "Host Scope Steering Agent" },
        executionMode: "background"
      },
      _meta: {
        ...metadata,
        "codex/activityPresentationId": "98989898-9898-4898-8898-989898989890"
      }
    }));
    await Promise.resolve();
    const expectedJobVersion = jobs.get(started.jobId)?.version as number;
    const steeringArguments = {
      requestId: "99999999-9999-4999-8999-999999999990",
      jobId: started.jobId,
      expectedJobVersion,
      prompt: "Apply the host-scoped correction."
    };
    expect(Object.keys(steeringArguments).sort()).toEqual([
      "expectedJobVersion",
      "jobId",
      "prompt",
      "requestId"
    ]);
    const delivered = parseToolJson(await rawCallTool({
      name: "codex_steer",
      arguments: steeringArguments,
      _meta: metadata
    }));
    expect(delivered).toMatchObject({
      ok: true,
      job: { jobId: started.jobId },
      delivery: { status: "delivered" }
    });

    const denied = await rawCallTool({
      name: "codex_steer",
      arguments: {
        ...steeringArguments,
        requestId: "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0",
        expectedJobVersion: jobs.get(started.jobId)?.version
      },
      _meta: { ...metadata, "openai/session": "other-steering-session" }
    });
    expect(denied.isError).toBe(true);
    expect(parseToolJson(denied)).toMatchObject({
      code: "JOB_SCOPE_MISMATCH",
      delivery: { status: "not-delivered" }
    });
    expect(upstream.steeringRequests).toEqual([
      { threadId: "thread-1", prompt: steeringArguments.prompt }
    ]);

    upstream.resolveNext(fakeCodexResult("thread-1"));
    for (let attempt = 0; attempt < 30 && jobs.get(started.jobId)?.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(jobs.get(started.jobId)?.status).toBe("completed");
    await close();
  });

  it("distinguishes an active MCP Server Job from steerable App Server work", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "active MCP work",
        agentName: "MCP Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const result = await client.callTool({
      name: "codex_steer",
      arguments: {
        requestId: "95959595-9595-4595-8595-959595959590",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        prompt: "MCP Server cannot steer an in-flight turn."
      }
    });
    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      code: "STEERING_UNSUPPORTED",
      job: { status: "running" },
      delivery: { status: "not-delivered" }
    });
    expect(jobs.listSteeringDeliveries(SCOPE_A)).toEqual([
      expect.objectContaining({ status: "not-delivered" })
    ]);
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("returns delivery-uncertain after a persisted dispatch boundary without resending", async () => {
    const root = temporaryRoot();
    const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "steering-crash-")), "state.sqlite");
    const prompt = "crash-boundary steering prompt must remain private";
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const requestId = "96969696-9696-4696-8696-969696969690";
    const jobId = "crashed-steering-job";
    const expectedJobVersion = 3;
    const actionHash = createHash("sha256")
      .update(JSON.stringify({ action: "steer", jobId, expectedJobVersion, promptHash: promptSha256 }))
      .digest("hex");
    const firstStore = new BridgeStateStore({ file: databaseFile });
    firstStore.beginSteeringDelivery({
      scopeId: SCOPE_A,
      requestId,
      actionHash,
      jobId,
      expectedJobVersion,
      promptSha256
    });
    firstStore.markSteeringDeliveryDispatching(SCOPE_A, requestId, actionHash);
    firstStore.close();

    const stateStore = new BridgeStateStore({ file: databaseFile });
    const config = configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" });
    const upstream = new InteractionUpstream();
    const settings = new UserSettingsStore(config, { stateStore });
    const jobs = new CodexJobRegistry({
      maxConcurrentJobs: config.maxConcurrentJobs,
      ttlMs: config.jobTtlMs,
      maxJobs: config.maxRetainedJobs,
      maxResultBytes: config.maxJobResultBytes,
      staleAfterMs: config.jobStaleAfterMs,
      allowedRoots: config.allowedRoots,
      stateStore
    });
    const connected = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings,
      jobs
    );
    const arguments_ = { requestId, jobId, expectedJobVersion, prompt };
    const first = await connected.client.callTool({ name: "codex_steer", arguments: arguments_ });
    const replay = await connected.client.callTool({ name: "codex_steer", arguments: arguments_ });
    expect(first.isError).toBe(true);
    expect(parseToolJson(first)).toMatchObject({
      ok: false,
      code: "DELIVERY_UNCERTAIN",
      job: null,
      delivery: { status: "uncertain" },
      promptPersistedByBridge: false
    });
    expect(parseToolJson(replay)).toEqual(parseToolJson(first));
    expect(upstream.steeringRequests).toEqual([]);
    expect(stateStore.getSteeringDelivery(SCOPE_A, requestId)).toMatchObject({
      actionHash,
      promptSha256,
      status: "uncertain",
      result: parseToolJson(first)
    });
    expect(JSON.stringify(stateStore.getSteeringDelivery(SCOPE_A, requestId))).not.toContain(prompt);
    await connected.close();
    stateStore.close();
    expect(readFileSync(databaseFile).includes(Buffer.from(prompt))).toBe(false);
  });

  it("projects only allowed interaction decisions and clears server-resolved requests from Activity state", async () => {
    const root = temporaryRoot();
    const upstream = new InteractionUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const startedResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "wait for interactions",
        agentName: "Interaction Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    });
    const started = parseToolJson(startedResult);
    const activityPresentation = await presentCompactActivity(
      client,
      started.activityId,
      "90909090-9090-4090-8090-909090909091"
    );
    const widgetSessionId = "widget-interaction";
    const card = automaticCardProof(activityPresentation);
    await client.callTool({
      name: "codex_activity_snapshot",
      arguments: { card },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });

    const steeringRequest = {
      requestId: "91919191-9191-4191-8191-919191919191",
      jobId: started.jobId,
      expectedJobVersion: jobs.get(started.jobId)?.version,
      prompt: "Focus on the exact pending interaction.",
      card
    };
    const steered = parseToolJson(await client.callTool({
      name: "codex_job_steer",
      arguments: steeringRequest,
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    const steeringReplay = parseToolJson(await client.callTool({
      name: "codex_job_steer",
      arguments: steeringRequest,
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    expect(steered).toMatchObject({ ok: true, action: "steer", promptPersistedByBridge: false });
    expect(steeringReplay).toEqual(steered);
    expect(upstream.steeringRequests).toEqual([
      { threadId: "thread-1", prompt: "Focus on the exact pending interaction." }
    ]);

    const approval = {
      interactionId: "interaction-approval-1",
      kind: "command-approval" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      summary: "Command approval required",
      reason: "Network access",
      cwdLabel: path.basename(root),
      availableDecisions: ["acceptForSession", "decline", "cancel"] as CodexInteractionDecision[],
      networkContext: { host: "example.test", protocol: "https" as const },
      proposedAmendments: {
        networkPolicy: [{ host: "example.test", action: "allow" as const }]
      }
    };
    upstream.progressNext({
      progress: 1,
      message: approval.summary,
      event: {
        eventId: "approval-waiting",
        type: "approval-required",
        phase: "waiting",
        createdAt: Date.now(),
        summary: approval.summary,
        details: { interaction: approval }
      }
    });
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([approval]);
    const approvalSnapshot = await client.callTool({
      name: "codex_activity_snapshot",
      arguments: { card },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect((approvalSnapshot as { structuredContent?: Record<string, any> }).structuredContent?.feed)
      .toMatchObject({
        mode: "compact",
        active: [expect.objectContaining({
          activityId: started.activityId,
          displayState: "approval-required"
        })]
      });

    const movedLegacyControl = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: started.activityId,
        action: "respond-interaction",
        jobId: started.jobId,
        interactionId: approval.interactionId,
        interactionDecision: "accept"
      }
    });
    expect(movedLegacyControl.isError).toBe(true);
    expect(JSON.stringify(movedLegacyControl)).toContain("Unrecognized keys");

    const unavailableDecision = await client.callTool({
      name: "codex_interaction_respond",
      arguments: {
        requestId: "92929292-9292-4292-8292-929292929292",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        interactionId: approval.interactionId,
        response: { decision: "accept" },
        card
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(unavailableDecision.isError).toBe(true);
    expect(JSON.stringify(unavailableDecision)).toContain("decision is not available");
    expect(upstream.interactionResponses).toEqual([]);

    const responseRequest = {
      requestId: "93939393-9393-4393-8393-939393939393",
      jobId: started.jobId,
      expectedJobVersion: jobs.get(started.jobId)?.version,
      interactionId: approval.interactionId,
      response: { decision: "acceptForSession" as const },
      card
    };
    const [respondedResult, concurrentResult] = await Promise.all([
      client.callTool({
        name: "codex_interaction_respond",
        arguments: responseRequest,
        _meta: { "openai/widgetSessionId": widgetSessionId }
      }),
      client.callTool({
        name: "codex_interaction_respond",
        arguments: {
          ...responseRequest,
          requestId: "93939393-9393-4393-8393-939393939394"
        },
        _meta: { "openai/widgetSessionId": widgetSessionId }
      })
    ]);
    const responded = parseToolJson(respondedResult);
    const concurrentResponse = parseToolJson(concurrentResult);
    const responseReplay = parseToolJson(await client.callTool({
      name: "codex_interaction_respond",
      arguments: responseRequest,
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    const stableInteractionResponse = {
      ok: true,
      action: "respond-interaction",
      activityId: started.activityId,
      promptOrAnswersPersisted: false
    };
    expect(responded).toMatchObject(stableInteractionResponse);
    expect(concurrentResponse).toMatchObject(stableInteractionResponse);
    expect(responseReplay).toMatchObject(stableInteractionResponse);
    expect(upstream.interactionResponses).toEqual([
      { interactionId: approval.interactionId, response: { decision: "acceptForSession" } }
    ]);
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([]);

    const reusedRequestId = await client.callTool({
      name: "codex_interaction_respond",
      arguments: {
        ...responseRequest,
        response: { decision: "decline" }
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(reusedRequestId.isError).toBe(true);
    expect(JSON.stringify(reusedRequestId)).toContain("requestId was already used");

    const withoutMountedCard = await client.callTool({
      name: "codex_interaction_respond",
      arguments: {
        requestId: "94949494-9494-4494-8494-949494949494",
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        interactionId: approval.interactionId,
        response: { decision: "decline" },
        card
      }
    });
    expect(withoutMountedCard.isError).toBe(true);
    expect(JSON.stringify(withoutMountedCard)).toContain("CARD_LEASE_REQUIRED");

    const input = {
      interactionId: "interaction-input-2",
      kind: "user-input" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      summary: "Codex requires user input",
      autoResolutionMs: 100,
      expiresAt: Date.now() + 100,
      questions: [{
        id: "choice",
        header: "Choice",
        question: "Choose",
        isSecret: false
      }]
    };
    upstream.progressNext({
      progress: 3,
      message: input.summary,
      event: {
        eventId: "input-waiting",
        type: "input-required",
        phase: "waiting",
        createdAt: Date.now(),
        summary: input.summary,
        details: { interaction: input }
      }
    });
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([input]);
    const inputSnapshot = await client.callTool({
      name: "codex_activity_snapshot",
      arguments: { card },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect((inputSnapshot as { structuredContent?: Record<string, any> }).structuredContent?.feed)
      .toMatchObject({
        mode: "compact",
        active: [expect.objectContaining({
          activityId: started.activityId,
          displayState: "input-required"
        })]
      });
    upstream.progressNext({
      progress: 4,
      message: "input resolved",
      event: {
        eventId: "input-resolved",
        type: "input-required",
        phase: "completed",
        createdAt: Date.now(),
        summary: "input resolved",
        details: {
          resolvedInteractionId: input.interactionId,
          resolution: "server-resolved"
        }
      }
    });
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([]);

    const secretInput = {
      interactionId: "interaction-input-secret-3",
      kind: "user-input" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-3",
      summary: "Codex requires a transient secret",
      questions: [{
        id: "password",
        header: "Secret",
        question: "Enter the transient value",
        isSecret: true
      }]
    };
    upstream.progressNext({
      progress: 5,
      message: secretInput.summary,
      event: {
        eventId: "secret-input-waiting",
        type: "input-required",
        phase: "waiting",
        createdAt: Date.now(),
        summary: secretInput.summary,
        details: { interaction: secretInput }
      }
    });
    const secretRequestId = "95959595-9595-4595-8595-959595959595";
    const secretValue = "transient-secret-value";
    const secretResponse = await client.callTool({
      name: "codex_interaction_respond",
      arguments: {
        requestId: secretRequestId,
        jobId: started.jobId,
        expectedJobVersion: jobs.get(started.jobId)?.version,
        interactionId: secretInput.interactionId,
        response: { answers: { password: [secretValue] } },
        card
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    expect(JSON.stringify(secretResponse)).not.toContain(secretValue);
    expect(JSON.stringify(jobs.getAgentMutation(SCOPE_A, secretRequestId))).not.toContain(secretValue);
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([]);
    expect(upstream.interactionResponses.at(-1)).toEqual({
      interactionId: secretInput.interactionId,
      response: { answers: { password: [secretValue] } }
    });

    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("keeps foreground execution in the active call and returns Activity identifiers", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    let settled = false;
    const pending = client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "discuss synchronously",
        sessionMode: "new",
        activityTitle: "Architecture discussion",
        activityKind: "discussion",
        executionMode: "foreground"
      }
    }).then((result) => {
      settled = true;
      return result;
    });
    await expect.poll(() => upstream.calls.length).toBe(1);
    expect(settled).toBe(false);
    expect(upstream.calls).toHaveLength(1);

    upstream.resolveNext(fakeCodexResult("discussion-thread"));
    const result = await pending;
    const structured = parseToolJson(result);
    expect(structured).toMatchObject({
      threadId: "discussion-thread",
      activityId: expect.stringMatching(SCOPE_ID_PATTERN),
      jobId: expect.stringMatching(SCOPE_ID_PATTERN),
      executionMode: "foreground"
    });
    const activityId = structured.activityId;
    expect(jobs.getActivity(activityId)).toMatchObject({
      kind: "discussion",
      lifecycle: "open",
      waitingOn: "orchestrator",
      counts: { completed: 1 }
    });
    await close();
  });

  it("projects retained foreground and exact-Job answers into ChatGPT-visible structured output", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const reportSections = [
      [
        "ISSUE38_E2E_SENTINEL",
        "",
        "## Files",
        "- src/tools.ts"
      ].join("\n"),
      [
        "## Tests",
        "- output contract passed",
        "",
        "## Remaining",
        "- none"
      ].join("\n")
    ];
    const report = reportSections.join("\n\n");
    const pending = client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "return a structured smoke report",
        sessionMode: "new",
        executionMode: "foreground"
      }
    });
    await expect.poll(() => upstream.calls.length).toBe(1);
    upstream.resolveNext({
      structuredContent: { threadId: "issue-38-thread" },
      content: reportSections.map((text) => ({ type: "text" as const, text }))
    });

    const foreground = await pending as { structuredContent?: Record<string, any> };
    expect(foreground.structuredContent).toMatchObject({
      state: "completed",
      resultAvailability: "delivered",
      resultOmitted: false,
      answer: report
    });
    const chatGptForegroundMessage = JSON.stringify(foreground.structuredContent);
    expect(chatGptForegroundMessage).toContain("ISSUE38_E2E_SENTINEL");
    expect(chatGptForegroundMessage).toContain("## Remaining");

    const jobId = foreground.structuredContent?.jobId as string;
    const activityId = foreground.structuredContent?.activityId as string;
    const exact = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: jobId } }
    }) as { structuredContent?: Record<string, any> };
    expect(exact.structuredContent?.items[0]).toMatchObject({
      id: jobId,
      result: { availability: "delivered", omitted: false },
      answer: report
    });
    expect(JSON.stringify(exact.structuredContent)).toContain("ISSUE38_E2E_SENTINEL");

    const activity = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "activity", id: activityId } }
    }));
    const summaryJob = activity.items.find((item: Record<string, any>) => item.id === jobId);
    expect(summaryJob).not.toHaveProperty("answer");
    expect(summaryJob.nextActions).toEqual([
      expect.stringContaining(`id:\"${jobId}\"`)
    ]);

    const escapedReport = '"\\\n'.repeat(12_000);
    const largePending = client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "return a large escaped report",
        sessionMode: "new",
        executionMode: "foreground"
      }
    });
    await expect.poll(() => upstream.calls.length).toBe(2);
    upstream.resolveNext({
      structuredContent: { threadId: "issue-38-large-thread" },
      content: [{ type: "text", text: escapedReport }]
    });
    const large = await largePending as { structuredContent?: Record<string, any> };
    const boundedAnswer = large.structuredContent?.answer as string;
    expect(Buffer.byteLength(JSON.stringify(boundedAnswer), "utf8") - 2)
      .toBeLessThanOrEqual(MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES);
    expect(boundedAnswer).toContain("truncated by output contract");
    expect(large.structuredContent?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("model-authoritative primary answer was truncated")
    ]));
    await close();
  });

  it("enforces verify lifecycle transitions and conversation-scope isolation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

    const started = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "implement and test",
        sessionMode: "new",
        activityTitle: "Verified implementation",
        activityKind: "implementation",
        handoffPolicy: "verify",
        completionTrigger: "sealed-jobs-terminal"
      }
    });
    const startedStructured = parseToolJson(started);
    const activityId = startedStructured.activityId;
    const jobId = startedStructured.jobId;
    expect(jobs.getActivity(activityId)).toMatchObject({ lifecycle: "open", verification: "not-required" });
    const initialVersion = jobs.getActivity(activityId)?.version as number;

    const crossScope = await rawCallTool({
      name: "codex_activity_update",
      arguments: {
        scopeId: SCOPE_B,
        activityId,
        expectedVersion: initialVersion,
        operation: { kind: "seal" }
      }
    });
    expect(crossScope.isError).toBe(true);
    expect(JSON.stringify(crossScope)).toContain("another conversation scope");

    const sealed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: initialVersion,
        operation: { kind: "seal" }
      }
    }));
    expect(sealed.target).toMatchObject({
      type: "activity",
      id: activityId,
      state: "sealed"
    });
    expect(jobs.getActivity(activityId)).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "verification",
      verification: "pending",
      completionVersion: 1
    });
    const pendingVerificationView = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    expect(parseToolJson(pendingVerificationView).feed).toMatchObject({
        activeCount: 1,
        active: [expect.objectContaining({ activityId, displayState: "verification" })],
        completed: { agentCount: 0, activityCount: 0 }
      });
    const illegalComplete = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.target.version,
        operation: { kind: "complete" }
      }
    });
    expect(illegalComplete.isError).toBe(true);
    expect(JSON.stringify(illegalComplete)).toContain("Finish Activity verification");

    const missingFailureReason = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.target.version,
        operation: { kind: "verification-failed" }
      }
    });
    expect(missingFailureReason.isError).toBe(true);
    const missingEvidence = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.target.version,
        operation: { kind: "verification-passed" }
      }
    });
    expect(missingEvidence.isError).toBe(true);
    const failed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.target.version,
        operation: {
          kind: "verification-failed",
          reason: "The first independent review found a gap"
        }
      }
    }));
    expect(failed.target).toMatchObject({ type: "activity", id: activityId, state: "open" });
    expect(jobs.getActivity(activityId)).toMatchObject({ lifecycle: "open", verification: "failed" });

    const verifying = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: failed.target.version,
        operation: { kind: "start-verification" }
      }
    }));
    expect(jobs.getActivity(activityId)).toMatchObject({ verification: "verifying" });
    const passed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: verifying.target.version,
        operation: {
          kind: "verification-passed",
          evidence: {
            summary: "Reviewed the diff and ran the test suite",
            jobIds: [jobId],
            tests: ["npm test: exit 0"]
          }
        }
      }
    }));
    expect(passed.target).toMatchObject({ type: "activity", id: activityId, state: "completed" });
    expect(jobs.getActivity(activityId)).toMatchObject({
      lifecycle: "completed",
      verification: "verified",
      waitingOn: "none"
    });
    const verifiedView = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    expect(parseToolJson(verifiedView).feed).toMatchObject({
        activeCount: 0,
        completed: {
          agentCount: 1,
          activityCount: 1,
          rows: [expect.objectContaining({ latestActivityId: activityId, verification: "verified" })]
        }
      });
    const abandonedTask = await runTask(client, {
      prompt: "create disposable work",
      activityTitle: "Disposable Activity",
      agentName: "Disposable Agent",
      contextMode: "fresh"
    });
    const abandonedActivityId = taskActivityId(abandonedTask);
    const abandoned = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: abandonedActivityId,
        expectedVersion: jobs.getActivity(abandonedActivityId)?.version,
        operation: { kind: "abandon", reason: "No longer needed" }
      }
    }));
    expect(abandoned.target).toMatchObject({
      type: "activity",
      id: abandonedActivityId,
      state: "abandoned"
    });
    await close();
  });

  it("cancels every running child job before cancelling its Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "long delegated work",
        sessionMode: "new",
        activityTitle: "Cancelable work",
        executionMode: "background"
      }
    }));

    const legacyCancel = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: running.activityId,
        action: "cancel",
        reason: "The user stopped this Activity"
      }
    });
    expect(legacyCancel.isError).toBe(true);
    expect(JSON.stringify(legacyCancel)).toContain("Unrecognized keys");
    expect(upstream.aborts).toBe(0);

    const activityVersion = jobs.getActivity(running.activityId)?.version as number;
    const missingReason = await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        requestId: "61616161-6161-4161-8161-616161616161",
        activityId: running.activityId,
        expectedVersion: activityVersion
      }
    });
    expect(missingReason.isError).toBe(true);
    expect(JSON.stringify(missingReason)).toContain("reason");
    expect(upstream.aborts).toBe(0);
    const stale = await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        requestId: "62626262-6262-4262-8262-626262626262",
        activityId: running.activityId,
        expectedVersion: activityVersion + 1,
        reason: "The user stopped this Activity"
      }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("Activity version changed");
    expect(upstream.aborts).toBe(0);
    const crossScope = await rawCallTool({
      name: "codex_activity_cancel",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "63636363-6363-4363-8363-636363636362",
        activityId: running.activityId,
        expectedVersion: activityVersion,
        reason: "The user stopped this Activity"
      }
    });
    expect(crossScope.isError).toBe(true);
    expect(JSON.stringify(crossScope)).toContain("another conversation scope");

    const cancellationArguments = {
      requestId: "63636363-6363-4363-8363-636363636363",
      activityId: running.activityId,
      expectedVersion: activityVersion,
      reason: "The user stopped this Activity"
    } as const;
    const cancelled = parseToolJson(await client.callTool({
      name: "codex_activity_cancel",
      arguments: cancellationArguments
    }));
    const cancellationReplay = parseToolJson(await client.callTool({
      name: "codex_activity_cancel",
      arguments: cancellationArguments
    }));
    expect(cancellationReplay).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      action: "cancel",
      target: { type: "activity", id: running.activityId, state: "cancelled" },
      affectedJobIds: [running.jobId],
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
    });
    expect(cancelled.warnings).toEqual([expect.stringContaining("not rolled back")]);
    expect(upstream.aborts).toBe(1);
    expect(jobs.get(running.jobId)).toMatchObject({
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      cancellationIntentId: expect.any(String)
    });
    expect(jobs.getActivity(running.activityId)).toMatchObject({
      lifecycle: "cancelled",
      waitingOn: "none"
    });
    expect(jobs.getCancellationOperation(SCOPE_A, cancellationArguments.requestId))
      .toMatchObject({
        source: "model-tool",
        reason: cancellationArguments.reason,
        status: "completed"
      });
    const cascadeIntents = jobs.listCancellationIntents({
      requestId: cancellationArguments.requestId
    });
    expect(cascadeIntents).toHaveLength(2);
    const parentIntent = cascadeIntents.find((intent) => intent.targetKind === "activity")!;
    const childIntent = cascadeIntents.find((intent) => intent.targetJobId === running.jobId)!;
    expect(parentIntent).toMatchObject({
      source: "model-tool",
      actionName: "cancel-activity",
      status: "succeeded"
    });
    expect(childIntent).toMatchObject({
      source: "activity-cascade",
      actionName: "cancel-child-job",
      parentIntentId: parentIntent.intentId,
      cascadeId: parentIntent.intentId,
      status: "succeeded"
    });
    const cascadeEvents = [
      ...jobs.listActivityEvents(running.activityId),
      ...jobs.listJobEvents(running.jobId)
    ]
      .sort((left, right) => left.scopeVersion - right.scopeVersion)
      .filter((event) => [
        "cancellation-intent-recorded",
        "activity-terminating",
        "job-terminating",
        "job-cancelled",
        "activity-cancelled"
      ].includes(event.eventType));
    const parentRecorded = cascadeEvents.findIndex((event) =>
      event.eventType === "cancellation-intent-recorded" &&
      (event.payload as Record<string, unknown>).cancellationIntentId === parentIntent.intentId
    );
    const activityTerminating = cascadeEvents.findIndex((event) =>
      event.eventType === "activity-terminating"
    );
    const childRecorded = cascadeEvents.findIndex((event) =>
      event.eventType === "cancellation-intent-recorded" &&
      (event.payload as Record<string, unknown>).cancellationIntentId === childIntent.intentId
    );
    const childCancelled = cascadeEvents.findIndex((event) => event.eventType === "job-cancelled");
    const activityCancelled = cascadeEvents.findIndex((event) => event.eventType === "activity-cancelled");
    expect(parentRecorded).toBeGreaterThanOrEqual(0);
    expect(activityTerminating).toBeGreaterThan(parentRecorded);
    expect(childRecorded).toBeGreaterThan(activityTerminating);
    expect(childCancelled).toBeGreaterThan(childRecorded);
    expect(activityCancelled).toBeGreaterThan(childCancelled);
    expect(cascadeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "cancellation-intent-recorded",
        payload: expect.objectContaining({ reason: cancellationArguments.reason })
      })
    ]));

    const activityCardResult = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "full-history",
        activityId: running.activityId
      }
    });
    const activityCardView = validateActivityViewPrivateMetadata(
      (activityCardResult as { _meta?: Record<string, unknown> })
        ._meta?.[ACTIVITY_VIEW_METADATA_KEY]
    ).view;
    expect(activityCardView.feed).toMatchObject({
      history: {
        rows: [expect.objectContaining({
          activityId: running.activityId,
          cancellations: [{
            targetKind: "activity",
            status: "succeeded",
            reason: cancellationArguments.reason,
            requestedAt: expect.any(String)
          }]
        })]
      }
    });

    const { view: dashboardView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(dashboardView.terminalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        latestTurn: expect.objectContaining({
          status: "cancelled",
          cancellation: {
            targetKind: "activity",
            status: "succeeded",
            reason: cancellationArguments.reason,
            requestedAt: expect.any(String)
          }
        })
      })
    ]));
    const changedRetry = await client.callTool({
      name: "codex_activity_cancel",
      arguments: { ...cancellationArguments, reason: "Different cancellation semantics" }
    });
    expect(changedRetry.isError).toBe(true);
    expect(JSON.stringify(changedRetry)).toContain("different cancellation payload");

    const attach = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must start a new Activity",
        sessionMode: "new",
        activityId: running.activityId
      }
    });
    expect(attach.isError).toBe(true);
    expect(JSON.stringify(attach)).toContain("only to an open Activity");
    await close();
  });

  it("interrupts every exact App Server turn in one Activity even when they share a worker", async () => {
    const root = temporaryRoot();
    const upstream = new MultiTurnAppUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
        CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
      }),
      upstream
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "first app turn",
        agentName: "App Agent One",
        contextMode: "fresh",
        executionMode: "background",
        activityTitle: "Parallel App turns"
      }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "second app turn",
        agentName: "App Agent Two",
        contextMode: "fresh",
        executionMode: "background",
        activityId: first.activityId
      }
    }));
    const affected = [first.jobId, second.jobId].sort();
    const turnDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { threadId: "app-thread-1" }
    }));
    expect(turnDetail).toMatchObject({
      kind: "thread",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "thread", id: "app-thread-1" }),
        expect.objectContaining({ type: "job", id: first.jobId, state: "running" })
      ])
    });
    expect(jobs.get(first.jobId)).toMatchObject({
      backendKind: "app-server",
      upstreamRequestId: "app-turn-1"
    });

    const stopped = parseToolJson(await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        requestId: "64646464-6464-4464-8464-646464646464",
        activityId: first.activityId,
        expectedVersion: jobs.getActivity(first.activityId)?.version,
        reason: "The user stopped every turn in this Activity",
        acknowledgeAffectedJobIds: affected
      }
    }));

    expect(upstream.forceCalls.map((call) => call.upstreamRequestId).sort()).toEqual([
      "app-turn-1",
      "app-turn-2"
    ]);
    expect(jobs.get(first.jobId)).toMatchObject({ status: "cancelled" });
    expect(jobs.get(second.jobId)).toMatchObject({ status: "cancelled" });
    expect(stopped).toMatchObject({
      target: { type: "activity", id: first.activityId, state: "cancelled" },
      affectedJobIds: expect.arrayContaining(affected)
    });
    await close();
  });

  it("permits an explicit workspace-write session only in an enabled profile", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      upstream
    );

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "implement", sessionMode: "new", sandbox: "workspace-write" }
    });
    expect(upstream.calls[0]).toMatchObject({ name: "codex", args: { sandbox: "workspace-write" } });

    await close();
  });

  it("permits danger-full-access while retaining read-only as the omitted default", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
        CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never"
      }),
      upstream
    );

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "full task", sessionMode: "new", sandbox: "danger-full-access" }
    });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: { sandbox: "danger-full-access", "approval-policy": "never" }
    });

    await client.callTool({ name: "codex_task", arguments: { prompt: "inspect", sessionMode: "new" } });
    expect(upstream.calls[1]).toMatchObject({ args: { sandbox: "read-only" } });
    await close();
  });

  it("uses and validates configured or per-call exact selections for new sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, jobs, close } = await connectTestClient(config, upstream);

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "default", sessionMode: "new" }
    });
    await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "override",
        sessionMode: "new",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "medium" }
      }
    });
    expect(upstream.calls[0]).toMatchObject({
      args: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } }
    });
    expect(upstream.calls[1]).toMatchObject({
      args: { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" } }
    });

    const rejected = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "invalid",
        sessionMode: "new",
        selection: { model: "gpt-5.5", reasoningEffort: "max" }
      }
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "MODEL_UNAVAILABLE" }
      }
    });
    expect(upstream.calls).toHaveLength(2);

    await close();
  });

  it("keeps a running job on its admission-time policy decision", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, jobs, close } = await connectTestClient(config, upstream);

    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "hold admission decision", sessionMode: "new" }
    }));
    expect(running).toMatchObject({
      actualModel: "gpt-5.6-sol",
      actualReasoningEffort: "max",
      rerouted: false
    });

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(upstream.calls[0]).toMatchObject({
      args: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } }
    });
    upstream.resolveNext(fakeCodexResult("admission-thread"));
    await waitForJobStatus(client, running.jobId, "completed");
    expect(jobs.get(running.jobId)?.executionDecision).toMatchObject({
      effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      source: "configured-fallback"
    });
    await close();
  });

  it("records requested, effective, accepted, and rerouted execution metadata without prompt text", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "PRIVATE_AUDIT_PROMPT_MUST_NOT_PERSIST",
        sessionMode: "new",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    }));
    upstream.progressNext({
      progress: 1,
      message: "turn started",
      event: {
        eventId: "turn:audit-turn",
        type: "turn",
        phase: "started",
        createdAt: 100,
        summary: "Codex turn started.",
        details: {
          evidence: "turn/start-accepted",
          selection: {
            model: "gpt-5.6-terra",
            reasoningEffort: "high",
            serviceTier: null
          }
        }
      }
    });
    upstream.progressNext({
      progress: 2,
      message: "model rerouted",
      event: {
        eventId: "reroute:audit-turn",
        type: "model",
        phase: "updated",
        createdAt: 110,
        summary: "Model rerouted.",
        details: {
          kind: "rerouted",
          fromModel: "gpt-5.6-terra",
          toModel: "gpt-5.6-sol",
          reason: "fixture-policy"
        }
      }
    });
    const status = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { jobId: running.jobId }
    }));
    expect(status).toMatchObject({ kind: "job", status: "running" });
    expect(jobs.get(running.jobId)?.executionDecision).toMatchObject({
      requestedSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      effectiveSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
    });
    expect(jobs.get(running.jobId)?.publicEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "model",
        details: expect.objectContaining({
          kind: "rerouted",
          fromModel: "gpt-5.6-terra",
          toModel: "gpt-5.6-sol",
          reason: "fixture-policy"
        })
      })
    ]));
    expect(JSON.stringify(status)).not.toContain("PRIVATE_AUDIT_PROMPT");
    upstream.resolveNext(fakeCodexResult("audit-thread"));
    await waitForJobStatus(client, running.jobId, "completed");
    await close();
  });

  it("retains structured context-window recovery metadata across background status and exact replay", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const sessions = new SessionRegistry();
    const { client, jobs, close } = await connectTestClient(
      configFor(root),
      upstream,
      sessions
    );
    const requestId = "81818181-8181-4181-8181-818181818181";
    const args = {
      requestId,
      activityPresentationId: requestId,
      prompt: "exhaust context",
      agent: { mode: "new", name: "Context Recovery" }
    };
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: args
    }));
    upstream.resolveNext({
      isError: true,
      content: [{ type: "text", text: "Context window exceeded." }],
      structuredContent: {
        threadId: "context-thread",
        turnId: "context-turn",
        turnStatus: "failed",
        backendKind: "app-server",
        error: {
          code: "CONTEXT_WINDOW_EXCEEDED",
          message: "Context window exceeded.",
          retryable: true,
          upstreamKind: "contextWindowExceeded",
          nextActions: ["Start fresh with an explicit handoff summary."]
        }
      }
    });
    const failed = await waitForJobStatus(client, running.jobId, "failed");
    expect(failed).toMatchObject({
      status: "failed",
      threadId: "context-thread",
      error: {
        code: "CONTEXT_WINDOW_EXCEEDED",
        retryable: true
      }
    });
    expect(sessions.get("context-thread")).toMatchObject({
      threadId: "context-thread",
      backendKind: "app-server"
    });
    expect(jobs.listAgents(SCOPE_A)[0]).toMatchObject({
      currentThreadId: "context-thread",
      lifecycle: "idle"
    });
    const replay = await client.callTool({ name: "codex_task", arguments: args });
    expect(replay).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "CONTEXT_WINDOW_EXCEEDED", retryable: true },
        actualModel: expect.any(String)
      }
    });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("keeps an admitted App Server thread resumable through a worker crash and replacement", async () => {
    const root = temporaryRoot();
    const upstream = new CrashThenResumeBridgeUpstream();
    const sessions = new SessionRegistry();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream,
      sessions
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "admit then crash",
        activity: { mode: "new", title: "Worker crash recovery" },
        agent: { mode: "new", name: "Crash Recovery" },
        executionMode: "background"
      }
    }));
    const failed = await waitForJobStatus(client, first.jobId, "failed");
    expect(failed).toMatchObject({
      threadId: "bridge-crash-thread",
      error: { message: expect.stringContaining("worker crashed") }
    });
    expect(sessions.get("bridge-crash-thread")).toMatchObject({
      threadId: "bridge-crash-thread",
      backendKind: "app-server"
    });
    expect(jobs.getAgent(first.agentId)).toMatchObject({
      currentThreadId: "bridge-crash-thread",
      lifecycle: "idle"
    });

    const resumed = await runTask(client, {
      prompt: "resume on replacement worker",
      activity: { mode: "existing", id: first.activityId },
      agent: { mode: "existing", id: first.agentId, context: "continue" }
    });
    expect(parseToolJson(resumed)).toMatchObject({
      threadId: "bridge-crash-thread",
      agentId: first.agentId
    });
    expect(sessions.get("bridge-crash-thread")).toMatchObject({
      sessionId: "bridge-crash-session"
    });
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply"]);
    await close();
  });

  it("rejects an MCP policy change until the caller explicitly starts a new thread", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, close } = await connectTestClient(config, upstream);
    const started = await runTask(client, { prompt: "start MCP thread", sessionMode: "new" });
    const activityId = taskActivityId(started);
    const agentId = parseToolJson(started).agentId;

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    for (const arguments_ of [
      { prompt: "auto must not hide a new thread", activityId },
      { prompt: "exact continuation must reject", activityId, agentId, contextMode: "continue" }
    ]) {
      const rejected = await client.callTool({
        name: "codex_task",
        arguments: arguments_
      });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "THREAD_OVERRIDE_UNSUPPORTED" }
        }
      });
    }
    expect(upstream.calls).toHaveLength(1);

    await runTask(client, {
      prompt: "explicit replacement thread",
      activityId,
      agentId,
      contextMode: "fresh"
    });
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1].args).toMatchObject({
      model: "gpt-5.6-terra",
      config: { model_reasoning_effort: "high" }
    });
    await close();
  });

  it("applies an App Server policy change on the same thread and updates execution state", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const sessions = new SessionRegistry();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, close } = await connectTestClient(config, upstream, sessions);

    const started = await runTask(client, { prompt: "start app thread", sessionMode: "new" });
    const agentId = parseToolJson(started).agentId;
    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    const continued = await runTask(client, {
      prompt: "continue with changed selection",
      agentId,
      contextMode: "continue"
    });

    expect(upstream.calls[1]).toMatchObject({
      name: "codex-reply",
      args: {
        threadId: "thread-1",
        model: "gpt-5.6-terra",
        config: { model_reasoning_effort: "high" },
        _bridgeBackendKind: "app-server"
      }
    });
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        threadId: "thread-1",
        actualModel: "gpt-5.6-terra",
        actualReasoningEffort: "high",
        rerouted: false
      });
    expect((started as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        actualModel: "gpt-5.6-sol",
        actualReasoningEffort: "max"
      });
    expect(sessions.get("thread-1")).toMatchObject({
      threadId: "thread-1",
      backendKind: "app-server",
      selection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      policyRevision: 1
    });
    await close();
  });

  it("auto mode continues the only compatible session attached to an Activity", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    const first = await runTask(client, { prompt: "first" });
    const activityId = taskActivityId(first);
    await runTask(client, { prompt: "follow up", activityId });

    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "follow up", _bridgeBackendKind: "mcp-server" }
    });
    expect(jobs.get(parseToolJson(first).jobId)?.sessionDecision).toMatchObject({
      action: "start",
      reason: "activity-new"
    });
    await close();
  });

  it("starts a new thread for a new Activity even when the scope has a compatible thread", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await runTask(client, { prompt: "first Activity" });
    await runTask(client, { prompt: "separate Activity" });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex"]);
    await close();
  });

  it("does not auto-select a Codex thread from another conversation scope", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const scopeA = await runTask(client, { prompt: "scope A", scopeId: SCOPE_A });
    await runTask(client, { prompt: "scope B", scopeId: SCOPE_B });
    await runTask(client, {
      prompt: "scope A follow-up",
      scopeId: SCOPE_A,
      activityId: taskActivityId(scopeA)
    });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex", "codex-reply"]);
    expect(upstream.calls[2]).toMatchObject({
      args: { threadId: "thread-1", prompt: "scope A follow-up" }
    });
    await close();
  });

  it("derives and isolates ChatGPT scopes from host metadata without a model-provided scopeId", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    const metadataA = {
      "openai/organization": "anonymous-org",
      "openai/subject": "anonymous-user",
      "openai/session": "chat-session-a"
    };
    const metadataB = { ...metadataA, "openai/session": "chat-session-b" };

    const started = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new", title: "Derived scope task", policy: { kind: "investigation" } },
        agent: { mode: "new", name: "Derived Scope Agent" },
        executionMode: "foreground"
      },
      _meta: { ...metadataA, "codex/activityPresentationId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }
    });
    const startedStructured = parseToolJson(started);
    const derivedScope = jobs.get(startedStructured.jobId)?.scopeId;
    expect(derivedScope).toMatch(SCOPE_ID_PATTERN);
    expect(derivedScope).not.toBe(SCOPE_A);

    const retriedWithIgnoredInput = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new", title: "Derived scope task", policy: { kind: "investigation" } },
        agent: { mode: "new", name: "Derived Scope Agent" },
        executionMode: "foreground"
      },
      _meta: { ...metadataA, "codex/activityPresentationId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }
    });
    const retriedStructured = parseToolJson(retriedWithIgnoredInput);
    expect(retriedStructured).toMatchObject({
      threadId: startedStructured.threadId,
      activityId: startedStructured.activityId,
      jobId: startedStructured.jobId,
      agentId: startedStructured.agentId,
      replay: true
    });
    expect((retriedWithIgnoredInput as { _meta?: unknown })._meta).toBeUndefined();
    const compactPresentation = await rawCallTool({
      name: "codex_activity",
      arguments: {
        mode: "compact-monitor",
        presentationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        activityId: startedStructured.activityId
      },
      _meta: metadataA
    });
    expect(privateActivityView(compactPresentation)).toMatchObject({
      mountedActivity: {
        activityId: startedStructured.activityId,
        cardGeneration: 1
      },
      mountedPresentation: {
        kind: "automatic",
        activityPresentationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      },
      watcherPolicy: { live: true, ownsCompletionHandoff: true }
    });
    expect(upstream.calls).toHaveLength(1);

    const continued = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        prompt: "continue derived scope",
        executionMode: "foreground",
        activity: {
          mode: "existing",
          id: startedStructured.activityId
        }
      },
      _meta: { ...metadataA, "codex/activityPresentationId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
    });
    const continuedStructured = parseToolJson(continued);
    expect(continuedStructured).toMatchObject({
      activityId: startedStructured.activityId,
      threadId: "thread-1"
    });
    expect(jobs.get(continuedStructured.jobId)?.sessionDecision).toMatchObject({
      action: "continue",
      threadId: "thread-1"
    });

    const statusA = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {}, _meta: metadataA })
    );
    const statusB = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {}, _meta: metadataB })
    );
    const explicitIgnored = parseToolJson(
      await rawCallTool({
        name: "codex_status",
        arguments: { scopeId: SCOPE_B },
        _meta: metadataA
      })
    );
    const deniedAudit = await rawCallTool({
      name: "codex_status",
      arguments: { includeAllScopes: true },
      _meta: metadataA
    });

    expect(statusA.scope).toEqual({ mode: "scoped", source: "host-metadata" });
    expect(statusA.scopeCounts).toMatchObject({ sessions: 1, jobs: 2 });
    expect(statusB.scopeCounts).toMatchObject({ sessions: 0, jobs: 0 });
    expect(explicitIgnored.scope).toEqual({ mode: "scoped", source: "host-metadata" });
    expect(deniedAudit.isError).toBe(true);
    expect(JSON.stringify(deniedAudit)).toContain("cannot request the bridge-wide audit view");
    expect(JSON.stringify(statusA)).not.toContain("chat-session-a");
    expect(JSON.stringify(statusA)).not.toContain("anonymous-user");
    expect(JSON.stringify(statusA)).not.toContain("anonymous-org");
    await close();
  });

  it("requires an explicit compatibility scope only when host metadata is absent", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

    const missing = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        activityPresentationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        prompt: "missing scope"
      }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("explicit compatibility scopeId");

    const compatible = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "abababab-abab-4aba-8aba-abababababab",
        activityPresentationId: "abababab-abab-4aba-8aba-abababababab",
        prompt: "compatibility scope",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new", title: "Compatibility scope task" },
        agent: { mode: "new", name: "Compatibility Agent" }
      }
    });
    expect(jobs.get(parseToolJson(compatible).jobId)?.scopeId).toBe(SCOPE_A);
    await close();
  });

  it("uses the same host-derived scope for job cancellation", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const metadata = { "openai/session": "cancel-session" };
    const started = parseToolJson(
      await rawCallTool({
        name: "codex_task",
        arguments: {
          requestId: "acacacac-acac-4aca-8aca-acacacacacac",
          prompt: "cancel derived job",
          project: { name: "Test Project", registryRevision: 1 },
          activity: { mode: "new", title: "Cancelable derived task", policy: { kind: "implementation" } },
          agent: { mode: "new", name: "Cancellation Agent" }
        },
        _meta: { ...metadata, "codex/activityPresentationId": "acacacac-acac-4aca-8aca-acacacacacac" }
      })
    );
    await Promise.resolve();
    const currentVersion = jobs.get(started.jobId)?.version as number;

    const denied = await rawCallTool({
      name: "codex_cancel",
      arguments: {
        requestId: "adadadad-adad-4ada-8ada-adadadadadad",
        jobId: started.jobId,
        expectedVersion: currentVersion,
        reason: "The user stopped this job"
      },
      _meta: { "openai/session": "another-cancel-session" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("another conversation scope");

    const cancelled = parseToolJson(
      await rawCallTool({
        name: "codex_cancel",
        arguments: {
          requestId: "aeaeaeae-aeae-4aea-8aea-aeaeaeaeaeae",
          jobId: started.jobId,
          expectedVersion: currentVersion,
          reason: "The user stopped this job"
        },
        _meta: metadata
      })
    );
    expect(cancelled.job.status).toBe("cancelled");
    await close();
  });

  it("normalizes UUID casing before routing sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    const started = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: UPPERCASE_SCOPE,
        prompt: "start",
        sessionMode: "new"
      }
    });
    expect(jobs.get(parseToolJson(started).jobId)?.scopeId).toBe(UPPERCASE_SCOPE.toLowerCase());
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { scopeId: UPPERCASE_SCOPE.toLowerCase() }
      })
    );
    expect(status.counts.sessions).toBe(1);
    await close();
  });

  it("requires an exact Agent after parallel work creates multiple Activity assignments", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const plan = await runTask(client, {
      prompt: "plan",
      agentName: "Planner",
      contextMode: "fresh"
    });
    const activityId = taskActivityId(plan);
    const planAgentId = parseToolJson(plan).agentId;
    const build = await runTask(client, {
      prompt: "build",
      agentName: "Builder",
      contextMode: "fresh",
      activityId
    });
    const buildAgentId = parseToolJson(build).agentId;
    const ambiguous = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "which thread?", activityId }
    });
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous)).toContain("AGENT_ID_REQUIRED");
    expect(JSON.stringify(ambiguous)).not.toContain("thread-1");
    expect(JSON.stringify(ambiguous)).not.toContain("thread-2");

    await runTask(client, {
      prompt: "refine plan",
      agentId: planAgentId,
      contextMode: "continue",
      activityId
    });
    await runTask(client, {
      prompt: "continue build",
      agentId: buildAgentId,
      contextMode: "continue",
      activityId
    });

    expect(upstream.calls.slice(2)).toEqual([
      {
        name: "codex-reply",
        args: {
          threadId: "thread-1",
          prompt: "refine plan",
          _bridgeBackendKind: "mcp-server"
        }
      },
      {
        name: "codex-reply",
        args: {
          threadId: "thread-2",
          prompt: "continue build",
          _bridgeBackendKind: "mcp-server"
        }
      }
    ]);
    await close();
  });

  it("deduplicates request retries and rejects request-id reuse with changed arguments", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId,
      prompt: "one logical task",
      activity: {
        mode: "new" as const,
        title: "Deduplicated Activity",
        policy: { kind: "investigation" as const }
      },
      agent: { mode: "new" as const, name: "Deduplicated Agent" },
      executionMode: "background" as const
    };

    const firstResult = await client.callTool({ name: "codex_task", arguments: arguments_ });
    const retryResult = await client.callTool({ name: "codex_task", arguments: arguments_ });
    const first = parseToolJson(firstResult);
    const retry = parseToolJson(retryResult);
    expect(retry.jobId).toBe(first.jobId);
    expect(retry.activityId).toBe(first.activityId);
    expect((firstResult as { _meta?: unknown })._meta).toBeUndefined();
    expect((retryResult as { _meta?: unknown })._meta).toBeUndefined();
    const compactPresentation = await presentCompactActivity(
      client,
      first.activityId,
      requestId
    );
    expect(privateActivityView(compactPresentation)).toMatchObject({
      mountedActivity: { activityId: first.activityId, cardGeneration: 1 },
      mountedPresentation: {
        kind: "automatic",
        activityPresentationId: requestId
      }
    });
    expect(upstream.calls).toHaveLength(1);

    const changed = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_, prompt: "changed task" }
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("already used for a different Codex task");
    const changedActivity = await client.callTool({
      name: "codex_task",
      arguments: {
        ...arguments_,
        activity: { ...arguments_.activity, title: "Different Activity" }
      }
    });
    expect(changedActivity.isError).toBe(true);
    expect(JSON.stringify(changedActivity)).toContain("already used for a different Codex task");
    const changedPresentation = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        ...arguments_,
        activityPresentationId: "24242424-0000-4000-8000-000000000099"
      }
    }));
    expect(changedPresentation.jobId).toBe(first.jobId);
    expect(changedPresentation.activityId).toBe(first.activityId);
    const omittedPresentation = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_ }
    });
    expect(parseToolJson(omittedPresentation)).toMatchObject({
      activityId: first.activityId,
      jobId: first.jobId,
      replay: true
    });
    expect((omittedPresentation as { _meta?: unknown })._meta).toBeUndefined();

    upstream.resolveNext(fakeCodexResult("deduped-thread"));
    await waitForJobStatus(client, first.jobId, "completed");
    const completedRetry = await client.callTool({ name: "codex_task", arguments: arguments_ });
    expect(parseToolJson(completedRetry)).toMatchObject({
      threadId: "deduped-thread",
      requestId,
      activityId: first.activityId,
      jobId: first.jobId,
      executionMode: "background",
      replay: true
    });
    expect((completedRetry as { _meta?: unknown })._meta).toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("registers concurrent exact v4 retries before duplicating Agent creation", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const arguments_ = {
      requestId: "37373737-3737-4737-8737-373737373737",
      prompt: "one concurrent logical task",
      activity: {
        mode: "new" as const,
        title: "Concurrent retry",
        policy: { kind: "implementation" as const }
      },
      agent: { mode: "new" as const, name: "Concurrent Retry Agent" },
      executionMode: "background" as const
    };

    const [first, second] = await Promise.all([
      client.callTool({ name: "codex_task", arguments: arguments_ }),
      client.callTool({ name: "codex_task", arguments: arguments_ })
    ]);
    const firstJob = parseToolJson(first);
    const secondJob = parseToolJson(second);
    expect(secondJob.jobId).toBe(firstJob.jobId);
    expect(secondJob.activityId).toBe(firstJob.activityId);
    expect(upstream.calls).toHaveLength(1);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);

    upstream.resolveNext(fakeCodexResult("concurrent-retry-thread"));
    await waitForJobStatus(client, firstJob.jobId, "completed");
    await close();
  });

  it("rolls back nested Activity policy and Agent creation when job admission fails", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "1"
    });
    const { client, jobs, close } = await connectTestClient(config, upstream);
    const admitted = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "occupy the only admission slot",
        activity: { mode: "new" },
        agent: { mode: "new", name: "Occupying Agent" }
      }
    }));
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toHaveLength(1);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);

    const rejected = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must roll back before admission",
        activity: {
          mode: "new",
          title: "Rolled-back Activity",
          policy: {
            kind: "implementation",
            handoff: "verify",
            completion: "sealed-jobs-terminal"
          }
        },
        agent: { mode: "new", name: "Rolled-back Agent" }
      }
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("Too many Codex jobs are running");
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toHaveLength(1);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);
    expect(jobs.listActivities(SCOPE_A, 100, 0))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Rolled-back Activity" })]));
    expect(jobs.listAgents(SCOPE_A, true, 100, 0))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ agentName: "Rolled-back Agent" })]));

    upstream.resolveNext(fakeCodexResult("occupying-thread"));
    await waitForJobStatus(client, admitted.jobId, "completed");
    await close();
  });

  it("normalizes v4 defaults and exact model selection across semantic retries", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId: "34343434-3434-4434-8434-343434343434",
      activityPresentationId: "34343434-3434-4434-8434-343434343434",
      prompt: "normalize admitted defaults",
      project: { name: "Test Project", registryRevision: 1 },
      activity: { mode: "new" as const, title: "Normalized defaults" },
      agent: { mode: "new" as const }
    };

    const first = await rawCallTool({ name: "codex_task", arguments: arguments_ });
    const admitted = jobs.listForScope(SCOPE_A)[0];
    expect(admitted).toMatchObject({
      requestHashVersion: 6,
      executionMode: "background",
      executionDecision: {
        effectiveSelection: expect.objectContaining({
          model: expect.any(String),
          reasoningEffort: expect.any(String)
        })
      }
    });
    const effectiveSelection = admitted!.executionDecision!.effectiveSelection;
    const retry = await rawCallTool({
      name: "codex_task",
      arguments: {
        ...arguments_,
        activity: {
          mode: "new",
          title: "Normalized defaults",
          policy: { kind: "other", handoff: "none", completion: "manual" }
        },
        agent: { mode: "new", name: "Codex Agent 34343434-3434-4434-8434-343434343434" },
        executionMode: "background",
        selection: {
          model: effectiveSelection.model,
          reasoningEffort: effectiveSelection.reasoningEffort
        }
      }
    });
    expect(parseToolJson(retry)).toMatchObject({
      activityId: parseToolJson(first).activityId,
      jobId: admitted!.jobId,
      replay: true
    });
    expect(upstream.calls).toHaveLength(1);

    const differentSelection = effectiveSelection.model === "gpt-5.6-terra"
      ? { model: "gpt-5.6-sol", reasoningEffort: "max" }
      : { model: "gpt-5.6-terra", reasoningEffort: "high" };
    const changedSelection = await rawCallTool({
      name: "codex_task",
      arguments: {
        ...arguments_,
        selection: differentSelection
      }
    });
    expect(changedSelection.isError).toBe(true);
    expect(JSON.stringify(changedSelection)).toContain(
      "requestId was already used for a different Codex task"
    );
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("keeps an exact-selection retry stable after a fixed-policy change", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const catalog = new FakeModelCatalog();
    const { rawCallTool, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      catalog,
      settings
    );
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      executionPolicyRef: settings.executionPolicyRef(
        settings.current,
        modelCatalogAdmissionFingerprint(catalog.getCachedCatalog().models)
      ),
      activityPresentationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      prompt: "same raw request with an omitted mode",
      project: { name: "Test Project", registryRevision: 1 },
      activity: {
        mode: "new" as const,
        title: "Stable exact-selection retry",
        policy: { kind: "investigation" as const }
      },
      agent: { mode: "new" as const, name: "Stable Retry Agent" },
      selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
    };

    const first = await rawCallTool({ name: "codex_task", arguments: arguments_ });
    settings.update({
      modelPolicy: {
        mode: "fixed",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        constraints: { allowDelegation: true }
      }
    }, 0);
    const retry = await rawCallTool({ name: "codex_task", arguments: arguments_ });

    const firstStructured = parseToolJson(first);
    const retryStructured = parseToolJson(retry);
    expect(retryStructured).toMatchObject({
      activityId: firstStructured.activityId,
      jobId: firstStructured.jobId,
      executionMode: "background",
      requestId: arguments_.requestId,
      replay: true
    });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("retires low-level thread adoption and preserves scope-local Agent ownership", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, {
      prompt: "start",
      scopeId: SCOPE_A,
      agentName: "Owned Agent",
      contextMode: "fresh"
    });

    const denied = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        prompt: "take over",
        sessionMode: "continue",
        threadId: "thread-1"
      }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("threadId");
    expect(JSON.stringify(denied)).toContain("Unrecognized key");

    const adoption = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        prompt: "take over",
        sessionMode: "continue",
        threadId: "thread-1",
        adoptThread: true
      }
    });
    expect(adoption.isError).toBe(true);
    expect(JSON.stringify(adoption)).toContain("Unrecognized keys");
    const statusA = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_A } })
    );
    const statusB = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_B } })
    );
    expect(statusA.counts).toMatchObject({ sessions: 1, jobs: 1 });
    expect(statusB.counts).toMatchObject({ sessions: 0, jobs: 0 });
    expect(jobs.listForScope(SCOPE_A)).toHaveLength(1);
    expect(jobs.listForScope(SCOPE_B)).toHaveLength(0);
    await close();
  });

  it("filters status details by scope and exposes all scopes only on explicit audit", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "A", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "B", sessionMode: "new", scopeId: SCOPE_B });

    const statusA = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_A } })
    );
    const statusB = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_B } })
    );
    const policyOnly = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {} })
    );
    const audit = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: { includeAllScopes: true } })
    );

    expect(statusA.counts).toMatchObject({ sessions: 1, jobs: 1 });
    expect(statusB.counts).toMatchObject({ sessions: 1, jobs: 1 });
    expect(policyOnly).toMatchObject({
      scope: { mode: "policy-only" },
      counts: { sessions: 0, jobs: 0 },
      items: []
    });
    expect(audit).toMatchObject({
      scope: { mode: "all" },
      counts: { sessions: 2, jobs: 2 }
    });
    expect(audit.items.filter((entry: { type: string }) => entry.type === "job")).toHaveLength(2);
    await close();
  });

  it("reports scoped totals independently from paginated session and job pages", async () => {
    const root = temporaryRoot();
    const sessions = new SessionRegistry();
    const now = Date.now();
    for (let index = 0; index < 11; index += 1) {
      sessions.record({
        threadId: `scope-a-thread-${index}`,
        scopeId: SCOPE_A,
        cwd: realpathSync(root),
        sandbox: "read-only",
        createdAt: now + index,
        lastUsedAt: now + index
      });
    }
    sessions.record({
      threadId: "scope-b-thread",
      scopeId: SCOPE_B,
      cwd: realpathSync(root),
      sandbox: "read-only",
      createdAt: now + 20,
      lastUsedAt: now + 20
    });
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream, sessions);
    await runTask(client, { prompt: "job one", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "job two", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "job three", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "other job", sessionMode: "new", scopeId: SCOPE_B });

    const firstSessions = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { scopeId: SCOPE_A, query: { kind: "page", collection: "sessions", limit: 10 } }
    }));
    const secondSessions = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        query: {
          kind: "page",
          collection: "sessions",
          limit: 10,
          cursor: firstSessions.pagination.nextCursor
        }
      }
    }));
    const firstJobs = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { scopeId: SCOPE_A, query: { kind: "page", collection: "jobs", limit: 2 } }
    }));
    const secondJobs = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        query: {
          kind: "page",
          collection: "jobs",
          limit: 2,
          cursor: firstJobs.pagination.nextCursor
        }
      }
    }));

    expect(firstSessions.scopeCounts).toEqual({
      sessions: 14,
      activities: 3,
      agents: 3,
      orphanedAgents: 0,
      jobs: 3,
      runningJobs: 0
    });
    expect(firstSessions.items).toHaveLength(10);
    expect(firstSessions.page).toMatchObject({
      offset: 0, returned: 10, total: 14, hasMore: true,
      nextCursor: expect.any(String)
    });
    expect(secondSessions.items).toHaveLength(4);
    expect(secondSessions.page).toMatchObject({
      offset: 10, returned: 4, total: 14, hasMore: false
    });
    expect(secondSessions.page).not.toHaveProperty("nextCursor");
    expect(firstJobs.items).toHaveLength(2);
    expect(firstJobs.page).toMatchObject({
      offset: 0, returned: 2, total: 3, hasMore: true,
      nextCursor: expect.any(String)
    });
    expect(secondJobs.items).toHaveLength(1);
    expect(secondJobs.page).toMatchObject({
      offset: 2, returned: 1, total: 3, hasMore: false
    });
    expect(secondJobs.page).not.toHaveProperty("nextCursor");
    const compactJobs = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "page", collection: "jobs", limit: 2 } }
      })
    );
    expect(compactJobs).toMatchObject({
      kind: "page",
      scope: { mode: "scoped" },
      counts: { jobs: 3 },
      page: { collection: "jobs", offset: 0, returned: 2, total: 3, hasMore: true },
      items: [
        expect.objectContaining({ type: "job" }),
        expect.objectContaining({ type: "job" })
      ]
    });
    expect(compactJobs.items.every((entry: Record<string, unknown>) => !("scopeId" in entry)))
      .toBe(true);
    const compactNext = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: {
          query: {
            kind: "page",
            collection: "jobs",
            limit: 2,
            cursor: compactJobs.pagination.nextCursor
          }
        }
      })
    );
    expect(compactNext).toMatchObject({
      page: { offset: 2, returned: 1, total: 3, hasMore: false },
      items: [expect.objectContaining({ type: "job" })]
    });
    const malformed = await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        query: { kind: "page", collection: "sessions", cursor: "not-a-valid-cursor" }
      }
    });
    expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed)).toContain("Invalid or mismatched sessions pagination cursor");
    await close();
  });

  it("reuses one thread across separate Activities and returns exact thread turns", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const firstResult = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "first intent", sessionMode: "new", activityTitle: "First Activity" }
    });
    const first = parseToolJson(firstResult);
    const agentId = first.agentId;
    const secondResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "reuse the thread for a separate intent",
        activity: { mode: "new", title: "Second Activity" },
        agent: { mode: "existing", id: agentId, context: "continue" }
      }
    });
    const second = parseToolJson(secondResult);
    expect(first.activityId).not.toBe(second.activityId);

    const detail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "thread", id: "thread-1" } }
    }));
    expect(detail.activities.map((activity: { activityId: string }) => activity.activityId).sort()).toEqual(
      [first.activityId, second.activityId].sort()
    );
    expect(detail.jobs).toHaveLength(2);
    const firstJobDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: first.jobId } }
    }));
    expect(firstJobDetail).toMatchObject({
      jobId: first.jobId,
      threadId: "thread-1"
    });
    const firstActivityDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "activity", id: first.activityId } }
    }));
    expect(firstActivityDetail).toMatchObject({ kind: "activity" });
    expect(firstActivityDetail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "activity", id: first.activityId }),
      expect.objectContaining({ type: "job", id: first.jobId })
    ]));
    const mixedContract = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: first.jobId },
        jobId: first.jobId
      }
    });
    expect(mixedContract.isError).toBe(true);
    expect(JSON.stringify(mixedContract)).toContain("Unrecognized key");
    expect(detail.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: first.jobId, status: "completed" }),
      expect.objectContaining({ jobId: second.jobId, status: "completed" })
    ]));
    await close();
  });

  it("uses the app-private Activity snapshot as the lightweight card watch API", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "watch this Activity",
        sessionMode: "new",
        executionMode: "background",
        activityTitle: "Watched Activity"
      }
    }));
    const rendered = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A },
      _meta: { "openai/locale": "ko-KR", "openai/widgetSessionId": "widget-render" }
    });
    const initial = privateActivityView(rendered);
    expect(initial.activities).toEqual([
      expect.objectContaining({ activityId: started.activityId, lifecycle: "open" })
    ]);
    expect(initial.feed.active[0].agents[0].execution).toEqual({
      model: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6 Sol",
      reasoningEffort: "max",
      isCurrent: true
    });
    expect((rendered as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "ko-KR"
    });
    expect((rendered as { _meta?: Record<string, any> })._meta).not.toHaveProperty("activityDetails");
    const cardPayload = JSON.stringify(rendered);
    expect(cardPayload).not.toContain(root);
    expect(cardPayload).not.toContain(path.basename(root));
    expect(cardPayload).not.toContain('"cwd"');
    expect(cardPayload).not.toContain('"backendKind"');
    expect(cardPayload).not.toContain('"threadId"');
    const card = {
      activityId: initial.mountedActivity.activityId,
      generation: initial.mountedActivity.cardGeneration,
      presentation: { kind: "explicit" as const }
    };

    const watchPromise = client.callTool({
      name: "codex_activity_snapshot",
      arguments: {
        card,
        afterVersion: initial.scopeVersion,
        waitMs: 1_000
      },
      _meta: { "openai/widgetSessionId": "widget-render" }
    });
    await Promise.resolve();
    upstream.progressNext({
      progress: 1,
      total: 2,
      message: "model rerouted",
      event: {
        eventId: "public-progress-1",
        type: "model",
        phase: "updated",
        createdAt: Date.now(),
        summary: "Model rerouted.",
        details: {
          kind: "rerouted",
          fromModel: "gpt-5.6-sol",
          toModel: "gpt-5.6-terra",
          reason: "test"
        }
      }
    } as Progress);
    const watched = await watchPromise;
    const next = (watched as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(next.scopeVersion).toBeGreaterThan(initial.scopeVersion);
    expect(next.wait).toMatchObject({ changed: true, timedOut: false });
    expect(next.agents[0]).toMatchObject({ displayState: "running", activityId: started.activityId });
    expect(next.feed.active[0].agents[0].execution).toEqual({
      model: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6 Sol",
      reasoningEffort: "max",
      reroutedModel: "gpt-5.6-terra",
      reroutedModelDisplayName: "GPT-5.6 Terra",
      isCurrent: true
    });
    expect(next.activities[0]).not.toHaveProperty("jobs");

    upstream.resolveNext(fakeCodexResult("watched-thread"));
    await waitForJobStatus(client, started.jobId, "completed");
    const completed = await client.callTool({ name: "codex_activity", arguments: {} });
    expect(privateActivityView(completed).feed.active[0].agents[0].execution).toEqual({
      model: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6 Sol",
      reasoningEffort: "max",
      reroutedModel: "gpt-5.6-terra",
      reroutedModelDisplayName: "GPT-5.6 Terra",
      isCurrent: false
    });
    await close();
  });

  it("treats an aborted Activity-card watch as lease cleanup and lets its job complete", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const startedResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "finish after the Activity-card watcher detaches",
        executionMode: "background"
      }
    });
    const started = parseToolJson(startedResult);
    await expect.poll(() => upstream.calls.length).toBe(1);
    const running = jobs.get(started.jobId)!;
    expect(running).toMatchObject({ status: "running" });

    const widgetInstanceId = "widget-watch-abort";
    const activityPresentation = await presentCompactActivity(
      client,
      started.activityId,
      "72727272-7272-4272-8272-727272727273"
    );
    const card = automaticCardProof(activityPresentation);
    const mounted = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: { scopeId: SCOPE_A, card },
      _meta: { "openai/widgetSessionId": widgetInstanceId }
    });
    const scopeVersion = (mounted as { structuredContent?: Record<string, any> })
      .structuredContent?.scopeVersion as number;
    const watchState = jobs as unknown as {
      activeWatchers: number;
      watcherLeases: Set<string>;
      activityCardLeases: Map<string, number>;
    };
    const controller = new AbortController();
    const watch = rawCallTool(
      {
        name: "codex_activity_snapshot",
        arguments: {
          scopeId: SCOPE_A,
          card,
          afterVersion: scopeVersion,
          waitMs: 60_000
        },
        _meta: { "openai/widgetSessionId": widgetInstanceId }
      },
      undefined,
      { signal: controller.signal }
    );
    await expect.poll(() => watchState.activeWatchers).toBe(1);
    expect(watchState.watcherLeases.size).toBe(1);
    expect(watchState.activityCardLeases.size).toBe(1);

    controller.abort();
    await expect(watch).rejects.toThrow(/cancel|abort/i);
    await expect.poll(() => watchState.activeWatchers).toBe(0);
    expect(watchState.watcherLeases.size).toBe(0);
    expect(watchState.activityCardLeases.size).toBe(0);
    expect(() => jobs.requireActivityCardLease(
      SCOPE_A,
      card.activityId,
      card.generation,
      widgetInstanceId,
      card.presentation
    )).toThrow(/CARD_LEASE_REQUIRED/);
    await expect.poll(() =>
      jobs.listTransportObservations("activity-watch-aborted").length
    ).toBeGreaterThan(0);
    expect(jobs.listTransportObservations("activity-watch-aborted")).toEqual([
      expect.objectContaining({
        kind: "activity-watch-aborted",
        scopeId: SCOPE_A,
        activityId: started.activityId,
        toolName: "codex_activity_snapshot",
        reasonCode: "host-aborted-activity-watch"
      })
    ]);
    expect(jobs.get(started.jobId)).toMatchObject({
      status: "running",
      version: running.version
    });
    expect(jobs.get(started.jobId)?.cancelRequestedAt).toBeUndefined();
    expect(jobs.get(started.jobId)?.cancellationIntentId).toBeUndefined();
    expect(jobs.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);
    const eventTypes = jobs.listJobEvents(started.jobId).map((event) => event.eventType);
    expect(eventTypes).not.toContain("cancellation-intent-recorded");
    expect(eventTypes).not.toContain("job-terminating");
    expect(eventTypes).not.toContain("job-cancelled");
    expect(upstream.aborts).toBe(0);

    upstream.resolveNext(fakeCodexResult("watch-abort-thread"));
    await waitForJobStatus(client, started.jobId, "completed");
    expect(jobs.get(started.jobId)).toMatchObject({
      status: "completed",
      terminalOrigin: "normal-completion"
    });
    expect(jobs.get(started.jobId)?.cancellationIntentId).toBeUndefined();
    expect(jobs.listCancellationIntents({ jobId: started.jobId })).toHaveLength(0);
    expect(upstream.aborts).toBe(0);
    await close();
  });

  it("keeps each Agent's own outcome in an older shared Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "complete the first role",
        activity: { mode: "new", title: "Mixed outcome Activity" },
        agent: { mode: "new", name: "Completed Participant" },
        executionMode: "background"
      }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "fail the second role",
        activity: { mode: "existing", id: first.activityId },
        agent: { mode: "new", name: "Failed Participant" },
        executionMode: "background"
      }
    }));

    upstream.resolveNext(fakeCodexResult("completed-participant-thread"));
    upstream.rejectNext(new Error("participant failed"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "failed")
    ]);

    const later = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "move the completed Agent to later work",
        activity: { mode: "new", title: "Later Activity" },
        agent: { mode: "existing", id: first.agentId, context: "fresh" },
        executionMode: "background"
      }
    }));
    const oldActivityCard = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "full-history",
        activityId: first.activityId
      }
    });
    const feed = privateActivityView(oldActivityCard).feed as {
      active: Array<Record<string, any>>;
      history: { rows: Array<Record<string, any>> };
    };
    const oldActivity = [...feed.active, ...feed.history.rows]
      .find((row) => row.activityId === first.activityId);
    expect(oldActivity?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentName: "Completed Participant",
        displayState: "completed"
      }),
      expect.objectContaining({
        agentName: "Failed Participant",
        displayState: "failed"
      })
    ]));

    upstream.resolveNext(fakeCodexResult("later-participant-thread"));
    await waitForJobStatus(client, later.jobId, "completed");
    expect(jobs.get(first.jobId)?.status).toBe("completed");
    await close();
  });

  it("renders one compact card for parallel task calls and keeps explicit cards distinct", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    const activityPresentationId = "24242424-2424-4424-8424-242424242424";
    const firstResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "first Agent",
        agentName: "Card Agent One",
        contextMode: "fresh",
        executionMode: "background"
      }
    });
    const first = parseToolJson(firstResult);
    expect((firstResult as { _meta?: unknown })._meta).toBeUndefined();
    const automaticPresentation = await presentCompactActivity(
      client,
      first.activityId,
      activityPresentationId
    );
    const automaticCard = automaticCardProof(automaticPresentation);
    const mounted = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: automaticCard
      },
      _meta: { "openai/widgetSessionId": "mounted-card" }
    });
    expect((mounted as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      mountedActivity: { activityId: first.activityId, cardGeneration: 1 },
      mountedPresentation: {
        kind: "automatic",
        activityPresentationId,
        reservationOwnerId: activityPresentationId
      },
      watcherPolicy: { live: true, ownsCompletionHandoff: true }
    });
    const retainedGenerationSnapshot = await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: first.activityId,
        cardGeneration: 1,
        presentationKind: "automatic",
        activityPresentationId
      },
      _meta: { "openai/widgetSessionId": "retained-generation-card" }
    });
    expect(retainedGenerationSnapshot.isError).toBe(true);
    expect(JSON.stringify(retainedGenerationSnapshot)).toContain("Unrecognized keys");

    const parallelResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel Agent",
        activityId: first.activityId,
        agentName: "Card Agent Two",
        contextMode: "fresh",
        executionMode: "background"
      }
    });
    const parallel = parseToolJson(parallelResult);
    expect((parallelResult as { _meta?: unknown })._meta).toBeUndefined();

    const differentActivityResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "different Activity in the same assistant response",
        agentName: "Card Agent Three",
        contextMode: "fresh",
        executionMode: "background"
      }
    });
    const differentActivity = parseToolJson(differentActivityResult);
    expect(differentActivity.activityId).not.toBe(first.activityId);
    expect((differentActivityResult as { _meta?: unknown })._meta).toBeUndefined();
    const parallelSnapshot = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: { scopeId: SCOPE_A, card: automaticCard },
      _meta: { "openai/widgetSessionId": "mounted-card" }
    });
    expect((parallelSnapshot as { structuredContent?: Record<string, any> })
      .structuredContent?.feed.active).toEqual(expect.arrayContaining([
        expect.objectContaining({
          activityId: first.activityId,
          agents: expect.arrayContaining([
            expect.objectContaining({ agentName: "Card Agent One" }),
            expect.objectContaining({ agentName: "Card Agent Two" })
          ])
        }),
        expect.objectContaining({
          activityId: differentActivity.activityId,
          agents: [expect.objectContaining({ agentName: "Card Agent Three" })]
        })
      ]));

    const explicit = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        activityId: first.activityId
      },
      _meta: { "openai/widgetSessionId": "explicit-card" }
    });
    expect(privateActivityView(explicit).presentation)
      .toMatchObject({
        shouldRenderActivityCard: true,
        renderReason: "explicit",
        presentationKind: "explicit"
      });
    expect(privateActivityView(explicit).watcherPolicy)
      .toMatchObject({ live: true, ownsCompletionHandoff: false, maxExplicitPerScope: 3 });

    upstream.resolveNext(fakeCodexResult("card-thread-1"));
    upstream.resolveNext(fakeCodexResult("card-thread-2"));
    upstream.resolveNext(fakeCodexResult("card-thread-3"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, parallel.jobId, "completed"),
      waitForJobStatus(client, differentActivity.jobId, "completed")
    ]);
    const nextPresentationId = "24242424-2424-4424-8424-242424242425";
    const nextResponseResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "same Activity in the next assistant response",
        activityId: first.activityId,
        agentId: first.agentId,
        contextMode: "continue",
        executionMode: "background"
      }
    });
    const nextResponse = parseToolJson(nextResponseResult);
    expect((nextResponseResult as { _meta?: unknown })._meta).toBeUndefined();
    const nextPresentation = await presentCompactActivity(
      client,
      nextResponse.activityId,
      nextPresentationId
    );
    const nextCard = automaticCardProof(nextPresentation);
    await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: nextCard
      },
      _meta: { "openai/widgetSessionId": "next-presentation-card" }
    });
    const stoppedOldPresentation = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: automaticCard,
        afterVersion: (mounted as { structuredContent?: Record<string, any> }).structuredContent
          ?.scopeVersion,
        waitMs: 1_000
      },
      _meta: { "openai/widgetSessionId": "mounted-card" }
    });
    expect((stoppedOldPresentation as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        watcherPolicy: {
          live: false,
          stopped: true,
          stopReason: "presentation-superseded",
          ownsCompletionHandoff: false
        },
        wait: {
          stopped: true,
          timedOut: false,
          stopReason: "presentation-superseded"
        }
      });
    expect(jobs.get(nextResponse.jobId)).toMatchObject({ status: "running" });
    expect(jobs.get(nextResponse.jobId)).not.toHaveProperty("cancellationIntentId");
    expect(jobs.listCancellationIntents({ jobId: nextResponse.jobId })).toHaveLength(0);
    expect(jobs.listTransportObservations("presentation-superseded")).not.toHaveLength(0);
    upstream.resolveNext(fakeCodexResult("card-thread-1"));
    await waitForJobStatus(client, nextResponse.jobId, "completed");
    await close();
  });

  it("requires a live private card proof and audits the dedicated card presentation", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const callerPresentationId = "82828282-8282-4282-8282-828282828282";
    const supersedingPresentationId = "83838383-8383-4383-8383-838383838383";
    const widgetInstanceId = "84848484-8484-4484-8484-848484848484";
    const cancellationRequestId = "85858585-8585-4585-8585-858585858585";
    const startedResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "cancel from the exact mounted card",
        sessionMode: "new",
        executionMode: "background"
      }
    });
    const started = parseToolJson(startedResult);
    expect((startedResult as { _meta?: unknown })._meta).toBeUndefined();
    await Promise.resolve();
    const compactPresentation = await presentCompactActivity(
      client,
      started.activityId,
      callerPresentationId
    );
    const card = automaticCardProof(compactPresentation);
    const mounted = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: { scopeId: SCOPE_A, card },
      _meta: { "openai/widgetSessionId": widgetInstanceId }
    });
    expect(mounted.isError).not.toBe(true);
    const expectedJobVersion = jobs.get(started.jobId)?.version as number;
    const cancellationArguments = {
      scopeId: SCOPE_A,
      requestId: cancellationRequestId,
      jobId: started.jobId,
      expectedJobVersion,
      card,
      acknowledgeAffectedJobIds: [started.jobId]
    };
    const cancelled = parseToolJson(await rawCallTool({
      name: "codex_activity_job_cancel",
      arguments: cancellationArguments,
      _meta: { "openai/widgetSessionId": widgetInstanceId }
    }));
    expect(cancelled).toMatchObject({
      kind: "mutation",
      action: "cancel-card-job",
      job: {
        status: "cancelled",
        terminalOrigin: "explicit-cancellation",
        cancellation: {
          logicalRequestId: cancellationRequestId,
          source: "widget-control",
          tool: "codex_activity_job_cancel",
          callerPresentation: {
            kind: "automatic",
            activityPresentationId: callerPresentationId
          },
          target: {
            jobId: started.jobId,
            presentationId: callerPresentationId
          },
          widgetProof: { present: true, cardGeneration: card.generation }
        }
      }
    });
    const replay = parseToolJson(await rawCallTool({
      name: "codex_activity_job_cancel",
      arguments: cancellationArguments,
      _meta: { "openai/widgetSessionId": widgetInstanceId }
    }));
    expect(replay).toEqual(cancelled);
    expect(upstream.aborts).toBe(1);
    const [intent] = jobs.listCancellationIntents({ requestId: cancellationRequestId });
    expect(intent).toMatchObject({
      source: "widget-control",
      callerPresentation: {
        kind: "automatic",
        activityPresentationId: callerPresentationId
      },
      targetPresentationId: callerPresentationId,
      widgetInstancePresent: true,
      cardGeneration: card.generation
    });
    expect(intent.widgetInstanceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.widgetInstanceDigest).not.toBe(widgetInstanceId);

    const supersedingPresentation = await presentCompactActivity(
      client,
      started.activityId,
      supersedingPresentationId
    );
    await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: { scopeId: SCOPE_A, card: automaticCardProof(supersedingPresentation) },
      _meta: { "openai/widgetSessionId": "superseding-widget" }
    });
    const stale = await rawCallTool({
      name: "codex_activity_job_cancel",
      arguments: {
        ...cancellationArguments,
        requestId: "86868686-8686-4686-8686-868686868686",
        expectedJobVersion: jobs.get(started.jobId)?.version
      },
      _meta: { "openai/widgetSessionId": widgetInstanceId }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("CARD_VERSION_UNSUPPORTED");
    expect(jobs.listCancellationIntents({
      requestId: "86868686-8686-4686-8686-868686868686"
    })).toHaveLength(0);
    expect(upstream.aborts).toBe(1);
    await close();
  });

  it("leases one Activity completion batch to only one mounted card", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    settings.update({ completionHandoff: "auto-handoff" }, settings.current.revision);
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const createNotifyActivity = async (prompt: string, title: string) => {
      const result = await client.callTool({
        name: "codex_task",
        arguments: {
          prompt,
          sessionMode: "new",
          activityTitle: title,
          handoffPolicy: "notify",
          completionTrigger: "sealed-jobs-terminal"
        }
      });
      const task = parseToolJson(result);
      expect((result as { _meta?: unknown })._meta).toBeUndefined();
      await client.callTool({
        name: "codex_activity_update",
        arguments: {
          activityId: task.activityId,
          expectedVersion: jobs.getActivity(task.activityId)?.version,
          operation: { kind: "seal" }
        }
      });
      return task;
    };
    const started = await createNotifyActivity(
      "notification payload must not be copied",
      "Notify once"
    );
    const secondActivity = await createNotifyActivity("second private payload", "Notify twice");
    const explicitView = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A }
    });
    expect(privateActivityView(explicitView)).toMatchObject({
        pendingHandoffs: [],
        watcherPolicy: { presentationKind: "explicit", ownsCompletionHandoff: false }
      });
    const compactPresentation = await presentCompactActivity(
      client,
      secondActivity.activityId,
      "61616161-6161-4161-8161-616161616161"
    );
    const card = automaticCardProof(compactPresentation);
    const view = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const pending = (view as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: started.activityId, channel: "notify" }),
      expect.objectContaining({ activityId: secondActivity.activityId, channel: "notify" })
    ]));
    expect((view as { structuredContent?: Record<string, any> }).structuredContent?.feed)
      .toMatchObject({
        mode: "compact",
        historySummary: { completedActivities: 0 },
        history: { rows: [] },
        active: expect.arrayContaining([
          expect.objectContaining({
            activityId: started.activityId,
            displayState: "waiting-gpt",
            pendingHandoff: true
          }),
          expect.objectContaining({
            activityId: secondActivity.activityId,
            displayState: "waiting-gpt",
            pendingHandoff: true
          })
        ])
      });
    const outboxIds = pending.map((event: Record<string, any>) => event.outboxId);
    const peerSnapshot = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: { scopeId: SCOPE_A, card },
      _meta: { "openai/widgetSessionId": "widget-two" }
    });
    expect(peerSnapshot.isError).not.toBe(true);
    expect((peerSnapshot as { structuredContent?: Record<string, any> })
      .structuredContent?.watcherPolicy).toMatchObject({
        presentationKind: "automatic",
        live: false,
        stopped: true,
        stopReason: "presentation-duplicate",
        ownsCompletionHandoff: false
      });
    const retainedPresentationArgs = {
      presentationKind: "automatic" as const,
      activityPresentationId: card.presentation.activityPresentationId
    };
    await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: secondActivity.activityId,
        cardGeneration: card.generation,
        ...retainedPresentationArgs
      },
      _meta: { "openai/widgetSessionId": "widget-retained" }
    });

    const first = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, card },
      _meta: { "openai/widgetSessionId": "widget-one" }
    }));
    const second = await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, card },
      _meta: { "openai/widgetSessionId": "widget-two" }
    });
    expect(first).toMatchObject({
      claimed: true,
      origin: "activity-handoff",
      handoffDepth: 1,
      handoffBatchId: expect.stringMatching(/^handoff-/),
      events: expect.arrayContaining([
        expect.objectContaining({ outboxId: outboxIds[0] }),
        expect.objectContaining({ outboxId: outboxIds[1] })
      ])
    });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("CARD_LEASE_REQUIRED");
    const retainedGenerationClaim = await rawCallTool({
      name: "codex_activity_handoff",
      arguments: {
        scopeId: SCOPE_A,
        action: "claim-batch",
        outboxIds,
        ...retainedPresentationArgs
      },
      _meta: { "openai/widgetSessionId": "widget-retained" }
    });
    expect(retainedGenerationClaim.isError).toBe(true);
    expect(JSON.stringify(retainedGenerationClaim)).toContain("card");
    expect(JSON.stringify(first)).not.toContain("notification payload must not be copied");

    const failedBatch = await rawCallTool({
      name: "codex_activity_handoff",
      arguments: {
        scopeId: SCOPE_A,
        action: "delivered-batch",
        outboxIds: [outboxIds[0], 999_999_999],
        card
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    expect(failedBatch.isError).toBe(true);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "release-batch", outboxIds, card },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const reclaimed = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, card },
      _meta: { "openai/widgetSessionId": "widget-one" }
    }));
    expect(reclaimed.events).toHaveLength(2);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "delivered-batch", outboxIds, card },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const after = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    expect((after as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs).toEqual([]);
    await close();
  });

  it("pins new Agent contexts to explicit projects while allowing adaptive sandbox and exact selections", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`,
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const settings = new UserSettingsStore(config);
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings,
      undefined,
      false
    );

    settings.update({
      projects: [
        { id: "first", label: "First", cwd: first },
        { id: "second", label: "Second", cwd: second }
      ]
    }, settings.current.revision);
    const firstResult = await runTask(client, {
      prompt: "first",
      projectId: "first",
      agentName: "First Root",
      contextMode: "fresh"
    });
    const secondResult = await runTask(client, {
      prompt: "other cwd",
      projectId: "second",
      agentName: "Second Root",
      contextMode: "fresh"
    });
    await runTask(client, {
      prompt: "write",
      projectId: "second",
      agentName: "Writer",
      contextMode: "fresh",
      sandbox: "workspace-write"
    });
    await runTask(client, {
      prompt: "other model",
      projectId: "second",
      agentName: "Other Model",
      contextMode: "fresh",
      selection: { model: "gpt-5.6-terra", reasoningEffort: "medium" }
    });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex", "codex", "codex"]);
    expect(upstream.calls.map((call) => call.args.cwd)).toEqual([
      realpathSync(first),
      realpathSync(second),
      realpathSync(second),
      realpathSync(second)
    ]);
    expect(upstream.calls[2]?.args.sandbox).toBe("workspace-write");
    const card = await client.callTool({ name: "codex_activity", arguments: {} });
    const cardView = privateActivityView(card);
    expect(new Set(cardView.feed.active.flatMap(
      (activity: { workspaceLabels: string[] }) => activity.workspaceLabels
    ))).toEqual(new Set(["First", "Second"]));
    const otherModel = cardView.feed.active.find((activity: { agents: Array<{ agentName: string }> }) =>
      activity.agents.some((agent) => agent.agentName === "Other Model")
    );
    expect(otherModel.agents.find((agent: { agentName: string }) =>
      agent.agentName === "Other Model"
    )?.execution).toEqual({
      model: "gpt-5.6-terra",
      modelDisplayName: "GPT-5.6 Terra",
      reasoningEffort: "medium",
      isCurrent: false
    });
    expect(JSON.stringify(card)).not.toContain(realpathSync(first));
    expect(JSON.stringify(card)).not.toContain(realpathSync(second));

    for (const result of [firstResult, secondResult]) {
      const activityId = parseToolJson(result).activityId;
      await client.callTool({
        name: "codex_activity_update",
        arguments: {
          activityId,
          expectedVersion: jobs.getActivity(activityId)?.version,
          operation: { kind: "complete", reason: "accepted for history rendering" }
        }
      });
    }
    const historyCard = await client.callTool({ name: "codex_activity", arguments: {} });
    const historyView = privateActivityView(historyCard);
    expect(historyView.feed.showWorkspaceLabels).toBe(true);
    expect(new Set(historyView.feed.completed.rows.flatMap(
      (row: { workspaceLabels: string[] }) => row.workspaceLabels
    ))).toEqual(new Set(["First", "Second"]));
    expect(historyView.feed.completed.rows.find(
      (row: { agentName: string }) => row.agentName === "First Root"
    )?.execution).toEqual({
      model: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6 Sol",
      reasoningEffort: "max",
      isCurrent: false
    });
    await close();
  });

  it("requires a project for sole-project new/fresh work and inherits it only on continue", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);

    const omitted = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "63636363-6363-4363-8363-636363636363",
        activityPresentationId: "64646464-6464-4464-8464-646464646464",
        prompt: "do not choose the sole project implicitly",
        activity: { mode: "new" },
        agent: { mode: "new", name: "Explicit Project Agent" },
        executionMode: "foreground"
      }
    });
    expect(omitted.isError).toBe(true);
    expect(JSON.stringify(omitted)).toContain("PROJECT_REQUIRED");
    expect(upstream.calls).toEqual([]);

    const started = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "65656565-6565-4565-8565-656565656565",
        activityPresentationId: "66666666-6666-4666-8666-666666666666",
        prompt: "use the sole project explicitly",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new" },
        agent: { mode: "new", name: "Explicit Project Agent" },
        executionMode: "foreground"
      }
    });
    const startedView = parseToolJson(started);
    const activityId = startedView.activityId as string;
    const agentId = startedView.agentId as string;
    expect(startedView.projectName).toBe("Test Project");

    const continued = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "67676767-6767-4767-8767-676767676767",
        activityPresentationId: "68686868-6868-4868-8868-686868686868",
        prompt: "inherit the pinned project",
        activity: { mode: "existing", id: activityId },
        agent: { mode: "existing", id: agentId, context: "continue" },
        executionMode: "foreground"
      }
    });
    expect(parseToolJson(continued).projectName).toBe("Test Project");

    const freshOmitted = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "69696969-6969-4969-8969-696969696969",
        activityPresentationId: "70707070-7070-4070-8070-707070707070",
        prompt: "fresh still requires an exact project",
        activity: { mode: "existing", id: activityId },
        agent: { mode: "existing", id: agentId, context: "fresh" },
        executionMode: "foreground"
      }
    });
    expect(freshOmitted.isError).toBe(true);
    expect(JSON.stringify(freshOmitted)).toContain("PROJECT_REQUIRED");
    expect(upstream.calls).toHaveLength(2);
    await close();
  });

  it("keeps an unaffected project selector byte-identical across unrelated registry changes", async () => {
    const root = temporaryRoot();
    const second = path.join(root, "second");
    mkdirSync(second);
    const upstream = new FakeUpstream();
    const { client, rawCallTool, settings, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const beforeTask = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    const stableDescriptor = structuredClone(beforeTask);
    const beforeProject = settings.current.projects[0]!;
    const beforeSelector = {
      name: beforeProject.name,
      projectRef: beforeProject.projectRef,
      projectRevision: beforeProject.projectRevision
    };

    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Second Project", cwd: second } }],
      undefined,
      settings.current.registryRevision
    );

    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: "18181818-1818-4818-8818-181818181818",
        prompt: "use unaffected project selector",
        project: beforeSelector,
        activity: { mode: "new" },
        agent: { mode: "new", name: "Stable Selector Agent" },
        executionMode: "foreground"
      }
    });
    expect(admitted.isError).not.toBe(true);
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(root));

    await client.callTool({ name: "codex_models", arguments: {} });
    const afterTask = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_task"
    )!;
    expect(afterTask).toEqual(stableDescriptor);
    expect(JSON.stringify(afterTask)).not.toContain("Second Project");
    await close();
  });

  it("fails closed at runtime for a stale legacy registry descriptor without admitting side effects", async () => {
    const root = temporaryRoot();
    const second = path.join(root, "second");
    mkdirSync(second);
    const upstream = new FakeUpstream();
    const { rawCallTool, jobs, settings, close } = await connectTestClient(configFor(root), upstream);

    const staleSelection = { name: "Test Project", registryRevision: 1 };
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Second Project", cwd: second } }],
      undefined,
      1
    );
    const rejected = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "91919191-9191-4191-8191-919191919191",
        activityPresentationId: "92929292-9292-4292-8292-929292929292",
        prompt: "a missed tools/list_changed notification must not admit work",
        project: staleSelection,
        activity: { mode: "new" },
        agent: { mode: "new", name: "Stale Mapping Agent" },
        executionMode: "foreground"
      }
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("PROJECT_REGISTRY_CHANGED");
    expect(upstream.calls).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listForScope(SCOPE_A)).toEqual([]);

    // The generation token prevents stale mappings. At the same current
    // generation, another exact valid name is a semantically valid selection;
    // the bridge cannot infer whether the model intended a different project.
    const validOther = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "93939393-9393-4393-8393-939393939393",
        activityPresentationId: "94949494-9494-4494-8494-949494949494",
        prompt: "select another exact current project",
        project: { name: "Second Project", registryRevision: 2 },
        activity: { mode: "new" },
        agent: { mode: "new", name: "Current Mapping Agent" },
        executionMode: "foreground"
      }
    });
    expect(validOther.isError).not.toBe(true);
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(second));
    await close();
  });

  it("rechecks registry identity inside the Activity-Agent-Job admission transaction", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const catalog = new AdmissionMutatingModelCatalog();
    const { client, rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      catalog
    );
    const project = settings.current.projects[0];
    const projectSelection = {
      name: project.name,
      projectRef: project.projectRef,
      projectRevision: project.projectRevision
    };
    catalog.beforeGet = () => settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: project.id, name: "Renamed During Admission" }],
      undefined,
      1
    );

    const raced = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: "95959595-9595-4595-8595-959595959595",
        activityPresentationId: "96969696-9696-4696-8696-969696969696",
        prompt: "race the registry immediately before admission",
        project: projectSelection,
        activity: { mode: "new" },
        agent: { mode: "new", name: "TOCTOU Agent" },
        executionMode: "foreground"
      }
    });
    expect(raced.isError).toBe(true);
    expect(JSON.stringify(raced)).toContain("PROJECT_REGISTRY_CHANGED");
    expect(settings.current).toMatchObject({ registryRevision: 2 });
    expect(upstream.calls).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listForScope(SCOPE_A)).toEqual([]);
    await close();
  });

  it("rechecks a new Activity selection atomically while continuing a pinned Agent", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const catalog = new AdmissionMutatingModelCatalog();
    const { rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      catalog
    );
    const seeded = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "97979797-9797-4797-8797-979797979797",
        activityPresentationId: "98989898-9898-4898-8898-989898989898",
        prompt: "seed the pinned Agent",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new" },
        agent: { mode: "new", name: "Pinned Admission Agent" },
        executionMode: "foreground"
      }
    });
    const agentId = parseToolJson(seeded).agentId as string;
    const project = settings.current.projects[0]!;
    catalog.beforeGet = () => settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: project.id, name: "Renamed During Continue" }],
      undefined,
      1
    );

    const raced = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "99999999-9999-4999-8999-999999999999",
        activityPresentationId: "90909090-9090-4090-8090-909090909090",
        prompt: "create a new Activity on the pinned Agent",
        project: { name: "Test Project", registryRevision: 1 },
        activity: { mode: "new", title: "Raced continuation" },
        agent: { mode: "existing", id: agentId, context: "continue" },
        executionMode: "foreground"
      }
    });
    expect(raced.isError).toBe(true);
    expect(JSON.stringify(raced)).toContain("PROJECT_REGISTRY_CHANGED");
    expect(upstream.calls).toHaveLength(1);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toHaveLength(1);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);
    expect(jobs.listForScope(SCOPE_A)).toHaveLength(1);
    await close();
  });

  it("projects exact project names and pins routing across Activities, Agents, and archival", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const firstCwd = realpathSync(first);
    const secondCwd = realpathSync(second);
    const upstream = new FakeUpstream();
    const sessions = new SessionRegistry();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const settings = new UserSettingsStore(config);
    settings.update({
      projects: [
        { id: "alpha", label: "알파 저장소", cwd: first },
        { id: "beta", label: "Beta Workspace", cwd: second }
      ]
    }, settings.current.revision);
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      config,
      upstream,
      sessions,
      new FakeModelCatalog(),
      settings,
      undefined,
      false
    );

    const taskDescriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task");
    const descriptorJson = JSON.stringify(taskDescriptor?.inputSchema);
    expect(descriptorJson).not.toContain("알파 저장소");
    expect(descriptorJson).not.toContain("Beta Workspace");
    expect(taskDescriptor?.inputSchema.properties?.project).toMatchObject({
      type: "object",
      required: ["name", "projectRef", "projectRevision"],
      additionalProperties: false
    });
    expect(descriptorJson).not.toContain(firstCwd);
    expect(descriptorJson).not.toContain(secondCwd);

    const alphaProject = settings.current.projects.find((project) => project.name === "알파 저장소")!;
    const betaProject = settings.current.projects.find((project) => project.name === "Beta Workspace")!;
    const alphaSelector = {
      name: alphaProject.name,
      projectRef: alphaProject.projectRef,
      projectRevision: alphaProject.projectRevision
    };
    const betaSelector = {
      name: betaProject.name,
      projectRef: betaProject.projectRef,
      projectRevision: betaProject.projectRevision
    };

    const missing = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "61616161-6161-4161-8161-616161616161",
        activityPresentationId: "62626262-6262-4262-8262-626262626262",
        prompt: "missing project",
        activity: { mode: "new" },
        agent: { mode: "new", name: "Missing Project" },
        executionMode: "foreground"
      }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("PROJECT_REQUIRED");

    const alpha = await runTask(client, {
      prompt: "work in alpha",
      project: alphaSelector,
      agentName: "Alpha Agent",
      contextMode: "fresh"
    });
    const alphaStructured = parseToolJson(alpha);
    const alphaActivityId = alphaStructured.activityId as string;
    const alphaAgentId = alphaStructured.agentId as string;
    expect(alphaStructured.projectName).toBe("알파 저장소");
    expect(jobs.getActivity(alphaActivityId)).toMatchObject({
      projectId: alphaProject.id,
      projectLabel: "알파 저장소"
    });
    expect(sessions.get("thread-1")).toMatchObject({
      projectId: alphaProject.id,
      projectLabel: "알파 저장소",
      cwd: firstCwd
    });

    const inherited = await runTask(client, {
      prompt: "add another alpha Agent",
      project: alphaSelector,
      activityId: alphaActivityId,
      agentName: "Second Alpha Agent",
      contextMode: "fresh"
    });
    expect(parseToolJson(inherited).projectName).toBe("알파 저장소");
    expect(upstream.calls[1]?.args.cwd).toBe(firstCwd);

    const conflict = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must not switch repositories",
        activityId: alphaActivityId,
        agentId: alphaAgentId,
        contextMode: "continue",
        project: betaSelector
      }
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("PROJECT_CONTEXT_CONFLICT");

    const linkedBeta = await runTask(client, {
      prompt: "continue the goal with fresh beta context",
      project: betaSelector,
      continuationOfActivityId: alphaActivityId,
      agentName: "Linked Beta Agent",
      contextMode: "fresh"
    });
    expect(parseToolJson(linkedBeta).projectName).toBe("Beta Workspace");
    expect(upstream.calls[2]?.args.cwd).toBe(secondCwd);
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).not.toHaveProperty("projects");
    const settingsView = parseToolJson(
      await client.callTool({ name: "codex_settings", arguments: {} })
    );
    expect(settingsView.projects).toEqual([
      { name: "알파 저장소", available: true, archived: false },
      { name: "Beta Workspace", available: true, archived: false }
    ]);
    expect(JSON.stringify(status)).not.toContain(firstCwd);
    expect(JSON.stringify(status)).not.toContain(secondCwd);
    const activityCard = await client.callTool({ name: "codex_activity", arguments: {} });
    expect(new Set(
      (privateActivityView(activityCard).feed.active || [])
        .flatMap((row: { workspaceLabels: string[] }) => row.workspaceLabels)
    )).toEqual(new Set(["알파 저장소", "Beta Workspace"]));
    expect(JSON.stringify(activityCard)).not.toContain(firstCwd);
    expect(JSON.stringify(activityCard)).not.toContain(secondCwd);

    settings.update({
      projects: [{ id: "beta", label: "Beta Workspace", cwd: second }]
    }, settings.current.revision);
    const continued = await runTask(client, {
      prompt: "continue the admitted alpha thread",
      activityId: alphaActivityId,
      agentId: alphaAgentId,
      contextMode: "continue"
    });
    expect(parseToolJson(continued).projectName).toBe("알파 저장소");
    expect(upstream.calls[3]).toMatchObject({
      name: "codex-reply",
      args: { threadId: "thread-1" }
    });
    const removedFresh = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "fresh context cannot reuse a removed project",
        activityId: alphaActivityId,
        agentId: alphaAgentId,
        contextMode: "fresh",
        project: alphaSelector
      }
    });
    expect(removedFresh.isError).toBe(true);
    expect(JSON.stringify(removedFresh)).toContain("PROJECT_REGISTRY_CHANGED");
    expect(JSON.stringify(removedFresh)).toContain("projectLookup");
    expect(JSON.stringify(removedFresh)).not.toContain("Refresh the tool descriptor");
    expect(upstream.calls).toHaveLength(4);
    const removed = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "new work cannot use a removed project",
        project: alphaSelector,
        agentName: "Removed Project Agent",
        contextMode: "fresh"
      }
    });
    expect(removed.isError).toBe(true);
    expect(JSON.stringify(removed)).toContain("PROJECT_REGISTRY_CHANGED");
    await close();
  });

  it.each(["continue", "fork"] as const)(
    "redacts an unavailable pinned project path during %s and recovers after restoration",
    async (contextMode) => {
      const root = temporaryRoot();
      const movedRoot = `${root}-moved`;
      const upstream = new ForkLifecycleUpstream();
      const { client, jobs, close } = await connectTestClient(
        configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
        upstream
      );
      const started = await runTask(client, {
        prompt: "seed pinned project",
        agentName: `Unavailable ${contextMode} Agent`,
        contextMode: "fresh"
      });
      const agentId = parseToolJson(started).agentId as string;

      renameSync(root, movedRoot);
      try {
        const result = await client.callTool({
          name: "codex_task",
          arguments: { prompt: "reuse unavailable project", agentId, contextMode }
        });
        const serialized = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(serialized).toContain("PROJECT_UNAVAILABLE");
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain(movedRoot);
        expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle" });
        expect(upstream.calls).toHaveLength(1);
      } finally {
        if (existsSync(movedRoot)) renameSync(movedRoot, root);
      }

      try {
        const recovered = await runTask(client, {
          prompt: "reuse restored project",
          agentId,
          contextMode
        });
        expect((recovered as { isError?: boolean }).isError).not.toBe(true);
        expect(upstream.calls.map((call) => call.name)).toEqual([
          "codex",
          contextMode === "continue" ? "codex-reply" : "codex-fork"
        ]);
      } finally {
        await close();
      }
    }
  );

  it("keeps an explicit project stable across idempotent retries", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const settings = new UserSettingsStore(config);
    settings.update({
      projects: [
        { id: "alpha", label: "Alpha", cwd: first },
        { id: "beta", label: "Beta", cwd: second }
      ]
    }, settings.current.revision);
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const alphaProject = settings.current.projects.find((project) => project.name === "Alpha")!;
    const requestId = "31313131-3131-4131-8131-313131313131";
    const args = {
      scopeId: SCOPE_A,
      requestId,
      activityPresentationId: "32323232-3232-4232-8232-323232323232",
      prompt: "idempotent project turn",
      project: { name: "Alpha", registryRevision: 1 },
      activity: { mode: "new" as const },
      agent: { mode: "new" as const, name: "Retry Agent" },
      executionMode: "foreground"
    };

    const firstResult = await rawCallTool({ name: "codex_task", arguments: args });
    settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: alphaProject.id, name: "Alpha Renamed" }],
      undefined,
      1
    );
    const replay = await rawCallTool({ name: "codex_task", arguments: args });
    expect(parseToolJson(replay)).toMatchObject({
      threadId: parseToolJson(firstResult).threadId,
      activityId: parseToolJson(firstResult).activityId,
      jobId: parseToolJson(firstResult).jobId,
      projectName: "Alpha",
      replay: true
    });
    expect(JSON.stringify(replay)).not.toContain(alphaProject.id);
    expect(JSON.stringify(replay)).not.toContain(realpathSync(first));
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(first));
    expect(jobs.listForScope(SCOPE_A)[0]).toMatchObject({
      projectId: alphaProject.id,
      projectLabel: "Alpha",
      requestHashVersion: 6
    });

    const changed = await rawCallTool({
      name: "codex_task",
      arguments: { ...args, project: { name: "Beta", registryRevision: 2 } }
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("requestId was already used for a different Codex task");
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("replays an exact persisted v5 legacy project request after the v6 selector migration", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const upstream = new FakeUpstream();
    const stateStore = new BridgeStateStore({ file: ":memory:" });
    const settings = new UserSettingsStore(config, { stateStore });
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Legacy Project", cwd: root } }],
      undefined,
      0
    );
    const project = settings.current.projects[0]!;
    const firstJobs = new CodexJobRegistry({
      allowedRoots: config.allowedRoots,
      stateStore
    });
    const firstConnection = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings,
      firstJobs,
      false
    );
    const requestId = "33333333-3333-4333-8333-333333333333";
    const args = {
      scopeId: SCOPE_A,
      requestId,
      prompt: "replay the pre-migration request",
      project: { name: "Legacy Project", registryRevision: 1 },
      activity: { mode: "new" as const, title: "Legacy v5 Activity" },
      agent: { mode: "new" as const, name: "Legacy v5 Agent" },
      executionMode: "foreground" as const
    };

    const admitted = await firstConnection.rawCallTool({
      name: "codex_task",
      arguments: args
    });
    const admittedTask = parseToolJson(admitted);
    const admittedJob = firstJobs.get(admittedTask.jobId)!;
    expect(admittedJob).toMatchObject({
      projectId: project.id,
      projectRequest: args.project,
      requestHashVersion: 6,
      status: "completed"
    });
    await firstConnection.close();

    const legacyRequestHash = legacyV5TaskRequestHashFixture({
      scopeId: SCOPE_A,
      prompt: args.prompt,
      projectName: args.project.name,
      registryRevision: args.project.registryRevision,
      projectId: project.id,
      cwd: admittedJob.cwd,
      sandbox: admittedJob.sandbox,
      backendKind: admittedJob.executionDecision!.backendKind,
      executionMode: args.executionMode,
      selection: admittedJob.executionDecision!.effectiveSelection,
      activityTitle: args.activity.title,
      agentName: args.agent.name
    });
    const { promise: _promise, ...persistedJob } = admittedJob;
    stateStore.replaceJobs([{
      ...persistedJob,
      requestHash: legacyRequestHash,
      requestHashVersion: 5
    }]);
    settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: project.id, name: "Migrated Project" }],
      undefined,
      settings.current.registryRevision
    );

    const migratedSettings = new UserSettingsStore(config, { stateStore });
    const migratedPersistedJobs = stateStore.listJobs();
    expect(migratedPersistedJobs).toHaveLength(1);
    const migratedJobs = new CodexJobRegistry({
      allowedRoots: config.allowedRoots,
      stateStore
    });
    expect(migratedJobs.listForScope(SCOPE_A)[0]).toMatchObject({
      requestId,
      requestHash: legacyRequestHash,
      requestHashVersion: 5,
      projectRequest: args.project
    });
    const migratedConnection = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      migratedSettings,
      migratedJobs,
      false
    );
    const migratedTaskDescriptor = (await migratedConnection.client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    )!;
    expect(JSON.stringify(migratedTaskDescriptor.inputSchema)).toContain("projectRef");

    const replay = await migratedConnection.bareCallTool({
      name: "codex_task",
      arguments: args
    });
    expect((replay as { isError?: boolean }).isError).not.toBe(true);
    expect(parseToolJson(replay)).toMatchObject({
      jobId: admittedTask.jobId,
      activityId: admittedTask.activityId,
      agentId: admittedTask.agentId,
      threadId: admittedTask.threadId,
      projectName: "Legacy Project",
      replay: true
    });
    expect(migratedJobs.listForScope(SCOPE_A)).toHaveLength(1);
    expect(migratedJobs.activityCount(SCOPE_A)).toBe(1);
    expect(migratedJobs.agentCount(SCOPE_A, true)).toBe(1);
    expect(upstream.calls).toHaveLength(1);

    await migratedConnection.close();
    stateStore.close();
  });

  it("keeps an existing Agent thread pinned after the registered projects change", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const relocated = temporaryRoot();
    const upstream = new FakeUpstream();
    const sessions = new SessionRegistry();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second},${relocated}`
    });
    const settings = new UserSettingsStore(config);
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      sessions,
      new FakeModelCatalog(),
      settings,
      undefined,
      false
    );

    settings.update({
      projects: [
        { id: "first", label: "First", cwd: first },
        { id: "second", label: "Second", cwd: second }
      ]
    }, settings.current.revision);
    const started = await runTask(client, {
      prompt: "start in the first folder",
      projectId: "first",
      agentName: "Pinned Cwd Agent",
      contextMode: "fresh"
    });
    const startedStructured = parseToolJson(started);
    const activityId = startedStructured.activityId as string;
    const agentId = startedStructured.agentId as string;
    const firstProject = settings.current.projects.find((project) => project.name === "First")!;
    settings.updateWithProjectOperations(
      {},
      [{ kind: "relocate", projectId: firstProject.id, cwd: relocated }],
      undefined,
      settings.current.registryRevision
    );
    await runTask(client, {
      prompt: "continue after the project registry changes",
      activityId,
      agentId,
      contextMode: "continue"
    });

    const linked = await runTask(client, {
      prompt: "continue in a new Activity without moving the pinned thread",
      project: { name: "First", registryRevision: settings.current.registryRevision },
      activityTitle: "Pinned follow-up Activity",
      agentId,
      contextMode: "continue"
    });
    const linkedActivityId = parseToolJson(linked).activityId as string;

    expect(sessions.get("thread-1")?.cwd).toBe(realpathSync(first));
    expect(jobs.listForAgent(agentId).map((job) => job.cwd)).toEqual([
      realpathSync(first),
      realpathSync(first),
      realpathSync(first)
    ]);
    expect(jobs.getActivityProjectAdmission(linkedActivityId)).toMatchObject({
      projectId: firstProject.id,
      projectLabel: "First",
      projectCwd: realpathSync(first)
    });
    expect(settings.current.projects.find((project) => project.id === firstProject.id))
      .toMatchObject({ name: "First", cwd: realpathSync(relocated) });
    await runTask(client, {
      prompt: "start fresh at the relocated current folder",
      projectId: "first",
      agentId,
      contextMode: "fresh"
    });
    expect(jobs.listForAgent(agentId).map((job) => job.cwd)).toEqual([
      realpathSync(first),
      realpathSync(first),
      realpathSync(first),
      realpathSync(relocated)
    ]);
    expect(upstream.calls.map((call) => call.name)).toEqual([
      "codex",
      "codex-reply",
      "codex-reply",
      "codex"
    ]);
    await close();
  });

  it("keeps automatic Activity cards compact and preserves terminal Activity history across Agent reuse", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const started = await runTask(client, {
      prompt: "render a summary",
      agentName: "Summary Agent",
      activityTitle: "Render summary",
      contextMode: "fresh"
    });
    const startedTask = parseToolJson(started);
    const activityId = startedTask.activityId as string;

    const summaryResult = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    const summary = privateActivityView(summaryResult);
    expect(summary).toMatchObject({
      feed: {
        mode: "full",
        activeCount: 1,
        active: [expect.objectContaining({
          activityId,
          title: "Render summary",
          displayState: "waiting-gpt",
          agents: [expect.objectContaining({ agentName: "Summary Agent" })]
        })],
        historySummary: { completedActivities: 0, endedActivities: 0 },
        history: { rows: [] },
        completed: { agentCount: 0, activityCount: 0 }
      }
    });
    expect(summary).not.toHaveProperty("viewMode");

    await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: jobs.getActivity(activityId)?.version,
        operation: { kind: "complete" }
      }
    });
    const agentsResult = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    const agents = privateActivityView(agentsResult);
    expect(agents).not.toHaveProperty("viewMode");
    expect(agents.feed).toMatchObject({
      mode: "full",
      activeCount: 0,
      historySummary: { completedActivities: 1, endedActivities: 0 },
      history: {
        rows: [expect.objectContaining({ activityId, displayState: "completed" })]
      },
      completed: {
        agentCount: 1,
        activityCount: 1,
        rows: [expect.objectContaining({
          agentName: "Summary Agent",
          latestActivityId: activityId,
          latestActivityTitle: "Render summary",
          activityCount: 1
        })]
      },
      idleAgents: {
        rows: [expect.objectContaining({
          agentName: "Summary Agent",
          latestActivityId: activityId,
          latestActivityTitle: "Render summary"
        })]
      }
    });

    const completedAutomaticResult = await presentCompactActivity(
      client,
      activityId,
      "30303030-3030-4030-8030-303030303030"
    );
    expect(privateActivityView(completedAutomaticResult).feed).toMatchObject({
        mode: "compact",
        active: [],
        historySummary: { completedActivities: 1, endedActivities: 0, idleAgents: 1 },
        history: { rows: [] },
        idleAgents: { rows: [] }
      });

    const agentId = startedTask.agentId as string;
    const resumed = await runTask(client, {
      prompt: "start the next scoped activity",
      agentId,
      contextMode: "continue",
      activityTitle: "Next activity"
    });
    const resumedActivityId = parseToolJson(resumed).activityId as string;
    const resumedResult = await client.callTool({ name: "codex_activity", arguments: {} });
    const resumedFeed = privateActivityView(resumedResult).feed;
    expect(resumedFeed).toMatchObject({
      mode: "full",
      activeCount: 1,
      active: [expect.objectContaining({
        activityId: resumedActivityId,
        agents: [expect.objectContaining({ agentName: "Summary Agent" })]
      })],
      historySummary: { completedActivities: 1, endedActivities: 0 },
      history: {
        rows: [expect.objectContaining({ activityId, displayState: "completed" })]
      },
      completed: { agentCount: 0, activityCount: 1, rows: [] }
    });

    const ended = jobs.createActivity({ scopeId: SCOPE_A, title: "Ended history" });
    jobs.cancelActivity(ended.activityId, "No longer needed");
    jobs.createAgent({ scopeId: SCOPE_A, agentName: "Unused idle Agent" });
    const automatic = await presentCompactActivity(
      client,
      resumedActivityId,
      "31313131-3131-4131-8131-313131313131"
    );
    const automaticCard = automaticCardProof(automatic);
    const compact = privateActivityView(automatic);
    expect(compact.feed).toMatchObject({
      mode: "compact",
      activeCount: 1,
      active: [expect.objectContaining({ activityId: resumedActivityId })],
      historySummary: { completedActivities: 1, endedActivities: 1, idleAgents: 1 },
      history: { rows: [] },
      idleAgents: { rows: [] },
      completed: { rows: [] },
      idle: { rows: [] },
      ended: { rows: [] }
    });
    expect(compact.agents).toEqual([]);
    expect(compact.archivedAgents).toEqual([]);
    expect(compact.activities).toEqual([]);
    expect(compact.unassignedJobs).toEqual([]);

    const endedWithAgent = jobs.createActivity({
      scopeId: SCOPE_A,
      title: "Ended history with idle Agent"
    });
    const endedIdleAgent = jobs.createAgent({
      scopeId: SCOPE_A,
      agentName: "Ended idle Agent"
    });
    jobs.assignAgent({
      activityId: endedWithAgent.activityId,
      agentId: endedIdleAgent.agentId,
      contextMode: "fresh"
    });
    jobs.releaseAgentAssignment(endedWithAgent.activityId, endedIdleAgent.agentId);
    jobs.cancelActivity(endedWithAgent.activityId, "Terminal idle Agent regression");
    const endedAutomatic = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: automaticCard
      },
      _meta: { "openai/widgetSessionId": "compact-history-summary" }
    });
    expect((endedAutomatic as { structuredContent?: Record<string, any> })
      .structuredContent?.feed.historySummary).toEqual({
        completedActivities: 1,
        endedActivities: 2,
        idleAgents: 2
      });
    await close();
  });

  it("paginates the explicit full Activity history within scope and keeps an exact selected Activity visible", async () => {
    const root = temporaryRoot();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream()
    );
    const scopedActivities = Array.from({ length: 35 }, (_, index) => jobs.createActivity({
      scopeId: SCOPE_A,
      title: `Scoped history ${index + 1}`
    }));
    const scopedAgents = Array.from({ length: 35 }, (_, index) => jobs.createAgent({
      scopeId: SCOPE_A,
      agentName: `Scoped idle Agent ${index + 1}`
    }));
    jobs.createActivity({ scopeId: SCOPE_B, title: "Other conversation history" });
    jobs.createAgent({ scopeId: SCOPE_B, agentName: "Other conversation Agent" });
    const oldest = scopedActivities[0]!;

    const opened = await client.callTool({
      name: "codex_activity",
      arguments: { activityId: oldest.activityId }
    });
    expect((opened as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      kind: "activity",
      activityId: oldest.activityId,
      activityVersion: oldest.version,
      counts: { activities: 35, agents: 35 }
    });
    const selectedPage = privateActivityView(opened);
    expect(selectedPage.feed).toMatchObject({
      mode: "full",
      activityTotal: 35,
      history: {
        pagination: {
          offset: 30,
          returned: 5,
          total: 35,
          hasPrevious: true,
          hasMore: false
        }
      },
      idleAgents: {
        agentCount: 35,
        pagination: { offset: 30, returned: 5, total: 35 }
      }
    });
    expect(selectedPage.feed.history.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ activityId: oldest.activityId })])
    );
    expect(JSON.stringify(selectedPage)).not.toContain("Other conversation history");
    expect(JSON.stringify(selectedPage)).not.toContain("Other conversation Agent");

    const card = {
      activityId: selectedPage.mountedActivity.activityId,
      generation: selectedPage.mountedActivity.cardGeneration,
      presentation: { kind: "explicit" as const }
    };
    const firstPageResult = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card,
        limit: 30,
        cursor: selectedPage.feed.history.pagination.previousCursor
      },
      _meta: { "openai/widgetSessionId": "explicit-history-pagination" }
    });
    const firstPage = (firstPageResult as { structuredContent?: Record<string, any> })
      .structuredContent!;
    expect(firstPage.feed.history.pagination).toMatchObject({
      offset: 0,
      returned: 30,
      total: 35,
      hasPrevious: false,
      hasMore: true
    });
    expect(firstPage.feed.history.rows).toHaveLength(30);
    expect(firstPage.feed.idleAgents).toMatchObject({
      agentCount: 35,
      pagination: { offset: 0, returned: 30, total: 35, hasMore: true }
    });
    expect(firstPage.feed.idleAgents.rows).toHaveLength(30);

    const nextPageResult = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card,
        limit: 30,
        cursor: firstPage.feed.history.pagination.nextCursor
      },
      _meta: { "openai/widgetSessionId": "explicit-history-pagination" }
    });
    const nextPage = (nextPageResult as { structuredContent?: Record<string, any> })
      .structuredContent!;
    expect(nextPage.feed.history.pagination).toMatchObject({
      offset: 30,
      returned: 5,
      total: 35,
      hasPrevious: true,
      hasMore: false
    });
    expect(nextPage.feed.idleAgents).toMatchObject({
      agentCount: 35,
      pagination: { offset: 30, returned: 5, total: 35, hasMore: false }
    });
    expect(nextPage.feed.idleAgents.rows).toHaveLength(5);

    jobs.createActivity({ scopeId: SCOPE_A, title: "New ordering boundary" });
    const resetResult = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card,
        limit: 30,
        cursor: nextPage.feed.history.pagination.currentCursor
      },
      _meta: { "openai/widgetSessionId": "explicit-history-pagination" }
    });
    const resetPage = (resetResult as { structuredContent?: Record<string, any> })
      .structuredContent!;
    expect(resetPage.feed.history.pagination).toMatchObject({
      offset: 0,
      returned: 30,
      total: 36,
      reset: true
    });
    expect(resetPage.feed.history.pagination.currentCursor)
      .not.toBe(nextPage.feed.history.pagination.currentCursor);
    expect(scopedAgents).toHaveLength(35);
    await close();
  });

  it("opens an unselected explicit Activity view at the priority-first page", async () => {
    const root = temporaryRoot();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      new FakeUpstream()
    );
    for (let index = 0; index < 30; index += 1) {
      const activity = jobs.createActivity({
        scopeId: SCOPE_A,
        title: `Waiting Activity ${index + 1}`
      });
      const agent = jobs.createAgent({
        scopeId: SCOPE_A,
        agentName: `Waiting Agent ${index + 1}`
      });
      jobs.assignAgent({
        activityId: activity.activityId,
        agentId: agent.agentId,
        contextMode: "fresh"
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newestIdle = jobs.createActivity({
      scopeId: SCOPE_A,
      title: "Newest idle history"
    });

    const opened = privateActivityView(await client.callTool({
      name: "codex_activity",
      arguments: {}
    }));
    expect(opened.mountedActivity.activityId).toBe(newestIdle.activityId);
    expect(opened.feed.history.pagination).toMatchObject({
      offset: 0,
      returned: 30,
      hasPrevious: false,
      hasMore: true
    });
    expect(opened.feed.active).toHaveLength(30);
    expect(opened.feed.active.every((row: Record<string, unknown>) =>
      row.displayState === "waiting-gpt"
    )).toBe(true);

    const refreshedResult = await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: {
          activityId: opened.mountedActivity.activityId,
          generation: opened.mountedActivity.cardGeneration,
          presentation: { kind: "explicit" }
        },
        limit: 30,
        cursor: opened.feed.history.pagination.currentCursor
      },
      _meta: { "openai/widgetSessionId": "priority-first-explicit-view" }
    });
    const refreshed = (refreshedResult as { structuredContent?: Record<string, any> })
      .structuredContent!;
    expect(refreshed.feed.history.pagination).toMatchObject({
      offset: 0,
      returned: 30,
      hasPrevious: false,
      hasMore: true
    });
    expect(refreshed.feed.active).toHaveLength(30);
    await close();
  });

  it("orders Activity rows by user block, recovery, result review, and running state", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    const failed = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "fail for ordering",
        agentName: "Failed ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    upstream.rejectNext(new Error("ordering failure"));
    await waitForJobStatus(client, failed.jobId, "failed");

    const verification = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "verify for ordering",
        agentName: "Verification ordering Agent",
        contextMode: "fresh",
        executionMode: "background",
        handoffPolicy: "verify",
        completionTrigger: "sealed-jobs-terminal"
      }
    }));
    upstream.resolveNext(fakeCodexResult("verification-ordering-thread"));
    await waitForJobStatus(client, verification.jobId, "completed");
    jobs.sealActivity(verification.activityId);

    const waiting = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "wait for GPT ordering",
        agentName: "Waiting ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    upstream.resolveNext(fakeCodexResult("waiting-ordering-thread"));
    await waitForJobStatus(client, waiting.jobId, "completed");

    const approval = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "request approval for ordering",
        agentName: "Approval ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const approvalInteraction = {
      interactionId: "ordering-approval",
      kind: "command-approval" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "ordering-item",
      summary: "Approval blocks the user",
      availableDecisions: ["accept", "decline"] as CodexInteractionDecision[]
    };
    upstream.progressNext({
      progress: 1,
      message: approvalInteraction.summary,
      event: {
        eventId: "ordering-approval-event",
        type: "approval-required",
        phase: "waiting",
        createdAt: Date.now(),
        summary: approvalInteraction.summary,
        details: { interaction: approvalInteraction }
      }
    });

    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "keep running for ordering",
        agentName: "Running ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newerRunning = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "keep a newer row running for stable ordering",
        agentName: "Newer running ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const terminating = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "show terminating within the progress group",
        agentName: "Terminating ordering Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const terminatingJob = jobs.get(terminating.jobId);
    if (!terminatingJob) throw new Error("Expected terminating ordering Job.");
    terminatingJob.status = "terminating";

    const card = privateActivityView(await client.callTool({ name: "codex_activity", arguments: {} }));
    expect(card.feed.active.map((row: { activityId: string; displayState: string }) => ({
      activityId: row.activityId,
      displayState: row.displayState
    }))).toEqual([
      { activityId: approval.activityId, displayState: "approval-required" },
      { activityId: failed.activityId, displayState: "failed" },
      { activityId: waiting.activityId, displayState: "waiting-gpt" },
      { activityId: verification.activityId, displayState: "verification" },
      { activityId: terminating.activityId, displayState: "terminating" },
      { activityId: newerRunning.activityId, displayState: "running" },
      { activityId: running.activityId, displayState: "running" }
    ]);

    terminatingJob.status = "running";
    upstream.resolveNext(fakeCodexResult("approval-ordering-thread"));
    upstream.resolveNext(fakeCodexResult("running-ordering-thread"));
    upstream.resolveNext(fakeCodexResult("newer-running-ordering-thread"));
    upstream.resolveNext(fakeCodexResult("terminating-ordering-thread"));
    await Promise.all([
      waitForJobStatus(client, approval.jobId, "completed"),
      waitForJobStatus(client, running.jobId, "completed"),
      waitForJobStatus(client, newerRunning.jobId, "completed"),
      waitForJobStatus(client, terminating.jobId, "completed")
    ]);
    await close();
  });

  it("shows current retry progress separately from previous Activity failures", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const failed = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "record one failed attempt",
        activity: { mode: "new", title: "Retry with failure history" },
        agent: { mode: "new", name: "Retry history Agent" },
        executionMode: "background"
      }
    }));
    upstream.rejectNext(new Error("first attempt failed"));
    await waitForJobStatus(client, failed.jobId, "failed");

    const retry = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "keep the retry running",
        activity: { mode: "existing", id: failed.activityId },
        agent: { mode: "existing", id: failed.agentId, context: "fresh" },
        executionMode: "background"
      }
    }));
    const card = privateActivityView(await client.callTool({
      name: "codex_activity",
      arguments: { activityId: failed.activityId }
    }));
    const row = card.feed.active.find(
      (entry: { activityId: string }) => entry.activityId === failed.activityId
    );
    expect(row).toMatchObject({
      activityId: failed.activityId,
      displayState: "running",
      canRetry: false,
      counts: {
        total: 2,
        running: 1,
        completed: 0,
        failed: 1,
        interrupted: 0,
        cancelled: 0,
        terminal: 1
      }
    });

    upstream.resolveNext(fakeCodexResult("retry-history-thread"));
    await waitForJobStatus(client, retry.jobId, "completed");
    await close();
  });

  it("uses Activity identity as the stable tiebreaker within one state group", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const [first, second] = await (async () => {
      const frozenNow = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
      try {
        const firstResult = parseToolJson(await client.callTool({
          name: "codex_task",
          arguments: {
            prompt: "first stable tie",
            agentName: "Stable tie Agent One",
            contextMode: "fresh",
            executionMode: "background"
          }
        }));
        const secondResult = parseToolJson(await client.callTool({
          name: "codex_task",
          arguments: {
            prompt: "second stable tie",
            agentName: "Stable tie Agent Two",
            contextMode: "fresh",
            executionMode: "background"
          }
        }));
        return [firstResult, secondResult] as const;
      } finally {
        now.mockRestore();
      }
    })();

    const card = privateActivityView(await client.callTool({
      name: "codex_activity",
      arguments: {}
    }));
    const tiedIds = card.feed.active
      .map((row: { activityId: string }) => row.activityId)
      .filter((activityId: string) => [first.activityId, second.activityId].includes(activityId));
    expect(tiedIds).toEqual([first.activityId, second.activityId].sort());

    upstream.resolveNext(fakeCodexResult("stable-tie-thread-one"));
    upstream.resolveNext(fakeCodexResult("stable-tie-thread-two"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("sessionMode=new always starts fresh even when a compatible session exists", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await runTask(client, { prompt: "first", sessionMode: "new" });
    await runTask(client, { prompt: "fresh", sessionMode: "new" });
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex"]);

    await close();
  });

  it("continues an exact tracked thread and rejects unknown or conflicting continuation inputs", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const first = await runTask(client, {
      prompt: "first",
      agent: { mode: "new", name: "Tracked Agent" }
    });
    const agentId = parseToolJson(first).agentId as string;

    await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        modelPolicy: {
          mode: "automatic",
          fallbackSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          allowedSelections: { kind: "catalog-visible" },
          constraints: { allowDelegation: true }
        }
      }
    });

    const continued = await runTask(client, {
      prompt: "continue",
      agent: { mode: "existing", id: agentId, context: "continue" }
    });
    expect(parseToolJson(continued)).toMatchObject({
      actualModel: "gpt-5.6-sol",
      actualReasoningEffort: "max"
    });
    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "continue", _bridgeBackendKind: "mcp-server" }
    });

    const unknown = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "continue",
        agent: {
          mode: "existing",
          id: "99999999-9999-4999-8999-999999999999",
          context: "continue"
        }
      }
    });
    expect(unknown.isError).toBe(true);

    const modelChange = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "switch",
        agent: { mode: "existing", id: agentId, context: "continue" },
        selection: { model: "gpt-5.6-terra", reasoningEffort: "medium" }
      }
    });
    expect(modelChange.isError).toBe(true);
    expect(JSON.stringify(modelChange)).toContain("THREAD_OVERRIDE_UNSUPPORTED");

    await close();
  });

  it("reuses the pinned write sandbox and rejects a conflicting adaptive override", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      upstream
    );
    const started = await runTask(client, {
      prompt: "write",
      agentName: "Writer",
      contextMode: "fresh",
      sandbox: "workspace-write"
    });
    const agentId = parseToolJson(started).agentId;

    await runTask(client, {
      prompt: "more",
      agentId,
      contextMode: "continue"
    });
    expect(upstream.calls[1]?.name).toBe("codex-reply");

    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "conflicting read", agentId, contextMode: "continue", sandbox: "read-only" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("requires sandbox='workspace-write'");

    await close();
  });

  it("reuses the pinned full-access sandbox and rejects a conflicting adaptive override", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" }),
      upstream
    );
    const started = await runTask(client, {
      prompt: "full task",
      agentName: "Full Agent",
      contextMode: "fresh",
      sandbox: "danger-full-access"
    });
    const agentId = parseToolJson(started).agentId;

    await runTask(client, {
      prompt: "more",
      agentId,
      contextMode: "continue"
    });
    expect(upstream.calls[1]?.name).toBe("codex-reply");

    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "conflicting read", agentId, contextMode: "continue", sandbox: "read-only" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("requires sandbox='danger-full-access'");

    await close();
  });

  it("returns session summaries from codex_status", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    await runTask(client, { prompt: "first", sessionMode: "new" });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.counts.sessions).toBe(1);
    expect(status.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "job", threadId: "thread-1" })
    ]));
    expect(JSON.stringify(status)).not.toContain(realpathSync(root));

    await close();
  });

  it("returns a background task immediately and retrieves completion through codex_status", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const started = parseToolJson(
      await Promise.race([
        client.callTool({
        name: "codex_task",
        arguments: { prompt: "slow", sessionMode: "new" }
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Background codex_task did not return immediately.")), 500)
        )
      ])
    );
    expect(started).toMatchObject({
      status: "running",
      executionMode: "background"
    });
    expect(started.activityId).toMatch(SCOPE_ID_PATTERN);
    expect(started).not.toHaveProperty("nextAction");
    upstream.resolveNext();

    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed).toMatchObject({
      threadId: "thread-1",
      result: { availability: "delivered", omitted: false }
    });
    await close();
  });

  it("long-polls one existing status call until the job becomes terminal", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );

    const waiting = client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: started.jobId, waitFor: "terminal", waitMs: 1000 }
      }
    });
    setTimeout(() => upstream.resolveNext(), 10);
    const completed = parseToolJson(await waiting);

    expect(completed).toMatchObject({
      status: "completed",
      terminal: true,
      wait: { waitFor: "terminal", timedOut: false, changed: true }
    });
    await close();
  });

  it("long-polls until an upstream progress notification changes the job", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );

    const waiting = client.callTool({
      name: "codex_status",
      arguments: { jobId: started.jobId, waitFor: "change", waitMs: 1000 }
    });
    setTimeout(
      () => upstream.progressNext({ progress: 3, total: 10, message: "editing files" }),
      10
    );
    const changed = parseToolJson(await waiting);

    expect(changed).toMatchObject({
      status: "running",
      terminal: false,
      versions: { job: 3 },
      wait: { waitFor: "change", timedOut: false, changed: true }
    });
    upstream.resolveNext();
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("returns a bounded timeout without changing a still-running job", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS: "1"
      }),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { jobId: started.jobId, waitFor: "terminal", waitMs: 10 }
      })
    );

    expect(status).toMatchObject({
      status: "running",
      wait: { waitFor: "terminal", timedOut: true, changed: false }
    });
    expect(status.warnings).toEqual([
      expect.stringContaining("No progress event has been observed")
    ]);
    upstream.resolveNext();
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("cancels only a job owned by the supplied scope and forwards an abort signal", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "cancel me", sessionMode: "new" } })
    );
    await Promise.resolve();
    const currentVersion = jobs.get(started.jobId)?.version as number;

    const missingReason = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "70707070-7070-4070-8070-707070707070",
        jobId: started.jobId,
        expectedVersion: currentVersion
      }
    });
    expect(missingReason.isError).toBe(true);
    expect(JSON.stringify(missingReason)).toContain("reason");
    expect(upstream.aborts).toBe(0);

    const denied = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "71717171-7171-4171-8171-717171717171",
        jobId: started.jobId,
        expectedVersion: currentVersion,
        reason: "The user stopped this job"
      }
    });
    expect(denied.isError).toBe(true);
    expect(upstream.aborts).toBe(0);

    const cancellationArguments = {
      scopeId: SCOPE_A,
      requestId: "72727272-7272-4272-8272-727272727272",
      jobId: started.jobId,
      expectedVersion: currentVersion,
      reason: "The user stopped this job"
    };
    const [cancelledResult, concurrentReplayResult] = await Promise.all([
      client.callTool({ name: "codex_cancel", arguments: cancellationArguments }),
      client.callTool({ name: "codex_cancel", arguments: cancellationArguments })
    ]);
    const cancelled = parseToolJson(cancelledResult);
    expect(parseToolJson(concurrentReplayResult)).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      kind: "mutation",
      action: "cancel-job",
      target: { type: "job", id: started.jobId, state: "cancelled" }
    });
    expect(jobs.get(started.jobId)).toMatchObject({
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      error: expect.stringContaining("Partial filesystem changes may remain")
    });
    expect(upstream.aborts).toBe(1);

    const durableReplay = parseToolJson(
      await client.callTool({
        name: "codex_cancel",
        arguments: cancellationArguments
      })
    );
    expect(durableReplay).toEqual(cancelled);
    expect(upstream.aborts).toBe(1);
    expect(jobs.listCancellationIntents({ requestId: cancellationArguments.requestId }))
      .toHaveLength(1);
    expect(jobs.getCancellationOperation(SCOPE_A, cancellationArguments.requestId))
      .toMatchObject({
        status: "completed",
        source: "model-tool",
        reason: cancellationArguments.reason,
        result: { status: "cancelled", jobId: started.jobId }
      });
    const activityCardResult = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        mode: "full-history",
        activityId: started.activityId
      }
    });
    const activityCardView = validateActivityViewPrivateMetadata(
      (activityCardResult as { _meta?: Record<string, unknown> })
        ._meta?.[ACTIVITY_VIEW_METADATA_KEY]
    ).view;
    const activityFeed = activityCardView.feed as {
      active: Array<Record<string, unknown>>;
      history: { rows: Array<Record<string, unknown>> };
    };
    expect([...activityFeed.active, ...activityFeed.history.rows]).toEqual(
      expect.arrayContaining([expect.objectContaining({
        activityId: started.activityId,
        cancellations: [{
          targetKind: "job",
          agentName: expect.any(String),
          status: "succeeded",
          reason: cancellationArguments.reason,
          requestedAt: expect.any(String)
        }]
      })])
    );
    const { view: dashboardView } = await freshDashboardSnapshot(rawCallTool, {
      scopeId: SCOPE_A
    });
    expect(dashboardView.terminalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        latestTurn: expect.objectContaining({
          cancellation: expect.objectContaining({
            targetKind: "job",
            status: "succeeded",
            reason: cancellationArguments.reason
          })
        })
      })
    ]));
    const conflictingReplay = await client.callTool({
      name: "codex_cancel",
      arguments: { ...cancellationArguments, expectedVersion: currentVersion + 1 }
    });
    expect(conflictingReplay.isError).toBe(true);
    expect(JSON.stringify(conflictingReplay)).toContain("CANCELLATION_REQUEST_CONFLICT");
    expect(upstream.aborts).toBe(1);
    await close();
  });

  it("requires stale-version and shared-worker confirmation before atomic force-stop reconcile", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
        CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
      }),
      upstream
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "target", sessionMode: "new", executionMode: "background" }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "collateral", sessionMode: "new", executionMode: "background" }
    }));
    await Promise.resolve();
    const current = jobs.get(first.jobId)!;

    const stale = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "73737373-7373-4373-8373-737373737373",
        jobId: first.jobId,
        expectedVersion: current.version - 1,
        reason: "The user stopped the target job"
      }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("version changed");
    expect(upstream.aborts).toBe(0);

    const unconfirmed = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "74747474-7474-4474-8474-747474747474",
        jobId: first.jobId,
        expectedVersion: current.version,
        reason: "The user stopped the target job"
      }
    });
    expect(unconfirmed.isError).toBe(true);
    expect(JSON.stringify(unconfirmed)).toContain("acknowledgeAffectedJobIds");
    expect(upstream.aborts).toBe(0);

    const affected = [first.jobId, second.jobId].sort();
    const stopped = parseToolJson(await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "75757575-7575-4575-8575-757575757575",
        jobId: first.jobId,
        expectedVersion: current.version,
        reason: "The user stopped the target job",
        acknowledgeAffectedJobIds: affected
      }
    }));
    expect(stopped).toMatchObject({
      action: "cancel-job",
      target: { type: "job", id: first.jobId, state: "cancelled" }
    });
    expect(jobs.get(first.jobId)).toMatchObject({ status: "cancelled", trackingState: "worker-lost" });
    expect(jobs.get(second.jobId)).toMatchObject({
      status: "interrupted",
      terminalOrigin: "assignment-containment",
      cancellationIntentId: expect.any(String),
      trackingState: "worker-lost",
      error: expect.stringContaining(`force-stopped job ${first.jobId}`)
    });
    const [containmentIntent] = jobs.listCancellationIntents({ jobId: second.jobId });
    expect(containmentIntent).toMatchObject({
      source: "assignment-containment",
      actionName: "interrupt-shared-worker",
      status: "succeeded"
    });
    expect(upstream.aborts).toBe(1);
    await close();
  });

  it("accepts cancellation acknowledgement sets above the former 30-job boundary", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const acknowledged = Array.from({ length: 31 }, (_, index) => `affected-job-${index + 1}`);

    const jobCancellation = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "76767676-7676-4676-8676-767676767676",
        jobId: "missing-job",
        expectedVersion: 1,
        reason: "The user stopped the missing job",
        acknowledgeAffectedJobIds: acknowledged
      }
    });
    expect(jobCancellation.isError).toBe(true);
    expect(JSON.stringify(jobCancellation)).toContain("Unknown Codex job id");

    const activityCancellation = await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "65656565-6565-4565-8565-656565656565",
        activityId: SCOPE_B,
        expectedVersion: 1,
        reason: "The user stopped the missing Activity",
        acknowledgeAffectedJobIds: acknowledged
      }
    });
    expect(activityCancellation.isError).toBe(true);
    expect(JSON.stringify(activityCancellation)).toContain("Unknown Activity id");

    expect(() => new CodexJobRegistry({
      maxConcurrentJobs: HARD_MAX_CONCURRENT_JOBS + 1
    })).toThrow(new RegExp(`between 1 and ${HARD_MAX_CONCURRENT_JOBS}`));
    await close();
  });

  it("requires wait options to target a specific job", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const missingJob = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", waitFor: "terminal", waitMs: 10 } }
    });
    const missingMode = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: "missing", waitMs: 10 } }
    });

    expect(missingJob.isError).toBe(true);
    expect(JSON.stringify(missingJob)).toContain("id");
    expect(JSON.stringify(missingMode)).toContain("waitMs requires waitFor");
    await close();
  });

  it("reports a failed slow task through codex_status", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    upstream.rejectNext(new Error("boom"));

    const failed = await waitForJobStatus(client, started.jobId, "failed");
    expect(failed.error.message).toContain("boom");
    await close();
  });

  it("bounds retained job results without losing the completed session", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES: "200" }),
      new LargeResultUpstream()
    );

    const result = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "large", sessionMode: "new", executionMode: "foreground" }
      })
    );
    expect(result).toMatchObject({
      status: "completed",
      delivery: "omitted",
      resultAvailability: "omitted",
      resultOmitted: true,
      answer: null,
      threadId: "large-thread"
    });

    const exact = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: result.jobId } }
    }));
    expect(exact.items[0]).toMatchObject({
      result: { availability: "omitted", omitted: true }
    });
    expect(exact.items[0]).not.toHaveProperty("answer");

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.counts.sessions).toBe(1);
    expect(status.jobs[0]).toMatchObject({ status: "completed", resultOmitted: true });
    await close();
  });

  it("marks an Agent orphaned when its backend thread is unavailable and requires explicit fresh recovery", async () => {
    const root = temporaryRoot();
    const unavailable = new Set<string>();
    const upstream = new RestartAwareUpstream(unavailable);
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const started = await runTask(client, {
      prompt: "seed Agent",
      agentName: "Recovery Agent",
      contextMode: "fresh"
    });
    const agentId = parseToolJson(started).agentId;
    unavailable.add("thread-1");

    const explicit = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue stale", agentId, contextMode: "continue" }
    });
    expect(explicit.isError).toBe(true);
    expect(JSON.stringify(explicit)).toContain("AGENT_ORPHANED");
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "orphaned" });
    expect(upstream.calls).toHaveLength(1);

    const restarted = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "start after restart", agentId, contextMode: "fresh", executionMode: "foreground" }
    });
    expect(restarted.isError).not.toBe(true);
    const restartedStructured = parseToolJson(restarted);
    expect(restartedStructured.threadId).toBe("thread-2");
    expect(jobs.get(restartedStructured.jobId)?.sessionDecision).toMatchObject({
      action: "start",
      reason: "activity-new",
      threadId: "thread-2"
    });
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex"]);
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "thread-2" });
    await close();
  });

  it("keeps busy and transient resume probes retryable while orphaning definitive thread failure", async () => {
    const root = temporaryRoot();
    const upstream = new ProbeAwareUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const started = await runTask(client, {
      prompt: "seed probe Agent",
      agentName: "Probe Agent",
      contextMode: "fresh"
    });
    const agentId = parseToolJson(started).agentId;

    upstream.probe = {
      state: "busy",
      runtimeStatus: "active",
      threadId: "thread-1",
      retryable: true
    };
    const busy = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "busy retry", agentId, contextMode: "continue" }
    });
    expect(busy).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "AGENT_THREAD_BUSY", retryable: true }
      }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle" });

    upstream.probe = {
      state: "unknown",
      reason: "transient",
      threadId: "thread-1",
      retryable: true
    };
    const unavailable = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "probe retry", agentId, contextMode: "continue" }
    });
    expect(unavailable).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "THREAD_PROBE_UNAVAILABLE", retryable: true }
      }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle" });

    upstream.probe = {
      state: "orphaned",
      reason: "system-error",
      threadId: "thread-1",
      retryable: false
    };
    const corrupt = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "corrupt thread", agentId, contextMode: "continue" }
    });
    expect(corrupt).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "AGENT_ORPHANED",
          retryable: false
        }
      }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "orphaned" });
    expect(upstream.calls).toHaveLength(1);
    const orphanedStatus = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: {} })
    );
    expect(orphanedStatus.scopeCounts).toMatchObject({ agents: 1, orphanedAgents: 1 });

    await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "73737373-7373-4373-8373-737373737373",
        agentId,
        action: "archive"
      }
    });
    upstream.probe = {
      state: "resumable",
      runtimeStatus: "notLoaded",
      threadId: "thread-1"
    };
    const restored = await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "74747474-7474-4474-8474-747474747474",
        agentId,
        action: "restore"
      }
    });
    expect(parseToolJson(restored)).toMatchObject({
      ok: true,
      target: { type: "agent", id: agentId, state: "idle" }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "thread-1" });
    await close();
  });

  it("rechecks execution policy after a deferred thread probe before orphaning an Agent", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const upstream = new DeferredProbeUpstream();
    const connection = await connectTestClient(config, upstream);
    const seeded = await runTask(connection.client, {
      prompt: "seed the deferred policy probe",
      agentName: "Deferred Policy Agent",
      contextMode: "fresh"
    });
    const seededTask = parseToolJson(seeded);
    const selectedProject = connection.settings.current.projects[0]!;
    const project = {
      name: selectedProject.name,
      projectRef: selectedProject.projectRef,
      projectRevision: selectedProject.projectRevision
    };

    const pending = connection.client.callTool({
      name: "codex_task",
      arguments: {
        requestId: "31313131-3131-4131-8131-313131313131",
        prompt: "do not orphan after the descriptor policy changes",
        project,
        activity: { mode: "new", title: "Deferred policy race" },
        agent: { mode: "existing", id: seededTask.agentId, context: "continue" },
        executionMode: "foreground"
      }
    });
    await vi.waitFor(() => expect(upstream.hasPendingProbe).toBe(true));
    connection.settings.update(
      { showBridgeThreadsInCodexApp: true },
      connection.settings.current.revision
    );
    upstream.resolveProbe({
      state: "orphaned",
      reason: "missing",
      runtimeStatus: "notLoaded",
      retryable: false
    });

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "EXECUTION_POLICY_CHANGED", retryable: true }
      }
    });
    expect(connection.jobs.getAgent(seededTask.agentId)).toMatchObject({ lifecycle: "idle" });
    expect(connection.jobs.listActivities(SCOPE_A, 100, 0)).toHaveLength(1);
    expect(connection.jobs.listForScope(SCOPE_A)).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
    await connection.close();
  });

  it("rechecks an explicit project after a deferred probe before rewriting session lineage", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredProbeUpstream();
    const connection = await connectTestClient(configFor(root), upstream);
    const seeded = await runTask(connection.client, {
      prompt: "seed the deferred project probe",
      agentName: "Deferred Project Agent",
      contextMode: "fresh"
    });
    const seededTask = parseToolJson(seeded);
    const beforeSession = connection.sessions.get(seededTask.threadId)!;
    const selectedProject = connection.settings.current.projects[0]!;
    const project = {
      name: selectedProject.name,
      projectRef: selectedProject.projectRef,
      projectRevision: selectedProject.projectRevision
    };

    const pending = connection.client.callTool({
      name: "codex_task",
      arguments: {
        requestId: "32323232-3232-4232-8232-323232323232",
        prompt: "do not rewrite lineage after the selected project changes",
        project,
        activity: { mode: "new", title: "Deferred project race" },
        agent: { mode: "existing", id: seededTask.agentId, context: "continue" },
        executionMode: "foreground"
      }
    });
    await vi.waitFor(() => expect(upstream.hasPendingProbe).toBe(true));
    const selected = connection.settings.current.projects[0]!;
    connection.settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: selected.id, name: "Renamed During Probe" }],
      undefined,
      connection.settings.current.registryRevision
    );
    upstream.resolveProbe({
      state: "resumable",
      runtimeStatus: "idle",
      sessionId: "lineage-that-must-not-be-recorded"
    });

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "PROJECT_REGISTRY_CHANGED", retryable: true },
        nextActions: [
          expect.stringContaining("new requestId")
        ]
      }
    });
    expect(connection.sessions.get(seededTask.threadId)).toEqual(beforeSession);
    expect(connection.jobs.getAgent(seededTask.agentId)).toMatchObject({ lifecycle: "idle" });
    expect(connection.jobs.listActivities(SCOPE_A, 100, 0)).toHaveLength(1);
    expect(connection.jobs.listForScope(SCOPE_A)).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
    await connection.close();
  });

  it("uses a projectless codex_task setup probe before first-run Settings onboarding", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, bareCallTool, jobs, sessions, settings, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new FakeModelCatalog(),
      undefined,
      undefined,
      false
    );

    const initialTools = await client.listTools();
    const initialTask = initialTools.tools.find((tool) => tool.name === "codex_task");
    const initialSchema = initialTask?.inputSchema as Record<string, any>;
    expect(initialSchema.properties.project).toMatchObject({
      type: "object",
      required: ["name", "projectRef", "projectRevision"],
      additionalProperties: false
    });
    expect(initialSchema.properties.projectLookup).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false
    });
    expect(initialSchema).not.toHaveProperty("allOf");
    expect(JSON.stringify(initialSchema)).not.toContain('"not":{}');
    expect(initialTask?._meta).toBeUndefined();
    expect(initialTask?.description).toContain("An empty registry returns PROJECT_SETUP_REQUIRED");
    const settingsTool = initialTools.tools.find((tool) => tool.name === "codex_settings");
    expect(settingsTool?.description).toContain("after an actual codex_task response");
    expect(settingsTool?.description).toContain(
      "Never open it merely because a conversation starts or this plugin is attached"
    );
    expect(settingsTool?.description).toContain(
      "projectLookup reports that the explicitly requested project needs recovery"
    );

    const setupProbe = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: "75757575-7575-4575-8575-757575757575",
        activityPresentationId: "76767676-7676-4676-8676-767676767676",
        prompt: "start the requested first-run Codex work",
        activity: { mode: "new", title: "First-run setup probe" },
        agent: { mode: "new", name: "First-run Agent" },
        executionMode: "foreground"
      }
    });
    expect(setupProbe).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "PROJECT_SETUP_REQUIRED"
        },
        nextActions: [expect.stringContaining("Open settings")]
      }
    });
    const setupContent = (setupProbe as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(setupContent).not.toHaveProperty("bridgeActivity");
    expect(setupContent).not.toHaveProperty("bridgeSession");
    expect(upstream.calls).toEqual([]);
    expect(jobs.listActivities(SCOPE_A)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true)).toEqual([]);
    expect(jobs.listForScope(SCOPE_A)).toEqual([]);
    expect(sessions.listForScope(SCOPE_A)).toEqual([]);

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRegistryRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { name: "First Project", cwd: root } }
            ]
          }
        }
      }
    });
    expect(saved.isError).not.toBe(true);

    const registeredTask = (await client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    );
    const registeredSchema = registeredTask?.inputSchema as Record<string, any>;
    expect(registeredSchema).not.toHaveProperty("allOf");
    expect(registeredTask).toEqual(initialTask);
    expect(JSON.stringify(registeredSchema)).not.toContain("First Project");
    expect(registeredTask?._meta).toBeUndefined();

    const missingProject = await bareCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "77777777-7777-4777-8777-777777777777",
        taskContractVersion: CODEX_TASK_INPUT_CONTRACT_VERSION,
        executionEnvelopeRef: settings.taskExecutionEnvelopeRef(),
        activityPresentationId: "78787878-7878-4878-8878-787878787878",
        prompt: "new work must now select the exact registered project",
        activity: { mode: "new" },
        agent: { mode: "new", name: "Missing Project Agent" },
        executionMode: "foreground"
      }
    });
    expect(missingProject.isError).toBe(true);
    expect(JSON.stringify(missingProject)).toContain("PROJECT_REQUIRED");
    expect(upstream.calls).toEqual([]);
    expect(jobs.listActivities(SCOPE_A)).toEqual([]);
    expect(jobs.listAgents(SCOPE_A, true)).toEqual([]);
    expect(jobs.listForScope(SCOPE_A)).toEqual([]);
    expect(sessions.listForScope(SCOPE_A)).toEqual([]);
    await close();
  });

  it("requires a registered project for multiple roots and retires every per-call cwd override", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const outside = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const upstream = new FakeUpstream();
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      undefined,
      undefined,
      false
    );

    const missing = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", agentName: "Missing Cwd", contextMode: "fresh" }
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "PROJECT_SETUP_REQUIRED"
        },
        nextActions: [expect.stringContaining("Open settings")]
      }
    });
    expect(jobs.listAgents(SCOPE_A, true)).toEqual([]);
    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", agentName: "Retired Cwd", contextMode: "fresh", cwd: outside }
    });
    expect(JSON.stringify(denied)).toContain("Unrecognized key");
    expect(JSON.stringify(denied)).toContain("cwd");
    const invalidSave = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { id: "outside", label: "Outside", cwd: outside } }
            ]
          }
        }
      }
    });
    expect(invalidSave.isError).toBe(true);
    expect(JSON.stringify(invalidSave)).toContain("PROJECT_CWD_NOT_ALLOWED");
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              { kind: "add", project: { id: "primary", label: "Primary", cwd: first } }
            ]
          }
        }
      }
    });
    expect(saved.isError).not.toBe(true);
    await runTask(client, {
      prompt: "inspect saved",
      projectId: "primary",
      agentName: "Saved Cwd",
      contextMode: "fresh"
    });
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(first));
    await close();
  });

  it("blocks sensitive files on start and rechecks before continuation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const first = await runTask(client, {
      prompt: "first",
      agent: { mode: "new", name: "Sensitive-file Agent" }
    });
    const agentId = parseToolJson(first).agentId as string;
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");

    const continued = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "continue",
        agent: { mode: "existing", id: agentId, context: "continue" }
      }
    });
    expect(continued.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("can explicitly disable the sensitive-file preflight", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN: "1" }),
      upstream
    );

    await runTask(client, { prompt: "inspect", sessionMode: "new" });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("rejects oversized prompts", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS: "5" }),
      upstream
    );

    const result = await client.callTool({ name: "codex_task", arguments: { prompt: "123456" } });
    expect(result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(0);
    await close();
  });

  it("does not expose and strictly rejects the retired Codex execution timeout", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const result = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", timeoutMs: 10800001 }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("timeoutMs");
    expect(upstream.calls).toHaveLength(0);
    await close();
  });

  it("limits total concurrent jobs", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "1"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", sessionMode: "new" }
    });
    expect(second.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
    upstream.resolveNext();
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("applies the saved concurrency limit below the owner maximum", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
    });
    const settings = new UserSettingsStore(config);
    settings.update({ maxConcurrentJobs: 1 }, settings.current.revision);
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", sessionMode: "new" }
    });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("configured limit is 1");
    upstream.resolveNext();
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("allows thirty concurrent jobs and rejects the thirty-first by default", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const started = await Promise.all(
      Array.from({ length: 30 }, async (_, index) =>
        parseToolJson(
          await client.callTool({
            name: "codex_task",
            arguments: {
              prompt: `parallel-${index + 1}`,
              sessionMode: "new"
            }
          })
        )
      )
    );
    expect(started.every((job) => job.status === "running")).toBe(true);
    expect(upstream.calls).toHaveLength(30);
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.jobs).toHaveLength(30);

    const overflow = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "parallel-31", sessionMode: "new" }
    });
    expect(overflow.isError).toBe(true);
    expect(JSON.stringify(overflow)).toContain("configured limit is 30");
    expect(upstream.calls).toHaveLength(30);

    for (let index = 0; index < 30; index += 1) {
      upstream.resolveNext(fakeCodexResult(`thread-${index + 1}`));
    }
    await Promise.all(started.map((job) => waitForJobStatus(client, job.jobId, "completed")));
    await close();
  });

  it("runs new sessions concurrently in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "first", sessionMode: "new" }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "second", sessionMode: "new" }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("allows workspace-write jobs in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "first write",
          sessionMode: "new",
          sandbox: "workspace-write"
        }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "second write",
          sessionMode: "new",
          sandbox: "workspace-write"
        }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("write-thread-1"));
    upstream.resolveNext(fakeCodexResult("write-thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("allows danger-full-access jobs in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "first full",
          sessionMode: "new",
          sandbox: "danger-full-access"
        }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "second full",
          sessionMode: "new",
          sandbox: "danger-full-access"
        }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("full-thread-1"));
    upstream.resolveNext(fakeCodexResult("full-thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("can add a parallel Agent while one Agent in the Activity is busy", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const seeded = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "seed Activity" } })
    );
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, seeded.jobId, "completed");
    const seededAgentId = seeded.agentId;

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "continue Activity",
          activityId: seeded.activityId,
          agentId: seededAgentId,
          contextMode: "continue"
        }
      })
    );
    const second = await client.callTool({
      name: "codex_task",
        arguments: {
          prompt: "same Agent automatically",
          activityId: seeded.activityId,
          agentId: seededAgentId,
          contextMode: "continue"
        }
    });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("AGENT_BUSY");

    const parallel = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "parallel work",
          agentName: "Parallel Agent",
          contextMode: "fresh",
          activityId: seeded.activityId
        }
      })
    );

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply", "codex"]);
    expect(jobs.get(parallel.jobId)?.sessionDecision).toMatchObject({
      action: "start",
      reason: "activity-no-compatible"
    });
    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, parallel.jobId, "completed")
    ]);
    await close();
  });

  it("does not start a second implicit auto session while the first one has no thread id yet", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "first implicit auto" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "second implicit auto",
        projectId: "default",
        activityId: first.activityId
      }
    });

    expect(first.status).toBe("running");
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("AGENT_BUSY");
    expect(upstream.calls).toHaveLength(1);
    upstream.resolveNext(fakeCodexResult("auto-thread"));
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("continues an Activity thread without an age limit and does not bypass it while busy", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const sessions = new SessionRegistry();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream,
      sessions
    );

    const seeded = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "seed old Activity thread" } })
    );
    upstream.resolveNext(fakeCodexResult("expiring-thread"));
    await waitForJobStatus(client, seeded.jobId, "completed");
    const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
    sessions.record({
      ...(sessions.get("expiring-thread") as NonNullable<ReturnType<SessionRegistry["get"]>>),
      lastUsedAt: old
    });

    const continuing = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "implicitly continue the old Activity thread",
          activityId: seeded.activityId
        }
      })
    );
    const auto = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "auto must not create a duplicate", activityId: seeded.activityId }
    });

    expect(continuing.status).toBe("running");
    expect(auto.isError).toBe(true);
    expect(JSON.stringify(auto)).toContain("AGENT_BUSY");
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply"]);
    upstream.resolveNext(fakeCodexResult("expiring-thread"));
    await waitForJobStatus(client, continuing.jobId, "completed");
    await close();
  });

  it("serializes concurrent turns on the same bridge Agent", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const seeded = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "seed", agentName: "Serial Agent", contextMode: "fresh" }
    }));
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, seeded.jobId, "completed");

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "first", agentId: seeded.agentId, contextMode: "continue" }
      })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", agentId: seeded.agentId, contextMode: "continue" }
    });

    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("AGENT_BUSY");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });
});

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "bridge-root-"));
}

function legacyV5TaskRequestHashFixture(input: {
  scopeId: string;
  prompt: string;
  projectName: string;
  registryRevision: number;
  projectId: string;
  cwd: string;
  sandbox: string;
  backendKind: string;
  executionMode: string;
  selection: { model: string; reasoningEffort: string; serviceTier?: string };
  activityTitle: string;
  agentName: string;
}): string {
  return createHash("sha256")
    .update(canonicalFixtureJson({
      version: 5,
      scopeId: input.scopeId,
      prompt: input.prompt,
      backendHandoff: null,
      projectRequest: {
        name: input.projectName,
        registryRevision: input.registryRevision
      },
      admittedProject: { projectId: input.projectId, cwd: input.cwd },
      routing: {
        activity: { mode: "new", continuationOfActivityId: null },
        agent: { mode: "new", contextMode: "fresh", sourceThreadId: null }
      },
      execution: {
        operation: "start",
        backendKind: input.backendKind,
        cwd: input.cwd,
        sandbox: input.sandbox,
        executionMode: input.executionMode,
        modelSelection: {
          model: input.selection.model,
          reasoningEffort: input.selection.reasoningEffort,
          serviceTier: input.selection.serviceTier || null
        }
      },
      creation: {
        activity: {
          title: input.activityTitle,
          kind: "other",
          executionMode: input.executionMode,
          handoffPolicy: "none",
          completionTrigger: "manual"
        },
        agent: { name: input.agentName },
        assignmentRole: "primary"
      }
    }))
    .digest("hex");
}

function canonicalFixtureJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalFixtureJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixtureJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported fixture JSON value: ${typeof value}.`);
}

function configFor(root: string, extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_ROOTS: root,
    ...extra
  });
}

async function connectTestClient(
  config: ReturnType<typeof loadConfig>,
  upstream: CodexUpstream,
  sessions?: SessionRegistry,
  modelCatalog: CodexModelCatalogProvider = new FakeModelCatalog(),
  userSettings?: UserSettingsStore,
  jobs?: CodexJobRegistry,
  bootstrapProject = true
) {
  const ownedState = !userSettings && !jobs
    ? new BridgeStateStore({ file: ":memory:" })
    : undefined;
  const sharedState = userSettings?.admissionStateStore ||
    jobs?.admissionStateStore ||
    ownedState;
  const settingsStore = userSettings || new UserSettingsStore(config, {
    stateStore: sharedState
  });
  if (bootstrapProject && settingsStore.current.projects.length === 0) {
    const cwd = config.allowedRoots[0];
    if (cwd) {
      settingsStore.updateWithProjectOperations(
        {},
        [{ kind: "add", project: { name: "Test Project", cwd } }],
        undefined,
        0
      );
    }
  }
  const jobRegistry = jobs || new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    allowedRoots: config.allowedRoots,
    stateStore: sharedState
  });
  const sessionRegistry = sessions || new SessionRegistry({
    allowedRoots: config.allowedRoots,
    stateStore: sharedState
  });
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessionRegistry,
    jobRegistry,
    modelCatalog,
    settingsStore
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const currentExecutionPolicyRef = () => settingsStore.executionPolicyRef(
    settingsStore.current,
    (() => {
      const catalog = modelCatalog.getCachedCatalog?.({ backendKind: config.defaultBackend });
      return catalog ? modelCatalogAdmissionFingerprint(catalog.models) : null;
    })()
  );
  const baseCallTool = client.callTool.bind(client);
  const bareCallTool = (...args: Parameters<typeof baseCallTool>) => baseCallTool(...args);
  const rawCallTool = (
    request: Parameters<typeof baseCallTool>[0],
    ...rest: Parameters<typeof baseCallTool> extends [unknown, ...infer Tail] ? Tail : never
  ) => {
    if (request.name !== "codex_task") return bareCallTool(request, ...rest);
    const arguments_ = request.arguments || {};
    return bareCallTool({
      ...request,
      arguments: {
        executionPolicyRef: currentExecutionPolicyRef(),
        ...arguments_
      }
    }, ...rest);
  };
  Object.defineProperty(client, "callTool", {
    value: (
      request: {
        name: string;
        arguments?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      },
      ...rest: unknown[]
    ) => {
      const arguments_ = request.arguments || {};
      if (request.name === "codex_task") {
        const currentArguments = currentTaskTestArguments(arguments_);
        const explicitLegacyContract =
          Object.prototype.hasOwnProperty.call(currentArguments, "executionPolicyRef") &&
          !Object.prototype.hasOwnProperty.call(currentArguments, "taskContractVersion");
        if (!explicitLegacyContract) {
          currentArguments.taskContractVersion ??= CODEX_TASK_INPUT_CONTRACT_VERSION;
          currentArguments.executionEnvelopeRef ??= settingsStore.taskExecutionEnvelopeRef();
        }
        const activity = currentArguments.activity as Record<string, unknown> | undefined;
        const agent = currentArguments.agent as Record<string, unknown> | undefined;
        const admitsFreshWork =
          activity?.mode !== "existing" ||
          agent?.mode === "new" ||
          (agent?.mode === "existing" && agent.context === "fresh");
        const legacyProjectId = typeof currentArguments.projectId === "string"
          ? currentArguments.projectId
          : undefined;
        delete currentArguments.projectId;
        if (
          admitsFreshWork &&
          !Object.prototype.hasOwnProperty.call(currentArguments, "project") &&
          !Object.prototype.hasOwnProperty.call(currentArguments, "projectLookup")
        ) {
          const target = selectTestProject(settingsStore, legacyProjectId);
          if (target) {
            currentArguments.project = {
              name: target.name,
              projectRef: target.projectRef,
              projectRevision: target.projectRevision
            };
          }
        } else if (legacyProjectId && !Object.prototype.hasOwnProperty.call(currentArguments, "project")) {
          const target = selectTestProject(settingsStore, legacyProjectId);
          currentArguments.project = {
            name: target?.name || legacyProjectId,
            ...(target
              ? {
                  projectRef: target.projectRef,
                  projectRevision: target.projectRevision
                }
              : {
                  projectRef: "prj_AAAAAAAAAAAAAAAAAAAAAA",
                  projectRevision: 1
                })
          };
        }
        const requestId = typeof currentArguments.requestId === "string"
          ? currentArguments.requestId
          : nextRequestId();
        return rawCallTool(
          {
            ...request,
            arguments: {
              scopeId: SCOPE_A,
              requestId,
              ...currentArguments
            }
          },
          ...(rest as [])
        );
      }
      const currentArguments = currentToolTestArguments(
        request.name,
        arguments_,
        settingsStore
      );
      if (
        (
          request.name === "codex_status" ||
          request.name === "codex_dashboard" ||
          request.name === "codex_dashboard_snapshot" ||
          request.name === "codex_activity" ||
          request.name === "codex_activity_rehydrate" ||
          request.name === "codex_activity_snapshot" ||
          request.name === "codex_activity_handoff" ||
          request.name === "codex_activity_job_cancel" ||
          request.name === "codex_activity_cancel" ||
          request.name === "codex_activity_update" ||
          request.name === "codex_agent" ||
          request.name === "codex_agent_recovery_detach" ||
          request.name === "codex_background_process_terminate" ||
          request.name === "codex_interaction_respond" ||
          request.name === "codex_job_steer" ||
          request.name === "codex_steer"
        ) &&
        !currentArguments.scopeId &&
        !currentArguments.includeAllScopes
      ) {
        return rawCallTool(
          { ...request, arguments: { scopeId: SCOPE_A, ...currentArguments } },
          ...(rest as [])
        );
      }
      return rawCallTool({ ...request, arguments: currentArguments }, ...(rest as []));
    }
  });
  return {
    client,
    rawCallTool,
    bareCallTool,
    jobs: jobRegistry,
    sessions: sessionRegistry,
    settings: settingsStore,
    close: async () => {
      await client.close();
      await server.close();
      ownedState?.close();
    }
  };
}

function selectTestProject(
  settings: UserSettingsStore,
  legacyProjectId?: string
) {
  const active = settings.current.projects.filter((project) => project.archivedAt === undefined);
  if (!legacyProjectId || legacyProjectId === "default") return active[0];
  let requestedKey: string | undefined;
  try {
    requestedKey = projectNameKey(legacyProjectId);
  } catch {
    // Invalid legacy routing values remain unknown names for negative tests.
  }
  const slug = (value: string) => value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return active.find((project) =>
    project.id === legacyProjectId ||
    (requestedKey !== undefined && project.nameKey === requestedKey) ||
    slug(project.name) === slug(legacyProjectId)
  );
}

async function runTask(client: Client, arguments_: Record<string, unknown>): Promise<unknown> {
  const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task");
  const executionPolicyRef = (
    task?.inputSchema.properties?.executionPolicyRef as { const?: string } | undefined
  )?.const;
  return client.callTool({
    name: "codex_task",
    arguments: {
      executionMode: "foreground",
      ...(executionPolicyRef ? { executionPolicyRef } : {}),
      ...arguments_
    }
  });
}

async function presentCompactActivity(
  client: Client,
  activityId?: string,
  presentationId = nextRequestId()
): Promise<unknown> {
  return client.callTool({
    name: "codex_activity",
    arguments: {
      mode: "compact-monitor",
      presentationId,
      ...(activityId ? { activityId } : {})
    }
  });
}

function automaticCardProof(result: unknown): {
  activityId: string;
  generation: number;
  presentation: {
    kind: "automatic";
    activityPresentationId: string;
    reservationOwnerId?: string;
  };
} {
  const view = privateActivityView(result);
  if (
    !view.mountedActivity ||
    view.mountedPresentation?.kind !== "automatic" ||
    typeof view.mountedPresentation.activityPresentationId !== "string"
  ) {
    throw new Error(`Activity result is not a compact automatic presentation: ${JSON.stringify(result)}`);
  }
  return {
    activityId: view.mountedActivity.activityId,
    generation: view.mountedActivity.cardGeneration,
    presentation: {
      kind: "automatic",
      activityPresentationId: view.mountedPresentation.activityPresentationId,
      ...(view.mountedPresentation.reservationOwnerId
        ? { reservationOwnerId: view.mountedPresentation.reservationOwnerId }
        : {})
    }
  };
}

function currentTaskTestArguments(input: Record<string, unknown>): Record<string, unknown> {
  const current = { ...input };
  const activityId = typeof current.activityId === "string" ? current.activityId : undefined;
  const continuationOf = typeof current.continuationOfActivityId === "string"
    ? current.continuationOfActivityId
    : undefined;
  const title = typeof current.activityTitle === "string" ? current.activityTitle : undefined;
  const kind = typeof current.activityKind === "string" ? current.activityKind : undefined;
  const handoff = typeof current.handoffPolicy === "string" ? current.handoffPolicy : undefined;
  const completion = typeof current.completionTrigger === "string"
    ? current.completionTrigger
    : undefined;
  if (!current.activity) {
    if (activityId) {
      current.activity = { mode: "existing", id: activityId };
    } else if (continuationOf || title || kind || handoff || completion) {
      current.activity = {
        mode: "new",
        ...(continuationOf ? { continuationOf } : {}),
        ...(title ? { title } : {}),
        ...(kind || handoff || completion
          ? {
              policy: {
                ...(kind ? { kind } : {}),
                ...(handoff ? { handoff } : {}),
                ...(completion ? { completion } : {})
              }
            }
          : {})
      };
    }
  }

  const agentId = typeof current.agentId === "string" ? current.agentId : undefined;
  const agentName = typeof current.agentName === "string" ? current.agentName : undefined;
  const context = typeof current.contextMode === "string"
    ? current.contextMode
    : current.sessionMode === "continue"
      ? "continue"
      : current.sessionMode === "new"
        ? "fresh"
        : undefined;
  if (!current.agent) {
    if (agentId) {
      current.agent = { mode: "existing", id: agentId, ...(context ? { context } : {}) };
    } else if (agentName) {
      current.agent = { mode: "new", name: agentName };
    }
  }

  for (const key of [
    "activityId",
    "continuationOfActivityId",
    "activityTitle",
    "activityKind",
    "handoffPolicy",
    "completionTrigger",
    "agentId",
    "agentName",
    "agentRole",
    "contextMode",
    "sessionMode"
  ]) {
    delete current[key];
  }
  return current;
}

function currentToolTestArguments(
  toolName: string,
  input: Record<string, unknown>,
  settingsStore: UserSettingsStore
): Record<string, unknown> {
  if (toolName === "codex_status" && !input.query) {
    const current = { ...input };
    if (typeof current.jobId === "string") {
      current.query = {
        kind: "job",
        id: current.jobId,
        ...(typeof current.waitFor === "string" ? { waitFor: current.waitFor } : {}),
        ...(typeof current.waitMs === "number" ? { waitMs: current.waitMs } : {})
      };
    } else if (typeof current.activityId === "string") {
      current.query = { kind: "activity", id: current.activityId };
    } else if (typeof current.threadId === "string") {
      current.query = { kind: "thread", id: current.threadId };
    } else {
      for (const collection of ["sessions", "jobs", "activities"] as const) {
        const prefix = collection === "activities" ? "activity" : collection.slice(0, -1);
        const limit = current[`${prefix}Limit`];
        const cursor = current[`${prefix}Cursor`];
        if (typeof limit === "number" || typeof cursor === "string") {
          current.query = {
            kind: "page",
            collection,
            ...(typeof limit === "number" ? { limit } : {}),
            ...(typeof cursor === "string" ? { cursor } : {})
          };
          break;
        }
      }
    }
    if (current.query) {
      for (const key of [
        "jobId",
        "activityId",
        "threadId",
        "waitFor",
        "waitMs",
        "sessionLimit",
        "sessionOffset",
        "sessionCursor",
        "jobLimit",
        "jobOffset",
        "jobCursor",
        "activityLimit",
        "activityOffset",
        "activityCursor"
      ]) {
        delete current[key];
      }
    }
    return current;
  }

  if (toolName === "codex_agent" && !input.operation) {
    const current = { ...input };
    if (current.action === "archive" || current.action === "restore") {
      current.operation = { kind: current.action };
    } else if (current.action === "rename" && typeof current.agentName === "string") {
      current.operation = { kind: "rename", name: current.agentName };
    }
    if (current.operation) {
      delete current.action;
      delete current.agentName;
    }
    return current;
  }

  if (toolName === "codex_activity_update" && !input.operation) {
    const current = { ...input };
    const action = current.action;
    if (action === "seal" || action === "start-verification") {
      current.operation = { kind: action };
    } else if ((action === "complete" || action === "abandon") &&
      (current.reason === undefined || typeof current.reason === "string")) {
      current.operation = { kind: action, ...(current.reason ? { reason: current.reason } : {}) };
    } else if (action === "verification-passed" && current.evidence) {
      current.operation = { kind: action, evidence: current.evidence };
    } else if (action === "verification-failed" && typeof current.reason === "string") {
      current.operation = { kind: action, reason: current.reason };
    } else if (action === "set-policy") {
      current.operation = {
        kind: action,
        policy: {
          ...(current.activityKind ? { kind: current.activityKind } : {}),
          ...(current.executionMode ? { executionMode: current.executionMode } : {}),
          ...(current.handoffPolicy ? { handoff: current.handoffPolicy } : {}),
          ...(current.completionTrigger ? { completion: current.completionTrigger } : {})
        }
      };
    }
    if (current.operation) {
      for (const key of [
        "action",
        "reason",
        "evidence",
        "activityKind",
        "executionMode",
        "handoffPolicy",
        "completionTrigger"
      ]) {
        delete current[key];
      }
    }
    return current;
  }

  if (toolName === "codex_update_settings") {
    const current = { ...input };
    if (!current.operation) {
      if (current.reset === true) {
        current.operation = { kind: "reset" };
        delete current.reset;
      } else {
        const settings: Record<string, unknown> = {};
        for (const key of [
          "accessStrategy",
          "modelPolicy",
          "usePriorityServiceTier",
          "uiLocalePreference",
          "maxConcurrentJobs"
        ]) {
          if (Object.prototype.hasOwnProperty.call(current, key)) settings[key] = current[key];
        }
        if (current.activityCardVisibility !== undefined || current.completionHandoff !== undefined) {
          settings.activityCard = {
            ...(current.activityCardVisibility !== undefined
              ? { visibility: current.activityCardVisibility }
              : {}),
            ...(current.completionHandoff !== undefined
              ? { completionHandoff: current.completionHandoff }
              : {})
          };
        }
        if (Object.keys(settings).length > 0) {
          current.operation = { kind: "patch", settings };
          for (const key of [
            ...Object.keys(settings),
            "activityCardVisibility",
            "completionHandoff"
          ]) {
            delete current[key];
          }
        }
      }
    }
    const operation = current.operation as Record<string, any> | undefined;
    if (operation?.kind === "patch" && operation.settings) {
      const projectOperations = operation.settings.projectOperations as
        | Array<Record<string, any>>
        | undefined;
      if (projectOperations) {
        operation.settings = {
          ...operation.settings,
          projectOperations: projectOperations.map((entry) => {
            if (entry.kind === "add") {
              return {
                kind: "add",
                project: {
                  name: entry.project?.name || entry.project?.label || entry.project?.id,
                  cwd: entry.project?.cwd
                }
              };
            }
            const target = selectTestProject(settingsStore, entry.projectId);
            const projectId = target?.id || entry.projectId;
            if (entry.kind === "remove") return { kind: "archive", projectId };
            if (entry.kind === "rename") {
              return { kind: "rename", projectId, name: entry.name || entry.label };
            }
            if (entry.kind === "relocate") return { kind: "relocate", projectId, cwd: entry.cwd };
            return { ...entry, projectId };
          })
        };
        current.expectedRegistryRevision ??= settingsStore.current.registryRevision;
      }
    }
    const hasGeneralMutation = operation?.kind === "reset" ||
      (operation?.kind === "patch" && Object.keys(operation.settings || {})
        .some((key) => key !== "projectOperations"));
    if (hasGeneralMutation && current.expectedSettingsRevision === undefined) {
      current.expectedSettingsRevision = current.expectedRevision;
    }
    delete current.expectedRevision;
    return current;
  }

  return input;
}

function taskActivityId(result: unknown): string {
  const activityId = (result as { structuredContent?: Record<string, any> }).structuredContent
    ?.activityId;
  if (typeof activityId !== "string") throw new Error("Task result did not include an Activity id.");
  return activityId;
}

function taskSession(result: unknown): Record<string, unknown> {
  return parseToolJson(result).bridgeSession || {};
}

function nextRequestId(): string {
  requestSequence += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${requestSequence.toString(16).padStart(12, "0")}`;
}

function fakeCodexResult(threadId: string): ToolResult {
  return {
    structuredContent: { threadId, content: "done" },
    content: [{ type: "text", text: JSON.stringify({ threadId, content: "done" }) }]
  };
}

function model(
  id: string,
  defaultEffort: string,
  efforts: string[],
  isDefault = false,
  displayName = id
) {
  const descriptions: Record<string, string> = {
    "gpt-5.6-sol": "Latest frontier agentic coding model.",
    "gpt-5.6-terra": "Balanced agentic coding model for everyday work.",
    "gpt-5.6-luna": "Fast and affordable agentic coding model.",
    "gpt-5.5": "Frontier model for complex coding, research, and real-world work.",
    "gpt-5.4": "Strong model for everyday coding.",
    "gpt-5.4-mini": "Small, fast, and cost-efficient model for simpler coding tasks.",
    "gpt-5.3-codex-spark": "Ultra-fast coding model."
  };
  const effortDescriptions: Record<string, string> = {
    low: "Fast responses with lighter reasoning.",
    medium: "Balances speed and reasoning depth for everyday tasks.",
    high: "Greater reasoning depth for complex problems.",
    xhigh: "Extra high reasoning depth for complex problems.",
    max: "Maximum reasoning depth for the hardest problems.",
    ultra: "Maximum reasoning with automatic task delegation."
  };
  return {
    id,
    displayName,
    description: descriptions[id] || `${displayName} catalog guidance.`,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.map((effort) => ({
      effort,
      description: effortDescriptions[effort] || `${effort} reasoning guidance.`
    })),
    isDefault,
    serviceTiers: [],
    inputModalities: ["text"],
    supportedInApi: true
  };
}

function parseToolJson(result: unknown): Record<string, any> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error(`Tool result did not include authoritative structuredContent: ${JSON.stringify(result)}`);
  }
  const output = structured as Record<string, any>;
  const metadata = (result as { _meta?: Record<string, any> })._meta || {};
  const privateActivityView = metadata["codex/activityView@11"]?.view;
  // Activity lifecycle tests inspect the app-hydration projection. W3 keeps
  // the model projection compact, so read the validated private view instead
  // of recreating the retired public fallback.
  const testAliases: Record<string, unknown> = {};
  const alias = (key: string, value: unknown) => {
    if (value === undefined || Object.prototype.hasOwnProperty.call(output, key)) return;
    testAliases[key] = value;
  };
  if (output.kind === "activity" && privateActivityView) {
    for (const [key, value] of Object.entries(privateActivityView)) alias(key, value);
    return privateActivityView;
  }
  if (output.kind === "task") {
    alias("status", output.state);
    const bootstrap = metadata["codex/activityBootstrap@11"];
    if (bootstrap) {
      const bridgeActivity = {
        activityId: bootstrap.activity?.activityId,
        jobId: bootstrap.correlation?.jobId,
        agentId: output.agentId,
        projectName: output.projectName,
        executionMode: output.execution?.mode,
        cardGeneration: bootstrap.activity?.cardGeneration,
        presentationKind: bootstrap.presentation?.kind,
        activityPresentationId: bootstrap.correlation?.activityPresentationId,
        shouldRenderActivityCard: bootstrap.render?.eligible,
        renderReason: bootstrap.render?.reason,
        renderTiming: bootstrap.render?.timing,
        statusTool: "codex_status",
        automaticRenderTool: "codex_activity",
        explicitRenderTool: "codex_activity",
        followUpRenderRequired: false,
        renderToolAvailable: true,
        explicitRenderAllowed: true
      };
      alias("bridgeActivity", bridgeActivity);
      alias("activityTracking", bridgeActivity);
      alias("bridgeSession", {
        requestId: output.requestId,
        projectName: output.projectName,
        scopeId: SCOPE_A,
        threadId: output.threadId
      });
    }
  }
  if (output.kind === "overview" || output.kind === "page" ||
      output.kind === "activity" || output.kind === "thread" || output.kind === "job") {
    const items = Array.isArray(output.items) ? output.items : [];
    const statusItemView = (entry: Record<string, any>) => {
      if (entry.type === "job") {
        return {
          ...entry,
          jobId: entry.id,
          status: entry.state,
          executionMode: entry.execution?.mode,
          backendKind: entry.execution?.backend,
          sandbox: entry.execution?.sandbox,
          resultOmitted: entry.result?.omitted
        };
      }
      if (entry.type === "activity") {
        return { ...entry, activityId: entry.id, lifecycle: entry.state };
      }
      if (entry.type === "agent") {
        return { ...entry, agentId: entry.id, lifecycle: entry.state };
      }
      if (entry.type === "thread") {
        return { ...entry, threadId: entry.id };
      }
      return entry;
    };
    const statusItems = items.map(statusItemView);
    alias("scopeView", output.scope);
    alias("scopeCounts", output.counts);
    alias("sessions", statusItems.filter((entry: any) => entry.type === "thread"));
    alias("jobs", statusItems.filter((entry: any) => entry.type === "job"));
    alias("activities", statusItems.filter((entry: any) => entry.type === "activity"));
    alias("agents", statusItems.filter((entry: any) => entry.type === "agent"));
    if (output.kind === "page") {
      alias("query", { kind: "page", collection: output.page?.collection });
      alias("pagination", output.page);
    } else if (output.kind === "job") {
      const job = statusItems.find((entry: any) => entry.type === "job") || {};
      for (const [key, value] of Object.entries({
        jobId: job.id,
        status: job.state,
        terminal: job.terminal,
        delivery: job.delivery,
        replay: job.replay,
        activityId: job.activityId,
        agentId: job.agentId,
        threadId: job.threadId,
        versions: job.versions,
        executionMode: job.execution?.mode,
        backendKind: job.execution?.backend,
        sandbox: job.execution?.sandbox,
        result: job.result,
        error: job.error,
        wait: job.wait,
        message: job.message
      })) alias(key, value);
    }
  }
  if (output.kind === "mutation" && output.target) {
    const target = output.target;
    alias(target.type, {
      [`${target.type}Id`]: target.id,
      status: target.state,
      lifecycle: target.state,
      version: target.version,
      terminal: target.state === "completed" || target.state === "failed" ||
        target.state === "cancelled"
    });
  }
  const privateSettings = metadata["codex/settingsView"];
  if (privateSettings) {
    alias("settings", privateSettings.settings);
    alias("policyActivation", privateSettings.policyActivation);
  }
  if (Array.isArray(output.models)) {
    alias("activePolicy", output.policy);
    alias("usePriorityServiceTier", output.priority);
    testAliases.models = output.models.map((model: Record<string, any>) =>
      Object.prototype.hasOwnProperty.call(model, "displayName")
        ? model
        : { ...model, displayName: model.name }
    );
  }
  return { ...output, ...testAliases };
}

function privateSettingsView(result: unknown): Record<string, any> {
  const toolResult = result as {
    structuredContent?: Record<string, any>;
    _meta?: Record<string, any>;
  } | undefined;
  const structured = toolResult?.structuredContent;
  const candidate = structured?.settings && structured?.capabilities && structured?.catalog
    ? structured
    : toolResult?._meta?.["codex/settingsView"];
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Missing full Settings-card view: ${JSON.stringify(result)}`);
  }
  return candidate;
}

async function freshDashboardSnapshot(
  rawCallTool: (request: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }) => Promise<any>,
  options: {
    scopeId?: string;
    metadata?: Record<string, unknown>;
    limit?: number;
  } = {}
): Promise<{ result: any; view: Record<string, any> }> {
  dashboardWidgetSequence += 1;
  const widgetSuffix = dashboardWidgetSequence.toString(16).padStart(12, "0");
  const result = await rawCallTool({
    name: "codex_dashboard_snapshot",
    arguments: {
      ...(options.scopeId ? { scopeId: options.scopeId } : {}),
      widgetInstanceId: `dddddddd-dddd-4ddd-8ddd-${widgetSuffix}`,
      limit: options.limit || 20
    },
    ...(options.metadata ? { _meta: options.metadata } : {})
  });
  expect(result.isError).not.toBe(true);
  const view = result.structuredContent as Record<string, any>;
  expect(validateDashboardViewPrivateMetadata(
    (result as { _meta?: Record<string, unknown> })._meta?.[DASHBOARD_VIEW_METADATA_KEY]
  ).view).toEqual(view);
  return { result, view };
}

function privateActivityView(result: unknown): Record<string, any> {
  const candidate = (result as { _meta?: Record<string, any> } | undefined)
    ?._meta?.[ACTIVITY_VIEW_METADATA_KEY];
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Missing private Activity view metadata: ${JSON.stringify(result)}`);
  }
  return (candidate as { view: Record<string, any> }).view;
}

async function waitForJobStatus(client: Client, jobId: string, expected: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { jobId } })
    );
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job status ${expected}.`);
}
