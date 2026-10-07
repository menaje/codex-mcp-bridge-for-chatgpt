import { removeSchema31ForFixture } from "./helpers/stateSchemaFixtures.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { loadConfig } from "../src/config.js";
import type {
  ProjectTarget,
  ProjectRegistryOperation,
} from "../src/projectRegistry.js";
import type {
  CodexUpstream,
  ToolResult,
  CodexProgress,
  UpstreamWorkerAssignment,
} from "../src/upstream.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const result = (threadId: string): ToolResult => ({
  content: [{ type: "text", text: "finished" }],
  structuredContent: { threadId },
});

describe("project retirement contract (#240)", () => {
  let root: string,
    file: string,
    state: BridgeStateStore,
    jobs: CodexJobRegistry,
    settings: UserSettingsStore,
    sessions: SessionRegistry,
    upstream: CodexUpstream;
  let releases: ReturnType<typeof vi.fn>, stops: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "issue240-")));
    file = path.join(root, "state.sqlite");
    state = new BridgeStateStore({ file });
    releases = vi.fn(async () => ({
      phase: "released" as const,
      evidence: "thread-unloaded" as const,
    }));
    stops = vi.fn(async () => ({
      exited: true,
      workerExited: false,
      mode: "turn-interrupt",
      escalated: false,
    }));
    upstream = {
      releaseThreadConnection: releases,
      forceTerminateWorker: stops,
      ownsActiveExecution: () => true,
      listLoadedBackgroundTerminals: vi.fn(async () => []),
      close: async () => {},
      respondToInteraction: vi.fn(async () => {}),
    } as unknown as CodexUpstream;
    initialize();
  });
  function initialize() {
    settings = new UserSettingsStore(
      loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" }),
      { stateStore: state },
    );
    jobs = new CodexJobRegistry({
      stateStore: state,
      allowedRoots: [root],
      recoverExecutions: upstream.supportsExecutionRecovery?.() === true,
    });
    sessions = new SessionRegistry({ stateStore: state, allowedRoots: [root] });
    jobs.attachUpstream(upstream, sessions);
  }
  afterEach(async () => {
    await jobs.closeThreadConnections();
    state.close();
    rmSync(root, { recursive: true });
  });
  function apply(...ops: ProjectRegistryOperation[]) {
    return settings.updateWithProjectOperations(
      {},
      ops,
      undefined,
      settings.current.registryRevision,
    );
  }
  function register(name = "Project", cwd = path.join(root, "project")) {
    mkdirSync(cwd, { recursive: true });
    apply({ kind: "add", project: { name, cwd } });
    return settings.current.projects.find((p) => p.cwd === cwd)!;
  }
  function input(project: ProjectTarget) {
    const activity = state.createActivity({
      scopeId,
      projectId: project.id,
      projectName: project.name,
      projectCwd: project.cwd,
    });
    return {
      operation: "start" as const,
      scopeId,
      requestId: randomUUID(),
      requestHash: "a".repeat(64),
      requestHashVersion: 11 as const,
      projectId: project.id,
      projectName: project.name,
      cwd: project.cwd,
      sandbox: "read-only" as const,
      backendKind: "app-server" as const,
      activityId: activity.activityId,
      exclusiveKeys: [],
      sessionDecision: {
        requestedMode: "new" as const,
        action: "start" as const,
        reason: "explicit-new" as const,
      },
    };
  }
  function session(
    project: ProjectTarget,
    threadId = randomUUID(),
    agentName = randomUUID(),
    persistence: "persistent" | "ephemeral" | "unknown" = "ephemeral",
  ) {
    const agent = jobs.createAgent({ scopeId, agentName });
    sessions.record({
      threadId,
      scopeId,
      backendKind: "app-server",
      projectId: project.id,
      projectName: project.name,
      cwd: project.cwd,
      sandbox: "read-only",
      persistence,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    });
    jobs.linkAgentThread({
      agentId: agent.agentId,
      threadId,
      projectId: project.id,
      projectName: project.name,
      cwd: project.cwd,
      backendKind: "app-server",
      sandbox: "read-only",
      contextMode: "fresh",
    });
    return { agent, threadId };
  }
  async function archive(project: ProjectTarget) {
    apply({ kind: "archive", projectId: project.id });
    await jobs.sweepProjectArchives();
    return settings.current.projects.find((p) => p.id === project.id)!;
  }
  function checkDb() {
    const db = new Database(file, { readonly: true });
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(
        db.prepare("SELECT rows,bytes FROM event_budget WHERE id=1").get(),
      ).toEqual(
        db
          .prepare(
            "SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM job_events",
          )
          .get(),
      );
    } finally {
      db.close();
    }
  }

  it("does not dispatch when the durable dispatch boundary cannot commit", async () => {
    const project = register();
    const original = state.upsertJob.bind(state);
    vi.spyOn(state, "upsertJob").mockImplementation((value) => {
      if ((value as { executionDispatched?: boolean }).executionDispatched)
        throw new Error("dispatch persistence unavailable");
      return original(value);
    });
    const run = vi.fn(async () => result("forbidden"));
    const job = jobs.start(input(project), run);
    await job.promise;
    expect(run).not.toHaveBeenCalled();
    expect(job.status).toBe("failed");
    expect(job.executionDispatched).toBe(false);
  });

  it("repeats registration/use/archive/delete/re-registration/use/delete for two full cycles and preserves files and conversations", async () => {
    const cwd = path.join(root, "project");
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "sentinel.txt"), "preserved");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        { cwd, encoding: "utf8" },
      );
    git("init", "--quiet", "--initial-branch=dev");
    git("add", "sentinel.txt");
    git(
      "-c",
      "user.name=Lifecycle fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    writeFileSync(path.join(cwd, "staged.txt"), "staged work");
    git("add", "staged.txt");
    writeFileSync(path.join(cwd, "untracked.txt"), "untracked work");
    writeFileSync(path.join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(cwd, "ignored.txt"), "ignored evidence");
    const gitHead = git("rev-parse", "HEAD");
    const gitStatus = git("status", "--porcelain=v1", "--untracked-files=all");
    const gitIndex = readFileSync(path.join(cwd, ".git", "index"));
    const original = path.join(root, "original-codex-conversation.jsonl");
    writeFileSync(original, "original conversation");
    const projectIds = new Set(),
      threadIds = new Set();
    for (let cycle = 0; cycle < 2; cycle++)
      for (let use = 0; use < 2; use++) {
        const project = register("Project", cwd);
        expect(projectIds.has(project.id)).toBe(false);
        projectIds.add(project.id);
        const retained = session(project);
        expect(threadIds.has(retained.threadId)).toBe(false);
        threadIds.add(retained.threadId);
        const admitted = input(project);
        const job = jobs.start(
          {
            ...admitted,
            threadId: retained.threadId,
            agentId: retained.agent.agentId,
            sessionDecision: {
              ...admitted.sessionDecision,
              threadId: retained.threadId,
            },
          },
          async () => result(retained.threadId),
        );
        await job.promise;
        expect(job.status).toBe("completed");
        const beforeArchive = state.getScopeVersion(scopeId);
        expect((await archive(project)).archiveState).toBe("complete");
        expect(state.getScopeVersion(scopeId)).toBeGreaterThan(beforeArchive);
        expect(sessions.get(retained.threadId)).toBeUndefined();
        expect(
          state.getAgent(retained.agent.agentId)?.currentThreadId,
        ).toBeUndefined();
        const beforeDelete = state.getScopeVersion(scopeId);
        apply({ kind: "delete", projectId: project.id });
        expect(state.getScopeVersion(scopeId)).toBeGreaterThan(beforeDelete);
        expect(jobs.get(job.jobId)).toBeUndefined();
        expect(settings.current.projects).toEqual([]);
        expect(() =>
          jobs.findRequest(scopeId, job.requestId, job.requestHash),
        ).toThrow("PROJECT_MANAGEMENT_ENDED");
        expect(
          state.getArchivedJobAdmissionReceipt(scopeId, {
            kind: "job",
            id: job.jobId,
          }),
        ).toMatchObject({ managementEnded: true, status: "completed" });
        apply({ kind: "delete", projectId: project.id });
        checkDb();
      }
    expect(readFileSync(path.join(cwd, "sentinel.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(git("rev-parse", "HEAD")).toBe(gitHead);
    expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe(
      gitStatus,
    );
    expect(readFileSync(path.join(cwd, ".git", "index"))).toEqual(gitIndex);
    expect(readFileSync(path.join(cwd, "staged.txt"), "utf8")).toBe(
      "staged work",
    );
    expect(readFileSync(path.join(cwd, "untracked.txt"), "utf8")).toBe(
      "untracked work",
    );
    expect(readFileSync(path.join(cwd, "ignored.txt"), "utf8")).toBe(
      "ignored evidence",
    );
    expect(readFileSync(original, "utf8")).toBe("original conversation");
  });
  it.each(["persistent", "ephemeral", "unknown"] as const)(
    "cleans idle %s context without making open work completed",
    async (persistence) => {
      const project = register();
      const retained = session(
        project,
        randomUUID(),
        randomUUID(),
        persistence,
      );
      const activity = state.createActivity({
        scopeId,
        projectId: project.id,
        projectName: project.name,
        projectCwd: project.cwd,
      });
      jobs.assignAgent({
        activityId: activity.activityId,
        agentId: retained.agent.agentId,
        contextMode: "fresh",
        role: "owner",
      });
      expect((await archive(project)).archiveState).toBe("complete");
      expect(state.getActivity(activity.activityId)?.lifecycle).toBe(
        "abandoned",
      );
      expect(state.listSessions()).toEqual([]);
      expect(state.threadConnections.get(retained.threadId)).toBeUndefined();
      checkDb();
    },
  );
  it("blocks fresh admission, continue/fork context, followup and automatic recovery immediately after intent acceptance", async () => {
    const project = register();
    const admitted = input(project);
    session(project);
    apply({ kind: "archive", projectId: project.id });
    expect(settings.current.projects[0]).toMatchObject({
      archiveState: "processing",
    });
    expect(settings.current.projects[0]?.archivedAt).toBeUndefined();
    expect(() =>
      state.resolveProjectSelection(
        {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision + 1,
        },
        [root],
      ),
    ).toThrow("archived");
    expect(() => jobs.start(admitted, async () => result("forbidden"))).toThrow(
      "PROJECT_ARCHIVED",
    );
    expect(() =>
      state.createActivity({
        scopeId,
        continuationOfActivityId: admitted.activityId,
      }),
    ).toThrow("PROJECT_ARCHIVED");
    expect(state.isEventProjectAvailable(project.id)).toBe(false);
    await jobs.sweepProjectArchives();
  });
  it("cancels worker-unassigned and execution-preparation Jobs before they can launch, including late activation", async () => {
    const project = register();
    const run = vi.fn(async () => result("late"));
    const job = jobs.start(
      input(project),
      run,
      undefined,
      30,
      false,
      undefined,
      true,
    );
    expect((await archive(project)).archiveState).toBe("complete");
    expect(job.status).toBe("cancelled");
    jobs.activateDeferredExecution(job.jobId);
    await job.promise;
    expect(run).not.toHaveBeenCalled();
    apply({ kind: "delete", projectId: project.id });
    register("Again", project.cwd);
    expect(run).not.toHaveBeenCalled();
  });
  it("retries an undispatched cancellation after a failed commit without losing the accepted Job", async () => {
    const project = register();
    const run = vi.fn(async () => result("forbidden"));
    const job = jobs.start(
      input(project),
      run,
      undefined,
      30,
      false,
      undefined,
      true,
    );
    const original = state.upsertJob.bind(state);
    const write = vi.spyOn(state, "upsertJob").mockImplementation((value) => {
      if (value.status === "cancelled")
        throw new Error("cancellation commit unavailable");
      return original(value);
    });
    expect((await archive(project)).archiveState).toBe("unresolved");
    expect(job.status).toBe("running");
    expect(run).not.toHaveBeenCalled();
    write.mockRestore();
    expect((await archive(project)).archiveState).toBe("complete");
    expect(job.status).toBe("cancelled");
    await job.promise;
    expect(run).not.toHaveBeenCalled();
    checkDb();
  });
  it("does not complete archive for dispatched work until its delayed worker ownership can be stopped", async () => {
    const project = register();
    let assign!: (a: UpstreamWorkerAssignment) => void;
    let finish!: (r: ToolResult) => void;
    const job = jobs.start(input(project), async (_progress, onAssigned) => {
      assign = onAssigned;
      return new Promise((resolve) => (finish = resolve));
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((await archive(project)).archiveState).toBe("unresolved");
    expect(job.status).toBe("running");
    expect(() => apply({ kind: "delete", projectId: project.id })).toThrow(
      "PROJECT_DELETE_REQUIRES_ARCHIVE",
    );
    assign({
      backendKind: "app-server",
      workerId: "worker",
      workerGeneration: 1,
      upstreamRequestId: "turn",
      threadId: "late-thread",
    });
    expect((await archive(project)).archiveState).toBe("complete");
    expect(job.status).toBe("cancelled");
    finish(result("late-thread"));
    await job.promise;
    apply({ kind: "delete", projectId: project.id });
    register("Again", project.cwd);
    assign({
      backendKind: "app-server",
      workerId: "worker",
      workerGeneration: 1,
      upstreamRequestId: "turn",
      threadId: "late-thread",
    });
    expect(state.listSessions()).toEqual([]);
    checkDb();
  });
  it("preserves the dispatch boundary across restart before worker assignment and resumes exact cleanup", async () => {
    let recoveredAssign!: (a: UpstreamWorkerAssignment) => void;
    Object.assign(upstream, {
      supportsExecutionRecovery: () => true,
      recoverExecution: async (
        _id: string,
        _progress: unknown,
        assigned: (a: UpstreamWorkerAssignment) => void,
      ) => {
        recoveredAssign = assigned;
        return new Promise(() => {});
      },
    });
    const project = register();
    const job = jobs.start(input(project), async () => new Promise(() => {}));
    await Promise.resolve();
    await Promise.resolve();
    expect((await archive(project)).archiveState).toBe("unresolved");
    await jobs.closeThreadConnections();
    state.close();
    state = new BridgeStateStore({ file });
    initialize();
    await jobs.sweepProjectArchives();
    expect(settings.current.projects[0]?.archiveState).toBe("unresolved");
    expect(jobs.get(job.jobId)?.executionDispatched).toBe(true);
    recoveredAssign({
      backendKind: "app-server",
      workerId: "recovered",
      workerGeneration: 1,
      threadId: "recovered-thread",
      upstreamRequestId: "recovered-turn",
    });
    expect((await archive(project)).archiveState).toBe("complete");
    expect(jobs.get(job.jobId)?.status).toBe("cancelled");
    checkDb();
  });
  it("keeps termination-failed unresolved, retries precise stop without killing a shared worker, and ignores late results/progress", async () => {
    const project = register();
    const other = register("Other", path.join(root, "other"));
    let progress!: (p: CodexProgress) => void;
    let finish!: (r: ToolResult) => void;
    const job = jobs.start(input(project), async (onProgress, assigned) => {
      progress = onProgress;
      assigned({
        backendKind: "app-server",
        workerId: "shared",
        workerGeneration: 1,
        threadId: "target-thread",
        upstreamRequestId: "target-turn",
      });
      return new Promise((resolve) => (finish = resolve));
    });
    const peer = jobs.start(input(other), async (_p, assigned) => {
      assigned({
        backendKind: "app-server",
        workerId: "shared",
        workerGeneration: 1,
        threadId: "peer-thread",
        upstreamRequestId: "peer-turn",
      });
      return new Promise(() => {});
    });
    await Promise.resolve();
    await Promise.resolve();
    stops.mockRejectedValueOnce(new Error("exact stop unconfirmed"));
    const unresolved = await archive(project);
    expect(unresolved.archiveState).toBe("unresolved");
    expect(unresolved.archivedAt).toBeUndefined();
    expect(job.status).toBe("termination-failed");
    expect(peer.status).toBe("running");
    expect((await archive(project)).archiveState).toBe("complete");
    expect(
      stops.mock.calls.every((call) => call[3]?.interruptOnly === true),
    ).toBe(true);
    expect(peer.status).toBe("running");
    apply({ kind: "delete", projectId: project.id });
    const replacement = register("Again", project.cwd);
    progress({ message: "late" } as CodexProgress);
    finish(result("target-thread"));
    await job.promise;
    expect(jobs.get(job.jobId)).toBeUndefined();
    expect(
      state.listSessions().some((s: any) => s.projectId === replacement.id),
    ).toBe(false);
    checkDb();
  });
  it("leaves unfinished cleanup restartable when the runtime closes during an exact stop", async () => {
    const project = register();
    const ownership = new Map<string, UpstreamWorkerAssignment>();
    upstream.supportsExecutionRecovery = () => true;
    upstream.recoverExecution = async (jobId, _progress, assigned) => {
      assigned(ownership.get(jobId)!);
      return new Promise(() => {});
    };
    for (const suffix of ["a", "b"]) {
      const job = jobs.start(input(project), async (_progress, assigned) => {
        const assignment: UpstreamWorkerAssignment = {
          backendKind: "app-server",
          workerId: `worker-${suffix}`,
          workerGeneration: 1,
          threadId: `thread-${suffix}`,
          upstreamRequestId: `turn-${suffix}`,
        };
        ownership.set(job.jobId, assignment);
        assigned(assignment);
        return new Promise(() => {});
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    let entered!: () => void, finishStop!: (value: unknown) => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    stops.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        finishStop = resolve;
      });
    });
    apply({ kind: "archive", projectId: project.id });
    const sweep = jobs.sweepProjectArchives();
    await stopping;
    const closing = jobs.closeThreadConnections();
    finishStop({
      exited: true,
      workerExited: false,
      mode: "turn-interrupt",
      escalated: false,
    });
    await Promise.all([sweep, closing]);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(settings.current.projects[0].archiveState).toBe("processing");
    expect(state.projectLifecycle.unfinished(project.id)).toBe(true);
    state.close();
    state = new BridgeStateStore({ file });
    initialize();
    await jobs.sweepProjectArchives();
    expect(settings.current.projects[0].archiveReasons).toEqual([]);
    expect(settings.current.projects[0].archiveState).toBe("complete");
    expect(state.projectLifecycle.unfinished(project.id)).toBe(false);
    checkDb();
  });
  it("stops loaded background terminals and confirms their absence before releasing idle threads", async () => {
    const project = register();
    session(project);
    let running = true;
    upstream.listLoadedBackgroundTerminals = vi.fn(async () =>
      running ? [{ processId: "process", command: "fixture" } as any] : [],
    );
    upstream.terminateBackgroundTerminal = vi.fn(async () => {
      running = false;
      return { terminated: true };
    });
    expect((await archive(project)).archiveState).toBe("complete");
    expect(upstream.terminateBackgroundTerminal).toHaveBeenCalledOnce();
    expect(running).toBe(false);
  });
  it("does not restore past thread selection and fences late session/thread/Job snapshots", async () => {
    const project = register();
    const retained = session(project);
    const admitted = input(project);
    const job = jobs.start(admitted, async () => result(retained.threadId));
    await job.promise;
    const stale = sessions.get(retained.threadId)!;
    await archive(project);
    apply({ kind: "restore", projectId: project.id });
    expect(state.listSessions()).toEqual([]);
    expect(() => sessions.record(stale)).toThrow("PROJECT_MANAGEMENT_ENDED");
    expect(() =>
      jobs.linkAgentThread({
        agentId: retained.agent.agentId,
        threadId: retained.threadId,
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        backendKind: "app-server",
        sandbox: "read-only",
        contextMode: "continue",
      }),
    ).toThrow("PROJECT_MANAGEMENT_ENDED");
    await archive(settings.current.projects[0]!);
    apply({ kind: "delete", projectId: project.id });
    state.upsertJob(job);
    state.threadConnections.register({
      threadId: retained.threadId,
      scopeId,
      persistence: "ephemeral",
    });
    expect(state.listJobs()).toEqual([]);
    expect(state.threadConnections.get(retained.threadId)).toBeUndefined();
    checkDb();
  });
  it("preserves unknown-hash compact admission facts and never guesses original content", async () => {
    const project = register();
    const job = jobs.start(input(project), async () => result("compact"));
    await job.promise;
    state.deleteJob(job.jobId);
    await archive(project);
    apply({ kind: "delete", projectId: project.id });
    expect(
      state.projectLifecycle.receipt("task", scopeId, job.requestId)
        ?.request_hash,
    ).toBeNull();
    expect(() =>
      jobs.findRequest(scopeId, job.requestId, "b".repeat(64)),
    ).toThrow("original content cannot be compared");
    checkDb();
  });
  it("resumes unresolved cleanup across two restarts and rejects stale CAS completion after retry", async () => {
    const project = register();
    session(project);
    releases.mockResolvedValueOnce({
      phase: "blocked",
      reason: "worker-unconfirmed",
    });
    expect((await archive(project)).archiveState).toBe("unresolved");
    const first = state.projectLifecycle.pending()[0]!;
    apply({ kind: "archive", projectId: project.id });
    expect(
      state.transaction(() =>
        state.projectLifecycle.complete(project.id, first.revision),
      ),
    ).toBe(false);
    await jobs.closeThreadConnections();
    state.close();
    state = new BridgeStateStore({ file });
    initialize();
    await jobs.sweepProjectArchives();
    expect(settings.current.projects[0]?.archiveState).toBe("complete");
    await jobs.closeThreadConnections();
    state.close();
    state = new BridgeStateStore({ file });
    initialize();
    await jobs.sweepProjectArchives();
    apply({ kind: "delete", projectId: project.id });
    register("Again", project.cwd);
    checkDb();
  });
  it("cleans indirect control/event/followup/command records without fabricating delivery", async () => {
    const project = register();
    const owner = session(project);
    const job = jobs.start(
      {
        ...input(project),
        agentId: owner.agent.agentId,
        approvedFollowups: [{ promptSha256: "d".repeat(64) }],
      },
      async () => result("controls"),
    );
    await job.promise;
    state.setMeta(
      "fixture/event",
      JSON.stringify({
        jobId: job.jobId,
        projectId: project.id,
        delivery: "pending",
      }),
    );
    state.setMeta(`fixture/${job.jobId}`, "123");
    const requestId = randomUUID();
    state.questions.beginDelivery(
      scopeId,
      requestId,
      "f".repeat(64),
      "e".repeat(64),
      job.jobId,
    );
    state.beginSteeringDelivery({
      scopeId,
      requestId: randomUUID(),
      actionHash: "c".repeat(64),
      jobId: job.jobId,
      expectedJobVersion: job.version,
      promptSha256: "d".repeat(64),
    });
    await archive(project);
    apply({ kind: "delete", projectId: project.id });
    expect(state.getMeta("fixture/event")).toBeUndefined();
    expect(
      state.projectLifecycle.receipt("question", scopeId, requestId)?.outcome,
    ).toBe("dispatching");
    expect(state.getMeta(`fixture/${job.jobId}`)).toBeUndefined();
    state.setMeta("fixture/late", JSON.stringify({ jobId: job.jobId }));
    state.setMeta(`fixture/${job.jobId}`, "456");
    expect(state.getMeta("fixture/late")).toBeUndefined();
    expect(state.getMeta(`fixture/${job.jobId}`)).toBeUndefined();
    expect(() =>
      state.recordAgentMutation(scopeId, randomUUID(), "a".repeat(64), {
        jobId: job.jobId,
      }),
    ).toThrow("PROJECT_MANAGEMENT_ENDED");
    expect(() =>
      state.projectLifecycle.assertRequest(
        "question",
        scopeId,
        requestId,
        "e".repeat(64),
      ),
    ).toThrow("PROJECT_MANAGEMENT_ENDED");
    checkDb();
  });
  it.each([false, true])(
    "migrates legacy archived/deleted=%s data and cleans it through two restarts without DB editing by users",
    async (deleted) => {
      const project = register();
      const retained = session(project);
      const job = jobs.start(input(project), async () =>
        result(retained.threadId),
      );
      await job.promise;
      await jobs.closeThreadConnections();
      state.close();
      const legacy = new Database(file);
      removeSchema31ForFixture(legacy);
      legacy
        .prepare(
          "UPDATE projects SET archived_at=10,deleted_at=? WHERE project_id=?",
        )
        .run(deleted ? 11 : null, project.id);
      legacy
        .prepare("UPDATE bridge_meta SET value='30' WHERE key='schema_version'")
        .run();
      legacy.close();
      state = new BridgeStateStore({ file });
      initialize();
      await jobs.sweepProjectArchives();
      if (!deleted) {
        expect(settings.current.projects[0]?.archiveState).toBe("complete");
        apply({ kind: "delete", projectId: project.id });
      }
      expect(state.projectLifecycle.exists(project.id)).toBe(false);
      await jobs.closeThreadConnections();
      state.close();
      state = new BridgeStateStore({ file });
      initialize();
      await jobs.sweepProjectArchives();
      register("New identity", project.cwd);
      expect(state.listSessions()).toEqual([]);
      expect(
        state.projectLifecycle.receipt("task", scopeId, job.requestId),
      ).toBeDefined();
      checkDb();
    },
  );
  it("does not clear a shared Agent current thread replaced by another project during release", async () => {
    const project = register(),
      other = register("Other", path.join(root, "other")),
      retained = session(project);
    releases.mockImplementationOnce(async () => {
      sessions.record({
        threadId: "replacement-thread",
        scopeId,
        backendKind: "app-server",
        projectId: other.id,
        projectName: other.name,
        cwd: other.cwd,
        sandbox: "read-only",
        persistence: "persistent",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      });
      jobs.linkAgentThread({
        agentId: retained.agent.agentId,
        threadId: "replacement-thread",
        projectId: other.id,
        projectName: other.name,
        cwd: other.cwd,
        backendKind: "app-server",
        sandbox: "read-only",
        contextMode: "fresh",
      });
      return { phase: "released", evidence: "thread-unloaded" };
    });
    expect((await archive(project)).archiveState).toBe("complete");
    expect(state.getAgent(retained.agent.agentId)?.currentThreadId).toBe(
      "replacement-thread",
    );
    apply({ kind: "delete", projectId: project.id });
    expect(sessions.get("replacement-thread")?.projectId).toBe(other.id);
    checkDb();
  });
  it.each(["user-input", "command-execution-approval"])(
    "terminates %s waiting work and preserves its cancelled outcome",
    async (kind) => {
      const project = register();
      const job = jobs.start(input(project), async (_progress, assigned) => {
        assigned({
          backendKind: "app-server",
          workerId: "waiting",
          workerGeneration: 1,
          threadId: "waiting-thread",
          upstreamRequestId: "waiting-turn",
        });
        return new Promise(() => {});
      });
      await Promise.resolve();
      await Promise.resolve();
      job.pendingInteractions = [
        {
          interactionId: "waiting:1:input",
          kind,
          threadId: "waiting-thread",
          turnId: "waiting-turn",
          isBlocking: true,
        } as any,
      ];
      state.upsertJob(job);
      expect((await archive(project)).archiveState).toBe("complete");
      expect(job.status).toBe("cancelled");
      expect(job.pendingInteractions).toEqual([]);
      checkDb();
    },
  );
});
