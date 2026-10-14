import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { acquireHistoryPolicyGate } from '../src/historyPolicyGate.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeStateStore } from '../src/stateStore.js';
import { sweepTelemetryHistory } from '../src/telemetryHistoryPolicy.js';
import { DASHBOARD_CARD_HTML } from '../src/dashboardCard.js';
import { loadConfig } from '../src/config.js';
import { ScopeResolver } from '../src/scopeResolver.js';
import { SessionRegistry } from '../src/sessionRegistry.js';
import { UserSettingsStore } from '../src/userSettings.js';
import { CodexJobRegistry } from '../src/tools.js';
import { createBridgeMcpServer } from '../src/server.js';
const day=86400000,now=Date.UTC(2026,9,14),scope='11111111-1111-4111-8111-111111111111';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(days=7){
  vi.useFakeTimers();vi.setSystemTime(now);
  const root=mkdtempSync(path.join(tmpdir(),'review-r-')),file=path.join(root,'state.sqlite');
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,'skills')});
  const store=new BridgeStateStore({file});const settings=new UserSettingsStore(config,{stateStore:store});
  store.writeSettings({...settings.current,historyRetentionDays:days},0);
  new ScopeResolver({stateStore:store});
  const activity=store.createActivity({scopeId:scope,title:'R fixture',handoffPolicy:'notify',now:now-40*day});
  const agent=store.createAgent({scopeId:scope,agentName:'R owner',now:now-40*day});
  const db=new Database(file);
  function seed(at:number,status='completed',archive=true){
    const jobId=randomUUID();store.upsertJob({jobId,requestId:randomUUID(),scopeId:scope,agentId:agent.agentId,activityId:activity.activityId,
      status,createdAt:at-1000,updatedAt:at,lastProgressAt:at,version:1,cwd:root,sandbox:'read-only',operation:'start',
      requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],trackingState:'connected',completionDeliveryPolicy:'direct-wait',
      sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},pendingInteractions:[],result:{content:[{type:'text',text:'R original'}]},error:status==='failed'?'R failure':undefined});
    if(status!=='running'&&archive)store.deleteJob(jobId,now);return jobId;
  }
  function reader(){const r=new BridgeStateStore({file,readOnly:true});const jobs=new CodexJobRegistry({stateStore:r,projectionOnly:true});
    const upstream:any={listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('no probes');},close:async()=>{}};
    const server=createBridgeMcpServer(config,upstream,new SessionRegistry({stateStore:r,projectionOnly:true}),jobs,undefined,new UserSettingsStore(config,{stateStore:r,projectionOnly:true}),new ScopeResolver({stateStore:r}));
    return {r,server,service:server.applicationService};}
  return {root,file,store,db,activity,agent,seed,reader,close(){db.close();store.close();}};
}
describe('#251 independent review regressions (assert required behavior)',()=>{
  for(const [from,to] of [[7,0],[30,90]] as const) it(`R1: ${from}→${to} commits before deletion authorization, including outer commit/rollback`,()=>{
    const f=fixture(from),source=new Database(f.file),telemetry=new Database(':memory:');
    telemetry.exec(`CREATE TABLE transport_observations(observation_id INTEGER PRIMARY KEY,job_id TEXT,created_at INTEGER);
      CREATE TABLE runtime_measurements(measurement_id INTEGER PRIMARY KEY,created_at INTEGER);
      CREATE TABLE diagnostic_events(event_id INTEGER PRIMARY KEY,created_at INTEGER);
      CREATE TABLE telemetry_retention_state(kind TEXT PRIMARY KEY,cursor INTEGER,last_completed_at INTEGER);
      CREATE TABLE telemetry_record_deliveries(delivery_id TEXT PRIMARY KEY,record_type TEXT,record_id INTEGER,created_at INTEGER);
      CREATE TABLE telemetry_meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO diagnostic_events VALUES(1,${now-40*day});`);
    try {
      f.store.transaction(()=>{
        f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:to},1,now);
        // An inner settings return is NOT its durable commit boundary.
        expect(source.prepare('SELECT settings_revision FROM user_settings').get()).toEqual({settings_revision:1});
        expect(()=>sweepTelemetryHistory(telemetry,source,now)).toThrow(/locked/);
      });
      expect(sweepTelemetryHistory(telemetry,source,now)).toBe(0);
      expect(telemetry.prepare('SELECT count(*) n FROM diagnostic_events').get()).toEqual({n:1});
      expect(()=>f.store.transaction(()=>{
        f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:from},2,now);
        throw Error('rollback fixture');
      })).toThrow('rollback fixture');
      expect(f.store.appliedHistoryPolicy(now).retentionDays).toBe(to);
      expect(sweepTelemetryHistory(telemetry,source,now)).toBe(0);
    } finally {telemetry.close();source.close();f.close();}
  });
  it('R1: the coordination lock contains no history, releases on failure/process death, and never blocks settings behind a wait',()=>{
    const f=fixture();
    try {
      const release=acquireHistoryPolicyGate(f.file);
      expect(()=>f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:0},1,now)).toThrow(/locked/);
      expect(f.store.getSettingsRevision()).toBe(1);release();
      execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
        `import {acquireHistoryPolicyGate} from './src/historyPolicyGate.ts';acquireHistoryPolicyGate(${JSON.stringify(f.file)});process.exit(0);`],{cwd:process.cwd()});
      f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:0},1,now);
      const gate=new Database(f.file+'.history-policy-gate.sqlite',{readonly:true});
      expect(gate.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);gate.close();
      expect(f.store.appliedHistoryPolicy(now).retentionDays).toBe(0);
    } finally {f.close();}
  });
  it('R1: serializes interleaved policy commit and telemetry DELETE, preserving rows on failure',()=>{
    const f=fixture(),source=new Database(f.file),telemetry=new Database(':memory:');
    telemetry.exec(`CREATE TABLE transport_observations(observation_id INTEGER PRIMARY KEY,job_id TEXT,created_at INTEGER);
      CREATE TABLE runtime_measurements(measurement_id INTEGER PRIMARY KEY,created_at INTEGER);
      CREATE TABLE diagnostic_events(event_id INTEGER PRIMARY KEY,created_at INTEGER);
      CREATE TABLE telemetry_retention_state(kind TEXT PRIMARY KEY,cursor INTEGER,last_completed_at INTEGER);
      CREATE TABLE telemetry_record_deliveries(delivery_id TEXT PRIMARY KEY,record_type TEXT,record_id INTEGER,created_at INTEGER);
      CREATE TABLE telemetry_meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO diagnostic_events VALUES(1,${now-40*day});`);
    const prepare=telemetry.prepare.bind(telemetry);let changed=false;
    vi.spyOn(telemetry,'prepare').mockImplementation((sql:string)=>{
      if(!changed&&sql.startsWith('DELETE FROM diagnostic_events WHERE event_id=')){
        f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:0},1,now);changed=true;
      }return prepare(sql);
    });
    expect(()=>sweepTelemetryHistory(telemetry,source,now)).toThrow(/locked/);
    expect(f.store.appliedHistoryPolicy(now).retentionDays).toBe(7);
    expect(telemetry.prepare('SELECT count(*) n FROM diagnostic_events').get()).toEqual({n:1});
    f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:0},1,now);
    expect(sweepTelemetryHistory(telemetry,source,now)).toBe(0);
    expect(telemetry.prepare('SELECT count(*) n FROM diagnostic_events').get()).toEqual({n:1});
    telemetry.close();source.close();f.close();
  });
  it('R2: logical expiry invalidates page cache before bounded physical sweep',async()=>{
    const f=fixture();const expiredId=f.seed(now-7*day+1000),keptId=f.seed(now-6*day);f.seed(now,'running');const r=f.reader();
    try{
      const before=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});
      const row=before.statusRows![0]!;const detail=await r.service.dashboardHistoryDetail!({scopeId:scope,rowKey:row.rowKey});
      expect(detail.history).toHaveLength(2);vi.setSystemTime(now+2000);
      const after=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});const fresh=after.statusRows![0]!;
      expect(fresh.historyCount).toBe(1);expect(fresh.historyRevision).not.toBe(row.historyRevision);
      expect(fresh.nextExpiryAt).not.toBe(row.nextExpiryAt);
      const context=vm.createContext({Date,widgetInstanceId:'r',historySecurityGeneration:1,selectedScope:'conversation',historyDetails:new Map(),historyErrors:new Map()});
      for(const name of ['historyKey','historyFresh','cachedHistoryDetail']){
        const line=DASHBOARD_CARD_HTML.split('\n').find(x=>x.trimStart().startsWith('function '+name+'('))!;
        expect(line).toBeDefined();vm.runInContext(line,context);
      }
      context.oldRow=row;context.newRow=fresh;context.detail=detail;
      vm.runInContext('historyDetails.set(historyKey(oldRow),detail); cached=cachedHistoryDetail(newRow)',context);
      expect(context.cached).toBeNull();
      expect(f.store.readRetainedJobDetail(scope,{kind:'job',id:expiredId})).toBeUndefined();
      expect(f.store.readRetainedJobDetail(scope,{kind:'job',id:keptId})).toBeDefined();
    }finally{await r.server.close();r.r.close();f.close();}
  });
  it('R2: a cursor and inflight page revision expire logically without waiting for a mutation',async()=>{
    const f=fixture();f.seed(now-7*day+1000);
    for(let n=0;n<13;n++)f.seed(now-6*day+n*1000);
    f.seed(now,'running');const r=f.reader();
    try {
      const before=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});
      const row=before.statusRows![0]!,detail=await r.service.dashboardHistoryDetail!({scopeId:scope,rowKey:row.rowKey});
      expect(detail.historyCount).toBe(14);expect(detail.nextCursor).toBeTypeOf('string');
      const stable=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});
      expect(stable.statusRows![0]!.historyRevision).toBe(detail.historyRevision);
      vi.setSystemTime(now+2000);
      await expect(r.service.dashboardHistoryDetail!({scopeId:scope,rowKey:row.rowKey,historyCursor:detail.nextCursor!})).rejects.toThrow(/TARGET_CHANGED/);
      const fresh=await r.service.dashboardHistoryDetail!({scopeId:scope,rowKey:row.rowKey});
      expect(fresh.historyCount).toBe(13);expect(fresh.historyRevision).not.toBe(detail.historyRevision);
      expect((f.db.prepare('SELECT count(*) n FROM work_history_state WHERE expired_at IS NOT NULL').get() as any).n).toBe(0);
    } finally {await r.server.close();r.r.close();f.close();}
  });
  for(const days of [7,30,90,0]) it(`R3/R5: independent ${days}-day Activity material clocks, pending/delivered completion and Job/Activity cancellation`,()=>{
    const f=fixture(days);
    try {
      const oldJob=f.seed(now-100*day,'completed',false);
      const outboxes:Array<{id:number;retained:boolean;delivered:boolean;original:string}>=[];
      const cancellations:Array<{requestId:string;retained:boolean}>=[];
      for(const age of [6,20,40,100]) {
        const basis=now-age*day,retained=days===0||age<days;
        for(const delivered of [false,true]) {
          vi.setSystemTime(basis);
          const activity=f.store.createActivity({scopeId:scope,title:`completion-original-${age}-${delivered}`,handoffPolicy:'notify',now:basis-1000});
          f.store.completeActivity(activity.activityId,undefined,basis);
          const outbox=f.store.listCompletionOutbox(activity.activityId)[0]!;
          if(delivered) {
            expect(f.store.claimCompletionOutbox(outbox.outboxId,scope,'fixture',60_000,basis)).toBeDefined();
            f.store.markCompletionOutboxDelivered(outbox.outboxId,scope,'fixture',basis+1);
          }
          outboxes.push({id:outbox.outboxId,retained,delivered,original:JSON.stringify(outbox.payload)});
        }
        for(const target of [{kind:'job',jobId:oldJob,activityId:f.activity.activityId} as const,{kind:'activity',activityId:f.activity.activityId} as const]) {
          const requestId=randomUUID();
          f.store.beginCancellationOperation({scopeId:scope,requestId,actionHash:'b'.repeat(64),source:'operator',toolName:'fixture',actionName:'cancel',target,expectedVersion:1,reasonCode:'fixture',reason:`cancellation-original-${age}-${target.kind}`,now:basis});
          // Completing the operation now cannot restart its prose clock.
          f.store.completeCancellationOperation(scope,requestId,{ok:true},'completed',now);
          cancellations.push({requestId,retained});
        }
      }
      vi.setSystemTime(now);
      for(const outbox of outboxes) {
        expect(Boolean(f.store.getCompletionOutbox(outbox.id))).toBe(outbox.retained);
        if(!outbox.retained)expect(f.store.claimCompletionOutbox(outbox.id,scope,'late',60_000,now)).toBeUndefined();
      }
      for(const c of cancellations)expect(Boolean(f.store.getCancellationOperation(scope,c.requestId)!.reason)).toBe(c.retained);
      f.store.maintainHistoryRetention(now);
      for(const outbox of outboxes) {
        const raw=f.db.prepare('SELECT payload,delivered_at FROM completion_outbox WHERE outbox_id=?').get(outbox.id) as any;
        expect(raw.payload).toBe(outbox.retained?outbox.original:'{"historyExpired":true}');
        expect(raw.delivered_at!==null).toBe(outbox.delivered);
      }
      for(const c of cancellations) {
        const raw=f.db.prepare('SELECT reason_text,action_hash,status,result FROM cancellation_operations WHERE request_id=?').get(c.requestId) as any;
        expect(Boolean(raw.reason_text)).toBe(c.retained);
        expect(raw).toMatchObject({action_hash:'b'.repeat(64),status:'completed',result:'{"ok":true}'});
      }
    } finally {f.close();}
  });
  it('R3: completion captured after Job expiry has its own lifetime and cannot resurrect after physical expiry',()=>{
    const f=fixture();f.seed(now-40*day);f.store.maintainHistoryRetention(now);
    f.store.completeActivity(f.activity.activityId,undefined,now);
    const outbox=f.store.listCompletionOutbox()[0]!;expect(outbox).toBeDefined();
    vi.setSystemTime(now+7*day);
    expect(f.store.listCompletionOutbox()).toEqual([]);
    expect(f.store.listPendingNotifyCompletionOutbox()).toEqual([]);
    f.store.maintainHistoryRetention(now+7*day);
    f.store.writeSettings({...f.store.getSettingsRecord()!.payload as any,historyRetentionDays:0},1,now+7*day);
    expect(f.store.getCompletionOutbox(outbox.outboxId)).toBeUndefined();
    expect(f.db.prepare('SELECT payload FROM completion_outbox WHERE outbox_id=?').get(outbox.outboxId)).toEqual({payload:'{"historyExpired":true}'});
    f.close();
  });
  it('R5: historical cancellation text expiry leaves active execution, pending intent and request replay authority unchanged',()=>{
    const f=fixture(),id=f.seed(now-40*day,'running'),requestId=randomUUID();
    const {operation,intent}=f.store.beginCancellationOperation({scopeId:scope,requestId,actionHash:'b'.repeat(64),source:'operator',toolName:'fixture',actionName:'cancel',target:{kind:'job',jobId:id,activityId:f.activity.activityId},expectedVersion:1,reasonCode:'fixture',reason:'old human rationale',now:now-40*day});
    f.store.maintainHistoryRetention(now);
    const current=f.store.getCancellationOperation(scope,requestId)!;
    expect(current.reason).toBeUndefined();
    expect(current).toMatchObject({rootIntentId:operation.rootIntentId,actionHash:operation.actionHash,status:'recorded'});
    expect(f.store.getCancellationIntent(intent.intentId)).toMatchObject({status:intent.status});
    expect(f.db.prepare('SELECT status FROM jobs WHERE job_id=?').get(id)).toEqual({status:'running'});
    f.close();
  });
  it('R5: unavailable history policy preserves prose on disk and does not prevent exact cancellation settlement',()=>{
    const f=fixture(),id=f.seed(now,'running'),requestId=randomUUID();
    try {
      f.store.beginCancellationOperation({scopeId:scope,requestId,actionHash:'b'.repeat(64),source:'operator',toolName:'fixture',actionName:'cancel',target:{kind:'job',jobId:id,activityId:f.activity.activityId},expectedVersion:1,reasonCode:'fixture',reason:'pending current rationale',now});
      f.db.prepare("UPDATE user_settings SET payload='{}'").run();
      expect(f.store.getCancellationOperation(scope,requestId)).toMatchObject({actionHash:'b'.repeat(64),status:'recorded',reason:undefined});
      expect(()=>f.store.listCancellationOperations(scope)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect(()=>f.store.maintainHistoryRetention(now)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect(f.db.prepare('SELECT reason_text FROM cancellation_operations WHERE request_id=?').get(requestId)).toEqual({reason_text:'pending current rationale'});
      expect(f.store.completeCancellationOperation(scope,requestId,{ok:true},'completed',now+1)).toMatchObject({actionHash:'b'.repeat(64),status:'completed'});
    } finally {f.close();}
  });
  it('R3: later Activity completion outbox expires independently of Job candidates',()=>{
    const f=fixture();const id=f.seed(now-40*day);f.store.completeActivity(f.activity.activityId,undefined,now-2*day);
    expect(f.store.listCompletionOutbox()).toHaveLength(1);f.store.maintainRetention(now);
    expect(f.store.workHistory.expired(id)).toBe(true);
    vi.setSystemTime(now+40*day);
    for(let n=0;n<5;n++)f.store.maintainRetention(now+40*day);
    expect(f.store.listCompletionOutbox()).toHaveLength(0);
    expect(f.store.listPendingNotifyCompletionOutbox()).toHaveLength(0);
    expect(f.store.nativeCompletionAvailability().available).toBe(false);
    expect(f.db.prepare('SELECT payload FROM completion_outbox').get()).toEqual({payload:'{"historyExpired":true}'});f.close();
  });
  it('R4: keeps confirmed runtime recurrence distinct from failed execution recovery',async()=>{
    const f=fixture(0);const id=f.seed(now-10000,'failed');const c={key:'r-recheck',scopeId:scope,agentId:f.agent.agentId,jobId:id,kind:'recheck' as const};
    f.store.automaticRecovery.observeRecheck(c,true,now-9000);
    f.store.automaticRecovery.observeRecheck(c,false,now-8000,'confirmed recovered');
    f.store.automaticRecovery.observeRecheck(c,true,now-1000);
    expect(f.store.automaticRecovery.listForDashboard(scope)).toHaveLength(2);const r=f.reader();
    try{const view=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false,problems:{review:'pending',kind:'all',offset:0}});
      expect(view.problems!.incidentCount).toBe(2);expect(view.problems!.rows[0]!.occurredAt).toBe(new Date(now-1000).toISOString());
      expect(view.problems!.rows[0]!.currentImpact).toBe('unknown');
      expect(view.problems!.currentImpactCount).toBe(1);
    }finally{await r.server.close();r.r.close();f.close();}
  });
  it('R5: expires Activity cancellation prose without losing hash/outcome authority',()=>{
    const f=fixture();const id=f.seed(now-40*day);
    const requestId=randomUUID();
    f.store.beginCancellationOperation({scopeId:scope,requestId,actionHash:'b'.repeat(64),source:'operator',toolName:'R',actionName:'cancel',
      target:{kind:'activity',activityId:f.activity.activityId},expectedVersion:1,reasonCode:'r-review',reason:'R historical cancellation prose',now:now-40*day});
    f.store.completeCancellationOperation(scope,requestId,{ok:true},'completed',now-40*day);
    for(let n=0;n<4;n++)f.store.maintainRetention(now);
    expect(f.store.workHistory.expired(id)).toBe(true);
    expect(f.store.listCancellationOperations(scope)[0]!.reason).toBeUndefined();
    expect(f.store.getCancellationOperation(scope,requestId)).toMatchObject({actionHash:'b'.repeat(64),status:'completed',result:{ok:true}});
    expect(f.db.prepare('SELECT reason_text FROM cancellation_operations').get()).toEqual({reason_text:null});f.close();
  });
});
