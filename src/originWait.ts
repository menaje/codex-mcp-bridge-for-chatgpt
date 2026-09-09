import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { AutomaticRecoveryRecord } from "./automaticRecovery.js";

export const originWaitTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .describe("Ignored legacy token. Status and input waits never dispatch recovery judgment.");
export const liveRecoverySchema = z.strictObject({
  kind:z.literal("origin-wait-recovery"),jobId:z.string(),originRequestId:z.string(),waitRequestDigest:z.string(),
  outcome:z.enum(["failed","interrupted","termination-failed"]),
  actionScope:z.literal("original-job-only"),reason:z.string(),
  automaticActions:z.array(z.strictObject({kind:z.enum(["release","recheck","retry-stop"]),state:z.enum(["retrying","resolved","blocked"]),
    attempts:z.number().int().min(1),reason:z.string(),evidence:z.string().optional()})),
  nextActions:z.array(z.string())
});
export type LiveRecovery = z.infer<typeof liveRecoverySchema>;
export type OriginJob = { jobId:string;scopeId:string;requestId:string;status:string;error?:string };
export type OriginWaitLease = { jobId:string;scopeId:string;originRequestId:string;requestDigest:string;signal?:AbortSignal;observing:boolean;closed:boolean };

/** A lease never survives its original foreground task callback. The host has
 * no response identity/end signal, so no later MCP call can inherit a lease. */
export class OriginWaits {
  beginTask(job: OriginJob, requestId: unknown, signal?: AbortSignal): OriginWaitLease {
    return {jobId:job.jobId,scopeId:job.scopeId,originRequestId:job.requestId,
      requestDigest:this.digest(requestId),signal,observing:["running","terminating"].includes(job.status),closed:false};
  }

  finish(lease: OriginWaitLease | undefined, job: OriginJob, records: AutomaticRecoveryRecord[] = []): {
    recovery?: LiveRecovery
  } {
    if (!lease || lease.closed) return {};
    lease.closed = true;
    if (lease.signal?.aborted || lease.scopeId !== job.scopeId || lease.jobId !== job.jobId || lease.originRequestId !== job.requestId) return {};
    const recovery = lease.observing && ["failed","interrupted","termination-failed"].includes(job.status) ? {
      kind:"origin-wait-recovery" as const,jobId:job.jobId,originRequestId:job.requestId,waitRequestDigest:lease.requestDigest,
      outcome:job.status as LiveRecovery["outcome"],actionScope:"original-job-only" as const,
      reason:job.error?.slice(0,512) || "The originally awaited Codex execution did not complete successfully.",
      automaticActions:records.filter(record => record.jobId === job.jobId && record.scopeId === job.scopeId).slice(0,6)
        .map(({kind,state,attempts,reason,evidence}) => ({kind,state,attempts,reason,...(evidence ? {evidence} : {})})),
      nextActions:[
        "Assess this exact Job's failure within the original user's task. Continue or retry only when that task's existing authorization supports it; preserve the failed outcome.",
        "Bridge cleanup evidence does not prove the task succeeded. Verify the intended result after any continuation.",
        "This receipt grants no cancellation, permission-change, other-Job, other-conversation, or host-wake authority. If this GPT response ends, do not route the incident to another GPT execution."
      ]
    } : undefined;
    return recovery ? {recovery} : {};
  }

  abandon(lease: OriginWaitLease | undefined): void { if (lease) lease.closed = true; }
  private digest(requestId: unknown): string { return createHash("sha256").update(JSON.stringify(["mcp-wait",String(requestId)])).digest("hex"); }
}
