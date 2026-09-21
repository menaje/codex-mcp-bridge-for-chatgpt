import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ChildProcessOperationalStateService,
  OperationalStateProcessError,
  SupervisedOperationalStateService
} from "../src/stateServiceProcess.js";
import {
  OPERATIONAL_STATE_CHILD_SUPPORTED_SLICES,
  OPERATIONAL_STATE_PROTOCOL_VERSION
} from "../src/stateService.js";
import { BridgeStateStore } from "../src/stateStore.js";

describe("operational state child process", () => {
  it("executes a semantic maintenance command in an isolated process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-process-"));
    const service = await ChildProcessOperationalStateService.start({
      file: path.join(root, "state.sqlite")
    });
    try {
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-incompatible",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: expect.any(String),
        capacity: 64,
        supportedSlices: OPERATIONAL_STATE_CHILD_SUPPORTED_SLICES
      });
      await expect(service.execute({ operation: "maintain", slice: "events" }))
        .resolves.toMatchObject({
          operation: "maintain",
          slice: "events",
          changed: 0,
          certainty: "committed",
          commandId: expect.any(String),
          replayed: false
        });
      await expect(service.execute({ operation: "maintain", slice: "receipts" }))
        .resolves.toMatchObject({
          operation: "maintain",
          slice: "receipts",
          changed: 0,
          certainty: "committed",
          commandId: expect.any(String),
          replayed: false
        });
      await expect(service.execute({ operation: "maintain", slice: "jobs" }))
        .rejects.toMatchObject<Partial<OperationalStateProcessError>>({
          code: "STATE_OPERATION_UNAVAILABLE"
        });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to become a second BridgeStateStore owner", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-owner-"));
    const file = path.join(root, "state.sqlite");
    const currentOwner = new BridgeStateStore({ file });
    try {
      await expect(ChildProcessOperationalStateService.start({
        file,
        startupTimeoutMs: 2_000
      })).rejects.toThrow(/already in use|owner|lease/iu);
    } finally {
      currentOwner.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps the parent event loop responsive and reports stale heartbeat while SQLite is locked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-lock-"));
    const file = path.join(root, "state.sqlite");
    const service = await ChildProcessOperationalStateService.start({ file, capacity: 1 });
    const locker = new Database(file);
    let locked = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      locked = true;
      const maintenance = service.execute(
        { operation: "maintain", slice: "events" },
        { deadlineMs: 5_000 }
      );
      await delay(50);
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-capacity",
        inFlight: 1,
        capacity: 1
      });
      await expect(service.execute({ operation: "maintain", slice: "history" }))
        .rejects.toMatchObject<Partial<OperationalStateProcessError>>({ code: "STATE_CAPACITY" });

      const timerStarted = performance.now();
      await delay(100);
      expect(performance.now() - timerStarted).toBeLessThan(300);

      await delay(2_100);
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-stale"
      });

      locker.exec("COMMIT");
      locked = false;
      await expect(maintenance).resolves.toMatchObject({ operation: "maintain", slice: "events" });
      await delay(350);
      expect(service.health()).toMatchObject({ ready: false, reason: "state-incompatible" });
    } finally {
      if (locked && locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps timed-out commands charged to capacity until their late response arrives", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-uncertain-"));
    const file = path.join(root, "state.sqlite");
    const service = await ChildProcessOperationalStateService.start({ file, capacity: 1 });
    const locker = new Database(file);
    let locked = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      locked = true;
      await expect(service.execute(
        { operation: "maintain", slice: "events" },
        { deadlineMs: 100 }
      )).rejects.toMatchObject<Partial<OperationalStateProcessError>>({
        code: "STATE_OUTCOME_UNKNOWN"
      });
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-capacity",
        inFlight: 1
      });
      await expect(service.execute({ operation: "maintain", slice: "history" }))
        .rejects.toMatchObject<Partial<OperationalStateProcessError>>({ code: "STATE_CAPACITY" });

      locker.exec("COMMIT");
      locked = false;
      await delay(350);
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-incompatible",
        inFlight: 0
      });
    } finally {
      if (locked && locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("replays a durable receipt after response loss and rejects hash conflicts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-receipt-replay-"));
    const file = path.join(root, "state.sqlite");
    const commandId = randomUUID();
    let service = await ChildProcessOperationalStateService.start({ file, capacity: 1 });
    const locker = new Database(file);
    let locked = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      locked = true;
      await expect(service.execute(
        { operation: "maintain", slice: "events" },
        { deadlineMs: 100, commandId, aggregateKey: "maintenance:events" }
      )).rejects.toMatchObject<Partial<OperationalStateProcessError>>({
        code: "STATE_OUTCOME_UNKNOWN",
        commandId
      });

      locker.exec("COMMIT");
      locked = false;
      await delay(350);
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-incompatible",
        inFlight: 0
      });
      await service.close();

      service = await ChildProcessOperationalStateService.start({ file, capacity: 1 });
      await expect(service.execute(
        { operation: "maintain", slice: "events" },
        { commandId, aggregateKey: "maintenance:events" }
      )).resolves.toMatchObject({
        operation: "maintain",
        slice: "events",
        certainty: "committed",
        commandId,
        replayed: true
      });
      await expect(service.execute(
        { operation: "maintain", slice: "history" },
        { commandId, aggregateKey: "maintenance:events" }
      )).rejects.toMatchObject<Partial<OperationalStateProcessError>>({
        code: "STATE_COMMAND_CONFLICT"
      });
    } finally {
      if (locked && locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("restarts a crashed state owner with one live writer generation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-supervisor-"));
    const file = path.join(root, "state.sqlite");
    const service = await SupervisedOperationalStateService.start({
      file,
      restartBaseDelayMs: 25,
      restartMaxDelayMs: 100,
      restartStableMs: 1_000
    });
    try {
      const firstPid = service.processId;
      expect(firstPid).toEqual(expect.any(Number));
      process.kill(firstPid as number, "SIGKILL");
      await waitFor(() => {
        const nextPid = service.processId;
        return nextPid !== undefined && nextPid !== firstPid &&
          service.health().heartbeatAgeMs !== undefined;
      }, 5_000);

      expect(service.health()).toMatchObject({ ready: false, reason: "state-incompatible" });
      await expect(service.execute({ operation: "maintain", slice: "events" }))
        .resolves.toMatchObject({ certainty: "committed", replayed: false });

      const database = new Database(file, { readonly: true });
      try {
        expect(database.prepare(`
          SELECT COUNT(*) AS count FROM bridge_instances WHERE stopped_at IS NULL
        `).get()).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("retires a live but stale state owner before starting its replacement", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-stale-supervisor-"));
    const file = path.join(root, "state.sqlite");
    const service = await SupervisedOperationalStateService.start({
      file,
      restartBaseDelayMs: 25,
      restartMaxDelayMs: 100,
      restartStableMs: 10_000,
      staleRestartMs: 2_250
    });
    try {
      const firstPid = service.processId;
      expect(firstPid).toEqual(expect.any(Number));
      process.kill(firstPid as number, "SIGSTOP");
      const commandId = randomUUID();
      const uncertain = service.execute(
        { operation: "maintain", slice: "events" },
        { commandId, deadlineMs: 10_000 }
      ).then(
        () => undefined,
        error => error as OperationalStateProcessError
      );

      await waitFor(() => {
        const nextPid = service.processId;
        return nextPid !== undefined && nextPid !== firstPid &&
          service.health().heartbeatAgeMs !== undefined;
      }, 8_000);

      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-incompatible",
        generation: expect.any(String)
      });
      await expect(uncertain).resolves.toMatchObject({
        code: "STATE_OUTCOME_UNKNOWN",
        commandId
      });
      await expect(service.execute(
        { operation: "maintain", slice: "events" },
        { commandId }
      )).resolves.toMatchObject({ certainty: "committed", commandId, replayed: false });

      const database = new Database(file, { readonly: true });
      try {
        expect(database.prepare(`
          SELECT COUNT(*) AS count FROM bridge_instances WHERE stopped_at IS NULL
        `).get()).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);

  it("closes promptly after the child has already exited by signal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-signalled-close-"));
    const service = await ChildProcessOperationalStateService.start({
      file: path.join(root, "state.sqlite")
    });
    try {
      expect(service.terminate("SIGKILL")).toBe(true);
      await service.waitForExit();
      await expect(Promise.race([
        service.close().then(() => "closed"),
        delay(1_000).then(() => "timed-out")
      ])).resolves.toBe("closed");
    } finally {
      service.terminate("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates supervisor restart options before spawning a child", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-invalid-supervisor-"));
    try {
      await expect(SupervisedOperationalStateService.start({
        file: path.join(root, "state.sqlite"),
        restartBaseDelayMs: 100,
        restartMaxDelayMs: 50
      })).rejects.toThrow(/restartMaxDelayMs must be an integer from 100 to 300000/);
      await expect(SupervisedOperationalStateService.start({
        file: path.join(root, "state.sqlite"),
        staleRestartMs: 2_000
      })).rejects.toThrow(/staleRestartMs must be an integer from 2250 to 300000/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state-service recovery.");
    await delay(25);
  }
}
