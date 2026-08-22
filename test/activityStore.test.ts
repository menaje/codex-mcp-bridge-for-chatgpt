import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import type { ToolResult } from "../src/upstream.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const ACTIVITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Activity SQLite state", () => {
  it("migrates schema v1 jobs into one-job legacy Activities atomically", () => {
    const file = stateFile();
    createV1Database(file, {
      payload: JSON.stringify({
        jobId: "legacy-job",
        scopeId: SCOPE_A,
        requestId: "legacy-request",
        status: "completed",
        updatedAt: 20,
        createdAt: 10,
        sessionDecision: { threadId: "legacy-thread" }
      })
    });

    const store = new BridgeStateStore({ file });
    const [activity] = store.listActivities(SCOPE_A);
    const [job] = store.listJobs() as Array<Record<string, unknown>>;

    expect(store.schemaVersion).toBe(2);
    expect(activity).toMatchObject({
      scopeId: SCOPE_A,
      title: "Legacy Codex job legacy-j",
      kind: "other",
      handoffPolicy: "none",
      completionTrigger: "manual",
      lifecycle: "open",
      waitingOn: "orchestrator",
      legacy: true,
      counts: { total: 1, completed: 1, terminal: 1 }
    });
    expect(job).toMatchObject({
      activityId: activity.activityId,
      threadId: "legacy-thread",
      executionMode: "auto",
      backendKind: "mcp-server",
      terminalVersion: 1
    });
    expect(store.getScopeVersion(SCOPE_A)).toBe(1);
    expect(store.listActivityEvents(activity.activityId)).toEqual([
      expect.objectContaining({ eventType: "legacy-job-grouped", scopeVersion: 1 })
    ]);
    expect(store.listJobEvents("legacy-job")).toEqual([
      expect.objectContaining({ eventType: "legacy-imported", scopeVersion: 1 })
    ]);
    expect(store.listCompletionOutbox()).toHaveLength(0);
    store.close();
  });

  it("rolls back a failed v1 migration without changing its schema marker", () => {
    const file = stateFile();
    createV1Database(file, { payload: "not-json" });

    expect(() => new BridgeStateStore({ file })).toThrow(/Invalid job payload/);

    const database = new Database(file, { readonly: true });
    const marker = database
      .prepare("SELECT value FROM bridge_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    const activityTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities'")
      .get();
    expect(marker.value).toBe("1");
    expect(activityTable).toBeUndefined();
    database.close();
  });

  it("keeps a default Activity open when its Codex turn reaches terminal state", () => {
    const store = new BridgeStateStore({ file: stateFile() });
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "running", 10));
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "completed", 20));

    expect(store.getActivity(ACTIVITY_A)).toMatchObject({
      lifecycle: "open",
      waitingOn: "orchestrator",
      verification: "not-required",
      handoffPolicy: "none",
      completionTrigger: "manual",
      counts: { total: 1, running: 0, completed: 1, terminal: 1 }
    });
    expect(store.getScopeVersion(SCOPE_A)).toBe(2);
    expect(store.listCompletionOutbox(ACTIVITY_A)).toHaveLength(0);
    expect(store.listJobEvents("job-a").map((event) => event.eventType)).toEqual([
      "job-started",
      "job-completed"
    ]);
    store.close();
  });

  it("completes a sealed notify Activity once after every child job succeeds", () => {
    const store = new BridgeStateStore({ file: stateFile() });
    store.createActivity({
      activityId: ACTIVITY_A,
      scopeId: SCOPE_A,
      title: "Parallel implementation",
      kind: "implementation",
      executionMode: "background",
      handoffPolicy: "notify",
      completionTrigger: "sealed-jobs-terminal",
      now: 1
    });
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "running", 2));
    store.upsertJob(job("job-b", "request-b", ACTIVITY_A, "running", 3));
    store.sealActivity(ACTIVITY_A, 4);
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "completed", 5));
    expect(store.getActivity(ACTIVITY_A)).toMatchObject({ lifecycle: "sealed", waitingOn: "codex" });
    expect(store.listCompletionOutbox(ACTIVITY_A)).toHaveLength(0);

    store.upsertJob(job("job-b", "request-b", ACTIVITY_A, "completed", 6));
    const terminal = store.getActivity(ACTIVITY_A);
    expect(terminal).toMatchObject({
      lifecycle: "completed",
      waitingOn: "none",
      verification: "not-required",
      completionVersion: 1,
      counts: { total: 2, completed: 2, terminal: 2 }
    });
    expect(store.listCompletionOutbox(ACTIVITY_A)).toEqual([
      expect.objectContaining({
        activityId: ACTIVITY_A,
        completionVersion: 1,
        channel: "notify",
        attemptCount: 0
      })
    ]);

    store.upsertJob(job("job-b", "request-b", ACTIVITY_A, "completed", 7));
    expect(store.getActivity(ACTIVITY_A)?.version).toBe(terminal?.version);
    expect(store.listCompletionOutbox(ACTIVITY_A)).toHaveLength(1);
    store.close();
  });

  it("moves verify work to pending but never reports a failed barrier as success", () => {
    const store = new BridgeStateStore({ file: stateFile() });
    store.createActivity({
      activityId: ACTIVITY_A,
      scopeId: SCOPE_A,
      handoffPolicy: "verify",
      completionTrigger: "sealed-jobs-terminal"
    });
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "running", 2));
    store.sealActivity(ACTIVITY_A, 3);
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "completed", 4));
    expect(store.getActivity(ACTIVITY_A)).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "verification",
      verification: "pending",
      completionVersion: 1
    });
    expect(store.listCompletionOutbox(ACTIVITY_A)).toEqual([
      expect.objectContaining({ channel: "verify", completionVersion: 1 })
    ]);

    store.createActivity({
      activityId: ACTIVITY_B,
      scopeId: SCOPE_A,
      handoffPolicy: "notify",
      completionTrigger: "sealed-jobs-terminal"
    });
    store.upsertJob(job("job-b", "request-b", ACTIVITY_B, "running", 5));
    store.upsertJob(job("job-c", "request-c", ACTIVITY_B, "running", 5));
    store.sealActivity(ACTIVITY_B, 6);
    store.upsertJob(job("job-b", "request-b", ACTIVITY_B, "failed", 7));
    expect(store.getActivity(ACTIVITY_B)).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "codex",
      verification: "not-required",
      completionVersion: 0,
      counts: { running: 1, failed: 1, terminal: 1 }
    });
    expect(store.listCompletionOutbox(ACTIVITY_B)).toHaveLength(0);
    expect(store.listActivityEvents(ACTIVITY_B)).toContainEqual(
      expect.objectContaining({ eventType: "attention-required" })
    );
    store.close();
  });

  it("rolls back job terminal state, Activity transition, scope version, and outbox together", () => {
    const store = new BridgeStateStore({ file: stateFile() });
    store.createActivity({
      activityId: ACTIVITY_A,
      scopeId: SCOPE_A,
      handoffPolicy: "notify",
      completionTrigger: "sealed-jobs-terminal"
    });
    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "running", 2));
    store.sealActivity(ACTIVITY_A, 3);
    const versionBefore = store.getScopeVersion(SCOPE_A);

    expect(() =>
      store.transaction(() => {
        store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "completed", 4));
        throw new Error("force terminal rollback");
      })
    ).toThrow(/force terminal rollback/);

    expect(store.listJobs()).toEqual([
      expect.objectContaining({ jobId: "job-a", status: "running", terminalVersion: undefined })
    ]);
    expect(store.getActivity(ACTIVITY_A)).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "codex",
      completionVersion: 0,
      counts: { running: 1, terminal: 0 }
    });
    expect(store.getScopeVersion(SCOPE_A)).toBe(versionBefore);
    expect(store.listCompletionOutbox(ACTIVITY_A)).toHaveLength(0);
    store.close();
  });

  it("rolls back cross-scope attachment and retains terminal facts after result pruning", () => {
    const store = new BridgeStateStore({ file: stateFile() });
    store.createActivity({ activityId: ACTIVITY_A, scopeId: SCOPE_A });
    const scopeBVersion = store.getScopeVersion(SCOPE_B);
    expect(() =>
      store.upsertJob({
        ...job("wrong-scope", "wrong-request", ACTIVITY_A, "running", 2),
        scopeId: SCOPE_B
      })
    ).toThrow(/another conversation scope/);
    expect(store.countJobs(SCOPE_B)).toBe(0);
    expect(store.getScopeVersion(SCOPE_B)).toBe(scopeBVersion);

    store.upsertJob(job("job-a", "request-a", ACTIVITY_A, "completed", 3));
    store.deleteJob("job-a");
    expect(store.listJobs()).toHaveLength(0);
    expect(store.getActivity(ACTIVITY_A)).toMatchObject({
      counts: { total: 1, completed: 1, terminal: 1 }
    });
    expect(store.listJobEvents("job-a")).toContainEqual(
      expect.objectContaining({ eventType: "retention-pruned" })
    );
    expect(() =>
      store.upsertJob(job("job-replay", "request-a", ACTIVITY_A, "running", 4))
    ).toThrow(/archived Codex job/);
    expect(store.getActivity(ACTIVITY_A)).toMatchObject({ counts: { total: 1 } });
    store.close();
  });

  it("records bridge generations and reconciles a formerly running job as interrupted", async () => {
    const file = stateFile();
    const root = path.dirname(path.dirname(file));
    const first = new BridgeStateStore({ file });
    const firstRegistry = registry(first, root);
    const running = firstRegistry.start(
      {
        operation: "start",
        cwd: root,
        sandbox: "read-only",
        scopeId: SCOPE_A,
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        requestHash: "c".repeat(64),
        requestHashVersion: 2,
        selectionKey: "restart-test",
        exclusiveKeys: [],
        sessionDecision: {
          requestedMode: "new",
          action: "start",
          reason: "explicit-new"
        }
      },
      async () => new Promise<ToolResult>(() => undefined)
    );
    await Promise.resolve();
    const firstInstance = first.bridgeInstanceId;
    expect(first.getActivity(running.activityId)).toMatchObject({
      waitingOn: "codex",
      counts: { running: 1 }
    });
    first.close();

    const second = new BridgeStateStore({ file });
    const secondRegistry = registry(second, root);
    const instances = second.listBridgeInstances();
    expect(instances).toEqual([
      expect.objectContaining({ instanceId: firstInstance, terminationReason: "clean-shutdown" }),
      expect.objectContaining({ instanceId: second.bridgeInstanceId, stoppedAt: undefined })
    ]);
    expect(secondRegistry.get(running.jobId)).toMatchObject({
      status: "interrupted",
      bridgeInstanceId: firstInstance
    });
    expect(second.getActivity(running.activityId)).toMatchObject({
      lifecycle: "open",
      waitingOn: "orchestrator",
      counts: { running: 0, interrupted: 1, terminal: 1 }
    });
    expect(second.listJobEvents(running.jobId)).toContainEqual(
      expect.objectContaining({ eventType: "job-interrupted", status: "interrupted" })
    );
    second.close();
  });
});

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "bridge-activity-state-")), "private", "state.sqlite");
}

function job(
  jobId: string,
  requestId: string,
  activityId: string,
  status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
  updatedAt: number
) {
  return {
    jobId,
    scopeId: SCOPE_A,
    requestId,
    activityId,
    status,
    updatedAt,
    executionMode: "auto" as const,
    backendKind: "mcp-server"
  };
}

function createV1Database(file: string, input: { payload: string }): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.exec(`
    CREATE TABLE bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO bridge_meta(key, value) VALUES ('schema_version', '1');
    CREATE TABLE sessions (
      thread_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      last_used_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(scope_id, request_id)
    ) STRICT;
    CREATE TABLE user_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      payload TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(`
      INSERT INTO jobs(job_id, scope_id, request_id, status, updated_at, payload)
      VALUES ('legacy-job', ?, 'legacy-request', 'completed', 20, ?)
    `)
    .run(SCOPE_A, input.payload);
  database.close();
}

function registry(stateStore: BridgeStateStore, root: string): CodexJobRegistry {
  return new CodexJobRegistry({
    stateStore,
    allowedRoots: [root],
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000
  });
}
