import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";

const HEALTH_TARGET_MS = 200;
const EVENT_LOOP_TARGET_MS = 50;
const HEALTHY_COMMAND_TARGET_MS = 500;
const STATE_LOCK_MS = 3_200;
const CURRENT_PROTOCOL = "2026-07-28";

type RuntimeFixture = {
  root: string;
  stateFile: string;
  telemetryFile: string;
  server: BridgeHttpServer;
  baseUrl: string;
  stateProcessIds: number[];
  executionProcessIds: number[];
};

async function main(): Promise<void> {
  const fixture = await startFixture();
  let telemetryLocker: Database.Database | undefined;
  let stateLocker: Database.Database | undefined;
  try {
    await waitForReady(fixture.baseUrl);
    const initialDatabaseId = readMeta(fixture.stateFile, "state_database_id");
    assert.match(initialDatabaseId, /^[0-9a-f-]{36}$/iu);

    const dashboardStartedAt = performance.now();
    const dashboard = await fixture.server.applicationService.dashboardSnapshot({
      inspectRuntime: true,
      includeHistory: false
    });
    const firstDashboardDurationMs = performance.now() - dashboardStartedAt;
    assert.ok(dashboard.codexAccount);
    await waitForCondition(
      () => fixture.executionProcessIds.length === 1 &&
        fixture.server.applicationService.runtimeHealth?.().executionService?.status === "ready",
      10_000,
      "isolated Codex execution startup"
    );
    assert.equal(fixture.stateProcessIds.length, 1);
    assert.notEqual(fixture.executionProcessIds[0], fixture.stateProcessIds[0]);

    const readStartedAt = performance.now();
    const concurrentReaderCount = 12;
    const readers = await Promise.all(Array.from({ length: concurrentReaderCount }, () =>
      fixture.server.applicationService.dashboardSnapshot({
        inspectRuntime: false,
        includeHistory: false
      })
    ));
    const concurrentReadDurationMs = performance.now() - readStartedAt;
    assert.equal(readers.length, concurrentReaderCount);

    const executionClient = new Client(
      { name: "issue-142-execution-admission", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: CURRENT_PROTOCOL } } }
    );
    await executionClient.connect(
      new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`))
    );
    const taskDescriptor = (await executionClient.listTools()).tools.find(
      tool => tool.name === "codex_task"
    );
    assert.ok(taskDescriptor, "codex_task descriptor must be available");
    const taskProperties = taskDescriptor.inputSchema.properties as Record<
      string,
      { const?: string | number }
    >;
    const executionProcessId = fixture.executionProcessIds.at(-1)!;
    let executionStopped = false;
    let executionAdmissionReadiness: unknown;
    try {
      process.kill(executionProcessId, "SIGSTOP");
      executionStopped = true;
      await waitForCondition(
        () => fixture.server.applicationService.runtimeHealth?.().executionService?.status ===
          "stale",
        8_000,
        "stale execution readiness"
      );
      const readiness = await probe(fixture.baseUrl, "/readyz");
      executionAdmissionReadiness = readiness.body;
      assert.equal(readiness.status, 503);
      assert.equal((readiness.body as { reason?: string }).reason, "execution-stale");
      assert.equal(
        (await fixture.server.applicationService.runtimeSnapshot()).acceptingNewJobs,
        false
      );
      assert.equal(readJobCount(fixture.stateFile), 0);
      const blocked = await executionClient.callTool({
        name: "codex_task",
        arguments: {
          scopeId: randomUUID(),
          requestId: randomUUID(),
          taskContractVersion: taskProperties.taskContractVersion?.const,
          executionEnvelopeRef: taskProperties.executionEnvelopeRef?.const,
          prompt: "This Job must not be created while the execution child is stale."
        }
      });
      assert.equal(blocked.isError, true);
      assert.equal(
        (blocked.structuredContent as { error?: { code?: string } } | undefined)?.error?.code,
        "EXECUTION_UNAVAILABLE"
      );
      assert.equal(readJobCount(fixture.stateFile), 0);
    } finally {
      if (executionStopped) process.kill(executionProcessId, "SIGCONT");
      await executionClient.close();
    }
    await waitForCondition(
      () => fixture.server.applicationService.runtimeHealth?.().executionService?.status ===
        "ready",
      8_000,
      "execution readiness after resume"
    );

    let revision = readSettingsRevision(fixture.stateFile);
    let visibility = readVisibility(fixture.stateFile);
    const healthyCommandDurations: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const startedAt = performance.now();
      const result = await fixture.server.applicationService.updateSettings({
        expectedSettingsRevision: revision,
        operation: {
          kind: "patch",
          settings: { showBridgeThreadsInCodexApp: !visibility }
        }
      });
      healthyCommandDurations.push(performance.now() - startedAt);
      revision = result.settings.settingsRevision;
      visibility = result.settings.showBridgeThreadsInCodexApp;
    }

    telemetryLocker = new Database(fixture.telemetryFile);
    telemetryLocker.exec("BEGIN IMMEDIATE");
    const telemetryFaultDurations: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const startedAt = performance.now();
      const result = await fixture.server.applicationService.updateSettings({
        expectedSettingsRevision: revision,
        operation: {
          kind: "patch",
          settings: { showBridgeThreadsInCodexApp: !visibility }
        }
      });
      telemetryFaultDurations.push(performance.now() - startedAt);
      revision = result.settings.settingsRevision;
      visibility = result.settings.showBridgeThreadsInCodexApp;
    }
    const telemetryFaultHealth = await probe(fixture.baseUrl, "/healthz");
    const telemetryFaultReadiness = await probe(fixture.baseUrl, "/readyz");
    assert.equal(telemetryFaultHealth.status, 200);
    assert.equal(telemetryFaultReadiness.status, 200);
    telemetryLocker.exec("ROLLBACK");
    telemetryLocker.close();
    telemetryLocker = undefined;
    await waitForCondition(
      () => {
        const status = fixture.server.applicationService.runtimeHealth?.().telemetryService;
        return status?.status === "ready" && status.queued === 0 && status.inFlight === 0;
      },
      10_000,
      "telemetry drain after lock release"
    );

    stateLocker = new Database(fixture.stateFile);
    stateLocker.exec("BEGIN IMMEDIATE");
    const lockedTargetRevision = revision + 1;
    const lockedMutation = fixture.server.applicationService.updateSettings({
      expectedSettingsRevision: revision,
      operation: {
        kind: "patch",
        settings: { showBridgeThreadsInCodexApp: !visibility }
      }
    }).then(
      () => ({ outcome: "confirmed" as const }),
      error => ({
        outcome: "unknown" as const,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    await waitForCondition(
      () => fixture.server.applicationService.runtimeHealth?.()
        .stateService?.activeOperation?.phase === "write-lock-wait",
      3_000,
      "state write-lock observation"
    );
    const eventLoopLags: number[] = [];
    const healthDurations: number[] = [];
    const lockStartedAt = performance.now();
    let expectedTimerAt = performance.now() + 10;
    while (performance.now() - lockStartedAt < STATE_LOCK_MS) {
      await new Promise<void>(resolve => setTimeout(() => {
        const now = performance.now();
        eventLoopLags.push(Math.max(0, now - expectedTimerAt));
        expectedTimerAt = now + 10;
        resolve();
      }, 10));
      const health = await probe(fixture.baseUrl, "/healthz");
      assert.equal(health.status, 200);
      healthDurations.push(health.durationMs);
    }
    const degraded = await probe(fixture.baseUrl, "/readyz");
    assert.equal(degraded.status, 503);
    assert.equal((degraded.body as { reason?: string }).reason, "state-stale");
    stateLocker.exec("ROLLBACK");
    stateLocker.close();
    stateLocker = undefined;
    const lockedOutcome = await lockedMutation;
    assert.equal(lockedOutcome.outcome, "unknown");
    assert.match("error" in lockedOutcome ? lockedOutcome.error : "", /RUNTIME_RESPONSE_UNCONFIRMED/u);
    await waitForReady(fixture.baseUrl, 10_000);
    await waitForCondition(
      () => readSettingsRevision(fixture.stateFile) === lockedTargetRevision,
      10_000,
      "authoritative locked mutation commit"
    );
    revision = lockedTargetRevision;

    const firstExecutionProcessId = fixture.executionProcessIds.at(-1)!;
    process.kill(firstExecutionProcessId, "SIGKILL");
    const healthDuringExecutionRestart = await probe(fixture.baseUrl, "/healthz");
    assert.equal(healthDuringExecutionRestart.status, 200);
    await waitForCondition(
      () => fixture.executionProcessIds.length >= 2 &&
        fixture.server.applicationService.runtimeHealth?.().executionService?.status === "ready",
      12_000,
      "Codex execution restart"
    );
    assert.equal(fixture.stateProcessIds.length, 1);
    assert.equal(readMeta(fixture.stateFile, "state_database_id"), initialDatabaseId);
    assert.equal((await fixture.server.applicationService.runtimeSnapshot()).acceptingNewJobs, true);

    const firstStateProcessId = fixture.stateProcessIds[0]!;
    process.kill(firstStateProcessId, "SIGKILL");
    const healthDuringStateRestart = await probe(fixture.baseUrl, "/healthz");
    assert.equal(healthDuringStateRestart.status, 200);
    await waitForCondition(
      () => fixture.stateProcessIds.length >= 2,
      12_000,
      "operational state-owner replacement"
    );
    await waitForReady(fixture.baseUrl, 12_000);
    assert.equal(readMeta(fixture.stateFile, "state_database_id"), initialDatabaseId);
    assert.equal(readSettingsRevision(fixture.stateFile), revision);

    const healthSorted = [...healthDurations].sort((left, right) => left - right);
    const eventLoopSorted = [...eventLoopLags].sort((left, right) => left - right);
    const healthySorted = [...healthyCommandDurations].sort((left, right) => left - right);
    const telemetrySorted = [...telemetryFaultDurations].sort((left, right) => left - right);
    assert.ok(percentile(healthSorted, 0.99) < HEALTH_TARGET_MS);
    assert.ok(percentile(eventLoopSorted, 0.99) < EVENT_LOOP_TARGET_MS);
    assert.ok(percentile(healthySorted, 0.99) < HEALTHY_COMMAND_TARGET_MS);
    assert.ok(percentile(telemetrySorted, 0.99) < HEALTHY_COMMAND_TARGET_MS);
    const report = {
      issue: 142,
      kind: "production-state-execution-isolation",
      testedAt: new Date().toISOString(),
      source: "current checkout",
      productionDatabaseModified: false,
      topology: {
        ingressProcessId: process.pid,
        stateOwnerProcessIds: fixture.stateProcessIds,
        executionProcessIds: fixture.executionProcessIds,
        stateDatabaseId: initialDatabaseId,
        distinctExecutionProcess: true
      },
      dashboard: {
        firstEnrichedReadMs: rounded(firstDashboardDurationMs),
        concurrentStructuralReaders: readers.length,
        concurrentStructuralReadTotalMs: rounded(concurrentReadDurationMs)
      },
      executionAdmission: {
        staleReadiness: executionAdmissionReadiness,
        acceptingNewJobs: false,
        blockedBeforeJobCreation: true,
        retainedJobs: readJobCount(fixture.stateFile)
      },
      healthyStateCommands: summarize(healthySorted, HEALTHY_COMMAND_TARGET_MS),
      telemetryLock: {
        stateCommands: telemetrySorted.length,
        stateCommandLatency: summarize(telemetrySorted, HEALTHY_COMMAND_TARGET_MS),
        healthStatus: telemetryFaultHealth.status,
        readinessStatus: telemetryFaultReadiness.status,
        operationalAdmissionUnaffected: true,
        drainedAfterRelease: true
      },
      stateLock: {
        holdMs: STATE_LOCK_MS,
        mutationOutcomeBeforeLateConfirmation: lockedOutcome.outcome,
        authoritativeRevisionAfterRelease: revision,
        healthz: summarize(healthSorted, HEALTH_TARGET_MS),
        ingressEventLoopLag: summarize(eventLoopSorted, EVENT_LOOP_TARGET_MS),
        readinessDuringFault: degraded.body
      },
      recovery: {
        executionRestartedWithoutStateOwnerRestart: true,
        healthDuringExecutionRestartMs: rounded(healthDuringExecutionRestart.durationMs),
        stateOwnerRestartedWithIdentityPreserved: true,
        healthDuringStateRestartMs: rounded(healthDuringStateRestart.durationMs),
        settingsRevisionPreserved: true
      },
      passed: true
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (telemetryLocker?.inTransaction) telemetryLocker.exec("ROLLBACK");
    telemetryLocker?.close();
    if (stateLocker?.inTransaction) stateLocker.exec("ROLLBACK");
    stateLocker?.close();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function startFixture(): Promise<RuntimeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-142-isolation-"));
  const stateFile = path.join(root, "state.sqlite");
  const telemetryFile = path.join(root, "telemetry.sqlite");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    CODEX_HOME: path.join(root, ".codex"),
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_CODEX: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../test/fixtures/fake-codex-app-server.mjs"
    ),
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: telemetryFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
  };
  const stateProcessIds: number[] = [];
  const executionProcessIds: number[] = [];
  const server = await createIsolatedHttpServer(loadConfig(environment), {
    childEnvironment: environment,
    onRuntimeProcessSpawn: processId => stateProcessIds.push(processId),
    onExecutionProcessSpawn: processId => executionProcessIds.push(processId)
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Issue #142 fixture has no address.");
  return {
    root,
    stateFile,
    telemetryFile,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    stateProcessIds,
    executionProcessIds
  };
}

function readSettingsRevision(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Number((database.prepare(
      "SELECT settings_revision AS value FROM user_settings WHERE singleton = 1"
    ).get() as { value?: number } | undefined)?.value || 0);
  } finally {
    database.close();
  }
}

function readVisibility(file: string): boolean {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const payload = String((database.prepare(
      "SELECT payload FROM user_settings WHERE singleton = 1"
    ).get() as { payload?: string } | undefined)?.payload || "{}");
    return JSON.parse(payload).showBridgeThreadsInCodexApp === true;
  } finally {
    database.close();
  }
}

function readMeta(file: string, key: string): string {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return String((database.prepare(
      "SELECT value FROM bridge_meta WHERE key = ?"
    ).get(key) as { value?: string } | undefined)?.value || "");
  } finally {
    database.close();
  }
}

function readJobCount(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Number((database.prepare(
      "SELECT COUNT(*) AS value FROM jobs"
    ).get() as { value?: number } | undefined)?.value || 0);
  } finally {
    database.close();
  }
}

async function probe(baseUrl: string, pathname: string): Promise<{
  status: number;
  durationMs: number;
  body: unknown;
}> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`);
  const text = await response.text();
  return {
    status: response.status,
    durationMs: performance.now() - startedAt,
    body: text ? JSON.parse(text) : null
  };
}

async function waitForReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  await waitForCondition(async () => (await probe(baseUrl, "/readyz")).status === 200,
    timeoutMs, "runtime readiness");
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (candidate) {
      error = candidate;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.${error ? ` ${String(error)}` : ""}`);
}

function summarize(values: number[], targetMs: number): Record<string, number | boolean> {
  assert.ok(values.length > 0);
  return {
    samples: values.length,
    p50Ms: rounded(percentile(values, 0.50)),
    p95Ms: rounded(percentile(values, 0.95)),
    p99Ms: rounded(percentile(values, 0.99)),
    maxMs: rounded(values.at(-1) || 0),
    targetMs,
    targetMet: percentile(values, 0.99) < targetMs
  };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

await main();
