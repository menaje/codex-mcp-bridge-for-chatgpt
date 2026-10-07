import { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fixtureScope, issue242Fixture } from "../scripts/issue-242-fixture.js";
import { ChangeSignal } from "../src/changeSignal.js";
import { nativeCompletionNotification, nativeCompletionRetryMs } from "../src/completionDelivery.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { createModelCatalog } from "../src/server.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { registerBridgeTools } from "../src/tools.js";
import type { CodexProgress, CodexUpstream } from "../src/upstream.js";

function activity(store: BridgeStateStore, policy: "notify" | "verify" = "notify", complete = true) {
  const activityId = randomUUID(), jobId = randomUUID();
  store.createActivity({ activityId, scopeId: fixtureScope, handoffPolicy: policy, completionTrigger: "sealed-jobs-terminal" });
  store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: jobId, status: "running", updatedAt: Date.now() });
  store.sealActivity(activityId);
  if (complete) store.upsertJob({ jobId, activityId, scopeId: fixtureScope, requestId: jobId, status: "completed", updatedAt: Date.now() });
  return { activityId, jobId };
}

describe("issue 242 W3 durable native completions", () => {
  it("emits readiness only after the outer durable commit; excludes progress, verify, duplicates and rollback", async () => {
    const f = await issue242Fixture(40);
    const upstream: CodexUpstream = { async listTools() { return { tools: [] }; }, async callTool() { throw new Error("No execution"); }, async close() {} };
    const mcp = new McpServer({ name: "W3-fixture", version: "1" });
    const registration = registerBridgeTools(mcp, f.config, upstream, f.sessions, f.jobs,
      createModelCatalog(f.config, upstream), f.settings, new ScopeResolver({ stateStore: f.store }));
    const topics: string[] = [];
    const off = registration.applicationService.subscribeChanges!(topic => topics.push(topic));
    try {
      const progress = f.jobs as unknown as { recordProgress(job: unknown, value: CodexProgress): void };
      const jobs = f.jobs.list(40, 0).slice(0, 4);
      jobs.forEach(job => { job.status = "running"; });
      const observed = await f.measure(() => {
        for (let i = 0; i < 400; i++) progress.recordProgress(jobs[i % 4], { progress: i });
      });
      expect(topics).toEqual(Array(400).fill("dashboard"));
      expect(f.jobs.nativeCompletionClaimDiagnostics()).toEqual({ emptyPreflights: 0, transactions: 0, lostRaces: 0 });
      expect(observed.sql.BEGIN ?? 0).toBe(0);
      expect(observed.changedRows).toBe(0);
      f.settings.update({ uiLocalePreference: "en" }, f.settings.current.settingsRevision);
      expect(topics).not.toContain("completion-outbox-ready");
      activity(f.store, "verify");
      expect(topics).not.toContain("completion-outbox-ready");
      expect(() => f.store.transaction(() => { activity(f.store); throw new Error("rollback"); })).toThrow("rollback");
      expect(topics).not.toContain("completion-outbox-ready");
      let id = "";
      f.store.transaction(() => {
        id = activity(f.store).activityId;
        expect(topics).not.toContain("completion-outbox-ready");
      });
      expect(topics.filter(t => t === "completion-outbox-ready")).toHaveLength(1);
      const done = f.store.listJobs().find(job => job.activityId === id)!;
      f.store.upsertJob({ ...done, updatedAt: Date.now() });
      expect(topics.filter(t => t === "completion-outbox-ready")).toHaveLength(1);
      const manual = f.jobs.createActivity({ scopeId: fixtureScope, handoffPolicy: "notify", completionTrigger: "manual" });
      f.jobs.completeActivity(manual.activityId);
      expect(topics.filter(t => t === "completion-outbox-ready")).toHaveLength(2);
      // Inserted and already leased/delivered within the same outer transaction
      // is not processable at commit and must not advertise readiness.
      f.store.transaction(() => {
        const inner = activity(f.store);
        const item = f.store.listCompletionOutbox(inner.activityId)[0]!;
        f.store.claimCompletionOutbox(item.outboxId, item.scopeId, "inline");
        f.store.markCompletionOutboxDelivered(item.outboxId, item.scopeId, "inline");
      });
      expect(topics.filter(t => t === "completion-outbox-ready")).toHaveLength(2);
    } finally { off(); registration.dispose(); await mcp.close(); await f.close(); }
  }, 20_000);

  it("has zero empty writer transactions and distinguishes a concurrent consumer winning after preflight", async () => {
    const f = await issue242Fixture(0);
    try {
      const empty = await f.measure(() => Array.from({ length: 20 }, () => f.jobs.claimNativeCompletionNotifications(10, "A")));
      expect(empty.sql).toEqual({ SELECT: 20 });
      expect(empty.changedRows).toBe(0);
      activity(f.store);
      const preflight = f.store.nativeCompletionAvailability.bind(f.store);
      vi.spyOn(f.store, "nativeCompletionAvailability").mockImplementationOnce(() => {
        const value = preflight();
        // Two native consumers share the one authoritative writer. B runs
        // after A's preflight and before A acquires/revalidates under its lock.
        const item = f.store.listPendingNotifyCompletionOutbox()[0]!;
        expect(f.store.claimCompletionOutbox(item.outboxId, item.scopeId, "B")).toBeDefined();
        return value;
      });
      const race = await f.measure(() => f.jobs.claimNativeCompletionNotifications(10, "A"));
      expect(race.result).toEqual([]);
      expect(race.sql.BEGIN).toBe(2); // B's successful claim plus A's losing transaction
      expect(race.changedRows).toBe(1); // only B changed a lease
      expect(f.jobs.nativeCompletionClaimDiagnostics()).toEqual({ emptyPreflights: 20, transactions: 1, lostRaces: 1 });
      expect(f.store.listCompletionOutbox()[0]!.leaseOwner).toBe("B");
    } finally { await f.close(); }
  });

  it("drains 25 durable completions in batches of at most ten with stable IDs and no Job execution", async () => {
    const f = await issue242Fixture(0);
    try {
      for (let i = 0; i < 25; i++) activity(f.store);
      const batches: number[] = [];
      const ids = new Set<string>();
      for (;;) {
        const batch = f.jobs.claimNativeCompletionNotifications(100, "consumer");
        if (!batch.length) break;
        batches.push(batch.length);
        batch.forEach(item => ids.add(nativeCompletionNotification({ ...item, channel: "notify" }).eventId));
        f.jobs.markNativeCompletionNotificationsDelivered(batch.map(item => item.outboxId), "consumer");
      }
      expect(batches).toEqual([10, 10, 5]);
      expect(ids.size).toBe(25);
      expect(f.store.nativeCompletionAvailability()).toEqual({ available: false });
      expect(f.store.listJobEvents(f.store.listJobs()[0]!.jobId).filter(e => e.status === "completed")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("persists bounded delivery backoff, ignores wrong owners and recovers ack loss, lease expiry and restart", async () => {
    const f = await issue242Fixture(0);
    let reopened: BridgeStateStore | undefined;
    try {
      activity(f.store);
      const now = Date.now();
      const first = f.jobs.claimNativeCompletionNotifications(10, "A")[0]!;
      const eventId = nativeCompletionNotification({ ...first, channel: "notify" }).eventId;
      const wrong = await f.measure(() => f.jobs.releaseNativeCompletionNotifications([first.outboxId], "B"));
      expect(wrong.changedRows).toBe(0);
      f.jobs.releaseNativeCompletionNotifications([first.outboxId], "A");
      const released = f.store.getCompletionOutbox(first.outboxId)!;
      expect(released.nextAttemptAt! - now).toBeGreaterThanOrEqual(5_000);
      expect(f.jobs.claimNativeCompletionNotifications(10, "A")).toEqual([]);
      expect(f.store.claimCompletionOutbox(first.outboxId, fixtureScope, "B", 1_000, released.nextAttemptAt! - 1)).toBeUndefined();
      const retry = f.store.claimCompletionOutbox(first.outboxId, fixtureScope, "B", 1_000, released.nextAttemptAt!)!;
      expect(retry.attemptCount).toBe(2);
      expect(nativeCompletionNotification({ ...retry, channel: "notify" }).eventId).toBe(eventId);
      // Presentation succeeded but ack and release both disappeared: preserve lease until expiry.
      await f.jobs.closeThreadConnections();
      f.store.close();
      reopened = new BridgeStateStore({ file: f.file });
      expect(reopened.nativeCompletionAvailability(retry.leaseExpiresAt! - 1).available).toBe(false);
      expect(reopened.claimCompletionOutbox(first.outboxId, fixtureScope, "restart", 1_000, retry.leaseExpiresAt! - 1)).toBeUndefined();
      const recovered = reopened.claimCompletionOutbox(first.outboxId, fixtureScope, "restart", 1_000, retry.leaseExpiresAt!)!;
      expect(nativeCompletionNotification({ ...recovered, channel: "notify" }).eventId).toBe(eventId);
      reopened.markCompletionOutboxDelivered(first.outboxId, fixtureScope, "restart");
      // Ack committed but response was lost; replay is idempotent and cannot re-deliver.
      reopened.markCompletionOutboxDelivered(first.outboxId, fixtureScope, "restart");
      expect(reopened.nativeCompletionAvailability()).toEqual({ available: false });
      expect([1, 2, 3, 7, 100].map(nativeCompletionRetryMs)).toEqual([5_000, 10_000, 20_000, 300_000, 300_000]);
    } finally { reopened?.close(); await f.close(); }
  });

  it("carries epoch and per-topic revision for lost/coalesced events and ignores unknown cursors", async () => {
    const changes = new ChangeSignal(["dashboard", "completion-outbox-ready"]);
    const start = await changes.wait();
    for (let i = 0; i < 400; i++) changes.notify("dashboard");
    expect((await changes.wait(start.revision, 0)).topics).toEqual(["dashboard"]);
    changes.notify("completion-outbox-ready");
    const ready = await changes.wait(start.revision, 0);
    expect(ready.topicRevisions["completion-outbox-ready"]).toBe(ready.revision);
    expect((await changes.wait(start.revision, 0)).topicRevisions).toEqual(ready.topicRevisions);
    expect((await changes.wait(ready.revision, 0)).topics).toEqual([]);
    const restart = new ChangeSignal(["dashboard", "completion-outbox-ready"]);
    const resync = await restart.wait(ready.revision, 0);
    expect(resync.revision.split(":")[0]).not.toBe(ready.revision.split(":")[0]);
    expect(resync.supportedTopics).toContain("completion-outbox-ready");
    changes.close(); restart.close();
  });
});
