import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
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
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";
import type { OperationalStateHealth } from "../src/stateService.js";
import {
  ChildProcessOperationalStateService,
  OperationalStateProcessError,
  operationalStateErrorCode
} from "../src/stateServiceProcess.js";
import {
  BridgeStateStore,
  STATE_DATABASE_BUSY_TIMEOUT_MS
} from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

type SqliteFaultMode = "in-process-current" | "isolated-prototype";
type SqliteFaultExpectedOutcome = "committed" | "storage-busy";
type SqliteFaultCase = {
  lockHoldMs: number;
  expectedOutcome: SqliteFaultExpectedOutcome;
};

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
const SQLITE_LOCK_FAULTS: readonly SqliteFaultCase[] = [
  { lockHoldMs: 50, expectedOutcome: "committed" },
  { lockHoldMs: 250, expectedOutcome: "committed" },
  { lockHoldMs: 1_000, expectedOutcome: "committed" },
  { lockHoldMs: 3_200, expectedOutcome: "committed" },
  { lockHoldMs: STATE_DATABASE_BUSY_TIMEOUT_MS - 100, expectedOutcome: "committed" },
  { lockHoldMs: STATE_DATABASE_BUSY_TIMEOUT_MS + 1_500, expectedOutcome: "storage-busy" }
];
const CPU_BLOCK_MS = 350;
const HEALTH_TARGET_MS = 200;
const EVENT_LOOP_TARGET_MS = 50;
const RUNTIME_HEALTH_TIMEOUT_MS = 2_000;
const PRODUCTION_STALL_MS = 30_500;
const PRODUCTION_PROBE_INTERVAL_MS = 250;

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
    for (const fault of SQLITE_LOCK_FAULTS) {
      inProcessSqlite.push(await runSqliteFaultCase(child, ready, "in-process-current", fault));
    }
    for (const fault of SQLITE_LOCK_FAULTS) {
      isolatedSqlite.push(await runSqliteFaultCase(child, ready, "isolated-prototype", fault));
    }

    const mainThreadCpu = await runCpuFaultCase(child, ready, CPU_BLOCK_MS);
    const productionLongStall = await runProductionLongStall(root);
    const recoveredHttp = await probeHttp(ready.port, 2_000);
    const recoveredCompanion = await companionRequest(ready.socketPath, "runtime.health", 2_000);
    assert.equal(recoveredHttp.statusCode, 200);
    assert.equal(recoveredCompanion.ok, true);

    const longestCurrent = inProcessSqlite.at(-1)!;
    const longestIsolated = isolatedSqlite.at(-1)!;
    assert.equal(longestCurrent.runtimeHealth.outcome, "timeout");
    assert.equal(longestIsolated.runtimeHealth.outcome, "ok");
    assert.equal(longestIsolated.stateServiceDuringFault?.reason, "state-stale");
    assert.equal(
      longestIsolated.stateServiceDuringFault?.activeOperation?.phase,
      "write-lock-wait"
    );

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
        configuredBusyTimeoutMs: STATE_DATABASE_BUSY_TIMEOUT_MS,
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
          cases: SQLITE_LOCK_FAULTS,
          currentMainProcess: inProcessSqlite,
          isolatedStatePrototype: isolatedSqlite
        },
        mainThreadCpu,
        productionLongStall
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
        "the 4.9-second case commits below the configured SQLite busy timeout, while a 6.5-second lock produces an explicit state-storage-busy result instead of being inferred from elapsed time",
        "a synthetic main-thread CPU fault still delays both legacy health paths, so database isolation is necessary but not sufficient",
        "the production ingress boundary remains live through a 30-second stopped runtime, reports state-stale instead of disconnected, rejects uncertain writes explicitly, and confirms the committed revision after the runtime resumes"
      ],
      limits: [
        "each fault duration is a single deterministic characterization sample, not a p99 load result",
        "the legacy comparison fixture remains a structural attribution test; the separate production-long-stall section is the authoritative current-startup-path result",
        "the fixture does not exercise the Secure MCP Tunnel or ChatGPT host, and it does not claim external network latency can be shortened",
        "the 30-second production test samples one controlled process/filesystem scheduling fault and does not claim a fleet-wide percentile",
        "the controlled SQLite fault proves a structural failure mode, not that locking caused every reported incident"
      ],
      failureReproduced: true,
      isolationPrototypeBoundaryVerified: true,
      sqliteBusyBoundaryVerified: true,
      productionResolutionVerified: productionLongStall.passed,
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
  fault: SqliteFaultCase
): Promise<Record<string, unknown> & {
  runtimeHealth: { outcome: string; durationMs: number };
  stateServiceDuringFault?: OperationalStateHealth;
}> {
  const { lockHoldMs, expectedOutcome } = fault;
  const scenarioId = `${mode}-sqlite-${lockHoldMs}`;
  const stateFile = mode === "in-process-current" ? ready.stateFile : ready.isolatedStateFile;
  const locker = new Database(stateFile);
  let lockReleased = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  try {
    locker.pragma(`busy_timeout = ${STATE_DATABASE_BUSY_TIMEOUT_MS}`);
    locker.exec("BEGIN IMMEDIATE");
    const startedPromise = waitForMessage(child, "operation-started", 5_000, scenarioId);
    const scenarioTimeoutMs = Math.max(lockHoldMs, STATE_DATABASE_BUSY_TIMEOUT_MS) + 5_000;
    const finishedPromise = waitForMessage(child, "operation-finished", scenarioTimeoutMs, scenarioId);
    const timerPromise = waitForMessage(child, "timer-fired", scenarioTimeoutMs, scenarioId);
    const healthSnapshotAfterMs = mode === "isolated-prototype" && lockHoldMs >= 3_000
      ? 2_250
      : undefined;
    const stateHealthPromise = healthSnapshotAfterMs === undefined
      ? undefined
      : waitForMessage(child, "state-health", scenarioTimeoutMs, scenarioId);
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

    const expectedBlockingMs = expectedOutcome === "committed"
      ? lockHoldMs
      : STATE_DATABASE_BUSY_TIMEOUT_MS;
    const toleranceMs = Math.min(350, Math.max(25, expectedBlockingMs * 0.1));
    if (expectedOutcome === "committed") {
      assert.equal(operation.error, null);
      assert.equal(operation.outcome, "committed");
    } else {
      assert.equal(operation.outcome, "failed");
      assert.equal(operation.errorCode, "STATE_STORAGE_BUSY");
      assert.match(operation.error || "", /busy|locked/iu);
    }
    assert.ok(
      operation.durationMs >= expectedBlockingMs - toleranceMs,
      `${mode} state operation blocked only ${operation.durationMs} ms; expected about ${expectedBlockingMs} ms`
    );
    assert.equal(http.statusCode, 200);
    if (mode === "in-process-current") {
      assert.ok(
        http.durationMs >= expectedBlockingMs - toleranceMs,
        `current /healthz delayed only ${http.durationMs} ms; expected about ${expectedBlockingMs} ms`
      );
      assert.ok(
        timer.delayMs >= expectedBlockingMs - toleranceMs,
        `current event-loop timer delayed only ${timer.delayMs} ms; expected about ${expectedBlockingMs} ms`
      );
      if (expectedBlockingMs > RUNTIME_HEALTH_TIMEOUT_MS) {
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
        assert.equal(stateHealthMessage.health.queueDepth, 0);
        assert.deepEqual(
          stateHealthMessage.health.activeOperation,
          {
            access: "write",
            operation: "maintain",
            slice: "events",
            phase: "write-lock-wait",
            startedAt: stateHealthMessage.health.activeOperation?.startedAt,
            observedAt: stateHealthMessage.health.activeOperation?.observedAt
          }
        );
      }
    }

    const stateServiceDuringFault = stateHealthMessage?.health;
    return {
      mode,
      scenarioId,
      injectedDomain: "sqlite-write-lock",
      lockHoldMs,
      expectedOutcome,
      operationStartedAt: rounded(started.at),
      stateOperation: {
        outcome: operation.outcome,
        ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
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

async function runProductionLongStall(root: string): Promise<Record<string, unknown> & {
  passed: boolean;
}> {
  if (process.platform === "win32") {
    throw new Error("The production long-stall regression requires POSIX SIGSTOP/SIGCONT support.");
  }
  const runtimeRoot = path.join(root, "production-runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const stateFile = path.join(runtimeRoot, "state.sqlite");
  const telemetryFile = path.join(runtimeRoot, "telemetry.sqlite");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(runtimeRoot, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: telemetryFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(runtimeRoot, "models.json"),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(runtimeRoot, "skills")
  };
  const spawnedProcessIds: number[] = [];
  const config = loadConfig(environment);
  const server = await createIsolatedHttpServer(config, {
    childEnvironment: environment,
    onRuntimeProcessSpawn: processId => spawnedProcessIds.push(processId)
  });
  // macOS limits AF_UNIX paths to roughly 104 bytes. The surrounding
  // characterization root is intentionally descriptive, so keep this one
  // generated socket in a separate short, private fixture directory.
  const companionRoot = await mkdtemp(path.join("/tmp", "i143-companion-"));
  const companionSocketPath = path.join(companionRoot, "bridge.sock");
  let companion: Awaited<ReturnType<typeof startBridgeCompanionServer>> | undefined;
  let locker: Database.Database | undefined;
  let lockReleased = false;
  let runtimeStopped = false;
  let stoppedProcessId: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Production regression HTTP address is unavailable.");
    }
    const port = address.port;
    companion = await startBridgeCompanionServer({
      socketPath: companionSocketPath,
      applicationService: server.applicationService
    });
    await waitForProductionReady(port, 10_000);
    const initial = await server.applicationService.settingsSnapshot();
    const nativeBaselineHealth = await companionRequest(
      companionSocketPath,
      "runtime.health",
      2_000
    );
    const nativeBaselineSettings = await companionRequest(
      companionSocketPath,
      "settings.snapshot",
      5_000
    );
    assert.equal(nativeBaselineHealth.ok, true);
    assert.equal(nativeBaselineSettings.ok, true);
    assert.equal(
      readSettingsRevision(nativeBaselineSettings.result),
      initial.settings.settingsRevision
    );
    const changedValue = !initial.settings.showBridgeThreadsInCodexApp;

    locker = new Database(stateFile);
    locker.pragma(`busy_timeout = ${STATE_DATABASE_BUSY_TIMEOUT_MS}`);
    locker.exec("BEGIN IMMEDIATE");
    const mutationStartedAt = performance.now();
    const mutationOutcome = server.applicationService.updateSettings({
      expectedSettingsRevision: initial.settings.settingsRevision,
      operation: {
        kind: "patch",
        settings: { showBridgeThreadsInCodexApp: changedValue }
      }
    }).then(
      () => ({ outcome: "confirmed" as const, durationMs: performance.now() - mutationStartedAt }),
      error => ({
        outcome: "unknown" as const,
        durationMs: performance.now() - mutationStartedAt,
        error: error instanceof Error ? error.message : String(error)
      })
    );

    await waitForCondition(() => {
      const operation = server.applicationService.runtimeHealth?.().stateService?.activeOperation;
      return operation?.access === "write" && operation.phase === "write-lock-wait";
    }, 3_000, "production runtime to report write-lock-wait");
    stoppedProcessId = spawnedProcessIds.at(-1);
    if (!stoppedProcessId) throw new Error("Production runtime process id was not observed.");
    process.kill(stoppedProcessId, "SIGSTOP");
    runtimeStopped = true;
    locker.exec("COMMIT");
    lockReleased = true;

    const stoppedAt = performance.now();
    // This is the same socket and method used by the native app. Starting the
    // request immediately after the runtime is stopped proves that either the
    // fresh-to-stale transition or an already-stale admission returns bounded
    // uncertainty instead of holding the app connection until recovery.
    const nativeDegradedSettingsPromise = companionRequest(
      companionSocketPath,
      "settings.snapshot",
      5_000
    );
    const healthSamples: Array<{ elapsedMs: number; durationMs: number; statusCode: number }> = [];
    const checkpoints: Array<{
      requestedAtMs: number;
      observedAtMs: number;
      readinessStatus: number;
      readiness: unknown;
      runtimeHealth: ReturnType<NonNullable<typeof server.applicationService.runtimeHealth>>;
      nativeRuntimeHealth: Awaited<ReturnType<typeof companionRequest>>;
    }> = [];
    const checkpointTargets = [2_250, 10_000, 30_000];
    let checkpointIndex = 0;
    while (performance.now() - stoppedAt < PRODUCTION_STALL_MS) {
      const probe = await probeHttp(port, 2_000);
      const elapsedMs = performance.now() - stoppedAt;
      healthSamples.push({
        elapsedMs: rounded(elapsedMs),
        durationMs: rounded(probe.durationMs),
        statusCode: probe.statusCode
      });
      while (
        checkpointIndex < checkpointTargets.length &&
        elapsedMs >= checkpointTargets[checkpointIndex]!
      ) {
        const requestedAtMs = checkpointTargets[checkpointIndex]!;
        const readiness = await probeReadiness(port, 2_000);
        const runtimeHealth = server.applicationService.runtimeHealth?.();
        if (!runtimeHealth) throw new Error("Production runtime health is unavailable.");
        const nativeRuntimeHealth = await companionRequest(
          companionSocketPath,
          "runtime.health",
          2_000
        );
        assert.equal(readiness.statusCode, 503);
        assert.match(String((readiness.body as { reason?: unknown }).reason), /^state-stale$/u);
        assert.equal(runtimeHealth.acceptingNewJobs, false);
        assert.equal(runtimeHealth.backgroundProcessState, "unknown");
        assert.equal(runtimeHealth.stateService?.status, "state-stale");
        assert.equal(runtimeHealth.stateService?.activeOperation?.access, "write");
        assert.equal(runtimeHealth.readService?.status, "read-stale");
        assert.equal(runtimeHealth.telemetryService?.status, "stale");
        assert.equal(nativeRuntimeHealth.ok, true);
        assert.ok(
          nativeRuntimeHealth.durationMs < 750,
          `native runtime.health took ${nativeRuntimeHealth.durationMs} ms`
        );
        assert.equal(
          readStateServiceStatus(nativeRuntimeHealth.result),
          "state-stale"
        );
        checkpoints.push({
          requestedAtMs,
          observedAtMs: rounded(performance.now() - stoppedAt),
          readinessStatus: readiness.statusCode,
          readiness: readiness.body,
          runtimeHealth,
          nativeRuntimeHealth
        });
        checkpointIndex += 1;
      }
      await delay(PRODUCTION_PROBE_INTERVAL_MS);
    }
    assert.equal(checkpoints.length, checkpointTargets.length);
    assert.ok(healthSamples.length >= 100, `Expected at least 100 liveness samples, received ${healthSamples.length}.`);
    assert.ok(healthSamples.every(sample => sample.statusCode === 200));
    assert.ok(
      healthSamples.every(sample => sample.durationMs < 750),
      `A production /healthz sample exceeded 750 ms: ${Math.max(...healthSamples.map(sample => sample.durationMs))}`
    );
    const uncertain = await mutationOutcome;
    assert.equal(uncertain.outcome, "unknown");
    assert.match("error" in uncertain ? uncertain.error : "", /RUNTIME_RESPONSE_UNCONFIRMED/u);
    const nativeDegradedSettings = await nativeDegradedSettingsPromise;
    assert.equal(nativeDegradedSettings.ok, false);
    assert.notEqual(nativeDegradedSettings.error, "timeout");
    assert.match(nativeDegradedSettings.error || "", /RUNTIME_RESPONSE_UNCONFIRMED/u);
    assert.ok(
      nativeDegradedSettings.durationMs < 3_500,
      `native Settings uncertainty took ${nativeDegradedSettings.durationMs} ms`
    );

    process.kill(stoppedProcessId, "SIGCONT");
    runtimeStopped = false;
    const resumedAt = performance.now();
    await waitForProductionReady(port, 10_000);
    const recovered = await waitForValue(
      async () => server.applicationService.settingsSnapshot(),
      snapshot => snapshot.settings.settingsRevision === initial.settings.settingsRevision + 1,
      10_000,
      "committed settings revision after runtime resume"
    );
    assert.equal(recovered.settings.showBridgeThreadsInCodexApp, changedValue);
    const nativeRecoveredSettings = await companionRequest(
      companionSocketPath,
      "settings.snapshot",
      5_000
    );
    const nativeRecoveredDashboard = await companionRequest(
      companionSocketPath,
      "dashboard.snapshot",
      5_000,
      { enrich: false }
    );
    assert.equal(nativeRecoveredSettings.ok, true);
    assert.equal(nativeRecoveredDashboard.ok, true);
    assert.equal(
      readSettingsRevision(nativeRecoveredSettings.result),
      recovered.settings.settingsRevision
    );
    const durations = healthSamples.map(sample => sample.durationMs).sort((left, right) => left - right);
    return {
      passed: true,
      injection: "BEGIN IMMEDIATE followed by SIGSTOP of the production runtime child",
      stoppedProcessId,
      configuredStallMs: PRODUCTION_STALL_MS,
      observedStallMs: rounded(resumedAt - stoppedAt),
      platform: {
        platform: process.platform,
        architecture: process.arch,
        cpu: cpus()[0]?.model || "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem()
      },
      healthz: {
        samples: healthSamples.length,
        allStatus200: true,
        p50Ms: rounded(percentile(durations, 0.5)),
        p95Ms: rounded(percentile(durations, 0.95)),
        p99Ms: rounded(percentile(durations, 0.99)),
        maxMs: rounded(durations.at(-1) || 0)
      },
      checkpoints,
      uncertainWrite: uncertain,
      nativeCompanion: {
        socketRemainedAvailable: true,
        baselineHealthMs: rounded(nativeBaselineHealth.durationMs),
        baselineSettingsMs: rounded(nativeBaselineSettings.durationMs),
        degradedSettings: nativeDegradedSettings,
        recoveredSettingsMs: rounded(nativeRecoveredSettings.durationMs),
        recoveredDashboardMs: rounded(nativeRecoveredDashboard.durationMs),
        recoveredSettingsRevision: readSettingsRevision(nativeRecoveredSettings.result)
      },
      recovery: {
        durationMs: rounded(performance.now() - resumedAt),
        settingsRevisionBefore: initial.settings.settingsRevision,
        settingsRevisionAfter: recovered.settings.settingsRevision,
        committedValueConfirmed: true
      },
      interpretation: [
        "public liveness is independent from the stopped runtime and its database work",
        "elapsed time changes readiness to state-stale but does not classify a Job as failed, cancelled, or successful",
        "the original caller receives an outcome-unknown result and authoritative state is resynchronized after recovery"
      ]
    };
  } finally {
    if (runtimeStopped && stoppedProcessId) {
      try { process.kill(stoppedProcessId, "SIGCONT"); } catch { /* already exited */ }
    }
    if (locker) {
      if (!lockReleased && locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
    }
    await companion?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(companionRoot, { recursive: true, force: true });
  }
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
        let errorCode: string | undefined;
        try {
          store.setMeta("issue_143_contention_probe", randomUUID());
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          errorCode = operationalStateErrorCode(caught);
        }
        const finishedAt = performance.now();
        send({
          type: "operation-finished",
          scenarioId,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          outcome: error ? "failed" : "committed",
          ...(errorCode ? { errorCode } : {}),
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
          deadlineMs: STATE_DATABASE_BUSY_TIMEOUT_MS + 3_000,
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

async function probeReadiness(
  port: number,
  timeoutMs: number
): Promise<{ statusCode: number; durationMs: number; body: unknown }> {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  return {
    statusCode: response.status,
    durationMs: performance.now() - started,
    body: await response.json()
  };
}

async function waitForProductionReady(port: number, timeoutMs: number): Promise<void> {
  await waitForCondition(async () => {
    try {
      return (await probeReadiness(port, Math.min(timeoutMs, 2_000))).statusCode === 200;
    } catch {
      return false;
    }
  }, timeoutMs, "production runtime readiness");
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForValue<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
  description: string
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${description}.` +
    (lastError ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "")
  );
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * quantile) - 1);
  return sortedValues[Math.min(index, sortedValues.length - 1)]!;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function companionRequest(
  socketPath: string,
  method: string,
  timeoutMs: number,
  params: Record<string, unknown> = {}
): Promise<{ ok: boolean; durationMs: number; error?: string; result?: unknown }> {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (ok: boolean, error?: string, result?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        ok,
        durationMs: performance.now() - started,
        ...(error ? { error } : {}),
        ...(result !== undefined ? { result } : {})
      });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finish(false, error.message));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: method, method, params })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const response = JSON.parse(buffer.split("\n")[0]!) as {
        error?: { message?: string };
        result?: unknown;
      };
      finish(!response.error, response.error?.message, response.result);
    });
  });
}

function readSettingsRevision(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = (value as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return undefined;
  const revision = (settings as { settingsRevision?: unknown }).settingsRevision;
  return typeof revision === "number" ? revision : undefined;
}

function readStateServiceStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stateService = (value as { stateService?: unknown }).stateService;
  if (!stateService || typeof stateService !== "object") return undefined;
  const status = (stateService as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
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
