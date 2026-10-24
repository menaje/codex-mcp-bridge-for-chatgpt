import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { readProcessTable, terminateManagedProcessTree } from "../src/macosHelperServer.js";

afterEach(() => vi.restoreAllMocks());

function inspection() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true)
  });
  const inspect = vi.fn(() => child);
  return { child, inspect: inspect as unknown as typeof spawn, calls: inspect };
}

it("rejects an already expired absolute budget before starting an inspection", async () => {
  const f = inspection();
  await expect(readProcessTable(Date.now() - 1, f.inspect)).rejects.toThrow("PROCESS_TABLE_TIMEOUT");
  expect(f.calls).not.toHaveBeenCalled();
  expect(f.child.kill).not.toHaveBeenCalled();
});

it("does not signal a captured runtime when its original cleanup deadline is already exhausted", async () => {
  const signal = vi.spyOn(process, "kill");
  const authorize = vi.fn();
  await expect(terminateManagedProcessTree([
    { pid: 123456, parentPid: 1, processGroupId: 123456 }
  ], Date.now() - 1, authorize)).rejects.toThrow("PROCESS_CLEANUP_DEADLINE");
  expect(signal).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

it("bounds a stalled inspection by the production two-second per-call cap without waiting for close", async () => {
  const f = inspection();
  // Real production cap: no fake clocks or shortened endurance substitute.
  await expect(readProcessTable(Infinity, f.inspect)).rejects.toThrow("PROCESS_TABLE_TIMEOUT");
  expect(f.calls).toHaveBeenCalledWith("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("uses only remaining absolute time for a stalled inspection near an existing deadline", async () => {
  const f = inspection();
  // A near-expiry query boundary, not a new whole-start budget or fake clock.
  const deadlineAt = Date.now() + 300;
  const timer = vi.spyOn(globalThis, "setTimeout");
  await expect(readProcessTable(deadlineAt, f.inspect)).rejects.toThrow("PROCESS_TABLE_TIMEOUT");
  const allowed = Number(timer.mock.calls[0]?.[1]);
  expect(allowed).toBeGreaterThan(0);
  expect(allowed).toBeLessThanOrEqual(300);
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("a late close after timeout cannot turn partial output into cleanup permission", async () => {
  const f = inspection();
  const observed = readProcessTable(Date.now() + 300, f.inspect);
  f.child.stdout.write("100 1 100\n");
  await expect(observed).rejects.toThrow("PROCESS_TABLE_TIMEOUT");
  f.child.emit("close", 0);
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it.each(["", "not-a-process-row\n", "100 1 100\ninvalid\n", "2 0 -1\n"])("rejects empty or malformed process observations instead of confirming cleanup: %j", async output => {
  const f = inspection();
  const observed = readProcessTable(Date.now() + 5_000, f.inspect);
  const rejected = expect(observed).rejects.toThrow(/empty|format/);
  f.child.stdout.write(output); f.child.emit("close", 0);
  await rejected;
});

it.skipIf(process.platform === "win32")("observes kernel PGID zero but refuses to signal it", async () => {
  const f = inspection();
  const observed = readProcessTable(Date.now() + 5_000, f.inspect);
  f.child.stdout.write("2 0 0\n100 1 100\n"); f.child.emit("close", 0);
  const rows = await observed;
  expect(rows).toEqual([
    { pid: 2, parentPid: 0, processGroupId: 0 }, { pid: 100, parentPid: 1, processGroupId: 100 }
  ]);
  const next = inspection();
  const signal = vi.spyOn(process, "kill");
  const stopped = terminateManagedProcessTree([rows[0]!], Date.now() + 5_000, undefined, next.inspect);
  const rejected = expect(stopped).rejects.toThrow("Refusing to signal unsafe managed process group 0");
  next.child.stdout.write("2 0 0\n100 1 100\n"); next.child.emit("close", 0);
  await rejected;
  expect(signal).not.toHaveBeenCalled();
});

it("rejects oversized output immediately even when the inspector never closes", async () => {
  const f = inspection();
  const observed = readProcessTable(Date.now() + 5_000, f.inspect);
  const rejected = expect(observed).rejects.toThrow("output exceeded");
  f.child.stdout.write(Buffer.alloc(4 * 1_024 * 1_024 + 1));
  await rejected;
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("returns a completed valid observation and removes its timeout", async () => {
  const f = inspection();
  const timer = vi.spyOn(globalThis, "setTimeout"), cleared = vi.spyOn(globalThis, "clearTimeout");
  const observed = readProcessTable(Date.now() + 5_000, f.inspect);
  f.child.stdout.write("100 1 100\n101 100 100\n"); f.child.emit("close", 0);
  await expect(observed).resolves.toEqual([
    { pid: 100, parentPid: 1, processGroupId: 100 }, { pid: 101, parentPid: 100, processGroupId: 100 }
  ]);
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(cleared).toHaveBeenCalledWith(timer.mock.results[0]?.value);
});

it.each(["error", "nonzero", "signal", "invalid-stderr"] as const)("clears the inspection timer on %s without confirming cleanup", async mode => {
  const f = inspection();
  const timer = vi.spyOn(globalThis, "setTimeout"), cleared = vi.spyOn(globalThis, "clearTimeout");
  const observed = readProcessTable(Date.now() + 5_000, f.inspect);
  const rejected = expect(observed).rejects.toThrow();
  if (mode === "error") f.child.emit("error", new Error("fixture inspector failure"));
  else {
    if (mode === "invalid-stderr") f.child.stderr.write(Buffer.from([0xff]));
    f.child.emit("close", mode === "signal" ? null : 1);
  }
  await rejected;
  expect(cleared).toHaveBeenCalledWith(timer.mock.results[0]?.value);
  if (mode === "error") {
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(() => f.child.emit("error", new Error("late inspector error"))).not.toThrow();
    expect(f.child.kill).toHaveBeenCalledOnce();
  }
  else expect(f.child.kill).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32").each([false, true])("owner change after TERM prevents KILL despite a still-running captured group (last poll stalls: %s)", async stalls => {
  let owner = "A";
  let termAt = 0;
  let stalled = false;
  const signal = vi.spyOn(process, "kill").mockImplementation((_pid, sent) => {
    if (sent === "SIGTERM") { owner = "B"; termAt = Date.now(); }
    return true;
  });
  const inspector = (() => {
    const f = inspection();
    if (stalls && !stalled && termAt > 0 && Date.now() - termAt >= 2_000) {
      stalled = true;
      return f.child as unknown as ChildProcess;
    }
    queueMicrotask(() => { f.child.stdout.write("123456 1 123456\n"); f.child.emit("close", 0); });
    return f.child as unknown as ChildProcess;
  }) as typeof spawn;
  const authorize = () => { if (owner !== "A") throw new Error("STARTUP_OWNERSHIP_UNCONFIRMED"); };
  // Uses the unchanged real three-second TERM stage; not a compressed run.
  await expect(terminateManagedProcessTree([{ pid: 123456, parentPid: 1, processGroupId: 123456 }],
    Date.now() + 10_000, authorize, inspector)).rejects.toThrow("STARTUP_OWNERSHIP_UNCONFIRMED");
  expect(signal.mock.calls.map(call => call[1])).toEqual(["SIGTERM"]);
  expect(stalled).toBe(stalls);
});
