import { describe, expect, it } from "vitest";
import { OriginWaits } from "../src/originWait.js";

const job = {jobId:"job-a",scopeId:"scope-a",requestId:"original-request-a",status:"running"};

describe("original GPT wait routing", () => {
  it("routes a new failure only to the active original call and closes its lease exactly once", () => {
    const waits = new OriginWaits();
    const lease = waits.beginTask(job,"call-a");
    const result = waits.finish(lease,{...job,status:"failed",error:"task failed"});
    expect(result.recovery).toMatchObject({jobId:job.jobId,originRequestId:job.requestId,outcome:"failed",actionScope:"original-job-only"});
    expect(result.waitContext).toBeUndefined();
    expect(waits.finish(lease,{...job,status:"failed"})).toEqual({});
    expect(waits.finish(undefined,{...job,status:"failed"})).toEqual({});
  });

  it("binds single-use continuation tokens to the original Job, conversation and execution request", () => {
    const waits = new OriginWaits();
    const token = waits.finish(waits.beginTask(job,"task-call"),job).waitContext!.token;
    for (const [target,scope] of [[{...job,jobId:"job-b"},job.scopeId],[job,"scope-b"],[{...job,requestId:"another-request"},job.scopeId]] as const) {
      expect(() => waits.beginWait(token,target,scope,"wait-a",true)).toThrow(/ORIGIN_WAIT_EXPIRED/);
    }
    expect(() => waits.beginWait(token,job,job.scopeId,"read-without-wait",false)).toThrow(/ORIGIN_WAIT_REQUIRED/);
    const lease = waits.beginWait(token,job,job.scopeId,"wait-a",true);
    expect(() => waits.beginWait(token,job,job.scopeId,"overlapping-wait",true)).toThrow(/ORIGIN_WAIT_EXPIRED/);
    const next = waits.finish(lease,job).waitContext!;
    expect(next.token).not.toBe(token);
    const nextLease = waits.beginWait(next.token,job,job.scopeId,"wait-b",true);
    expect(waits.finish(nextLease,{...job,status:"interrupted"}).recovery).toMatchObject({jobId:job.jobId,outcome:"interrupted"});
  });

  it("does not revive old incidents, expired responses, detached waits or a restarted bridge", () => {
    let now = 1000;
    const waits = new OriginWaits(() => now);
    const token = waits.finish(waits.beginTask(job,"task-call"),job).waitContext!.token;
    expect(waits.beginWait(undefined,job,job.scopeId,"overview",true)).toBeUndefined();
    expect(() => new OriginWaits(() => now).beginWait(token,job,job.scopeId,"restart",true)).toThrow(/ORIGIN_WAIT_EXPIRED/);
    const historical = waits.beginWait(token,{...job,status:"failed"},job.scopeId,"late-read",true);
    expect(waits.finish(historical,{...job,status:"failed"})).toEqual({});
    const expiring = waits.finish(waits.beginTask(job,"another-original-call"),job).waitContext!;
    now = expiring.expiresAt;
    expect(() => waits.beginWait(expiring.token,job,job.scopeId,"later-gpt-response",true)).toThrow(/ORIGIN_WAIT_EXPIRED/);
    const abort = new AbortController(), detached = waits.beginTask(job,"detached",abort.signal);
    abort.abort();
    expect(waits.finish(detached,{...job,status:"failed"})).toEqual({});
    const abandoned = waits.beginTask(job,"abandoned");waits.abandon(abandoned);
    expect(waits.finish(abandoned,{...job,status:"failed"})).toEqual({});
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
