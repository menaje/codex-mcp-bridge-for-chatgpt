import { mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const ACTIVITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("scope-level bridge Agents", () => {
  it("restores every archived v17 Agent atomically without changing its links, history, or activity time", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-agent-v18-"));
    const file = path.join(directory, "state.sqlite");
    let store = new BridgeStateStore({ file });
    const project = store.applyProjectOperations(
      [{ kind: "add", project: { name: "Migration project", cwd: realpathSync(directory) } }],
      0,
      []
    ).projects[0]!;
    const activity = store.createActivity({
      scopeId: SCOPE_A,
      projectId: project.id,
      projectLabel: project.name,
      projectCwd: project.cwd,
      title: "Migration fixture",
      now: 100
    });
    const idle = store.createAgent({ scopeId: SCOPE_A, agentName: "Archived Idle", now: 110 });
    store.assignAgent({ activityId: activity.activityId, agentId: idle.agentId, contextMode: "fresh", now: 120 });
    store.linkAgentThread({
      agentId: idle.agentId,
      threadId: "archived-idle-thread",
      projectId: project.id,
      projectLabel: project.name,
      backendKind: "app-server",
      cwd: project.cwd,
      sandbox: "read-only",
      contextMode: "fresh",
      now: 130
    });
    const orphaned = store.createAgent({ scopeId: SCOPE_A, agentName: "Archived Orphan", now: 140 });
    store.setAgentExecutionState(orphaned.agentId, "orphaned", {
      orphanedReason: "Stored thread is unavailable.",
      now: 150
    });
    const historicalActivity = store.createActivity({
      scopeId: SCOPE_A,
      projectId: project.id,
      projectLabel: project.name,
      projectCwd: project.cwd,
      title: "Retained failure",
      now: 151
    });
    const historicalJob = {
      jobId: "migration-retained-job",
      requestId: "migration-retained-request",
      activityId: historicalActivity.activityId,
      scopeId: SCOPE_A,
      agentId: orphaned.agentId,
      projectId: project.id,
      projectLabel: project.name,
      cwd: project.cwd,
      status: "failed",
      createdAt: 152,
      updatedAt: 153,
      resultAvailability: "delivered",
      result: { content: [{ type: "text", text: "retained migration result" }] },
      error: "retained migration failure",
      execution: { model: "gpt-5.6-sol", reasoningEffort: "high", serviceTier: "fast" }
    };
    store.upsertJob(historicalJob);
    store.workHistory.acknowledge(historicalJob.jobId, 154);
    const active = store.createAgent({ scopeId: SCOPE_A, agentName: "Archived Active", now: 160 });
    store.upsertJob({
      jobId: "migration-active-job",
      requestId: "migration-active-request",
      scopeId: SCOPE_A,
      agentId: active.agentId,
      status: "running",
      createdAt: 170,
      updatedAt: 171,
      pendingInteractions: []
    });
    store.setAgentExecutionState(active.agentId, "active", {
      currentJobId: "migration-active-job",
      now: 172
    });
    const waiting = store.createAgent({ scopeId: SCOPE_A, agentName: "Archived Waiting", now: 180 });
    store.upsertJob({
      jobId: "migration-waiting-job",
      requestId: "migration-waiting-request",
      scopeId: SCOPE_A,
      agentId: waiting.agentId,
      status: "running",
      createdAt: 190,
      updatedAt: 191,
      pendingInteractions: [{ interactionId: "approval", isBlocking: true }]
    });
    store.setAgentExecutionState(waiting.agentId, "waiting-input", {
      currentJobId: "migration-waiting-job",
      now: 192
    });
    store.close();

    const database = new Database(file);
    const ids = [idle.agentId, orphaned.agentId, active.agentId, waiting.agentId];
    const placeholders = ids.map(() => "?").join(",");
    database.prepare(`UPDATE agents SET lifecycle='archived', archived_at=999 WHERE agent_id IN (${placeholders})`)
      .run(...ids);
    // A legacy/interrupted state can retain a stale pointer even though there
    // is no current Job. Schema 18 derives that pointer together with lifecycle.
    database.prepare("UPDATE agents SET current_job_id='missing-current-job' WHERE agent_id=?")
      .run(idle.agentId);
    database.prepare("UPDATE bridge_meta SET value='17' WHERE key='schema_version'").run();
    const before = database.prepare(`
      SELECT agent_id, version, created_at, updated_at, current_thread_id, current_job_id, orphaned_reason
        FROM agents WHERE agent_id IN (${placeholders}) ORDER BY agent_id
    `).all(...ids) as Array<Record<string, unknown>>;
    const historicalJobBefore = database.prepare(`
      SELECT job_id, scope_id, activity_id, agent_id, project_uuid, project_name_snapshot,
             project_cwd_snapshot, status, updated_at, payload
        FROM jobs WHERE job_id=?
    `).get(historicalJob.jobId) as Record<string, unknown>;
    const reviewBefore = database.prepare(
      "SELECT job_id, acknowledged_at, expired_at FROM work_history_state WHERE job_id=?"
    ).get(historicalJob.jobId) as Record<string, unknown>;
    const scopeVersionBefore = (database.prepare("SELECT version FROM scope_versions WHERE scope_id=?")
      .get(SCOPE_A) as { version: number }).version;
    database.close();

    store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(18);
    expect(store.getMeta("schema_v18_restored_agent_count")).toBe("4");
    expect(store.getMeta("schema_v18_migrated_at")).toEqual(expect.any(String));
    expect(store.getAgent(idle.agentId)).toMatchObject({ lifecycle: "idle", currentThreadId: "archived-idle-thread" });
    expect(store.getAgent(idle.agentId)?.currentJobId).toBeUndefined();
    expect(store.getAgent(orphaned.agentId)).toMatchObject({
      lifecycle: "orphaned",
      orphanedReason: "Stored thread is unavailable."
    });
    expect(store.getAgent(active.agentId)).toMatchObject({
      lifecycle: "active",
      currentJobId: "migration-active-job"
    });
    expect(store.getAgent(waiting.agentId)).toMatchObject({
      lifecycle: "waiting-input",
      currentJobId: "migration-waiting-job"
    });
    expect(store.listAgents(SCOPE_A)).toHaveLength(4);
    expect(store.listAgentThreads(idle.agentId)).toEqual([
      expect.objectContaining({
        threadId: "archived-idle-thread",
        projectId: project.id,
        projectLabel: project.name,
        cwd: project.cwd,
        sandbox: "read-only",
        contextMode: "fresh",
        isCurrent: true
      })
    ]);
    expect(store.listActivityAgentAssignments(activity.activityId, idle.agentId)).toEqual([
      expect.objectContaining({ activityId: activity.activityId, releasedAt: undefined })
    ]);
    expect(store.listJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: "migration-active-job", status: "running" }),
      expect.objectContaining({ jobId: "migration-waiting-job", status: "running" }),
      expect.objectContaining({
        jobId: historicalJob.jobId,
        status: "failed",
        resultAvailability: "delivered",
        result: historicalJob.result,
        error: historicalJob.error,
        execution: historicalJob.execution
      })
    ]));
    expect(store.workHistory.acknowledgedJobIds(SCOPE_A)).toContain(historicalJob.jobId);
    store.close();

    const migrated = new Database(file);
    const after = migrated.prepare(`
      SELECT agent_id, version, created_at, updated_at, current_thread_id, current_job_id, orphaned_reason, archived_at
        FROM agents WHERE agent_id IN (${placeholders}) ORDER BY agent_id
    `).all(...ids) as Array<Record<string, unknown>>;
    expect(after.map(({ archived_at: _archivedAt, ...row }) => row)).toEqual(
      before.map((row) => ({
        ...row,
        version: Number(row.version) + 1,
        ...(row.agent_id === idle.agentId ? { current_job_id: null } : {})
      }))
    );
    expect(after.every((row) => row.archived_at === null)).toBe(true);
    expect((migrated.prepare("SELECT version FROM scope_versions WHERE scope_id=?")
      .get(SCOPE_A) as { version: number }).version).toBe(scopeVersionBefore + 1);
    expect(migrated.prepare(`
      SELECT job_id, scope_id, activity_id, agent_id, project_uuid, project_name_snapshot,
             project_cwd_snapshot, status, updated_at, payload
        FROM jobs WHERE job_id=?
    `).get(historicalJob.jobId)).toEqual(historicalJobBefore);
    expect(migrated.prepare(
      "SELECT job_id, acknowledged_at, expired_at FROM work_history_state WHERE job_id=?"
    ).get(historicalJob.jobId)).toEqual(reviewBefore);
    migrated.close();
    const backups = readdirSync(directory).filter((name) => name.includes("pre-v18"));
    expect(backups).toHaveLength(1);
    expect(statSync(path.join(directory, backups[0]!)).mode & 0o777).toBe(0o600);

    store = new BridgeStateStore({ file });
    expect(store.getMeta("schema_v18_restored_agent_count")).toBe("4");
    const versions = store.listAgents(SCOPE_A).map((agent) => agent.version).sort((a, b) => a - b);
    store.close();
    store = new BridgeStateStore({ file });
    expect(store.listAgents(SCOPE_A).map((agent) => agent.version).sort((a, b) => a - b)).toEqual(versions);
    store.close();
  });

  it("guards recovery detach inside the assignment transaction", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    store.createActivity({ activityId: ACTIVITY_A, scopeId: SCOPE_A, title: "Recovery goal" });
    const agent = store.createAgent({ scopeId: SCOPE_A, agentName: "Recovery Agent" });
    const assignment = store.assignAgent({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      contextMode: "fresh"
    });
    const active = store.setAgentExecutionState(agent.agentId, "active", { currentJobId: "job-active" });

    expect(() => store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: active.version
    })).toThrow(/AGENT_BUSY/);
    expect(store.listActivityAgentAssignments(ACTIVITY_A, agent.agentId)[0]?.releasedAt).toBeUndefined();

    const idle = store.setAgentExecutionState(agent.agentId, "idle");
    expect(() => store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: idle.version - 1
    })).toThrow(/AGENT_VERSION_CHANGED/);

    const detached = store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: idle.version
    });
    expect(detached).toMatchObject({
      alreadyReleased: false,
      assignment: { assignmentId: assignment.assignmentId, releasedAt: expect.any(Number) },
      agent: { version: idle.version + 1 }
    });
    const replayedState = store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: detached.agent.version
    });
    expect(replayedState).toMatchObject({
      alreadyReleased: true,
      assignment: { assignmentId: assignment.assignmentId }
    });
    store.close();
  });

  it("persists normalized names, assignments, current/history threads, and mutations", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "bridge-agent-state-")), "state.sqlite");
    const store = new BridgeStateStore({ file });
    const projectCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-agent-project-")));
    const project = store.applyProjectOperations(
      [{ kind: "add", project: { name: "Codex MCP Bridge", cwd: projectCwd } }],
      0,
      []
    ).projects[0]!;
    store.createActivity({
      activityId: ACTIVITY_A,
      scopeId: SCOPE_A,
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      projectCwd,
      title: "Original goal",
      now: 10
    });
    const agent = store.createAgent({ scopeId: SCOPE_A, agentName: "Ａlice", now: 20 });
    expect(agent).toMatchObject({ agentName: "Alice", normalizedName: "alice", lifecycle: "idle" });
    expect(() => store.createAgent({ scopeId: SCOPE_A, agentName: "ALICE", now: 21 }))
      .toThrow(/AGENT_NAME_CONFLICT/);
    expect(store.createAgent({ scopeId: SCOPE_B, agentName: "alice", now: 22 }).scopeId).toBe(SCOPE_B);

    const firstAssignment = store.assignAgent({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      contextMode: "fresh",
      role: "implementation",
      now: 30
    });
    store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      sessionId: "session-tree-1",
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "fresh",
      now: 40
    });
    expect(() => store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectLabel: "Other project",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "continue",
      now: 41
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(() => store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: "/workspace/switched",
      sandbox: "read-only",
      contextMode: "continue",
      now: 42
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(store.releaseAgentAssignment(ACTIVITY_A, agent.agentId, 45)).toMatchObject({
      assignmentId: firstAssignment.assignmentId,
      releasedAt: 45
    });

    store.createActivity({
      activityId: ACTIVITY_B,
      scopeId: SCOPE_A,
      continuationOfActivityId: ACTIVITY_A,
      title: "Linked goal",
      now: 50
    });
    store.assignAgent({
      activityId: ACTIVITY_B,
      agentId: agent.agentId,
      contextMode: "fork",
      role: "verification",
      now: 55
    });
    store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-fork",
      sessionId: "session-tree-1",
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "fork",
      forkedFromThreadId: "thread-original",
      now: 60
    });
    const renamed = store.renameAgent(agent.agentId, "  Builder  ", 70);
    expect(renamed).toMatchObject({ agentId: agent.agentId, agentName: "Builder", currentThreadId: "thread-fork" });
    expect(store.listAgents(SCOPE_A)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: agent.agentId, lifecycle: "idle" })
    ]));
    store.recordAgentMutation(SCOPE_A, "mutation-1", "hash-1", { ok: true, action: "rename" }, 100);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(18);
    expect(restored.getActivity(ACTIVITY_A)).toMatchObject({
      lifecycle: "open",
      projectId: project.id,
      projectLabel: "Codex MCP Bridge"
    });
    expect(restored.getActivity(ACTIVITY_B)).toMatchObject({
      continuationOfActivityId: ACTIVITY_A,
      cardGeneration: 1,
      projectId: project.id,
      projectLabel: "Codex MCP Bridge"
    });
    expect(restored.getActivityProjectAdmission(ACTIVITY_B)).toEqual({
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      projectCwd
    });
    expect(restored.getAgent(agent.agentId)).toMatchObject({
      scopeId: SCOPE_A,
      agentName: "Builder",
      lifecycle: "idle",
      currentThreadId: "thread-fork"
    });
    expect(restored.listAgentThreads(agent.agentId)).toEqual([
      expect.objectContaining({
        threadId: "thread-original",
        sessionId: "session-tree-1",
        projectId: project.id,
        projectLabel: "Codex MCP Bridge",
        contextMode: "fresh",
        isCurrent: false,
        replacedAt: 60
      }),
      expect.objectContaining({
        threadId: "thread-fork",
        sessionId: "session-tree-1",
        projectId: project.id,
        projectLabel: "Codex MCP Bridge",
        contextMode: "fork",
        isCurrent: true,
        forkedFromThreadId: "thread-original"
      })
    ]);
    expect(restored.listActivityAgentAssignments(undefined, agent.agentId)).toEqual([
      expect.objectContaining({
        activityId: ACTIVITY_A,
        role: "implementation",
        contextMode: "fresh",
        releasedAt: 45
      }),
      expect.objectContaining({
        activityId: ACTIVITY_B,
        role: "verification",
        contextMode: "fork",
        releasedAt: undefined
      })
    ]);
    expect(restored.getAgentMutation(SCOPE_A, "mutation-1")).toEqual({
      actionHash: "hash-1",
      result: { ok: true, action: "rename" }
    });
    restored.close();
  });
});
