import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/v4";
import type { AutomaticRecoveryRecord } from "./automaticRecovery.js";

export const originWaitTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .describe("Single-use wait token from this task's originating call or its preceding wait. It never authorizes another Job or a later unrelated GPT response.");
export const originWaitContinuationSchema = z.strictObject({
  token:originWaitTokenSchema,jobId:z.string(),originRequestId:z.string(),expiresAt:z.number().int().positive()
});
export const liveRecoverySchema = z.strictObject({
  kind:z.literal("origin-wait-recovery"),jobId:z.string(),originRequestId:z.string(),waitRequestDigest:z.string(),
  outcome:z.enum(["failed","interrupted","termination-failed"]),
  actionScope:z.literal("original-job-only"),reason:z.string(),
  automaticActions:z.array(z.strictObject({kind:z.enum(["release","recheck","retry-stop"]),state:z.enum(["retrying","resolved","blocked"]),
    attempts:z.number().int().min(1),reason:z.string(),evidence:z.string().optional()})),
  nextActions:z.array(z.string())
});
export type OriginWaitContinuation = z.infer<typeof originWaitContinuationSchema>;
export type LiveRecovery = z.infer<typeof liveRecoverySchema>;
export type OriginJob = { jobId:string;scopeId:string;requestId:string;status:string;error?:string };
type Context = { jobId:string;scopeId:string;originRequestId:string;expiresAt:number };
export type OriginWaitLease = Context & {requestDigest:string;signal?:AbortSignal;observing:boolean;closed:boolean};
const CONTINUATION_GAP_MS = 90_000;

/** Only live MCP callbacks hold a lease. Tokens bridge short bounded waits;
 * they are never persisted, listed by status, or reissued on task replay. */
export class OriginWaits {
  private readonly continuations = new Map<string,Context>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  beginTask(job: OriginJob, requestId: unknown, signal?: AbortSignal): OriginWaitLease {
    return {...this.context(job),requestDigest:this.digest(requestId),signal,observing:true,closed:false};
  }

  beginWait(token: string | undefined, job: OriginJob, scopeId: string, requestId: unknown, waiting: boolean, signal?: AbortSignal): OriginWaitLease | undefined {
    this.prune();
    if (!token) return;
    const context = this.continuations.get(token);
    if (!context || context.scopeId !== scopeId || context.jobId !== job.jobId || context.originRequestId !== job.requestId || context.expiresAt <= this.now()) {
      throw new Error("ORIGIN_WAIT_EXPIRED: This is not the original active wait context. Read the exact Job without a waitToken to retrieve its state; no recovery judgment was dispatched.");
    }
    if (!waiting) throw new Error("ORIGIN_WAIT_REQUIRED: A recovery context belongs only to a bounded wait for its exact Job.");
    this.continuations.delete(token);
    return {...context,requestDigest:this.digest(requestId),signal,
      // A historical read cannot turn an already ended Job into a live incident.
      observing:["running","terminating"].includes(job.status),closed:false};
  }

  finish(lease: OriginWaitLease | undefined, job: OriginJob, records: AutomaticRecoveryRecord[] = []): {
    waitContext?: OriginWaitContinuation; recovery?: LiveRecovery
  } {
    if (!lease || lease.closed) return {};
    lease.closed = true;
    if (lease.signal?.aborted || lease.scopeId !== job.scopeId || lease.jobId !== job.jobId || lease.originRequestId !== job.requestId) return {};
    const active = ["running","terminating","termination-failed"].includes(job.status);
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
    if (!active) return recovery ? {recovery} : {};
    this.prune();
    const token = randomBytes(32).toString("base64url"), context = this.context(job);
    this.continuations.set(token,context);
    return {waitContext:{token,jobId:job.jobId,originRequestId:job.requestId,expiresAt:context.expiresAt},...(recovery ? {recovery} : {})};
  }

  abandon(lease: OriginWaitLease | undefined): void { if (lease) lease.closed = true; }
  private context(job: OriginJob): Context { return {jobId:job.jobId,scopeId:job.scopeId,originRequestId:job.requestId,expiresAt:this.now()+CONTINUATION_GAP_MS}; }
  private digest(requestId: unknown): string { return createHash("sha256").update(JSON.stringify(["mcp-wait",String(requestId)])).digest("hex"); }
  private prune(): void {
    for (const [token,context] of this.continuations) if (context.expiresAt <= this.now()) this.continuations.delete(token);
    // Live Job admission already has a tighter concurrency limit. Never grow
    // an unbounded registry through abandoned foreground/background results.
    while (this.continuations.size >= 256) this.continuations.delete(this.continuations.keys().next().value!);
  }
}
