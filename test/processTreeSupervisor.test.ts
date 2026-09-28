import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { processObservationFailure, readProcessTable, SupervisedProcessTreeRegistry } from "../src/processTreeSupervisor.js";

describe("supervised process table observation", () => {
  it("does not signal a reused PID/PGID with a different birth stamp", async () => {
    const pid = 999_991;
    let startedAt: string | undefined;
    const registry = new SupervisedProcessTreeRegistry(async () => [{
      pid, parentPid: 1, processGroupId: pid, state: "S", startedAt
    }]);
    registry.remember({ pid, processGroupId: pid });
    registry.merge({ root: { pid, processGroupId: pid }, rootExited: true,
      processes: [{ pid, parentPid: 1, processGroupId: pid, startedAt: "original incarnation" }] });
    const signal = vi.spyOn(process, "kill");
    try {
      await registry.refresh();
      expect(registry.snapshots()[0]?.processes[0]?.startedAt).toBe("original incarnation");
      startedAt = "new incarnation";
      expect(await registry.release({ pid, processGroupId: pid }, 0)).toBe(false);
      expect(signal).not.toHaveBeenCalled();
      expect(registry.size).toBe(1);
    } finally { signal.mockRestore(); }
  });

  it("does not treat unknown or ledger-limit observation as worker death", async () => {
    const registry = new SupervisedProcessTreeRegistry(async () => { throw new Error("unknown observer fault"); });
    const identity = { pid: 999_990, processGroupId: 999_990 };
    registry.remember(identity, true);
    await expect(registry.refresh()).rejects.toThrow(/unknown/);
    expect(registry.size).toBe(1);
    expect(await registry.cleanupAll(0)).toBe(false);
    expect(registry.size).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "retains a verified reparented child through one missing birth stamp",
    async () => {
      const pid = 999_970;
      const childPid = 999_971;
      const identity = { pid, processGroupId: pid };
      const root = { pid, parentPid: 1, processGroupId: pid,
        state: "S", startedAt: "root incarnation" };
      const child = { pid: childPid, parentPid: pid, processGroupId: childPid,
        state: "S", startedAt: "child incarnation" };
      let rows: Array<{ pid: number; parentPid: number; processGroupId: number;
        state: string; startedAt?: string }> = [root, child];
      const registry = new SupervisedProcessTreeRegistry(async () => rows);
      await registry.register(identity);
      expect(registry.capturedProcessCount).toBe(2);
      registry.markExited(identity);
      rows = [{ ...child, parentPid: 1, startedAt: undefined }];
      await registry.refresh();
      registry.merge({ root: identity, rootExited: true, processes: [{
        pid: childPid, parentPid: 1, processGroupId: childPid
      }] });
      expect(registry.snapshots()[0]?.processes).toEqual([expect.objectContaining({
        pid: childPid, startedAt: "child incarnation"
      })]);

      const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        expect(await registry.release(identity, 0)).toBe(false);
        expect(signal).not.toHaveBeenCalled();
        expect(registry.size).toBe(1);

        rows = [{ ...child, parentPid: 1 }];
        await registry.refresh();
        expect(registry.snapshots()[0]?.processes).toEqual([expect.objectContaining({
          pid: childPid, startedAt: "child incarnation"
        })]);
        signal.mockImplementation(() => { rows = []; return true; });
        expect(await registry.release(identity, 0)).toBe(true);
        expect(signal).toHaveBeenCalledWith(childPid, "SIGTERM");
        expect(registry.size).toBe(0);
      } finally { signal.mockRestore(); }
    }
  );

  it.skipIf(process.platform === "win32")(
    "reclaims verified exited children without exhausting a live tree's ledger",
    async () => {
      const pid = 999_980;
      const identity = { pid, processGroupId: pid };
      const root = { ...identity, parentPid: 1, state: "S", startedAt: "root" };
      let rows = [root];
      const registry = new SupervisedProcessTreeRegistry(async () => rows);
      await registry.register(identity);
      for (let batch = 0; batch < 41; batch += 1) {
        rows = [root, ...Array.from({ length: 100 }, (_, index) => ({
          pid: 800_000 + batch * 100 + index, parentPid: pid,
          processGroupId: pid, state: "S", startedAt: `${batch}:${index}`
        }))];
        await registry.refresh();
        expect(registry.capturedProcessCount).toBe(101);
      }
      rows = [root];
      await registry.refresh();
      expect(registry.capturedProcessCount).toBe(1);
      rows = [root, { pid: 899_999, parentPid: pid, processGroupId: pid,
        state: "S", startedAt: "next" }];
      await registry.refresh();
      expect(registry.capturedProcessCount).toBe(2);
      registry.forget(identity);
    }
  );
  it.skipIf(process.platform === "win32")(
    "settles a completed probe across the 1.0 to 1.25 second pause boundary",
    async () => {
      for (const pauseMs of [1_000, 1_100, 1_200]) {
        const pending = readProcessTable();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
        const rows = await pending;
        expect(rows.some(row => row.pid === process.pid)).toBe(true);
      }
    },
    10_000
  );

  it.skipIf(process.platform === "win32")(
    "does not time out an in-flight probe after the supervisor event loop pauses",
    async () => {
      const pending = readProcessTable();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
      const rows = await pending;
      expect(rows.some(row => row.pid === process.pid)).toBe(true);
    },
    10_000
  );

  it.skipIf(process.platform === "win32")(
    "bounds a genuinely hung probe and records a sanitized timeout diagnostic",
    async () => {
      const probe = spawn("/bin/sleep", ["6"], { stdio: ["ignore", "pipe", "pipe"] });
      const closed = once(probe, "close");
      const startedAt = Date.now();
      const error = await readProcessTable(() => probe).catch(error => error);
      expect(processObservationFailure(error)).toMatchObject({
        kind: "ps-timeout", psExitCode: null, osCode: null,
        durationMs: expect.any(Number), timerLatenessMs: expect.any(Number)
      });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      await closed;
    },
    10_000
  );

  it.skipIf(process.platform === "win32")(
    "records the ps exit status without exposing stderr",
    async () => {
      const error = await readProcessTable(() => spawn(
        "/bin/sh", ["-c", "echo private-detail >&2; exit 7"],
        { stdio: ["ignore", "pipe", "pipe"] }
      )).catch(error => error);
      expect(processObservationFailure(error)).toMatchObject({
        kind: "ps-exit", psExitCode: 7
      });
      expect(String(error)).not.toContain("private-detail");
    },
    10_000
  );

  it.skipIf(process.platform === "win32")(
    "rejects malformed process rows instead of accepting an incomplete tree",
    async () => {
      for (const output of ["not-a-process-row\n", "999 1 999 S\n"]) {
        const error = await readProcessTable(() => spawn(
          process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`],
          { stdio: ["ignore", "pipe", "pipe"] }
        )).catch(error => error);
        expect(processObservationFailure(error).kind).toBe("ps-output-invalid");
      }
    },
    10_000
  );
});
