import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
    const service = await ChildProcessTelemetryService.start(file);
    const locker = new Database(file);
    locker.exec("BEGIN IMMEDIATE");
    const bridgeInstanceId = randomUUID();
    const scopeId = randomUUID();
    const jobId = randomUUID();
    const startedAt = Date.now();
    try {
      for (let index = 0; index < 300; index += 1) {
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
        retained: 300
      });
      expect(service.status().queued + service.status().inFlight).toBeLessThanOrEqual(256);
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
      expect(row.count).toBeLessThanOrEqual(257);
      expect(persisted.prepare(
        "SELECT COUNT(*) AS count FROM transport_observations WHERE reason_code = ?"
      ).get("telemetry-worker-recovery")).toMatchObject({ count: 1 });
    } finally {
      persisted.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

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

      expect(() => operational.setMeta("telemetry_capacity_probe", "committed"))
        .not.toThrow();
      expect(operational.getMeta("telemetry_capacity_probe")).toBe("committed");
    } finally {
      operational.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
