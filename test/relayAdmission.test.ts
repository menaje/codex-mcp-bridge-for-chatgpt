import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";
import {
  BRIDGE_MCP_INSTRUCTIONS, EXPERIMENTAL_EVENTS_MCP_INSTRUCTIONS,
  createHttpServer, type BridgeHttpServer
} from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import type {
  CodexInteractionResponse, CodexProgress, CodexUpstream,
  ToolResult, UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

// Functional ordering uses explicit upstream releases and committed terminal
// notifications only. No sleep, elapsed-time assertion, fake clock, shortened
// expiry, production database, host receiver or actual Codex execution is used.
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type HeldCall = {
  started: ReturnType<typeof barrier<void>>;
  result: ReturnType<typeof barrier<ToolResult>>;
  progress?: (value: CodexProgress) => void;
  release(text?: string): void;
};

class ControlledUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly answers: Array<{ interactionId: string; response: CodexInteractionResponse }> = [];
  readonly holds: HeldCall[] = [];
  private readonly queue: HeldCall[] = [];
  readonly threadId = randomUUID();

  hold(): HeldCall {
    const started = barrier<void>();
    const result = barrier<ToolResult>();
    const held: HeldCall = {
      started, result,
      release: (text = "Fixture result") => result.resolve({
        structuredContent: { threadId: this.threadId, content: text },
        content: [{ type: "text", text }]
      })
    };
    this.queue.push(held);
    this.holds.push(held);
    return held;
  }

  async listTools() { return { tools: [{ name: "codex" }, { name: "codex-reply" }] }; }
  async callTool(name: string, args: Record<string, unknown>,
    onProgress?: (value: CodexProgress) => void,
    onAssigned?: (value: UpstreamWorkerAssignment) => void): Promise<ToolResult> {
    this.calls.push({ name, args });
    const held = this.queue.shift();
    if (!held) throw new Error("Unexpected execution without an explicit fixture release");
    held.progress = onProgress;
    onAssigned?.({ backendKind: "app-server", workerId: "issue261-fixture-worker",
      workerGeneration: 1, threadId: this.threadId, upstreamRequestId: "fixture-turn" });
    held.started.resolve();
    return held.result.promise;
  }
  async respondToInteraction(interactionId: string, response: CodexInteractionResponse) {
    this.answers.push({ interactionId, response });
    throw new Error("Synthetic reply loss after answer dispatch");
  }
  async close() {}
}

const metadata = { "openai/session": "issue261-original-conversation" };
const foreignMetadata = { "openai/session": "issue261-other-conversation" };
const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const catalog: CodexModelCatalogProvider = {
  async getCatalog() { return this.getCachedCatalog()!; },
  getCachedCatalog() {
    return { source: "codex-cli", fetchedAt: "2026-10-13T00:00:00Z",
      validatedAt: "2026-10-13T00:00:00Z", fingerprint: "f".repeat(64),
      cached: true, stale: false, validation: "valid",
      models: [{ id: selection.model, displayName: "Fixture Sol", isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ effort: "medium" }],
        serviceTiers: [], inputModalities: ["text"] }] };
  }
};

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
type Task = { jobId: string; requestId: string; activityId: string; agentId: string;
  jobVersion: number; approvedFollowups: Array<{ followupId: string; requestId: string }> | null };
type ExactJob = { id: string; state: string; answer: string; activityId: string; agentId: string;
  versions: { job: number }; approvedFollowups?: Array<{ followupId: string; requestId: string }> };

function taskResult(result: CallResult): Task {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as unknown as Task;
}

describe("#261 bounded followup contracts", () => {
  let root: string;
  let config: ReturnType<typeof loadConfig>;
  let state: BridgeStateStore;
  let settings: UserSettingsStore;
  let upstream: ControlledUpstream;
  let registry: CodexJobRegistry | undefined;
  let server: BridgeHttpServer;
  let client: Client;
  let endpoint: URL;
  let envelope: { taskContractVersion: string; executionEnvelopeRef: string };

  async function connect() {
    server = createHttpServer(config, upstream, catalog, { stateStore: state });
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    endpoint = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    client = new Client({ name: "issue261-functional-fixture", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const task = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
    const properties = task.inputSchema.properties as Record<string, { const: string }>;
    envelope = { taskContractVersion: properties.taskContractVersion.const,
      executionEnvelopeRef: properties.executionEnvelopeRef.const };
  }

  beforeEach(async () => {
    registry = undefined;
    const original = CodexJobRegistry.prototype.start;
    vi.spyOn(CodexJobRegistry.prototype, "start").mockImplementation(function(input, ...rest) {
      registry = this;
      return original.call(this, input, ...rest);
    });
    root = await mkdtemp(path.join(tmpdir(), "issue261-functional-"));
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json") });
    settings = new UserSettingsStore(config, { stateStore: state });
    settings.update({ modelPolicy: { mode: "fixed", selection,
      constraints: { allowDelegation: false } } }, settings.current.revision);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }],
      undefined, settings.current.registryRevision);
    upstream = new ControlledUpstream();
    await connect();
  });

  // The notification happens after the original terminal transaction commits.
  // Subscribe before release; the recheck also covers already committed Jobs.
  function terminal(jobId: string): Promise<void> {
    return new Promise<void>(done => {
      const check = () => {
        if (state.listJobs().some(job => job.jobId === jobId &&
          ["completed", "failed", "interrupted", "cancelled"].includes(job.status))) {
          unsubscribe();
          done();
        }
      };
      const unsubscribe = registry!.subscribeChanges(check);
      check();
    });
  }

  async function finish(job: Task, hold: HeldCall, text = "Fixture result") {
    await hold.started.promise;
    const committed = terminal(job.jobId);
    hold.release(text);
    await committed;
    expect(state.listJobs().find(current => current.jobId === job.jobId)!.status).toBe("completed");
  }

  afterEach(async () => {
    for (const hold of upstream.holds) hold.release();
    if (registry) {
      for (const job of state.listJobs()) {
        if (job.status === "running") await terminal(job.jobId);
      }
    }
    await client?.close();
    if (server?.listening) await new Promise<void>(done => server.close(() => done()));
    state.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function call(name: string, args: Record<string, unknown>, meta = metadata) {
    return client.callTool({ name, arguments: args, _meta: meta });
  }
  function task(args: Record<string, unknown>, meta = metadata) {
    return call("codex_task", { ...envelope, ...args }, meta);
  }
  function initial(extra: Record<string, unknown> = {}) {
    const project = settings.current.projects[0]!;
    return task({ requestId: randomUUID(), prompt: "Implement and review the fixture goal",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      ...extra });
  }
  function continuation(a: Task, prompt = "Apply the correction found by reviewing A") {
    return { requestId: randomUUID(), prompt, activity: { mode: "existing", id: a.activityId },
      agent: { mode: "existing", id: a.agentId, context: "continue" } };
  }
  async function exact(jobId: string): Promise<ExactJob> {
    const result = await call("codex_status", { query: { kind: "job", id: jobId } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent as unknown as { items: ExactJob[] }).items[0]!;
  }
  async function restart() {
    await client.close();
    await new Promise<void>(done => server.close(() => done()));
    state.close();
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    settings = new UserSettingsStore(config, { stateStore: state });
    upstream = new ControlledUpstream();
    registry = undefined;
    await connect();
  }

  it("automatically connects execution and answer descriptors while keeping reads and internal relay responses card-free", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(19);
    for (const name of ["codex_task", "codex_answer"]) {
      expect(tools.find(tool => tool.name === name)!._meta).toMatchObject({ ui: { resourceUri: "ui://codex-mcp-bridge/relay/v1.html" } });
    }
    for (const name of ["codex_status", "codex_relay", "codex_relay_wait"]) {
      expect(tools.find(tool => tool.name === name)!._meta || {}).not.toHaveProperty("openai/outputTemplate");
    }
    const hold = upstream.hold(), result = await initial(), a = taskResult(result);
    expect(result.structuredContent).toMatchObject({ completionDeliveryPolicy: "relay-card" });
    const open = (result._meta as any)["codex/relayOpen@1"];
    expect(open).toMatchObject({ jobId: a.jobId, activityId: a.activityId, contractGeneration: 1 });
    const cardId = randomUUID(), base = { contractGeneration: 1, activityId: a.activityId, cardId };
    const connected = await call("codex_relay", { ...base, action: "connect", inputRequestId: open.inputRequestId, presentationRef: open.presentationRef });
    expect(connected.isError, JSON.stringify(connected)).not.toBe(true);
    expect(connected._meta || {}).not.toHaveProperty("openai/outputTemplate");
    const blank = await call("codex_relay_wait", { ...base, waitMs: 0 });
    expect(blank.structuredContent).toMatchObject({ events: [], stopped: false });
    expect(blank._meta || {}).not.toHaveProperty("openai/outputTemplate");
    await finish(a, hold);
    const event = state.relay.registration(a.jobId)!.event!;
    const attemptId = randomUUID();
    expect((await call("codex_relay", { ...base, action: "claim", eventId: event.eventId, attemptId })).structuredContent).toMatchObject({ event: { state: "leased" } });
    expect((await call("codex_relay", { ...base, action: "enter", eventId: event.eventId, attemptId })).structuredContent).toMatchObject({ dispatch: true });
    expect((await call("codex_relay", { ...base, action: "ack", eventId: event.eventId, attemptId, outcome: "accepted" })).structuredContent).toMatchObject({ event: { state: "accepted" } });
    const read = await call("codex_status", { query: { kind: "job", id: a.jobId } });
    expect(read._meta || {}).not.toHaveProperty("codex/relayOpen@1");
    expect(read._meta || {}).not.toHaveProperty("openai/outputTemplate");
    expect(JSON.stringify(read.structuredContent)).toContain(event.eventId);
    expect((await call("codex_relay_wait", { ...base, waitMs: 0 }, foreignMetadata)).isError).toBe(true);
    expect((await call("codex_status", { scopeId: state.getRelayJobSnapshot(a.jobId)!.scopeId, query: { kind: "job", id: a.jobId } }, {})).isError).toBe(true);
    expect((await call("codex_relay", { ...base, contractGeneration: 0, action: "connect", inputRequestId: open.inputRequestId, presentationRef: open.presentationRef })).isError).toBe(true);
  });

  it("binds dynamic B atomically through admission response loss, different caller IDs, concurrent replay and restart", async () => {
    const aHold = upstream.hold(), a = taskResult(await initial()); await finish(a, aHold);
    const reviewed = await exact(a.jobId), event = state.relay.registration(a.jobId)!.event!;
    const reference = { eventId: event.eventId, step: "apply-review-correction", reviewedVersion: reviewed.versions.job };
    const bArgs = { ...envelope, ...continuation(a), relayFollowup: reference };
    const canonical = state.taskFollowups.dynamicIdentity(state.getEventJobSnapshot(a.jobId)!.scopeId, reference);
    const bHold = upstream.hold();
    const lossy = new Client({ name: "relay-response-loss", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    let drop = true;
    const lossyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (drop && typeof init?.body === "string" && init.body.includes('"name":"codex_task"')) {
        drop = false; await response.body?.cancel(); throw new TypeError("Synthetic relay B response loss");
      }
      return response;
    };
    await lossy.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));
    try {
      await expect(lossy.callTool({ name: "codex_task", arguments: bArgs, _meta: metadata })).rejects.toThrow("Synthetic relay B response loss");
      await bHold.started.promise;
      const [b, replay] = (await Promise.all([task({ ...bArgs, requestId: randomUUID() }), task({ ...bArgs, requestId: randomUUID() })])).map(taskResult);
      expect(replay.jobId).toBe(b.jobId); expect(b.requestId).toBe(canonical.requestId); expect(upstream.calls).toHaveLength(2);
      expect(state.relay.registration(b.jobId)?.activityId).toBe(a.activityId);
      expect((await exact(a.jobId)).approvedFollowups).toContainEqual({ ...canonical, status: "admitted" });
      const page = await call("codex_status", { query: { kind: "followups", jobId: a.jobId } });
      expect(page.structuredContent).toMatchObject({ kind: "followups", receipts: [{ ...canonical, status: "admitted" }], after: null });
      expect(page._meta || {}).not.toHaveProperty("openai/outputTemplate");
      expect((await call("codex_status", { query: { kind: "followups", jobId: a.jobId } }, foreignMetadata)).isError).toBe(true);
      expect(taskResult(await task({ ...bArgs, requestId: randomUUID(), relayFollowup: { ...reference, reviewedVersion: reference.reviewedVersion + 1 } })).jobId).toBe(b.jobId);
      expect((await task({ ...bArgs, requestId: randomUUID(), prompt: "Changed payload" })).structuredContent).toMatchObject({ error: { code: "FOLLOWUP_ADMISSION_CONFLICT" } });
      await finish(b, bHold, "B original result");
      expect(state.relay.registration(b.jobId)?.event?.kind).toBe("terminal");
      expect(state.deleteJob(b.jobId)).toBe(true);
      await restart();
      expect(taskResult(await task({ ...bArgs, requestId: randomUUID() })).jobId).toBe(b.jobId);
      expect(upstream.calls).toHaveLength(0); expect((await exact(b.jobId)).answer).toContain("B original result");
    } finally { bHold.release(); await lossy.close(); }
  });

  it("keeps legitimate parallel steps and a Worker to Reviewer transition in the same goal", async () => {
    settings.update({ maxConcurrentJobs: 2 }, settings.current.revision);
    const aHold = upstream.hold(), a = taskResult(await initial()); await finish(a, aHold);
    const reviewed = await exact(a.jobId), eventId = state.relay.registration(a.jobId)!.event!.eventId;
    const workerHold = upstream.hold(), worker = taskResult(await task({ ...continuation(a), relayFollowup: { eventId, step: "fix", reviewedVersion: reviewed.versions.job } }));
    await workerHold.started.promise;
    // A fresh Codex thread belongs to the new Reviewer, with ordinary project
    // admission and no transfer of another Activity's ownership.
    Object.defineProperty(upstream, "threadId", { value: randomUUID() });
    const reviewerHold = upstream.hold(), project = settings.current.projects[0]!;
    const reviewer = taskResult(await task({ requestId: randomUUID(), prompt: "Independently review the same approved goal",
      activity: { mode: "existing", id: a.activityId }, agent: { mode: "new", name: "Reviewer" },
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      relayFollowup: { eventId, step: "review", reviewedVersion: reviewed.versions.job } }));
    expect(reviewer.agentId).not.toBe(worker.agentId); expect(reviewer.requestId).not.toBe(worker.requestId);
    expect(state.relay.registration(reviewer.jobId)?.activityId).toBe(a.activityId);
    await finish(worker, workerHold); await finish(reviewer, reviewerHold);
    expect(state.relay.pending(a.activityId).map(event => event.jobId)).toEqual(expect.arrayContaining([a.jobId, worker.jobId, reviewer.jobId]));
  });

  it("requires the current exact source offer and original owner, and preserves followup stops", async () => {
    const aHold = upstream.hold(), a = taskResult(await initial()); await finish(a, aHold);
    const eventId = state.relay.registration(a.jobId)!.event!.eventId;
    const args = { ...continuation(a), relayFollowup: { eventId, step: "next", reviewedVersion: state.getEventJobSnapshot(a.jobId)!.version! } };
    expect((await task(args)).structuredContent).toMatchObject({ error: { code: "FOLLOWUP_REVIEW_REQUIRED" } });
    await exact(a.jobId);
    expect((await task(args, foreignMetadata)).isError).toBe(true);
    expect((await task({ ...args, activity: { mode: "existing", id: randomUUID() } })).isError).toBe(true);
    expect((await task({ ...args, relayFollowup: { ...args.relayFollowup, reviewedVersion: 1 } })).isError).toBe(true);
    expect((await call("codex_relay_control", { activityId: a.activityId, stop: "followups" })).isError).not.toBe(true);
    expect((await task(args)).isError).toBe(true); expect(state.listJobs()).toHaveLength(1);
    expect(state.getEventJobSnapshot(a.jobId)?.status).toBe("completed");
  });

  it("describes automatic relay consistently in running exact status and its next actions", async () => {
    const hold = upstream.hold(), a = taskResult(await initial());
    await hold.started.promise;
    const result = await call("codex_status", { query: { kind: "job", id: a.jobId } });
    const item = (result.structuredContent as any).items[0];
    expect(item.completionDeliveryPolicy).toBe("relay-card");
    expect(item.message).toMatch(/automatic relay/i);
    expect(item.message).not.toContain("direct result delivery");
    expect(item.message).toContain("optional");
    expect(JSON.stringify(item.nextActions)).toContain("relay");
    expect(JSON.stringify(item.nextActions)).not.toContain("bounded terminal wait");
    await finish(a, hold);
  });

  it.each(["relay", "followups", "ended"] as const)("reflects the current %s stop in status without changing execution or other stop semantics", async stop => {
    const hold = upstream.hold(), a = taskResult(await initial()); await hold.started.promise;
    if (stop === "ended") state.transaction(() => state.relay.endActivity(a.activityId));
    else expect((await call("codex_relay_control", { activityId: a.activityId, stop })).isError).not.toBe(true);
    const result = await call("codex_status", { query: { kind: "job", id: a.jobId } });
    const item = (result.structuredContent as any).items[0], next = JSON.stringify(item.nextActions);
    expect(item.state).toBe("running"); expect(item.completionDeliveryPolicy).toBe("relay-card");
    expect(item.message).not.toContain("direct result delivery");
    if (stop === "followups") {
      expect(item.message).toMatch(/automatic relay.*enabled/i);
      expect(item.message).toContain("Future followup admission is stopped");
      expect(next).toContain("Future followup admission is stopped");
    } else {
      const guidance = stop === "relay" ? "Automatic relay is stopped" : "automatic relay is closed";
      expect(item.message).toContain(guidance); expect(next).toContain(guidance);
      expect(next).not.toContain("remains connected");
    }
    await finish(a, hold);
    expect(state.relay.pending(a.activityId)).toHaveLength(stop === "followups" ? 1 : 0);
  });
});
