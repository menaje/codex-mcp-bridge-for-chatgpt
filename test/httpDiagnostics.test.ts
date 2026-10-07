import { describe, expect, it } from "vitest";
import { BoundedHttpDiagnostics, type HttpObservation } from "../src/httpDiagnostics.js";

describe("bounded private HTTP evidence", () => {
  it("bounds requests and merged ingress/child records over the entire runtime lifetime", () => {
    const rows: HttpObservation[] = [];
    const diagnostics = new BoundedHttpDiagnostics(row => rows.push(row), 10_000);
    for (let index = 0; index < 200; index++) {
      const trace = diagnostics.start("ingress");
      if (index >= 128) { expect(trace).toBeUndefined(); continue; }
      for (let event = 0; event < 100; event++) trace!.record("admitted");
    }
    expect(rows).toHaveLength(128 * 32);
    expect(new Set(rows.map(row => row.requestId)).size).toBe(128);
    expect(new Set(rows.map(row => row.requestId.length))).toEqual(new Set([36]));
  });

  it("rejects unknown/invalid child IDs and reconstructs only allowlisted fields", () => {
    const rows: HttpObservation[] = [];
    const diagnostics = new BoundedHttpDiagnostics(row => rows.push(row));
    const trace = diagnostics.start("ingress")!;
    trace.outcome = "unknown";
    trace.record("caller-closed", true);
    const child = { ...rows[0], source: "child", phase: "application-response",
      prompt: "secret prompt", url: "secret URL", auth: "secret auth", body: "secret result" };
    diagnostics.receiveChild({ ...child, requestId: "public-secret" });
    diagnostics.receiveChild({ ...child, elapsedMs: Infinity });
    diagnostics.receiveChild({ ...child, phase: "secret-error-text" });
    expect(rows).toHaveLength(1);
    diagnostics.receiveChild(child);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ source: "child", outcome: "unknown", firstTermination: false });
    expect(JSON.stringify(rows)).not.toContain("secret");
    for (let event = 0; event < 100; event++) diagnostics.receiveChild(child);
    expect(rows).toHaveLength(32);
  });

  it("makes observer failure inert and rejects duplicate trusted IDs", () => {
    let calls = 0;
    const diagnostics = new BoundedHttpDiagnostics(() => { calls += 1; throw new Error("secret error"); }, 2);
    const trace = diagnostics.start("ingress")!;
    expect(() => trace.record("dispatch")).not.toThrow();
    expect(diagnostics.start("child", trace.requestId)).toBeUndefined();
    expect(diagnostics.start("child", "forged-header")).toBeUndefined();
    expect(trace.recordOnce("state-start")).toBe(true);
    expect(trace.recordOnce("state-start")).toBe(false);
    expect(calls).toBe(2);
    expect(new BoundedHttpDiagnostics(() => {}, 0).start("ingress")).toBeUndefined();
  });
});
