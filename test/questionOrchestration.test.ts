import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";
import { USER_QUESTION_META } from "../src/questionTools.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import type { CodexPendingInteraction, CodexProgress, CodexUpstream, ToolResult, UpstreamWorkerAssignment } from "../src/upstream.js";

const field = { id: "color", header: "Color", question: "Which color?", isOther: false,
  options: [{ label: "Blue", description: "Blue option" }, { label: "Red", description: "Red option" }] };
const meta = { "openai/session": "question-test-conversation" };
const otherMeta = { "openai/session": "different-question-conversation" };
const catalog: CodexModelCatalogSnapshot = {
  source: "codex-cli", fetchedAt: new Date().toISOString(), validatedAt: new Date().toISOString(), fingerprint: "a".repeat(64),
  cached: true, stale: false, validation: "valid", models: [{ id: "gpt-5.6-sol", displayName: "Fixture", defaultReasoningEffort: "max",
    supportedReasoningEfforts: [{ effort: "max" }], serviceTiers: [], inputModalities: ["text"] }]
};

describe("GPT question orchestration", () => {
  let root: string, store: BridgeStateStore, jobs: CodexJobRegistry, client: Client;
  let server: ReturnType<typeof createBridgeMcpServer>, settings: UserSettingsStore;
  let emit: ((progress: CodexProgress) => void) | undefined, finish: ((result: ToolResult) => void) | undefined;
  let delivered: unknown[];
  let assign: ((worker: UpstreamWorkerAssignment) => void) | undefined, deliveryFailure: boolean;
  const call = async (name: string, args: object = {}, metadata: Record<string, unknown> = meta) =>
    await client.callTool({ name, arguments: args as Record<string, unknown>, _meta: metadata }) as any;
  const ok = async (name: string, args: object = {}, metadata: Record<string, unknown> = meta) => {
    const result = await call(name, args, metadata);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result;
  };
  const start = async () => {
    const project = settings.current.projects[0];
    const result = await ok("codex_task", { requestId: randomUUID(), taskContractVersion: "2",
      executionEnvelopeRef: settings.taskExecutionEnvelopeRef(), prompt: "Synthetic question test", executionMode: "background",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision } });
    return result.structuredContent.jobId as string;
  };
  const question = (overrides: Partial<CodexPendingInteraction> = {}) => {
    const input: CodexPendingInteraction = { interactionId: "fixture:1:question", kind: "user-input", origin: "codex-question",
      isBlocking: false, threadId: "fixture-thread", turnId: "fixture-turn", itemId: "fixture-item", summary: "Color choice",
      questions: [{ ...field, isSecret: false }], ...overrides };
    emit?.({ progress: 1, event: { eventId: randomUUID(), type: "input-required", phase: "updated",
      createdAt: Date.now(), summary: input.summary, details: { interaction: input } } });
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gpt-questions-"));
    store = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
    settings = new UserSettingsStore(config, { stateStore: store });
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }], undefined, 0);
    jobs = new CodexJobRegistry({ allowedRoots: [root], stateStore: store });
    delivered = [];
    deliveryFailure = false;
    const upstream: CodexUpstream = {
      async listTools() { return { tools: [{ name: "codex" }] }; },
      async callTool(_name, _args, progress, assigned) {
        emit = progress;
        assign = assigned;
        assigned?.({ backendKind: "app-server", workerId: "fixture-worker", workerGeneration: 1,
          threadId: "fixture-thread", upstreamRequestId: "fixture-turn" });
        return new Promise(resolve => { finish = resolve; });
      },
      async respondToInteraction(id, response) {
        delivered.push({ id, response }); await new Promise(resolve => setTimeout(resolve, 5));
        if (deliveryFailure) throw new Error("Connection lost after dispatch");
      },
      async close() {}
    };
    server = createBridgeMcpServer(config, upstream, new SessionRegistry({ stateStore: store }), jobs,
      { getCatalog: async () => catalog, getCachedCatalog: () => catalog }, settings);
    client = new Client({ name: "question-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
  });
  afterEach(async () => {
    vi.useRealTimers();
    finish?.({ content: [{ type: "text", text: "Fixture complete" }] });
    await Promise.all(jobs.list(100).map(j => j.promise));
    await client.close(); await server.close(); store.close();
    await rm(root, { recursive: true, force: true });
    emit = undefined; finish = undefined; assign = undefined;
  });

  it("binds global user controls to exact displayed work without granting GPT cross-conversation access", async () => {
    const jobId = await start();
    question({ kind: "command-approval", origin: "app-approval", interactionId: "approval-1", isBlocking: true,
      questions: undefined, availableDecisions: ["accept", "decline"] });
    const job = jobs.get(jobId)!;
    const rowKey = createHash("sha256").update("codex-dashboard/row-key/v1").update("\0").update("agent:" + job.agentId).digest("hex").slice(0, 32);
    const widgetInstanceId = randomUUID();
    const overview = await ok("codex_ui_read", { view: "dashboard", widgetInstanceId, enrich: false }, otherMeta);
    expect(overview._meta["codex/dashboardView@1"].view.activeRows[0].controlKind).toBe("request");
    const read = await ok("codex_ui_read", { view: "control", rowKey, widgetInstanceId }, otherMeta);
    expect(read.structuredContent).toEqual({ kind: "control", ready: true });
    expect(JSON.stringify(read.structuredContent)).not.toContain("approval-1");
    const detail = read._meta["codex/uiControl@1"];
    expect(detail).toMatchObject({ jobId, projectName: "Fixture" });
    expect(detail).not.toHaveProperty("canStop");
    expect(detail).not.toHaveProperty("affectedJobIds");
    expect(detail).not.toHaveProperty("backgroundProcesses");
    expect(detail).not.toHaveProperty("backgroundUnavailable");
    expect(detail.pendingInteractions[0].interactionId).toBe("approval-1");
    const args = { widgetInstanceId, card: detail.card, requestId: randomUUID(), jobId,
      expectedJobVersion: detail.jobVersion, interactionId: "approval-1", response: { decision: "accept" } };
    for (const patch of [{ widgetInstanceId: randomUUID() }, { jobId: "another-job" },
      { card: { ...detail.card, token: detail.card.token + "tampered" } },
      { expectedJobVersion: detail.jobVersion + 1 }, { interactionId: "unknown" }, { response: { decision: "acceptForSession" } }]) {
      expect((await call("codex_interaction_respond", { ...args, ...patch, requestId: randomUUID() }, otherMeta)).isError).toBe(true);
    }
    expect((await call("codex_interaction_respond", args, meta)).isError).toBe(true);
    expect((await call("codex_status", { query: { kind: "input", jobId } }, otherMeta)).isError).toBe(true);
    expect((await call("codex_cancel", { requestId: randomUUID(), target: { kind: "job", id: jobId }, expectedVersion: job.version, reason: "Stop" }, otherMeta)).isError).toBe(true);
    expect(delivered).toEqual([]);
    const [first, replay] = await Promise.all([ok("codex_interaction_respond", args, otherMeta), ok("codex_interaction_respond", args, otherMeta)]);
    expect(first.structuredContent).toEqual(replay.structuredContent);
    expect(delivered).toEqual([{ id: "approval-1", response: { decision: "accept" } }]);
    expect((await call("codex_interaction_respond", { ...args, requestId: randomUUID() }, otherMeta)).isError).toBe(true);
    question();
    const ordinaryDetail = await call("codex_ui_read", { view: "control", rowKey, widgetInstanceId }, otherMeta);
    expect(ordinaryDetail.isError).toBe(true);
    expect(JSON.stringify(ordinaryDetail)).toContain("UI_CONTROL_UNAVAILABLE");
    const ordinaryOverview = await ok("codex_ui_read", { view: "dashboard", widgetInstanceId, enrich: false }, otherMeta);
    expect(ordinaryOverview._meta["codex/dashboardView@1"].view.activeRows[0].controlKind).toBeNull();
    const refused = await call("codex_interaction_respond", { ...args,
      requestId: randomUUID(), interactionId: "fixture:1:question", response: { answers: { color: ["Blue"] } } }, otherMeta);
    expect(refused.isError).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it("returns current question state from submit, claim and acknowledgment without an extra read", async () => {
    const created = await ok("codex_ask_user", { requestId: randomUUID(), title: "Choice", questions: [field] });
    const { questionId, revision, presentationToken } = created._meta[USER_QUESTION_META];
    const proof = { questionId, revision, presentationToken };
    const submitted = await ok("codex_question_action", { ...proof, operation: { kind: "submit", response: { answers: { color: ["Blue"] } } } });
    expect(submitted._meta[USER_QUESTION_META]).toMatchObject({ status: "answered", notification: "stored", consumed: false });
    const claim = await ok("codex_question_action", { ...proof, operation: { kind: "claim" } });
    expect(claim.structuredContent.send).toBe(true);
    expect(claim._meta[USER_QUESTION_META].notification).toBe("dispatching");
    const ack = await ok("codex_question_action", { ...proof, operation: { kind: "ack", attempt: claim.structuredContent.attempt, state: "uncertain" } });
    expect(ack._meta[USER_QUESTION_META]).toMatchObject({ notification: "uncertain", consumed: false });
    expect((await ok("codex_question_action", { ...proof, operation: { kind: "claim" } })).structuredContent.send).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("waits for input rather than progress, and answers after unrelated Job revisions without a card", async () => {
    const jobId = await start();
    const initial = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    const waiting = ok("codex_status", { query: { kind: "input", ...{ jobId, afterCursor: initial.cursor, waitMs: 500 } } });
    emit?.({ progress: 1, message: "Independent progress" });
    question();
    const observed = (await waiting).structuredContent;
    expect(observed.timedOut).toBe(false);
    expect(observed.questions).toHaveLength(1);
    const version = jobs.get(jobId)!.version;
    emit?.({ progress: 2, event: { eventId: randomUUID(), type: "command", phase: "completed", summary: "Unrelated command", createdAt: Date.now() } });
    expect(jobs.get(jobId)!.version).toBeGreaterThan(version);
    expect((await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent.cursor).toBe(observed.cursor);
    const args = { jobId, requestId: randomUUID(), questionRef: observed.questions[0].questionRef, answers: { color: ["Blue"] } };
    const [a, b] = await Promise.all([ok("codex_answer", args), ok("codex_answer", args)]);
    expect(a.structuredContent.delivery).toBe("delivered");
    expect(a.structuredContent).toEqual(b.structuredContent);
    expect(delivered).toHaveLength(1);
    expect((await ok("codex_answer", args)).structuredContent.delivery).toBe("delivered");
    expect((await call("codex_answer", { ...args, answers: { color: ["Red"] } })).isError).toBe(true);
    expect((await call("codex_answer", args, otherMeta)).isError).toBe(true);
    expect((await call("codex_answer", { ...args, requestId: randomUUID() })).isError).toBe(true);
    const journal = store.questions.delivery(jobs.get(jobId)!.scopeId, args.requestId, (await import("../src/questionStore.js")).questionHash(args));
    expect(journal).toBe("delivered");
  });

  it("keeps completed message items visible while the turn runs and ignores non-input progress", async () => {
    const jobId = await start();
    const before = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    const wait = ok("codex_status", { query: { kind: "input", ...{ jobId, afterCursor: before.cursor, waitMs: 40 } } });
    emit?.({ progress: 3, message: "Still working" });
    expect((await wait).structuredContent.timedOut).toBe(true);
    emit?.({ progress: 4, event: { eventId: "interim-message", type: "agent-message", phase: "completed", summary: "Which color?", createdAt: Date.now() } });
    const result = (await ok("codex_status", { query: { kind: "input", ...{ jobId, afterCursor: before.cursor, waitMs: 100 } } })).structuredContent;
    expect(result.active).toBe(true);
    expect(result.messages[0].text).toBe("Which color?");
    expect(jobs.get(jobId)!.status).toBe("running");
    const status = (await ok("codex_status", { query: { kind: "job", id: jobId } })).structuredContent;
    expect(status.items[0].inputs.readTool).toBe("codex_status");
  });

  it.each([true, false])("answers freeform questions (blocking=%s) and prevents a retry after an uncertain dispatch", async isBlocking => {
    const jobId = await start();
    question({ isBlocking, questions: [{ ...field, options: [], isSecret: false }] });
    const input = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    expect(input.questions[0].questions[0].options).toBeUndefined();
    const args = { jobId, requestId: randomUUID(), questionRef: input.questions[0].questionRef, answers: { color: ["A freeform answer"] } };
    deliveryFailure = true;
    expect((await ok("codex_answer", args)).structuredContent.delivery).toBe("uncertain");
    expect((await ok("codex_answer", args)).structuredContent.delivery).toBe("uncertain");
    expect((await call("codex_answer", { ...args, requestId: randomUUID() })).isError).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it("drops old questions when the executing worker or turn is replaced", async () => {
    const jobId = await start(); question();
    const input = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    assign?.({ backendKind: "app-server", workerId: "replacement-worker", workerGeneration: 2,
      threadId: "fixture-thread", upstreamRequestId: "replacement-turn" });
    const current = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    expect(current.questions).toEqual([]);
    expect(current.cursor).not.toBe(input.cursor);
    expect((await call("codex_answer", { jobId, requestId: randomUUID(), questionRef: input.questions[0].questionRef, answers: { color: ["Blue"] } })).isError).toBe(true);
    expect(delivered).toEqual([]);
  });

  it("rejects changed questions, old workers, secrets, approvals and unknown input origins", async () => {
    const jobId = await start(); question();
    const ref = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent.questions[0].questionRef;
    const answer = { jobId, requestId: randomUUID(), questionRef: ref, answers: { color: ["Blue"] } };
    question({ questions: [{ ...field, question: "A changed question", isSecret: false }] });
    expect((await call("codex_answer", answer)).isError).toBe(true);
    question(); jobs.get(jobId)!.workerGeneration = 2;
    expect((await call("codex_answer", answer)).isError).toBe(true);
    for (const origin of ["app-approval", "unknown"] as const) {
      question({ origin });
      expect((await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent.questions).toEqual([]);
      expect((await call("codex_answer", answer)).isError).toBe(true);
    }
    question({ questions: [{ ...field, isSecret: true }] });
    const secret = (await ok("codex_status", { query: { kind: "input", ...{ jobId } } })).structuredContent;
    expect(secret.questions).toEqual([]); expect(secret.approvals).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it("routes metadata-less card calls with private proof without overriding another host conversation", async () => {
    const card = await ok("codex_ask_user", { requestId: randomUUID(), title: "Host routing", questions: [field] });
    const { questionId, revision, presentationToken, scopeId } = card._meta[USER_QUESTION_META];
    const proof = { questionId, revision, presentationToken, scopeId };
    expect(card.structuredContent.scopeId).toBeUndefined();
    expect((await call("codex_question_card", { questionId, revision, presentationToken }, {})).isError).toBe(true);
    expect((await call("codex_question_card", proof, otherMeta)).isError).toBe(true);
    expect((await call("codex_question_card", { ...proof, scopeId: randomUUID() }, {})).isError).toBe(true);
    expect((await call("codex_question_card", { ...proof, presentationToken: randomUUID() }, {})).isError).toBe(true);
    expect((await ok("codex_question_card", proof, {})).structuredContent.status).toBe("pending");
    const submitted = await ok("codex_question_submit", { ...proof, response: { answers: { color: ["Blue"] } } }, {});
    const claim = (await ok("codex_question_notify", { ...proof, operation: { kind: "claim" } }, {})).structuredContent;
    expect(claim.send).toBe(true);
    await ok("codex_question_notify", { ...proof, operation: { kind: "ack", attempt: claim.attempt, state: "requested" } }, {});
    const responseRef = submitted._meta[USER_QUESTION_META].responseRef;
    expect((await call("codex_user_answer", { responseRef }, {})).isError).toBe(true);
    expect((await call("codex_user_answer", { responseRef }, otherMeta)).isError).toBe(true);
    expect((await ok("codex_user_answer", { responseRef })).structuredContent.responses[0].answers)
      .toEqual([{ questionId: "color", values: ["Blue"] }]);
    expect(delivered).toEqual([]);
  });

  it("stores card answers for GPT, claims notifications once, and preserves unread answers after notification failure", async () => {
    const args = { requestId: randomUUID(), title: "Color preference", questions: [field] };
    const card = await ok("codex_ask_user", args);
    const { questionId, revision, presentationToken } = card._meta[USER_QUESTION_META];
    const proof = { questionId, revision, presentationToken };
    expect((await ok("codex_ask_user", args))._meta[USER_QUESTION_META]).toMatchObject(proof);
    expect((await call("codex_ask_user", { ...args, title: "Different" })).isError).toBe(true);
    expect((await call("codex_question_card", proof, otherMeta)).isError).toBe(true);
    const submitted = await ok("codex_question_submit", { ...proof, response: { answers: { color: ["Blue"] } } });
    const responseRef = submitted._meta[USER_QUESTION_META].responseRef;
    expect((await ok("codex_question_submit", { ...proof, response: { answers: { color: ["Blue"] } } }))._meta[USER_QUESTION_META].responseRef).toBe(responseRef);
    expect((await call("codex_question_submit", { ...proof, response: { answers: { color: ["Red"] } } })).isError).toBe(true);
    const claim = (await ok("codex_question_notify", { ...proof, operation: { kind: "claim" } })).structuredContent;
    expect(claim.send).toBe(true);
    expect((await ok("codex_question_notify", { ...proof, operation: { kind: "claim" } })).structuredContent.send).toBe(false);
    await ok("codex_question_notify", { ...proof, operation: { kind: "ack", attempt: claim.attempt, state: "failed" } });
    const retry = (await ok("codex_question_notify", { ...proof, operation: { kind: "claim" } })).structuredContent;
    expect(retry.send).toBe(true); expect(retry.attempt).not.toBe(claim.attempt);
    await ok("codex_question_notify", { ...proof, operation: { kind: "ack", attempt: retry.attempt, state: "requested" } });
    const unread = (await ok("codex_user_answer")).structuredContent.responses;
    expect(unread[0].responseRef).toBe(responseRef); expect(unread[0].answers).toBeUndefined();
    expect((await ok("codex_user_answer")).structuredContent.responses).toHaveLength(1);
    const read = (await ok("codex_user_answer", { responseRef })).structuredContent.responses[0];
    expect(read.answers).toEqual([{ questionId: "color", values: ["Blue"] }]);
    expect((await ok("codex_user_answer")).structuredContent.responses).toEqual([]);
    expect((await call("codex_user_answer", { responseRef }, otherMeta)).isError).toBe(true);
    expect(delivered).toEqual([]);
  });

  it("rejects expired and stale cards and returns cancellation to GPT", async () => {
    const card = await ok("codex_ask_user", { requestId: randomUUID(), title: "Question", questions: [field], expiresInMinutes: 1 });
    const { questionId, revision, presentationToken } = card._meta[USER_QUESTION_META];
    const proof = { questionId, revision, presentationToken };
    expect((await call("codex_question_submit", { ...proof, revision: 2, response: { answers: { color: ["Blue"] } } })).isError).toBe(true);
    const cancelled = await ok("codex_question_submit", { ...proof, response: { cancel: true } });
    const responseRef = cancelled._meta[USER_QUESTION_META].responseRef;
    expect((await ok("codex_user_answer", { responseRef })).structuredContent.responses[0].status).toBe("cancelled");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await call("codex_question_card", proof)).isError).toBe(true);
    expect((await call("codex_user_answer", { responseRef })).isError).toBe(true);
    vi.restoreAllMocks();
    expect(delivered).toEqual([]);
  });
});
