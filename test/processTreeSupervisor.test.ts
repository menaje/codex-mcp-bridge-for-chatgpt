import { describe, expect, it } from "vitest";
import { readProcessTable } from "../src/processTreeSupervisor.js";

describe("supervised process table observation", () => {
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
});
