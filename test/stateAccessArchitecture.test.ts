import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { StateMaintenanceScheduler } from "../src/maintenanceScheduler.js";
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
    const scheduler = new StateMaintenanceScheduler(store);
    try {
      await controller.sweep();
      expect(eventMaintenance).not.toHaveBeenCalled();
      expect(scheduler.sweep("events")).toMatchObject({ slice: "events", failed: false });
      expect(eventMaintenance).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.close();
      await controller.close();
      store.close();
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
      const history = store.listDashboardAgentRetainedJobs(SCOPE, agent.agentId, 13);
      const summaries = store.dashboardJobSummaries(history.jobs.map((job) => job.jobId));
      expect(overview.jobs).toHaveLength(13);
      expect(overview.totalsByAgent.get(agent.agentId)).toBe(30);
      expect(history).toMatchObject({ total: 30 });
      expect(history.jobs).toHaveLength(13);
      expect(summaries.size).toBe(13);
      expect(writes(sql)).toEqual([]);
      expect(sql.filter((statement) => /^\s*(?:WITH|SELECT)\b/iu.test(statement))).toHaveLength(3);
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
