import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {loadConfig} from '../src/config.js';
import {CodexJobRegistry} from '../src/tools.js';
import {createBridgeMcpServer} from '../src/server.js';
import {UserSettingsStore} from '../src/userSettings.js';
import {ScopeResolver} from '../src/scopeResolver.js';
import {SessionRegistry} from '../src/sessionRegistry.js';
import {ChildProcessStateReadService} from '../src/stateReadProcess.js';
import {automaticRecoveryKey} from '../src/automaticRecovery.js';
const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',now=Date.UTC(2026,9,14,12),day=86400000;
afterEach(()=>vi.restoreAllMocks());
function fixture(days=0) {
 vi.spyOn(Date,'now').mockReturnValue(now);const root=mkdtempSync(path.join(tmpdir(),'execution-tabs-')),file=path.join(root,'state.sqlite');
 const writer=new BridgeStateStore({file});const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,'skills')});
 new ScopeResolver({stateStore:writer});
 const settings=new UserSettingsStore(config,{stateStore:writer});writer.writeSettings({...settings.current,historyRetentionDays:days},0);
 const agent=writer.createAgent({scopeId:scope,agentName:'Job owner'});const activity=writer.createActivity({scopeId:scope,title:'One grouped Activity'});
 let reader:BridgeStateStore|undefined,server:ReturnType<typeof createBridgeMcpServer>|undefined;
 function seed(status='completed',age=1,extra:Record<string,unknown>={}) {
  const source={jobId:randomUUID(),requestId:randomUUID(),scopeId:scope,agentId:agent.agentId,activityId:activity.activityId,status,
   createdAt:now-age*day-1000,updatedAt:now-age*day,lastProgressAt:now-age*day,version:1,cwd:root,sandbox:'read-only',operation:'start',
   requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],trackingState:'connected',completionDeliveryPolicy:'direct-wait',
   ...(status==='cancelled' ? {terminalOrigin:'legacy-unattributed-cancellation'} : {}),sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},pendingInteractions:[],...extra};
  if(status==='cancelled') {
   writer.upsertJob({...source,status:'running'});
   const {intent}=writer.beginCancellationOperation({scopeId:scope,requestId:randomUUID(),actionHash:'b'.repeat(64),source:extra.cancellationSource==='model-tool'?'model-tool':'operator',toolName:'fixture',actionName:'cancel',
    target:{kind:'job',jobId:source.jobId,activityId:activity.activityId,agentId:agent.agentId},expectedVersion:1,reasonCode:'fixture-cancel',reason:typeof extra.reasonText==='string'?extra.reasonText:undefined,now:source.updatedAt-1});
   Object.assign(source,{cancellationIntentId:intent.intentId,terminalOrigin:'explicit-cancellation'});
   writer.setCancellationIntentStatus(intent.intentId,'dispatched',source.updatedAt-1);
   writer.setCancellationIntentStatus(intent.intentId,'succeeded',source.updatedAt);
   writer.completeCancellationOperation(scope,intent.requestId,{ok:true},"completed",source.updatedAt);
  }
  writer.upsertJob(source);if(['completed','failed','interrupted','cancelled'].includes(status)) writer.deleteJob(source.jobId);return source;
 }
 function service(){
  if(server)return server.applicationService;
  reader=new BridgeStateStore({file,readOnly:true});const jobs=new CodexJobRegistry({stateStore:reader,projectionOnly:true});
  server=createBridgeMcpServer(config,{listTools:async()=>({tools:[]}),close:async()=>{}} as any,new SessionRegistry({stateStore:reader,projectionOnly:true}),jobs,undefined,new UserSettingsStore(config,{stateStore:reader,projectionOnly:true}),new ScopeResolver({stateStore:reader}));return server.applicationService;
 }
 return {writer,root,file,agent,activity,seed,service,async close(){await server?.close();reader?.close();writer.close();}};
}
const query={scopeId:scope,historyMode:'jobs' as const,statusFilter:'all' as const,inspectRuntime:false,includeHistory:true,limit:5};
describe('Job-unit execution tabs and read-only exact detail',()=>{
 it('paginates every terminal Job independently of a single Agent/Activity and excludes active Jobs from executionCount',async()=>{
  const f=fixture();try {
   const jobs=Array.from({length:13},(_,n)=>f.seed(['completed','failed','interrupted','cancelled'][n%4],n+1,{error:n%4===1?'recorded failure':undefined}));
   f.seed('running',0);
   const first=await f.service().dashboardSnapshot(query);expect(first.counts.executionCount).toBe(13);expect(first.counts.progressJobCount).toBe(1);
   expect(first.pagination.terminal.total).toBe(13);expect(first.terminalRows).toHaveLength(5);expect(first.historyModeApplied).toBe('jobs');
   const ids:string[]=[];for(const offset of [0,5,10]){const v=await f.service().dashboardSnapshot({...query,terminalOffset:offset});ids.push(...v.terminalRows.map(x=>x.jobId!));expect(v.terminalRows.every(x=>x.historyCount===0)).toBe(true);}
   expect(new Set(ids)).toEqual(new Set(jobs.map(x=>x.jobId)));expect(ids).toHaveLength(13);
   const legacy=await f.service().dashboardSnapshot({...query,historyMode:undefined});expect(legacy.historyModeApplied).toBe('agents');expect(legacy.counts.executionCount).toBe(13);
  } finally {await f.close();}
 });
 it('makes exact scoped details agree with rows and rejects changed policy/content, wrong scope and unavailable Jobs',async()=>{
  const f=fixture(30);try {
   const j=f.seed('failed',1,{executionName:'Actual named Job',summary:'Stored content preview',error:'secret=abcdef0123456789 failed',result:{content:[{type:'text',text:'original retained result'}]}});
   const v=await f.service().dashboardSnapshot(query),row=v.terminalRows[0]!;
   expect(row.jobId).toBe(j.jobId);expect(row.latestTurn?.error).toContain('[REDACTED]');
   const detail=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:j.jobId,expectedExecutionRevision:row.executionRevision,expectedPolicyRevision:row.policyRevision});
   expect(detail.execution).toMatchObject({jobId:j.jobId,executionName:'Actual named Job',summary:'Stored content preview',status:'failed'});expect(detail.nextExpiryAt).toBe(row.nextExpiryAt);
   await expect(f.service().dashboardExecutionDetail!({scopeId:other,jobId:j.jobId})).rejects.toThrow(/UNAVAILABLE/);
   await expect(f.service().dashboardExecutionDetail!({scopeId:scope,jobId:'missing'})).rejects.toThrow(/UNAVAILABLE/);
   f.writer.writeSettings({historyRetentionDays:7},1,now);
   await expect(f.service().dashboardExecutionDetail!({scopeId:scope,jobId:j.jobId,expectedPolicyRevision:detail.policyRevision})).rejects.toThrow(/STALE/);
   f.writer.upsertJob({...j,error:'different recorded failure',updatedAt:now});
   await expect(f.service().dashboardExecutionDetail!({scopeId:scope,jobId:j.jobId,expectedExecutionRevision:detail.executionRevision})).rejects.toThrow(/STALE/);
  } finally {await f.close();}
 });
 it.each([7,30,90,0])('keeps page/totals/detail under the same %i-day policy without running deletion',async days=>{
  const f=fixture(days);try {
   const input=[6,20,40,100].map(age=>f.seed('completed',age));const v=await f.service().dashboardSnapshot(query);const eligible=[6,20,40,100].filter(age=>days===0||age<days).length;
   expect(v.counts.executionCount).toBe(eligible);expect(v.pagination.terminal.total).toBe(eligible);
   for(let n=0;n<input.length;n++){const result=f.service().dashboardExecutionDetail!({scopeId:scope,jobId:input[n].jobId});if(days===0||[6,20,40,100][n]<days)await expect(result).resolves.toMatchObject({jobId:input[n].jobId});else await expect(result).rejects.toThrow(/UNAVAILABLE/);}
  } finally {await f.close();}
 });
 it('reports interruption and cancellation separately, deduplicates linked Job events, and labels Jobless system events',async()=>{
  const f=fixture(30);try {
   const failed=f.seed('failed',1),interrupted=f.seed('interrupted',1),cancelled=f.seed('cancelled',1);
   const c={key:automaticRecoveryKey('recheck',[failed.jobId,'later-distinct']),scopeId:scope,agentId:f.agent.agentId,jobId:failed.jobId,kind:'recheck' as const};
   f.writer.automaticRecovery.observeRecheck(c,true,now);f.writer.automaticRecovery.observeRecheck({...c,key:automaticRecoveryKey('recheck',['jobless']),jobId:undefined},true,now);
   const v=await f.service().dashboardSnapshot({...query,limit:12,problems:{view:'history',review:'pending',kind:'all',offset:0}});const p=v.problems!;
   expect(p.affectedExecutionCount).toBe(3);expect(p.systemIncidentCount).toBe(1);
   expect(p.rows.find(x=>x.jobId===interrupted.jobId)?.kind).toBe('interrupted');expect(p.rows.find(x=>x.jobId===cancelled.jobId)?.kind).toBe('cancelled');
   expect(p.rows.filter(x=>x.source==='execution').every(x=>x.reason===null&&x.reasonAvailability==='unrecorded')).toBe(true);
   expect(p.rows.find(x=>!x.jobId)?.executionAvailability).toBe('not-linked');
   expect(p.rows.every(x=>!x.canAcknowledge&&!x.canRecheck&&!x.canRetryStop)).toBe(true);
  } finally {await f.close();}
 });
 it('does not substitute the current Agent Job for an unavailable exact referenced execution',async()=>{
  const f=fixture(7);try {
   const old=f.seed('failed',40),current=f.seed('completed',1,{executionName:'Different current Job'});
   f.writer.automaticRecovery.observeRecheck({key:automaticRecoveryKey('recheck',['old-ref']),scopeId:scope,agentId:f.agent.agentId,jobId:old.jobId,kind:'recheck'},true,now);
   const v=await f.service().dashboardSnapshot({...query,problems:{view:'history',review:'pending',kind:'all',offset:0}});expect(v.problems?.unavailableExecutionCount).toBe(1);
   const event=v.problems!.rows.find(x=>x.jobId===old.jobId)!;expect(event.executionAvailability).toBe('unavailable');expect(event.executionName).toBeNull();expect(event.row.latestTurn?.jobId).not.toBe(current.jobId);
  } finally {await f.close();}
 });
 it('keeps history detail revisions stable through unrelated runtime/progress updates and preserves archived error text',async()=>{
  const f=fixture();try {
   const old=f.seed('failed',1,{error:'first failure'});const live=f.seed('running',0);
   const v=await f.service().dashboardSnapshot(query),row=v.terminalRows.find(x=>x.jobId===old.jobId)!;
   f.writer.upsertJob({...live,updatedAt:now+1000,lastProgressAt:now+1000});
   f.writer.upsertJob({...old,error:undefined,updatedAt:now+2000});
   const detail=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:old.jobId,expectedExecutionRevision:row.executionRevision});
   expect(detail.execution.error).toBe('first failure');expect(f.writer.readRetainedJobDetail(scope,{kind:'job',id:old.jobId})).toBeDefined();
  } finally {await f.close();}
 });
 it('keeps blocking approval and question Jobs in progress and paginates actual executions under one Agent',async()=>{
  const f=fixture();try {
   const a=f.seed('running',0,{pendingInteractions:[{interactionId:'approval',isBlocking:true,kind:'command-approval'}]});
   const q=f.seed('running',0,{pendingInteractions:[{interactionId:'question',isBlocking:true}]});
   f.seed('terminating',0);f.seed('termination-failed',0);
   const first=await f.service().dashboardSnapshot({...query,statusFilter:'running',limit:2});
   const second=await f.service().dashboardSnapshot({...query,statusFilter:'running',limit:2,statusOffset:2});
   const rows=[...first.activeRows,...second.activeRows];expect(first.counts.progressJobCount).toBe(4);
   expect(first.counts.executionCount).toBe(0);expect(first.pagination.active.conversationTotal).toBe(1);
   expect(new Set(rows.map(x=>x.jobId)).size).toBe(4);
   expect(rows.find(x=>x.jobId===a.jobId)?.status).toBe('approval-required');expect(rows.find(x=>x.jobId===q.jobId)?.status).toBe('input-required');
  }finally{await f.close();}
 });
 it.each(['operator','model-tool'])('preserves a recorded %s cancellation as a neutral exact reason in list, incident and detail',async source=>{
  const f=fixture();try {
   const j=f.seed('cancelled',1,{cancellationSource:source,reasonText:'Stop requested for this execution'});
   const view=await f.service().dashboardSnapshot({...query,problems:{view:'history',review:'pending',kind:'all',offset:0}});
   const row=view.terminalRows[0]!;expect(row.latestTurn?.cancellation).toMatchObject({reason:'Stop requested for this execution',status:'succeeded'});
   expect(row.latestTurn?.error).toBeNull();expect(row.reasonAvailability).toBe('recorded');
   const detail=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:j.jobId,expectedExecutionRevision:row.executionRevision});
   expect(detail.execution.cancellation).toEqual(row.latestTurn?.cancellation);expect(view.problems?.rows[0]?.reason).toBe('Stop requested for this execution');
  }finally{await f.close();}
 });
 it('routes exact detail through the isolated read worker without adding a database writer',async()=>{
  const f=fixture(30);const j=f.seed('failed',1,{executionName:'Worker exact execution',error:'recorded error'});
  const before=f.writer.listBridgeInstances().length;vi.restoreAllMocks();
  const worker=await ChildProcessStateReadService.start(f.file,{...process.env,HOME:f.root,CODEX_HOME:path.join(f.root,'codex'),
   CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:f.file,
   CODEX_MCP_BRIDGE_RUNTIME_HOME:path.join(f.root,'runtime'),CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(f.root,'skills')});
  try{
   expect(await worker.dashboardExecutionDetail({scopeId:scope,jobId:j.jobId})).toMatchObject({kind:'dashboard-execution',jobId:j.jobId,execution:{executionName:'Worker exact execution',error:'recorded error'}});
   expect(f.writer.listBridgeInstances()).toHaveLength(before);
   await expect(worker.dashboardExecutionDetail({scopeId:other,jobId:j.jobId})).rejects.toThrow(/UNAVAILABLE/);
  }finally{await worker.close();await f.close();}
 },15000);

 it('preserves actual background work in the shared all-status Job projection',async()=>{
  const f=fixture();try{
   const live=f.seed('running',0,{threadId:'fixture-background-thread'});
   const first=await f.service().dashboardSnapshot(query);
   const enriched=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state:'busy',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   expect(enriched.counts.progressJobCount).toBe(1);expect(enriched.counts.executionCount).toBe(0);
   expect(enriched.activeRows.find(x=>x.jobId===live.jobId)?.backgroundProcessCount).toBe(1);
   expect(enriched.statusRows?.filter(x=>x.backgroundProcessCount>0).map(x=>x.jobId)).toContain(live.jobId);
  }finally{await f.close();}
 });

});
