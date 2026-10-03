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
import { CodexJobRegistry } from "../src/tools.js";
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

describe("#221 delivery transition", () => {
  let root: string;
  let state: BridgeStateStore;
  let settings: UserSettingsStore;
  let config: ReturnType<typeof loadConfig>;
  let client: Client;
  let server: BridgeHttpServer;
  let upstream: FixtureUpstream;
  let endpoint: URL;

  let registry: CodexJobRegistry;
  beforeEach(async () => {
    const original = CodexJobRegistry.prototype.start;
    vi.spyOn(CodexJobRegistry.prototype, "start").mockImplementation(function(input, ...rest) {
      registry = this;
      return original.call(this, input, ...rest);
    });
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
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function admit(extra: Record<string, unknown> = {}) {
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    return client.callTool({ name: "codex_task", _meta: metadata, arguments: {
      requestId: randomUUID(), taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const, prompt: "Fixture A", selection,
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision }, ...extra
    } });
  }
  async function exact(jobId: string) {
    await vi.waitFor(() => expect(registry.get(jobId)?.status).toBe("completed"));
    const result = await client.callTool({ name: "codex_status", _meta: metadata,
      arguments: { query: { kind: "job", id: jobId } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as any;
  }
  async function followup(reference: any, version: number, prompt = "Fixture B") {
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as any;
    return client.callTool({ name: "codex_task", _meta: metadata, arguments: {
      requestId: reference.requestId, taskContractVersion: properties.taskContractVersion.const,
      executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt,
      followup: { followupId: reference.followupId, reviewedVersion: version }
    } });
  }
  // Seed historical data only in this disposable fixture. The production
  // migration must never perform these policy rewrites or regenerate receipts.
  function historical(policy: "live-card" | "events") {
    const db = new Database(path.join(root, "state.sqlite"));
    try {
      for (const job of state.listJobs()) {
        registry.get(job.jobId)!.completionDeliveryPolicy = policy;
        db.prepare("UPDATE jobs SET payload=json_set(payload,'$.completionDeliveryPolicy',?) WHERE job_id=?").run(policy, job.jobId);
      }
      for (const row of state.listMeta("task_followup_v1/", 100)) {
        state.setMeta(row.key, JSON.stringify({ ...JSON.parse(row.value), completionDeliveryPolicy: policy }));
      }
    } finally { db.close(); }
  }
  it.each([false, true])("uses direct-wait for the legacy switch value %s", async legacy => {
    settings.update({ experimentalDirectResultDelivery: legacy }, settings.current.revision);
    const result = await admit();
    expect(result.structuredContent).toMatchObject({ completionDeliveryPolicy: "direct-wait" });
    expect(JSON.stringify((result.structuredContent as any).nextActions)).not.toContain("codex_dashboard");
    expect(result._meta).not.toHaveProperty("openai/outputTemplate");
    await exact((result.structuredContent as any).jobId);
  });
  it("keeps the entire ordinary path independent of Events", async () => {
    const tools = await client.listTools();
    const task = tools.tools.find(tool => tool.name === "codex_task")!;
    expect(task.inputSchema.properties).not.toHaveProperty("completionDelivery");
    expect(tools.tools.some(tool => tool.name === "codex_event_access")).toBe(false);
    expect(task.description).not.toMatch(/subscriptionRef|codex_event_access|opt-in events/i);
    const a = await admit({ approvedFollowups: [{ prompt: "Fixture B" }] });
    const parent = await exact((a.structuredContent as any).jobId);
    const reference = parent.items[0].approvedFollowups[0];
    const b = await followup(reference, parent.items[0].versions.job);
    expect(b.isError, JSON.stringify(b)).not.toBe(true);
    const bId = (b.structuredContent as any).jobId;
    await exact(bId);
    const replay = await followup(reference, parent.items[0].versions.job);
    expect(replay.structuredContent).toMatchObject({ jobId: bId, replay: true });
    expect(upstream.calls).toHaveLength(2);
  });
  it.each(["live-card", "events"] as const)("rejects an unadmitted historical %s followup without modifying approval", async policy => {
    const a = await admit({ approvedFollowups: [{ prompt: "Fixture B" }] });
    const parent = await exact((a.structuredContent as any).jobId);
    historical(policy);
    const reference = parent.items[0].approvedFollowups[0];
    const before = state.listMeta("task_followup_v1/", 100);
    const hashes = state.listJobs().map(job => job.requestHash);
    const rejected = await followup(reference, parent.items[0].versions.job);
    expect(rejected.structuredContent).toMatchObject({ jobId: null, error: { code: "FOLLOWUP_DELIVERY_RETIRED" } });
    expect(state.listMeta("task_followup_v1/", 100)).toEqual(before);
    expect(state.listJobs().map(job => job.requestHash)).toEqual(hashes);
    expect(upstream.calls).toHaveLength(1);
    const reapproved = await admit({ prompt: "Fixture B", project: undefined, selection: undefined,
      activity: { mode: "existing", id: parent.items[0].activityId },
      agent: { mode: "existing", id: parent.items[0].agentId, context: "continue" } });
    expect(reapproved.isError, JSON.stringify(reapproved)).not.toBe(true);
    expect(reapproved.structuredContent).toMatchObject({ completionDeliveryPolicy: "direct-wait" });
    await exact((reapproved.structuredContent as any).jobId);
    expect(state.listMeta("task_followup_v1/", 100)).toEqual(before);
  });
  it.each(["live-card", "events"] as const)("replays an already admitted historical %s B before retired-policy rejection", async policy => {
    const a = await admit({ approvedFollowups: [{ prompt: "Fixture B" }] });
    const parent = await exact((a.structuredContent as any).jobId);
    const reference = parent.items[0].approvedFollowups[0];
    const b = await followup(reference, parent.items[0].versions.job);
    const bId = (b.structuredContent as any).jobId;
    await exact(bId);
    historical(policy);
    const before = state.listMeta("task_followup_v1/", 100);
    const hashes = state.listJobs().map(job => job.requestHash);
    const replay = await followup(reference, parent.items[0].versions.job);
    expect(replay.structuredContent).toMatchObject({ jobId: bId, replay: true });
    expect(upstream.calls).toHaveLength(2);
    expect(state.listMeta("task_followup_v1/", 100)).toEqual(before);
    expect(state.listJobs().map(job => job.requestHash)).toEqual(hashes);
    const result = await exact(bId);
    expect(result.items[0].answer).toBe("Completed fixture work.");
  });
  it("continues bounded reads of the same historical active live-card Job", async () => {
    const held = upstream.holdNextCall();
    const a = await admit(); const id = (a.structuredContent as any).jobId;
    await held.started; historical("live-card");
    const hash = registry.get(id)!.requestHash;
    const read = await client.callTool({ name: "codex_status", _meta: metadata,
      arguments: { query: { kind: "job", id, waitFor: "terminal", waitMs: 1 } } });
    expect(read.structuredContent).toMatchObject({ items: [expect.objectContaining({ id, state: "running", wait: { timedOut: true } })] });
    expect(JSON.stringify(read.structuredContent)).not.toContain('"tool":"codex_dashboard"');
    expect(JSON.stringify(read.structuredContent)).toContain('"waitFor":"terminal"');
    expect(registry.get(id)!.requestHash).toBe(hash);
    expect(upstream.calls).toHaveLength(1);
    held.release(); await exact(id);
  });
});
