import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ChildProcessOperationalStateService,
  OperationalStateProcessError
} from "../src/stateServiceProcess.js";
import { BridgeStateStore } from "../src/stateStore.js";

describe("operational state child process", () => {
  it("executes a semantic maintenance command in an isolated process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-process-"));
    const service = await ChildProcessOperationalStateService.start({
      file: path.join(root, "state.sqlite")
    });
    try {
      expect(service.health()).toMatchObject({
        ready: true,
        reason: "ready",
        protocolVersion: 2,
        generation: expect.any(String),
        capacity: 64
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
      expect(service.health()).toMatchObject({ ready: true, reason: "ready" });
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
      expect(service.health()).toMatchObject({ ready: true, reason: "ready", inFlight: 0 });
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
      expect(service.health()).toMatchObject({ ready: true, inFlight: 0 });
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
});
