import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { processObservationFailure, readProcessTable } from "../src/processTreeSupervisor.js";

describe("supervised process table observation", () => {
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
      const error = await readProcessTable(() => spawn(
        process.execPath, ["-e", "process.stdout.write('not-a-process-row\\n')"],
        { stdio: ["ignore", "pipe", "pipe"] }
      )).catch(error => error);
      expect(processObservationFailure(error).kind).toBe("ps-output-invalid");
    },
    10_000
  );
});
