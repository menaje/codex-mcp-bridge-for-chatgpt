import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { StateMaintenanceScheduler } from "../src/maintenanceScheduler.js";
import { InProcessOperationalStateService } from "../src/stateService.js";
import { ThreadConnectionController } from "../src/threadConnections.js";
import type { CodexUpstream } from "../src/upstream.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";
const writes = (statements: string[]) => statements.filter((sql) =>
  /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)
);

describe("state access ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps question and decision queries free of cleanup writes", () => {
    let now = Date.parse("2026-09-19T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sql: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: statement => sql.push(statement) });
    try {
      const question = store.questions.create(SCOPE, {
        requestId: randomUUID(),
        title: "Choose",
        questions: [{ id: "choice", header: "Choice", question: "Which?" }]
      });
      const answered = store.questions.submit(question, { choice: ["A"] });
      store.questions.claimNotification(answered);

      const card = store.decisionCards.create(SCOPE, {
        requestId: randomUUID(),
        title: "Confirm",
        html: "<p>Proceed?</p>"
      });
      const proof = { cardId: card.cardId, cardVersion: card.version, presentationRef: card.presentationRef };
      const submission = store.decisionCards.submit(SCOPE, proof, {
        submissionId: randomUUID(), intent: "confirm", fields: []
      });
      store.decisionCards.claimDelivery({
        scopeId: SCOPE,
        proof,
        receipt: submission.receipt,
        leaseOwner: randomUUID()
      });

      now += 21_000;
      sql.length = 0;
      expect(store.questions.get(SCOPE, question.questionId).notification).toBe("uncertain");
      expect(store.questions.readResponses(SCOPE, answered.responseRef)).toHaveLength(1);
      expect(store.decisionCards.get(SCOPE, card.cardId)).toMatchObject({ cardId: card.cardId });
      expect(store.decisionCards.latestSubmission(SCOPE, card.cardId)).toMatchObject({
        deliveryState: "acceptance-unknown"
      });
      expect(writes(sql)).toEqual([]);

      store.maintainQuestionRetention(now);
      store.maintainDecisionRetention(now);
      expect(writes(sql).some((statement) => /UPDATE/iu.test(statement))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("runs storage slices independently of the thread connection controller", async () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const eventMaintenance = vi.spyOn(store, "maintainEventRetention");
    const controller = new ThreadConnectionController(
      store.threadConnections,
      {} as CodexUpstream
    );
    const scheduler = new StateMaintenanceScheduler(new InProcessOperationalStateService(store));
    try {
      await controller.sweep();
      expect(eventMaintenance).not.toHaveBeenCalled();
      expect(await scheduler.sweep("events")).toMatchObject({ slice: "events", failed: false });
      expect(eventMaintenance).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.close();
      await controller.close();
      store.close();
    }
  });

  it("defers scheduled storage work while foreground jobs are active", async () => {
    let now = 1_000;
    let active = true;
    const store = new BridgeStateStore({ file: ":memory:" });
    const eventMaintenance = vi.spyOn(store, "maintainEventRetention");
    const scheduler = new StateMaintenanceScheduler(new InProcessOperationalStateService(store), {
      now: () => now,
      shouldDefer: () => active,
      maxDeferMs: 60_000
    });
    try {
      expect(await scheduler.sweep()).toMatchObject({
        slice: "events",
        changed: 0,
        failed: false,
        deferred: true
      });
      expect(eventMaintenance).not.toHaveBeenCalled();

      expect(await scheduler.sweep("events")).toMatchObject({
        slice: "events",
        failed: false,
        deferred: false
      });
      expect(eventMaintenance).toHaveBeenCalledTimes(1);

      now += 60_000;
      expect(await scheduler.sweep()).toMatchObject({
        slice: "events",
        failed: false,
        deferred: false
      });
      expect(eventMaintenance).toHaveBeenCalledTimes(2);

      active = false;
      expect(await scheduler.sweep()).toMatchObject({
        slice: "history",
        failed: false,
        deferred: false
      });
    } finally {
      scheduler.close();
      store.close();
    }
  });

  it("does not force scheduled storage work through an active foreground period by default", async () => {
    let now = 1_000;
    const store = new BridgeStateStore({ file: ":memory:" });
    const eventMaintenance = vi.spyOn(store, "maintainEventRetention");
    const scheduler = new StateMaintenanceScheduler(new InProcessOperationalStateService(store), {
      now: () => now,
      shouldDefer: () => true
    });
    try {
      expect(await scheduler.sweep()).toMatchObject({ slice: "events", deferred: true });
      now += 24 * 60 * 60 * 1_000;
      expect(await scheduler.sweep()).toMatchObject({ slice: "events", deferred: true });
      expect(eventMaintenance).not.toHaveBeenCalled();
    } finally {
      scheduler.close();
      store.close();
    }
  });

  it("reuses one logical command ID after an outcome-unknown maintenance response", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("unknown"), {
        code: "STATE_OUTCOME_UNKNOWN"
      }))
      .mockRejectedValueOnce(Object.assign(new Error("recovering"), {
        code: "STATE_RECOVERING"
      }))
      .mockResolvedValueOnce({ operation: "maintain", slice: "events", changed: 0 });
    const scheduler = new StateMaintenanceScheduler({ execute });
    try {
      expect(await scheduler.sweep("events")).toMatchObject({ failed: true });
      expect(await scheduler.sweep("events")).toMatchObject({ failed: true });
      expect(await scheduler.sweep("events")).toMatchObject({ failed: false });
      expect(execute).toHaveBeenCalledTimes(3);
      const firstOptions = execute.mock.calls[0]?.[1];
      const secondOptions = execute.mock.calls[1]?.[1];
      const thirdOptions = execute.mock.calls[2]?.[1];
      expect(firstOptions).toMatchObject({
        commandId: expect.any(String),
        aggregateKey: "maintenance:events"
      });
      expect(secondOptions).toEqual(firstOptions);
      expect(thirdOptions).toEqual(firstOptions);
    } finally {
      scheduler.close();
    }
  });

  it("commits compatibility maintenance as separate domain transactions", () => {
    const sql: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: statement => sql.push(statement) });
    try {
      sql.length = 0;
      store.maintainRetention();
      expect(sql.filter((statement) => /^BEGIN IMMEDIATE$/iu.test(statement.trim())).length)
        .toBeGreaterThanOrEqual(4);
    } finally {
      store.close();
    }
  });

  it("loads overview and Agent history through bounded SQL projections", () => {
    const sql: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: statement => sql.push(statement) });
    try {
      const agent = store.createAgent({ scopeId: SCOPE, agentName: "Bounded history", now: 1 });
      for (let index = 0; index < 30; index++) {
        const jobId = `history-${String(index).padStart(2, "0")}`;
        store.upsertJob({
          jobId,
          requestId: `request-${String(index).padStart(2, "0")}`,
          scopeId: SCOPE,
          agentId: agent.agentId,
          status: "completed",
          createdAt: index + 1,
          updatedAt: index + 1
        });
        store.deleteJob(jobId);
      }

      sql.length = 0;
      const overview = store.listDashboardArchivedJobsByAgent(SCOPE, 13);
      const history = store.listDashboardAgentRetainedJobs(SCOPE, agent.agentId, 12);
      const loadedHistory = [history.representative!, ...history.history];
      const summaries = store.dashboardJobSummaries(loadedHistory.map((job) => job.jobId));
      expect(overview.jobs).toHaveLength(13);
      expect(overview.totalsByAgent.get(agent.agentId)).toBe(30);
      expect(history).toMatchObject({ total: 30 });
      expect(history.representative).toMatchObject({ jobId: "history-29" });
      expect(history.history).toHaveLength(12);
      expect(summaries.size).toBe(13);
      expect(writes(sql)).toEqual([]);
      expect(sql.filter((statement) => /^\s*(?:WITH|SELECT)\b/iu.test(statement))).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("separates representative execution order from history order and resolves exact problem Jobs", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const agent = store.createAgent({ scopeId: SCOPE, agentName: "Ordering", now: 1 });
      const olderLateJob = "older-late-failure";
      const newerJob = "newer-completion";
      store.upsertJob({
        jobId: olderLateJob,
        requestId: "44444444-4444-4444-8444-444444444444",
        scopeId: SCOPE,
        agentId: agent.agentId,
        status: "failed",
        createdAt: 10,
        updatedAt: 100
      });
      store.deleteJob(olderLateJob);
      store.upsertJob({
        jobId: newerJob,
        requestId: "55555555-5555-4555-8555-555555555555",
        scopeId: SCOPE,
        agentId: agent.agentId,
        status: "completed",
        createdAt: 20,
        updatedAt: 90
      });
      store.deleteJob(newerJob);

      expect(store.listDashboardArchivedJobsByAgent(SCOPE, 1, "created").jobs)
        .toEqual([expect.objectContaining({ jobId: newerJob, status: "completed" })]);
      expect(store.listDashboardArchivedJobsByAgent(SCOPE, 1, "updated").jobs)
        .toEqual([expect.objectContaining({ jobId: olderLateJob, status: "failed" })]);
      expect(store.listDashboardRetainedJobsByIds([olderLateJob], SCOPE))
        .toEqual([expect.objectContaining({
          jobId: olderLateJob,
          status: "failed",
          createdAt: 10,
          updatedAt: 100
        })]);
    } finally {
      store.close();
    }
  });

  it("keeps the exact created-time representative outside the top twelve updated history rows", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const agent = store.createAgent({ scopeId: SCOPE, agentName: "History boundary", now: 1 });
      for (let index = 1; index <= 13; index += 1) {
        const jobId = `older-${String(index).padStart(2, "0")}`;
        store.upsertJob({
          jobId,
          requestId: `66666666-6666-4666-8${String(index).padStart(3, "0")}-666666666666`,
          scopeId: SCOPE,
          agentId: agent.agentId,
          status: "failed",
          createdAt: index,
          updatedAt: 2_000 + index
        });
        store.deleteJob(jobId);
      }
      store.upsertJob({
        jobId: "newest-run",
        requestId: "77777777-7777-4777-8777-777777777777",
        scopeId: SCOPE,
        agentId: agent.agentId,
        status: "completed",
        createdAt: 1_000,
        updatedAt: 1_001
      });
      store.deleteJob("newest-run");

      const overview = store.listDashboardArchivedJobsByAgent(SCOPE, 1, "created");
      const detail = store.listDashboardAgentRetainedJobs(SCOPE, agent.agentId, 12);
      expect(overview.jobs).toEqual([
        expect.objectContaining({ jobId: "newest-run", status: "completed" })
      ]);
      expect(detail.representative).toMatchObject({ jobId: "newest-run", status: "completed" });
      expect(detail.history.map((job) => job.jobId)).toEqual(
        Array.from({length: 12}, (_, index) => `older-${String(13 - index).padStart(2, "0")}`)
      );
      expect(detail.total).toBe(14);
    } finally {
      store.close();
    }
  });

  it("does not rewrite current-policy events during a maintenance sweep", () => {
    const sql: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: statement => sql.push(statement) });
    try {
      store.upsertJob({
        jobId: "current-policy",
        requestId: "33333333-3333-4333-8333-333333333333",
        scopeId: SCOPE,
        status: "running",
        createdAt: 1,
        updatedAt: 1
      });
      store.recordJobTelemetryEvent(
        "current-policy",
        "app-progress",
        { type: "progress", details: { itemId: "one" } },
        2
      );
      sql.length = 0;
      expect(store.maintainEventRetention(3).processed).toBeGreaterThan(0);
      expect(sql.some((statement) => /^\s*UPDATE job_events SET payload=/iu.test(statement)))
        .toBe(false);
    } finally {
      store.close();
    }
  });
});
