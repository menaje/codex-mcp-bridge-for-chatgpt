import {mkdtempSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {describe, expect, it} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {historyRetentionDays} from "../src/workHistory.js";

const scopeId="11111111-1111-4111-8111-111111111111";
const day=86400_000, now=Date.now(), old=now-40*day;
const job=(id:string)=>({jobId:id,requestId:`request-${id}`,scopeId,status:"failed",createdAt:old-1000,updatedAt:old,
  error:"old diagnostic",result:{content:[{type:"text",text:"old result"}]}});

describe("execution history retention",()=>{
  it("expires display details, preserves replay reservations, and never resurrects an expired result",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"work-history-")),file=path.join(directory,"state.sqlite");
    let store=new BridgeStateStore({file});
    const input=job("old");store.upsertJob(input);store.deleteJob(input.jobId);
    store.workHistory.acknowledge(input.jobId,old+1000);
    expect(store.workHistory.acknowledgedJobIds(scopeId).has(input.jobId)).toBe(true);
    expect(store.maintainRetention(now).historyRemoved).toBe(1);
    expect(store.listDashboardRetainedJobs()).toEqual([]);
    expect(store.listJobEvents(input.jobId)).toEqual([]);
    expect(store.eventRetention.summary(input.jobId)).toEqual({});
    store.upsertJob(input);
    expect(store.listDashboardRetainedJobs()).toEqual([]);
    expect(()=>store.upsertJob({...input,jobId:"replay"})).toThrow(/request/i);
    expect(store.workHistory.policy(30)).toMatchObject({retentionDays:30,lastCleanupAt:new Date(now).toISOString(),lastCleanupCount:1,totalRemoved:1});
    store.close();store=new BridgeStateStore({file});
    expect(store.workHistory.expired(input.jobId)).toBe(true);
    expect(store.workHistory.acknowledgedJobIds(scopeId).has(input.jobId)).toBe(true);
    const db=new Database(file,{readonly:true});
    const payload=(db.prepare("SELECT payload FROM jobs WHERE job_id=?").get(input.jobId) as {payload:string}).payload;
    expect(payload).not.toContain("old diagnostic");expect(payload).not.toContain("old result");
    expect(JSON.parse(payload)).toMatchObject({status:"failed",resultOmitted:true,historyExpired:true,requestId:input.requestId});
    expect(db.pragma("foreign_key_check")).toEqual([]);db.close();store.close();
  });

  it("protects active work, pending delivery, uncertain responses and user holds",()=>{
    const file=path.join(mkdtempSync(path.join(tmpdir(),"history-protect-")),"state.sqlite"),store=new BridgeStateStore({file});
    const active={...job("active"),status:"running"};store.upsertJob(active);
    const held=job("held");store.upsertJob(held);store.holdResult(held.jobId,"review",now+day);
    const result=job("delivery");store.upsertJob(result);store.deleteJob(result.jobId);
    const db=new Database(file),activity=(db.prepare("SELECT activity_id FROM jobs WHERE job_id=?").get(result.jobId) as {activity_id:string}).activity_id;
    db.prepare("INSERT INTO completion_outbox(activity_id,scope_id,completion_version,channel,payload,created_at) VALUES (?,?,1,'notify','{}',?)").run(activity,scopeId,old);
    const uncertain=job("uncertain");store.upsertJob(uncertain);store.deleteJob(uncertain.jobId);
    const requestId="22222222-2222-4222-8222-222222222222",actionHash="a".repeat(64);
    store.beginSteeringDelivery({scopeId,requestId,actionHash,jobId:uncertain.jobId,expectedJobVersion:1,promptSha256:"b".repeat(64),now:old});
    store.completeSteeringDelivery(scopeId,requestId,actionHash,"uncertain",{delivery:{status:"uncertain"}},old);
    expect(store.retentionProtection(uncertain.jobId,now)).toContain("uncertain-response");
    expect(store.maintainRetention(now).historyRemoved).toBe(0);
    expect(store.countJobs()).toBe(2);
    expect(store.workHistory.expired(result.jobId)).toBe(false);
    expect(store.workHistory.expired(uncertain.jobId)).toBe(false);
    db.prepare("UPDATE completion_outbox SET acknowledged_at=? WHERE activity_id=?").run(now,activity);
    expect(store.maintainRetention(now).historyRemoved).toBe(1);
    expect(store.workHistory.expired(result.jobId)).toBe(true);
    expect(store.getSteeringDelivery(scopeId,requestId)?.status).toBe("uncertain");
    db.close();store.close();
  });

  it("rotates past a full protected batch and respects the selected retention period",()=>{
    const store=new BridgeStateStore({file:":memory:"});
    store.transaction(()=>{for(let n=0;n<502;n++){const input=job(String(n).padStart(4,"0"));store.upsertJob(input);store.deleteJob(input.jobId);}});
    const protectedJob=(id:string)=>Number(id)<500;
    expect(store.workHistory.sweep(0,()=>false,now)).toBe(0);
    expect(store.workHistory.sweep(90,()=>false,now)).toBe(0);
    expect(store.workHistory.sweep(30,protectedJob,now)).toBe(0);
    expect(store.workHistory.sweep(30,protectedJob,now)).toBe(2);
    expect(store.listDashboardRetainedJobs()).toHaveLength(500);
    expect(historyRetentionDays(undefined)).toBe(30);
    expect(historyRetentionDays(7)).toBe(7);expect(historyRetentionDays(0)).toBe(0);
    expect(historyRetentionDays("7")).toBe(30);store.close();
  });

  it("backs up v14 before enabling history expiry and retains the latest failure across restart",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"history-v14-")),file=path.join(directory,"state.sqlite");
    let store=new BridgeStateStore({file});store.upsertJob(job("failed"));store.close();
    const db=new Database(file);db.exec("DROP TABLE work_history_state; UPDATE bridge_meta SET value='14' WHERE key='schema_version'");db.close();
    store=new BridgeStateStore({file});
    expect(store.schemaVersion).toBe(18);expect(store.countJobs()).toBe(1);
    expect(readdirSync(directory).filter(name=>name.includes("pre-v18"))).toHaveLength(1);
    store.workHistory.acknowledge("failed",now);store.close();store=new BridgeStateStore({file});
    expect(store.workHistory.acknowledgedJobIds().has("failed")).toBe(true);store.close();
  });
});
