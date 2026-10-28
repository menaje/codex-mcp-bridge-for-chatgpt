import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { DIRECT_WAIT_GRACE_MS, RESULT_REVIEW_GRACE_MS, relayEvent, relayPresentationRef } from "../src/relayDelivery.js";
import { registerRelayTools, relayToolResult } from "../src/relayTools.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerCodexInputTools } from "../src/questionTools.js";
import type { CodexJobRegistry } from "../src/tools.js";

// Functional state and ordering fixtures only: no elapsed-duration assertion,
// soak, fake clock, expiry acceleration, live GPT or production state.
const stores: BridgeStateStore[] = [];
const directories: string[] = [];
afterEach(() => { for (const state of stores.splice(0)) state.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fixture(file = ":memory:", withProject = false) {
  const state = new BridgeStateStore({ file }); stores.push(state);
  const scopes = new ScopeResolver({ stateStore: state });
  const metadata = { "openai/session": "relay-original" };
  const scopeId = scopes.resolve(metadata)!.scopeId;
  const directory = withProject ? realpathSync(mkdtempSync(path.join(tmpdir(), "relay-project-"))) : undefined;
  if (directory) directories.push(directory);
  const project = directory ? state.applyProjectOperations([{ kind: "add", project: { name: "Project", cwd: directory } }],
    state.getProjectRegistryRevision(), [directory]).projects[0] : undefined;
  const activity = state.createActivity({ scopeId, projectId: project?.id, projectName: project?.name, projectCwd: directory, handoffPolicy: "none", completionTrigger: "manual" });
  const agent = state.createAgent({ scopeId, agentName: "Worker" });
  const owner = { scopeId };
  const seed = (extra: Record<string, unknown> = {}) => {
    const job = { jobId: randomUUID(), requestId: randomUUID(), scopeId, activityId: activity.activityId,
      agentId: agent.agentId, projectId: project?.id, projectName: project?.name, cwd: directory || process.cwd(), sandbox: "read-only", completionDeliveryPolicy: "relay-card" as const,
      status: "running", createdAt: Date.now(), updatedAt: Date.now(), version: 1, pendingInteractions: [], ...extra };
    state.upsertJob(job);
    return job;
  };
  const finish = (job: ReturnType<typeof seed>) => {
    state.upsertJob({ ...job, status: "completed", version: 2, updatedAt: Date.now(), result: { content: [{ type: "text", text: "Original result" }] } });
    return state.relay.registration(job.jobId)!.event!;
  };
  const connect = (cardId = randomUUID()) => { state.relay.connect(activity.activityId, owner, cardId); return cardId; };
  return { state, scopes, metadata, scopeId, activity, agent, owner, seed, finish, connect, project, directory };
}

describe("#261 durable relay delivery", () => {
  it("commits registration and event intent with the source and emits readiness only after commit", () => {
    const f = fixture(); const seen: string[] = [];
    f.state.subscribeRelayReady(activityId => { expect(f.state.relay.pending(activityId)).toHaveLength(1); seen.push(activityId); });
    const a = f.seed();
    expect(f.state.relay.registration(a.jobId)).toBeDefined();
    expect(() => f.state.transaction(() => { f.finish(a); throw new Error("rollback"); })).toThrow("rollback");
    expect(f.state.getEventJobSnapshot(a.jobId)?.status).toBe("running");
    expect(f.state.relay.registration(a.jobId)?.event).toBeUndefined(); expect(seen).toEqual([]);
    f.state.transaction(() => { f.finish(a); expect(seen).toEqual([]); });
    expect(seen).toEqual([f.activity.activityId]);
  });

  it("grants one claim across cards and preserves send-entry through handoff without replaying entered sends", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a), first = f.connect(), attemptId = randomUUID();
    expect(f.state.relay.claim(f.activity.activityId, f.owner, first, event.eventId, attemptId)?.state).toBe("leased");
    const second = f.connect();
    expect(f.state.relay.enter(f.activity.activityId, f.owner, first, event.eventId, attemptId)).toBe(false);
    const nextAttempt = randomUUID();
    expect(f.state.relay.claim(f.activity.activityId, f.owner, second, event.eventId, nextAttempt)?.state).toBe("leased");
    expect(f.state.relay.enter(f.activity.activityId, f.owner, second, event.eventId, nextAttempt)).toBe(true);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, second, event.eventId, nextAttempt)).toBe(false);
    f.connect();
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, first, event.eventId, attemptId, "accepted")).toBeUndefined();
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, second, event.eventId, nextAttempt, "accepted")?.state).toBe("accepted");
  });

  it("releases only proven pre-send attempts and never replays unknown sends", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a), card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "not-sent")?.state).toBe("pending");
    const stored = f.state.relay.registration(a.jobId)!;
    // Construct the next protocol state directly; this does not simulate time.
    delete stored.event!.retryAt; f.state.setMeta(`relay_job_v1/${a.jobId}`, JSON.stringify(stored));
    const second = randomUUID(); f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, second);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, second);
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, second, "not-sent")?.state).toBe("sending");
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, second, "unknown")?.state).toBe("unknown");
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
  });

  it.each(["accepted", "unknown", "sending"] as const)("preserves %s input delivery through owner liveness loss and recovery", outcome => {
    const f = fixture(), input = { interactionId: "same-question", kind: "user-input", origin: "codex-question",
      questions: [{ id: "choice", header: "Choice", question: "Original question" }] };
    const a = f.seed({ trackingState: "connected", workerId: "original-worker", workerGeneration: 1,
      threadId: randomUUID(), pendingInteractions: [input] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
    if (outcome !== "sending") f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome);
    const before = f.state.relay.registration(a.jobId)!.event!;
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" });
    expect.soft(f.state.relay.registration(a.jobId)?.event).toEqual(before);
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    const replacement = f.connect(); f.state.relay.recover(f.activity.activityId);
    f.state.upsertJob({ ...a, version: 3, trackingState: "connected" });
    expect.soft(f.state.relay.registration(a.jobId)?.event).toEqual(before);
    expect.soft(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    const repeatedAttempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, replacement, event.eventId, repeatedAttempt);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, replacement, event.eventId, repeatedAttempt)).toBe(false);
  });

  it.each(["pending", "leased"] as const)("pauses %s inputs without losing a claim and signals readiness only on committed recovery", phase => {
    const f = fixture(), a = f.seed({ trackingState: "connected", pendingInteractions: [{ interactionId: "waiting-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    if (phase === "leased") f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    const before = f.state.relay.registration(a.jobId)!.event!, signal = vi.fn(); f.state.subscribeRelayReady(signal);
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" });
    expect(f.state.relay.registration(a.jobId)).toMatchObject({ paused: true, event: before });
    expect(f.state.listMeta(`relay_ready_v1/${f.activity.activityId}/`, 64)).toEqual([]);
    expect(signal).not.toHaveBeenCalled();
    expect(() => f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt)).toThrow(/RELAY_EVENT_PAUSED/);
    expect(() => f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toThrow(/RELAY_EVENT_PAUSED/);
    const transaction = vi.spyOn(f.state, "transaction"), write = vi.spyOn(f.state, "setMeta");
    f.state.relay.recover(f.activity.activityId); f.state.relay.recover(f.activity.activityId);
    expect(transaction).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    transaction.mockRestore(); write.mockRestore();
    expect(() => f.state.transaction(() => { f.state.upsertJob({ ...a, version: 3 }); throw new Error("rollback recovery"); })).toThrow("rollback recovery");
    expect(f.state.relay.registration(a.jobId)).toMatchObject({ paused: true, event: before });
    expect(signal).not.toHaveBeenCalled();
    f.state.transaction(() => { f.state.upsertJob({ ...a, version: 3 }); expect(signal).not.toHaveBeenCalled(); });
    // The existing card's live lease is retained, so it is not a new offer.
    expect(signal).toHaveBeenCalledTimes(phase === "pending" ? 1 : 0);
    expect(f.state.relay.registration(a.jobId)?.event).toEqual(before);
    expect(f.state.relay.registration(a.jobId)?.paused).toBeUndefined();
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt)?.attempts).toBe(1);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(false);
  });

  it.each(["accepted", "unknown", "sending"] as const)("retains %s input receipts across resolution, replacement and return of the exact identity", outcome => {
    const f = fixture(), input = { interactionId: "original-question", questions: [{ question: "Private original body" }] };
    const a = f.seed({ trackingState: "connected", workerId: "worker", workerGeneration: 1, threadId: randomUUID(), pendingInteractions: [input] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
    if (outcome !== "sending") f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome);
    const before = f.state.relay.registration(a.jobId)!.event!, historyKey = `relay_event_history_v1/${a.jobId}/${event.eventId}`;
    f.state.upsertJob({ ...a, version: 2, pendingInteractions: [] });
    expect(f.state.relay.registration(a.jobId)?.event).toBeUndefined();
    expect(JSON.parse(f.state.getMeta(historyKey)!)).toEqual(before);
    expect(f.state.getMeta(historyKey)).not.toContain("Private original body");
    expect(() => f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toThrow(/RELAY_EVENT_STALE/);
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "accepted")).toBeUndefined();
    f.state.upsertJob({ ...a, version: 3, pendingInteractions: [{ ...input, interactionId: "replacement-question" }] });
    expect(f.state.relay.registration(a.jobId)?.event?.eventId).not.toBe(event.eventId);
    f.state.upsertJob({ ...a, version: 4 });
    expect(f.state.relay.registration(a.jobId)?.event).toEqual(before);
    expect(f.state.getMeta(historyKey)).toBeUndefined();
    const repeatedAttempt = randomUUID();
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, repeatedAttempt)).toBeUndefined();
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, repeatedAttempt)).toBe(false);
  });

  it.each(["accepted", "unknown", "sending"] as const)("recovers a paused %s input after SQLite restart without another send", outcome => {
    const directory = mkdtempSync(path.join(tmpdir(), "relay-paused-restart-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite"), f = fixture(file);
    const a = f.seed({ trackingState: "connected", pendingInteractions: [{ interactionId: "same-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    if (outcome !== "sending") f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome);
    const before = f.state.relay.registration(a.jobId)!.event!;
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" }); f.state.close();
    const restarted = new BridgeStateStore({ file }); stores.push(restarted);
    const nextCard = randomUUID(); restarted.relay.connect(f.activity.activityId, f.owner, nextCard);
    restarted.relay.recover(f.activity.activityId);
    expect(restarted.relay.registration(a.jobId)).toMatchObject({ paused: true, event: before });
    expect(restarted.relay.pending(f.activity.activityId)).toEqual([]);
    restarted.upsertJob({ ...a, version: 3 });
    expect(restarted.relay.registration(a.jobId)?.event).toEqual(before);
    const repeatedAttempt = randomUUID();
    expect(restarted.relay.claim(f.activity.activityId, f.owner, nextCard, event.eventId, repeatedAttempt)).toBeUndefined();
    expect(restarted.relay.enter(f.activity.activityId, f.owner, nextCard, event.eventId, repeatedAttempt)).toBe(false);
  });

  it("records the same send's late ACK while its input owner is paused", () => {
    const f = fixture(), a = f.seed({ trackingState: "connected", pendingInteractions: [{ interactionId: "waiting-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" }); f.connect();
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "accepted")?.state).toBe("accepted");
    f.state.upsertJob({ ...a, version: 3 });
    expect(f.state.relay.registration(a.jobId)?.event).toMatchObject({ eventId: event.eventId, attemptId: attempt, attempts: 1, state: "accepted" });
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
  });

  it.each(["not-sent", "retryable-rejection"] as const)("holds a proven %s retry until owner recovery without resetting its attempt", outcome => {
    const f = fixture(), a = f.seed({ trackingState: "connected", pendingInteractions: [{ interactionId: "retry-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    if (outcome === "retryable-rejection") f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" });
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome))
      .toMatchObject({ state: "pending", attempts: 1, attemptId: attempt });
    const before = f.state.relay.registration(a.jobId)!.event!;
    expect(before.retryAt).toBeDefined();
    expect(f.state.listMeta(`relay_ready_v1/${f.activity.activityId}/`, 64)).toEqual([]);
    f.state.upsertJob({ ...a, version: 3 });
    expect(f.state.relay.registration(a.jobId)?.event).toEqual(before);
    expect(f.state.listMeta(`relay_ready_v1/${f.activity.activityId}/`, 64)).toHaveLength(1);
  });

  it("keeps exact-result offers separate from receipt, and idempotent ACKs separate from the Activity goal", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a), card = f.connect(), attempt = randomUUID();
    f.state.recordJobCompletionResultOffer({ scopeId: f.scopeId, jobId: a.jobId, source: "direct-query" });
    expect(f.state.relay.pending(f.activity.activityId)).toHaveLength(1);
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    const first = f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "accepted");
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "accepted")).toEqual(first);
    expect(f.state.getActivity(f.activity.activityId)?.lifecycle).toBe("open");
    const reviewer = f.state.createAgent({ scopeId: f.scopeId, agentName: "Reviewer" });
    const b = f.seed({ agentId: reviewer.agentId }); const bEvent = f.finish(b);
    expect(f.state.relay.pending(f.activity.activityId).map(event => event.eventId)).toEqual([bEvent.eventId]);
    expect(f.state.relay.goal(f.activity.activityId)?.cardId).toBe(card);
  });

  it("limits only proven retryable host rejections and never retries a permanent rejection", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a), card = f.connect();
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const attempt = randomUUID();
      const stored = f.state.relay.registration(a.jobId)!; delete stored.event!.retryAt;
      f.state.setMeta(`relay_job_v1/${a.jobId}`, JSON.stringify(stored));
      expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt)?.attempts).toBe(ordinal);
      expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
      expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, "retryable-rejection")?.state)
        .toBe(ordinal < 3 ? "pending" : "rejected");
    }
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
  });

  it("recovers an enrolled result after registry eviction, without overriding common history expiry", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a);
    expect(f.state.deleteJob(a.jobId)).toBe(true);
    expect(f.state.getEventJobSnapshot(a.jobId)).toBeUndefined();
    expect(f.state.getRelayJobSnapshot(a.jobId)?.terminalVersion).toBeDefined();
    const card = f.connect(), attempt = randomUUID();
    expect(f.state.relay.pending(f.activity.activityId).map(item => item.eventId)).toEqual([event.eventId]);
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
    // An already-expired source is constructed directly, with the current
    // ordinary policy. No elapsed-time or accelerated lifetime is tested.
    const old = f.seed({ createdAt: Date.now() - 40 * 86_400_000, pendingInteractions: [{ interactionId: "expired-question" }] });
    f.state.upsertJob({ ...old, status: "completed", version: 2, updatedAt: old.createdAt });
    expect(f.state.listMeta(`relay_event_history_v1/${old.jobId}/`, 1)).toHaveLength(1);
    expect(f.state.retainedJobVisible(old.jobId)).toBe(false);
    f.state.maintainHistoryRetention();
    expect(f.state.relay.registration(old.jobId)).toBeUndefined();
    expect(f.state.listMeta(`relay_event_history_v1/${old.jobId}/`, 1)).toEqual([]);
    expect(f.state.listMeta(`relay_ready_v1/${f.activity.activityId}/`, 64)).not.toContainEqual(expect.objectContaining({ value: JSON.stringify({ jobId: old.jobId }) }));
    expect(f.state.getArchivedJobAdmissionReceipt(f.scopeId, { kind: "request", requestId: old.requestId })?.jobId).toBe(old.jobId);
  });

  it("removes project relay references at deletion and cannot connect them to a re-registered folder", () => {
    const f = fixture(":memory:", true), a = f.seed({ pendingInteractions: [{ interactionId: "project-question" }] }); f.finish(a);
    expect(f.state.listMeta(`relay_event_history_v1/${a.jobId}/`, 1)).toHaveLength(1);
    const projectId = f.project!.id, apply = (operations: any[]) => f.state.applyProjectOperations(operations, f.state.getProjectRegistryRevision(), [f.directory!]);
    apply([{ kind: "archive", projectId }]);
    const intent = f.state.projectLifecycle.pending().find(item => item.projectId === projectId)!;
    expect(f.state.transaction(() => f.state.projectLifecycle.complete(projectId, intent.revision))).toBe(true);
    expect(() => f.connect()).toThrow(/OWNER_REQUIRED/);
    apply([{ kind: "delete", projectId }]);
    expect(f.state.relay.registration(a.jobId)).toBeUndefined(); expect(f.state.relay.goal(f.activity.activityId)).toBeUndefined();
    expect(f.state.listMeta(`relay_event_history_v1/${a.jobId}/`, 1)).toEqual([]);
    const replacement = apply([{ kind: "add", project: { name: "Project", cwd: f.directory! } }]).projects[0]!;
    expect(replacement.id).not.toBe(projectId); expect(() => f.connect()).toThrow(/OWNER_REQUIRED/);
    expect(f.state.getArchivedJobAdmissionReceipt(f.scopeId, { kind: "request", requestId: a.requestId })?.managementEnded).toBe(true);
  });

  it("pages all parallel admission receipts with bounded read-only indexed queries", () => {
    const f = fixture(), a = f.seed(), event = f.finish(a), issued = new Set<string>();
    for (let step = 0; step < 30; step++) {
      const identity = f.state.taskFollowups.dynamicIdentity(f.scopeId, { eventId: event.eventId, step: `parallel-${step}` }); issued.add(identity.followupId);
      f.state.setMeta(`task_followup_v1/${a.jobId}/${identity.followupId.slice(36)}`, JSON.stringify({ ...identity,
        parentJobId: a.jobId, scopeId: f.scopeId, activityId: f.activity.activityId, agentId: f.agent.agentId,
        admittedJobId: randomUUID(), expiresAt: Date.now(), promptSha256: "",
        dynamic: { eventId: event.eventId, step: `parallel-${step}`, payloadSha256: "a".repeat(64) } }));
    }
    const transaction = vi.spyOn(f.state, "transaction"), reads = vi.spyOn(f.state, "listMeta");
    const first = f.state.taskFollowups.page(a), second = f.state.taskFollowups.page(a, first.after!);
    expect(first.receipts).toHaveLength(24); expect(second.receipts).toHaveLength(6); expect(second.after).toBeNull();
    expect(new Set([...first.receipts, ...second.receipts].map(receipt => receipt.followupId))).toEqual(issued);
    expect(transaction).not.toHaveBeenCalled(); expect(reads.mock.calls.every(call => call[1] === 25)).toBe(true);
    const foreignCursor = f.state.taskFollowups.dynamicIdentity(f.scopeId, { eventId: event.eventId.replace(a.jobId.replaceAll("-", ""), randomUUID().replaceAll("-", "")), step: "foreign" });
    expect(() => f.state.taskFollowups.page(a, foreignCursor.followupId)).toThrow(/OWNER_REQUIRED/);
  });

  it("wakes a bounded wait only after the matching event commit and releases aborted observations", async () => {
    const f = fixture(), a = f.seed(), card = f.connect(), handlers = new Map<string, any>();
    registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, f.state, f.scopes);
    const args = { contractGeneration: 1, activityId: f.activity.activityId, cardId: card, after: f.state.relayRevision, waitMs: 25_000 };
    const controller = new AbortController(), extra = { mcpReq: { _meta: f.metadata, signal: controller.signal } };
    const transaction = vi.spyOn(f.state, "transaction");
    const waiting = handlers.get("codex_relay_wait")(args, extra);
    expect(transaction).not.toHaveBeenCalled(); transaction.mockRestore();
    const event = f.finish(a);
    expect((await waiting).structuredContent.events).toMatchObject([{ eventId: event.eventId }]);
    const attempt = randomUUID(); f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    const observing = handlers.get("codex_relay_wait")({ ...args, after: f.state.relayRevision }, extra);
    controller.abort(); expect((await observing).structuredContent.events).toEqual([]);
    expect(f.state.getRelayJobSnapshot(a.jobId)?.status).toBe("completed");
  });

  it.each(["claim", "enter"])("marks a paused %s as explicitly retryable without changing the attempt", async action => {
    const f = fixture(), a = f.seed({ trackingState: "connected", pendingInteractions: [{ interactionId: "original-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID(), handlers = new Map<string, any>();
    registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, f.state, f.scopes);
    if (action === "enter") f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.upsertJob({ ...a, version: 2, trackingState: "liveness-unknown" });
    const before = f.state.relay.registration(a.jobId)!.event;
    const result = await handlers.get("codex_relay")({ contractGeneration: 1, activityId: f.activity.activityId,
      cardId: card, action, eventId: event.eventId, attemptId: attempt }, { mcpReq: { _meta: f.metadata } });
    expect(result).toMatchObject({ isError: true, _meta: { "codex/relayRetry@1": { delivery: "not-sent", retryable: true } } });
    expect(f.state.relay.registration(a.jobId)!.event).toEqual(before);
  });

  it("marks wait capacity as retryable and releases all existing observations on abort", async () => {
    const f = fixture(), handlers = new Map<string, any>(), controller = new AbortController(), pending: Promise<any>[] = [];
    registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, f.state, f.scopes);
    const extra = { mcpReq: { _meta: f.metadata, signal: controller.signal } };
    try {
      for (let index = 0; index < 8; index++) {
        const activity = f.state.createActivity({ scopeId: f.scopeId, handoffPolicy: "none", completionTrigger: "manual" });
        f.seed({ activityId: activity.activityId }); const cardId = randomUUID();
        f.state.relay.connect(activity.activityId, f.owner, cardId);
        pending.push(handlers.get("codex_relay_wait")({ contractGeneration: 1, activityId: activity.activityId,
          cardId, after: f.state.relayRevision, waitMs: 25_000 }, extra));
      }
      f.seed(); const cardId = f.connect();
      const result = await handlers.get("codex_relay_wait")({ contractGeneration: 1, activityId: f.activity.activityId,
        cardId, after: f.state.relayRevision, waitMs: 25_000 }, extra);
      expect(result).toMatchObject({ isError: true, _meta: { "codex/relayRetry@1": { delivery: "not-sent", retryable: true } } });
    } finally { controller.abort(); await Promise.all(pending); }
  });

  it.each(["claim", "enter"])("allows recovery from a stale %s without reviving a resolved question", async action => {
    const f = fixture(), a = f.seed({ pendingInteractions: [{ interactionId: "resolved-question" }] });
    const event = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID(), handlers = new Map<string, any>();
    registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, f.state, f.scopes);
    if (action === "enter") f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.upsertJob({ ...a, version: 2, pendingInteractions: [] });
    const result = await handlers.get("codex_relay")({ contractGeneration: 1, activityId: f.activity.activityId,
      cardId: card, action, eventId: event.eventId, attemptId: attempt }, { mcpReq: { _meta: f.metadata } });
    expect(result).toMatchObject({ isError: true, _meta: { "codex/relayRetry@1": { delivery: "not-sent", retryable: true } } });
    expect(f.state.relay.registration(a.jobId)!.event).toBeUndefined(); expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
  });

  it("uses a stable question event through progress, drops resolved/replaced questions and rejects late entry or ACK", () => {
    const f = fixture(), a = f.seed();
    const input = { interactionId: "question-one", kind: "user-input", origin: "codex-question", isBlocking: false,
      questions: [{ id: "choice", header: "Choice", question: "Original private question" }] };
    f.state.upsertJob({ ...a, version: 2, pendingInteractions: [input] });
    const first = f.state.relay.registration(a.jobId)!.event!, card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, first.eventId, attempt);
    const signal = vi.fn(); f.state.subscribeRelayReady(signal);
    f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 3, lastProgressAt: Date.now(), pendingInteractions: [input] });
    expect(f.state.relay.registration(a.jobId)?.event?.eventId).toBe(first.eventId); expect(signal).not.toHaveBeenCalled();
    f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 4, lastProgressAt: Date.now(), pendingInteractions: [] });
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    expect(() => f.state.relay.enter(f.activity.activityId, f.owner, card, first.eventId, attempt)).toThrow(/STALE/);
    f.state.upsertJob({ ...a, version: 5, pendingInteractions: [{ ...input, interactionId: "question-two" }] });
    expect(f.state.relay.registration(a.jobId)?.event?.eventId).not.toBe(first.eventId);
    expect(f.state.relay.acknowledge(f.activity.activityId, f.owner, card, first.eventId, attempt, "accepted")).toBeUndefined();
    expect(JSON.stringify(f.state.relay.registration(a.jobId))).not.toContain("Original private question");
  });

  it("preserves monitor and followup stops through late completion, remount, history cleanup and source recovery", () => {
    const f = fixture(), a = f.seed(), card = f.connect();
    f.state.relay.stop(f.activity.activityId, f.owner, "relay"); f.finish(a);
    expect(f.state.relay.connect(f.activity.activityId, f.owner, card)).toMatchObject({ ended: true, monitoringStopped: true });
    f.state.relay.recover(f.activity.activityId); expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    f.state.relay.stop(f.activity.activityId, f.owner, "followups");
    expect(() => f.seed()).toThrow(/FOLLOWUPS_STOPPED/);
    f.state.relay.forgetJob(a.jobId);
    expect(f.state.relay.goal(f.activity.activityId)).toMatchObject({ monitoringStopped: true, followupsStopped: true });
  });

  it("closes only the explicitly completed Activity and never enrolls old terminal history", () => {
    const f = fixture(), a = f.seed(), other = f.state.createActivity({ scopeId: f.scopeId });
    const b = f.seed({ activityId: other.activityId }); f.finish(a); f.finish(b);
    const historical = f.seed({ completionDeliveryPolicy: "direct-wait", activityId: f.state.createActivity({ scopeId: f.scopeId }).activityId });
    f.state.upsertJob({ ...historical, status: "completed", version: 2 });
    expect(f.state.relay.registration(historical.jobId)).toBeUndefined();
    f.state.completeActivity(f.activity.activityId);
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]); expect(f.state.relay.pending(other.activityId)).toHaveLength(1);
  });

  it("recovers registered events after restart with no old terminal backfill or fresh execution", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "relay-restart-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite"), f = fixture(file), a = f.seed(), event = f.finish(a), card = f.connect(), attempt = randomUUID();
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.close();
    const restarted = new BridgeStateStore({ file }); stores.push(restarted);
    restarted.relay.connect(f.activity.activityId, f.owner, randomUUID()); restarted.relay.recover(f.activity.activityId);
    expect(restarted.relay.pending(f.activity.activityId)).toEqual([]);
    expect(restarted.relay.registration(a.jobId)?.event).toMatchObject({ eventId: event.eventId, attemptId: attempt, state: "sending" });
    expect(restarted.getEventJobSnapshot(a.jobId)?.status).toBe("completed");
  });

  it("uses bounded indexed empty reads with no writer transaction and rejects other conversations or compatibility scope", async () => {
    const f = fixture(), a = f.seed(), card = f.connect();
    const transaction = vi.spyOn(f.state, "transaction");
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]); expect(f.state.relay.recover(f.activity.activityId)).toBeNull();
    expect(transaction).not.toHaveBeenCalled(); transaction.mockRestore();
    const handlers = new Map<string, any>(); registerRelayTools({ registerTool(name: string, descriptor: any, callback: any) { handlers.set(name, { descriptor, callback }); } } as unknown as McpServer, f.state, f.scopes);
    const call = async (meta: unknown) => handlers.get("codex_relay_wait").callback({ contractGeneration: 1, activityId: f.activity.activityId, cardId: card, waitMs: 0 }, { mcpReq: { _meta: meta } });
    await expect(call({ "openai/session": "other" })).rejects.toThrow(/OWNER_REQUIRED/);
    await expect(call(undefined)).rejects.toThrow(/HOST_SCOPE_REQUIRED/);
    expect((await call(f.metadata)).structuredContent.events).toEqual([]);
    expect(handlers.get("codex_relay").descriptor._meta).not.toHaveProperty("openai/outputTemplate");
    const result = relayToolResult({ structuredContent: { jobId: a.jobId } }, f.state, a.requestId) as any;
    expect(result._meta["codex/relayOpen@1"].presentationRef).toBe(relayPresentationRef(a.requestId));
  });

  it("requires the original authenticated principal even in the same host conversation", async () => {
    const f = fixture(), a = f.seed({ mcpPrincipal: "original-principal" }), event = f.finish(a);
    const owner = { ...f.owner, mcpPrincipal: "original-principal" }, cardId = randomUUID();
    f.state.relay.connect(f.activity.activityId, owner, cardId);
    const handlers = new Map<string, any>();
    registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, f.state, f.scopes);
    const read = (principal?: string) => handlers.get("codex_relay_wait")({ contractGeneration: 1,
      activityId: f.activity.activityId, cardId, waitMs: 0 }, { mcpReq: { _meta: f.metadata },
      http: principal ? { authInfo: { scopes: ["bridge"], extra: { bridgeMcpPrincipal: principal } } } : undefined });
    await expect(read()).rejects.toThrow(/OWNER_REQUIRED/);
    await expect(read("another-principal")).rejects.toThrow(/OWNER_REQUIRED/);
    expect((await read("original-principal")).structuredContent.events).toMatchObject([{ eventId: event.eventId }]);
    expect(() => f.state.relay.requireFollowup(event.eventId, { ...owner, mcpPrincipal: "another-principal" }, 2)).toThrow(/OWNER_REQUIRED/);
    expect(() => f.seed({ mcpPrincipal: "another-principal" })).toThrow(/OWNER_REQUIRED/);

    const waitForInput = vi.fn();
    const jobs = { admissionStateStore: f.state, get: () => ({ ...a, mcpPrincipal: "original-principal" }),
      getActivity: () => f.state.getActivity(f.activity.activityId), getAgent: () => f.state.getAgent(f.agent.agentId),
      waitForInput } as unknown as CodexJobRegistry;
    const inputs = registerCodexInputTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, jobs, f.scopes);
    const foreign = { mcpReq: { _meta: f.metadata }, http: { authInfo: { scopes: ["bridge"], extra: { bridgeMcpPrincipal: "another-principal" } } } };
    await expect(inputs.readInput({ jobId: a.jobId }, foreign as any)).rejects.toThrow(/INPUT_JOB_UNAVAILABLE/);
    await expect(handlers.get("codex_answer")({ requestId: randomUUID(), jobId: a.jobId, questionRef: "a".repeat(64), answers: { choice: ["yes"] } }, foreign)).rejects.toThrow(/INPUT_JOB_UNAVAILABLE/);
    expect(waitForInput).not.toHaveBeenCalled();
  });
});

describe("#280 direct result and relay coordination", () => {
  it("holds only a terminal event during an actual wait and restores it after the finite end grace", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed(), waitId = randomUUID(), card = f.connect();
    expect(f.state.relay.beginDirectWait(a.jobId, f.owner, waitId, 20_000)).toBe(true);
    f.state.upsertJob({ ...a, version: 2, pendingInteractions: [{ interactionId: "question" }] });
    expect(f.state.relay.pending(f.activity.activityId).map(event => event.kind)).toEqual(["input"]);
    const event = f.finish(a);
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    const before = f.state.relay.registration(a.jobId)!.directWaits;
    f.connect(); f.state.relay.recover(f.activity.activityId); f.state.relay.pending(f.activity.activityId);
    expect(f.state.relay.registration(a.jobId)!.directWaits).toEqual(before);
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, randomUUID())).toBeUndefined();
    f.state.relay.endDirectWait(a.jobId, waitId);
    now += DIRECT_WAIT_GRACE_MS;
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
    expect(f.state.getEventJobSnapshot(a.jobId)?.status).toBe("completed");
  });

  it("preserves overlapping waits and bounds a vanished wait without renewal by cards", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed(), first = randomUUID(), second = randomUUID();
    f.state.relay.beginDirectWait(a.jobId, f.owner, first, 20_000);
    f.state.relay.beginDirectWait(a.jobId, f.owner, second, 40_000);
    const event = f.finish(a); f.state.relay.endDirectWait(a.jobId, first);
    now += 20_000; f.connect(); f.state.relay.recover(f.activity.activityId);
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    now += 30_000;
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
  });

  it("rejects excess waits rather than accepting an untracked direct wait", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed();
    for (let i = 0; i < 16; i++) expect(f.state.relay.beginDirectWait(a.jobId, f.owner, randomUUID(), 20_000)).toBe(true);
    expect(() => f.state.relay.beginDirectWait(a.jobId, f.owner, randomUUID(), 20_000)).toThrow(/DIRECT_WAIT_CAPACITY/);
    expect(f.state.getEventJobSnapshot(a.jobId)?.status).toBe("running");
    now += 20_000 + DIRECT_WAIT_GRACE_MS;
    expect(f.state.relay.beginDirectWait(a.jobId, f.owner, randomUUID(), 20_000)).toBe(true);
  });

  it("recovers the original completion when a direct wait ends before the Job", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed(), waitId = randomUUID();
    f.state.relay.beginDirectWait(a.jobId, f.owner, waitId, 60_000);
    f.state.relay.endDirectWait(a.jobId, waitId);
    now += DIRECT_WAIT_GRACE_MS + 1;
    const event = f.finish(a);
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
    expect(f.state.getEventJobSnapshot(a.jobId)?.status).toBe("completed");
  });

  it.each(["terminating", "termination-failed"])("holds a terminal notice while directly waiting on a %s Job", status => {
    const f = fixture(), a = f.seed({ status });
    expect(f.state.relay.beginDirectWait(a.jobId, f.owner, randomUUID(), 20_000)).toBe(true);
    f.finish(a);
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
  });

  it("atomically refuses entry after review and makes an unentered lease eligible again after expiry", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed(), event = f.finish(a), card = f.connect(), attempt = randomUUID();
    expect(f.state.relay.offerResult(a.jobId, f.owner, event.eventId, event.version)).toBe(true);
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt)?.state).toBe("leased");
    const review = f.state.relay.reviewResult(f.owner, event.eventId, event.version);
    expect(review).toMatchObject({ alreadyReviewed: false, dispatchEntered: false });
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBeUndefined();
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(false);
    now += RESULT_REVIEW_GRACE_MS - 1;
    expect(f.state.relay.reviewResult(f.owner, event.eventId, event.version)).toMatchObject({ alreadyReviewed: true, until: review.until });
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    now += 1;
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
    const retry = randomUUID();
    expect(f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, retry)?.state).toBe("leased");
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, retry)).toBe(true);
  });

  it.each(["sending", "unknown", "accepted", "rejected"] as const)("never replays an already %s send after late review and expiry", outcome => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), a = f.seed(), event = f.finish(a), card = f.connect(), attempt = randomUUID();
    f.state.relay.offerResult(a.jobId, f.owner, event.eventId, event.version);
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    expect(f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt)).toBe(true);
    if (outcome !== "sending") f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome);
    expect(f.state.relay.reviewResult(f.owner, event.eventId, event.version).dispatchEntered).toBe(true);
    now += RESULT_REVIEW_GRACE_MS + 60_000; f.connect();
    expect(f.state.relay.pending(f.activity.activityId)).toEqual([]);
    expect(f.state.relay.registration(a.jobId)?.event?.state).toBe(outcome);
  });

  it("requires the exact offered generation and original owner, without holding other Jobs", () => {
    const f = fixture(), a = f.seed(), b = f.seed(), event = f.finish(a), other = f.finish(b);
    expect(() => f.state.relay.reviewResult(f.owner, event.eventId, event.version)).toThrow(/RESULT_REVIEW_UNAVAILABLE/);
    f.state.relay.offerResult(a.jobId, f.owner, event.eventId, event.version);
    expect(() => f.state.relay.reviewResult({ scopeId: randomUUID() }, event.eventId, event.version)).toThrow(/OWNER_REQUIRED/);
    expect(() => f.state.relay.reviewResult(f.owner, event.eventId, event.version + 1)).toThrow(/RESULT_REVIEW_UNAVAILABLE/);
    f.state.relay.reviewResult(f.owner, event.eventId, event.version);
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([other.eventId]);
  });

  it("persists finite holds and send history through restart without restarting their deadline", () => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const directory = mkdtempSync(path.join(tmpdir(), "relay-direct-restart-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite"), f = fixture(file), a = f.seed(), waitId = randomUUID();
    f.state.relay.beginDirectWait(a.jobId, f.owner, waitId, 20_000);
    const event = f.finish(a); f.state.close();
    const restarted = new BridgeStateStore({ file }); stores.push(restarted);
    restarted.relay.connect(f.activity.activityId, f.owner, randomUUID());
    restarted.relay.recover(f.activity.activityId);
    expect(restarted.relay.pending(f.activity.activityId)).toEqual([]);
    now += 20_000 + DIRECT_WAIT_GRACE_MS;
    expect(restarted.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
  });

  it.each(["sending", "unknown", "accepted"] as const)("retains a %s terminal attempt after review and restart", outcome => {
    let now = 1_800_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const directory = mkdtempSync(path.join(tmpdir(), "relay-review-restart-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite"), f = fixture(file), a = f.seed(), event = f.finish(a);
    const card = f.connect(), attempt = randomUUID();
    f.state.relay.offerResult(a.jobId, f.owner, event.eventId, event.version);
    f.state.relay.claim(f.activity.activityId, f.owner, card, event.eventId, attempt);
    f.state.relay.enter(f.activity.activityId, f.owner, card, event.eventId, attempt);
    if (outcome !== "sending") f.state.relay.acknowledge(f.activity.activityId, f.owner, card, event.eventId, attempt, outcome);
    f.state.relay.reviewResult(f.owner, event.eventId, event.version); f.state.close();
    now += RESULT_REVIEW_GRACE_MS + 1;
    const restarted = new BridgeStateStore({ file }); stores.push(restarted);
    restarted.relay.connect(f.activity.activityId, f.owner, randomUUID()); restarted.relay.recover(f.activity.activityId);
    expect(restarted.relay.pending(f.activity.activityId)).toEqual([]);
    expect(restarted.relay.registration(a.jobId)?.event).toMatchObject({ eventId: event.eventId, attemptId: attempt, state: outcome });
  });

  it("removes the held-event index when its project is deleted", () => {
    const f = fixture(":memory:", true), a = f.seed(), waitId = randomUUID();
    f.state.relay.beginDirectWait(a.jobId, f.owner, waitId, 20_000); f.finish(a);
    expect(f.state.listMeta(`relay_deferred_v1/${f.activity.activityId}/`, 1)).toHaveLength(1);
    const projectId = f.project!.id, apply = (operations: any[]) => f.state.applyProjectOperations(operations, f.state.getProjectRegistryRevision(), [f.directory!]);
    apply([{ kind: "archive", projectId }]);
    const intent = f.state.projectLifecycle.pending().find(item => item.projectId === projectId)!;
    expect(f.state.transaction(() => f.state.projectLifecycle.complete(projectId, intent.revision))).toBe(true);
    apply([{ kind: "delete", projectId }]);
    expect(f.state.listMeta(`relay_deferred_v1/${f.activity.activityId}/`, 1)).toEqual([]);
  });

  it("does not let a page of held completions starve an unrelated ready event", () => {
    const f = fixture();
    for (let i = 0; i < 70; i++) {
      const a = f.seed(); f.state.relay.beginDirectWait(a.jobId, f.owner, randomUUID(), 20_000); f.finish(a);
    }
    const b = f.seed(), event = f.finish(b);
    expect(f.state.relay.pending(f.activity.activityId).map(e => e.eventId)).toEqual([event.eventId]);
  });

  it("keeps explicit relay stop authoritative after a wait ends", () => {
    const f = fixture(), a = f.seed(), waitId = randomUUID();
    f.state.relay.beginDirectWait(a.jobId, f.owner, waitId, 20_000);
    f.state.relay.stop(f.activity.activityId, f.owner, "relay");
    f.finish(a); f.state.relay.endDirectWait(a.jobId, waitId);
    f.connect();
    expect(f.state.relay.pending(f.activity.activityId, Date.now() + 120_000)).toEqual([]);
    expect(f.state.relay.goal(f.activity.activityId)?.monitoringStopped).toBe(true);
  });
});
