import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { BridgeStateStore } from "../src/stateStore.js";

const root = await mkdtemp(path.join(tmpdir(), "issue-138-state-access-"));
const file = path.join(root, "state.sqlite");
const outputFile = process.argv[2];
const sql: string[] = [];
const report: Record<string, unknown> = {
  issue: 138,
  testedAt: new Date().toISOString(),
  database: "disposable schema-24 fixture",
  productionDatabaseModified: false
};

try {
  const initial = new BridgeStateStore({ file });
  initial.close();
  seedScaleFixture(file, [
    { name: "100-jobs-100-agents", jobs: 100, agents: 100 },
    { name: "1000-jobs-500-agents", jobs: 1_000, agents: 500 },
    { name: "10000-jobs-1000-agents", jobs: 10_000, agents: 1_000 }
  ]);

  const store = new BridgeStateStore({ file, traceSql: statement => sql.push(statement) });
  try {
    const scales: Record<string, unknown>[] = [];
    for (const fixture of [
      { name: "100-jobs-100-agents", jobs: 100, agents: 100 },
      { name: "1000-jobs-500-agents", jobs: 1_000, agents: 500 },
      { name: "10000-jobs-1000-agents", jobs: 10_000, agents: 1_000 }
    ]) {
      sql.length = 0;
      const beforeHeap = process.memoryUsage().heapUsed;
      const started = performance.now();
      const overview = store.listDashboardArchivedJobsByAgent(fixture.name, 1);
      const overviewMs = performance.now() - started;
      const agentId = `${fixture.name}-agent-0000`;
      const historyStarted = performance.now();
      const history = store.listDashboardAgentRetainedJobs(fixture.name, agentId, 12);
      const historyMs = performance.now() - historyStarted;
      const loadedHistory = [
        ...(history.representative ? [history.representative] : []),
        ...history.history
      ];
      const summaries = store.dashboardJobSummaries(loadedHistory.map(job => job.jobId));
      const counts = store.dashboardArchivedCounts(fixture.name);
      const statements = [...sql];
      assert.equal(counts.total, fixture.jobs);
      assert.ok(overview.jobs.length <= fixture.agents);
      assert.ok(history.history.length <= 12);
      assert.equal(summaries.size, loadedHistory.length);
      assert.equal(writeStatements(statements).length, 0);
      scales.push({
        ...fixture,
        overviewLoadedRows: overview.jobs.length,
        overviewSqlStatements: statements.filter(isQuery).length - 3,
        overviewMs: rounded(overviewMs),
        agentHistoryLoadedRows: loadedHistory.length,
        agentHistoryTotal: history.total,
        agentHistoryMs: rounded(historyMs),
        completeArchivedCount: counts.total,
        heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - beforeHeap)
      });
    }
    report.dashboardScale = scales;

    sql.length = 0;
    const createdRepresentative = store.listDashboardArchivedJobsByAgent(
      "representative-order",
      1,
      "created"
    );
    const updatedRepresentative = store.listDashboardArchivedJobsByAgent(
      "representative-order",
      1,
      "updated"
    );
    const detailedHistory = store.listDashboardAgentRetainedJobs(
      "representative-order",
      "representative-order-agent",
      12
    );
    const exactHistorical = store.listDashboardRetainedJobsByIds(
      ["representative-order-old-13"],
      "representative-order"
    );
    const exactSummaries = store.dashboardJobSummaries(
      exactHistorical.map(job => job.jobId)
    );
    assert.equal(createdRepresentative.jobs[0]?.jobId, "representative-order-newer-completed");
    assert.equal(updatedRepresentative.jobs[0]?.jobId, "representative-order-old-13");
    assert.equal(detailedHistory.representative?.jobId, "representative-order-newer-completed");
    assert.deepEqual(
      detailedHistory.history.map(job => job.jobId),
      Array.from({length: 12}, (_, index) => `representative-order-old-${13 - index}`)
    );
    assert.deepEqual(exactHistorical.map(job => ({
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    })), [{
      jobId: "representative-order-old-13",
      status: "failed",
      createdAt: 13,
      updatedAt: 2_013
    }]);
    const exactExecution = exactSummaries
      .get("representative-order-old-13")?.execution as {model?: string} | undefined;
    assert.equal(exactExecution?.model, "gpt-5.6-sol");
    assert.equal(writeStatements(sql).length, 0);
    report.dashboardRepresentativeSelection = {
      createdTimeRepresentative: createdRepresentative.jobs[0]?.jobId,
      updatedTimeRepresentative: updatedRepresentative.jobs[0]?.jobId,
      detailRepresentative: detailedHistory.representative?.jobId,
      detailHistoryFirst: detailedHistory.history[0]?.jobId,
      detailHistoryRows: detailedHistory.history.length,
      exactHistoricalRows: exactHistorical.length,
      exactHistoricalSummaryLoaded: exactSummaries.has("representative-order-old-13"),
      writes: 0
    };

    store.upsertJob({
      jobId: "progress-job",
      scopeId: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      lastProgressAt: 1,
      pendingInteractions: []
    });
    sql.length = 0;
    store.recordJobTelemetryEvent(
      "progress-job",
      "app-progress",
      { type: "progress", details: { itemId: "progress-item" } },
      2,
      undefined,
      {
        updatedAt: 2,
        version: 2,
        lastProgressAt: 2,
        lastProgress: { message: "bounded" },
        pendingInteractions: []
      }
    );
    const progressWrites = writeStatements(sql).filter(statement =>
      !/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(statement)
    );
    assert.ok(progressWrites.length <= 4, `Public progress used ${progressWrites.length} writes`);

    sql.length = 0;
    store.updateJobProgressState("progress-job", {
      updatedAt: 3,
      version: 3,
      lastProgressAt: 3,
      lastProgress: { message: "state-only" },
      pendingInteractions: []
    });
    const stateOnlyWrites = writeStatements(sql).filter(statement =>
      !/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(statement)
    );
    assert.ok(stateOnlyWrites.length <= 2, `State-only progress used ${stateOnlyWrites.length} writes`);
    report.progressSqlTrace = {
      publicEventWrites: progressWrites.length,
      stateOnlyWrites: stateOnlyWrites.length,
      excludesTriggerInternalWrites: true
    };

    sql.length = 0;
    assert.equal(store.statusReadModel.job("progress-job")?.status, "running");
    assert.deepEqual(store.statusReadModel.scopeOverview("11111111-1111-4111-8111-111111111111"), {
      total: 1,
      active: 1,
      terminal: 0
    });
    assert.equal(writeStatements(sql).length, 0);
    report.statusReadModel = { sqlStatements: sql.filter(isQuery).length, writes: 0 };

    report.passed = true;
  } finally {
    store.close();
  }
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  report.temporaryFixtureRemoved = true;
}

const encodedReport = `${JSON.stringify(report, null, 2)}\n`;
if (outputFile) await writeFile(outputFile, encodedReport);
process.stdout.write(encodedReport);

function seedScaleFixture(
  file: string,
  fixtures: Array<{name:string;jobs:number;agents:number}>
): void {
  const database = new Database(file);
  database.pragma("foreign_keys = ON");
  const insertScope = database.prepare(
    "INSERT INTO scopes(scope_id,version,created_at,updated_at) VALUES (?,0,0,0)"
  );
  const insertActivity = database.prepare(`
    INSERT INTO activities(
      activity_id,scope_id,title,kind,handoff_policy,completion_trigger,lifecycle,
      waiting_on,verification,version,created_at,updated_at
    ) VALUES (?,?,'Scale fixture','implementation','none','manual','completed',
      'none','not-required',1,0,0)
  `);
  const insertAgent = database.prepare(`
    INSERT INTO agents(
      agent_id,scope_id,agent_name,normalized_name,lifecycle,version,created_at,updated_at
    ) VALUES (?,?,?,?,'idle',1,0,0)
  `);
  const insertJob = database.prepare(`
    INSERT INTO jobs(
      job_id,scope_id,request_id,activity_id,status,backend_kind,agent_id,cwd,sandbox,
      created_at,updated_at,archived_at,job_version,last_progress_at,summary,payload
    ) VALUES (?,?,?,?,'completed','app-server',?,'/tmp','read-only',?,?,?,1,? ,?,?)
  `);
  const insertRepresentativeJob = database.prepare(`
    INSERT INTO jobs(
      job_id,scope_id,request_id,activity_id,status,backend_kind,agent_id,cwd,sandbox,
      created_at,updated_at,archived_at,job_version,last_progress_at,summary,payload
    ) VALUES (?,?,?,?,?,'app-server',?,'/tmp','read-only',?,?,?,1,?,?,?)
  `);
  database.transaction(() => {
    for (const fixture of fixtures) {
      insertScope.run(fixture.name);
      for (let agentIndex = 0; agentIndex < fixture.agents; agentIndex++) {
        const suffix = String(agentIndex).padStart(4, "0");
        const agentId = `${fixture.name}-agent-${suffix}`;
        const activityId = `${fixture.name}-activity-${suffix}`;
        insertAgent.run(agentId, fixture.name, `Agent ${suffix}`, `agent-${suffix}`);
        insertActivity.run(activityId, fixture.name);
      }
      for (let jobIndex = 0; jobIndex < fixture.jobs; jobIndex++) {
        const suffix = String(jobIndex).padStart(5, "0");
        const agentSuffix = String(jobIndex % fixture.agents).padStart(4, "0");
        const agentId = `${fixture.name}-agent-${agentSuffix}`;
        const activityId = `${fixture.name}-activity-${agentSuffix}`;
        const timestamp = jobIndex + 1;
        insertJob.run(
          `${fixture.name}-job-${suffix}`,
          fixture.name,
          `${fixture.name}-request-${suffix}`,
          activityId,
          agentId,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          JSON.stringify({
            execution: { model: "gpt-5.6-sol", reasoningEffort: "high" },
            usage: {
              basis: "cumulative-difference",
              tokens: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 }
            }
          }),
          JSON.stringify({ resultOmitted: true })
        );
      }
    }

    const representativeScope = "representative-order";
    const representativeAgent = "representative-order-agent";
    const representativeActivity = "representative-order-activity";
    insertScope.run(representativeScope);
    insertAgent.run(
      representativeAgent,
      representativeScope,
      "Representative order Agent",
      "representative-order-agent"
    );
    insertActivity.run(representativeActivity, representativeScope);
    for (const job of [
      ...Array.from({length: 13}, (_, index) => ({
        jobId: `representative-order-old-${index + 1}`,
        requestId: `representative-order-old-request-${index + 1}`,
        status: "failed",
        createdAt: index + 1,
        updatedAt: 2_001 + index
      })),
      {
        jobId: "representative-order-newer-completed",
        requestId: "representative-order-newer-request",
        status: "completed",
        createdAt: 1_000,
        updatedAt: 1_001
      }
    ]) insertRepresentativeJob.run(
      job.jobId,
      representativeScope,
      job.requestId,
      representativeActivity,
      job.status,
      representativeAgent,
      job.createdAt,
      job.updatedAt,
      job.updatedAt,
      job.updatedAt,
      JSON.stringify({
        execution: { model: "gpt-5.6-sol", reasoningEffort: "high" }
      }),
      JSON.stringify({ resultOmitted: true })
    );
  })();
  database.close();
}

function writeStatements(statements: string[]): string[] {
  return statements.filter(statement =>
    /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|ROLLBACK)\b/iu.test(statement)
  );
}

function isQuery(statement: string): boolean {
  return /^\s*(?:WITH|SELECT)\b/iu.test(statement);
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
