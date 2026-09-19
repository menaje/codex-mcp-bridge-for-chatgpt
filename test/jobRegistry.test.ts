import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexJobRegistry } from "../src/tools.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexProgress, CodexUpstream, ToolResult } from "../src/upstream.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("CodexJobRegistry persistence", () => {
  it.each(["persistent", "ephemeral"] as const)(
    "keeps %s progress writes on bounded state and event paths",
    async (mode) => {
      const root = temporaryRoot();
      const clock = vi.spyOn(Date, "now");
      let now = 1_000;
      clock.mockImplementation(() => now);
      const stateStore = mode === "persistent"
        ? new BridgeStateStore({ file: path.join(root, "state.sqlite") })
        : undefined;
      const registry = new CodexJobRegistry({
        stateStore,
        allowedRoots: [root]
      });
      const store = registry.admissionStateStore;
      const upsertJob = vi.spyOn(store, "upsertJob");
      const replaceJobs = vi.spyOn(store, "replaceJobs");
      const updateProgress = vi.spyOn(store, "updateJobProgressState");
      const recordTelemetry = vi.spyOn(store, "recordJobTelemetryEvent");
      let emitProgress: ((progress: CodexProgress) => void) | undefined;
      try {
        const job = registry.start(jobInput(root), async (progress) => {
          emitProgress = progress;
          return new Promise<ToolResult>(() => undefined);
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(emitProgress).toBeTypeOf("function");
        upsertJob.mockClear();
        replaceJobs.mockClear();

        now = 31_001;
        emitProgress?.({ progress: 0.25 });
        expect(updateProgress).toHaveBeenCalledTimes(1);
        expect(recordTelemetry).not.toHaveBeenCalled();

        now = 31_002;
        emitProgress?.({
          progress: 0.5,
          event: {
            eventId: "bounded-progress-event",
            type: "command",
            phase: "updated",
            createdAt: now,
            summary: "Command is still running"
          }
        });
        expect(recordTelemetry).toHaveBeenCalledTimes(1);
        expect(upsertJob).not.toHaveBeenCalled();
        expect(replaceJobs).not.toHaveBeenCalled();
        expect(store.listJobs()).toEqual([
          expect.objectContaining({
            jobId: job.jobId,
            status: "running",
            version: 3,
            lastProgressAt: now,
            lastProgress: expect.objectContaining({ progress: 0.5 })
          })
        ]);
        expect(store.listJobEvents(job.jobId).at(-1)).toMatchObject({
          eventType: "app-command-updated",
          status: "running"
        });
      } finally {
        clock.mockRestore();
        store.close();
      }
    }
  );

  it("keeps terminal waits asleep across progress churn and off the prune hot path", async () => {
    vi.useFakeTimers();
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "state.sqlite"));
    const store = registry.admissionStateStore;
    let emitProgress: ((progress: CodexProgress) => void) | undefined;
    let complete: (value: ToolResult) => void = () => undefined;
    try {
      const job = registry.start(jobInput(root), async (progress) => {
        emitProgress = progress;
        return new Promise<ToolResult>((resolve) => { complete = resolve; });
      });
      await Promise.resolve();
      await Promise.resolve();

      const projectIdentityReads = vi.spyOn(store, "listActivityProjectIdentities");
      const waiting = registry.wait(job.jobId, "terminal", 1_000, undefined, "model-status");
      await Promise.resolve();
      projectIdentityReads.mockClear();

      for (let index = 0; index < 100; index += 1) {
        emitProgress?.({ progress: index / 100 });
      }
      expect(projectIdentityReads).not.toHaveBeenCalled();
      expect(registry.waitDiagnostics()).toMatchObject({
        exactStatusWaits: 1,
        wakes: { total: 0, progress: 0, terminal: 0 },
        active: {
          total: 1,
          modelStatus: 1,
          jobs: [{ jobId: job.jobId, total: 1, terminal: 1, modelStatus: 1 }]
        }
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toMatchObject({
        job: { jobId: job.jobId, status: "running" },
        waitFor: "terminal",
        waitTimedOut: true,
        changed: true
      });
      expect(projectIdentityReads).not.toHaveBeenCalled();
      expect(registry.waitDiagnostics()).toMatchObject({
        timedOut: 1,
        wakes: { total: 0, progress: 0, terminal: 0 },
        active: { total: 0, jobs: [] }
      });

      complete(result("terminal-timeout-survived"));
      await job.promise;
      expect(registry.get(job.jobId)).toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it("wakes change waits on progress without waking terminal waits", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "state.sqlite"));
    let emitProgress: ((progress: CodexProgress) => void) | undefined;
    let complete: (value: ToolResult) => void = () => undefined;
    try {
      const job = registry.start(jobInput(root), async (progress) => {
        emitProgress = progress;
        return new Promise<ToolResult>((resolve) => { complete = resolve; });
      });
      await Promise.resolve();
      await Promise.resolve();

      const changed = registry.wait(job.jobId, "change", 5_000);
      await Promise.resolve();
      emitProgress?.({ progress: 0.5 });
      await expect(changed).resolves.toMatchObject({
        job: { jobId: job.jobId, status: "running" },
        waitFor: "change",
        waitTimedOut: false,
        changed: true
      });
      expect(registry.waitDiagnostics()).toMatchObject({
        started: { total: 1, change: 1, terminal: 0 },
        wakes: { total: 1, progress: 1, terminal: 0, stateChange: 0 }
      });

      complete(result("change-wait-completed"));
      await job.promise;
    } finally {
      registry.admissionStateStore.close();
    }
  });

  it("bounds simultaneous Dashboard and model terminal watchers under public-event load", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "state.sqlite"));
    const store = registry.admissionStateStore;
    let emitProgress: ((progress: CodexProgress) => void) | undefined;
    let complete: (value: ToolResult) => void = () => undefined;
    try {
      const job = registry.start(jobInput(root), async (progress) => {
        emitProgress = progress;
        return new Promise<ToolResult>((resolve) => { complete = resolve; });
      });
      await Promise.resolve();
      await Promise.resolve();

      const modelWait = registry.wait(
        job.jobId, "terminal", 5_000, undefined, "model-status"
      );
      const dashboardWait = registry.wait(
        job.jobId, "terminal", 5_000, undefined, "dashboard-completion"
      );
      await Promise.resolve();
      const projectIdentityReads = vi.spyOn(store, "listActivityProjectIdentities");

      for (let index = 0; index < 100; index += 1) {
        emitProgress?.({
          progress: index / 100,
          event: {
            eventId: `public-progress-${index}`,
            type: "command",
            phase: "updated",
            createdAt: Date.now(),
            summary: `Public progress ${index}`
          }
        });
      }
      expect(projectIdentityReads).not.toHaveBeenCalled();
      expect(registry.waitDiagnostics()).toMatchObject({
        exactStatusWaits: 1,
        sources: { modelStatus: 1, dashboardCompletion: 1 },
        wakes: { total: 0, progress: 0, terminal: 0 },
        active: {
          total: 2,
          modelStatus: 1,
          dashboardCompletion: 1,
          jobs: [{ jobId: job.jobId, total: 2, terminal: 2 }]
        },
        maintenance: { telemetryTransaction: { count: 100 } }
      });

      complete(result("two-watchers-one-terminal"));
      await job.promise;
      const [modelResult, dashboardResult] = await Promise.all([modelWait, dashboardWait]);
      expect(modelResult.job).toMatchObject({ status: "completed" });
      expect(dashboardResult.job).toMatchObject({ status: "completed" });
      expect(registry.waitDiagnostics()).toMatchObject({
        completed: 2,
        wakes: { total: 2, progress: 0, terminal: 2, stateChange: 0 },
        active: { total: 0, jobs: [] }
      });
    } finally {
      store.close();
    }
  });

  it("treats an aborted exact status wait as a read abort without cancelling the Job", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "state.sqlite"));
    let complete: (value: ToolResult) => void = () => undefined;
    try {
      const job = registry.start(jobInput(root), async () =>
        new Promise<ToolResult>((resolve) => { complete = resolve; })
      );
      await Promise.resolve();
      const cancel = vi.spyOn(registry, "cancel");
      const controller = new AbortController();
      const waiting = registry.wait(
        job.jobId, "terminal", 5_000, controller.signal, "model-status"
      );
      await Promise.resolve();
      controller.abort();

      await expect(waiting).rejects.toThrow("cancelled by the host");
      expect(cancel).not.toHaveBeenCalled();
      expect(registry.get(job.jobId)).toMatchObject({ status: "running" });
      expect(registry.get(job.jobId)?.cancelRequestedAt).toBeUndefined();
      expect(registry.waitDiagnostics()).toMatchObject({
        hostAborts: { total: 1, modelStatus: 1 },
        active: { total: 0, jobs: [] }
      });

      complete(result("abort-did-not-cancel"));
      await job.promise;
      expect(registry.get(job.jobId)).toMatchObject({ status: "completed" });
    } finally {
      registry.admissionStateStore.close();
    }
  });

  it("notifies native subscribers when work starts and settles, then unsubscribes", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "state.sqlite"));
    const changed = vi.fn();
    const unsubscribe = registry.subscribeChanges(changed);
    let complete: (value: ToolResult) => void = () => undefined;
    const job = registry.start(jobInput(root), () => new Promise(resolve => { complete = resolve; }));
    await Promise.resolve();
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    complete(result("native-notice"));
    await job.promise;
    expect(changed).toHaveBeenCalled();
    unsubscribe();
    changed.mockClear();
    const next = registry.start({ ...jobInput(root), requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, async () => result("after-unsubscribe"));
    await next.promise;
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([["upstream unavailable", "upstream-failure"], ["CODEX_WORKER_LOST: Worker exited", "worker-loss"]])("records %s without inventing user cancellation", async (message, origin) => {
    const root = temporaryRoot(), stateFile = path.join(root, "state.sqlite");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start({ ...jobInput(root), backendKind: "app-server" }, async () => { throw new Error(message); });
    await job.promise;
    expect(registry.listCancellationIntents({ jobId: job.jobId })).toHaveLength(0);
    registry.admissionStateStore.close();
    expect(persistentRegistry(root, stateFile).get(job.jobId)).toMatchObject({ backendKind: "app-server", terminalOrigin: origin });
  });
  it("retains completed results across bridge registry restarts", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "state.sqlite");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(jobInput(root), async () => result("thread-completed"));

    await job.promise;
    registry.admissionStateStore.close();
    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      status: "completed",
      terminalOrigin: "normal-completion",
      executionDecision: {
        policyRevision: 3,
        effectiveSelection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        source: "fixed",
        appliedAt: "thread-start"
      },
      result: { structuredContent: { threadId: "thread-completed" } }
    });
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it("keeps reads pure and expires a result only at an explicit retention boundary", async () => {
    const root = temporaryRoot();
    const stateStore = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    const clock = vi.spyOn(Date, "now");
    let now = 1_000;
    clock.mockImplementation(() => now);
    const ttlMs = 100;
    const registry = new CodexJobRegistry({
      stateStore,
      allowedRoots: [root],
      ttlMs,
      maxJobs: 100
    });
    try {
      const completed = registry.start(jobInput(root), async () => result("recovery-window"));
      await completed.promise;
      const delivery = stateStore.getJobCompletionDelivery(completed.jobId, SCOPE_A)!;
      const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      stateStore.claimJobCompletionDelivery(completed.jobId, SCOPE_A, owner, 1_000, 1_010);
      stateStore.markJobCompletionHostAccepted({
        jobId: completed.jobId,
        scopeId: SCOPE_A,
        receipt: delivery.receipt,
        leaseOwner: owner,
        now: 1_020
      });
      stateStore.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "completion-receipt",
        receipt: delivery.receipt,
        now: 1_050
      });

      now = 1_101;
      expect(registry.get(completed.jobId)?.result).toMatchObject({
        structuredContent: { threadId: "recovery-window" }
      });
      now = 1_150;
      expect(registry.get(completed.jobId)).toBeDefined();
      expect(stateStore.listJobs()).toHaveLength(1);
      expect(registry.maintainRetainedJobs()).toBe(1);
      expect(registry.get(completed.jobId)).toBeUndefined();
      expect(stateStore.listJobs()).toEqual([]);
    } finally {
      clock.mockRestore();
      stateStore.close();
    }
  });

  it("does not publish an in-memory completion when the atomic terminal commit fails", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
    const store = registry.admissionStateStore;
    const originalUpsert = store.upsertJob.bind(store);
    let injected = false;
    vi.spyOn(store, "upsertJob").mockImplementation((value) => {
      if (!injected && (value as { status?: unknown }).status === "completed") {
        injected = true;
        throw new Error("injected terminal persistence failure");
      }
      return originalUpsert(value);
    });

    const job = registry.start(jobInput(root), async () => result("commit-failure-thread"));
    await job.promise;

    expect(injected).toBe(true);
    expect(registry.get(job.jobId)).toMatchObject({
      status: "failed",
      terminalOrigin: undefined,
      error: expect.stringContaining("BRIDGE_TERMINAL_COMMIT_FAILED")
    });
    expect(store.listJobs()).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: "failed",
        error: expect.stringContaining("BRIDGE_TERMINAL_COMMIT_FAILED")
      })
    ]);
    expect(store.listJobs()[0]).not.toHaveProperty("terminalOrigin");
    expect(store.listJobEvents(job.jobId).map((event) => event.eventType)).toEqual([
      "job-started",
      "job-failed"
    ]);
    expect(store.listCompletionOutbox(job.activityId)).toEqual([]);
  });

  it("does not start deferred execution when the enclosing admission transaction rolls back", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
    const run = vi.fn(async () => result("must-not-run"));
    let job: ReturnType<CodexJobRegistry["start"]> | undefined;

    expect(() => registry.activityTransaction(() => {
      job = registry.start(jobInput(root), run, undefined, 4, false, undefined, true);
      throw new Error("injected admission commit failure");
    })).toThrow("injected admission commit failure");
    registry.discardDeferredAdmission(job!.jobId);
    await job!.promise;

    expect(run).not.toHaveBeenCalled();
    expect(registry.get(job!.jobId)).toBeUndefined();
    expect(registry.admissionStateStore.listJobs()).toEqual([]);
  });

  it("makes a rejected-turn terminal commit failure explicit instead of publishing the upstream failure", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
    const store = registry.admissionStateStore;
    const originalUpsert = store.upsertJob.bind(store);
    let injected = false;
    vi.spyOn(store, "upsertJob").mockImplementation((value) => {
      if (!injected && (value as { status?: unknown }).status === "failed") {
        injected = true;
        throw new Error("injected rejected-turn persistence failure");
      }
      return originalUpsert(value);
    });

    const job = registry.start(jobInput(root), async () => {
      throw new Error("ordinary upstream failure");
    });
    await job.promise;

    expect(registry.get(job.jobId)).toMatchObject({
      status: "failed",
      terminalOrigin: undefined,
      error: expect.stringContaining("BRIDGE_TERMINAL_COMMIT_FAILED")
    });
    expect(store.listJobs()).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: "failed",
        error: expect.stringContaining("BRIDGE_TERMINAL_COMMIT_FAILED")
      })
    ]);
  });

  it("keeps the durable running receipt authoritative when every terminal commit fails", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
    const store = registry.admissionStateStore;
    const originalUpsert = store.upsertJob.bind(store);
    vi.spyOn(store, "upsertJob").mockImplementation((value) => {
      if ((value as { status?: unknown }).status !== "running") {
        throw new Error("persistent terminal persistence failure");
      }
      return originalUpsert(value);
    });

    const job = registry.start(jobInput(root), async () => result("uncommitted-terminal-thread"));
    await job.promise;

    expect(registry.get(job.jobId)).toMatchObject({
      status: "running",
      version: 1
    });
    expect(registry.get(job.jobId)).not.toHaveProperty("terminalOrigin");
    expect(store.listJobs()).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: "running",
        version: 1
      })
    ]);
    expect(store.listJobEvents(job.jobId).map((event) => event.eventType)).toEqual([
      "job-started"
    ]);
  });

  it("persists retired request-hash version 3 without inventing a project identity", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "state.sqlite");
    const registry = persistentRegistry(root, stateFile);
    const job = registry.start(
      {
        ...jobInput(root),
        requestHashVersion: 3
      },
      async () => result("project-thread")
    );

    await job.promise;
    registry.admissionStateStore.close();
    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      requestHashVersion: 3
    });
  });

  it("persists request-hash version 4 and its immutable source thread", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "state.sqlite");
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
    registry.admissionStateStore.close();
    const restored = persistentRegistry(root, stateFile);
    expect(restored.get(job.jobId)).toMatchObject({
      requestHashVersion: 4,
      sourceThreadId: "thread-before-fork"
    });
  });

  it.each(["mcp-server", "codex-sdk", "app-server"] as const)("marks %s jobs that were running at restart as interrupted without replay", async backendKind => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "state.sqlite");
    const registry = persistentRegistry(root, stateFile);
    const execute = vi.fn(async () => new Promise<ToolResult>(() => undefined));
    const job = registry.start({ ...jobInput(root), backendKind }, execute);
    await Promise.resolve();

    registry.admissionStateStore.close();
    const restored = persistentRegistry(root, stateFile);
    const loaded = restored.get(job.jobId);

    expect(loaded).toMatchObject({
      backendKind,
      status: "interrupted",
      terminalOrigin: "bridge-restart",
      trackingState: "orphaned",
      version: 2,
      error: "The bridge restarted before this Codex job reached a terminal state."
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restored.listCancellationIntents({ jobId: job.jobId })).toEqual([]);
  });

  it("treats resolved MCP error results as failed jobs", async () => {
    const root = temporaryRoot();
    const stateFile = path.join(root, "private", "state.sqlite");
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
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
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

  it("drops persisted jobs whose cwd is outside the configured roots", async () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const stateFile = path.join(firstRoot, "private", "state.sqlite");
    const registry = persistentRegistry(firstRoot, stateFile);
    const job = registry.start(jobInput(firstRoot), async () => result("thread-one"));
    await job.promise;

    registry.admissionStateStore.close();
    const restored = persistentRegistry(secondRoot, stateFile);

    expect(restored.get(job.jobId)).toBeUndefined();
    expect(restored.size).toBe(0);
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

  it("restores a terminal result that arrives while an unconfirmed force-stop is pending", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
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
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
    registry.attachUpstream({
      async listTools() { return { tools: [] }; },
      async callTool() { return result("unused"); },
      async close() {},
      async forceTerminateWorker() { throw new Error("still alive"); }
    });
    let emitProgress: ((progress: CodexProgress) => void) | undefined;
    const job = registry.start(jobInput(root), async (progress, assigned) => {
      emitProgress = progress;
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
    const beforeResumeScopeVersion = registry.getScopeVersion(SCOPE_A);
    const upsertJob = vi.spyOn(registry.admissionStateStore, "upsertJob");
    emitProgress?.({ progress: 0.5 });
    expect(upsertJob).not.toHaveBeenCalled();
    expect(registry.get(job.jobId)).toMatchObject({ status: "running" });
    expect(registry.get(job.jobId)?.error).toBeUndefined();
    expect(registry.admissionStateStore.listJobs()).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: "running",
        version: job.version,
        lastProgress: expect.objectContaining({ progress: 0.5 })
      })
    ]);
    expect((registry.admissionStateStore.listJobs()[0] as { error?: string }).error).toBeUndefined();
    expect(registry.getScopeVersion(SCOPE_A)).toBe(beforeResumeScopeVersion + 1);
    expect(registry.admissionStateStore.listJobEvents(job.jobId).at(-1)).toMatchObject({
      eventType: "job-running",
      status: "running",
      payload: { resumedFrom: "termination-failed" }
    });
  });

  it("rejects an internal single-job cancellation before side effects when provenance is absent", async () => {
    const root = temporaryRoot();
    const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
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
      const registry = persistentRegistry(root, path.join(root, "private", "state.sqlite"));
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
    const stateFile = path.join(root, "private", "state.sqlite");
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
      ...(job.upstreamRequestId ? { turnId: job.upstreamRequestId } : {})
    },
    expectedVersion: job.version,
    reasonCode: "test-cancel"
  }).intent;
}

function persistentRegistry(root: string, stateFile: string): CodexJobRegistry {
  const stateStore = new BridgeStateStore({ file: stateFile });
  return new CodexJobRegistry({
    maxConcurrentJobs: 30,
    ttlMs: 6 * 60 * 60 * 1000,
    maxJobs: 100,
    maxResultBytes: 1024 * 1024,
    staleAfterMs: 10 * 60 * 1000,
    stateStore,
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
