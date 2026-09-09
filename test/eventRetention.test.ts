import { mkdtempSync, readdirSync, statSync } from "node:fs";
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
    expect(store.eventRetention.summary(input.jobId).usage).toEqual({basis:"cumulative-difference",tokens});
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

  it("backs up before v14 and resumes archived event scrubbing in small committed batches",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"event-migration-")),file=path.join(directory,"state.sqlite");
    let store=new BridgeStateStore({file});const input=job();store.upsertJob({...input,status:"completed"});store.deleteJob(input.jobId);store.close();
    const db=new Database(file);
    const activity=(db.prepare("SELECT activity_id FROM jobs WHERE job_id=?").get(input.jobId) as {activity_id:string}).activity_id;
    db.exec("DROP TRIGGER event_budget_insert; DROP TRIGGER event_budget_update; DROP TRIGGER event_budget_delete; DROP TABLE event_budget; DROP TABLE result_holds; DROP TABLE job_summaries; DROP TABLE thread_connections; UPDATE bridge_meta SET value='13' WHERE key='schema_version';");
    const insert=db.prepare("INSERT INTO job_events(job_id,activity_id,scope_id,scope_version,event_type,status,created_at,payload) VALUES (?,?,?,1,'app-command-completed','completed',?,?)");
    db.transaction(()=>{for(let n=0;n<1250;n++)insert.run(input.jobId,activity,scopeId,Date.now(),JSON.stringify(progress(`old-${n}`,"private transcript text")));})();db.close();
    store=new BridgeStateStore({file});
    const backups=readdirSync(directory).filter(name=>name.includes("pre-v14"));expect(backups).toHaveLength(1);
    expect(statSync(path.join(directory,backups[0]!)).mode&0o777).toBe(0o600);
    const backup=new Database(path.join(directory,backups[0]!),{readonly:true});
    expect((backup.prepare("SELECT COUNT(*) count FROM job_events").get() as {count:number}).count).toBe(1251);backup.close();
    store.maintainRetention();store.close();store=new BridgeStateStore({file});
    for(let i=0;i<5;i++)store.maintainRetention();
    expect(JSON.stringify(store.listJobEvents(input.jobId))).not.toContain("private transcript text");
    expect(readdirSync(directory).filter(name=>name.includes("pre-v14"))).toHaveLength(1);
    expect(store.countJobs()).toBe(0);store.close();
  });

  it.each(["13","14"])("bounds every Job from schema %s, including a previously completed sweep, after restart",schema=>{
    const directory=mkdtempSync(path.join(tmpdir(),"event-mixed-migration-")),file=path.join(directory,"state.sqlite"),now=Date.now();
    let store=new BridgeStateStore({file});
    for(const id of ["first","second","third"])store.upsertJob({...job(id),status:"completed"});
    store.close();
    const db=new Database(file);
    if(schema==="13")db.exec("DROP TRIGGER event_budget_insert; DROP TRIGGER event_budget_update; DROP TRIGGER event_budget_delete; DROP TABLE event_budget; DROP TABLE result_holds; DROP TABLE job_summaries; DROP TABLE thread_connections; UPDATE bridge_meta SET value='13' WHERE key='schema_version';");
    db.exec("DELETE FROM job_events; DELETE FROM bridge_meta WHERE key='event_retention_policy';");
    const insert=db.prepare("INSERT INTO job_events(job_id,activity_id,scope_id,scope_version,event_type,status,created_at,payload) VALUES (?,?,?,1,'diagnostic','completed',?,?)");
    const jobs=db.prepare("SELECT job_id,activity_id FROM jobs ORDER BY job_id").all() as Array<{job_id:string;activity_id:string}>;
    db.transaction(()=>{for(const row of jobs)for(let n=0;n<(row.job_id==="first"?1:400);n++)insert.run(row.job_id,row.activity_id,scopeId,now,JSON.stringify({synthetic:n}));})();
    // This sample lies beyond the first 500-row slice but within the third Job's pruned prefix.
    const tokens={inputTokens:3000,cachedInputTokens:2500,outputTokens:100,totalTokens:3100};
    db.prepare("UPDATE job_events SET event_type='app-usage-updated',payload=? WHERE job_id='third' AND json_extract(payload,'$.synthetic')=110")
      .run(JSON.stringify({type:"usage",details:{jobUsage:{basis:"cumulative-difference",tokens}}}));
    db.exec("INSERT OR REPLACE INTO bridge_meta(key,value) SELECT 'event_retention_cursor',CAST(MAX(event_id) AS TEXT) FROM job_events;");
    db.close();
    store=new BridgeStateStore({file});
    store.maintainRetention(now);
    expect(store.listJobEvents("first")).toHaveLength(1);
    expect(store.listJobEvents("second")).toHaveLength(EVENT_RETENTION_LIMITS.perJob);
    store.close();store=new BridgeStateStore({file});
    for(let n=0;n<5;n++)store.maintainRetention(now);
    for(const id of ["second","third"])expect(store.listJobEvents(id)).toHaveLength(EVENT_RETENTION_LIMITS.perJob);
    expect(store.eventRetention.summary("third").usage).toEqual({basis:"cumulative-difference",tokens});
    expect(store.listJobs()).toHaveLength(3);
    store.close();
  });

  it("enforces the global byte budget independently of per-job limits and makes freed pages reusable",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"event-budget-")),file=path.join(directory,"state.sqlite");
    const store=new BridgeStateStore({file});const input=job();store.upsertJob(input);
    const db=new Database(file);const activity=(db.prepare("SELECT activity_id FROM jobs WHERE job_id=?").get(input.jobId) as {activity_id:string}).activity_id;
    db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<9000)
      INSERT INTO job_events(job_id,activity_id,scope_id,scope_version,event_type,status,created_at,payload)
      SELECT 'bulk-'||value,?,?,1,'diagnostic','completed',?,? FROM n`).run(activity,scopeId,Date.now(),JSON.stringify({message:"x".repeat(8100)}));
    store.recordJobTelemetryEvent(input.jobId,"app-command-completed",progress("new"));
    const report=store.maintainRetention();expect(report.bytes).toBeLessThanOrEqual(EVENT_RETENTION_LIMITS.bytes);expect(report.rows).toBeLessThanOrEqual(EVENT_RETENTION_LIMITS.rows);expect(report.freePages).toBeGreaterThan(0);
    db.close();store.close();
  });
});
