import { describe, expect, it } from "vitest";
import { bridgeExecutionContext } from "../src/executionContext.js";

describe("bridge execution context", () => {
  it("copies only the admitted binding and keeps admission separate from execution evidence", () => {
    const job = { jobId: "job", requestId: "request", activityId: "activity", agentId: "agent", contextMode: "fresh",
      scopeId: "private-scope", mcpPrincipal: "private-principal", cwd: "/private/project", result: "unreviewed output",
      error: "private failure", workerPid: 123, upstreamRequestId: "prior-turn" };
    const text = bridgeExecutionContext(job);
    expect(JSON.parse(text.split("\n")[1]!)).toEqual({ jobId: "job", requestId: "request", activityId: "activity", agentId: "agent", contextMode: "fresh" });
    for (const value of [job.scopeId, job.mcpPrincipal, job.cwd, job.result, job.error, job.upstreamRequestId]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("not proof of a previous process's ownership");
    expect(text).toContain("originating host");
    expect(text).toContain("does not turn HOLD or failed acceptance into PASS");
  });
});
