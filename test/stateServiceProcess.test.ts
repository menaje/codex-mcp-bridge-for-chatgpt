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
  OPERATIONAL_STATE_PROTOCOL_VERSION,
  type OperationalJobRetentionCommand
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
        ready: true,
        reason: "ready",
        protocolVersion: OPERATIONAL_STATE_PROTOCOL_VERSION,
        generation: expect.any(String),
        inFlight: 0,
        queueDepth: 0,
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
          committedAt: expect.any(Number),
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
      await expect(service.execute(jobRetentionCommand()))
        .resolves.toMatchObject({
          operation: "maintain",
          slice: "jobs",
          changed: 0,
          jobRetention: {
            classifications: [],
            remainingAdmissionReservations: 0
          },
          certainty: "committed",
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

  it("classifies and archives bounded Job-retention candidates in the state owner", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-jobs-"));
    const file = path.join(root, "state.sqlite");
    const now = Date.now();
    const protectedJobId = randomUUID();
    const removableJobId = randomUUID();
    const seed = new BridgeStateStore({ file });
    seed.upsertJob({
      jobId: protectedJobId,
      scopeId: "11111111-1111-4111-8111-111111111111",
      requestId: randomUUID(),
      status: "completed",
      updatedAt: now,
      version: 1
    });
    seed.upsertJob({
      jobId: removableJobId,
      scopeId: "11111111-1111-4111-8111-111111111111",
      requestId: randomUUID(),
      status: "completed",
      updatedAt: now,
      version: 1
    });
    seed.holdResult(protectedJobId, "test hold", now + 60_000, now);
    seed.close();

    const fixture = new Database(file);
    fixture.exec("DELETE FROM completion_outbox; DELETE FROM job_completion_deliveries;");
    fixture.close();

    const service = await ChildProcessOperationalStateService.start({ file });
    try {
      const command = jobRetentionCommand({
        now: now + 1_000,
        cutoffAt: now + 500,
        retentionTarget: 0,
        admissionReservations: 2,
        maxRemoved: 2,
        maxDurationMs: 1_000,
        candidates: [
          { jobId: protectedJobId, version: 1, updatedAt: now, knownProtected: false },
          { jobId: removableJobId, version: 1, updatedAt: now, knownProtected: false }
        ]
      });
      const commandId = randomUUID();
      await expect(service.execute(command, {
        commandId,
        aggregateKey: "maintenance:jobs"
      })).resolves.toMatchObject({
        operation: "maintain",
        slice: "jobs",
        changed: 1,
        jobRetention: {
          classifications: [
            { jobId: protectedJobId, disposition: "protected" },
            { jobId: removableJobId, disposition: "removed" }
          ],
          remainingAdmissionReservations: 0
        },
        certainty: "committed",
        commandId,
        replayed: false
      });
      await expect(service.execute(command, {
        commandId,
        aggregateKey: "maintenance:jobs"
      })).resolves.toMatchObject({
        operation: "maintain",
        slice: "jobs",
        changed: 1,
        jobRetention: {
          classifications: [
            { jobId: protectedJobId, disposition: "protected" },
            { jobId: removableJobId, disposition: "removed" }
          ]
        },
        certainty: "committed",
        commandId,
        replayed: true
      });
      await service.close();

      const verify = new BridgeStateStore({ file });
      try {
        expect(verify.listJobs().map(job => job.jobId)).toEqual([protectedJobId]);
        expect(verify.listDashboardRetainedJobsByIds([removableJobId])).toHaveLength(1);
      } finally {
        verify.close();
      }
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the parent responsive and retains the blocked write phase and queue depth", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-service-lock-"));
    const file = path.join(root, "state.sqlite");
    const service = await ChildProcessOperationalStateService.start({ file, capacity: 2 });
    const locker = new Database(file);
    let locked = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      locked = true;
      const maintenance = service.execute(
        { operation: "maintain", slice: "events" },
        { deadlineMs: 5_000 }
      );
      await waitFor(() => service.health().activeOperation?.phase === "write-lock-wait", 1_000);
      const queuedMaintenance = service.execute(
        { operation: "maintain", slice: "history" },
        { deadlineMs: 5_000 }
      );
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-capacity",
        inFlight: 2,
        queueDepth: 1,
        capacity: 2,
        activeOperation: {
          access: "write",
          operation: "maintain",
          slice: "events",
          phase: "write-lock-wait",
          startedAt: expect.any(Number),
          observedAt: expect.any(Number)
        }
      });
      await expect(service.execute({ operation: "maintain", slice: "questions" }))
        .rejects.toMatchObject<Partial<OperationalStateProcessError>>({ code: "STATE_CAPACITY" });

      const timerStarted = performance.now();
      await delay(100);
      expect(performance.now() - timerStarted).toBeLessThan(300);

      await delay(2_100);
      expect(service.health()).toMatchObject({
        ready: false,
        reason: "state-stale",
        inFlight: 2,
        queueDepth: 1,
        activeOperation: {
          access: "write",
          slice: "events",
          phase: "write-lock-wait"
        }
      });

      locker.exec("COMMIT");
      locked = false;
      await expect(maintenance).resolves.toMatchObject({ operation: "maintain", slice: "events" });
      await expect(queuedMaintenance).resolves.toMatchObject({
        operation: "maintain",
        slice: "history"
      });
      await delay(350);
      const recovered = service.health();
      expect(recovered).toMatchObject({
        ready: true,
        reason: "ready",
        inFlight: 0,
        queueDepth: 0,
        lastCommitAt: expect.any(Number)
      });
      expect(recovered).not.toHaveProperty("activeOperation");
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
        ready: true,
        reason: "ready",
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
      const committedAt = service.health().lastCommitAt;
      expect(committedAt).toEqual(expect.any(Number));
      expect(service.health()).toMatchObject({
        ready: true,
        reason: "ready",
        inFlight: 0,
        lastCommitAt: expect.any(Number)
      });
      await service.close();

      service = await ChildProcessOperationalStateService.start({ file, capacity: 1 });
      expect(service.health()).toMatchObject({ lastCommitAt: committedAt });
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

      expect(service.health()).toMatchObject({ ready: true, reason: "ready" });
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
        ready: true,
        reason: "ready",
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

function jobRetentionCommand(
  overrides: Partial<OperationalJobRetentionCommand> = {}
): OperationalJobRetentionCommand {
  return {
    operation: "maintain",
    slice: "jobs",
    now: 1_000,
    cutoffAt: 0,
    completionResultRecoveryMs: 0,
    retentionTarget: 0,
    admissionReservations: 0,
    maxRemoved: 32,
    maxDurationMs: 10,
    candidates: [],
    ...overrides
  };
}
