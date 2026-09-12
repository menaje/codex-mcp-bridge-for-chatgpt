import { describe, expect, it } from "vitest";
import { OriginWaits } from "../src/originWait.js";

const job = {jobId:"job-a",scopeId:"scope-a",requestId:"original-request-a",status:"running"};

describe("original GPT wait routing", () => {
  it("routes a new failure only to the active original call and closes its lease exactly once", () => {
    const waits = new OriginWaits();
    const lease = waits.beginTask(job,"call-a");
    const result = waits.finish(lease,{...job,status:"failed",error:"task failed"});
    expect(result.recovery).toMatchObject({jobId:job.jobId,originRequestId:job.requestId,outcome:"failed",actionScope:"original-job-only"});
    expect(result).not.toHaveProperty("waitContext");
    expect(waits.finish(lease,{...job,status:"failed"})).toEqual({});
    expect(waits.finish(undefined,{...job,status:"failed"})).toEqual({});
  });

  it("permanently ends the lease when the original callback returns, including while work is still running", () => {
    const waits = new OriginWaits();
    const lease = waits.beginTask(job,"original-task-call");
    expect(waits.finish(lease,job)).toEqual({});
    // Even the same Job/request cannot recover a closed original callback.
    expect(waits.finish(lease,{...job,status:"failed"})).toEqual({});
    expect(waits).not.toHaveProperty("beginWait");
  });

  it("rejects other work, detached callbacks and pre-existing failures", () => {
    const waits = new OriginWaits();
    for (const target of [{...job,jobId:"job-b"},{...job,scopeId:"scope-b"},{...job,requestId:"request-b"}]) {
      expect(waits.finish(waits.beginTask(job,"original-call"),{...target,status:"failed"})).toEqual({});
    }
    const abort = new AbortController(), detached = waits.beginTask(job,"detached",abort.signal);
    abort.abort();
    expect(waits.finish(detached,{...job,status:"failed"})).toEqual({});
    const abandoned = waits.beginTask(job,"abandoned");waits.abandon(abandoned);
    expect(waits.finish(abandoned,{...job,status:"failed"})).toEqual({});
    const historical = {...job,status:"failed"};
    expect(waits.finish(waits.beginTask(historical,"late-call"),historical)).toEqual({});
  });

  it("includes only this Job's verified bridge actions and grants no process-control authority", () => {
    const waits = new OriginWaits();
    const common = {kind:"release" as const,state:"resolved" as const,attempts:1,createdAt:1,updatedAt:2,nextAttemptAt:0,
      agentId:"agent-a",key:"record",reason:"idle-connection-released",evidence:"thread-unloaded"};
    const result = waits.finish(waits.beginTask(job,"wait-a"),{...job,status:"failed"},[
      {...common,jobId:job.jobId,scopeId:job.scopeId},
      {...common,jobId:"another-job",scopeId:job.scopeId},
      {...common,jobId:job.jobId,scopeId:"another-scope"}
    ]);
    expect(result.recovery?.automaticActions).toHaveLength(1);
    expect(result.recovery?.automaticActions[0]).toMatchObject({evidence:"thread-unloaded"});
    expect(result.recovery?.nextActions.join(" ")).toContain("no cancellation");
    expect(result.recovery?.outcome).toBe("failed");
  });
});
