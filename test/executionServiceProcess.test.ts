import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildProcessCodexExecutionService,
  type CodexExecutionRequestLimits,
  type ExecutorExitReason,
  type WorkerObservationIncident
} from "../src/executionServiceProcess.js";
import type { CodexPendingInteraction, UpstreamWorkerAssignment } from "../src/upstream.js";
import { readProcessTable } from "../src/processTreeSupervisor.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-app-server.mjs"
);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("isolated Codex execution process", () => {
  it("runs turns, progress, account reads, and steering outside the state owner", async () => {
    const service = await createService();
    let assignment: UpstreamWorkerAssignment | undefined;
    const progress: unknown[] = [];
    try {
      expect(service.processId).toEqual(expect.any(Number));
      expect(service.processId).not.toBe(process.pid);
      expect(service.health()).toMatchObject({ status: "ready", inFlight: 0 });
      await expect(service.readAccountRateLimits()).resolves.toMatchObject({
        limitId: "codex",
        windowDurationMins: 10_080
      });

      const running = service.callTool(
        "codex",
        task("hold for steering"),
        value => progress.push(value),
        value => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.threadId));
      expect(service.canSteerThread(assignment!.threadId!)).toBe(true);
      await expect(service.steerThread(assignment!.threadId!, "isolated direction"))
        .resolves.toMatchObject({ turnId: assignment!.upstreamRequestId });
      await expect(running).resolves.toMatchObject({
        content: [{ text: "STEERED:isolated direction" }],
        structuredContent: {
          threadId: assignment!.threadId,
          turnStatus: "completed"
        }
      });
      expect(progress.length).toBeGreaterThan(0);
      expect(service.canSteerThread(assignment!.threadId!)).toBe(false);
      expect(service.canResumeThread(assignment!.threadId!)).toBe(true);
    } finally {
      await service.close();
    }
  }, 20_000);

  it("retains a running executor across a parent wall-clock jump", async () => {
    const service = await createService();
    let assignment: UpstreamWorkerAssignment | undefined;
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now");
    try {
      const running = service.callTool(
        "codex",
        task("hold for steering"),
        undefined,
        value => { assignment = value; }
      );
      await eventually(() => Boolean(assignment?.threadId));
      const executorPid = service.processId;
      clock.mockImplementation(() => realNow() + 30_000);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      clock.mockRestore();
      await eventually(() => service.health().status === "ready");
      expect(service.processId).toBe(executorPid);
      await expect(service.steerThread(assignment!.threadId!, "resume after pause"))
        .resolves.toMatchObject({ turnId: assignment!.upstreamRequestId });
      await expect(running).resolves.toMatchObject({
        content: [{ text: "STEERED:resume after pause" }]
      });
    } finally {
      clock.mockRestore();
      await service.close();
    }
  }, 20_000);

  it("keeps private interaction input in the execution process proxy only", async () => {
    const service = await createService();
    let interaction: CodexPendingInteraction | undefined;
    try {
      const running = service.callTool("codex", task("elicitation form"), value => {
        const candidate = value.event?.details?.interaction as CodexPendingInteraction | undefined;
        if (candidate?.interactionId) interaction = candidate;
      });
      await eventually(() => Boolean(interaction));
      expect(service.interactionInput(interaction!.interactionId)).toHaveProperty("requestedSchema");
      await service.respondToInteraction(interaction!.interactionId, {
        elicitation: {
          action: "accept",
          content: { color: "blue", count: 2, enabled: false, tags: ["b"] }
        }
      });
      await expect(running).resolves.toMatchObject({ content: [{ text: "ELICITATION COMPLETE" }] });
      expect(service.interactionInput(interaction!.interactionId)).toBeUndefined();
    } finally {
      await service.close();
    }
  }, 20_000);

  it("reserves request slots for interaction responses and forced termination", async () => {
    const service = await createService({}, {
      maxPendingRequests: 3,
      controlRequestReserve: 1,
      maxBytesInFlight: 1024 * 1024,
      controlRequestBytesReserve: 256 * 1024
    });
    let interaction: CodexPendingInteraction | undefined;
    let firstAssignment: UpstreamWorkerAssignment | undefined;
    const interactionTurn = service.callTool("codex", task("elicitation form"), value => {
      const candidate = value.event?.details?.interaction as CodexPendingInteraction | undefined;
      if (candidate?.interactionId) interaction = candidate;
    });
    const firstHold = service.callTool(
      "codex",
      task("hold first saturated turn"),
      undefined,
      value => { firstAssignment = value; }
    );
    const firstHoldSettled = firstHold.catch(error => error);
    let secondHoldSettled: Promise<unknown> | undefined;
    try {
      await eventually(() => Boolean(interaction && firstAssignment));
      expect(service.health()).toMatchObject({
        status: "capacity",
        inFlight: 2,
        ordinaryInFlight: 2,
        ordinaryCapacity: 2
      });
      await expect(service.callTool("codex", task("must be rejected at ordinary capacity")))
        .rejects.toThrow(/EXECUTION_CAPACITY/);
      await expect(service.respondToInteraction(interaction!.interactionId, {
        elicitation: {
          action: "accept",
          content: { color: "blue", count: 2, enabled: false, tags: ["b"] }
        }
      })).resolves.toBeNull();
      await expect(interactionTurn).resolves.toMatchObject({
        content: [{ text: "ELICITATION COMPLETE" }]
      });

      const secondHold = service.callTool("codex", task("hold second saturated turn"));
      secondHoldSettled = secondHold.catch(error => error);
      await eventually(() => service.health().status === "capacity");
      await expect(service.forceTerminateWorker(firstAssignment!, {
        kind: "cancellation-intent",
        intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source: "operator",
        reasonCode: "saturated-control-reserve"
      })).resolves.toMatchObject({ mode: "turn-interrupt" });
      await firstHoldSettled;
    } finally {
      await service.close();
      await firstHoldSettled;
      await secondHoldSettled;
    }
  }, 20_000);

  it("reserves byte capacity for steering an existing turn", async () => {
    const service = await createService({}, {
      maxPendingRequests: 10,
      controlRequestReserve: 2,
      maxBytesInFlight: 30 * 1024,
      controlRequestBytesReserve: 10 * 1024
    });
    let firstAssignment: UpstreamWorkerAssignment | undefined;
    const largePrompt = `hold ${"x".repeat(9_000)}`;
    const first = service.callTool(
      "codex",
      task(largePrompt),
      undefined,
      value => { firstAssignment = value; }
    );
    const firstSettled = first.then(
      value => ({ value }),
      error => ({ error })
    );
    const second = service.callTool("codex", task(largePrompt));
    const secondSettled = second.catch(error => error);
    try {
      await eventually(() => Boolean(firstAssignment) && service.health().inFlight === 2);
      expect(service.health().ordinaryBytesInFlight).toBeGreaterThan(18_000);
      await expect(service.callTool(
        "codex",
        task(`ordinary byte overflow ${"x".repeat(3_000)}`)
      ))
        .rejects.toThrow(/EXECUTION_CAPACITY/);
      await expect(service.steerThread(firstAssignment!.threadId!, "reserved byte control"))
        .resolves.toMatchObject({ turnId: firstAssignment!.upstreamRequestId });
      await expect(firstSettled).resolves.toMatchObject({
        value: { content: [{ text: "STEERED:reserved byte control" }] }
      });
    } finally {
      await service.close();
      await secondSettled;
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "retains an exited App Server until its same-group command is gone",
    async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-root-exit-"));
    roots.push(root);
    const observation = path.join(root, "descendants.jsonl");
    const exitGate = path.join(root, "exit-app-server");
    const service = await createService({
      CODEX_TEST_DESCENDANT_OBSERVATION: observation,
      CODEX_TEST_APP_SERVER_EXIT_GATE: exitGate
    });
    try {
      const executorPid = service.processId;
      const interrupted = service.callTool(
        "codex",
        task("execution descendant hold app server exits first")
      );
      await eventually(() => readDescendantObservations(observation).length === 1 &&
        (service.health().supervisedProcesses || 0) >= 2);
      const [{ appServerPid, childPid }] = readDescendantObservations(observation);
      expect(isProcessAlive(appServerPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);
      expect(processGroupId(childPid)).toBe(processGroupId(appServerPid));
      await writeFile(exitGate, "exit\n");
      await expect(interrupted).rejects.toThrow(/CODEX_WORKER_LOST/);
      expect(service.health().status).toBe("recovering");
      await expect(service.callTool("codex", task("blocked during App Server cleanup")))
        .rejects.toThrow(/EXECUTION_UNAVAILABLE/);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(isProcessAlive(appServerPid)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(true);

      await eventually(() => !isProcessAlive(childPid), 10_000);
      await eventually(() => service.health().status === "ready");
      await expect(service.callTool("codex", task("after App Server cleanup"))).resolves.toMatchObject({
        structuredContent: { turnStatus: "completed" }
      });
      expect(service.processId).toBe(executorPid);
      expect(service.health()).toMatchObject({
        status: "ready",
        supervisedWorkers: 1,
        supervisedProcesses: 1
      });
    } finally {
      await service.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "kills a detached descendant group before replacing a crashed executor",
    async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-descendant-"));
    roots.push(root);
    const observation = path.join(root, "descendants.jsonl");
    const service = await createService({
      CODEX_TEST_DESCENDANT_OBSERVATION: observation
    });
    try {
      const first = service.processId;
      const interrupted = service.callTool(
        "codex",
        task("execution descendant hold detached ignore descendant term")
      );
      await eventually(() => readDescendantObservations(observation).length === 1 &&
        (service.health().supervisedProcesses || 0) >= 2);
      const [{ appServerPid, childPid, detached }] = readDescendantObservations(observation);
      expect(detached).toBe(true);
      expect(isProcessAlive(appServerPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);
      expect(processGroupId(childPid)).toBe(childPid);
      expect(processGroupId(childPid)).not.toBe(processGroupId(appServerPid));
      expect(service.terminate("SIGKILL")).toBe(true);
      await expect(interrupted).rejects.toThrow(/CODEX_WORKER_LOST/);
      await eventually(() => !isProcessAlive(appServerPid) && !isProcessAlive(childPid), 10_000);
      await eventually(() => service.processId !== undefined && service.processId !== first &&
        service.health().status === "ready", 10_000);
      expect(readDescendantObservations(observation)).toHaveLength(1);
      await expect(service.callTool("codex", task("after execution restart")))
        .resolves.toMatchObject({ structuredContent: { turnStatus: "completed" } });
    } finally {
      await service.close();
    }
  }, 30_000);

  it("rechecks authoritative release eligibility across the process boundary", async () => {
    const service = await createService({ CODEX_TEST_UNSUBSCRIBE_UNLOAD: "1" });
    let assignment: UpstreamWorkerAssignment | undefined;
    let checks = 0;
    try {
      await service.callTool(
        "codex",
        task("release after completion"),
        undefined,
        value => { assignment = value; }
      );
      expect(assignment?.threadId).toBeTypeOf("string");
      await expect(service.releaseThreadConnection(assignment!.threadId!, {
        canRelease: threadId => {
          checks += 1;
          return threadId === assignment!.threadId;
        },
        eligibleThreadIds: [assignment!.threadId!],
        previousWorkerPid: assignment!.workerPid
      })).resolves.toMatchObject({ phase: "released", evidence: "thread-unloaded" });
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(service.canResumeThread(assignment!.threadId!)).toBe(false);
    } finally {
      await service.close();
    }
  }, 20_000);

  it("does not grant the execution process Bridge database or listener authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-environment-"));
    roots.push(root);
    const observation = path.join(root, "environment.json");
    const service = await createService({
      CODEX_TEST_APP_SERVER_ENV_OBSERVATION: observation,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_ENV_FILE: path.join(root, "bridge.env"),
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_TOKEN: "must-not-cross-execution-boundary"
    });
    try {
      await service.readAccountSnapshot();
      const environment = JSON.parse(await readFile(observation, "utf8")) as {
        stateDatabaseFile: string | null;
        telemetryDatabaseFile: string | null;
        bridgeToken: string | null;
        runtimeHome: string | null;
        environmentFile: string | null;
        allowedRoots: string | null;
        codexHome: string | null;
      };
      expect(environment).toMatchObject({
        stateDatabaseFile: null,
        telemetryDatabaseFile: null,
        bridgeToken: null,
        runtimeHome: null,
        environmentFile: null,
        allowedRoots: null,
        codexHome: expect.any(String)
      });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("continues Codex work while the state-owner event loop is blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "execution-owner-stall-"));
    roots.push(root);
    const completionLog = path.join(root, "completion.log");
    const service = await createService({
      CODEX_TEST_TURN_COMPLETION_LOG: completionLog
    });
    try {
      let assigned = false;
      const running = service.callTool(
        "codex",
        task("delayed isolated completion"),
        undefined,
        () => { assigned = true; }
      );
      const runningSettled = running.then(
        value => ({ value }),
        error => ({ error })
      );
      await eventually(() => assigned);
      const blockedAt = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const resumedAt = Date.now();
      const completedAt = Number((await readFile(completionLog, "utf8")).trim());
      expect(completedAt).toBeGreaterThanOrEqual(blockedAt);
      expect(completedAt).toBeLessThan(resumedAt);
      await expect(runningSettled).resolves.toMatchObject({
        value: {
          content: [{ text: "ISOLATED COMPLETION" }],
          structuredContent: { turnStatus: "completed" }
        }
      });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("keeps two in-flight Jobs across a 1.1 second synchronous SQLite pause", async () => {
    const service = await createService();
    const assignments: UpstreamWorkerAssignment[] = [];
    const running = [1, 2].map(index => service.callTool(
      "codex", task(`hold for steering ${index}`), undefined,
      assignment => { assignments.push(assignment); }
    ));
    const settled = running.map(turn => turn.catch(error => error));
    try {
      await eventually(() => assignments.length > 0 && service.health().inFlight === 2);
      const executorPid = service.processId;
      const database = new Database(":memory:");
      try {
        database.function("pause_for_test", () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
          return 1;
        });
        database.prepare("SELECT pause_for_test()").get();
      } finally {
        database.close();
      }
      await eventually(() => service.health().status === "ready");
      expect(service.processId).toBe(executorPid);
      for (let index = 0; index < 2; index += 1) {
        await eventually(() => assignments.length > index);
        await service.steerThread(assignments[index].threadId!, `resume ${index}`);
      }
      const results = await Promise.all(running);
      expect(results.map(result => result.structuredContent?.turnStatus))
        .toEqual(["completed", "completed"]);
    } finally {
      await service.close();
      await Promise.all(settled);
    }
  }, 25_000);

  it.skipIf(process.platform === "win32")(
    "retains an active turn after the executor event loop resumes",
    async () => {
      const service = await createService();
      let assignment: UpstreamWorkerAssignment | undefined;
      const running = service.callTool(
        "codex", task("hold for steering executor pause"), undefined,
        value => { assignment = value; }
      );
      try {
        await eventually(() => Boolean(assignment));
        const executorPid = service.processId!;
        process.kill(executorPid, "SIGSTOP");
        try {
          await new Promise(resolve => setTimeout(resolve, 4_000));
        } finally {
          process.kill(executorPid, "SIGCONT");
        }
        await eventually(() => service.health().status === "ready");
        expect(service.processId).toBe(executorPid);
        await service.steerThread(assignment!.threadId!, "after executor pause");
        await expect(running).resolves.toMatchObject({
          content: [{ text: "STEERED:after executor pause" }]
        });
      } finally {
        await service.close();
        await Promise.allSettled([running]);
      }
    }, 25_000);

  it("fences admission during one failed parent observation and retains active turns", async () => {
    const incidents: WorkerObservationIncident[] = [];
    const service = await createService({}, undefined,
      incident => incidents.push(incident));
    let assignment: UpstreamWorkerAssignment | undefined;
    const running = service.callTool(
      "codex", task("hold for steering observation retry"), undefined,
      value => { assignment = value; }
    );
    try {
      await eventually(() => Boolean(assignment));
      const executorPid = service.processId;
      const registry = (service as unknown as {
        workerProcesses: { refresh(): Promise<void> };
        observeWorkerProcesses(): void;
      }).workerProcesses;
      const originalRefresh = registry.refresh.bind(registry);
      const timeoutError = await timedOutProbeError();
      const spy = vi.spyOn(registry, "refresh")
        .mockRejectedValueOnce(timeoutError)
        .mockImplementation(() => originalRefresh());
      (service as unknown as { observeWorkerProcesses(): void }).observeWorkerProcesses();
      await eventually(() => service.health().status === "recovering");
      await expect(service.callTool("codex", task("admission fenced")))
        .rejects.toThrow(/EXECUTION_UNAVAILABLE/);
      await eventually(() => service.health().status === "ready");
      spy.mockRestore();
      expect(service.processId).toBe(executorPid);
      expect(incidents).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: "parent", phase: "refresh", state: "degraded",
          failure: expect.objectContaining({ kind: "ps-timeout" }) }),
        expect.objectContaining({ side: "parent", phase: "refresh", state: "recovered" })
      ]));
      await service.steerThread(assignment!.threadId!, "after observation retry");
      await expect(running).resolves.toMatchObject({
        content: [{ text: "STEERED:after observation retry" }]
      });
      const later = service.callTool("codex", task("hold for steering after recovery"));
      await eventually(() => service.health().inFlight === 1);
      process.kill(executorPid!, "SIGKILL");
      const laterError = await later.catch(error => error);
      expect(String(laterError)).toContain("CODEX_WORKER_LOST");
      expect(String(laterError)).toContain("exit_intent=unconfirmed");
      expect(String(laterError)).not.toContain("first_observation=");
    } finally {
      await service.close();
      await Promise.allSettled([running]);
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "keeps active turns when repeated parent probes fail and resumes after recovery",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "execution-observation-failure-"));
      roots.push(root);
      const observation = path.join(root, "descendants.jsonl");
      const incidents: WorkerObservationIncident[] = [];
      const service = await createService({
        CODEX_TEST_DESCENDANT_OBSERVATION: observation
      }, undefined, incident => incidents.push(incident));
      let assignment: UpstreamWorkerAssignment | undefined;
      let appServerPid = 0;
      let childPid = 0;
      const running = service.callTool(
        "codex", task("execution descendant hold detached ignore descendant term"),
        undefined, value => { assignment = value; }
      );
      try {
        await eventually(() => Boolean(assignment) &&
          readDescendantObservations(observation).length === 1 &&
          (service.health().supervisedProcesses || 0) >= 2);
        const firstPid = service.processId;
        [{ appServerPid, childPid }] = readDescendantObservations(observation);
        const registry = (service as unknown as {
          workerProcesses: { refresh(): Promise<void> };
          observeWorkerProcesses(): void;
        }).workerProcesses;
        const timeoutError = await timedOutProbeError();
        const originalRefresh = registry.refresh.bind(registry);
        const spy = vi.spyOn(registry, "refresh")
          .mockRejectedValue(timeoutError);
        (service as unknown as { observeWorkerProcesses(): void }).observeWorkerProcesses();
        await eventually(() => service.health().status === "recovering" &&
          incidents.some(incident => incident.state === "failed"));
        await expect(service.callTool("codex", task("admission fenced during blind probe")))
          .rejects.toThrow(/EXECUTION_UNAVAILABLE/);
        expect(service.processId).toBe(firstPid);
        expect(isProcessAlive(appServerPid)).toBe(true);
        expect(isProcessAlive(childPid)).toBe(true);
        await service.steerThread(assignment!.threadId!, "continue during observer outage");
        await expect(running).resolves.toMatchObject({
          content: [{ text: "STEERED:continue during observer outage" }]
        });
        spy.mockImplementation(() => originalRefresh());
        await eventually(() => service.health().status === "ready", 10_000);
        spy.mockRestore();
        expect(service.processId).toBe(firstPid);
        expect(incidents.filter(incident => incident.state === "failed")).toHaveLength(1);
        await expect(service.callTool("codex", task("after observation failure recovery")))
          .resolves.toMatchObject({ structuredContent: { turnStatus: "completed" } });
      } finally {
        await service.close();
        await Promise.allSettled([running]);
      }
      await eventually(() => !isProcessAlive(appServerPid) && !isProcessAlive(childPid), 10_000);
    }, 30_000);

  it("waits for verified worker cleanup after a transient process-table failure", async () => {
    const incidents: WorkerObservationIncident[] = [];
    const service = await createService({}, undefined, incident => incidents.push(incident));
    try {
      const executorPid = service.processId;
      const registry = (service as unknown as {
        workerProcesses: {
          release(identity: { pid: number; processGroupId: number | null }, graceMs: number):
            Promise<boolean>;
        };
      }).workerProcesses;
      const originalRelease = registry.release.bind(registry);
      const timeoutError = await timedOutProbeError();
      const spy = vi.spyOn(registry, "release")
        .mockRejectedValueOnce(timeoutError)
        .mockImplementation((identity, graceMs) => originalRelease(identity, graceMs));
      const release = (service as unknown as {
        releaseWorkerProcess(message: {
          type: "worker-exited";
          generation: string;
          cleanupId: string;
          identity: { pid: number; processGroupId: number | null };
        }): Promise<void>;
      }).releaseWorkerProcess.bind(service);
      const pending = release({
        type: "worker-exited",
        generation: service.health().generation!,
        cleanupId: "transient-cleanup-test",
        identity: { pid: 999_999, processGroupId: 999_999 }
      });
      await eventually(() => service.health().status === "recovering");
      await pending;
      spy.mockRestore();
      expect(service.processId).toBe(executorPid);
      expect(service.health().status).toBe("ready");
      expect(incidents).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: "parent", phase: "cleanup", state: "degraded" }),
        expect.objectContaining({ side: "parent", phase: "cleanup", state: "recovered" })
      ]));
    } finally {
      await service.close();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "reports an unverified cleanup before an executor exit affects another active turn",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "execution-cleanup-intent-"));
      roots.push(root);
      const observation = path.join(root, "descendants.jsonl");
      const exitGate = path.join(root, "exit-app-server");
      const exitReasons: ExecutorExitReason[] = [];
      const service = await createService({
        CODEX_TEST_DESCENDANT_OBSERVATION: observation,
        CODEX_TEST_APP_SERVER_EXIT_GATE: exitGate
      }, undefined, undefined, 2, reason => exitReasons.push(reason));
      let retainedAssignment: UpstreamWorkerAssignment | undefined;
      const retained = service.callTool("codex", task("hold for steering"), undefined,
        value => { retainedAssignment = value; });
      let exiting: Promise<unknown> | undefined;
      let descendantPid = 0;
      try {
        await eventually(() => Boolean(retainedAssignment));
        exiting = service.callTool("codex", task("execution descendant hold app server exits first"));
        void exiting.catch(() => undefined);
        await eventually(() => readDescendantObservations(observation).length === 1 &&
          service.health().supervisedWorkers === 2);
        descendantPid = readDescendantObservations(observation)[0]!.childPid;
        const registry = (service as unknown as {
          workerProcesses: {
            release(identity: { pid: number; processGroupId: number | null }, graceMs: number):
              Promise<boolean>;
          };
        }).workerProcesses;
        const originalRelease = registry.release.bind(registry);
        const spy = vi.spyOn(registry, "release")
          .mockResolvedValueOnce(false)
          .mockImplementation((identity, graceMs) => originalRelease(identity, graceMs));
        await writeFile(exitGate, "exit\n");
        const retainedError = await retained.catch(error => error);
        spy.mockRestore();
        expect(String(retainedError)).toContain("CODEX_WORKER_LOST");
        expect(String(retainedError)).toContain("exit_intent=worker-cleanup-unconfirmed");
        expect(exitReasons).toContain("worker-cleanup-unconfirmed");
        await eventually(() => !isProcessAlive(descendantPid), 10_000);
      } finally {
        await service.close();
        await Promise.allSettled([retained, ...(exiting ? [exiting] : [])]);
      }
    }, 30_000);

  it("bounds executor progress IPC while the state owner cannot receive messages", async () => {
    const service = await createService();
    const progress: unknown[] = [];
    try {
      const running = service.callTool(
        "codex",
        task("execution progress flood"),
        value => progress.push(value)
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      await expect(running).resolves.toMatchObject({
        content: [{ text: "EXECUTION PROGRESS FLOOD COMPLETE" }],
        structuredContent: { turnStatus: "completed" }
      });
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.length).toBeLessThan(100);
    } finally {
      await service.close();
    }
  }, 20_000);
});

async function createService(
  extraEnvironment: NodeJS.ProcessEnv = {},
  requestLimits?: Partial<CodexExecutionRequestLimits>,
  onObservationIncident?: (incident: WorkerObservationIncident) => void,
  poolSize = 1,
  onExitIntent?: (reason: ExecutorExitReason) => void
): Promise<ChildProcessCodexExecutionService> {
  const home = await mkdtemp(path.join(tmpdir(), "execution-service-"));
  roots.push(home);
  return ChildProcessCodexExecutionService.start({
    command: fixture,
    poolSize,
    environment: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      ...extraEnvironment
    },
    ...(requestLimits ? { requestLimits } : {}),
    ...(onObservationIncident ? { onObservationIncident } : {}),
    ...(onExitIntent ? { onExitIntent } : {})
  });
}

function readDescendantObservations(file: string): Array<{
  appServerPid: number;
  childPid: number;
  detached?: boolean;
}> {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const value = JSON.parse(line) as {
        appServerPid: number;
        childPid: number;
        detached?: boolean;
      };
      return value;
    });
  } catch {
    return [];
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processGroupId(processId: number): number {
  return Number(execFileSync(
    "/bin/ps",
    ["-o", "pgid=", "-p", String(processId)],
    { encoding: "utf8" }
  ).trim());
}

function task(prompt: string): Record<string, unknown> {
  return {
    prompt,
    cwd: process.cwd(),
    sandbox: "read-only",
    "approval-policy": "on-request"
  };
}

async function timedOutProbeError(): Promise<Error> {
  const probe = spawn("/bin/sleep", ["6"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(probe, "close");
  const error = await readProcessTable(() => probe).catch(error => error);
  await closed;
  return error as Error;
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
