import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexJobRegistry } from "../src/tools.js";
import { LEGACY_SCOPE_ID } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("CodexJobRegistry persistence", () => {
  it("retains completed results across bridge registry restarts", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("thread-completed"));

    await job.promise;
    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      status: "completed",
      terminalOrigin: "normal-completion",
      activityPresentationId: REQUEST_A,
      executionDecision: {
        policyRevision: 3,
        effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        source: "fixed",
        appliedAt: "thread-start"
      },
      result: { structuredContent: { threadId: "thread-completed" } }
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 10 });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it("persists retired request-hash version 3 without inventing a project identity", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(
      {
        ...jobInput(root),
        requestHashVersion: 3
      },
      async () => result("project-thread")
    );

    await job.promise;
    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      requestHashVersion: 3
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      version: 10,
      jobs: [expect.objectContaining({ requestHashVersion: 3 })]
    });
  });

  it("persists request-hash version 4 and its immutable source thread", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(
      {
        ...jobInput(root),
        requestHashVersion: 4,
        sourceThreadId: "thread-before-fork"
      },
      async () => result("thread-after-fork")
    );

    await job.promise;
    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      requestHashVersion: 4,
      sourceThreadId: "thread-before-fork"
    });
  });

  it("marks jobs that were running at restart as interrupted", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(
      jobInput(root),
      async () => new Promise<ToolResult>(() => undefined)
    );
    await Promise.resolve();

    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      status: "interrupted",
      terminalOrigin: "bridge-restart",
      trackingState: "orphaned",
      version: 2,
      error: "The bridge restarted before this Codex job reached a terminal state."
    });
  });

  it("treats resolved MCP error results as failed jobs", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => ({
      isError: true,
      content: [{ type: "text", text: "Session not found for thread_id: stale-thread" }]
    }));

    await job.promise;
    expect(registry.get(job.jobId)).toMatchObject({
      status: "failed",
      terminalOrigin: "upstream-failure",
      error: "Session not found for thread_id: stale-thread"
    });
    expect(registry.get(job.jobId)?.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Session not found for thread_id: stale-thread" }]
    });
  });

  it("keeps spontaneous App Server interruption and worker loss distinct from cancellation", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    const interrupted = registry.start(
      { ...jobInput(root), backendKind: "app-server" },
      async () => ({
        content: [{ type: "text", text: "interrupted upstream" }],
        structuredContent: {
          threadId: "spontaneous-thread",
          turnId: "spontaneous-turn",
          turnStatus: "interrupted",
          backendKind: "app-server"
        }
      })
    );
    await interrupted.promise;
    expect(registry.get(interrupted.jobId)).toMatchObject({
      status: "interrupted",
      terminalOrigin: "app-server-interrupted"
    });
    expect(registry.get(interrupted.jobId)?.cancellationIntentId).toBeUndefined();
    expect(registry.listCancellationIntents({ jobId: interrupted.jobId })).toHaveLength(0);

    const workerLost = registry.start(
      {
        ...jobInput(root),
        backendKind: "app-server",
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        requestHash: "d".repeat(64)
      },
      async () => {
        throw new Error(
          "CODEX_WORKER_LOST: The Codex App Server worker exited during an active turn."
        );
      }
    );
    await workerLost.promise;
    expect(registry.get(workerLost.jobId)).toMatchObject({
      status: "interrupted",
      terminalOrigin: "worker-loss",
      trackingState: "worker-lost"
    });
    expect(registry.get(workerLost.jobId)?.cancellationIntentId).toBeUndefined();
    expect(registry.listCancellationIntents({ jobId: workerLost.jobId })).toHaveLength(0);
  });

  it("repairs legacy completed jobs whose retained MCP result is an error", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("thread-before-repair"));
    await job.promise;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.jobs[0].result = {
      isError: true,
      content: [{ type: "text", text: "Session not found for thread_id: thread-before-repair" }]
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      status: "failed",
      error: "Session not found for thread_id: thread-before-repair"
    });
    expect(restored.get(job.jobId)?.result).toBeUndefined();
  });

  it("drops persisted jobs whose cwd is outside the configured roots", async () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const stateFile = path.join(firstRoot, "private", "jobs.json");
    const registry = persistentRegistry(firstRoot, stateFile);
    const job = registry.start(jobInput(firstRoot), async () => result("thread-one"));
    await job.promise;

    const restored = persistentRegistry(secondRoot, stateFile);

    expect(restored.get(job.jobId)).toBeUndefined();
    expect(restored.size).toBe(0);
  });

  it("migrates version 1 jobs into a quarantined legacy scope", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("legacy-thread"));
    await job.promise;

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.version = 1;
    delete state.jobs[0].scopeId;
    delete state.jobs[0].taskKey;
    delete state.jobs[0].requestId;
    delete state.jobs[0].requestHash;
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      scopeId: LEGACY_SCOPE_ID
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 10 });
  });

  it("migrates version 2 task-lane jobs without retaining taskKey", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("v2-thread"));
    await job.promise;

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.version = 2;
    state.jobs[0].taskKey = "review";
    state.jobs[0].requestHash = "b".repeat(64);
    delete state.jobs[0].requestHashVersion;
    delete state.jobs[0].selectionKey;
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({ scopeId: SCOPE_A });
    expect(restored.get(job.jobId)).not.toHaveProperty("taskKey");
    expect(restored.findRequest(SCOPE_A, REQUEST_A, "a".repeat(64))?.jobId).toBe(job.jobId);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 10 });
  });

  it("labels pre-provenance cancelled rows only through the legacy import path", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("legacy-cancelled-thread"));
    await job.promise;

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.version = 9;
    state.jobs[0].status = "cancelled";
    delete state.jobs[0].terminalOrigin;
    delete state.jobs[0].cancellationIntentId;
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      status: "cancelled",
      terminalOrigin: "legacy-unattributed-cancellation"
    });
    expect(restored.get(job.jobId)?.cancellationIntentId).toBeUndefined();
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ version: 10 });
  });

  it("keeps only the newest legacy record for a duplicated scope request", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const original = registry.start(jobInput(root), async () => result("older-thread"));
    await original.promise;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const duplicate = structuredClone(state.jobs[0]);
    duplicate.jobId = "newer-duplicate-job";
    duplicate.updatedAt += 1;
    duplicate.result = result("newer-thread");
    state.jobs.push(duplicate);
    writeFileSync(stateFile, JSON.stringify(state));

    const restored = persistentRegistry(root, stateFile);
    expect(restored.size).toBe(1);
    expect(restored.get("newer-duplicate-job")).toMatchObject({
      status: "completed",
      result: { structuredContent: { threadId: "newer-thread" } }
    });
    expect(restored.get(original.jobId)).toBeUndefined();
  });

  it("cancels a scope watcher promptly and releases its widget lease", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    const controller = new AbortController();
    const version = registry.getScopeVersion(SCOPE_A);
    const pending = registry.waitForScopeVersion(
      SCOPE_A,
      version,
      10_000,
      "widget-a",
      controller.signal,
      { kind: "explicit" }
    );

    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled by the host/);
    await expect(
      registry.waitForScopeVersion(
        SCOPE_A,
        version,
        1,
        "widget-a",
        undefined,
        { kind: "explicit" }
      )
    ).resolves.toMatchObject({ changed: false, timedOut: true });
  });

  it("keeps watcher admission separate from all 30 active Codex job slots", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    for (let index = 0; index < 30; index += 1) {
      registry.start(
        {
          ...jobInput(root),
          requestId: `request-${index}`,
          requestHash: String(index).padStart(64, "0")
        },
        async () => new Promise<ToolResult>(() => undefined)
      );
    }
    expect(registry.runningCount()).toBe(30);
    expect(() =>
      registry.start(
        {
          ...jobInput(root),
          requestId: "request-over-limit",
          requestHash: "f".repeat(64)
        },
        async () => result("never")
      )
    ).toThrow(/configured limit is 30/);

    const controller = new AbortController();
    const version = registry.getScopeVersion(SCOPE_A);
    const watch = registry.waitForScopeVersion(
      SCOPE_A,
      version,
      10_000,
      "widget-load-test",
      controller.signal,
      { kind: "explicit" }
    );
    controller.abort();
    await expect(watch).rejects.toThrow(/cancelled by the host/);
  });

  it("directs deliberate parallel work to a fresh Agent context, not retired session inputs", async () => {
    const root = temporaryRoot();
    const registry = new CodexJobRegistry({ maxConcurrentJobs: 2, allowedRoots: [root] });
    let finish!: (value: ToolResult) => void;
    const pending = new Promise<ToolResult>((resolve) => {
      finish = resolve;
    });
    const first = registry.start(jobInput(root), async () => pending);

    let conflict = "";
    try {
      registry.start(
        {
          ...jobInput(root),
          requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          requestHash: "b".repeat(64)
        },
        async () => result("unused"),
        undefined,
        2,
        true
      );
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error);
    }
    expect(conflict).toContain("contextMode='fresh'");
    expect(conflict).not.toContain("sessionMode");

    finish(result("thread-completed"));
    await first.promise;
  });

  it("enforces independent per-scope and global watcher fairness limits", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const scopeB = "22222222-2222-4222-8222-222222222222";
    const watches = controllers.slice(0, 3).map((controller, index) =>
      registry
        .waitForScopeVersion(
          SCOPE_A,
          registry.getScopeVersion(SCOPE_A),
          10_000,
          `widget-${index}`,
          controller.signal,
          { kind: "explicit" }
        )
        .catch((error: unknown) => error)
    );
    watches.push(registry.waitForScopeVersion(
      SCOPE_A,
      registry.getScopeVersion(SCOPE_A),
      10_000,
      "widget-3",
      controllers[3].signal,
      {
        kind: "automatic",
        activityPresentationId: "10101010-1010-4010-8010-101010101010"
      }
    ).catch((error: unknown) => error));

    await expect(
      registry.waitForScopeVersion(
        SCOPE_A,
        registry.getScopeVersion(SCOPE_A),
        10,
        "widget-extra-a",
        undefined,
        { kind: "explicit" }
      )
    ).rejects.toThrow(/per-scope watcher limit is 4/);
    watches.push(...controllers.slice(4, 7).map((controller, offset) =>
      registry
        .waitForScopeVersion(
          scopeB,
          registry.getScopeVersion(scopeB),
          10_000,
          `widget-${offset + 4}`,
          controller.signal,
          { kind: "explicit" }
        )
        .catch((error: unknown) => error)
    ));
    watches.push(registry.waitForScopeVersion(
      scopeB,
      registry.getScopeVersion(scopeB),
      10_000,
      "widget-7",
      controllers[7].signal,
      {
        kind: "automatic",
        activityPresentationId: "20202020-2020-4020-8020-202020202020"
      }
    ).catch((error: unknown) => error));
    await expect(
      registry.waitForScopeVersion(
        "33333333-3333-4333-8333-333333333333",
        0,
        10,
        "widget-global-extra",
        undefined,
        { kind: "explicit" }
      )
    ).rejects.toThrow(/watcher limit is 8/);

    for (const controller of controllers) controller.abort();
    await Promise.all(watches);
  });

  it("confirms automatic presentation ownership only after a mounted card lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    try {
      const registry = new CodexJobRegistry({ activityMountReservationTtlMs: 1_000 });
      const activity = registry.createActivity({ scopeId: SCOPE_A, title: "Card generation" });
      const preferences = { activityCardVisibility: "always" as const };
      const firstPresentation = "10101010-1010-4010-8010-101010101010";
      const secondPresentation = "20202020-2020-4020-8020-202020202020";

      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-one"
      }))
        .toMatchObject({
          activityId: activity.activityId,
          cardGeneration: 1,
          shouldRenderActivityCard: true,
          renderReason: "new-presentation",
          activityPresentationId: firstPresentation
        });
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-two"
      }))
        .toMatchObject({ shouldRenderActivityCard: true, renderReason: "render-latest" });
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-one"
      }))
        .toMatchObject({ shouldRenderActivityCard: true, renderReason: "render-latest" });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-two"
      }))
        .toMatchObject({ shouldRenderActivityCard: true, renderReason: "new-presentation" });

      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        1,
        "widget-one",
        {
          kind: "automatic",
          activityPresentationId: firstPresentation,
          reservationOwnerId: "job-two"
        }
      )).toEqual({ stopped: false });
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-two"
      }))
        .toMatchObject({ shouldRenderActivityCard: false, renderReason: "active-lease" });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        1,
        "widget-duplicate",
        {
          kind: "automatic",
          activityPresentationId: firstPresentation,
          reservationOwnerId: "job-two"
        }
      )).toEqual({ stopped: true, stopReason: "presentation-duplicate" });
      registry.releaseActivityCardLease(
        SCOPE_A,
        activity.activityId,
        1,
        "widget-one",
        {
          kind: "automatic",
          activityPresentationId: firstPresentation,
          reservationOwnerId: "job-two"
        }
      );
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-two"
      })).toMatchObject({
        shouldRenderActivityCard: false,
        renderReason: "render-confirmed"
      });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        1,
        "widget-remounted",
        {
          kind: "automatic",
          activityPresentationId: firstPresentation,
          reservationOwnerId: "job-two"
        }
      )).toEqual({ stopped: false });
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        presentationKind: "explicit"
      }))
        .toMatchObject({ shouldRenderActivityCard: true, renderReason: "explicit" });

      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId: secondPresentation,
        reservationOwnerId: "job-three"
      })).toMatchObject({ shouldRenderActivityCard: true, renderReason: "new-presentation" });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, {
        kind: "automatic",
        activityPresentationId: firstPresentation
      })).toMatchObject({ live: true, stopped: false });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, {
        kind: "automatic",
        activityPresentationId: secondPresentation
      })).toMatchObject({ live: true, stopped: false, ownsCompletionHandoff: true });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        1,
        "widget-two",
        {
          kind: "automatic",
          activityPresentationId: secondPresentation,
          reservationOwnerId: "job-three"
        }
      )).toEqual({ stopped: false });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, {
        kind: "automatic",
        activityPresentationId: firstPresentation
      })).toMatchObject({ live: false, stopped: true, stopReason: "presentation-superseded" });

      const root = temporaryRoot();
      const databaseFile = path.join(root, "state.sqlite");
      const firstStore = new BridgeStateStore({ file: databaseFile });
      const beforeRestart = new CodexJobRegistry({ stateStore: firstStore, allowedRoots: [root] });
      const persistentActivity = beforeRestart.createActivity({ scopeId: SCOPE_A, title: "Restart lease" });
      beforeRestart.activityCardRenderHint(persistentActivity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-before-restart"
      });
      firstStore.close();

      const secondStore = new BridgeStateStore({ file: databaseFile });
      const afterRestart = new CodexJobRegistry({ stateStore: secondStore, allowedRoots: [root] });
      expect(afterRestart.activityCardRenderHint(persistentActivity.activityId, "background", preferences, {
        activityPresentationId: firstPresentation,
        reservationOwnerId: "job-after-restart"
      })).toMatchObject({ shouldRenderActivityCard: true, renderReason: "new-presentation" });
      secondStore.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a late mount from an older unconfirmed presentation reservation", () => {
    const registry = new CodexJobRegistry();
    const activity = registry.createActivity({ scopeId: SCOPE_A, title: "Late card mount" });
    const preferences = { activityCardVisibility: "always" as const };
    const olderPresentation = "21212121-2121-4121-8121-212121212121";
    const newerPresentation = "23232323-2323-4323-8323-232323232323";

    registry.activityCardRenderHint(activity.activityId, "foreground", preferences, {
      activityPresentationId: olderPresentation,
      reservationOwnerId: "older-job"
    });
    registry.activityCardRenderHint(activity.activityId, "foreground", preferences, {
      activityPresentationId: newerPresentation,
      reservationOwnerId: "newer-job"
    });

    expect(registry.touchActivityCardLease(
      SCOPE_A,
      activity.activityId,
      activity.cardGeneration,
      "newer-widget",
      { kind: "automatic", activityPresentationId: newerPresentation }
    )).toEqual({ stopped: false });
    expect(registry.touchActivityCardLease(
      SCOPE_A,
      activity.activityId,
      activity.cardGeneration,
      "late-older-widget",
      { kind: "automatic", activityPresentationId: olderPresentation }
    )).toEqual({ stopped: true, stopReason: "presentation-superseded" });
  });

  it("lets only the newest mounted sibling own one response presentation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T01:00:00.000Z"));
    try {
      const registry = new CodexJobRegistry({ activityMountReservationTtlMs: 1_000 });
      const activity = registry.createActivity({ scopeId: SCOPE_A, title: "Latest sibling card" });
      const preferences = { activityCardVisibility: "always" as const };
      const presentationId = "25252525-2525-4525-8525-252525252525";
      const firstPresentation = {
        kind: "automatic" as const,
        activityPresentationId: presentationId,
        reservationOwnerId: "job-first"
      };
      const lastPresentation = {
        kind: "automatic" as const,
        activityPresentationId: presentationId,
        reservationOwnerId: "job-last"
      };

      registry.activityCardRenderHint(activity.activityId, "foreground", preferences, {
        activityPresentationId: presentationId,
        reservationOwnerId: "job-first"
      });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        activity.cardGeneration,
        "widget-first",
        firstPresentation
      )).toEqual({ stopped: false });

      expect(registry.activityCardRenderHint(activity.activityId, "foreground", preferences, {
        activityPresentationId: presentationId,
        reservationOwnerId: "job-last"
      })).toMatchObject({ shouldRenderActivityCard: true, renderReason: "render-latest" });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, firstPresentation))
        .toMatchObject({ live: true, stopped: false });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, firstPresentation))
        .toMatchObject({ live: true, stopped: false });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        activity.cardGeneration,
        "widget-first",
        firstPresentation
      )).toEqual({ stopped: false });

      expect(registry.activityCardRenderHint(activity.activityId, "foreground", preferences, {
        activityPresentationId: presentationId,
        reservationOwnerId: "job-last"
      })).toMatchObject({ shouldRenderActivityCard: true, renderReason: "render-latest" });
      const previousWatch = registry.waitForScopeVersion(
        SCOPE_A,
        registry.getScopeVersion(SCOPE_A),
        10_000,
        "widget-first",
        undefined,
        firstPresentation
      );
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        activity.cardGeneration,
        "widget-last",
        lastPresentation
      )).toEqual({ stopped: false });
      await expect(previousWatch).resolves.toMatchObject({
        stopped: true,
        timedOut: false,
        stopReason: "presentation-superseded"
      });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, firstPresentation))
        .toMatchObject({ live: false, stopped: true, stopReason: "presentation-superseded" });
      expect(registry.activityPresentationWatcherPolicy(SCOPE_A, lastPresentation))
        .toMatchObject({ live: true, stopped: false, ownsCompletionHandoff: true });
      expect(registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        activity.cardGeneration,
        "widget-first",
        firstPresentation
      )).toEqual({ stopped: true, stopReason: "presentation-superseded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands live-watch ownership across 10 sequential response presentations without leaking watcher slots", async () => {
    const registry = new CodexJobRegistry();
    const activity = registry.createActivity({ scopeId: SCOPE_A, title: "Sequential cards" });
    const preferences = { activityCardVisibility: "always" as const };
    let previousWatch: Promise<Awaited<ReturnType<typeof registry.waitForScopeVersion>>> | undefined;
    let previousPresentation: string | undefined;
    let finalController: AbortController | undefined;

    for (let index = 1; index <= 10; index += 1) {
      const activityPresentationId = `24242424-2424-4424-8424-${index.toString(16).padStart(12, "0")}`;
      expect(registry.activityCardRenderHint(activity.activityId, "background", preferences, {
        activityPresentationId,
        reservationOwnerId: `job-${index}`
      })).toMatchObject({
        shouldRenderActivityCard: true,
        renderReason: "new-presentation",
        activityPresentationId
      });

      const presentation = { kind: "automatic" as const, activityPresentationId };
      registry.touchActivityCardLease(
        SCOPE_A,
        activity.activityId,
        activity.cardGeneration,
        `automatic-widget-${index}`,
        presentation
      );

      if (previousWatch) {
        await expect(previousWatch).resolves.toMatchObject({
          stopped: true,
          timedOut: false,
          stopReason: "presentation-superseded"
        });
        expect(registry.activityPresentationWatcherPolicy(SCOPE_A, {
          kind: "automatic",
          activityPresentationId: previousPresentation as string
        })).toMatchObject({ live: false, ownsCompletionHandoff: false });
      }

      const controller = new AbortController();
      previousWatch = registry.waitForScopeVersion(
        SCOPE_A,
        registry.getScopeVersion(SCOPE_A),
        10_000,
        `automatic-widget-${index}`,
        controller.signal,
        presentation
      );
      previousPresentation = activityPresentationId;
      finalController = controller;
    }

    finalController?.abort();
    await expect(previousWatch).rejects.toThrow(/cancelled by the host/);

    const verificationController = new AbortController();
    const verificationWatch = registry.waitForScopeVersion(
      SCOPE_A,
      registry.getScopeVersion(SCOPE_A),
      10_000,
      "automatic-widget-verification",
      verificationController.signal,
      { kind: "automatic", activityPresentationId: previousPresentation as string }
    );
    verificationController.abort();
    await expect(verificationWatch).rejects.toThrow(/cancelled by the host/);
  });

  it("reserves three explicit watcher slots while preserving one latest automatic owner", async () => {
    const registry = new CodexJobRegistry();
    const activity = registry.createActivity({ scopeId: SCOPE_A, title: "Watcher ownership" });
    const activityPresentationId = "25252525-2525-4525-8525-252525252525";
    registry.activityCardRenderHint(
      activity.activityId,
      "background",
      { activityCardVisibility: "always" },
      { activityPresentationId }
    );

    const explicitControllers = [new AbortController(), new AbortController(), new AbortController()];
    const explicitWatches = explicitControllers.map((controller, index) =>
      registry.waitForScopeVersion(
        SCOPE_A,
        registry.getScopeVersion(SCOPE_A),
        10_000,
        `explicit-widget-${index}`,
        controller.signal,
        { kind: "explicit" }
      )
    );
    await expect(registry.waitForScopeVersion(
      SCOPE_A,
      registry.getScopeVersion(SCOPE_A),
      10_000,
      "explicit-widget-overflow",
      undefined,
      { kind: "explicit" }
    )).rejects.toThrow(/explicit-card watcher limit is 3/);

    const automaticController = new AbortController();
    const automaticWatch = registry.waitForScopeVersion(
      SCOPE_A,
      registry.getScopeVersion(SCOPE_A),
      10_000,
      "automatic-widget",
      automaticController.signal,
      { kind: "automatic", activityPresentationId }
    );
    expect(registry.activityPresentationWatcherPolicy(SCOPE_A, { kind: "explicit" }))
      .toMatchObject({ live: true, ownsCompletionHandoff: false, maxExplicitPerScope: 3 });
    expect(registry.activityPresentationWatcherPolicy(SCOPE_A, {
      kind: "automatic",
      activityPresentationId
    })).toMatchObject({ live: true, ownsCompletionHandoff: true, maxAutomaticPerScope: 1 });

    for (const controller of explicitControllers) controller.abort();
    automaticController.abort();
    const settled = await Promise.allSettled([...explicitWatches, automaticWatch]);
    expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
  });

  it("restores a terminal result that arrives while an unconfirmed force-stop is pending", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    let resolveRun!: (value: ToolResult) => void;
    const runResult = new Promise<ToolResult>((resolve) => {
      resolveRun = resolve;
    });
    const upstream: CodexUpstream = {
      async listTools() { return { tools: [] }; },
      async callTool() { return result("unused"); },
      async close() {},
      async forceTerminateWorker() {
        resolveRun(result("naturally-completed"));
        await Promise.resolve();
        throw new Error("process exit was not confirmed");
      }
    };
    registry.attachUpstream(upstream);
    const job = registry.start(jobInput(root), async (_progress, assigned) => {
      assigned({
        backendKind: "mcp-server",
        workerId: "worker-race",
        workerGeneration: 7,
        workerPid: 700,
        processGroupId: 700
      });
      return runResult;
    });

    await Promise.resolve();
    await registry.cancel(
      job.jobId,
      durableCancelIntent(
        registry,
        job.jobId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      )
    );
    await job.promise;
    expect(registry.get(job.jobId)).toMatchObject({
      status: "completed",
      result: { structuredContent: { threadId: "naturally-completed" } }
    });
    expect(registry.runningCount()).toBe(0);
  });

  it("keeps a termination-failed job active when no terminal evidence exists", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    registry.attachUpstream({
      async listTools() { return { tools: [] }; },
      async callTool() { return result("unused"); },
      async close() {},
      async forceTerminateWorker() { throw new Error("still alive"); }
    });
    const job = registry.start(jobInput(root), async (_progress, assigned) => {
      assigned({
        backendKind: "mcp-server",
        workerId: "worker-live",
        workerGeneration: 8,
        workerPid: 800,
        processGroupId: 800
      });
      return new Promise<ToolResult>(() => undefined);
    });

    await Promise.resolve();
    await expect(registry.cancel(
      job.jobId,
      durableCancelIntent(
        registry,
        job.jobId,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      )
    )).resolves.toMatchObject({ status: "termination-failed" });
    expect(registry.runningCount()).toBe(1);
    expect(registry.get(job.jobId)?.error).toContain("still alive");
  });

  it("rejects an internal single-job cancellation before side effects when provenance is absent", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
    const forceTerminateWorker = vi.fn(async () => undefined);
    registry.attachUpstream({
      async listTools() { return { tools: [] }; },
      async callTool() { return result("unused"); },
      async close() {},
      forceTerminateWorker
    });
    const job = registry.start(jobInput(root), async (_progress, assigned) => {
      assigned({
        backendKind: "mcp-server",
        workerId: "worker-without-intent",
        workerGeneration: 9,
        workerPid: 900,
        processGroupId: 900
      });
      return new Promise<ToolResult>(() => undefined);
    });
    await Promise.resolve();

    await expect(
      (registry.cancel as unknown as (jobId: string, intent: undefined) => Promise<unknown>)(
        job.jobId,
        undefined
      )
    ).rejects.toThrow(/CANCELLATION_PROVENANCE_REQUIRED/);
    expect(forceTerminateWorker).not.toHaveBeenCalled();
    expect(registry.get(job.jobId)).toMatchObject({ status: "running" });
  });

  it("keeps a no-progress job tracked beyond three hours and accepts its late result", async () => {
    vi.useFakeTimers();
    try {
      const root = temporaryRoot();
      const registry = persistentRegistry(root, path.join(root, "private", "jobs.json"));
      let resolveRun!: (value: ToolResult) => void;
      const running = new Promise<ToolResult>((resolve) => {
        resolveRun = resolve;
      });
      const job = registry.start(jobInput(root), async () => running);

      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1_000 + 1);
      expect(registry.get(job.jobId)).toMatchObject({ status: "running" });
      expect(registry.runningCount()).toBe(1);

      resolveRun(result("late-thread"));
      await job.promise;
      expect(registry.get(job.jobId)).toMatchObject({
        status: "completed",
        result: { structuredContent: { threadId: "late-thread" } }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts retained results and failures before persistence", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "jobs.json");
    const registry = persistentRegistry(root, stateFile);
    const completed = registry.start(jobInput(root), async () => ({
      _meta: { authorization: "Bearer top-secret-value" },
      content: [
        {
          type: "text",
          text: `token=sk-proj-supersecret123456 path=${path.join(root, "src", "secret.ts")}`
        }
      ],
      structuredContent: {
        threadId: "redacted-thread",
        apiKey: "sk-proj-anothersecret123456",
        cwd: path.join(root, "nested")
      }
    } as ToolResult));
    await completed.promise;
    const retained = JSON.stringify(registry.get(completed.jobId)?.result);
    expect(retained).not.toContain("top-secret-value");
    expect(retained).not.toContain("supersecret");
    expect(retained).not.toContain(root);
    expect(retained).not.toContain('"_meta"');
    expect(retained).toContain("[REDACTED");
    expect(retained).toContain(path.basename(root));

    const failed = registry.start(
      {
        ...jobInput(root),
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        requestHash: "b".repeat(64)
      },
      async () => {
        throw new Error(`Bearer abcdefghijklmnop at ${path.join(root, "private", "token.txt")}`);
      }
    );
    await failed.promise;
    const failure = registry.get(failed.jobId)?.error || "";
    expect(failure).toContain("Bearer [REDACTED]");
    expect(failure).not.toContain("abcdefghijklmnop");
    expect(failure).not.toContain(root);
    expect(readFileSync(stateFile, "utf8")).not.toContain("supersecret");
  });
});

function durableCancelIntent(
  registry: CodexJobRegistry,
  jobId: string,
  requestId: string
) {
  const job = registry.get(jobId);
  if (!job) throw new Error("test job is missing");
  return registry.beginCancellationOperation({
    scopeId: job.scopeId,
    requestId,
    actionHash: "a".repeat(64),
    source: "operator",
    toolName: "job-registry-test",
    actionName: "cancel-job",
    target: {
      kind: "job",
      jobId: job.jobId,
      activityId: job.activityId,
      ...(job.agentId ? { agentId: job.agentId } : {}),
      ...(job.threadId ? { threadId: job.threadId } : {}),
      ...(job.upstreamRequestId ? { turnId: job.upstreamRequestId } : {}),
      ...(job.activityPresentationId
        ? { presentationId: job.activityPresentationId }
        : {})
    },
    expectedVersion: job.version,
    reasonCode: "test-cancel"
  }).intent;
}

function persistentRegistry(root: string, stateFile: string): CodexJobRegistry {
  return new CodexJobRegistry({
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000,
    stateFile,
    allowedRoots: [root]
  });
}

function jobInput(root: string) {
  return {
    operation: "start" as const,
    cwd: root,
    sandbox: "read-only" as const,
    scopeId: SCOPE_A,
    requestId: REQUEST_A,
    activityPresentationId: REQUEST_A,
    requestHash: "a".repeat(64),
    requestHashVersion: 2 as const,
    selectionKey: "selection-a",
    executionDecision: {
      policyRevision: 3,
      catalogFingerprint: "c".repeat(64),
      catalogValidation: "valid" as const,
      backendKind: "mcp-server" as const,
      effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      source: "fixed" as const,
      appliedAt: "thread-start" as const,
      reason: "Selected from the saved fixed policy."
    },
    exclusiveKeys: [],
    sessionDecision: {
      requestedMode: "new" as const,
      action: "start" as const,
      reason: "explicit-new" as const
    }
  };
}

function result(threadId: string): ToolResult {
  return {
    content: [{ type: "text", text: threadId }],
    structuredContent: { threadId }
  };
}

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "bridge-job-state-"));
}
