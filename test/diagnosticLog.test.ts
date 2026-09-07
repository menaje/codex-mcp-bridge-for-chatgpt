import { describe, expect, it } from "vitest";
import { DiagnosticLog } from "../src/diagnosticLog.js";

describe("bounded in-memory diagnostic retention", () => {
  it("expires idle logs on read and bounds UTF-8 bytes rather than character count", () => {
    let now = 0;
    const log = new DiagnosticLog<{ at: string; message: string }>({ maxEntries: 200, maxBytes: 100, retentionMs: 60, now: () => now });
    log.append({ at: "0", message: "가".repeat(20) }); // 83 UTF-8 bytes
    log.append({ at: "0", message: "new" });
    expect(log.recent(200)).toEqual([{ at: "0", message: "new" }]);
    now = 60;
    expect(log.recent(200)).toEqual([]);
  });

  it("keeps the newest entries, omits oversized records, and does not let callers mutate retained logs", () => {
    const log = new DiagnosticLog<{ at: string; message: string }>({ maxEntries: 2, maxBytes: 100, retentionMs: 60, now: () => 0 });
    for (const message of ["one", "two", "three", "x".repeat(150)]) log.append({ at: "0", message });
    expect(log.recent(10).map(row => row.message)).toEqual(["two", "three"]);
    log.recent(1)[0].message = "mutated";
    expect(log.recent(1)[0].message).toBe("three");
    expect(log.recent(0)).toEqual([]);
  });

  it("rejects invalid retention configuration", () => {
    for (const maxBytes of [0, -1, NaN, Infinity, 2.5]) {
      expect(() => new DiagnosticLog({ maxEntries: 200, maxBytes, retentionMs: 60 })).toThrow("Invalid diagnostic log limit");
    }
  });
});
