import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  type Progress
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { HARD_MAX_CONCURRENT_JOBS, loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { projectNameKey } from "../src/projectRegistry.js";
import { SCOPE_ID_PATTERN, SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import {
  ACTIVITY_CARD_CONTRACT_GENERATION,
  ACTIVITY_CARD_URI
} from "../src/activityCard.js";
import {
  SETTINGS_CARD_CONTRACT_GENERATION,
  SETTINGS_CARD_URI
} from "../src/settingsCard.js";
import { CodexJobRegistry } from "../src/tools.js";
import { uiResourceRevisions } from "../src/uiResources.js";
import type {
  CodexBackgroundTerminal,
  CodexInteractionDecision,
  CodexProgress,
  CodexThreadResumeProbe,
  CodexThreadForkRequest,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const UPPERCASE_SCOPE = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
let requestSequence = 0;

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

  async steerThread(threadId: string, prompt: string): Promise<void> {
    this.steeringRequests.push({ threadId, prompt });
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
  public probe: CodexThreadResumeProbe = {
    state: "resumable",
    runtimeStatus: "idle",
    threadId: "thread-1"
  };

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    return { ...this.probe, threadId } as CodexThreadResumeProbe;
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
      "codex_activity_snapshot",
      "codex_activity_update",
      "codex_agent",
      "codex_agent_recovery_detach",
      "codex_background_process_terminate",
      "codex_cancel",
      "codex_interaction_respond",
      "codex_job_steer",
      "codex_models",
      "codex_settings",
      "codex_status",
      "codex_task",
      "codex_update_settings"
    ]);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    for (const tool of tools.tools) {
      expect(tool.outputSchema, `${tool.name} must declare structuredContent`).toMatchObject({
        type: "object"
      });
    }
    expect(byName.get("codex_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    });
    expect(byName.get("codex_status")?.inputSchema).toMatchObject({
      properties: {
        query: {
          oneOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                kind: { type: "string", const: "job" },
                waitFor: { type: "string", enum: ["change", "terminal"], description: expect.any(String) },
                waitMs: expect.objectContaining({ maximum: 60000 })
              })
            }),
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
      .toEqual(["activityId"]);
    expect(byName.get("codex_task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(byName.get("codex_task")?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": ACTIVITY_CARD_URI,
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_activity")?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": ACTIVITY_CARD_URI
    });
    expect(byName.get("codex_task")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        bridgeSession: expect.any(Object),
        bridgeActivity: expect.objectContaining({
          properties: expect.objectContaining({
            shouldRenderActivityCard: { type: "boolean" },
            renderReason: {
              type: "string",
              enum: expect.arrayContaining(["render-retry", "render-latest"])
            }
          })
        })
      }
    });
    for (const activityViewTool of ["codex_activity", "codex_activity_snapshot"]) {
      expect(byName.get(activityViewTool)?.outputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["scopeVersion", "watcherPolicy", "feed"]),
        properties: {
          mountedPresentation: expect.any(Object),
          watcherPolicy: expect.any(Object),
          feed: expect.any(Object)
        }
      });
    }
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
      required: expect.arrayContaining(["requestId", "activityPresentationId", "prompt"])
    });
    expect((byName.get("codex_task")?.inputSchema as any).allOf).toEqual([
      expect.objectContaining({ then: { required: ["project"] } })
    ]);
    expect((byName.get("codex_task")?.inputSchema as { required?: string[] }).required)
      .not.toContain("scopeId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("taskKey");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("cwd");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("threadId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("sessionMode");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("adoptThread");
    expect(byName.get("codex_cancel")?.inputSchema.properties).not.toHaveProperty("scopeId");
    expect(byName.get("codex_cancel")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["requestId", "jobId", "expectedVersion"])
    });
    expect(byName.get("codex_activity_job_cancel")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_task")?.inputSchema.properties).toMatchObject({
      activity: { oneOf: expect.any(Array) },
      activityPresentationId: expect.any(Object),
      agent: { oneOf: expect.any(Array) },
      executionMode: { enum: ["foreground", "background"] },
      requestId: expect.any(Object),
      prompt: expect.any(Object)
    });
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
    expect(taskProperties?.project?.description).toContain("user-defined project name");
    expect(taskProperties?.project?.oneOf?.[0]).toMatchObject({
      required: ["name", "registryRevision"],
      properties: {
        name: { const: "Test Project" },
        registryRevision: { const: 1 }
      }
    });
    for (const variant of taskProperties?.project?.oneOf || []) {
      expect(Object.keys(variant.properties || {}).sort())
        .toEqual(["name", "registryRevision"]);
    }
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
        waitMs: { maximum: 60000 },
        widgetInstanceId: { type: "string", pattern: expect.stringContaining("[0-9a-f]") },
        card: expect.any(Object)
      }
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
      required: expect.arrayContaining(["requestId", "activityId", "expectedVersion"])
    });
    expect(byName.get("codex_settings")?._meta).toMatchObject({
      ui: { resourceUri: SETTINGS_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": SETTINGS_CARD_URI,
      "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_update_settings")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
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
    expect(settingsPatchSchema.properties.projectOperations.items.oneOf.map(
      (variant: any) => variant.properties.kind.const
    )).toEqual(["add", "rename", "relocate", "archive", "restore"]);
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
    expect(discoveryInventory).toMatchInlineSnapshot(`
      [
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
          "schemaBytes": 1613,
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
          "name": "codex_activity",
          "properties": [
            "activityId",
          ],
          "propertyCount": 1,
          "schemaBytes": 327,
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
          "name": "codex_activity_snapshot",
          "properties": [
            "afterVersion",
            "card",
            "limit",
            "scopeId",
            "waitMs",
            "widgetInstanceId",
          ],
          "propertyCount": 6,
          "schemaBytes": 1527,
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
          "schemaBytes": 1037,
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
          "schemaBytes": 1972,
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
            "requestId",
          ],
          "propertyCount": 4,
          "schemaBytes": 853,
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
          "schemaBytes": 2254,
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
          "schemaBytes": 971,
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
          "schemaBytes": 215,
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
          "schemaBytes": 203,
          "visibility": {
            "app": true,
            "model": true,
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
          "name": "codex_update_settings",
          "properties": [
            "expectedRegistryRevision",
            "expectedSettingsRevision",
            "operation",
          ],
          "propertyCount": 3,
          "schemaBytes": 4871,
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
            "activityPresentationId",
            "agent",
            "executionMode",
            "project",
            "prompt",
            "requestId",
            "sandbox",
            "selection",
          ],
          "propertyCount": 9,
          "schemaBytes": 6407,
          "visibility": {
            "app": true,
            "model": true,
            "operatorCapability": false,
          },
        },
      ]
    `);

    await close();
  });

  it("rejects expired runtime fields and malformed presentation inputs at parsing", async () => {
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

    const missingPresentation = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "24242424-0000-4000-8000-000000000003",
        prompt: "current contract without response correlation",
        activity: { mode: "new" },
        agent: { mode: "new" }
      }
    });
    expect(missingPresentation).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "ACTIVITY_PRESENTATION_ID_REQUIRED",
          retryable: true,
          missingFields: ["activityPresentationId"]
        }
      }
    });

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
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

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
    const defaultAgentId = (defaulted as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
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
    const agentId = (named as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
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
    const secondAgentId = (defaultedSecondAgent as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
    expect(jobs.getAgent(secondAgentId)?.agentName)
      .toMatch(/^Codex Agent [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(3);
    await close();
  });

  it("rejects mixed task routing contracts and accepts verified host card correlation", async () => {
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
    expect((hostCorrelated as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: { activityPresentationId: hostPresentationId }
      });
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

  it("serves every retained Settings and Activity UI revision through MCP", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    const listed = await client.listResources();
    const listedUris = new Set(listed.resources.map((resource) => resource.uri));

    for (const [name, currentUri] of [
      ["settings", SETTINGS_CARD_URI],
      ["activity", ACTIVITY_CARD_URI]
    ] as const) {
      const revisions = uiResourceRevisions(name);
      expect(revisions.map((revision) => revision.uri)).toEqual(name === "settings"
        ? [
            "ui://codex-mcp-bridge/settings/ad2c5a241a90.html",
            "ui://codex-mcp-bridge/settings/ad24ba83c693.html",
          ]
        : [
            "ui://codex-mcp-bridge/activity/d7d73c496d9b.html",
            "ui://codex-mcp-bridge/activity/5804dd38e35a.html",
            "ui://codex-mcp-bridge/activity/536d28d41856.html",
            "ui://codex-mcp-bridge/activity/4a8f190de901.html",
            "ui://codex-mcp-bridge/activity/030f9817fd9e.html",
            "ui://codex-mcp-bridge/activity/c06844041247.html",
            "ui://codex-mcp-bridge/activity/ec8bc991267d.html",
            "ui://codex-mcp-bridge/activity/24b062eaa337.html"
          ]);
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
        }
        if (name === "activity" && revision.uri === currentUri) {
          expect(html).toContain('callTool("codex_background_process_terminate"');
          expect(html).toContain('callTool("codex_activity_job_cancel"');
          expect(html).not.toContain('callTool("codex_cancel"');
          expect(html).not.toContain('callTool("codex_agent"');
          expect(html).toContain('callTool("codex_activity_snapshot"');
          expect(html).toContain('callTool("codex_interaction_respond"');
          expect(html).not.toContain('callTool("codex_status",Object.assign({activityView:true');
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
                : SETTINGS_CARD_CONTRACT_GENERATION)
          });
      }
    }

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

  it("projects saved access changes into codex_task risk annotations", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());
    const taskAnnotations = async () =>
      (await client.listTools()).tools.find((entry) => entry.name === "codex_task")?.annotations;

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
      destructiveHint: false,
      openWorldHint: false
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
    const initial = privateSettingsView(initialResult);
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
    expect(saved.isError).not.toBe(true);
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
    const publicSaved = JSON.stringify({
      content: saved.content,
      structuredContent: (saved as { structuredContent?: unknown }).structuredContent
    });
    expect(publicSaved).not.toContain(webProject.id);
    expect(publicSaved).not.toContain(apiProject.id);
    expect(publicSaved).not.toContain(realpathSync(web));
    expect(publicSaved).not.toContain(realpathSync(api));
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
    expect(privateSettingsView(await client.callTool({ name: "codex_settings", arguments: {} }))
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
    await close();
  });

  it("onboards arbitrary PC folders from Settings and preserves them when general defaults are restored", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const opened = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(opened.settings).toMatchObject({
      settingsRevision: 0,
      registryRevision: 0,
      projects: []
    });
    expect(opened.capabilities).not.toHaveProperty("allowedRoots");

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
        projects: beforeReset.projects
      });

    const task = await runTask(client, { prompt: "work here", projectId: "first" });
    expect(task).toMatchObject({ structuredContent: { bridgeActivity: { projectName: "First" } } });
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
    const { client, close } = await connectTestClient(
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
    expect(view.capabilities.projectAvailability).toEqual([
      { name: "Active", available: true, archived: false },
      { name: "Recovery", available: false, archived: false }
    ]);
    expect(JSON.stringify(view.capabilities.projectAvailability)).not.toContain(second);
    expect(JSON.stringify(view.capabilities.projectAvailability)).not.toContain("unavailableReason");
    expect(view.settings.projects).toContainEqual({
      name: "Recovery",
      available: false,
      archived: false
    });
    expect(privateSettingsView(await client.callTool({
      name: "codex_settings",
      arguments: {}
    })).settings.projects).toContainEqual({
      id: expect.stringMatching(SCOPE_ID_PATTERN),
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

  it("refreshes the path-free project descriptor when a saved folder disappears and recovers", async () => {
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
    expect(initial.capabilities.projectAvailability).toEqual([
      { name: "Alpha Workspace", available: true, archived: false }
    ]);
    const initialDescriptor = await taskDescriptor();
    expect(JSON.stringify(initialDescriptor.inputSchema.properties?.project))
      .toContain('"const":"Alpha Workspace"');
    expect(JSON.stringify(initialDescriptor)).not.toContain(realpathSync(project));

    renameSync(project, displaced);
    const unavailable = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unavailable.capabilities.projectAvailability).toEqual([
      { name: "Alpha Workspace", available: false, archived: false }
    ]);
    expect(listChanged).toBe(baselineNotifications + 1);
    const unavailableDescriptor = await taskDescriptor();
    const unavailableSchema = unavailableDescriptor.inputSchema as Record<string, any>;
    expect(JSON.stringify(unavailableSchema.properties?.project))
      .not.toContain('"const":"Alpha Workspace"');
    expect(unavailableSchema.properties?.project).toMatchObject({ not: {} });
    expect(unavailableSchema.allOf).toEqual([
      expect.objectContaining({
        then: expect.objectContaining({ required: expect.arrayContaining(["project"]) })
      })
    ]);
    expect(unavailableDescriptor._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": ACTIVITY_CARD_URI
    });
    expect(unavailableDescriptor.description).toContain("do not use the first-install probe");
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(project);
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(displaced);
    const unavailableStatus = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: {} })
    );
    expect(unavailableStatus.projects).toEqual([
      { projectName: "Alpha Workspace", available: false, archived: false }
    ]);
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
    expect(recovered.capabilities.projectAvailability).toEqual([
      { name: "Alpha Workspace", available: true, archived: false }
    ]);
    expect(listChanged).toBe(baselineNotifications + 2);
    const recoveredDescriptor = await taskDescriptor();
    expect(JSON.stringify(recoveredDescriptor.inputSchema.properties?.project))
      .toContain('"const":"Alpha Workspace"');
    expect(JSON.stringify(recoveredDescriptor.inputSchema.properties?.project))
      .toContain('"title":"Alpha Workspace"');
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
      projects: [{ projectName: "Test Project", available: true, archived: false }],
      modelPolicy: {
        mode: "automatic",
        preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        allowedSelections: { kind: "catalog-visible" }
      },
      usePriorityServiceTier: false,
      codexExecutionDeadline: "none",
      appServerPolicy: {
        experimental: true,
        upstreamProductionSupport: "unsupported",
        rollout: "explicit-opt-in-canary",
        supportedCodexCliVersion: "0.145.0",
        resumeProbe: "thread/read"
      },
      modelCatalogStatus: {
        available: true,
        source: "codex-cli",
        stale: false,
        validation: "valid"
      },
      upstreamPoolSize: 4,
      maxRetainedJobs: 100,
      maxJobResultBytes: 1048576,
      maxConcurrentJobs: 30,
      stateStorage: { backend: "memory", transactional: false },
      concurrencyPolicy: {
        sameWorkingDirectory: {
          readOnly: "allowed",
          workspaceWrite: "allowed",
          dangerFullAccess: "allowed"
        },
        sameThread: "serialized",
        mutationCoordination: "caller-managed"
      },
      sessionPolicy: {
        persistent: false,
        selection: "activity-compatible-only-when-unambiguous",
        implicitNewActivityBehavior: "start-new-thread",
        exactActivityContinuationAgeLimit: "none"
      }
    });
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
    expect(status).toMatchObject({ projects: [] });
    expect(status).not.toHaveProperty("defaultProjectId");
    expect(status).not.toHaveProperty("allowedRootCount");
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
      validatedAt: "2026-08-21T00:00:00.000Z",
      fingerprint: "f".repeat(64),
      validation: "valid"
    });
    expect(result.models.map((entry: { id: string }) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5"
    ]);
    expect(catalog.calls).toEqual([{ refresh: true, backendKind: "mcp-server" }]);

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

  it("projects automatic exact selections, refreshes the next descriptor, and enforces fixed mode", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });

    let task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema).toMatchObject({ additionalProperties: false });
    expect(task.inputSchema.properties).not.toHaveProperty("model");
    expect(task.inputSchema.properties).not.toHaveProperty("reasoningEffort");
    expect(task.inputSchema.properties?.selection).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            model: { const: "gpt-5.6-sol", type: "string" },
            reasoningEffort: expect.objectContaining({
              enum: expect.arrayContaining(["high", "max"])
            })
          }),
          additionalProperties: false
        })
      ])
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
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        policyActivation: {
          policyRevision: 1,
          executionPolicyActive: true,
          schemaRefreshRequested: true,
          schemaRefreshGuaranteed: false
        }
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listChanged).toBeGreaterThan(0);

    task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties).not.toHaveProperty("selection");
    expect(task.inputSchema.properties).not.toHaveProperty("modelPolicyRevision");
    expect(task.inputSchema).toMatchObject({ additionalProperties: false });

    const staleOverride = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "stale override",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    });
    expect(staleOverride.isError).toBe(true);
    expect(staleOverride).toMatchObject({
      structuredContent: {
        error: {
          code: "MODEL_SELECTION_FORBIDDEN",
          policyRevision: 1,
          nextActions: [expect.stringContaining("Omit selection")]
        }
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
        executionDecision: {
          policyRevision: 1,
          effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          source: "fixed"
        }
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
          preferredSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          constraints: { allowDelegation: true }
        }
      }
    });
    task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties?.selection).toMatchObject({
      oneOf: [{
        properties: {
          model: { const: "gpt-5.6-terra" },
          reasoningEffort: { const: "high" }
        },
        additionalProperties: false
      }]
    });

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
    const selectionSchema = task.inputSchema.properties?.selection as {
      oneOf?: Array<{ properties?: Record<string, { const?: string }> }>;
    };
    expect(JSON.stringify(selectionSchema)).not.toContain("serviceTier");
    expect(selectionSchema.oneOf).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          model: expect.objectContaining({ const: "gpt-5.6-sol" }),
          reasoningEffort: expect.objectContaining({
            enum: expect.arrayContaining(["high", "max"])
          })
        })
      })
    ]);

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
    expect((settings as { structuredContent?: Record<string, any> }).structuredContent?.settings)
      .toMatchObject({ settingsRevision: 2, usePriorityServiceTier: false });
    await close();
  });

  it("revalidates a stale descriptor against catalog drift at runtime", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      new DriftingModelCatalog()
    );
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(JSON.stringify(task.inputSchema)).toContain("gpt-5.6-terra");

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
          code: "MODEL_UNAVAILABLE",
          policyRevision: 0,
          nextActions: expect.any(Array)
        }
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
          preferredSelection: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
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
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings)
      .toMatchObject({ settingsRevision: 1, modelPolicy: { mode: "automatic" } });

    const task = await runTask(client, { prompt: "use surviving selection", sessionMode: "new" });
    expect((task as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        executionDecision: {
          source: "backend-default",
          effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
        }
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
      prompt: "fixed selection removed",
      agentName: "Fallback Agent",
      contextMode: "fresh"
    });
    expect((task as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      executionDecision: {
        policyRevision: 1,
        source: "compatibility-fallback",
        savedSelectionSupported: false,
        effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        effectiveReasoningEffort: "max",
        preferenceWarning: expect.stringContaining("unsupported by the current catalog")
      }
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
    const task = await runTask(client, { prompt: "catalog required", sessionMode: "new" });
    expect(task).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "MODEL_UNAVAILABLE", policyRevision: 0 }
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
        error: { code: "MODEL_UNAVAILABLE", policyRevision: 0 }
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
    expect(status).toMatchObject({
      settingsRevision: 0,
      modelPolicy: { mode: "automatic" }
    });
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
      settings: {
        schemaVersion: 2,
        settingsRevision: 0,
        registryRevision: 1,
        accessStrategy: "adaptive",
        modelPolicy: {
          mode: "automatic",
          preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          allowedSelections: { kind: "catalog-visible" }
        },
        projects: [{ name: "Test Project", available: true, archived: false }],
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      },
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
    expect(privateSettingsView(opened).settings).toMatchObject({
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
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings).toMatchObject({
      settingsRevision: 1,
      accessStrategy: "always-full",
      modelPolicy: {
        mode: "fixed",
        selection: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      },
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12,
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

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "use saved defaults", agentName: "Saved Defaults", contextMode: "fresh" }
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
    expect(status).toMatchObject({
      accessStrategy: "always-full",
      defaultSandbox: "danger-full-access",
      uiLocalePreference: "ko",
      codexExecutionDeadline: "none",
      maxConcurrentJobs: 12,
      settingsPolicy: { revision: 1, scope: "shared-bridge-instance" }
    });
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
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings)
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
    expect((reset as { structuredContent?: Record<string, any> }).structuredContent?.settings)
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
    const unchangedPolicy = {
      mode: "automatic" as const,
      allowedSelections: { kind: "catalog-visible" as const },
      constraints: { allowDelegation: true }
    };
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        uiLocalePreference: "ko",
        modelPolicy: unchangedPolicy
      }
    });
    expect(saved.isError).not.toBe(true);
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings)
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

    const alwaysForeground = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "discuss with a visible card",
        sessionMode: "new",
        activityKind: "discussion",
        executionMode: "foreground"
      }
    });
    expect((alwaysForeground as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: {
          executionMode: "foreground",
          activityCardVisibility: "always",
          shouldRenderActivityCard: true,
          renderTiming: "after-result-or-existing-mounted-card"
        }
      });

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, activityCardVisibility: "background-only" }
    });
    const backgroundOnlyTools = await client.listTools();
    expect(backgroundOnlyTools.tools.find((tool) => tool.name === "codex_task")?._meta)
      .toMatchObject({ "openai/outputTemplate": ACTIVITY_CARD_URI });
    const groupedPresentation = "24242424-0000-4000-8000-000000000010";
    const backgroundOnlyForeground = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "foreground without automatic card",
        sessionMode: "new",
        executionMode: "foreground",
        activityPresentationId: groupedPresentation
      }
    });
    expect((backgroundOnlyForeground as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeActivity: { shouldRenderActivityCard: false } });

    const backgroundOnlyBackground = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "background with automatic card",
        sessionMode: "new",
        activityPresentationId: groupedPresentation
      }
    }));
    expect(backgroundOnlyBackground).toMatchObject({
      status: "running",
      executionMode: "background",
      bridgeActivity: {
        activityCardVisibility: "background-only",
        shouldRenderActivityCard: true,
        activityPresentationId: groupedPresentation,
        renderTiming: "immediate"
      }
    });
    const groupedBackgroundDuplicate = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "same response second background call",
        sessionMode: "new",
        activityPresentationId: groupedPresentation
      }
    }));
    expect(groupedBackgroundDuplicate.bridgeActivity).toMatchObject({
      activityPresentationId: groupedPresentation,
      shouldRenderActivityCard: true,
      renderReason: "render-latest"
    });

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, activityCardVisibility: "never", completionHandoff: "off" }
    });
    const neverTools = await client.listTools();
    expect(neverTools.tools.find((tool) => tool.name === "codex_task")?._meta)
      .toBeUndefined();
    const neverTaskDescriptor = neverTools.tools.find((tool) => tool.name === "codex_task");
    expect((neverTaskDescriptor?.inputSchema as { required?: string[] }).required)
      .not.toContain("activityPresentationId");
    const neverBackground = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "background without automatic card",
        sessionMode: "new",
        activityPresentationId: "24242424-0000-4000-8000-000000000011"
      }
    }));
    expect(neverBackground.bridgeActivity).toMatchObject({
      activityCardVisibility: "never",
      shouldRenderActivityCard: false,
      explicitRenderAllowed: true
    });
    const neverWithoutPresentation = parseToolJson(await rawCallTool({
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
    }));
    expect(neverWithoutPresentation.bridgeActivity).toMatchObject({
      activityCardVisibility: "never",
      shouldRenderActivityCard: false,
      renderReason: "visibility-disabled"
    });
    const explicitCard = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A }
    });
    expect((explicitCard as { structuredContent?: Record<string, any> }).structuredContent)
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
      .toMatchObject({ "openai/outputTemplate": ACTIVITY_CARD_URI });
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

  it("hides per-call sandbox in fixed access modes and rejects stale fixed-mode overrides", async () => {
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
    expect(task.inputSchema.properties).not.toHaveProperty("sandbox");
    expect(task.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    });
    const staleReadOverride = await readClient.client.callTool({
      name: "codex_task",
      arguments: { prompt: "stale override", sandbox: "read-only" }
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
    expect(task.inputSchema.properties).not.toHaveProperty("sandbox");
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

  it("projects and enforces the immutable exact operator model ceiling", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING:
        '[{"model":"gpt-5.6-sol","reasoningEffort":"max"}]'
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());
    const task = (await client.listTools()).tools.find((entry) => entry.name === "codex_task")!;
    expect(task.inputSchema.properties?.selection).toMatchObject({
      oneOf: [{
        properties: {
          model: { const: "gpt-5.6-sol" },
          reasoningEffort: { const: "max" }
        },
        additionalProperties: false
      }]
    });
    const settings = await client.callTool({ name: "codex_settings", arguments: {} });
    expect((settings as { structuredContent?: Record<string, any> }).structuredContent)
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
    expect(JSON.stringify(widened)).toContain("MODEL_SELECTION_FORBIDDEN");
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

    const first = parseToolJson(await client.callTool({
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
    }));
    expect(first).toMatchObject({
      status: "running",
      async: true,
      executionMode: "background",
      activityTracking: {
        statusTool: "codex_status",
        automaticRenderTool: "codex_task",
        explicitRenderTool: "codex_activity",
        followUpRenderRequired: false,
        renderToolAvailable: true
      }
    });
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
    expect(updatedPolicy.activity).toMatchObject({ handoffPolicy: "notify" });

    const completed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: updatedPolicy.activity.version,
        operation: {
          kind: "complete",
          reason: "The orchestrator accepted both investigation results"
        }
      }
    }));
    expect(completed).toMatchObject({
      action: "complete",
      activity: { lifecycle: "completed", waitingOn: "none", completionVersion: 1 },
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
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
    const firstStructured = (first as { structuredContent?: Record<string, any> }).structuredContent!;
    const sourceActivityId = firstStructured.bridgeActivity.activityId;
    const agentId = firstStructured.bridgeActivity.agentId;
    expect(firstStructured.threadId).toBe("thread-1");
    expect(firstStructured.bridgeActivity).toMatchObject({
      projectName: "Test Project"
    });
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
    const linkedStructured = (linked as { structuredContent?: Record<string, any> }).structuredContent!;
    const linkedActivityId = linkedStructured.bridgeActivity.activityId;
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
    expect((forked as { structuredContent?: Record<string, any> }).structuredContent?.threadId)
      .toBe("thread-forked");
    expect((forked as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity)
      .toMatchObject({ projectName: "Test Project" });
    expect(upstream.calls[2]).toMatchObject({
      name: "codex-fork",
      args: { threadId: "thread-1", prompt: "independently verify the approach" }
    });
    const forkRetry = await runTask(client, {
      ...forkArguments,
      activityPresentationId: "36363636-3636-4636-8636-363636363636"
    });
    expect((forkRetry as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        threadId: "thread-forked",
        bridgeActivity: {
          activityId: linkedActivityId,
          jobId: (forked as { structuredContent?: Record<string, any> })
            .structuredContent?.bridgeActivity.jobId
        }
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
    expect(handedOff).toMatchObject({
      structuredContent: {
        threadId: "thread-1",
        bridgeSession: {
          handoff: {
            sourceBackend: "mcp-server",
            targetBackend: "app-server",
            sourceThreadId: "mcp-thread",
            continuity: "explicit-summary-only",
            summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
          }
        }
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
      forceStop: { tool: "codex_cancel", arguments: { jobId: started.jobId } },
      warning: expect.stringContaining("does not roll back filesystem changes")
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
      agent: { agentId, agentName: "Renamed Agent", threadHistoryCount: 1 },
      historyPreserved: true,
      deletionPerformed: false
    });
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
    expect(archived).toMatchObject({ ok: true, agent: { agentId, lifecycle: "archived" } });
    expect(upstream.archivedThreads).toEqual([]);
    const card = await client.callTool({ name: "codex_activity", arguments: {} });
    const cardView = (card as { structuredContent?: Record<string, any> }).structuredContent!;
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
      agent: { agentId, agentName: "Renamed Agent", lifecycle: "idle", threadHistoryCount: 1 }
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
      agent: { agentId: sourceAgent.agentId, lifecycle: "archived", threadHistoryCount: 1 }
    });
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
      agent: { agentId: sourceAgent.agentId, lifecycle: "idle", threadHistoryCount: 1 }
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
    const { client, jobs, close } = await connectTestClient(
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
    const agentId = (completedResult as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
    const activityId = (completedResult as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId as string;
    expect(agentId).toEqual(expect.any(String));

    const widgetSessionId = "71717171-7171-4171-8171-717171717171";
    const card = await client.callTool({
      name: "codex_activity",
      arguments: { activityId },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    });
    const view = (card as { structuredContent?: Record<string, any> }).structuredContent!;
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
      code: "AGENT_BACKGROUND_PROCESS",
      backgroundProcesses: [
        { processId: "background-process-1" },
        { processId: "legacy-background-process-2" }
      ]
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
    expect((after as { structuredContent?: Record<string, any> }).structuredContent?.agents)
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

  it("projects only allowed interaction decisions and clears server-resolved requests from Activity state", async () => {
    const root = temporaryRoot();
    const upstream = new InteractionUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "wait for interactions",
        agentName: "Interaction Agent",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    const widgetSessionId = "widget-interaction";
    const card = {
      activityId: started.activityId,
      generation: started.bridgeActivity.cardGeneration,
      presentation: {
        kind: "automatic" as const,
        activityPresentationId: started.activityPresentationId
      }
    };
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
    expect((result as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      threadId: "discussion-thread",
      bridgeActivity: {
        activityId: expect.stringMatching(SCOPE_ID_PATTERN),
        jobId: expect.stringMatching(SCOPE_ID_PATTERN),
        executionMode: "foreground"
      }
    });
    const activityId = (result as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId;
    expect(jobs.getActivity(activityId)).toMatchObject({
      kind: "discussion",
      lifecycle: "open",
      waitingOn: "orchestrator",
      counts: { completed: 1 }
    });
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
    const activityId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId;
    const jobId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.jobId;
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
    expect(sealed.activity).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "verification",
      verification: "pending",
      completionVersion: 1
    });
    const pendingVerificationView = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    expect((pendingVerificationView as { structuredContent?: Record<string, any> })
      .structuredContent?.feed).toMatchObject({
        activeCount: 1,
        active: [expect.objectContaining({ activityId, displayState: "verification" })],
        completed: { agentCount: 0, activityCount: 0 }
      });
    const illegalComplete = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.activity.version,
        operation: { kind: "complete" }
      }
    });
    expect(illegalComplete.isError).toBe(true);
    expect(JSON.stringify(illegalComplete)).toContain("Finish Activity verification");

    const missingFailureReason = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.activity.version,
        operation: { kind: "verification-failed" }
      }
    });
    expect(missingFailureReason.isError).toBe(true);
    const missingEvidence = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.activity.version,
        operation: { kind: "verification-passed" }
      }
    });
    expect(missingEvidence.isError).toBe(true);
    const failed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: sealed.activity.version,
        operation: {
          kind: "verification-failed",
          reason: "The first independent review found a gap"
        }
      }
    }));
    expect(failed.activity).toMatchObject({ lifecycle: "open", verification: "failed" });

    const verifying = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: failed.activity.version,
        operation: { kind: "start-verification" }
      }
    }));
    expect(verifying.activity).toMatchObject({ verification: "verifying" });
    const passed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        expectedVersion: verifying.activity.version,
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
    expect(passed.activity).toMatchObject({
      lifecycle: "completed",
      verification: "verified",
      waitingOn: "none"
    });
    const verifiedView = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    expect((verifiedView as { structuredContent?: Record<string, any> })
      .structuredContent?.feed).toMatchObject({
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
    expect(abandoned.activity).toMatchObject({ lifecycle: "abandoned" });
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
    const stale = await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        requestId: "62626262-6262-4262-8262-626262626262",
        activityId: running.activityId,
        expectedVersion: activityVersion + 1
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
        expectedVersion: activityVersion
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
      activity: {
        lifecycle: "cancelled",
        waitingOn: "none",
        counts: { running: 0, cancelled: 1, terminal: 1 }
      },
      cancelledJobIds: [running.jobId]
    });
    expect(cancelled.warning).toContain("not rolled back");
    expect(upstream.aborts).toBe(1);
    expect(jobs.get(running.jobId)).toMatchObject({
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      cancellationIntentId: expect.any(String)
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
      session: { threadId: "app-thread-1", backendKind: "app-server" },
      turns: [expect.objectContaining({ jobId: first.jobId, turnId: "app-turn-1", status: "running" })]
    });

    const stopped = parseToolJson(await client.callTool({
      name: "codex_activity_cancel",
      arguments: {
        requestId: "64646464-6464-4464-8464-646464646464",
        activityId: first.activityId,
        expectedVersion: jobs.getActivity(first.activityId)?.version,
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
      activity: { lifecycle: "cancelled", counts: { cancelled: 2, running: 0 } },
      cancelledJobIds: expect.arrayContaining(affected),
      collateralJobIds: []
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
    const { client, close } = await connectTestClient(config, upstream);

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
        error: { code: "MODEL_UNAVAILABLE", policyRevision: 0 }
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
    const { client, close } = await connectTestClient(config, upstream);

    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "hold admission decision", sessionMode: "new" }
    }));
    expect(running.executionDecision).toMatchObject({
      policyRevision: 0,
      effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      source: "preferred"
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
    const completed = await waitForJobStatus(client, running.jobId, "completed");
    expect(completed.executionDecision).toMatchObject({
      policyRevision: 0,
      effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      source: "preferred"
    });
    await close();
  });

  it("records requested, effective, accepted, and rerouted execution metadata without prompt text", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
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
    expect(status.executionAudit).toMatchObject({
      requested: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      actual: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      evidence: {
        model: "model/rerouted",
        reasoningEffort: "turn/start-accepted",
        actualEffortRuntimeOverrideReported: false
      },
      reroute: {
        fromModel: "gpt-5.6-terra",
        toModel: "gpt-5.6-sol",
        reason: "fixture-policy"
      }
    });
    expect(JSON.stringify(status.executionAudit)).not.toContain("PRIVATE_AUDIT_PROMPT");
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
      upstreamError: {
        code: "CONTEXT_WINDOW_EXCEEDED",
        retryable: true,
        upstreamKind: "contextWindowExceeded"
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
        executionAudit: expect.any(Object)
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
      error: expect.stringContaining("worker crashed")
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
    expect(resumed).toMatchObject({
      structuredContent: {
        threadId: "bridge-crash-thread",
        bridgeActivity: { agentId: first.agentId }
      }
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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;

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
      const rejected = await client.callTool({ name: "codex_task", arguments: arguments_ });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "THREAD_OVERRIDE_UNSUPPORTED", policyRevision: 1 }
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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;
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
        executionDecision: {
          policyRevision: 1,
          effectiveSelection: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          appliedAt: "turn-start"
        },
        executionAudit: {
          effective: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          actual: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          evidence: { model: "bridge-dispatch", reasoningEffort: "bridge-dispatch" }
        }
      });
    expect((started as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        executionAudit: {
          effective: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          actual: { model: "gpt-5.6-sol", reasoningEffort: "max" }
        }
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
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const first = await runTask(client, { prompt: "first" });
    const activityId = taskActivityId(first);
    await runTask(client, { prompt: "follow up", activityId });

    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "follow up", _bridgeBackendKind: "mcp-server" }
    });
    expect(taskSession(first)).toMatchObject({ action: "start", reason: "activity-new" });
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
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);
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
    const derivedScope = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeSession?.scopeId;
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
    const startedStructured = (started as { structuredContent?: Record<string, any> }).structuredContent!;
    const retriedStructured = (retriedWithIgnoredInput as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(retriedStructured).toMatchObject({
      threadId: startedStructured.threadId,
      bridgeActivity: {
        activityId: startedStructured.bridgeActivity.activityId,
        jobId: startedStructured.bridgeActivity.jobId,
        agentId: startedStructured.bridgeActivity.agentId,
        cardGeneration: 1,
        shouldRenderActivityCard: true,
        renderReason: "render-retry"
      },
      bridgeSession: startedStructured.bridgeSession,
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
          id: (started as { structuredContent?: Record<string, any> }).structuredContent
            ?.bridgeActivity?.activityId
        }
      },
      _meta: { ...metadataA, "codex/activityPresentationId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
    });
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeSession: {
          scopeId: derivedScope,
          action: "continue",
          threadId: "thread-1"
        }
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

    expect(statusA.scopeView).toEqual({
      mode: "scoped",
      scopeId: derivedScope,
      source: "host-metadata",
      keyVersion: 1,
      explicitInputIgnored: false
    });
    expect(statusA.scopeCounts).toMatchObject({ sessions: 1, jobs: 2 });
    expect(statusB.scopeCounts).toMatchObject({ sessions: 0, jobs: 0 });
    expect(explicitIgnored.scopeView).toMatchObject({
      scopeId: derivedScope,
      source: "host-metadata",
      explicitInputIgnored: true
    });
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
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);

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
    expect((compatible as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeSession: { scopeId: SCOPE_A } });
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
        expectedVersion: currentVersion
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
          expectedVersion: currentVersion
        },
        _meta: metadata
      })
    );
    expect(cancelled.status).toBe("cancelled");
    await close();
  });

  it("normalizes UUID casing before routing sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const started = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: UPPERCASE_SCOPE,
        prompt: "start",
        sessionMode: "new"
      }
    });
    expect((started as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      bridgeSession: { scopeId: UPPERCASE_SCOPE.toLowerCase() }
    });
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { scopeId: UPPERCASE_SCOPE.toLowerCase() }
      })
    );
    expect(status.sessions).toHaveLength(1);
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
    const planAgentId = (plan as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;
    const build = await runTask(client, {
      prompt: "build",
      agentName: "Builder",
      contextMode: "fresh",
      activityId
    });
    const buildAgentId = (build as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;
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

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: arguments_ })
    );
    const retry = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: arguments_ })
    );
    expect(retry.jobId).toBe(first.jobId);
    expect(retry.activityId).toBe(first.activityId);
    expect(first.bridgeActivity).toMatchObject({
      activityPresentationId: requestId,
      shouldRenderActivityCard: true,
      renderReason: "new-presentation"
    });
    expect(retry.bridgeActivity).toMatchObject({
      activityPresentationId: requestId,
      shouldRenderActivityCard: true,
      renderReason: "render-retry"
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
    const omittedPresentation = await rawCallTool({
      name: "codex_task",
      arguments: { ...arguments_ }
    });
    expect(omittedPresentation).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "ACTIVITY_PRESENTATION_ID_REQUIRED" }
      }
    });

    upstream.resolveNext(fakeCodexResult("deduped-thread"));
    await waitForJobStatus(client, first.jobId, "completed");
    const completedRetry = await client.callTool({ name: "codex_task", arguments: arguments_ });
    expect(
      (completedRetry as { structuredContent?: Record<string, any> }).structuredContent
    ).toMatchObject({
      threadId: "deduped-thread",
      bridgeSession: { scopeId: SCOPE_A, requestId },
      bridgeActivity: {
        activityId: first.activityId,
        jobId: first.jobId,
        executionMode: "background",
        shouldRenderActivityCard: true,
        renderReason: "render-retry"
      }
    });
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
      requestHashVersion: 5,
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
    expect((retry as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: {
          activityId: (first as { structuredContent?: Record<string, any> })
            .structuredContent?.bridgeActivity.activityId,
          jobId: admitted!.jobId
        }
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
    const { rawCallTool, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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

    const firstStructured = (first as { structuredContent?: Record<string, any> }).structuredContent!;
    const retryStructured = (retry as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(retryStructured.bridgeActivity).toMatchObject({
      activityId: firstStructured.bridgeActivity.activityId,
      jobId: firstStructured.bridgeActivity.jobId,
      executionMode: "background"
    });
    expect(retryStructured.bridgeSession).toMatchObject({
      scopeId: SCOPE_A,
      requestId: arguments_.requestId
    });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("retires low-level thread adoption and preserves scope-local Agent ownership", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
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
    expect(statusA.sessions).toEqual([
      expect.objectContaining({ threadId: "thread-1", scopeId: SCOPE_A })
    ]);
    expect(statusB.sessions).toEqual([]);
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

    expect(statusA.sessions.map((session: { threadId: string }) => session.threadId)).toEqual([
      "thread-1"
    ]);
    expect(statusB.sessions.map((session: { threadId: string }) => session.threadId)).toEqual([
      "thread-2"
    ]);
    expect(policyOnly).toMatchObject({
      scopeView: {
        mode: "policy-only",
        hostMetadataOrCompatibilityScopeRequiredForDetails: true
      },
      sessions: [],
      jobs: []
    });
    expect(audit.sessions).toHaveLength(2);
    expect(audit.jobs).toHaveLength(2);
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
    expect(firstSessions.pagination).toMatchObject({
      offset: 0, returned: 10, total: 14, hasMore: true, nextOffset: 10
    });
    expect(secondSessions.items).toHaveLength(4);
    expect(secondSessions.pagination).toMatchObject({
      offset: 10, returned: 4, total: 14, hasMore: false, nextOffset: null
    });
    expect(firstJobs.items).toHaveLength(2);
    expect(firstJobs.pagination).toMatchObject({
      offset: 0, returned: 2, total: 3, hasMore: true, nextOffset: 2
    });
    expect(secondJobs.items).toHaveLength(1);
    expect(secondJobs.pagination).toMatchObject({
      offset: 2, returned: 1, total: 3, hasMore: false, nextOffset: null
    });
    const compactJobs = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "page", collection: "jobs", limit: 2 } }
      })
    );
    expect(Object.keys(compactJobs).sort()).toEqual([
      "items",
      "pagination",
      "query",
      "scopeCounts",
      "scopeView"
    ]);
    expect(compactJobs).toMatchObject({
      query: { kind: "page", collection: "jobs" },
      pagination: { offset: 0, returned: 2, total: 3, hasMore: true },
      items: [expect.objectContaining({ scopeId: SCOPE_A }), expect.objectContaining({ scopeId: SCOPE_A })]
    });
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
      pagination: { offset: 2, returned: 1, total: 3, hasMore: false },
      items: [expect.objectContaining({ scopeId: SCOPE_A })]
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
    const first = (firstResult as { structuredContent?: Record<string, any> }).structuredContent
      ?.bridgeActivity;
    const agentId = first.agentId;
    const secondResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "reuse the thread for a separate intent",
        activity: { mode: "new", title: "Second Activity" },
        agent: { mode: "existing", id: agentId, context: "continue" }
      }
    });
    const second = (secondResult as { structuredContent?: Record<string, any> }).structuredContent
      ?.bridgeActivity;
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
      threadId: "thread-1",
      session: { threadId: "thread-1" }
    });
    const firstActivityDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "activity", id: first.activityId } }
    }));
    expect(firstActivityDetail).toMatchObject({
      activity: { activityId: first.activityId },
      jobs: [expect.objectContaining({ jobId: first.jobId })]
    });
    const mixedContract = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: first.jobId },
        jobId: first.jobId
      }
    });
    expect(mixedContract.isError).toBe(true);
    expect(JSON.stringify(mixedContract)).toContain("Unrecognized key");
    expect(detail.turns).toEqual([
      expect.objectContaining({ jobId: first.jobId, turnId: null, status: "completed" }),
      expect.objectContaining({ jobId: second.jobId, turnId: null, status: "completed" })
    ]);
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
    const initial = (rendered as { structuredContent?: Record<string, any> }).structuredContent!;
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
    expect((completed as { structuredContent?: Record<string, any> })
      .structuredContent?.feed.active[0].agents[0].execution).toEqual({
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
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "finish after the Activity-card watcher detaches",
        executionMode: "background"
      }
    }));
    await expect.poll(() => upstream.calls.length).toBe(1);
    const running = jobs.get(started.jobId)!;
    expect(running).toMatchObject({ status: "running" });

    const widgetInstanceId = "widget-watch-abort";
    const card = {
      activityId: started.activityId,
      generation: started.bridgeActivity.cardGeneration,
      presentation: {
        kind: "automatic" as const,
        activityPresentationId: started.bridgeActivity.activityPresentationId
      }
    };
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

  it("deduplicates parallel Agents by one response presentation and keeps explicit cards distinct", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);
    const activityPresentationId = "24242424-2424-4424-8424-242424242424";
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "first Agent",
        activityPresentationId,
        agentName: "Card Agent One",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    expect(first.bridgeActivity).toMatchObject({
      shouldRenderActivityCard: true,
      renderReason: "new-presentation",
      cardGeneration: 1,
      activityPresentationId
    });

    const automaticCard = {
      activityId: first.activityId,
      generation: 1,
      presentation: {
        kind: "automatic" as const,
        activityPresentationId,
        reservationOwnerId: first.jobId
      }
    };
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
        reservationOwnerId: first.jobId
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

    const parallel = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel Agent",
        activityPresentationId,
        activityId: first.activityId,
        agentName: "Card Agent Two",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    expect(parallel.bridgeActivity).toMatchObject({
      activityId: first.activityId,
      cardGeneration: 1,
      shouldRenderActivityCard: true,
      renderReason: "render-latest"
    });

    const differentActivity = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "different Activity in the same assistant response",
        activityPresentationId,
        agentName: "Card Agent Three",
        contextMode: "fresh",
        executionMode: "background"
      }
    }));
    expect(differentActivity.activityId).not.toBe(first.activityId);
    expect(differentActivity.bridgeActivity).toMatchObject({
      activityPresentationId,
      shouldRenderActivityCard: true,
      renderReason: "render-latest"
    });

    const explicit = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        activityId: first.activityId
      },
      _meta: { "openai/widgetSessionId": "explicit-card" }
    });
    expect((explicit as { structuredContent?: Record<string, any> }).structuredContent?.presentation)
      .toMatchObject({
        shouldRenderActivityCard: true,
        renderReason: "explicit",
        presentationKind: "explicit"
      });
    expect((explicit as { structuredContent?: Record<string, any> }).structuredContent?.watcherPolicy)
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
    const nextResponse = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "same Activity in the next assistant response",
        activityId: first.activityId,
        agentId: first.agentId,
        contextMode: "continue",
        executionMode: "background",
        activityPresentationId: nextPresentationId
      }
    }));
    expect(nextResponse.bridgeActivity).toMatchObject({
      activityId: first.activityId,
      cardGeneration: 1,
      activityPresentationId: nextPresentationId,
      shouldRenderActivityCard: true,
      renderReason: "new-presentation"
    });
    await rawCallTool({
      name: "codex_activity_snapshot",
      arguments: {
        scopeId: SCOPE_A,
        card: {
          activityId: nextResponse.activityId,
          generation: nextResponse.bridgeActivity.cardGeneration,
          presentation: {
            kind: "automatic",
            activityPresentationId: nextPresentationId,
            reservationOwnerId: nextResponse.jobId
          }
        }
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

  it("requires a live private card proof and audits exact caller and target presentations", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const targetPresentationId = "81818181-8181-4181-8181-818181818181";
    const callerPresentationId = "82828282-8282-4282-8282-828282828282";
    const supersedingPresentationId = "83838383-8383-4383-8383-838383838383";
    const widgetInstanceId = "84848484-8484-4484-8484-848484848484";
    const cancellationRequestId = "85858585-8585-4585-8585-858585858585";
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "cancel from the exact mounted card",
        sessionMode: "new",
        executionMode: "background",
        activityPresentationId: targetPresentationId
      }
    }));
    await Promise.resolve();
    jobs.activityCardRenderHint(
      started.activityId,
      "background",
      undefined,
      { activityPresentationId: callerPresentationId }
    );
    const card = {
      activityId: started.activityId,
      generation: jobs.getActivity(started.activityId)?.cardGeneration as number,
      presentation: {
        kind: "automatic" as const,
        activityPresentationId: callerPresentationId
      }
    };
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
          presentationId: targetPresentationId
        },
        widgetProof: { present: true, cardGeneration: card.generation }
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
      targetPresentationId,
      widgetInstancePresent: true,
      cardGeneration: card.generation
    });
    expect(intent.widgetInstanceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.widgetInstanceDigest).not.toBe(widgetInstanceId);

    jobs.activityCardRenderHint(
      started.activityId,
      "background",
      undefined,
      { activityPresentationId: supersedingPresentationId }
    );
    jobs.touchActivityCardLease(
      SCOPE_A,
      started.activityId,
      card.generation,
      "superseding-widget",
      { kind: "automatic", activityPresentationId: supersedingPresentationId }
    );
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
      const activity = (result as { structuredContent?: Record<string, any> }).structuredContent
        ?.bridgeActivity;
      await client.callTool({
        name: "codex_activity_update",
        arguments: {
          activityId: activity.activityId,
          expectedVersion: jobs.getActivity(activity.activityId)?.version,
          operation: { kind: "seal" }
        }
      });
      return activity;
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
    expect((explicitView as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        pendingHandoffs: [],
        watcherPolicy: { presentationKind: "explicit", ownsCompletionHandoff: false }
      });
    const card = {
      activityId: secondActivity.activityId,
      generation: secondActivity.cardGeneration,
      presentation: {
        kind: "automatic" as const,
        activityPresentationId: secondActivity.activityPresentationId
      }
    };
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
      activityPresentationId: secondActivity.activityPresentationId
    };
    await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: secondActivity.activityId,
        cardGeneration: secondActivity.cardGeneration,
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
    const cardView = (card as { structuredContent?: Record<string, any> }).structuredContent!;
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
      const activityId = (result as { structuredContent?: Record<string, any> })
        .structuredContent?.bridgeActivity?.activityId;
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
    const historyView = (historyCard as { structuredContent?: Record<string, any> }).structuredContent!;
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
    const startedView = (started as { structuredContent?: Record<string, any> })
      .structuredContent!;
    const activityId = startedView.bridgeActivity.activityId as string;
    const agentId = startedView.bridgeActivity.agentId as string;
    expect(startedView.bridgeActivity).toMatchObject({ projectName: "Test Project" });

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
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeActivity: { projectName: "Test Project" } });

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

  it("fails closed at runtime for a stale registry descriptor without admitting side effects", async () => {
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
    const { rawCallTool, jobs, settings, close } = await connectTestClient(
      configFor(root),
      upstream,
      undefined,
      catalog
    );
    const project = settings.current.projects[0];
    catalog.beforeGet = () => settings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: project.id, name: "Renamed During Admission" }],
      undefined,
      1
    );

    const raced = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "95959595-9595-4595-8595-959595959595",
        activityPresentationId: "96969696-9696-4696-8696-969696969696",
        prompt: "race the registry immediately before admission",
        project: { name: "Test Project", registryRevision: 1 },
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
    const agentId = (seeded as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
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
    expect(descriptorJson).toContain('"const":"알파 저장소"');
    expect(descriptorJson).toContain('"registryRevision":{"const":1}');
    expect(descriptorJson).toContain('"const":"Beta Workspace"');
    expect(descriptorJson).toContain('"title":"Beta Workspace"');
    expect(descriptorJson).not.toContain(firstCwd);
    expect(descriptorJson).not.toContain(secondCwd);

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
      project: { name: "알파 저장소", registryRevision: 1 },
      agentName: "Alpha Agent",
      contextMode: "fresh"
    });
    const alphaStructured = (alpha as { structuredContent?: Record<string, any> }).structuredContent!;
    const alphaActivityId = alphaStructured.bridgeActivity.activityId as string;
    const alphaAgentId = alphaStructured.bridgeActivity.agentId as string;
    const alphaProject = settings.current.projects.find((project) => project.name === "알파 저장소")!;
    expect(alphaStructured).toMatchObject({
      bridgeActivity: { projectName: "알파 저장소" },
      bridgeSession: { projectName: "알파 저장소" }
    });
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
      project: { name: "알파 저장소", registryRevision: 1 },
      activityId: alphaActivityId,
      agentName: "Second Alpha Agent",
      contextMode: "fresh"
    });
    expect((inherited as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeActivity: { projectName: "알파 저장소" } });
    expect(upstream.calls[1]?.args.cwd).toBe(firstCwd);

    const conflict = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must not switch repositories",
        activityId: alphaActivityId,
        agentId: alphaAgentId,
        contextMode: "continue",
        project: { name: "Beta Workspace", registryRevision: 1 }
      }
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("PROJECT_CONTEXT_CONFLICT");

    const linkedBeta = await runTask(client, {
      prompt: "continue the goal with fresh beta context",
      project: { name: "Beta Workspace", registryRevision: 1 },
      continuationOfActivityId: alphaActivityId,
      agentName: "Linked Beta Agent",
      contextMode: "fresh"
    });
    expect((linkedBeta as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: { projectName: "Beta Workspace" },
        bridgeSession: { projectName: "Beta Workspace" }
      });
    expect(upstream.calls[2]?.args.cwd).toBe(secondCwd);
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.projects).toEqual([
      { projectName: "알파 저장소", available: true, archived: false },
      { projectName: "Beta Workspace", available: true, archived: false }
    ]);
    expect(JSON.stringify(status)).not.toContain(firstCwd);
    expect(JSON.stringify(status)).not.toContain(secondCwd);
    const activityCard = await client.callTool({ name: "codex_activity", arguments: {} });
    expect(new Set(
      ((activityCard as { structuredContent?: Record<string, any> }).structuredContent?.feed.active || [])
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
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeSession: { projectName: "알파 저장소" } });
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
        project: { name: "알파 저장소", registryRevision: 2 }
      }
    });
    expect(removedFresh.isError).toBe(true);
    expect(JSON.stringify(removedFresh)).toContain("PROJECT_NOT_FOUND");
    expect(upstream.calls).toHaveLength(4);
    const removed = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "new work cannot use a removed project",
        project: { name: "알파 저장소", registryRevision: 2 },
        agentName: "Removed Project Agent",
        contextMode: "fresh"
      }
    });
    expect(removed.isError).toBe(true);
    expect(JSON.stringify(removed)).toContain("PROJECT_NOT_FOUND");
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
      const agentId = (started as { structuredContent?: Record<string, any> })
        .structuredContent?.bridgeActivity?.agentId as string;

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
    expect((replay as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        threadId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.threadId,
        bridgeActivity: {
          activityId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity.activityId,
          jobId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity.jobId,
          projectName: "Alpha"
        }
      });
    expect(JSON.stringify(replay)).not.toContain(alphaProject.id);
    expect(JSON.stringify(replay)).not.toContain(realpathSync(first));
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(first));
    expect(jobs.listForScope(SCOPE_A)[0]).toMatchObject({
      projectId: alphaProject.id,
      projectLabel: "Alpha",
      requestHashVersion: 5
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
    const startedStructured = (started as { structuredContent?: Record<string, any> })
      .structuredContent!;
    const activityId = startedStructured.bridgeActivity.activityId as string;
    const agentId = startedStructured.bridgeActivity.agentId as string;
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
    const linkedActivityId = (linked as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId as string;

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

  it("renders one scoped flat feed and folds completed work by Agent", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const { client, jobs, close } = await connectTestClient(
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
    const startedStructured = (started as { structuredContent?: Record<string, any> })
      .structuredContent!;
    const activityId = startedStructured.bridgeActivity.activityId as string;

    const summaryResult = await client.callTool({
      name: "codex_activity",
      arguments: { activityId }
    });
    const summary = (summaryResult as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(summary).toMatchObject({
      feed: {
        activeCount: 1,
        active: [expect.objectContaining({
          activityId,
          title: "Render summary",
          displayState: "waiting-gpt",
          agents: [expect.objectContaining({ agentName: "Summary Agent" })]
        })],
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
    const agents = (agentsResult as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(agents).not.toHaveProperty("viewMode");
    expect(agents.feed).toMatchObject({
      activeCount: 0,
      completed: {
        agentCount: 1,
        activityCount: 1,
        rows: [expect.objectContaining({
          agentName: "Summary Agent",
          latestActivityId: activityId,
          latestActivityTitle: "Render summary",
          activityCount: 1
        })]
      }
    });

    const agentId = startedStructured.bridgeActivity.agentId as string;
    const resumed = await runTask(client, {
      prompt: "start the next scoped activity",
      agentId,
      contextMode: "continue",
      activityTitle: "Next activity"
    });
    const resumedActivityId = (resumed as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId as string;
    const resumedResult = await client.callTool({ name: "codex_activity", arguments: {} });
    const resumedFeed = (resumedResult as { structuredContent?: Record<string, any> })
      .structuredContent?.feed;
    expect(resumedFeed).toMatchObject({
      activeCount: 1,
      active: [expect.objectContaining({
        activityId: resumedActivityId,
        agents: [expect.objectContaining({ agentName: "Summary Agent" })]
      })],
      completed: { agentCount: 0, activityCount: 0 }
    });
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
    const agentId = (first as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;

    await runTask(client, {
      prompt: "continue",
      agent: { mode: "existing", id: agentId, context: "continue" }
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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;

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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;

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
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({
      threadId: "thread-1",
      sandbox: "read-only",
      resumeAvailability: "unknown"
    });
    expect(JSON.stringify(status.sessions[0])).not.toContain(realpathSync(root));

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
      operation: "start",
      executionMode: "background",
      bridgeActivity: {
        automaticRenderTool: "codex_task",
        followUpRenderRequired: false,
        shouldRenderActivityCard: true
      }
    });
    expect(started).not.toHaveProperty("nextAction");
    upstream.resolveNext();

    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed.operation).toBe("start");
    expect(JSON.stringify(completed.result)).toContain("thread-1");
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
      version: 3,
      progressObserved: true,
      lastProgress: { progress: 3, total: 10, message: "editing files" },
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
      health: "no-progress-observed",
      wait: { waitFor: "terminal", timedOut: true, changed: false }
    });
    upstream.resolveNext();
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("cancels only a job owned by the supplied scope and forwards an abort signal", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "cancel me", sessionMode: "new" } })
    );
    await Promise.resolve();
    const currentVersion = jobs.get(started.jobId)?.version as number;

    const denied = await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "71717171-7171-4171-8171-717171717171",
        jobId: started.jobId,
        expectedVersion: currentVersion
      }
    });
    expect(denied.isError).toBe(true);
    expect(upstream.aborts).toBe(0);

    const cancellationArguments = {
      scopeId: SCOPE_A,
      requestId: "72727272-7272-4272-8272-727272727272",
      jobId: started.jobId,
      expectedVersion: currentVersion
    };
    const [cancelledResult, concurrentReplayResult] = await Promise.all([
      client.callTool({ name: "codex_cancel", arguments: cancellationArguments }),
      client.callTool({ name: "codex_cancel", arguments: cancellationArguments })
    ]);
    const cancelled = parseToolJson(cancelledResult);
    expect(parseToolJson(concurrentReplayResult)).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminal: true,
      terminalOrigin: "explicit-cancellation",
      cancellation: {
        logicalRequestId: cancellationArguments.requestId,
        source: "model-tool",
        tool: "codex_cancel",
        action: "cancel-job",
        reasonCode: "public-job-cancel",
        status: "succeeded",
        expectedVersion: currentVersion,
        target: {
          jobId: started.jobId,
          activityId: started.activityId,
          presentationId: started.activityPresentationId
        },
        durableDetailsAvailable: true
      }
    });
    expect(cancelled.error).toContain("Partial filesystem changes may remain");
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
      .toMatchObject({ status: "completed", source: "model-tool", result: cancelled });
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
        expectedVersion: current.version - 1
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
        expectedVersion: current.version
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
        acknowledgeAffectedJobIds: affected
      }
    }));
    expect(stopped).toMatchObject({ status: "cancelled", processLiveness: "worker-lost" });
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
    expect(failed.error).toContain("boom");
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
      resultOmitted: true,
      maxRetainedBytes: 200,
      threadId: "large-thread"
    });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.sessions[0]).toMatchObject({ threadId: "large-thread" });
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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;
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
    expect((restarted as { structuredContent?: Record<string, any> }).structuredContent?.bridgeSession)
      .toMatchObject({ action: "start", reason: "activity-new", threadId: "thread-2" });
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
    const agentId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId;

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
          retryable: false,
          probe: { reason: "system-error" }
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
    expect(restored).toMatchObject({
      structuredContent: {
        ok: true,
        agent: { lifecycle: "idle" }
      }
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "thread-1" });
    await close();
  });

  it("uses a projectless codex_task setup probe before first-run Settings onboarding", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, sessions, close } = await connectTestClient(
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
    expect(initialSchema.properties).not.toHaveProperty("project");
    expect(initialSchema).not.toHaveProperty("allOf");
    expect(JSON.stringify(initialSchema)).not.toContain('"not":{}');
    expect(initialTask?._meta).toBeUndefined();
    expect(initialTask?.description).toContain("call this tool once without project as a setup probe");
    const settingsTool = initialTools.tools.find((tool) => tool.name === "codex_settings");
    expect(settingsTool?.description).toContain("after an actual codex_task response");
    expect(settingsTool?.description).toContain(
      "Never open it merely because a conversation starts or this plugin is attached"
    );
    expect(settingsTool?.description).toContain(
      "registered project entries exist but the current codex_task descriptor exposes no selectable project"
    );

    const setupProbe = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
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
          code: "PROJECT_SETUP_REQUIRED",
          nextAction: { tool: "codex_settings", arguments: {} }
        }
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
    expect(registeredSchema.allOf).toEqual([
      expect.objectContaining({
        then: expect.objectContaining({ required: expect.arrayContaining(["project"]) })
      })
    ]);
    expect(registeredSchema.properties.project.oneOf).toEqual([
      expect.objectContaining({
        required: ["name", "registryRevision"],
        properties: {
          name: { const: "First Project" },
          registryRevision: { const: 1 }
        }
      })
    ]);
    expect(registeredTask?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": ACTIVITY_CARD_URI
    });

    const missingProject = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "77777777-7777-4777-8777-777777777777",
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
          code: "PROJECT_SETUP_REQUIRED",
          nextAction: { tool: "codex_settings", arguments: {} }
        }
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
    const agentId = (first as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
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
    const { client, close } = await connectTestClient(
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
    expect(parallel.session).toMatchObject({ action: "start", reason: "activity-no-compatible" });
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
  const rawCallTool = client.callTool.bind(client);
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
        if (admitsFreshWork && !Object.prototype.hasOwnProperty.call(currentArguments, "project")) {
          const target = selectTestProject(settingsStore, legacyProjectId);
          if (target) {
            currentArguments.project = {
              name: target.name,
              registryRevision: settingsStore.current.registryRevision
            };
          }
        } else if (legacyProjectId && !Object.prototype.hasOwnProperty.call(currentArguments, "project")) {
          const target = selectTestProject(settingsStore, legacyProjectId);
          currentArguments.project = {
            name: target?.name || legacyProjectId,
            registryRevision: settingsStore.current.registryRevision
          };
        }
        const requestId = typeof currentArguments.requestId === "string"
          ? currentArguments.requestId
          : nextRequestId();
        const activityPresentationId = typeof currentArguments.activityPresentationId === "string"
          ? currentArguments.activityPresentationId
          : requestId;
        return rawCallTool(
          {
            ...request,
            arguments: {
              scopeId: SCOPE_A,
              requestId,
              activityPresentationId,
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
          request.name === "codex_activity" ||
          request.name === "codex_activity_snapshot" ||
          request.name === "codex_activity_handoff" ||
          request.name === "codex_activity_job_cancel" ||
          request.name === "codex_activity_cancel" ||
          request.name === "codex_activity_update" ||
          request.name === "codex_agent" ||
          request.name === "codex_agent_recovery_detach" ||
          request.name === "codex_background_process_terminate" ||
          request.name === "codex_interaction_respond" ||
          request.name === "codex_job_steer"
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
  return client.callTool({
    name: "codex_task",
    arguments: { executionMode: "foreground", ...arguments_ }
  });
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
    ?.bridgeActivity?.activityId;
  if (typeof activityId !== "string") throw new Error("Task result did not include an Activity id.");
  return activityId;
}

function taskSession(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, any> }).structuredContent?.bridgeSession || {};
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
  return {
    id,
    displayName,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.map((effort) => ({ effort })),
    isDefault,
    serviceTiers: [],
    inputModalities: ["text"],
    supportedInApi: true
  };
}

function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text || "{}");
}

function privateSettingsView(result: unknown): Record<string, any> {
  const candidate = (result as { _meta?: Record<string, any> } | undefined)
    ?._meta?.["codex/settingsView"];
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Missing private Settings-card view metadata.");
  }
  return candidate;
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
