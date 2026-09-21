import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { startBridgeCompanionServer } from "../src/companionServer.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot,
  ModelCatalogOptions
} from "../src/modelCatalog.js";
import { createHttpServer } from "../src/server.js";
import type { OperationalStateHealth } from "../src/stateService.js";
import {
  ChildProcessOperationalStateService,
  OperationalStateProcessError
} from "../src/stateServiceProcess.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

type SqliteFaultMode = "in-process-current" | "isolated-prototype";

type FixtureMessage =
  | {
      type: "ready";
      port: number;
      socketPath: string;
      stateFile: string;
      isolatedStateFile: string;
      isolatedStateProcessId?: number;
      isolatedStateHealth: OperationalStateHealth;
    }
  | { type: "operation-started"; scenarioId: string; at: number }
  | {
      type: "operation-finished";
      scenarioId: string;
      startedAt: number;
      finishedAt: number;
      durationMs: number;
      outcome: "committed" | "completed" | "failed";
      errorCode?: string;
      error: string | null;
    }
  | {
      type: "timer-fired";
      scenarioId: string;
      scheduledAt: number;
      firedAt: number;
      delayMs: number;
    }
  | {
      type: "state-health";
      scenarioId: string;
      health: OperationalStateHealth;
    }
  | { type: "closed" };

type FixtureCommand =
  | {
      type: "run-sqlite-fault";
      scenarioId: string;
      mode: SqliteFaultMode;
      healthSnapshotAfterMs?: number;
    }
  | { type: "run-cpu-fault"; scenarioId: string; blockMs: number }
  | { type: "close" };

type ReadyMessage = Extract<FixtureMessage, { type: "ready" }>;

const CHILD_FLAG = "--fixture-child";
const SQLITE_LOCK_HOLDS_MS = [50, 250, 1_000, 3_200] as const;
const CPU_BLOCK_MS = 350;
const HEALTH_TARGET_MS = 200;
const EVENT_LOOP_TARGET_MS = 50;
const RUNTIME_HEALTH_TIMEOUT_MS = 2_000;

async function runCharacterization(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-143-reliability-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG, root],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  let childOutput = "";
  child.stdout?.on("data", chunk => { childOutput += chunk; });
  child.stderr?.on("data", chunk => { childOutput += chunk; });
  let report: Record<string, unknown> | undefined;

  try {
    const ready = await waitForMessage(child, "ready", 15_000);
    const baselineHttp = await probeHttp(ready.port, 2_000);
    const baselineCompanion = await companionRequest(ready.socketPath, "runtime.health", 2_000);
    assert.equal(baselineHttp.statusCode, 200);
    assert.equal(baselineCompanion.ok, true);

    const inProcessSqlite = [];
    const isolatedSqlite = [];
    for (const lockHoldMs of SQLITE_LOCK_HOLDS_MS) {
      inProcessSqlite.push(await runSqliteFaultCase(child, ready, "in-process-current", lockHoldMs));
    }
    for (const lockHoldMs of SQLITE_LOCK_HOLDS_MS) {
      isolatedSqlite.push(await runSqliteFaultCase(child, ready, "isolated-prototype", lockHoldMs));
    }

    const mainThreadCpu = await runCpuFaultCase(child, ready, CPU_BLOCK_MS);
    const recoveredHttp = await probeHttp(ready.port, 2_000);
    const recoveredCompanion = await companionRequest(ready.socketPath, "runtime.health", 2_000);
    assert.equal(recoveredHttp.statusCode, 200);
    assert.equal(recoveredCompanion.ok, true);

    const longestCurrent = inProcessSqlite.at(-1)!;
    const longestIsolated = isolatedSqlite.at(-1)!;
    assert.equal(longestCurrent.runtimeHealth.outcome, "timeout");
    assert.equal(longestIsolated.runtimeHealth.outcome, "ok");
    assert.equal(longestIsolated.stateServiceDuringFault?.reason, "state-stale");

    report = {
      issue: 143,
      kind: "latency-attribution-and-isolation-comparison",
      testedAt: new Date().toISOString(),
      source: "current checkout",
      database: "disposable schema-25 fixtures",
      productionDatabaseModified: false,
      measurementContract: {
        samplesPerFaultDuration: 1,
        percentileClaimed: false,
        configuredBusyTimeoutMs: 5_000,
        runtimeHealthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS,
        initialTargetsMs: {
          healthzP99: HEALTH_TARGET_MS,
          bridgeEventLoopP99: EVENT_LOOP_TARGET_MS,
          healthyStateCommandP99: 500
        }
      },
      baseline: {
        healthzMs: rounded(baselineHttp.durationMs),
        runtimeHealthMs: rounded(baselineCompanion.durationMs),
        isolatedStateProcessId: ready.isolatedStateProcessId,
        isolatedStateReadiness: ready.isolatedStateHealth.reason
      },
      faultMatrix: {
        sqliteWriteLock: {
          injection: "separate SQLite connection BEGIN IMMEDIATE",
          lockHoldMs: [...SQLITE_LOCK_HOLDS_MS],
          currentMainProcess: inProcessSqlite,
          isolatedStatePrototype: isolatedSqlite
        },
        mainThreadCpu
      },
      recovery: {
        healthzMs: rounded(recoveredHttp.durationMs),
        runtimeHealthMs: rounded(recoveredCompanion.durationMs)
      },
      attribution: {
        optimize: [
          "healthy SQL/query cost, payload size, serialization, allocation, and main-thread CPU work",
          "queue scheduling and duplicated Dashboard reads"
        ],
        isolate: [
          "synchronous operational SQLite execution and lock/filesystem stalls",
          "Dashboard/history reads and diagnostic persistence"
        ],
        boundedDegradation: [
          "state command completion may wait only within its deadline and capacity contract",
          "readiness may become state-stale while liveness remains responsive",
          "Dashboard data may remain visibly stale and maintenance may be deferred"
        ],
        externalTolerance: [
          "Tunnel, network, ChatGPT host, and Codex runtime latency require separate clocks, reconnect, and authoritative resync"
        ],
        neverAllowed: [
          "a state lock freezing /healthz or runtime.health",
          "one project exhausting every other project's critical capacity",
          "timeout being reported as Job failure, cancellation, or success"
        ]
      },
      conclusion: [
        "latency is not indivisible: SQLite completion remains delayed by the injected lock, while process isolation prevents that delay from occupying the Bridge event loop",
        "the current in-process path scales Bridge health and event-loop delay with the SQLite lock duration and crosses the macOS two-second timeout",
        "the isolated prototype keeps /healthz, runtime.health, and the Bridge timer responsive while its state-service readiness becomes stale",
        "a synthetic main-thread CPU fault still delays both health paths, so database isolation is necessary but not sufficient"
      ],
      limits: [
        "each fault duration is a single deterministic characterization sample, not a p99 load result",
        "the protocol-v4 isolated state service is ready for every maintenance slice, including registry-planned jobs retention, but production startup does not select it until the remaining command and query callers cross the boundary",
        "the fixture does not exercise the Secure MCP Tunnel, ChatGPT host, Codex runtime, disk exhaustion, large JSON/GC pressure, queue fairness, or the read-worker design",
        "the controlled SQLite fault proves a structural failure mode, not that locking caused every reported incident"
      ],
      failureReproduced: true,
      isolationPrototypeBoundaryVerified: true,
      productionResolutionVerified: false,
      temporaryFixtureRemoved: true
    };
  } catch (error) {
    if (childOutput) process.stderr.write(childOutput);
    throw error;
  } finally {
    if (child.connected) {
      child.send({ type: "close" });
      await waitForMessage(child, "closed", 3_000).catch(() => undefined);
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runSqliteFaultCase(
  child: ChildProcess,
  ready: ReadyMessage,
  mode: SqliteFaultMode,
  lockHoldMs: number
): Promise<Record<string, unknown> & {
  runtimeHealth: { outcome: string; durationMs: number };
  stateServiceDuringFault?: OperationalStateHealth;
}> {
  const scenarioId = `${mode}-sqlite-${lockHoldMs}`;
  const stateFile = mode === "in-process-current" ? ready.stateFile : ready.isolatedStateFile;
  const locker = new Database(stateFile);
  let lockReleased = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  try {
    locker.pragma("busy_timeout = 5000");
    locker.exec("BEGIN IMMEDIATE");
    const startedPromise = waitForMessage(child, "operation-started", 5_000, scenarioId);
    const finishedPromise = waitForMessage(child, "operation-finished", lockHoldMs + 5_000, scenarioId);
    const timerPromise = waitForMessage(child, "timer-fired", lockHoldMs + 5_000, scenarioId);
    const healthSnapshotAfterMs = mode === "isolated-prototype" && lockHoldMs >= 3_000
      ? 2_250
      : undefined;
    const stateHealthPromise = healthSnapshotAfterMs === undefined
      ? undefined
      : waitForMessage(child, "state-health", lockHoldMs + 5_000, scenarioId);
    child.send({
      type: "run-sqlite-fault",
      scenarioId,
      mode,
      ...(healthSnapshotAfterMs === undefined ? {} : { healthSnapshotAfterMs })
    } satisfies FixtureCommand);
    const started = await startedPromise;

    let releaseResolve!: () => void;
    let releaseReject!: (error: Error) => void;
    const released = new Promise<void>((resolve, reject) => {
      releaseResolve = resolve;
      releaseReject = reject;
    });
    releaseTimer = setTimeout(() => {
      try {
        locker.exec("COMMIT");
        lockReleased = true;
        releaseResolve();
      } catch (error) {
        releaseReject(error instanceof Error ? error : new Error(String(error)));
      }
    }, lockHoldMs);

    const httpPromise = probeHttp(ready.port, lockHoldMs + 3_000);
    const runtimeHealthPromise = companionRequest(
      ready.socketPath,
      "runtime.health",
      RUNTIME_HEALTH_TIMEOUT_MS
    );
    const [[http, runtimeHealth, operation, timer, stateHealthMessage]] = await Promise.all([
      Promise.all([
        httpPromise,
        runtimeHealthPromise,
        finishedPromise,
        timerPromise,
        stateHealthPromise ?? Promise.resolve(undefined)
      ]),
      released
    ]);
    if (releaseTimer) clearTimeout(releaseTimer);

    const toleranceMs = Math.min(250, Math.max(25, lockHoldMs * 0.25));
    assert.equal(operation.error, null);
    assert.equal(operation.outcome, "committed");
    assert.ok(
      operation.durationMs >= lockHoldMs - toleranceMs,
      `${mode} state operation blocked only ${operation.durationMs} ms for a ${lockHoldMs} ms lock`
    );
    assert.equal(http.statusCode, 200);
    if (mode === "in-process-current") {
      assert.ok(
        http.durationMs >= lockHoldMs - toleranceMs,
        `current /healthz delayed only ${http.durationMs} ms for a ${lockHoldMs} ms lock`
      );
      assert.ok(
        timer.delayMs >= lockHoldMs - toleranceMs,
        `current event-loop timer delayed only ${timer.delayMs} ms for a ${lockHoldMs} ms lock`
      );
      if (lockHoldMs > RUNTIME_HEALTH_TIMEOUT_MS) {
        assert.equal(runtimeHealth.ok, false);
        assert.equal(runtimeHealth.error, "timeout");
      } else {
        assert.equal(runtimeHealth.ok, true);
        assert.ok(runtimeHealth.durationMs >= lockHoldMs - toleranceMs);
      }
    } else {
      assert.equal(runtimeHealth.ok, true);
      assert.ok(http.durationMs < 750, `isolated /healthz took ${http.durationMs} ms`);
      assert.ok(runtimeHealth.durationMs < 750, `isolated runtime.health took ${runtimeHealth.durationMs} ms`);
      assert.ok(timer.delayMs < 750, `isolated event-loop timer took ${timer.delayMs} ms`);
      if (stateHealthMessage) {
        assert.equal(stateHealthMessage.health.reason, "state-stale");
        assert.equal(stateHealthMessage.health.inFlight, 1);
      }
    }

    const stateServiceDuringFault = stateHealthMessage?.health;
    return {
      mode,
      scenarioId,
      injectedDomain: "sqlite-write-lock",
      lockHoldMs,
      operationStartedAt: rounded(started.at),
      stateOperation: {
        outcome: operation.outcome,
        durationMs: rounded(operation.durationMs)
      },
      healthz: {
        statusCode: http.statusCode,
        durationMs: rounded(http.durationMs),
        initialTargetMet: http.durationMs <= HEALTH_TARGET_MS
      },
      runtimeHealth: {
        outcome: runtimeHealth.ok ? "ok" : runtimeHealth.error || "error",
        durationMs: rounded(runtimeHealth.durationMs)
      },
      bridgeEventLoopTimer: {
        durationMs: rounded(timer.delayMs),
        initialTargetMet: timer.delayMs <= EVENT_LOOP_TARGET_MS
      },
      ...(stateServiceDuringFault ? { stateServiceDuringFault } : {}),
      availabilityPropagationObserved:
        http.durationMs > HEALTH_TARGET_MS ||
        timer.delayMs > EVENT_LOOP_TARGET_MS ||
        !runtimeHealth.ok
    };
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    if (!lockReleased && locker.inTransaction) locker.exec("ROLLBACK");
    locker.close();
  }
}

async function runCpuFaultCase(
  child: ChildProcess,
  ready: ReadyMessage,
  blockMs: number
): Promise<Record<string, unknown>> {
  const scenarioId = `main-thread-cpu-${blockMs}`;
  const startedPromise = waitForMessage(child, "operation-started", 5_000, scenarioId);
  const finishedPromise = waitForMessage(child, "operation-finished", blockMs + 5_000, scenarioId);
  const timerPromise = waitForMessage(child, "timer-fired", blockMs + 5_000, scenarioId);
  child.send({ type: "run-cpu-fault", scenarioId, blockMs } satisfies FixtureCommand);
  const started = await startedPromise;
  const httpPromise = probeHttp(ready.port, blockMs + 2_000);
  const runtimeHealthPromise = companionRequest(
    ready.socketPath,
    "runtime.health",
    RUNTIME_HEALTH_TIMEOUT_MS
  );
  const [http, runtimeHealth, operation, timer] = await Promise.all([
    httpPromise,
    runtimeHealthPromise,
    finishedPromise,
    timerPromise
  ]);
  const toleranceMs = Math.max(50, blockMs * 0.25);
  assert.equal(operation.outcome, "completed");
  assert.equal(operation.error, null);
  assert.ok(operation.durationMs >= blockMs - toleranceMs);
  assert.equal(http.statusCode, 200);
  assert.ok(http.durationMs >= blockMs - toleranceMs);
  assert.equal(runtimeHealth.ok, true);
  assert.ok(runtimeHealth.durationMs >= blockMs - toleranceMs);
  assert.ok(timer.delayMs >= blockMs - toleranceMs);
  return {
    scenarioId,
    injectedDomain: "synthetic-main-thread-cpu",
    blockMs,
    operationStartedAt: rounded(started.at),
    operationDurationMs: rounded(operation.durationMs),
    healthz: {
      statusCode: http.statusCode,
      durationMs: rounded(http.durationMs),
      initialTargetMet: http.durationMs <= HEALTH_TARGET_MS
    },
    runtimeHealth: {
      outcome: runtimeHealth.ok ? "ok" : runtimeHealth.error || "error",
      durationMs: rounded(runtimeHealth.durationMs)
    },
    bridgeEventLoopTimer: {
      durationMs: rounded(timer.delayMs),
      initialTargetMet: timer.delayMs <= EVENT_LOOP_TARGET_MS
    },
    availabilityPropagationObserved: true,
    interpretation: "state-process isolation cannot protect health paths from synchronous CPU work that remains on the Bridge event loop"
  };
}

async function runFixtureChild(root: string): Promise<void> {
  const stateFile = path.join(root, "state.sqlite");
  const isolatedStateFile = path.join(root, "isolated-state.sqlite");
  const socketPath = path.join(root, "bridge.sock");
  const config = loadConfig({
    ...process.env,
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_PORT: "8876",
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
  });
  const store = new BridgeStateStore({ file: stateFile });
  const isolatedState = await ChildProcessOperationalStateService.start({
    file: isolatedStateFile,
    capacity: 1
  });
  const server = createHttpServer(config, new FixtureUpstream(), new FixtureCatalog(), { stateStore: store });
  const companion = await startBridgeCompanionServer({
    socketPath,
    applicationService: server.applicationService
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP address is unavailable.");
  send({
    type: "ready",
    port: address.port,
    socketPath,
    stateFile,
    isolatedStateFile,
    isolatedStateProcessId: isolatedState.processId,
    isolatedStateHealth: isolatedState.health()
  });

  process.on("message", message => {
    if (!message || typeof message !== "object") return;
    const command = message as FixtureCommand;
    if (command.type === "run-sqlite-fault") {
      const { scenarioId } = command;
      const scheduledAt = performance.now();
      setTimeout(() => {
        const firedAt = performance.now();
        send({
          type: "timer-fired",
          scenarioId,
          scheduledAt,
          firedAt,
          delayMs: firedAt - scheduledAt
        });
      }, 10);
      const startedAt = performance.now();
      send({ type: "operation-started", scenarioId, at: startedAt });
      if (command.mode === "in-process-current") {
        let error: string | null = null;
        try {
          store.setMeta("issue_143_contention_probe", randomUUID());
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const finishedAt = performance.now();
        send({
          type: "operation-finished",
          scenarioId,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          outcome: error ? "failed" : "committed",
          error
        });
        return;
      }
      if (command.healthSnapshotAfterMs !== undefined) {
        setTimeout(() => send({
          type: "state-health",
          scenarioId,
          health: isolatedState.health()
        }), command.healthSnapshotAfterMs);
      }
      void isolatedState.execute(
        { operation: "maintain", slice: "events" },
        {
          deadlineMs: 5_000,
          commandId: randomUUID(),
          aggregateKey: `issue-143:${scenarioId}`
        }
      ).then(
        result => {
          const finishedAt = performance.now();
          send({
            type: "operation-finished",
            scenarioId,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            outcome: result.certainty === "committed" ? "committed" : "failed",
            error: result.certainty === "committed" ? null : "State result was not committed."
          });
        },
        caught => {
          const finishedAt = performance.now();
          send({
            type: "operation-finished",
            scenarioId,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            outcome: "failed",
            ...(caught instanceof OperationalStateProcessError ? { errorCode: caught.code } : {}),
            error: caught instanceof Error ? caught.message : String(caught)
          });
        }
      );
      return;
    }
    if (command.type === "run-cpu-fault") {
      const { scenarioId, blockMs } = command;
      const scheduledAt = performance.now();
      setTimeout(() => {
        const firedAt = performance.now();
        send({
          type: "timer-fired",
          scenarioId,
          scheduledAt,
          firedAt,
          delayMs: firedAt - scheduledAt
        });
      }, 10);
      const startedAt = performance.now();
      send({ type: "operation-started", scenarioId, at: startedAt });
      const deadline = startedAt + blockMs;
      while (performance.now() < deadline) {
        // Deliberately occupy the fixture's main event loop for attribution.
      }
      const finishedAt = performance.now();
      send({
        type: "operation-finished",
        scenarioId,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        outcome: "completed",
        error: null
      });
      return;
    }
    if (command.type === "close") {
      void (async () => {
        await isolatedState.close();
        await companion.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
        send({ type: "closed" });
        process.disconnect?.();
      })();
    }
  });
}

class FixtureUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> { return { tools: [] }; }
  async callTool(): Promise<ToolResult> {
    return { content: [{ type: "text", text: "fixture" }] };
  }
  async close(): Promise<void> {}
}

class FixtureCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-21T00:00:00.000Z",
    validatedAt: "2026-09-21T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "Fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }],
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };

  async getCatalog(_options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    return this.snapshot;
  }

  getCachedCatalog(): CodexModelCatalogSnapshot { return this.snapshot; }
}

function send(message: FixtureMessage): void {
  if (process.send) process.send(message);
}

function waitForMessage<T extends FixtureMessage["type"]>(
  child: ChildProcess,
  type: T,
  timeoutMs: number,
  scenarioId?: string
): Promise<Extract<FixtureMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for fixture message: ${type}`)), timeoutMs);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
      if (
        scenarioId !== undefined &&
        (message as { scenarioId?: unknown }).scenarioId !== scenarioId
      ) return;
      finish(undefined, message as Extract<FixtureMessage, { type: T }>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Fixture child exited before ${type}: code=${code} signal=${signal}`));
    };
    const finish = (error?: Error, message?: Extract<FixtureMessage, { type: T }>) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function probeHttp(port: number, timeoutMs: number): Promise<{ statusCode: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET" }, response => {
      response.resume();
      response.once("end", () => resolve({
        statusCode: response.statusCode || 0,
        durationMs: performance.now() - started
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("HTTP timeout")));
    request.once("error", reject);
    request.end();
  });
}

function companionRequest(
  socketPath: string,
  method: string,
  timeoutMs: number
): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (ok: boolean, error?: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, durationMs: performance.now() - started, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finish(false, error.message));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const response = JSON.parse(buffer.split("\n")[0]!) as { error?: { message?: string } };
      finish(!response.error, response.error?.message);
    });
  });
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

const rootArgument = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  if (!rootArgument) throw new Error("Fixture child root is required.");
  await runFixtureChild(rootArgument);
} else {
  await runCharacterization();
}
