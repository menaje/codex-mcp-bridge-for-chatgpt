import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { EVENT_RETENTION_LIMITS } from "../src/eventRetention.js";
const scopeId="11111111-1111-4111-8111-111111111111";
const job=(id="job")=>({jobId:id,requestId:`request-${id}`,scopeId,status:"running",updatedAt:Date.now(),createdAt:Date.now()-1000});
const progress=(itemId:string, output="text")=>({type:"command",phase:"completed",summary:"command complete",details:{itemId,outputTail:output}});

describe("bounded diagnostic retention",()=>{
  it("records progress without rewriting the full Job document",()=>{
    const file=path.join(mkdtempSync(path.join(tmpdir(),"event-write-path-")),"state.sqlite");
    const store=new BridgeStateStore({file});
    const input={...job(),version:1,lastProgressAt:10,result:{content:[{type:"text",text:"retained result"}]}};
    store.upsertJob(input);
    const db=new Database(file);
    const before=(db.prepare("SELECT payload FROM jobs WHERE job_id=?").get(input.jobId) as {payload:string}).payload;

    store.recordJobTelemetryEvent(
      input.jobId,
      "app-command-completed",
      progress("bounded"),
      20,
      undefined,
      {
        updatedAt:20,
        version:2,
        lastProgressAt:20,
        lastProgress:{phase:"completed"},
        pendingInteractions:[{interactionId:"input",isBlocking:true}]
      }
    );

    const after=db.prepare(`SELECT payload,updated_at,job_version,last_progress
      FROM jobs WHERE job_id=?`).get(input.jobId) as {
        payload:string;updated_at:number;job_version:number;last_progress:string;
      };
    expect(after.payload).toBe(before);
    expect(after).toMatchObject({updated_at:20,job_version:2});
    expect(JSON.parse(after.last_progress)).toEqual({phase:"completed"});
    expect(db.prepare("SELECT interaction_id,is_blocking,payload FROM job_interactions WHERE job_id=?").all(input.jobId))
      .toEqual([{interaction_id:"input",is_blocking:1,payload:"{}"}]);
    expect((store.listJobs() as Array<{pendingInteractions:unknown[]}>)[0]?.pendingInteractions)
      .toEqual([{interactionId:"input",isBlocking:true}]);
    expect(JSON.parse(after.payload)).not.toHaveProperty("pendingInteractions");
    db.close();store.close();
  });

  it("coalesces one item's snapshots, keeps cursor order and preserves usage after result expiry",()=>{
    const store=new BridgeStateStore({file:":memory:"});const input=job();store.upsertJob(input);
    store.recordJobTelemetryEvent(input.jobId,"app-command-started",{...progress("same"),phase:"started"});
    const first=store.listJobEvents(input.jobId).at(-1)!.eventId;
    for(let n=0;n<600;n++) store.recordJobTelemetryEvent(input.jobId,"app-command-completed",progress(`item-${n}`,"x".repeat(20_000)));
    store.recordJobTelemetryEvent(input.jobId,"app-command-completed",progress("same"));
    const events=store.listJobEvents(input.jobId);
    expect(events.length).toBeLessThanOrEqual(EVENT_RETENTION_LIMITS.perJob);
    expect(events.at(-1)!.eventId).toBeGreaterThan(first);
    expect(events.every(event=>Buffer.byteLength(JSON.stringify(event.payload))<=EVENT_RETENTION_LIMITS.payloadBytes)).toBe(true);
    const tokens={inputTokens:3000,cachedInputTokens:2500,outputTokens:100,totalTokens:3100};
    store.recordJobTelemetryEvent(input.jobId,"app-usage-updated",{type:"usage",phase:"updated",details:{total:{inputTokens:999999},jobUsage:{basis:"cumulative-difference",tokens}}});
    store.upsertJob({...input,status:"completed",updatedAt:Date.now()});
    store.deleteJob(input.jobId);
    expect(store.eventRetention.summary(input.jobId)).toEqual({
      usage:{basis:"cumulative-difference",tokens}
    });
    expect(store.listJobEvents(input.jobId)).toHaveLength(1);
    expect(JSON.stringify(store.listJobEvents(input.jobId))).not.toContain("outputTail");
    expect(store.listDashboardRetainedJobs()[0]?.jobId).toBe(input.jobId);
    expect(()=>store.upsertJob({...input,jobId:"duplicate",status:"running"})).toThrow(/request/i);
    store.close();
  });

  it("protects pending results and renewable holds while bounding their progress output",()=>{
    const store=new BridgeStateStore({file:":memory:"});const input=job();store.upsertJob(input);
    expect(store.retentionProtection(input.jobId)).toContain("active-work");
    store.upsertJob({...input,status:"completed"});
    store.holdResult(input.jobId,"waiting for review",Date.now()+60_000);
    store.deleteJob(input.jobId);expect(store.countJobs()).toBe(1);
    expect(store.retentionProtection(input.jobId)).toContain("user-hold");
    store.releaseResultHold(input.jobId);store.deleteJob(input.jobId);expect(store.countJobs()).toBe(0);
    expect(()=>store.holdResult(input.jobId,"cannot restore",Date.now()+1000)).toThrow(/NOT_RETAINED/);
    store.close();
  });

  it("keeps undelivered output, blocking input and uncertain dispatch independently of diagnostic cleanup",()=>{
    const file=path.join(mkdtempSync(path.join(tmpdir(),"event-protection-")),"state.sqlite");
    const store=new BridgeStateStore({file}),input=job();store.upsertJob({...input,status:"completed",result:{content:[{type:"text",text:"retained answer"}]}});
    const db=new Database(file),activity=(db.prepare("SELECT activity_id FROM jobs WHERE job_id=?").get(input.jobId) as {activity_id:string}).activity_id;
    db.prepare("INSERT INTO completion_outbox(activity_id,scope_id,completion_version,channel,payload,created_at) VALUES (?,?,1,'notify','{}',?)").run(activity,scopeId,Date.now());
    expect(store.retentionProtection(input.jobId)).toContain("undelivered-result");
    store.deleteJob(input.jobId);expect(store.countJobs()).toBe(1);
    db.prepare("UPDATE completion_outbox SET delivered_at=? WHERE activity_id=?").run(Date.now(),activity);
    const requestId="22222222-2222-4222-8222-222222222222",actionHash="a".repeat(64);
    store.beginSteeringDelivery({scopeId,requestId,actionHash,jobId:input.jobId,expectedJobVersion:1,promptSha256:"b".repeat(64),now:Date.now()});
    expect(()=>store.acknowledgeUncertainResultReview(input.jobId)).toThrow(/RESULT_REVIEW_PENDING/);
    store.markSteeringDeliveryDispatching(scopeId,requestId,actionHash,Date.now());
    store.completeSteeringDelivery(scopeId,requestId,actionHash,"uncertain",{delivery:{status:"uncertain"}},Date.now());
    store.maintainRetention();store.deleteJob(input.jobId);
    expect(store.retentionProtection(input.jobId)).toContain("uncertain-response");expect(store.countJobs()).toBe(1);
    expect(store.getSteeringDelivery(scopeId,requestId)?.status).toBe("uncertain");
    const blocked=job("blocked-input");store.upsertJob({...blocked,status:"completed",pendingInteractions:[{interactionId:"question",isBlocking:true}]});
    store.deleteJob(blocked.jobId);expect(store.retentionProtection(blocked.jobId)).toContain("pending-interaction");
    store.upsertJob({...blocked,status:"completed",pendingInteractions:[]});store.deleteJob(blocked.jobId);
    expect(store.countJobs()).toBe(1);
    store.acknowledgeUncertainResultReview(input.jobId);
    expect(store.retentionProtection(input.jobId)).not.toContain("uncertain-response");
    // Review does not rewrite dispatch history or authorize another delivery.
    expect(store.getSteeringDelivery(scopeId,requestId)?.status).toBe("uncertain");
    expect(()=>store.markSteeringDeliveryDispatching(scopeId,requestId,actionHash)).toThrow(/uncertain/);
    const laterRequest="33333333-3333-4333-8333-333333333333";
    store.beginSteeringDelivery({scopeId,requestId:laterRequest,actionHash,jobId:input.jobId,expectedJobVersion:1,promptSha256:"b".repeat(64),now:Date.now()});
    store.completeSteeringDelivery(scopeId,laterRequest,actionHash,"uncertain",{delivery:{status:"uncertain"}},Date.now());
    expect(store.retentionProtection(input.jobId)).toContain("uncertain-response");
    store.acknowledgeUncertainResultReview(input.jobId);
    store.deleteJob(input.jobId);expect(store.countJobs()).toBe(0);db.close();store.close();
  });

  it("enforces the global byte budget independently of per-job limits and makes freed pages reusable",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"event-budget-")),file=path.join(directory,"state.sqlite");
    const store=new BridgeStateStore({file});const input=job();store.upsertJob(input);
    const db=new Database(file);const activity=(db.prepare("SELECT activity_id FROM jobs WHERE job_id=?").get(input.jobId) as {activity_id:string}).activity_id;
    const insert=db.prepare("INSERT INTO job_events(job_id,activity_id,scope_id,scope_version,event_type,status,created_at,payload) VALUES (?,?,?,1,'diagnostic','completed',?,?)");
    db.transaction(()=>{for(let value=0;value<9000;value++)insert.run(input.jobId,activity,scopeId,Date.now(),JSON.stringify({message:"x".repeat(8100),value}));})();
    store.recordJobTelemetryEvent(input.jobId,"app-command-completed",progress("new"));
    const report=store.maintainRetention();expect(report.bytes).toBeLessThanOrEqual(EVENT_RETENTION_LIMITS.bytes);expect(report.rows).toBeLessThanOrEqual(EVENT_RETENTION_LIMITS.rows);expect(report.freePages).toBeGreaterThan(0);
    db.close();store.close();
  });
});
