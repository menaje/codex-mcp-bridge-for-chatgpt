import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

const hash = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

describe("operational command receipts", () => {
  it("commits a mutation and receipt together and replays the first result", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const commandId = randomUUID();
    const generation = randomUUID();
    const payloadSha256 = hash({ operation: "probe", value: 1 });
    const apply = vi.fn(() => {
      store.setMeta("receipt_probe", "committed-once");
      return { result: { value: 7 }, resultingVersion: 3 };
    });
    try {
      expect(store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        aggregateKey: "probe:one",
        workerGeneration: generation,
        committedAt: 123
      }, apply)).toEqual({
        replayed: false,
        receipt: {
          commandId,
          operation: "probe",
          payloadSha256,
          aggregateKey: "probe:one",
          resultingVersion: 3,
          result: { value: 7 },
          workerGeneration: generation,
          committedAt: 123
        }
      });

      expect(store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        aggregateKey: "probe:one",
        workerGeneration: randomUUID()
      }, apply)).toMatchObject({
        replayed: true,
        receipt: { result: { value: 7 }, workerGeneration: generation }
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(store.getMeta("receipt_probe")).toBe("committed-once");
      expect(store.getOperationalCommandReceipt(commandId)).toMatchObject({
        commandId,
        payloadSha256,
        result: { value: 7 }
      });
    } finally {
      store.close();
    }
  });

  it("rejects command-ID reuse with a different payload without applying it", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const commandId = randomUUID();
    const generation = randomUUID();
    try {
      store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256: hash({ value: 1 }),
        workerGeneration: generation
      }, () => ({ result: { value: 1 } }));
      expect(() => store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256: hash({ value: 2 }),
        workerGeneration: generation
      }, () => ({ result: { value: 2 } }))).toThrow(/STATE_COMMAND_CONFLICT/);
    } finally {
      store.close();
    }
  });

  it("rolls back the mutation when its receipt result is invalid", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      expect(() => store.executeOperationalCommand({
        commandId: randomUUID(),
        operation: "probe",
        payloadSha256: hash({ value: 1 }),
        workerGeneration: randomUUID()
      }, () => {
        store.setMeta("receipt_probe", "must-rollback");
        return { result: { oversized: "x".repeat(70 * 1024) } };
      })).toThrow(/STATE_COMMAND_RESULT_TOO_LARGE/);
      expect(store.getMeta("receipt_probe")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("persists receipts across a clean state-owner restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "operational-receipt-restart-"));
    const file = path.join(root, "state.sqlite");
    const commandId = randomUUID();
    const payloadSha256 = hash({ operation: "probe" });
    try {
      let store = new BridgeStateStore({ file });
      store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        workerGeneration: randomUUID()
      }, () => ({ result: { retained: true } }));
      store.close();

      store = new BridgeStateStore({ file });
      expect(store.getOperationalCommandReceipt(commandId)).toMatchObject({
        operation: "probe",
        payloadSha256,
        result: { retained: true }
      });
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
