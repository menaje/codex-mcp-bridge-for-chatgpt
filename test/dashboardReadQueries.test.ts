import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { automaticRecoveryKey } from "../src/automaticRecovery.js";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type { CodexUpstream } from "../src/upstream.js";

const scopeId = "11111111-1111-4111-8111-111111111111";

describe("Dashboard query cost", () => {
  it.each([20, 120])("batches titles and handoffs with %s retained Agents and recovery records", async count => {
    const root = await mkdtemp(path.join(tmpdir(), "dashboard-query-cost-"));
    const file = path.join(root, "state.sqlite");
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file, CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills") });
    const writer = new BridgeStateStore({ file });
    const now = Date.now();
    let orphanId = "";
    let releasedThread = "";
    try {
      new UserSettingsStore(config, { stateStore: writer });
      new ScopeResolver({ stateStore: writer });
      writer.transaction(() => {
        for (let index = 0; index < count; index++) {
          const activity = writer.createActivity({ scopeId, title: `Work ${index}`, now });
          const agent = writer.createAgent({ scopeId, agentName: `Agent ${index}`,
            lifecycle: index === 0 ? "orphaned" : "idle", now });
          const threadId = randomUUID();
          writer.linkAgentThread({ agentId: agent.agentId, threadId, backendKind: "app-server",
            cwd: root, sandbox: "read-only", contextMode: "fresh", now });
          writer.upsertSession({ threadId, scopeId, backendKind: "app-server", cwd: root,
            sandbox: "read-only", visibleInCodexApp: true, lastUsedAt: now });
          writer.threadConnections.register({ threadId, scopeId, agentId: agent.agentId, persistence: "persistent" }, now);
          const jobId = randomUUID();
          writer.upsertJob({ jobId, requestId: randomUUID(), scopeId, agentId: agent.agentId,
            activityId: activity.activityId, status: "failed", createdAt: now, updatedAt: now });
          writer.deleteJob(jobId);
          if (index === 0) {
            orphanId = agent.agentId;
            writer.setAgentExecutionState(orphanId, "orphaned", { orphanedReason: "fixture", now });
            const current = writer.getAgent(orphanId)!;
            const candidate = { key: automaticRecoveryKey("recheck", [orphanId, current.version, undefined]),
              scopeId, agentId: orphanId, kind: "recheck" as const };
            writer.automaticRecovery.observeRecheck(candidate, true, now);
            const attempt = writer.automaticRecovery.begin(candidate, now)!;
            writer.automaticRecovery.finish(candidate.key, attempt.attempts,
              { resolved: false, reason: "fixture-blocked", retryable: false }, now);
          } else {
            writer.automaticRecovery.begin({ key: automaticRecoveryKey("release", threadId),
              scopeId, agentId: agent.agentId, jobId, kind: "release" }, now + index);
          }
          if (index === 1) {
            releasedThread = threadId;
            writer.threadConnections.update(threadId, { phase: "released", evidence: "thread-unloaded" }, now);
          }
        }
      });
    } finally { writer.close(); }

    const statements: string[] = [];
    const reader = new BridgeStateStore({ file, readOnly: true, traceSql: sql => statements.push(sql) });
    const jobs = new CodexJobRegistry({ stateStore: reader, projectionOnly: true });
    const upstream = { listTools: async () => ({ tools: [] }), callTool: async () => { throw new Error("No runtime probes"); },
      close: async () => {} } as CodexUpstream;
    const server = createBridgeMcpServer(config, upstream,
      new SessionRegistry({ stateStore: reader, projectionOnly: true }), jobs, undefined,
      new UserSettingsStore(config, { stateStore: reader, projectionOnly: true }), new ScopeResolver({ stateStore: reader }));
    try {
      statements.length = 0;
      const view = await server.applicationService.dashboardSnapshot({ scopeId, statusFilter: "all", includeHistory: false,
        inspectRuntime: false, problems: { review: "pending", kind: "all", offset: 0, view: "actionable" } });
      expect(view.counts.failed).toBe(count);
      expect(view.statusRows).toHaveLength(count);
      expect(view.statusRows!.every(row => row.activityTitle?.startsWith("Work "))).toBe(true);
      expect(view.statusRows!.find(row => row.codexThreadUrl === `codex://threads/${releasedThread}`)?.handoff)
        .toMatchObject({ phase: "released", canOpen: true });
      expect(view.problems?.rows.find(row => row.kind === "orphaned")?.automatic)
        .toMatchObject({ kind: "recheck", state: "blocked", attempts: 1 });
      expect(statements.filter(sql => /FROM automatic_recovery_incidents WHERE identity_key=/u.test(sql))).toHaveLength(1);
      expect(statements.filter(sql => /SELECT activity_id,title FROM activities/u.test(sql))).toHaveLength(1);
      expect(statements.filter(sql => /SELECT \* FROM thread_connections\s+WHERE thread_id IN/u.test(sql))).toHaveLength(1);
      expect(statements.length).toBeLessThan(50);
      expect(statements.filter(sql => /^\s*(INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT)/u.test(sql))).toEqual([]);
    } finally {
      await server.close();
      reader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds batch parameters and preserves missing and duplicate identities", () => {
    const statements: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: sql => statements.push(sql) });
    try {
      const activity = store.createActivity({ scopeId, title: "Retained title" });
      store.threadConnections.register({ threadId: "retained-thread", scopeId, persistence: "persistent" });
      const missing = Array.from({ length: 520 }, () => randomUUID());
      statements.length = 0;
      expect(store.dashboardActivityTitles([activity.activityId, ...missing, activity.activityId]))
        .toEqual(new Map([[activity.activityId, "Retained title"]]));
      expect(store.threadConnections.listByThreadIds(["retained-thread", ...missing, "retained-thread"]))
        .toEqual([expect.objectContaining({ threadId: "retained-thread", phase: "connected" })]);
      expect(statements).toHaveLength(4);
      statements.length = 0;
      expect(store.dashboardActivityTitles([])).toEqual(new Map());
      expect(store.threadConnections.listByThreadIds([])).toEqual([]);
      expect(statements).toEqual([]);
    } finally { store.close(); }
  });

  it("keeps scoped retained-history totals and global ordering across Agent filter batches", () => {
    const statements: string[] = [];
    const store = new BridgeStateStore({ file: ":memory:", traceSql: sql => statements.push(sql) });
    try {
      const now = Date.now();
      const older = store.createAgent({ scopeId, agentName: "Older" });
      const newer = store.createAgent({ scopeId, agentName: "Newer" });
      for (const [agent, age] of [[older, 2], [newer, 1]] as const) {
        const jobId = randomUUID();
        store.upsertJob({ jobId, agentId: agent.agentId, activityId: randomUUID(), scopeId,
          requestId: randomUUID(), status: "completed", createdAt: now - age, updatedAt: now - age });
        store.deleteJob(jobId);
      }
      const missing = Array.from({ length: 520 }, () => randomUUID());
      statements.length = 0;
      const result = store.dashboardReadModel.archivedByAgent(scopeId, 13, "updated",
        [older.agentId, ...missing, newer.agentId, older.agentId]);
      expect(result.rows.map(row => row.agent_id)).toEqual([newer.agentId, older.agentId]);
      expect(result.totalsByAgent).toEqual(new Map([[older.agentId, 1], [newer.agentId, 1]]));
      expect(statements).toHaveLength(2);
      const otherScope = "22222222-2222-4222-8222-222222222222";
      expect(store.dashboardReadModel.archivedByAgent(otherScope, 13, "updated", [older.agentId]).rows).toEqual([]);
      statements.length = 0;
      expect(store.dashboardReadModel.archivedByAgent(scopeId, 13, "updated", []).rows).toEqual([]);
      expect(statements).toEqual([]);
    } finally { store.close(); }
  });
});
