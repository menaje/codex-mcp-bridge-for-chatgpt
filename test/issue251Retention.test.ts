import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { BridgeStateStore } from "../src/stateStore.js";
import { strictRetentionDays } from "../src/historyPolicy.js";
const now=Date.UTC(2026,9,14),day=86_400_000,scope="11111111-1111-4111-8111-111111111111";
afterEach(()=>vi.useRealTimers());
function fixture(days:number) {
  vi.useFakeTimers();vi.setSystemTime(now);
  const file=path.join(mkdtempSync(path.join(tmpdir(),"issue251-")),"state.sqlite");
  const store=new BridgeStateStore({file});
  store.writeSettings({historyRetentionDays:days},0,now);
  const db=new Database(file);
  return {store,db,file};
}
function insert(store:BridgeStateStore,id:string,age:number,status="failed",archived=false) {
  const basis=now-age*day;
  const agent=store.createAgent({scopeId:scope,agentName:id,now:basis-1});
  const input={jobId:id,requestId:`request-${id}`,scopeId:scope,agentId:agent.agentId,status,
    createdAt:basis-1000,updatedAt:basis,result:{content:[{type:"text",text:`original-${id}`}]},error:`diagnostic-${id}`};
  store.upsertJob(input);
  store.recordJobTelemetryEvent(id,"app-command-completed",{type:"command",details:{outputTail:`event-${id}`}},basis);
  if (archived) store.deleteJob(id,now);
  const candidate={key:`recovery-${id}`,scopeId:scope,agentId:agent.agentId,kind:"recheck" as const};
  store.automaticRecovery.observeRecheck(candidate,true,basis);
  const attempt=store.automaticRecovery.begin(candidate,basis)!;
  store.automaticRecovery.finish(candidate.key,attempt.attempts,{resolved:false,reason:`unresolved-${id}`,retryable:false},basis+1000);
  return {input,candidate,agent};
}
describe("#251 one policy across durable records",()=>{
  for(const days of [7,30,90,0]) it(`uses independent cloned inputs for ${days} days`,()=>{
    const {store,db}=fixture(days);
    for(const age of [6,20,40,100]) for(const status of ["completed","failed","interrupted"]) for(const archived of [false,true]) {
      const id=`${age}-${status}-${archived}`;
      insert(store,id,age,status,archived);
      const retained=days===0||age<days;
      expect(Boolean(store.readRetainedJobDetail(scope,{kind:"job",id},now)),id).toBe(retained);
      expect(store.workHistory.problemJobs(scope).some(x=>x.jobId===id),id).toBe(retained&&status!=="completed");
    }
    for(let n=0;n<8;n++) {store.maintainHistoryRetention(now);store.maintainRecoveryRetention(now);store.maintainEventRetention(now);}
    for(const row of db.prepare("SELECT job_id,ended_at,payload,detail_availability FROM jobs").all() as any[]) {
      const retained=days===0||now-row.ended_at<days*day;
      expect(row.payload.includes(`original-${row.job_id}`),row.job_id).toBe(retained);
      expect(db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id=?").get(row.job_id)).toEqual({n:retained?2+(row.job_id.endsWith("true")?1:0):0});
      expect(Boolean(store.automaticRecovery.get(`recovery-${row.job_id}`)),row.job_id).toBe(retained);
    }
    db.close();store.close();
  });
  it("retains complete bodies and diagnostics through archive, size pressure and restart",()=>{
    const {store,db,file}=fixture(0);const {input}=insert(store,"archive",100,"completed",false);
    expect(store.readRetainedJobDetail(scope,{kind:"job",id:input.jobId})?.result).toEqual(input.result);
    for(let n=0;n<300;n++) store.recordJobTelemetryEvent("archive","app-command-completed",{type:"command",details:{itemId:String(n),outputTail:"x".repeat(10_000)}},now);
    store.deleteJob("archive",now);store.maintainEventRetention(now);
    expect((db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id='archive'").get() as any).n).toBeGreaterThan(300);
    db.close();store.close();const reopened=new BridgeStateStore({file});
    expect(reopened.readRetainedJobDetail(scope,{kind:"job",id:"archive"})?.result).toEqual(input.result);reopened.close();
  });
  it("keeps an oversized original on disk while the registry result is only a response preview",()=>{
    const {store,db,file}=fixture(90);const {input}=insert(store,"large",40,"completed");
    const body={content:[{type:"text",text:"original".repeat(200_000)}]};
    store.saveJobResultBody(input.jobId,body);
    store.upsertJob({...input,result:{content:[{type:"text",text:"bounded preview"}]},resultOmitted:true});
    store.deleteJob(input.jobId,now);
    expect(store.readRetainedJobDetail(scope,{kind:"job",id:input.jobId})?.result).toEqual(body);
    expect((db.prepare("SELECT payload FROM jobs WHERE job_id=?").get(input.jobId) as any).payload).not.toContain("originaloriginal");
    db.close();store.close();const reopened=new BridgeStateStore({file});
    expect(reopened.readRetainedJobDetail(scope,{kind:"job",id:input.jobId})?.result).toEqual(body);
    reopened.writeSettings({historyRetentionDays:7},1,now);reopened.maintainHistoryRetention(now);
    expect(reopened.readRetainedJobDetail(scope,{kind:"job",id:input.jobId})).toBeUndefined();reopened.close();
  });
  it("migrates an isolated schema-31 fixture without inventing lost originals or current timestamps",()=>{
    const {store,db,file}=fixture(0);insert(store,"legacy",40,"completed",true);db.close();store.close();
    const old=new Database(file);
    old.exec(`DROP TRIGGER job_history_insert;DROP TRIGGER job_history_change;
      DROP TABLE agent_history_revisions;DROP TABLE job_result_bodies;DROP TABLE recovery_controls;
      DROP TABLE automatic_recovery_steps;DROP TABLE question_history;
      DROP INDEX jobs_policy_clock;DROP INDEX recovery_policy_clock;
      ALTER TABLE jobs DROP COLUMN ended_at;ALTER TABLE jobs DROP COLUMN ended_at_source;
      ALTER TABLE jobs DROP COLUMN detail_availability;ALTER TABLE jobs DROP COLUMN problem_summary;
      ALTER TABLE automatic_recovery DROP COLUMN occurred_at;ALTER TABLE automatic_recovery DROP COLUMN project_id;
      ALTER TABLE automatic_recovery DROP COLUMN activity_id;ALTER TABLE automatic_recovery DROP COLUMN thread_id;
      ALTER TABLE codex_question_deliveries DROP COLUMN occurred_at;
      UPDATE jobs SET payload='{"resultOmitted":true}';
      UPDATE bridge_meta SET value='31' WHERE key='schema_version';
      DELETE FROM bridge_meta WHERE key LIKE 'schema_v32_%';`);
    old.close();const migrated=new BridgeStateStore({file});
    expect(migrated.getMeta("schema_version")).toBe("32");
    const detail=migrated.readRetainedJobDetail(scope,{kind:"job",id:"legacy"}) as any;
    expect(detail).toMatchObject({endedAt:now-40*day,endedAtSource:"legacy-estimate",detailAvailability:"legacy-partial",resultOmitted:true});
    expect(detail.result).toBeUndefined();migrated.close();
  });
  it("keeps terminal clock fixed and applies a changed policy to prepared candidates",()=>{
    const {store,db}=fixture(30);const {input}=insert(store,"clock",40);
    store.upsertJob({...input,updatedAt:now});
    expect((db.prepare("SELECT ended_at FROM jobs WHERE job_id='clock'").get() as any).ended_at).toBe(now-40*day);
    store.writeSettings({historyRetentionDays:0},1,now);
    expect(store.workHistory.sweep(30,()=>false,now)).toBe(0);
    store.writeSettings({historyRetentionDays:7},2,now);
    expect(store.maintainHistoryRetention(now).historyRemoved).toBe(1);
    expect(()=>store.upsertJob({...input,jobId:"duplicate"})).toThrow(/request/i);
    store.upsertJob(input);expect(store.readRetainedJobDetail(scope,{kind:"job",id:"clock"})).toBeUndefined();
    db.close();store.close();
  });
  it("does not substitute thirty days for corrupt, missing or nonnumeric policy",()=>{
    const {store,db}=fixture(0);insert(store,"invalid",100);
    for(const value of [{}, {historyRetentionDays:"0"},{historyRetentionDays:null},{historyRetentionDays:17}]) {
      db.prepare("UPDATE user_settings SET payload=?").run(JSON.stringify(value));
      expect(()=>store.maintainHistoryRetention(now)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect(()=>store.maintainEventRetention(now)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect(()=>store.maintainRecoveryRetention(now)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect((db.prepare("SELECT payload FROM jobs WHERE job_id='invalid'").get() as any).payload).toContain("original-invalid");
    }
    expect(strictRetentionDays(0)).toBe(0);db.close();store.close();
  });
  it("expires unresolved/jobless prose without resetting the current incident budget",()=>{
    const {store,db,file}=fixture(7);const {candidate}=insert(store,"budget",40);
    const attempts=store.automaticRecovery.get(candidate.key)!.attempts;
    store.maintainRecoveryRetention(now);
    expect(store.automaticRecovery.listForDashboard(scope)).toEqual([]);
    expect(store.automaticRecovery.begin(candidate,now)).toBeUndefined();
    expect(store.automaticRecovery.canBegin(candidate,now)).toBe(false);
    expect((db.prepare("SELECT attempts FROM recovery_controls WHERE recovery_key=?").get(candidate.key) as any).attempts).toBe(attempts);
    expect(JSON.stringify(db.prepare("SELECT * FROM recovery_controls").all())).not.toContain("unresolved-budget");
    db.close();store.close();const reopened=new BridgeStateStore({file});
    expect(reopened.automaticRecovery.begin(candidate,now)).toBeUndefined();
    reopened.automaticRecovery.observeRecheck(candidate,false,now,"confirmed");
    reopened.automaticRecovery.observeRecheck(candidate,true,now+1);
    const recurrence=reopened.automaticRecovery.recheckCandidate(candidate)!;
    expect(recurrence.key).not.toBe(candidate.key);expect(reopened.automaticRecovery.begin(recurrence,now+1)?.attempts).toBe(1);reopened.close();
  });
  it("protects actual work and approval state, while terminal holds do not extend history",()=>{
    const {store,db}=fixture(7);const live=insert(store,"active",100,"running");
    store.upsertJob({...live.input,pendingInteractions:[{interactionId:"approval",isBlocking:true}]});
    const terminal=insert(store,"held",40,"completed");store.holdResult("held","hold",now+day);
    store.maintainHistoryRetention(now);
    expect(store.readRetainedJobDetail(scope,{kind:"job",id:"active"})).toBeDefined();
    expect(db.prepare("SELECT interaction_id FROM job_interactions WHERE job_id='active'").all()).toEqual([{interaction_id:"approval"}]);
    expect(store.readRetainedJobDetail(scope,{kind:"job",id:terminal.input.jobId})).toBeUndefined();
    expect(db.prepare("SELECT status FROM jobs WHERE job_id='active'").get()).toEqual({status:"running"});
    db.close();store.close();
  });
});
