import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issue242Fixture, fixtureScope } from "../scripts/issue-242-fixture.js";
import { ChildProcessStateReadService, type StateReadObservation } from "../src/stateReadProcess.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { CodexJobRegistry, createBridgeReadProjectionService } from "../src/tools.js";
import { createModelCatalog } from "../src/server.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type { CodexUpstream } from "../src/upstream.js";

async function drained(service: ChildProcessStateReadService) {
  const until = Date.now() + 5_000;
  while (service.health().inFlight && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  expect(service.health().inFlight).toBe(0);
}

describe("issue 242 shared read contract", () => {
  it("keeps Dashboard state and pending inputs independent of retained event bodies", async () => {
    const f = await issue242Fixture(20);
    const retained = f.jobs.list(20, 0);
    const seeded = [retained[0]!, retained[10]!, retained[1]!].map((job, index) => index < 2
      ? { ...job, jobId: randomUUID(), requestId: `pending-job-${index}`, activityId: randomUUID(), status: "running" as const,
        terminalOrigin: undefined, terminalVersion: undefined, endedAt: undefined, endedAtSource: undefined,
        result: undefined, error: undefined }
      : job);
    f.store.transaction(() => {
      for (const [index, job] of seeded.entries()) {
        const { promise: _promise, ...persisted } = job;
        if (index < 2) {
          f.store.upsertJob({ ...persisted, trackingState: "connected",
            pendingInteractions: [{ interactionId: `pending-${index}`, origin: index === 0 ? "codex-question" : "app-approval",
              kind: index === 0 ? "user-input" : "command-approval", threadId: job.threadId || "fixture-input",
              turnId: "fixture-turn", itemId: "fixture-item", summary: "Pending fixture input", isBlocking: true }] });
          f.store.setAgentExecutionState(job.agentId!, "waiting-input", { currentJobId: job.jobId });
        }
        for (let event = 0; event < 200; event++) f.store.recordJobTelemetryEvent(job.jobId, "app-agent-message", {
          eventId: `${index}-${event}`, type: "agent-message", phase: "updated", createdAt: Date.now(),
          summary: "Retained fixture event", details: { text: "한글 fixture text ".repeat(250) }
        });
      }
    });
    const readOnly = new BridgeStateStore({ file: f.file, readOnly: true });
    const full = new CodexJobRegistry({ stateStore: readOnly, allowedRoots: [f.root], projectionOnly: true });
    const upstream: CodexUpstream = { async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("No execution in read fixture."); }, async close() {} };
    const inline = createBridgeReadProjectionService(f.config, upstream,
      new SessionRegistry({ stateStore: readOnly, allowedRoots: [f.root], projectionOnly: true }), full,
      createModelCatalog(f.config, upstream), new UserSettingsStore(f.config, { stateStore: readOnly, projectionOnly: true }),
      new ScopeResolver({ stateStore: readOnly }));
    const query = { scopeId: fixtureScope, limit: 2, includeHistory: true,
      inspectRuntime: false, historyMode: "jobs" as const, statusFilter: "all" as const,
      problems: { review: "pending" as const, kind: "all" as const, offset: 0 } };
    const baseline = await inline.dashboardSnapshot(query);
    const digest = () => createHash("sha256").update(JSON.stringify(f.store.listJobEvents(seeded[0]!.jobId))).digest("hex");
    const eventsBefore = digest();
    const service = await ChildProcessStateReadService.start(f.file, f.environment);
    const states = (view: typeof baseline) => view.activeRows.map(row => ({
      jobId: row.jobId, rowKey: row.rowKey, scopeId: row.scopeId, status: row.status,
      executionRevision: row.executionRevision, policyRevision: row.policyRevision
    }));
    try {
      const observed = await f.measure(() => service.dashboardSnapshot(query));
      expect(observed.changedRows).toBe(0);
      expect(observed.result.counts).toEqual(baseline.counts);
      expect(observed.result.terminalRows).toEqual(baseline.terminalRows);
      expect(states(observed.result)).toEqual(states(baseline));
      expect(observed.result.activeRows.map(row => row.status)).toEqual(expect.arrayContaining(["input-required", "approval-required"]));
      expect(digest()).toBe(eventsBefore);
      expect(() => f.store.listJobsForDashboard()).toThrow("query-only projection");

      // A valid SQLite JSON value with invalid text cannot affect a list that
      // does not use that event. Exact event reads retain their strict parser.
      const unreadable = JSON.stringify({ text: String.fromCharCode(0xd800) });
      f.database.prepare("UPDATE job_events SET payload=? WHERE event_id=(SELECT MAX(event_id) FROM job_events WHERE job_id=? AND event_type='app-agent-message')")
        .run(unreadable, seeded[0]!.jobId);
      expect(() => f.store.listJobs()).toThrow("Invalid job public events");
      expect(() => f.store.listJobEvents(seeded[0]!.jobId)).toThrow("Invalid job event payload");
      const after = await service.dashboardSnapshot(query);
      expect(after.counts).toEqual(baseline.counts);
      expect(after.terminalRows).toEqual(baseline.terminalRows);
      expect(states(after)).toEqual(states(baseline));
    } finally { await service.close(); await full.closeThreadConnections(); readOnly.close(); await f.close(); }
  }, 15_000);

  it("hydrates only the requested scope and omits Session payloads from Settings and detail", async () => {
    const f = await issue242Fixture(20);
    const service = await ChildProcessStateReadService.start(f.file, f.environment);
    try {
      const baseline = await service.dashboardSnapshot({ scopeId: fixtureScope, includeHistory: true });
      const otherScope = "22222222-2222-4222-8222-222222222222";
      const otherAgent = f.store.createAgent({ scopeId: otherScope, agentName: "Other scope" });
      const otherJob = randomUUID();
      f.store.upsertSession({ threadId: "other-thread", scopeId: otherScope, backendKind: "mcp-server",
        cwd: f.root, sandbox: "read-only", lastUsedAt: Date.now() });
      f.store.upsertJob({ jobId: otherJob, agentId: otherAgent.agentId, activityId: randomUUID(),
        scopeId: otherScope, requestId: "other-request", status: "completed", updatedAt: Date.now() });
      // Valid JSON satisfies SQLite's constraint; its unpaired surrogate is
      // rejected by the application's text-integrity parser if hydrated.
      const unreadable = JSON.stringify({ fixture: String.fromCharCode(0xd800) });
      f.database.prepare("UPDATE sessions SET selection=? WHERE thread_id=?").run(unreadable, "other-thread");
      f.database.prepare("UPDATE jobs SET payload=? WHERE job_id=?").run(unreadable, otherJob);
      const view = await service.dashboardSnapshot({ scopeId: fixtureScope, includeHistory: true });
      expect(view.counts.retainedJobs).toBe(20);
      expect(view.counts).toEqual(baseline.counts);
      expect(view.terminalRows).toEqual(baseline.terminalRows);
      const row = view.terminalRows[0]!;
      expect(row).toBeDefined();
      // These paths do not use Session content, even in the selected scope.
      f.database.prepare("UPDATE sessions SET selection=? WHERE scope_id=?").run(unreadable, fixtureScope);
      const detail = await service.dashboardHistoryDetail({ scopeId: fixtureScope, rowKey: row.rowKey });
      expect(detail.historyRevision).toBe(row.historyRevision);
      expect((await service.settingsSnapshot()).settings.registryRevision).toBe(f.settings.current.registryRevision);
      expect(() => new SessionRegistry({ stateStore: f.store, projectionOnly: true,
        projectionSessions: false })).toThrow("query-only projection");
      expect(() => new CodexJobRegistry({ stateStore: f.store, projectionOnly: true,
        projectionJobs: { scopeId: fixtureScope } })).toThrow("query-only projection");
    } finally { await service.close(); await f.close(); }
  }, 15_000);

  it("preserves paged ordering, counts and detail revisions with bounded SQL", async () => {
    const f = await issue242Fixture(120), observations: StateReadObservation[] = [];
    const service = await ChildProcessStateReadService.start(f.file, f.environment, { onMeasurement: x => observations.push(x) });
    try {
      const all = await service.dashboardSnapshot({ limit: 100, includeHistory: true });
      const page = await service.dashboardSnapshot({ limit: 2, includeHistory: true });
      const next = await service.dashboardSnapshot({ limit: 2, terminalOffset: 2, includeHistory: true });
      expect(page.counts).toEqual(all.counts);
      expect(next.counts).toEqual(all.counts);
      expect([...page.terminalRows, ...next.terminalRows]).toEqual(all.terminalRows.slice(0, 4));
      expect(page.pagination.terminal.total).toBe(all.pagination.terminal.total);
      const row = page.terminalRows[0]!;
      const detail = await service.dashboardHistoryDetail({ rowKey: row.rowKey });
      expect(detail.historyRevision).toBe(row.historyRevision);
      expect(row.history).toHaveLength(3);
      for(const [index,preview] of row.history.entries())expect(detail.history[index]).toMatchObject(preview);
      expect(detail.history.length).toBeLessThanOrEqual(12);
      expect(detail.historyCount).toBe(row.historyCount);
      expect(detail.policyRevision).toBe(row.policyRevision);
      expect(observations.at(-1)?.selectStatements).toBeLessThan(50);
      expect(observations.slice(0, 3).every(x => x.selectStatements < 70)).toBe(true);
      await service.settingsSnapshot();
      expect(observations.at(-1)?.jobsMs).toBeLessThan(5);
      expect(() => f.jobs.assertJobMayExecute("absent")).toThrow("PROJECT_MANAGEMENT_ENDED");
    } finally { await service.close(); await f.close(); }
  }, 20_000);
  it("coalesces equal queries, cancelling A without cancelling B", async () => {
    const f = await issue242Fixture(40), observations: StateReadObservation[] = [];
    const service = await ChildProcessStateReadService.start(f.file, f.environment, { onMeasurement: x => observations.push(x) });
    const cancel = new AbortController();
    try {
      const a = service.dashboardSnapshot({ limit: 2, includeHistory: false }, { signal: cancel.signal });
      const aFailure = expect(a).rejects.toThrow("STATE_READ_CANCELLED");
      const b = service.dashboardSnapshot({ includeHistory: false, limit: 2 });
      await new Promise(resolve => setTimeout(resolve, 0));
      cancel.abort();
      await aFailure;
      expect((await b).counts.retainedJobs).toBe(40);
      expect(observations).toHaveLength(1);
      await drained(service);
    } finally { await service.close(); await f.close(); }
  }, 15_000);

  it("keeps the physical slot after the last waiter leaves, skips queued work and permits a fresh retry", async () => {
    const f = await issue242Fixture(0), observations: StateReadObservation[] = [];
    const service = await ChildProcessStateReadService.start(f.file, f.environment, { onMeasurement: x => observations.push(x) });
    const pid = service.processId!, cancel = new AbortController();
    let stopped = false;
    try {
      process.kill(pid, "SIGSTOP"); stopped = true;
      const a = service.dashboardSnapshot({}, { signal: cancel.signal });
      const failure = expect(a).rejects.toThrow("STATE_READ_CANCELLED");
      await new Promise(resolve => setTimeout(resolve, 10));
      cancel.abort(); await failure;
      expect(service.health().inFlight).toBe(1);
      const retry = service.dashboardSnapshot();
      expect(service.health().inFlight).toBe(2);
      process.kill(pid, "SIGCONT"); stopped = false;
      expect((await retry).counts.retainedJobs).toBe(0);
      await drained(service);
      expect(observations.filter(x => x.callerAbandoned)).toHaveLength(1);
      expect(observations.find(x => x.callerAbandoned)?.jobsMs).toBe(0);
    } finally { if (stopped) process.kill(pid, "SIGCONT"); await service.close(); await f.close(); }
  }, 15_000);

  it("does not join a pending query after a committed write and includes queue wait in the caller deadline", async () => {
    const f = await issue242Fixture(0);
    const service = await ChildProcessStateReadService.start(f.file, f.environment);
    const pid = service.processId!;
    let stopped = false;
    try {
      process.kill(pid, "SIGSTOP"); stopped = true;
      const a = service.dashboardSnapshot({}, { deadlineAt: Date.now() + 30 });
      const failure = expect(a).rejects.toThrow("STATE_READ_STALE");
      f.settings.update({ uiLocalePreference: "ko" }, 0);
      const b = service.dashboardSnapshot();
      expect(service.health().inFlight).toBe(2);
      await failure;
      expect(service.health().inFlight).toBe(2);
      process.kill(pid, "SIGCONT"); stopped = false;
      expect((await b).uiLocalePreference).toBe("ko");
      await drained(service);
    } finally { if (stopped) process.kill(pid, "SIGCONT"); await service.close(); await f.close(); }
  }, 15_000);

  it("rejects A's completed late read after archive/delete and same-cwd B registration", async () => {
    const f = await issue242Fixture(0);
    const apply = (operations: Parameters<typeof f.settings.updateWithProjectOperations>[1]) =>
      f.settings.updateWithProjectOperations({}, operations, undefined, f.settings.current.registryRevision);
    apply([{ kind: "add", project: { name: "A", cwd: f.root } }]);
    const a = f.settings.current.projects[0]!;
    const activity = f.store.createActivity({ scopeId: fixtureScope, projectId: a.id, projectName: a.name, projectCwd: a.cwd });
    const agent = f.store.createAgent({ scopeId: fixtureScope, agentName: "A Agent" });
    const jobId = randomUUID();
    const persisted = { jobId, agentId: agent.agentId, activityId: activity.activityId, projectId: a.id,
      projectName: a.name, scopeId: fixtureScope, requestId: "late-a", requestHash: "a".repeat(64),
      requestHashVersion: 11, operation: "start", backendKind: "mcp-server", status: "completed",
      createdAt: Date.now(), updatedAt: Date.now(), lastProgressAt: Date.now(), version: 1,
      cwd: f.root, sandbox: "read-only", exclusiveKeys: [], publicEvents: [], pendingInteractions: [],
      sessionDecision: { requestedMode: "new", action: "start", reason: "explicit-new", threadId: "late-a-thread" } };
    f.store.upsertJob(persisted);
    let retire = false;
    let retirementError: unknown;
    const service = await ChildProcessStateReadService.start(f.file, f.environment, { onMeasurement: () => {
      if (!retire) return;
      retire = false;
      try {
        apply([{ kind: "archive", projectId: a.id }]);
        const archived = f.settings.current.projects[0]!;
        expect(f.store.projectLifecycle.complete(a.id, archived.archiveRevision!, Date.now(), f.store.projectLifecycle.threadIds(a.id))).toBe(true);
        apply([{ kind: "delete", projectId: a.id }]);
        apply([{ kind: "add", project: { name: "B", cwd: f.root } }]);
        const b = f.settings.current.projects[0]!;
        const bActivity = f.store.createActivity({ scopeId: fixtureScope, projectId: b.id, projectName: b.name, projectCwd: b.cwd });
        const bAgent = f.store.createAgent({ scopeId: fixtureScope, agentName: "B Agent" });
        f.store.upsertJob({ ...persisted, jobId: randomUUID(), requestId: "fresh-b", activityId: bActivity.activityId,
        agentId: bAgent.agentId, projectId: b.id, projectName: b.name,
        sessionDecision: { ...persisted.sessionDecision, threadId: "fresh-b-thread" } });
      } catch (error) { retirementError = error; }
    } });
    try {
      const confirmedA = await service.dashboardSnapshot();
      expect(confirmedA.counts.retainedJobs).toBe(1);
      expect(confirmedA.terminalRows[0]?.projectName).toBe("A");
      retire = true;
      await expect(service.dashboardSnapshot()).rejects.toThrow("STATE_READ_TARGET_CHANGED");
      expect(retirementError).toBeUndefined();
      const b = f.settings.current.projects[0]!;
      expect(b.id).not.toBe(a.id);
      const next = await service.dashboardSnapshot();
      expect(next.terminalRows[0]?.projectName).toBe("B");
      expect(next.terminalRows[0]?.rowKey).not.toBe(confirmedA.terminalRows[0]?.rowKey);
      expect(next.counts.retainedJobs).toBe(1);
      await expect(service.dashboardHistoryDetail({ rowKey: "0".repeat(32) })).rejects.toThrow("DASHBOARD_HISTORY_TARGET_CHANGED");
      expect(() => f.store.projectLifecycle.assertRequest("task", fixtureScope, "late-a")).toThrow("PROJECT_MANAGEMENT_ENDED");
    } finally { await service.close(); await f.close(); }
  }, 15_000);
});
