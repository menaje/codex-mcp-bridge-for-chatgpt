import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { UserSettingsStore } from "../src/userSettings.js";

describe("BridgeStateStore", () => {
  it("commits session and job changes atomically and keeps the database private", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });

    expect(() =>
      store.transaction(() => {
        store.upsertSession(session("thread-rollback"));
        store.upsertJob(job("job-rollback", "request-rollback"));
        throw new Error("force rollback");
      })
    ).toThrow(/force rollback/);
    expect(store.countSessions()).toBe(0);
    expect(store.countJobs()).toBe(0);

    store.transaction(() => {
      store.upsertSession(session("thread-committed"));
      store.upsertJob(job("job-committed", "request-committed"));
    });
    expect(store.countSessions(SCOPE_A)).toBe(1);
    expect(store.countJobs(SCOPE_A, "completed")).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-shm`).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = new BridgeStateStore({ file });
    expect(reopened.listSessions()).toEqual([session("thread-committed")]);
    expect(reopened.listJobs()).toEqual([
      expect.objectContaining({
        ...job("job-committed", "request-committed"),
        activityId: expect.any(String),
        executionMode: "background",
        backendKind: "mcp-server",
        terminalVersion: 1
      })
    ]);
    reopened.close();
  });

  it("rejects an unknown future schema instead of overwriting its version", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    store.setMeta("schema_version", "999");
    store.close();

    expect(() => new BridgeStateStore({ file })).toThrow(/Unsupported bridge state database schema version: 999/);
  });

  it("persists steering intent and dispatch state without storing the raw prompt", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const requestId = "12121212-1212-4212-8212-121212121212";
    const actionHash = "a".repeat(64);
    const rawPrompt = "private steering prompt must never enter SQLite";
    const promptSha256 = createHash("sha256").update(rawPrompt).digest("hex");
    const prepared = store.beginSteeringDelivery({
      scopeId: SCOPE_A,
      requestId,
      actionHash,
      jobId: "steering-job",
      expectedJobVersion: 7,
      promptSha256,
      now: 10
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      promptSha256,
      result: undefined
    });
    expect(JSON.stringify(prepared)).not.toContain(rawPrompt);

    const dispatching = store.markSteeringDeliveryDispatching(
      SCOPE_A,
      requestId,
      actionHash,
      11
    );
    expect(dispatching).toMatchObject({ status: "dispatching", dispatchedAt: 11 });
    const result = {
      ok: true,
      action: "steer",
      delivery: { status: "delivered" },
      promptPersistedByBridge: false
    };
    store.completeSteeringDelivery(
      SCOPE_A,
      requestId,
      actionHash,
      "delivered",
      result,
      12
    );
    expect(store.getSteeringDelivery(SCOPE_A, requestId)).toMatchObject({
      status: "delivered",
      result,
      completedAt: 12
    });
    expect(() => store.beginSteeringDelivery({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "c".repeat(64),
      jobId: "different-job",
      expectedJobVersion: 1,
      promptSha256: "d".repeat(64)
    })).toThrow(/STEERING_REQUEST_CONFLICT/);
    store.close();
    expect(readFileSync(file).includes(Buffer.from(rawPrompt))).toBe(false);

    const reopened = new BridgeStateStore({ file });
    expect(reopened.schemaVersion).toBe(9);
    expect(reopened.listSteeringDeliveries(SCOPE_A)).toEqual([
      expect.objectContaining({
        requestId,
        actionHash,
        promptSha256,
        status: "delivered",
        result
      })
    ]);
    reopened.close();
  });

  it("persists first-class project admission without exposing the canonical path on Activities", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const cwd = temporaryRoot();
    const project = registerProject(store, "Codex MCP Bridge", cwd);
    const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.createActivity({
      activityId,
      scopeId: SCOPE_A,
      projectId: project.id,
      projectLabel: project.name,
      projectCwd: cwd,
      title: "Project-aware work",
      now: 1
    });
    store.upsertSession({
      ...session("thread-project"),
      cwd,
      projectId: project.id,
      projectLabel: project.name
    });
    store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: project.id,
      projectLabel: project.name
    });

    expect(store.getActivity(activityId)).toMatchObject({
      projectId: project.id,
      projectLabel: "Codex MCP Bridge"
    });
    expect(store.getActivity(activityId)).not.toHaveProperty("projectCwd");
    expect(store.getActivityProjectAdmission(activityId)).toEqual({
      projectId: project.id,
      projectLabel: "Codex MCP Bridge",
      projectCwd: cwd
    });
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ projectId: project.id, projectLabel: "Codex MCP Bridge" })
    ]);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectLabel: "Codex MCP Bridge" })
    ]);
    expect(() => store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: "22222222-2222-4222-8222-222222222222",
      projectLabel: "Other"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(9);
    expect(restored.getActivityProjectAdmission(activityId)?.projectId).toBe(project.id);
    expect(restored.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectLabel: "Codex MCP Bridge" })
    ]);
    restored.close();
  });

  it("inherits a continuation project by default but permits an explicit fresh-project admission", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const alphaCwd = temporaryRoot();
    const betaCwd = temporaryRoot();
    const alpha = registerProject(store, "Alpha", alphaCwd);
    const beta = registerProject(store, "Beta", betaCwd);
    const sourceId = "abababab-abab-4bab-8bab-abababababab";
    const inheritedId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    const switchedId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    store.createActivity({
      activityId: sourceId,
      scopeId: SCOPE_A,
      projectId: alpha.id,
      projectLabel: "Alpha",
      projectCwd: alphaCwd,
      now: 1
    });

    store.createActivity({
      activityId: inheritedId,
      scopeId: SCOPE_A,
      continuationOfActivityId: sourceId,
      now: 2
    });
    store.createActivity({
      activityId: switchedId,
      scopeId: SCOPE_A,
      continuationOfActivityId: sourceId,
      projectId: beta.id,
      projectLabel: "Beta",
      projectCwd: betaCwd,
      now: 3
    });

    expect(store.getActivityProjectAdmission(inheritedId)).toMatchObject({
      projectId: alpha.id,
      projectCwd: alphaCwd
    });
    expect(store.getActivityProjectAdmission(switchedId)).toMatchObject({
      projectId: beta.id,
      projectCwd: betaCwd
    });
    store.close();
  });

  it("backfills a legacy Activity only when every admitted job uses the selected project folder", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const cwd = temporaryRoot();
    const otherCwd = temporaryRoot();
    const project = registerProject(store, "Codex MCP Bridge", cwd);
    const compatibleActivity = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.createActivity({ activityId: compatibleActivity, scopeId: SCOPE_A, now: 1 });
    store.upsertJob({
      ...job("legacy-job", "legacy-request"),
      activityId: compatibleActivity,
      cwd
    });
    store.upsertJob({
      ...job("project-job", "project-request"),
      activityId: compatibleActivity,
      cwd,
      projectId: project.id,
      projectLabel: "Codex MCP Bridge"
    });
    expect(store.getActivityProjectAdmission(compatibleActivity)?.projectId).toBe(project.id);

    const ambiguousActivity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    store.createActivity({ activityId: ambiguousActivity, scopeId: SCOPE_A, now: 3 });
    store.upsertJob({
      ...job("other-legacy-job", "other-legacy-request"),
      activityId: ambiguousActivity,
      cwd: otherCwd
    });
    expect(() => store.upsertJob({
      ...job("other-project-job", "other-project-request"),
      activityId: ambiguousActivity,
      cwd,
      projectId: project.id,
      projectLabel: "Codex MCP Bridge"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(store.getActivityProjectAdmission(ambiguousActivity)).toBeUndefined();
    store.close();
  });

  it("persists first-class cancellation provenance before permitting a cancelled job", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const activityId = "dededede-dede-4ede-8ede-dededededede";
    const requestId = "efefefef-efef-4fef-8fef-efefefefefef";
    const callerPresentationId = "abababab-abab-4aba-8aba-abababababab";
    const targetPresentationId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    const activeJob = {
      ...job("durable-cancel-job", "durable-job-request"),
      activityId,
      status: "running",
      updatedAt: 2,
      activityPresentationId: targetPresentationId
    };
    store.createActivity({ activityId, scopeId: SCOPE_A, now: 1 });
    store.upsertJob(activeJob);

    expect(() => store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      updatedAt: 3
    })).toThrow(/CANCELLATION_PROVENANCE_REQUIRED/);
    expect(() => store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "legacy-unattributed-cancellation",
      updatedAt: 3
    })).toThrow(/CANCELLATION_PROVENANCE_REQUIRED/);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({ status: "running" })
    ]);
    expect(store.listJobs()[0]).not.toHaveProperty("cancellationIntentId");

    const { operation, intent } = store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "f".repeat(64),
      source: "widget-control",
      toolName: "codex_activity_job_cancel",
      actionName: "cancel-card-job",
      target: {
        kind: "job",
        jobId: activeJob.jobId,
        activityId,
        presentationId: targetPresentationId
      },
      expectedVersion: 1,
      callerPresentation: {
        kind: "automatic",
        activityPresentationId: callerPresentationId
      },
      widgetProof: {
        instanceDigest: "1".repeat(64),
        cardGeneration: 7
      },
      callerRequestDigest: "2".repeat(64),
      reasonCode: "widget-force-stop",
      now: 4
    });
    expect(operation.rootIntentId).toBe(intent.intentId);
    expect(operation.bridgeInstanceId).toBe(store.bridgeInstanceId);
    store.setCancellationIntentStatus(intent.intentId, "dispatched", 5);
    store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      cancellationIntentId: intent.intentId,
      updatedAt: 6
    });
    store.setCancellationIntentStatus(intent.intentId, "succeeded", 7);
    store.completeCancellationOperation(SCOPE_A, requestId, { status: "cancelled" }, "completed", 8);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.getCancellationOperation(SCOPE_A, requestId)).toMatchObject({
      status: "completed",
      source: "widget-control",
      bridgeInstanceId: expect.any(String),
      targetJobId: activeJob.jobId,
      targetPresentationId,
      result: { status: "cancelled" }
    });
    expect(restored.getCancellationIntent(intent.intentId)).toMatchObject({
      requestId,
      status: "succeeded",
      callerPresentation: {
        kind: "automatic",
        activityPresentationId: callerPresentationId
      },
      targetPresentationId,
      widgetInstancePresent: true,
      widgetInstanceDigest: "1".repeat(64),
      cardGeneration: 7,
      callerRequestDigest: "2".repeat(64)
    });
    expect(restored.listJobs()).toEqual([
      expect.objectContaining({
        status: "cancelled",
        terminalOrigin: "explicit-cancellation",
        cancellationIntentId: intent.intentId
      })
    ]);
    restored.close();
  });

  it("imports each legacy JSON registry once into the shared database", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-migration-root-"));
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-migration-state-"));
    const sessionFile = path.join(stateDirectory, "sessions.json");
    const jobFile = path.join(stateDirectory, "jobs.json");
    const settingsFile = path.join(stateDirectory, "settings.json");
    const databaseFile = path.join(stateDirectory, "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root
    });
    const legacySessions = new SessionRegistry({ stateFile: sessionFile, allowedRoots: [root] });
    legacySessions.record({
      threadId: "legacy-thread",
      scopeId: SCOPE_A,
      cwd: root,
      sandbox: "read-only",
      backendKind: "mcp-server",
      createdAt: 1,
      lastUsedAt: 2
    });
    const legacyJobs = registry(jobFile, root);
    const legacyJob = legacyJobs.start(jobInput(root), async () => ({
      content: [{ type: "text", text: "done" }],
      structuredContent: { threadId: "legacy-thread" }
    }));
    await legacyJob.promise;
    const legacySettings = new UserSettingsStore(config, { stateFile: settingsFile });
    legacySettings.update({ uiLocalePreference: "ko" }, legacySettings.current.revision);

    const store = new BridgeStateStore({ file: databaseFile });
    const importedSessions = new SessionRegistry({
      stateFile: sessionFile,
      stateStore: store,
      allowedRoots: [root]
    });
    const importedJobs = registry(jobFile, root, store);
    const importedSettings = new UserSettingsStore(config, { stateFile: settingsFile, stateStore: store });

    expect(importedSessions.get("legacy-thread")).toBeDefined();
    expect(importedJobs.get(legacyJob.jobId)).toMatchObject({ status: "completed" });
    expect(importedSettings.current).toMatchObject({ revision: 1, uiLocalePreference: "ko" });
    expect(store.countSessions()).toBe(1);
    expect(store.countJobs()).toBe(1);
    store.close();

    writeFileSync(sessionFile, JSON.stringify({ version: 3, sessions: [
      {
        threadId: "must-not-reimport",
        scopeId: SCOPE_A,
        cwd: root,
        sandbox: "read-only",
        createdAt: 3,
        lastUsedAt: 4
      }
    ] }));
    writeFileSync(jobFile, JSON.stringify({ version: 4, jobs: [] }));

    const reopened = new BridgeStateStore({ file: databaseFile });
    const restoredSessions = new SessionRegistry({
      stateFile: sessionFile,
      stateStore: reopened,
      allowedRoots: [root]
    });
    const restoredJobs = registry(jobFile, root, reopened);
    expect(restoredSessions.get("legacy-thread")).toBeDefined();
    expect(restoredSessions.get("must-not-reimport")).toBeUndefined();
    expect(restoredJobs.get(legacyJob.jobId)).toMatchObject({ status: "completed" });
    reopened.close();
  });
});

const SCOPE_A = "11111111-1111-4111-8111-111111111111";

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "bridge-sqlite-state-")), "private", "state.sqlite");
}

function temporaryRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-state-project-")));
}

function registerProject(store: BridgeStateStore, name: string, cwd: string) {
  const before = store.getProjectRegistryRevision();
  return store.applyProjectOperations(
    [{ kind: "add", project: { name, cwd } }],
    before,
    []
  ).projects.at(-1)!;
}

function session(threadId: string) {
  return {
    threadId,
    scopeId: SCOPE_A,
    cwd: "/tmp/repository",
    lastUsedAt: 1
  };
}

function job(jobId: string, requestId: string) {
  return {
    jobId,
    scopeId: SCOPE_A,
    requestId,
    status: "completed",
    updatedAt: 2
  };
}

function registry(stateFile: string, root: string, stateStore?: BridgeStateStore): CodexJobRegistry {
  return new CodexJobRegistry({
    stateFile,
    stateStore,
    allowedRoots: [root],
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000
  });
}

function jobInput(root: string) {
  return {
    operation: "start" as const,
    cwd: root,
    sandbox: "read-only" as const,
    scopeId: SCOPE_A,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestHash: "a".repeat(64),
    requestHashVersion: 2 as const,
    selectionKey: "legacy-selection",
    exclusiveKeys: [],
    sessionDecision: {
      requestedMode: "new" as const,
      action: "start" as const,
      reason: "explicit-new" as const
    }
  };
}
