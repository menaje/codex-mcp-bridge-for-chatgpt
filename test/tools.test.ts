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
import { SCOPE_ID_PATTERN, SessionRegistry } from "../src/sessionRegistry.js";
import {
  ACTIVITY_CARD_CONTRACT_GENERATION,
  ACTIVITY_CARD_URI,
  LEGACY_ACTIVITY_CARD_CONTRACT_GENERATION
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
  private pending: Array<{
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
    return fakeCodexResult("thread-forked");
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

  async respondToInteraction(
    interactionId: string,
    response: { decision?: CodexInteractionDecision; answers?: Record<string, string[]> }
  ): Promise<void> {
    this.interactionResponses.push({ interactionId, response });
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
      model("gpt-5.6-sol", "max", ["low", "medium", "high", "xhigh", "max", "ultra"], true),
      model("gpt-5.6-terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
      model("gpt-5.5", "medium", ["low", "medium", "high", "xhigh"])
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
      "codex_activity_handoff",
      "codex_activity_update",
      "codex_agent",
      "codex_agent_recovery_detach",
      "codex_background_process_terminate",
      "codex_cancel",
      "codex_models",
      "codex_settings",
      "codex_status",
      "codex_task",
      "codex_update_settings"
    ]);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("codex_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    });
    expect(byName.get("codex_status")?.inputSchema).toMatchObject({
      properties: {
        waitFor: { enum: ["change", "terminal"] },
        waitMs: { maximum: 60000 }
      }
    });
    expect(byName.get("codex_task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(byName.get("codex_task")?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI },
      "openai/outputTemplate": ACTIVITY_CARD_URI,
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": ACTIVITY_CARD_CONTRACT_GENERATION
    });
    expect(byName.get("codex_activity")?._meta).toMatchObject({
      ui: { resourceUri: ACTIVITY_CARD_URI },
      "openai/outputTemplate": ACTIVITY_CARD_URI
    });
    expect(byName.get("codex_task")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["requestId", "activityPresentationId", "prompt"])
    });
    expect((byName.get("codex_task")?.inputSchema as { required?: string[] }).required)
      .not.toContain("scopeId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("taskKey");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("cwd");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("threadId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("sessionMode");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("adoptThread");
    expect(byName.get("codex_task")?.inputSchema.properties).toMatchObject({
      activityKind: { enum: ["discussion", "investigation", "review", "implementation", "other"] },
      executionMode: { enum: ["foreground", "background"] },
      handoffPolicy: { enum: ["none", "notify", "verify"] },
      completionTrigger: { enum: ["manual", "sealed-jobs-terminal"] },
      contextMode: { enum: ["continue", "fork", "fresh"] },
      agentId: expect.any(Object),
      agentName: expect.any(Object),
      continuationOfActivityId: expect.any(Object),
      activityPresentationId: expect.any(Object)
    });
    expect(byName.get("codex_agent")?.inputSchema.properties).toMatchObject({
      action: { enum: ["archive", "restore", "rename"] },
      agentId: expect.any(Object),
      requestId: expect.any(Object)
    });
    expect(byName.get("codex_agent")?.inputSchema.properties).not.toHaveProperty("activityId");
    expect(byName.get("codex_agent")?.inputSchema.properties).not.toHaveProperty("processId");
    expect((byName.get("codex_agent")?.inputSchema.properties?.action as { enum?: string[] }).enum)
      .not.toContain("delete");
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
    expect(byName.get("codex_cancel")?.inputSchema.properties?.acknowledgeAffectedJobIds)
      .toMatchObject({ maxItems: HARD_MAX_CONCURRENT_JOBS });
    expect(byName.get("codex_activity_update")?.inputSchema.properties?.acknowledgeAffectedJobIds)
      .toMatchObject({ maxItems: HARD_MAX_CONCURRENT_JOBS });
    expect(byName.get("codex_activity_update")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
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
    expect(byName.get("codex_update_settings")?.inputSchema.properties).toMatchObject({
      projects: { type: "array" },
      defaultProjectId: expect.any(Object),
      uiLocalePreference: {
        enum: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"]
      },
      activityCardVisibility: { enum: ["always", "background-only", "never"] },
      completionHandoff: { enum: ["off", "auto-handoff"] }
    });
    expect(byName.get("codex_update_settings")?.inputSchema.properties)
      .not.toHaveProperty("activityCardView");
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
            "activityCursor",
            "activityId",
            "activityLimit",
            "activityOffset",
            "activityPresentationId",
            "activityView",
            "afterVersion",
            "cardGeneration",
            "includeAllScopes",
            "jobCursor",
            "jobId",
            "jobLimit",
            "jobOffset",
            "mountedActivityId",
            "presentationKind",
            "scopeId",
            "sessionCursor",
            "sessionLimit",
            "sessionOffset",
            "threadId",
            "waitFor",
            "waitMs",
          ],
          "propertyCount": 22,
          "schemaBytes": 3368,
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
            "cardGeneration",
            "forceNewCard",
            "limit",
            "scopeId",
            "sinceVersion",
            "waitMs",
          ],
          "propertyCount": 7,
          "schemaBytes": 987,
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
          "name": "codex_activity_handoff",
          "properties": [
            "action",
            "activityPresentationId",
            "outboxId",
            "outboxIds",
            "presentationKind",
            "scopeId",
          ],
          "propertyCount": 6,
          "schemaBytes": 719,
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
            "action",
            "agentId",
            "agentName",
            "requestId",
            "scopeId",
          ],
          "propertyCount": 5,
          "schemaBytes": 923,
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
          ],
          "propertyCount": 6,
          "schemaBytes": 1586,
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
            "scopeId",
          ],
          "propertyCount": 4,
          "schemaBytes": 724,
          "visibility": {
            "app": false,
            "model": true,
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
          "name": "codex_activity_update",
          "properties": [
            "acknowledgeAffectedJobIds",
            "action",
            "activityId",
            "activityKind",
            "completionTrigger",
            "evidence",
            "executionMode",
            "expectedJobVersion",
            "expectedVersion",
            "handoffPolicy",
            "interactionAnswers",
            "interactionDecision",
            "interactionId",
            "jobId",
            "reason",
            "scopeId",
            "steeringPrompt",
          ],
          "propertyCount": 17,
          "schemaBytes": 2976,
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
            "accessStrategy",
            "activityCardVisibility",
            "completionHandoff",
            "defaultCwd",
            "defaultProjectId",
            "expectedRevision",
            "maxConcurrentJobs",
            "modelPolicy",
            "projects",
            "reset",
            "uiLocalePreference",
            "usePriorityServiceTier",
          ],
          "propertyCount": 12,
          "schemaBytes": 2848,
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
            "activityId",
            "activityKind",
            "activityPresentationId",
            "activityTitle",
            "agentId",
            "agentName",
            "agentRole",
            "completionTrigger",
            "contextMode",
            "continuationOfActivityId",
            "executionMode",
            "handoffPolicy",
            "modelPolicyRevision",
            "projectId",
            "prompt",
            "requestId",
            "sandbox",
            "scopeId",
            "selection",
          ],
          "propertyCount": 19,
          "schemaBytes": 5314,
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

  it("returns an identifiable retryable error for a stale automatic-card descriptor missing presentation id", async () => {
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
    expect((missing as { structuredContent?: Record<string, any> }).structuredContent?.error)
      .toMatchObject({
        code: "ACTIVITY_PRESENTATION_ID_REQUIRED",
        retryable: true,
        missingFields: ["activityPresentationId"],
        nextActions: expect.any(Array)
      });
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
    expect(JSON.stringify(invalid)).toContain("UUID-formatted");
    await close();
  });

  it("requires complete GPT-supplied creation metadata and preserves it across follow-ups", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

    const missingName = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "10101010-1010-4010-8010-101010101010",
        activityPresentationId: "10101010-1010-4010-8010-101010101010",
        prompt: "review the design",
        executionMode: "foreground"
      }
    });
    expect(missingName.isError).toBe(true);
    const missingNameText = JSON.stringify(missingName);
    expect(missingNameText).toContain("AGENT_NAME_REQUIRED");
    for (const field of ["agentName", "agentRole", "activityTitle", "activityKind", "contextMode"]) {
      expect(missingNameText).toContain(field);
    }
    expect((missingName as { structuredContent?: Record<string, any> }).structuredContent?.error)
      .toMatchObject({
        code: "AGENT_NAME_REQUIRED",
        retryable: true,
        missingFields: ["agentName", "agentRole", "activityTitle", "activityKind", "contextMode"],
        requiredFields: ["agentName", "agentRole", "activityTitle", "activityKind", "contextMode"],
        nextActions: expect.any(Array)
      });
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);

    const incompleteMetadata = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "20202020-2020-4020-8020-202020202020",
        activityPresentationId: "20202020-2020-4020-8020-202020202020",
        prompt: "review the design",
        agentName: "민아",
        contextMode: "fresh",
        executionMode: "foreground"
      }
    });
    const incompleteMetadataText = JSON.stringify(incompleteMetadata);
    expect(incompleteMetadata.isError).toBe(true);
    expect(incompleteMetadataText).toContain("ACTIVITY_METADATA_REQUIRED");
    for (const field of ["agentRole", "activityTitle", "activityKind"]) {
      expect(incompleteMetadataText).toContain(field);
    }
    expect((incompleteMetadata as { structuredContent?: Record<string, any> }).structuredContent?.error)
      .toMatchObject({
        retryable: true,
        missingFields: ["agentRole", "activityTitle", "activityKind"]
      });
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toEqual([]);
    expect(jobs.listActivities(SCOPE_A, 100, 0)).toEqual([]);

    const named = await runTask(client, {
      prompt: "review the design",
      activityTitle: "Design review",
      activityKind: "review",
      agentName: "민아",
      agentRole: "design reviewer",
      contextMode: "fresh"
    });
    const agentId = (named as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.agentId as string;
    expect(jobs.getAgent(agentId)).toMatchObject({ agentName: "민아" });
    expect(jobs.listActivityAgentAssignments(undefined, agentId)).toEqual([
      expect.objectContaining({ role: "design reviewer" })
    ]);

    await runTask(client, {
      prompt: "continue the review",
      activityId: taskActivityId(named),
      agentId
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ agentName: "민아" });
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);

    const incompleteSecondAgent = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "30303030-3030-4030-8030-303030303030",
        activityPresentationId: "30303030-3030-4030-8030-303030303030",
        prompt: "independent review",
        activityId: taskActivityId(named),
        agentName: "준"
      }
    });
    const incompleteSecondAgentText = JSON.stringify(incompleteSecondAgent);
    expect(incompleteSecondAgent.isError).toBe(true);
    expect(incompleteSecondAgentText).toContain("AGENT_METADATA_REQUIRED");
    expect(incompleteSecondAgentText).toContain("agentRole");
    expect(incompleteSecondAgentText).toContain("contextMode");
    expect((incompleteSecondAgent as { structuredContent?: Record<string, any> }).structuredContent?.error)
      .toMatchObject({
        retryable: true,
        missingFields: ["agentRole", "contextMode"],
        requiredFields: ["agentName", "agentRole", "contextMode"]
      });
    expect(jobs.listAgents(SCOPE_A, true, 100, 0)).toHaveLength(1);
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
    expect(contents.text).toContain("result&&result.isError");
    expect(contents.text).toContain("!elements.form.reportValidity()");
    expect(contents.text).toContain("Number.isSafeInteger(value)");
    expect(contents.text).toContain("if(modelPolicyDirty)args.modelPolicy=buildModelPolicy()");
    expect(contents.text).toContain("settings.legacyPreferredModel");
    expect(contents.text).toContain('id="allowed-models"');
    expect(contents.text).toContain('id="effort-groups"');
    expect(contents.text).toContain('id="use-priority-service-tier" type="checkbox"');
    expect(contents.text).toContain('id="project-list"');
    expect(contents.text).toContain('id="add-project" type="button"');
    expect(contents.text).toContain('id="default-project"');
    expect(contents.text).not.toContain('id="default-cwd"');
    expect(contents.text).toContain("projects:projectSettings.projects");
    expect(contents.text).toContain("defaultProjectId:projectSettings.defaultProjectId");
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
      expect(revisions).toHaveLength(2);
      expect(revisions[0].uri).toBe(currentUri);
      for (const [index, revision] of revisions.entries()) {
        expect(listedUris).toContain(revision.uri);
        const resource = await client.readResource({ uri: revision.uri });
        expect(resource.contents[0]).toMatchObject({
          uri: revision.uri,
          mimeType: "text/html;profile=mcp-app"
        });
        expect((resource.contents[0] as { text?: string }).text).toContain("<!doctype html>");
        if (name === "activity") {
          const html = (resource.contents[0] as { text?: string }).text || "";
          if (index === 0) {
            expect(html).toContain('callTool("codex_background_process_terminate"');
            expect(html).not.toContain('callTool("codex_agent"');
          } else {
            expect(html).toContain('callTool("codex_agent"');
            expect(html).not.toContain('callTool("codex_background_process_terminate"');
          }
        }
        expect((resource.contents[0] as { _meta?: Record<string, unknown> })._meta)
          .toMatchObject({
            "codex/uiContractGeneration": name === "activity" && index > 0
              ? LEGACY_ACTIVITY_CARD_CONTRACT_GENERATION
              : name === "activity"
                ? ACTIVITY_CARD_CONTRACT_GENERATION
                : SETTINGS_CARD_CONTRACT_GENERATION
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
    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, accessStrategy: "read-only" }
    });
    expect(await taskAnnotations()).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    });
    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, accessStrategy: "always-full" }
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
    mkdirSync(web);
    mkdirSync(api);
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const initial = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(initial.settings).toMatchObject({
      projects: [{ id: "default", cwd: realpathSync(root) }],
      defaultProjectId: "default"
    });
    expect(initial.capabilities.projectAvailability).toEqual([
      { id: "default", available: true }
    ]);

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        projects: [
          { id: "Web APP", label: "웹 앱", cwd: web },
          { id: "API", label: "API 서비스", cwd: api }
        ],
        defaultProjectId: "API"
      }
    });
    expect(saved.isError).not.toBe(true);
    const view = (saved as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(view.settings).toMatchObject({
      revision: 1,
      projects: [
        { id: "web-app", label: "웹 앱", cwd: realpathSync(web) },
        { id: "api", label: "API 서비스", cwd: realpathSync(api) }
      ],
      defaultProjectId: "api",
      defaultCwd: realpathSync(api)
    });
    expect(view.capabilities.projectAvailability).toEqual([
      { id: "web-app", available: true },
      { id: "api", available: true }
    ]);

    const duplicateId = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        projects: [
          { id: "same id", label: "One", cwd: web },
          { id: "same_id", label: "Two", cwd: api }
        ],
        defaultProjectId: null
      }
    });
    expect(duplicateId.isError).toBe(true);
    expect(JSON.stringify(duplicateId)).toContain("PROJECT_DUPLICATE_ID");

    const duplicatePath = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        projects: [
          { id: "one", label: "One", cwd: web },
          { id: "two", label: "Two", cwd: web }
        ],
        defaultProjectId: null
      }
    });
    expect(duplicatePath.isError).toBe(true);
    expect(JSON.stringify(duplicatePath)).toContain("PROJECT_DUPLICATE_PATH");

    const missingDefault = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        projects: [{ id: "web", label: "Web", cwd: web }],
        defaultProjectId: "missing"
      }
    });
    expect(missingDefault.isError).toBe(true);
    expect(JSON.stringify(missingDefault)).toContain("PROJECT_DEFAULT_NOT_FOUND");
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
      ],
      defaultProjectId: "active"
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
      { id: "active", available: true },
      { id: "recovery", available: false }
    ]);
    expect(JSON.stringify(view.capabilities.projectAvailability)).not.toContain(second);
    expect(JSON.stringify(view.capabilities.projectAvailability)).not.toContain("unavailableReason");
    expect(view.settings.projects).toContainEqual({
      id: "recovery",
      label: "Recovery",
      cwd: realpathSync(second)
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
      projects: [{ id: "alpha", label: "Alpha Workspace", cwd: project }],
      defaultProjectId: "alpha"
    }, settings.current.revision);
    const { client, close } = await connectTestClient(
      config,
      new FakeUpstream(),
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
    expect(initial.capabilities.projectAvailability).toEqual([{ id: "alpha", available: true }]);
    const initialDescriptor = await taskDescriptor();
    expect(JSON.stringify(initialDescriptor.inputSchema.properties?.projectId))
      .toContain('"const":"alpha"');
    expect(JSON.stringify(initialDescriptor)).not.toContain(realpathSync(project));

    renameSync(project, displaced);
    const unavailable = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unavailable.capabilities.projectAvailability).toEqual([{ id: "alpha", available: false }]);
    expect(listChanged).toBe(baselineNotifications + 1);
    const unavailableDescriptor = await taskDescriptor();
    expect(JSON.stringify(unavailableDescriptor.inputSchema.properties?.projectId))
      .not.toContain('"const":"alpha"');
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(project);
    expect(JSON.stringify(unavailableDescriptor)).not.toContain(displaced);
    const unavailableStatus = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: {} })
    );
    expect(unavailableStatus.projects).toEqual([
      { projectId: "alpha", projectLabel: "Alpha Workspace", available: false }
    ]);
    expect(JSON.stringify(unavailableStatus)).not.toContain(project);
    expect(JSON.stringify(unavailableStatus)).not.toContain(displaced);

    renameSync(displaced, project);
    const recovered = (await client.callTool({
      name: "codex_settings",
      arguments: {}
    }) as { structuredContent?: Record<string, any> }).structuredContent!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recovered.capabilities.projectAvailability).toEqual([{ id: "alpha", available: true }]);
    expect(listChanged).toBe(baselineNotifications + 2);
    const recoveredDescriptor = await taskDescriptor();
    expect(JSON.stringify(recoveredDescriptor.inputSchema.properties?.projectId))
      .toContain('"const":"alpha"');
    expect(JSON.stringify(recoveredDescriptor.inputSchema.properties?.projectId))
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
      allowedRootCount: 1,
      defaultProjectId: "default",
      projects: [{ projectId: "default", projectLabel: path.basename(root), available: true }],
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

  it("reports no default project when multiple roots have no registered projects", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({ allowedRootCount: 2, defaultProjectId: null, projects: [] });
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
    expect(staleLegacyOverride).toMatchObject({
      structuredContent: {
        error: { code: "MODEL_SELECTION_FORBIDDEN", policyRevision: 1 }
      }
    });
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

    const staleRevision = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "stale revision",
        modelPolicyRevision: 1,
        selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
      }
    });
    expect(staleRevision).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MODEL_POLICY_CHANGED",
          policyRevision: 2,
          nextActions: [expect.stringContaining("Refresh")]
        }
      }
    });
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
      .toMatchObject({ revision: 2, usePriorityServiceTier: false });
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
      .toMatchObject({ revision: 1, modelPolicy: { mode: "automatic" } });

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
      modelPolicyRevision: 0,
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
        revision: 0,
        accessStrategy: "adaptive",
        modelPolicy: {
          mode: "automatic",
          preferredSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
          allowedSelections: { kind: "catalog-visible" }
        },
        defaultCwd: realpathSync(root),
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      },
      capabilities: {
        availableAccessStrategies: ["read-only", "adaptive", "always-full"],
        allowedRoots: [realpathSync(root)],
        availableUiLocalePreferences: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"],
        availableActivityCardVisibilities: ["always", "background-only", "never"],
        availableCompletionHandoffs: ["off", "auto-handoff"],
        maxConcurrentJobs: 30,
        allowDangerFullAccess: true
      }
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
        defaultCwd: root,
        uiLocalePreference: "ko",
        maxConcurrentJobs: 12,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      }
    });
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings).toMatchObject({
      revision: 1,
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
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const descriptor = (await client.listTools()).tools.find(
      (entry) => entry.name === "codex_update_settings"
    )!;
    expect(descriptor.inputSchema.required).toContain("expectedRevision");
    const missingRevision = await client.callTool({
      name: "codex_update_settings",
      arguments: { uiLocalePreference: "ko" }
    });
    expect(missingRevision.isError).toBe(true);

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, uiLocalePreference: "ko" }
    });
    const stale = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, accessStrategy: "always-full" }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("SETTINGS_REVISION_CONFLICT");
    expect(JSON.stringify(stale)).not.toContain("expected revision");
    expect(JSON.stringify(stale)).not.toContain("current revision");

    const unsupported = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        modelPolicy: {
          mode: "fixed",
          selection: { model: "gpt-5.5", reasoningEffort: "max" },
          constraints: { allowDelegation: true }
        }
      }
    });
    expect(unsupported.isError).toBe(true);
    expect(JSON.stringify(unsupported)).toContain("MODEL_UNAVAILABLE");
    await close();
  });

  it("ignores a retired Activity layout sent by a stale Settings card", async () => {
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
    expect(saved.isError).not.toBe(true);
    const settings = (saved as { structuredContent?: Record<string, any> }).structuredContent?.settings;
    expect(settings).toMatchObject({ revision: 1, uiLocalePreference: "ko" });
    expect(settings).not.toHaveProperty("activityCardView");

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
      .toMatchObject({ revision: 1, uiLocalePreference: "ko" });
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
      shouldRenderActivityCard: false,
      renderReason: "render-reserved"
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
        activityTitle: "Never visibility compatibility",
        activityKind: "other",
        agentName: "Never Visibility Agent",
        agentRole: "compatibility",
        contextMode: "fresh"
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
    expect(JSON.stringify(staleReadOverride)).toContain("SANDBOX_OVERRIDE_RETIRED");
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
        sessionMode: "new",
        activityId: first.activityId,
        handoffPolicy: "notify"
      }
    });
    expect(policyInjection.isError).toBe(true);
    expect(JSON.stringify(policyInjection)).toContain("cannot be used with activityId");
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
        action: "set-policy",
        handoffPolicy: "notify"
      }
    });
    expect(stalePolicy.isError).toBe(true);
    expect(JSON.stringify(stalePolicy)).toContain("Activity version changed");
    expect(jobs.getActivity(first.activityId)).toMatchObject({ handoffPolicy: "none" });

    const completed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        action: "complete",
        reason: "The orchestrator accepted both investigation results"
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
    const { client, jobs, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server" }),
      upstream
    );

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
      projectId: "default",
      projectLabel: path.basename(root)
    });
    expect(jobs.getAgent(agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "thread-1" });
    expect(jobs.listActivityAgentAssignments(sourceActivityId, agentId)).toEqual([
      expect.objectContaining({ contextMode: "fresh", releasedAt: expect.any(Number) })
    ]);

    await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId: sourceActivityId, action: "complete", reason: "Original goal accepted" }
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
      projectId: "default",
      projectLabel: path.basename(root),
      cardGeneration: 1
    });
    expect(upstream.calls[1]).toMatchObject({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "continue into a separately verifiable goal" }
    });

    const forked = await runTask(client, {
      prompt: "independently verify the approach",
      activityId: linkedActivityId,
      agentId,
      contextMode: "fork"
    });
    expect((forked as { structuredContent?: Record<string, any> }).structuredContent?.threadId)
      .toBe("thread-forked");
    expect((forked as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity)
      .toMatchObject({ projectId: "default", projectLabel: path.basename(root) });
    expect(upstream.calls[2]).toMatchObject({
      name: "codex-fork",
      args: { threadId: "thread-1", prompt: "independently verify the approach" }
    });

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
      projectId: "default",
      projectLabel: path.basename(root)
    });
    expect(history.find((thread) => thread.threadId === "thread-forked")).toMatchObject({
      isCurrent: false,
      contextMode: "fork",
      projectId: "default",
      projectLabel: path.basename(root),
      forkedFromThreadId: "thread-1"
    });
    expect(history.find((thread) => thread.threadId === "thread-2")).toMatchObject({
      isCurrent: true,
      contextMode: "fresh",
      projectId: "default",
      projectLabel: path.basename(root)
    });
    expect(jobs.getAgent(agentId)).toMatchObject({
      agentId,
      agentName: "Long-lived Agent",
      lifecycle: "idle",
      currentThreadId: "thread-2"
    });
    await close();
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
      action: "rename",
      agentName: "Renamed Agent"
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
      arguments: { ...renameArguments, agentName: "Different Name" }
    });
    expect(changedRetry.isError).toBe(true);
    expect(JSON.stringify(changedRetry)).toContain("already used for a different Agent mutation");

    jobs.setAgentExecutionState(agentId, "orphaned", {
      orphanedReason: "Transient session metadata was unavailable before recovery."
    });

    const archived = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "40404040-4040-4040-8040-404040404040",
        agentId,
        action: "archive"
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
        action: "restore"
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
        action: "archive"
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

    const widgetSessionId = "background-process-card";
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

    const legacyTerminated = parseToolJson(await client.callTool({
      name: "codex_agent",
      arguments: {
        requestId: "84848484-8484-4484-8484-848484848484",
        agentId,
        action: "terminate-background-process",
        processId: "legacy-background-process-2"
      },
      _meta: { "openai/widgetSessionId": widgetSessionId }
    }));
    expect(legacyTerminated).toMatchObject({
      ok: true,
      action: "terminate-background-process",
      processId: "legacy-background-process-2",
      terminated: true
    });
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

    const unavailableDecision = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: started.activityId,
        action: "respond-interaction",
        jobId: started.jobId,
        interactionId: approval.interactionId,
        interactionDecision: "accept"
      }
    });
    expect(unavailableDecision.isError).toBe(true);
    expect(JSON.stringify(unavailableDecision)).toContain("decision is not available");
    expect(upstream.interactionResponses).toEqual([]);

    await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: started.activityId,
        action: "respond-interaction",
        jobId: started.jobId,
        interactionId: approval.interactionId,
        interactionDecision: "acceptForSession"
      }
    });
    expect(upstream.interactionResponses).toEqual([
      { interactionId: approval.interactionId, response: { decision: "acceptForSession" } }
    ]);
    expect(jobs.get(started.jobId)?.pendingInteractions).toEqual([]);

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
    await new Promise((resolve) => setTimeout(resolve, 10));
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

    const crossScope = await rawCallTool({
      name: "codex_activity_update",
      arguments: { scopeId: SCOPE_B, activityId, action: "seal" }
    });
    expect(crossScope.isError).toBe(true);
    expect(JSON.stringify(crossScope)).toContain("another conversation scope");

    const sealed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId, action: "seal" }
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
      arguments: { activityId, action: "complete" }
    });
    expect(illegalComplete.isError).toBe(true);
    expect(JSON.stringify(illegalComplete)).toContain("Finish Activity verification");

    const verifying = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId, action: "start-verification" }
    }));
    expect(verifying.activity).toMatchObject({ verification: "verifying" });
    const passed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        action: "verification-passed",
        evidence: {
          summary: "Reviewed the diff and ran the test suite",
          jobIds: [jobId],
          tests: ["npm test: exit 0"]
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
      arguments: { activityId, forceNewCard: true }
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
    await close();
  });

  it("cancels every running child job before cancelling its Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "long delegated work",
        sessionMode: "new",
        activityTitle: "Cancelable work",
        executionMode: "background"
      }
    }));

    const cancelled = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: running.activityId,
        action: "cancel",
        reason: "The user stopped this Activity"
      }
    }));
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
    expect(jobs.get(running.jobId)).toMatchObject({ status: "cancelled" });

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
      session: null,
      turns: [expect.objectContaining({ jobId: first.jobId, turnId: "app-turn-1", status: "running" })]
    });

    const stopped = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        action: "cancel",
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
    const threadId = (started as { structuredContent?: Record<string, any> }).structuredContent?.threadId;

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
      { prompt: "exact continuation must reject", activityId, sessionMode: "continue", threadId }
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
      sessionMode: "new"
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

    await runTask(client, { prompt: "start app thread", sessionMode: "new" });
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
      sessionMode: "continue",
      threadId: "thread-1"
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
        activityPresentationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        activityTitle: "Derived scope task",
        activityKind: "investigation",
        agentName: "Derived Scope Agent",
        agentRole: "investigation",
        contextMode: "fresh",
        executionMode: "foreground"
      },
      _meta: metadataA
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
        activityPresentationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        activityTitle: "Derived scope task",
        activityKind: "investigation",
        agentName: "Derived Scope Agent",
        agentRole: "investigation",
        contextMode: "fresh",
        executionMode: "foreground"
      },
      _meta: metadataA
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
        shouldRenderActivityCard: false,
        renderReason: "render-reserved"
      },
      bridgeSession: startedStructured.bridgeSession,
    });
    expect(upstream.calls).toHaveLength(1);

    const continued = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        activityPresentationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        prompt: "continue derived scope",
        executionMode: "foreground",
        activityId: (started as { structuredContent?: Record<string, any> }).structuredContent
          ?.bridgeActivity?.activityId
      },
      _meta: metadataA
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
        activityTitle: "Compatibility scope task",
        activityKind: "other",
        agentName: "Compatibility Agent",
        agentRole: "compatibility test",
        contextMode: "fresh"
      }
    });
    expect((compatible as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeSession: { scopeId: SCOPE_A } });
    await close();
  });

  it("uses the same host-derived scope for job cancellation", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { rawCallTool, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const metadata = { "openai/session": "cancel-session" };
    const started = parseToolJson(
      await rawCallTool({
        name: "codex_task",
        arguments: {
          requestId: "acacacac-acac-4aca-8aca-acacacacacac",
          activityPresentationId: "acacacac-acac-4aca-8aca-acacacacacac",
          prompt: "cancel derived job",
          activityTitle: "Cancelable derived task",
          activityKind: "implementation",
          agentName: "Cancellation Agent",
          agentRole: "implementation",
          contextMode: "fresh"
        },
        _meta: metadata
      })
    );

    const denied = await rawCallTool({
      name: "codex_cancel",
      arguments: { jobId: started.jobId },
      _meta: { "openai/session": "another-cancel-session" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("another conversation scope");

    const cancelled = parseToolJson(
      await rawCallTool({
        name: "codex_cancel",
        arguments: { jobId: started.jobId },
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
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId,
      prompt: "one logical task",
      agentName: "Deduplicated Agent",
      contextMode: "fresh" as const,
      activityTitle: "Deduplicated Activity",
      activityKind: "investigation" as const,
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
      shouldRenderActivityCard: false,
      renderReason: "render-reserved"
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
      arguments: { ...arguments_, activityTitle: "Different Activity" }
    });
    expect(changedActivity.isError).toBe(true);
    expect(JSON.stringify(changedActivity)).toContain("already used for a different Codex task");
    const changedPresentation = await client.callTool({
      name: "codex_task",
      arguments: {
        ...arguments_,
        activityPresentationId: "24242424-0000-4000-8000-000000000099"
      }
    });
    expect(changedPresentation.isError).toBe(true);
    expect(JSON.stringify(changedPresentation)).toContain("already used for a different Codex task");

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
        shouldRenderActivityCard: false,
        renderReason: "render-reserved"
      }
    });
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
      activityTitle: "Stable exact-selection retry",
      activityKind: "investigation" as const,
      agentName: "Stable Retry Agent",
      agentRole: "investigation",
      contextMode: "fresh" as const,
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
    expect(JSON.stringify(denied)).toContain("THREAD_ROUTING_RETIRED");

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
    expect(JSON.stringify(adoption)).toContain("THREAD_ADOPTION_RETIRED");
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
    const { client, rawCallTool, close } = await connectTestClient(configFor(root), upstream);
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

    const firstPage = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { scopeId: SCOPE_A, sessionLimit: 10, jobLimit: 2 }
      })
    );
    expect(firstPage.pagination.sessions.nextCursor).toEqual(expect.any(String));
    expect(firstPage.pagination.jobs.nextCursor).toEqual(expect.any(String));
    const secondPage = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: {
          scopeId: SCOPE_A,
          sessionLimit: 10,
          sessionCursor: firstPage.pagination.sessions.nextCursor,
          jobLimit: 2,
          jobCursor: firstPage.pagination.jobs.nextCursor
        }
      })
    );

    expect(firstPage.scopeCounts).toEqual({
      sessions: 14,
      activities: 3,
      agents: 3,
      orphanedAgents: 0,
      jobs: 3,
      runningJobs: 0
    });
    expect(firstPage.sessions).toHaveLength(10);
    expect(firstPage.jobs).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({
      sessions: { offset: 0, returned: 10, total: 14, hasMore: true, nextOffset: 10 },
      jobs: { offset: 0, returned: 2, total: 3, hasMore: true, nextOffset: 2 }
    });
    expect(secondPage.sessions).toHaveLength(4);
    expect(secondPage.jobs).toHaveLength(1);
    expect(secondPage.pagination).toMatchObject({
      sessions: { offset: 10, returned: 4, total: 14, hasMore: false, nextOffset: null },
      jobs: { offset: 2, returned: 1, total: 3, hasMore: false, nextOffset: null }
    });
    const malformed = await client.callTool({
      name: "codex_status",
      arguments: { scopeId: SCOPE_A, sessionCursor: "not-a-valid-cursor" }
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
    const secondResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "reuse the thread for a separate intent",
        sessionMode: "continue",
        threadId: "thread-1",
        activityTitle: "Second Activity"
      }
    });
    const second = (secondResult as { structuredContent?: Record<string, any> }).structuredContent
      ?.bridgeActivity;
    expect(first.activityId).not.toBe(second.activityId);

    const detail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { threadId: "thread-1" }
    }));
    expect(detail.activities.map((activity: { activityId: string }) => activity.activityId).sort()).toEqual(
      [first.activityId, second.activityId].sort()
    );
    expect(detail.jobs).toHaveLength(2);
    const firstJobDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { jobId: first.jobId }
    }));
    expect(firstJobDetail).toMatchObject({
      jobId: first.jobId,
      threadId: "thread-1",
      session: { threadId: "thread-1" }
    });
    expect(detail.turns).toEqual([
      expect.objectContaining({ jobId: first.jobId, turnId: null, status: "completed" }),
      expect.objectContaining({ jobId: second.jobId, turnId: null, status: "completed" })
    ]);
    await close();
  });

  it("uses codex_status as the lightweight card watch API without private execution details", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
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

    const watchPromise = client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        afterVersion: initial.scopeVersion,
        waitFor: "change",
        waitMs: 1_000
      },
      _meta: { "openai/widgetSessionId": "widget-watch" }
    });
    await Promise.resolve();
    upstream.progressNext({
      progress: 1,
      total: 2,
      message: "public progress",
      event: {
        eventId: "public-progress-1",
        type: "turn",
        phase: "updated",
        createdAt: Date.now(),
        summary: "Public progress"
      }
    } as Progress);
    const watched = await watchPromise;
    const next = (watched as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(next.scopeVersion).toBeGreaterThan(initial.scopeVersion);
    expect(next.wait).toMatchObject({ changed: true, timedOut: false });
    expect(next.agents[0]).toMatchObject({ displayState: "running", activityId: started.activityId });
    expect(next.activities[0]).not.toHaveProperty("jobs");

    upstream.resolveNext(fakeCodexResult("watched-thread"));
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("deduplicates parallel Agents by one response presentation and keeps explicit cards distinct", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, rawCallTool, close } = await connectTestClient(configFor(root), upstream);
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

    const mounted = await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: first.activityId,
        cardGeneration: 1,
        presentationKind: "automatic",
        activityPresentationId
      },
      _meta: { "openai/widgetSessionId": "mounted-card" }
    });
    expect((mounted as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      mountedActivity: { activityId: first.activityId, cardGeneration: 1 },
      mountedPresentation: { kind: "automatic", activityPresentationId },
      watcherPolicy: { live: true, ownsCompletionHandoff: true }
    });

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
      shouldRenderActivityCard: false,
      renderReason: "active-lease"
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
      shouldRenderActivityCard: false,
      renderReason: "active-lease"
    });

    const explicit = await rawCallTool({
      name: "codex_activity",
      arguments: {
        scopeId: SCOPE_A,
        activityId: first.activityId,
        cardGeneration: 1,
        forceNewCard: true
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
    const stoppedOldPresentation = await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: first.activityId,
        cardGeneration: 1,
        presentationKind: "automatic",
        activityPresentationId,
        afterVersion: (mounted as { structuredContent?: Record<string, any> }).structuredContent
          ?.scopeVersion,
        waitFor: "change",
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
    upstream.resolveNext(fakeCodexResult("card-thread-1"));
    await waitForJobStatus(client, nextResponse.jobId, "completed");
    await close();
  });

  it("leases one Activity completion batch to only one mounted card", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    settings.update({ completionHandoff: "auto-handoff" }, settings.current.revision);
    const { client, rawCallTool, close } = await connectTestClient(
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
        arguments: { activityId: activity.activityId, action: "seal" }
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
    const presentationArgs = {
      presentationKind: "automatic" as const,
      activityPresentationId: secondActivity.activityPresentationId
    };
    const view = await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: secondActivity.activityId,
        cardGeneration: secondActivity.cardGeneration,
        ...presentationArgs
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const pending = (view as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: started.activityId, channel: "notify" }),
      expect.objectContaining({ activityId: secondActivity.activityId, channel: "notify" })
    ]));
    const outboxIds = pending.map((event: Record<string, any>) => event.outboxId);

    const first = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, ...presentationArgs },
      _meta: { "openai/widgetSessionId": "widget-one" }
    }));
    const second = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, ...presentationArgs },
      _meta: { "openai/widgetSessionId": "widget-two" }
    }));
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
    expect(second).toMatchObject({ claimed: false, handoffDepth: 0, events: [] });
    expect(JSON.stringify(first)).not.toContain("notification payload must not be copied");

    const failedBatch = await rawCallTool({
      name: "codex_activity_handoff",
      arguments: {
        scopeId: SCOPE_A,
        action: "delivered-batch",
        outboxIds: [outboxIds[0], 999_999_999],
        ...presentationArgs
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    expect(failedBatch.isError).toBe(true);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "release-batch", outboxIds, ...presentationArgs },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const reclaimed = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds, ...presentationArgs },
      _meta: { "openai/widgetSessionId": "widget-two" }
    }));
    expect(reclaimed.events).toHaveLength(2);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "delivered-batch", outboxIds, ...presentationArgs },
      _meta: { "openai/widgetSessionId": "widget-two" }
    });
    const after = await rawCallTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        mountedActivityId: secondActivity.activityId,
        cardGeneration: secondActivity.cardGeneration,
        ...presentationArgs
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    expect((after as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs).toEqual([]);
    await close();
  });

  it("pins new Agent contexts to the saved cwd while allowing adaptive sandbox and exact selections", async () => {
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
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    settings.update({ defaultCwd: first }, settings.current.revision);
    const firstResult = await runTask(client, {
      prompt: "first",
      agentName: "First Root",
      contextMode: "fresh"
    });
    settings.update({ defaultCwd: second }, settings.current.revision);
    const secondResult = await runTask(client, {
      prompt: "other cwd",
      agentName: "Second Root",
      contextMode: "fresh"
    });
    await runTask(client, {
      prompt: "write",
      agentName: "Writer",
      contextMode: "fresh",
      sandbox: "workspace-write"
    });
    await runTask(client, {
      prompt: "other model",
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
    ))).toEqual(new Set([path.basename(first), path.basename(second)]));
    expect(JSON.stringify(card)).not.toContain(realpathSync(first));
    expect(JSON.stringify(card)).not.toContain(realpathSync(second));

    for (const result of [firstResult, secondResult]) {
      const activityId = (result as { structuredContent?: Record<string, any> })
        .structuredContent?.bridgeActivity?.activityId;
      await client.callTool({
        name: "codex_activity_update",
        arguments: { activityId, action: "complete", reason: "accepted for history rendering" }
      });
    }
    const historyCard = await client.callTool({ name: "codex_activity", arguments: {} });
    const historyView = (historyCard as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(historyView.feed.showWorkspaceLabels).toBe(true);
    expect(new Set(historyView.feed.completed.rows.flatMap(
      (row: { workspaceLabels: string[] }) => row.workspaceLabels
    ))).toEqual(new Set([path.basename(first), path.basename(second)]));
    await close();
  });

  it("projects named project IDs and pins routing across Activities, Agents, and removal", async () => {
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
      ],
      defaultProjectId: null
    }, settings.current.revision);
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      sessions,
      new FakeModelCatalog(),
      settings
    );

    const taskDescriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task");
    const descriptorJson = JSON.stringify(taskDescriptor?.inputSchema);
    expect(descriptorJson).toContain('"const":"alpha"');
    expect(descriptorJson).toContain('"title":"알파 저장소"');
    expect(descriptorJson).toContain('"const":"beta"');
    expect(descriptorJson).toContain('"title":"Beta Workspace"');
    expect(descriptorJson).not.toContain(firstCwd);
    expect(descriptorJson).not.toContain(secondCwd);

    const missing = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "missing project", agentName: "Missing Project", contextMode: "fresh" }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("PROJECT_REQUIRED");

    const alpha = await runTask(client, {
      prompt: "work in alpha",
      projectId: "alpha",
      agentName: "Alpha Agent",
      contextMode: "fresh"
    });
    const alphaStructured = (alpha as { structuredContent?: Record<string, any> }).structuredContent!;
    const alphaActivityId = alphaStructured.bridgeActivity.activityId as string;
    const alphaAgentId = alphaStructured.bridgeActivity.agentId as string;
    expect(alphaStructured).toMatchObject({
      bridgeActivity: { projectId: "alpha", projectLabel: "알파 저장소" },
      bridgeSession: { projectId: "alpha", projectLabel: "알파 저장소" }
    });
    expect(jobs.getActivity(alphaActivityId)).toMatchObject({
      projectId: "alpha",
      projectLabel: "알파 저장소"
    });
    expect(sessions.get("thread-1")).toMatchObject({
      projectId: "alpha",
      projectLabel: "알파 저장소",
      cwd: firstCwd
    });

    const inherited = await runTask(client, {
      prompt: "add another alpha Agent",
      activityId: alphaActivityId,
      agentName: "Second Alpha Agent",
      contextMode: "fresh"
    });
    expect((inherited as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeActivity: { projectId: "alpha", projectLabel: "알파 저장소" } });
    expect(upstream.calls[1]?.args.cwd).toBe(firstCwd);

    const conflict = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must not switch repositories",
        activityId: alphaActivityId,
        agentId: alphaAgentId,
        contextMode: "continue",
        projectId: "beta"
      }
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("PROJECT_CONTEXT_CONFLICT");

    const linkedBeta = await runTask(client, {
      prompt: "continue the goal with fresh beta context",
      projectId: "beta",
      continuationOfActivityId: alphaActivityId,
      agentName: "Linked Beta Agent",
      contextMode: "fresh"
    });
    expect((linkedBeta as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: { projectId: "beta", projectLabel: "Beta Workspace" },
        bridgeSession: { projectId: "beta", projectLabel: "Beta Workspace" }
      });
    expect(upstream.calls[2]?.args.cwd).toBe(secondCwd);
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.projects).toEqual([
      { projectId: "alpha", projectLabel: "알파 저장소", available: true },
      { projectId: "beta", projectLabel: "Beta Workspace", available: true }
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
      projects: [{ id: "beta", label: "Beta Workspace", cwd: second }],
      defaultProjectId: "beta"
    }, settings.current.revision);
    const continued = await runTask(client, {
      prompt: "continue the admitted alpha thread",
      activityId: alphaActivityId,
      agentId: alphaAgentId,
      contextMode: "continue"
    });
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeSession: { projectId: "alpha", projectLabel: "알파 저장소" } });
    expect(upstream.calls[3]).toMatchObject({
      name: "codex-reply",
      args: { threadId: "thread-1" }
    });
    const removed = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "new work cannot use a removed project",
        projectId: "alpha",
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

  it("keeps an omitted effective project stable across idempotent retries", async () => {
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
      ],
      defaultProjectId: "alpha"
    }, settings.current.revision);
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const requestId = "31313131-3131-4131-8131-313131313131";
    const args = {
      requestId,
      prompt: "idempotent project turn",
      agentName: "Retry Agent",
      contextMode: "fresh",
      executionMode: "foreground"
    };

    const firstResult = await client.callTool({ name: "codex_task", arguments: args });
    settings.update({ defaultProjectId: "beta" }, settings.current.revision);
    const replay = await client.callTool({ name: "codex_task", arguments: args });
    expect((replay as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        threadId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.threadId,
        bridgeActivity: {
          activityId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity.activityId,
          jobId: (firstResult as { structuredContent?: Record<string, any> }).structuredContent?.bridgeActivity.jobId,
          projectId: "alpha"
        }
      });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(first));
    expect(jobs.listForScope(SCOPE_A)[0]).toMatchObject({
      projectId: "alpha",
      projectLabel: "Alpha",
      requestHashVersion: 3
    });

    const changed = await client.callTool({
      name: "codex_task",
      arguments: { ...args, projectId: "beta" }
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("requestId was already used for a different Codex task");
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("keeps an existing Agent thread and later turns pinned after the saved cwd changes", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const upstream = new FakeUpstream();
    const sessions = new SessionRegistry();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const settings = new UserSettingsStore(config);
    const { client, jobs, close } = await connectTestClient(
      config,
      upstream,
      sessions,
      new FakeModelCatalog(),
      settings
    );

    settings.update({ defaultCwd: first }, settings.current.revision);
    const started = await runTask(client, {
      prompt: "start in the first folder",
      agentName: "Pinned Cwd Agent",
      contextMode: "fresh"
    });
    const startedStructured = (started as { structuredContent?: Record<string, any> })
      .structuredContent!;
    const activityId = startedStructured.bridgeActivity.activityId as string;
    const agentId = startedStructured.bridgeActivity.agentId as string;
    settings.update({ defaultCwd: second }, settings.current.revision);
    await runTask(client, {
      prompt: "continue after the default changes",
      activityId,
      agentId,
      contextMode: "continue"
    });

    expect(sessions.get("thread-1")?.cwd).toBe(realpathSync(first));
    expect(jobs.listForAgent(agentId).map((job) => job.cwd)).toEqual([
      realpathSync(first),
      realpathSync(first)
    ]);
    expect(settings.current.defaultCwd).toBe(realpathSync(second));
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply"]);
    await close();
  });

  it("renders one scoped flat feed and folds completed work by Agent", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const { client, close } = await connectTestClient(
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
      arguments: { activityId, action: "complete" }
    });
    const agentsResult = await client.callTool({
      name: "codex_activity",
      arguments: { activityId, forceNewCard: true }
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
    await runTask(client, { prompt: "first", sessionMode: "new" });

    await runTask(client, {
      prompt: "continue",
      sessionMode: "continue",
      threadId: "thread-1"
    });
    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "continue", _bridgeBackendKind: "mcp-server" }
    });

    const unknown = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue", sessionMode: "continue", threadId: "missing" }
    });
    expect(unknown.isError).toBe(true);

    const modelChange = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "switch",
        sessionMode: "continue",
        threadId: "thread-1",
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
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );

    const waiting = client.callTool({
      name: "codex_status",
      arguments: { jobId: started.jobId, waitFor: "terminal", waitMs: 1000 }
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
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "cancel me", sessionMode: "new" } })
    );

    const denied = await client.callTool({
      name: "codex_cancel",
      arguments: { scopeId: SCOPE_B, jobId: started.jobId }
    });
    expect(denied.isError).toBe(true);
    expect(upstream.aborts).toBe(0);

    const cancelled = parseToolJson(
      await client.callTool({
        name: "codex_cancel",
        arguments: { scopeId: SCOPE_A, jobId: started.jobId }
      })
    );
    expect(cancelled).toMatchObject({ status: "cancelled", terminal: true });
    expect(cancelled.error).toContain("Partial filesystem changes may remain");
    expect(upstream.aborts).toBe(1);

    const repeated = parseToolJson(
      await client.callTool({
        name: "codex_cancel",
        arguments: { scopeId: SCOPE_A, jobId: started.jobId }
      })
    );
    expect(repeated.status).toBe("cancelled");
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
      arguments: { scopeId: SCOPE_A, jobId: first.jobId, expectedVersion: current.version - 1 }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("version changed");
    expect(upstream.aborts).toBe(0);

    const unconfirmed = await client.callTool({
      name: "codex_cancel",
      arguments: { scopeId: SCOPE_A, jobId: first.jobId, expectedVersion: current.version }
    });
    expect(unconfirmed.isError).toBe(true);
    expect(JSON.stringify(unconfirmed)).toContain("acknowledgeAffectedJobIds");
    expect(upstream.aborts).toBe(0);

    const affected = [first.jobId, second.jobId].sort();
    const stopped = parseToolJson(await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        jobId: first.jobId,
        expectedVersion: current.version,
        acknowledgeAffectedJobIds: affected
      }
    }));
    expect(stopped).toMatchObject({ status: "cancelled", processLiveness: "worker-lost" });
    expect(jobs.get(first.jobId)).toMatchObject({ status: "cancelled", trackingState: "worker-lost" });
    expect(jobs.get(second.jobId)).toMatchObject({
      status: "interrupted",
      trackingState: "worker-lost",
      error: expect.stringContaining(`force-stopped job ${first.jobId}`)
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
        jobId: "missing-job",
        acknowledgeAffectedJobIds: acknowledged
      }
    });
    expect(jobCancellation.isError).toBe(true);
    expect(JSON.stringify(jobCancellation)).toContain("Unknown Codex job id");

    const activityCancellation = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        scopeId: SCOPE_A,
        activityId: SCOPE_B,
        action: "cancel",
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
      arguments: { waitFor: "terminal", waitMs: 10 }
    });
    const missingMode = await client.callTool({
      name: "codex_status",
      arguments: { jobId: "missing", waitMs: 10 }
    });

    expect(JSON.stringify(missingJob)).toContain("require a jobId");
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

  it("requires a registered project for multiple roots and retires every per-call cwd override", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const outside = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const upstream = new FakeUpstream();
    const { client, jobs, close } = await connectTestClient(config, upstream);

    const missing = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", agentName: "Missing Cwd", contextMode: "fresh" }
    });
    expect(JSON.stringify(missing)).toContain("PROJECT_REQUIRED");
    expect(jobs.listAgents(SCOPE_A, true)).toEqual([]);
    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", agentName: "Retired Cwd", contextMode: "fresh", cwd: outside }
    });
    expect(JSON.stringify(denied)).toContain("CWD_OVERRIDE_RETIRED");
    const invalidSave = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, defaultCwd: outside }
    });
    expect(invalidSave.isError).toBe(true);
    expect(JSON.stringify(invalidSave)).toContain("outside allowed roots");
    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, defaultCwd: first }
    });
    expect(saved.isError).not.toBe(true);
    await runTask(client, { prompt: "inspect saved", agentName: "Saved Cwd", contextMode: "fresh" });
    expect(upstream.calls[0]?.args.cwd).toBe(realpathSync(first));
    await close();
  });

  it("blocks sensitive files on start and rechecks before continuation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "first", sessionMode: "new" });
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");

    const continued = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue", sessionMode: "continue", threadId: "thread-1" }
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
      arguments: { prompt: "second implicit auto", activityId: first.activityId }
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
  userSettings: UserSettingsStore = new UserSettingsStore(config),
  jobs?: CodexJobRegistry
) {
  const jobRegistry = jobs || new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    allowedRoots: config.allowedRoots
  });
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobRegistry,
    modelCatalog,
    userSettings
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
        const requestId = typeof arguments_.requestId === "string"
          ? arguments_.requestId
          : nextRequestId();
        const activityPresentationId =
          typeof arguments_.activityPresentationId === "string"
            ? arguments_.activityPresentationId
            : requestId;
        const createsActivity = !arguments_.activityId;
        const createsUnattachedAgent =
          !arguments_.agentId &&
          !arguments_.agentName &&
          createsActivity &&
          !arguments_.continuationOfActivityId &&
          !arguments_.threadId;
        const testAgentName = `Test Agent ${requestId.replaceAll("-", "").slice(-8)}`;
        const createsNamedAgent = Boolean(arguments_.agentName && !arguments_.agentId);
        const needsCreationMetadata = createsActivity || createsNamedAgent;
        const selectedAgent = typeof arguments_.agentId === "string"
          ? jobRegistry.getAgent(arguments_.agentId)
          : undefined;
        const inferredContextMode = arguments_.sessionMode === "continue" || arguments_.threadId
          ? "continue"
          : arguments_.sessionMode === "new" || arguments_.agentName || createsUnattachedAgent
            ? "fresh"
            : selectedAgent?.currentThreadId
              ? "continue"
              : arguments_.continuationOfActivityId
                ? "continue"
                : "fresh";
        return rawCallTool(
          {
            ...request,
            arguments: {
              scopeId: SCOPE_A,
              requestId,
              activityPresentationId,
              ...(createsUnattachedAgent ? { agentName: testAgentName } : {}),
              ...(needsCreationMetadata && !arguments_.agentRole
                ? { agentRole: "test role" }
                : {}),
              ...(createsActivity && !arguments_.activityTitle
                ? { activityTitle: `Test Activity ${requestId.replaceAll("-", "").slice(-8)}` }
                : {}),
              ...(createsActivity && !arguments_.activityKind
                ? { activityKind: "other" }
                : {}),
              ...(needsCreationMetadata && !arguments_.contextMode
                ? { contextMode: inferredContextMode }
                : {}),
              ...arguments_
            }
          },
          ...(rest as [])
        );
      }
      if (
        (
          request.name === "codex_status" ||
          request.name === "codex_activity" ||
          request.name === "codex_activity_update" ||
          request.name === "codex_agent" ||
          request.name === "codex_agent_recovery_detach" ||
          request.name === "codex_background_process_terminate"
        ) &&
        !arguments_.scopeId &&
        !arguments_.includeAllScopes
      ) {
        return rawCallTool(
          { ...request, arguments: { scopeId: SCOPE_A, ...arguments_ } },
          ...(rest as [])
        );
      }
      return rawCallTool(request, ...(rest as []));
    }
  });
  return {
    client,
    rawCallTool,
    jobs: jobRegistry,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

async function runTask(client: Client, arguments_: Record<string, unknown>): Promise<unknown> {
  return client.callTool({
    name: "codex_task",
    arguments: { executionMode: "foreground", ...arguments_ }
  });
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

function model(id: string, defaultEffort: string, efforts: string[], isDefault = false) {
  return {
    id,
    displayName: id,
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
