import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { ChildProcessTelemetryService } from "../src/telemetryService.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for telemetry state.");
}

describe("isolated telemetry persistence", () => {
  it("bounds and drains diagnostics without sharing an operational SQLite wait", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-"));
    const file = path.join(root, "telemetry.sqlite");
    const sourceStateDatabaseId = randomUUID();
    const service = await ChildProcessTelemetryService.start(file, {
      sourceStateDatabaseId
    });
    const locker = new Database(file);
    expect(service.recordRuntimeMeasurement({
      component: "state",
      metric: "transaction.duration",
      durationMs: 12.5
    })).toBe(true);
    expect(service.recordDiagnosticEvent({
      severity: "warning",
      component: "state",
      code: "storage.busy"
    })).toBe(true);
    await waitFor(() => service.status().queued === 0 && service.status().inFlight === 0);
    locker.exec("BEGIN IMMEDIATE");
    const bridgeInstanceId = randomUUID();
    const scopeId = randomUUID();
    const jobId = randomUUID();
    const startedAt = Date.now();
    try {
      for (let index = 0; index < 4_300; index += 1) {
        service.recordTransportObservation({
          kind: "status-wait-aborted",
          scopeId,
          jobId,
          toolName: "codex_status",
          callerRequestDigest: index.toString(16).padStart(64, "0"),
          reasonCode: "host-aborted-read-wait"
        }, bridgeInstanceId);
      }
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(service.status()).toMatchObject({
        connected: true,
        retained: 1_000
      });
      expect(service.status().queued + service.status().inFlight).toBeLessThanOrEqual(4_097);
      expect(service.status().dropped).toBeGreaterThan(0);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    await waitFor(() => service.status().queued === 0 && service.status().inFlight === 0);
    expect(service.status().lastPersistedAt).toBeTypeOf("number");

    const originalProcessId = service.processId;
    expect(originalProcessId).toBeTypeOf("number");
    process.kill(originalProcessId!, "SIGKILL");
    service.recordTransportObservation({
      kind: "status-wait-aborted",
      scopeId,
      jobId,
      toolName: "codex_status",
      callerRequestDigest: "f".repeat(64),
      reasonCode: "telemetry-worker-recovery"
    }, bridgeInstanceId);
    await waitFor(() => service.status().connected && service.processId !== originalProcessId);
    await waitFor(() => service.status().queued === 0 && service.status().inFlight === 0);
    await service.close();

    const persisted = new Database(file, { readonly: true });
    try {
      const row = persisted.prepare(
        "SELECT COUNT(*) AS count FROM transport_observations"
      ).get() as { count: number };
      expect(row.count).toBeGreaterThan(0);
      expect(row.count).toBeLessThanOrEqual(1_000);
      expect(persisted.prepare(
        "SELECT COUNT(*) AS count FROM transport_observations WHERE reason_code = ?"
      ).get("telemetry-worker-recovery")).toMatchObject({ count: 1 });
      expect(persisted.prepare(
        "SELECT value FROM telemetry_meta WHERE key = 'source_state_database_id'"
      ).get()).toEqual({ value: sourceStateDatabaseId });
      expect(persisted.prepare(
        "SELECT SUM(dropped_count) AS count FROM telemetry_drop_counters"
      ).get()).toMatchObject({ count: expect.any(Number) });
      expect(persisted.prepare(
        "SELECT COUNT(*) AS count FROM runtime_measurements"
      ).get()).toEqual({ count: 1 });
      expect(persisted.prepare(
        "SELECT COUNT(*) AS count FROM diagnostic_events"
      ).get()).toEqual({ count: 1 });
      for (const table of [
        "runtime_measurements",
        "diagnostic_events",
        "telemetry_drop_counters",
        "telemetry_retention_state"
      ]) {
        expect(persisted.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table)).toEqual({ count: 1 });
      }
    } finally {
      persisted.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("contains a diagnostic database capacity failure without blocking operational state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-full-"));
    const telemetryFile = path.join(root, "telemetry.sqlite");
    const operationalFile = path.join(root, "state.sqlite");
    const service = await ChildProcessTelemetryService.start(telemetryFile, {
      freezePageCountAfterStartup: true
    });
    const bridgeInstanceId = randomUUID();
    const scopeId = randomUUID();
    const operational = new BridgeStateStore({ file: operationalFile });
    try {
      const failedBeforeInvalidInput = service.status().failed;
      expect(() => service.recordTransportObservation({
        kind: "status-wait-aborted",
        scopeId,
        reasonCode: "invalid reason with spaces"
      }, bridgeInstanceId)).not.toThrow();
      expect(service.status().failed).toBe(failedBeforeInvalidInput + 1);

      for (let index = 0; index < 256; index += 1) {
        service.recordTransportObservation({
          kind: "status-wait-aborted",
          scopeId,
          toolName: `codex_status_${index.toString().padStart(3, "0")}_${"x".repeat(70)}`,
          callerRequestDigest: index.toString(16).padStart(64, "0"),
          reasonCode: "telemetry-capacity-fault"
        }, bridgeInstanceId);
      }
      await waitFor(() => service.status().queued === 0 && service.status().inFlight === 0);
      expect(service.status()).toMatchObject({ connected: true });
      expect(service.status().failed).toBeGreaterThan(0);
      const failedAfterDrain = service.status().failed;
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(service.status().failed - failedAfterDrain).toBeLessThanOrEqual(2);

      expect(() => operational.setMeta("telemetry_capacity_probe", "committed"))
        .not.toThrow();
      expect(operational.getMeta("telemetry_capacity_probe")).toBe("committed");
    } finally {
      operational.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("quarantines telemetry from a different operational database and rebuilds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-source-"));
    const file = path.join(root, "telemetry.sqlite");
    const firstSource = randomUUID();
    const secondSource = randomUUID();
    let service = await ChildProcessTelemetryService.start(file, {
      sourceStateDatabaseId: firstSource
    });
    await service.close();
    try {
      service = await ChildProcessTelemetryService.start(file, {
        sourceStateDatabaseId: secondSource
      });
      await waitFor(() => service.status().queued === 0 && service.status().inFlight === 0);
      await service.close();

      const active = new Database(file, { readonly: true });
      try {
        expect(active.prepare(
          "SELECT value FROM telemetry_meta WHERE key = 'source_state_database_id'"
        ).get()).toEqual({ value: secondSource });
        expect(active.prepare(
          "SELECT COUNT(*) AS count FROM diagnostic_events WHERE code = 'database.rebuilt'"
        ).get()).toEqual({ count: 1 });
      } finally {
        active.close();
      }
      const rejected = (await readdir(root)).filter(name =>
        name.startsWith("telemetry.sqlite.rejected-")
      );
      expect(rejected).toHaveLength(1);
      expect(await readdir(path.join(root, rejected[0]!))).toContain("telemetry.sqlite");
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("quarantines a corrupt diagnostic database without touching operational state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-corrupt-"));
    const file = path.join(root, "telemetry.sqlite");
    const sourceStateDatabaseId = randomUUID();
    await writeFile(file, "not a sqlite database", { mode: 0o600 });
    let service: ChildProcessTelemetryService | undefined;
    try {
      service = await ChildProcessTelemetryService.start(file, {
        sourceStateDatabaseId
      });
      await waitFor(() => service!.status().queued === 0 && service!.status().inFlight === 0);
      await service.close();

      const active = new Database(file, { readonly: true });
      try {
        expect(active.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(active.prepare(
          "SELECT value FROM telemetry_meta WHERE key = 'source_state_database_id'"
        ).get()).toEqual({ value: sourceStateDatabaseId });
      } finally {
        active.close();
      }
      expect((await readdir(root)).some(name =>
        name.startsWith("telemetry.sqlite.rejected-")
      )).toBe(true);
    } finally {
      await service?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("starts degraded and recovers after a transient telemetry startup lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-start-lock-"));
    const file = path.join(root, "telemetry.sqlite");
    const sourceStateDatabaseId = randomUUID();
    const initial = await ChildProcessTelemetryService.start(file);
    await initial.close();
    const locker = new Database(file);
    locker.exec("BEGIN EXCLUSIVE");
    let service: ChildProcessTelemetryService | undefined;
    try {
      service = await ChildProcessTelemetryService.start(file, { sourceStateDatabaseId });
      expect(service.status()).toMatchObject({ connected: false, failed: 1 });
      locker.exec("ROLLBACK");
      await waitFor(() => service!.status().connected, 10_000);
      expect(service.status()).toMatchObject({ connected: true });
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await service?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rebases startup records and merges drops after an initially locked database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-telemetry-rebase-"));
    const file = path.join(root, "telemetry.sqlite");
    const sourceStateDatabaseId = randomUUID();
    const bridgeInstanceId = randomUUID();
    const scopeId = randomUUID();
    const initial = await ChildProcessTelemetryService.start(file, { sourceStateDatabaseId });
    initial.recordTransportObservation({
      kind: "status-wait-aborted",
      scopeId,
      reasonCode: "existing-before-startup-lock"
    }, bridgeInstanceId);
    await waitFor(() => initial.status().queued === 0 && initial.status().inFlight === 0);
    await initial.close();

    const locker = new Database(file);
    locker.prepare(`
      INSERT INTO telemetry_drop_counters(kind, dropped_count, first_at, last_at)
      VALUES ('transport.queue-capacity', 5, 100, 200)
    `).run();
    locker.prepare(`
      UPDATE telemetry_meta SET value = '1' WHERE key = 'schema_version'
    `).run();
    locker.exec("DROP TABLE telemetry_record_deliveries");
    locker.exec("BEGIN EXCLUSIVE");
    let service: ChildProcessTelemetryService | undefined;
    try {
      service = await ChildProcessTelemetryService.start(file, {
        sourceStateDatabaseId,
        queueCapacity: 1
      });
      expect(service.status()).toMatchObject({ connected: false, failed: 1 });
      expect(service.recordTransportObservation({
        kind: "status-wait-aborted",
        scopeId,
        reasonCode: "queued-during-startup-recovery"
      }, bridgeInstanceId)).toMatchObject({ observationId: 1 });
      service.recordTransportObservation({
        kind: "status-wait-aborted",
        scopeId,
        reasonCode: "dropped-during-startup-recovery"
      }, bridgeInstanceId);
      expect(service.status().dropped).toBe(1);

      locker.exec("ROLLBACK");
      await waitFor(() => service!.status().connected, 10_000);
      await waitFor(
        () => service!.status().queued === 0 && service!.status().inFlight === 0,
        10_000
      );
      expect(service.status().dropped).toBe(6);
      await service.close();

      const persisted = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(persisted.prepare(`
          SELECT observation_id AS id, reason_code AS reason
            FROM transport_observations
           ORDER BY observation_id
        `).all()).toEqual([
          { id: 1, reason: "existing-before-startup-lock" },
          { id: 2, reason: "queued-during-startup-recovery" }
        ]);
        expect(persisted.prepare(`
          SELECT dropped_count AS count
            FROM telemetry_drop_counters
           WHERE kind = 'transport.queue-capacity'
        `).get()).toEqual({ count: 6 });
        expect(persisted.prepare(`
          SELECT value FROM telemetry_meta WHERE key = 'schema_version'
        `).get()).toEqual({ value: "2" });
        expect(persisted.prepare(`
          SELECT COUNT(*) AS count FROM telemetry_record_deliveries
        `).get()).toEqual({ count: 1 });
      } finally {
        persisted.close();
      }
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await service?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
