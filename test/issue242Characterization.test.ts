import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { issue242Fixture } from "../scripts/issue-242-fixture.js";
import { ChildProcessStateReadService, type StateReadObservation } from "../src/stateReadProcess.js";
import { createModelCatalog } from "../src/server.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { registerBridgeTools } from "../src/tools.js";
import type { CodexProgress, CodexUpstream } from "../src/upstream.js";

describe("issue 242 latest-dev characterization", () => {
  it("measures fresh query-only projections without changing results or writer ownership", async () => {
    const f = await issue242Fixture(100);
    const rows: StateReadObservation[] = [];
    const service = await ChildProcessStateReadService.start(f.file, f.environment, {
      onMeasurement: row => { rows.push(row); throw new Error("observer failure"); }
    });
    try {
      const before = f.database.prepare("SELECT count(*) AS n FROM bridge_instances").get();
      const views = await Promise.all(Array.from({ length: 4 }, () => service.dashboardSnapshot({ limit: 2, includeHistory: false })));
      expect(views.map(view => view.counts.retainedJobs)).toEqual([100, 100, 100, 100]);
      expect(views.map(view => view.terminalRows.map(row => row.rowKey))).toEqual(Array(4).fill(views[0].terminalRows.map(row => row.rowKey)));
      expect(rows).toHaveLength(1);
      for (const row of rows) {
        expect(row.sqlStatements).toBeGreaterThan(0);
        expect(row.selectStatements).toBeGreaterThan(0);
        expect(row.responseBytes).toBeGreaterThan(0);
        expect(row.endToEndMs).toBeGreaterThanOrEqual(row.queueMs + row.jobsMs + row.projectionMs);
        expect(row.callerAbandoned).toBe(false);
        for (const [key, value] of Object.entries(row)) {
          if (!["requestId", "method", "callerAbandoned"].includes(key)) expect(Number.isFinite(value)).toBe(true);
        }
      }
      expect(JSON.stringify(rows)).not.toContain(f.root);
      expect(JSON.stringify(rows)).not.toContain("synthetic");
      expect(views[0]).not.toHaveProperty("measurement");
      expect(service.health().inFlight).toBe(0);
      expect(f.database.prepare("SELECT count(*) AS n FROM bridge_instances").get()).toEqual(before);
    } finally { await service.close(); await f.close(); }
  }, 20_000);

  it("separates general progress notices and empty claims from actual changed rows", async () => {
    const f = await issue242Fixture(40);
    const upstream: CodexUpstream = { async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("No execution in characterization."); }, async close() {} };
    const mcp = new McpServer({ name: "issue-242-fixture", version: "1" });
    const registration = registerBridgeTools(mcp, f.config, upstream, f.sessions, f.jobs,
      createModelCatalog(f.config, upstream), f.settings, new ScopeResolver({ stateStore: f.store }));
    const topics: string[] = [];
    const unsubscribe = registration.applicationService.subscribeChanges!(topic => topics.push(topic));
    try {
      const progress = f.jobs as unknown as { recordProgress(job: unknown, value: CodexProgress): void };
      const jobs = f.jobs.list(40, 0).slice(0, 4);
      // Invoke the production progress handler with fixture memory; no worker or Job is launched.
      for (const job of jobs) job.status = "running";
      const observed = await f.measure(() => {
        for (let i = 0; i < 40; i++) progress.recordProgress(jobs[i % 4], { progress: i });
      });
      expect(topics).toEqual(Array(40).fill("dashboard"));
      expect(observed.changedRows).toBe(0);
      expect(f.store.listPendingNotifyCompletionOutbox()).toEqual([]);
      const empty = await f.measure(() => Array.from({ length: 20 }, () => f.jobs.claimNativeCompletionNotifications(10, "fixture-consumer")));
      expect(empty.result.every(rows => rows.length === 0)).toBe(true);
      expect(empty.sql.BEGIN).toBe(20);
      expect(empty.sql.COMMIT).toBe(20);
      expect(empty.sql.UPDATE ?? 0).toBe(0);
      expect(empty.changedRows).toBe(0);
    } finally { unsubscribe(); registration.dispose(); await mcp.close(); await f.close(); }
  });
});
