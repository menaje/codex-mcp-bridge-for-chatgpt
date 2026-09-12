import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

describe("BridgeStateStore", () => {
  it("finds retained status-card work and filters archived jobs before applying its limit", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const otherScope = "22222222-2222-4222-8222-222222222222";
    try {
      expect(store.hasDashboardWork(SCOPE_A)).toBe(false);
      store.upsertJob({ ...job("older-here", "request-here"), updatedAt: 10 });
      store.upsertJob({ ...job("newer-elsewhere", "request-elsewhere"), scopeId: otherScope, updatedAt: 20 });
      store.deleteJob("older-here");
      store.deleteJob("newer-elsewhere");
      expect(store.countJobs()).toBe(0);
      expect(store.hasDashboardWork(SCOPE_A)).toBe(true);
      expect(store.listDashboardRetainedJobs(1).map(job => job.jobId)).toEqual(["newer-elsewhere"]);
      expect(store.listDashboardRetainedJobs(1, SCOPE_A).map(job => job.jobId)).toEqual(["older-here"]);
    } finally { store.close(); }
  });

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
    expect(reopened.listSessions()).toEqual([
      expect.objectContaining(session("thread-committed"))
    ]);
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
    expect(reopened.schemaVersion).toBe(19);
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
      projectName: project.name,
      projectCwd: cwd,
      title: "Project-aware work",
      now: 1
    });
    store.upsertSession({
      ...session("thread-project"),
      cwd,
      projectId: project.id,
      projectName: project.name
    });
    store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: project.id,
      projectName: project.name
    });

    expect(store.getActivity(activityId)).toMatchObject({
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    });
    expect(store.getActivity(activityId)).not.toHaveProperty("projectCwd");
    expect(store.getActivityProjectAdmission(activityId)).toEqual({
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      projectCwd: cwd
    });
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
    ]);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
    ]);
    expect(() => store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Other"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(19);
    expect(restored.getActivityProjectAdmission(activityId)?.projectId).toBe(project.id);
    expect(restored.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
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
      projectName: "Alpha",
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
      projectName: "Beta",
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
      projectName: "Codex MCP Bridge"
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
      projectName: "Codex MCP Bridge"
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

  it("persists a bounded user-facing model cancellation reason in the durable root operation", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const activityId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const requestId = "cececece-cece-4ece-8ece-cececececece";
    const activeJob = {
      ...job("reasoned-cancel-job", "reasoned-job-request"),
      activityId,
      status: "running",
      updatedAt: 2
    };
    store.createActivity({ activityId, scopeId: SCOPE_A, now: 1 });
    store.upsertJob(activeJob);

    const { intent } = store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "e".repeat(64),
      source: "model-tool",
      toolName: "codex_cancel",
      actionName: "cancel-job",
      target: { kind: "job", jobId: activeJob.jobId, activityId },
      expectedVersion: 1,
      reasonCode: "public-job-cancel",
      reason: "  The user changed direction.\nStop the obsolete job.  ",
      now: 3
    });
    expect(store.getCancellationOperation(SCOPE_A, requestId)?.reason).toBe(
      "The user changed direction. Stop the obsolete job."
    );
    expect(store.listJobEvents(activeJob.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "cancellation-intent-recorded",
        payload: expect.objectContaining({
          cancellationIntentId: intent.intentId,
          reason: "The user changed direction. Stop the obsolete job."
        })
      })
    ]));
    expect(() => store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf",
      actionHash: "d".repeat(64),
      source: "model-tool",
      toolName: "codex_cancel",
      actionName: "cancel-job",
      target: { kind: "job", jobId: activeJob.jobId, activityId },
      expectedVersion: 1,
      reasonCode: "public-job-cancel",
      reason: "x".repeat(501),
      now: 4
    })).toThrow(/500 characters/);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(19);
    expect(restored.getCancellationOperation(SCOPE_A, requestId)).toMatchObject({
      source: "model-tool",
      reason: "The user changed direction. Stop the obsolete job."
    });
    restored.close();
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
