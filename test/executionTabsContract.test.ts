import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
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
class ExecutionElement {
 children:ExecutionElement[]=[];dataset:Record<string,string>={};textContent='';hidden=false;open=false;disabled=false;
 constructor(readonly tag:string,readonly className='',text=''){this.textContent=text;}
 append(...items:ExecutionElement[]){this.children.push(...items)}appendChild(item:ExecutionElement){this.append(item);return item}addEventListener(){}
 texts():string[]{return [this.textContent,...this.children.flatMap(c=>c.texts())]}
}
function cachedExecutionRenderer(row:any,detail:any,historyPolicy:any){
 const c=vm.createContext({Date,view:{historyModeApplied:'jobs',historyPolicy},widgetInstanceId:'health-widget',historySecurityGeneration:1,selectedScope:'conversation',
  executionDetails:new Map(),executionRequests:new Map(),executionErrors:new Map(),expandedExecutions:new Set(),localeTag:'en',t:{},BUNDLES:{en:{}},reads:0,
  callTool:async()=>{c.reads++;throw Error('valid cached detail must not be refetched');},
  node:(tag:string,cls:string,text:string)=>new ExecutionElement(tag,cls,text),tone:()=>'',statusLabel:(status:string)=>status,scheduleSizeChanged:()=>{},appendExecution:()=>{},timeMeta:()=>"Recorded time",rowMeta:()=>"",appendCancellation:(parent:ExecutionElement,cancel:any)=>parent.appendChild(new ExecutionElement("p","",cancel.reason))});
 for(const name of ['uiText','jobRowVisible','executionTarget','executionKey','executionFresh','executionCached'])
  vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(line=>new RegExp('^\\s*function '+name+'\\(').test(line))!,c);
 vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(line=>/^\s*async function loadExecutionDetail\(/.test(line))!,c);
 const start=DASHBOARD_CARD_HTML.indexOf('    function appendExecutionRecord('),end=DASHBOARD_CARD_HTML.indexOf('    function historyKey(',start);
 vm.runInContext(DASHBOARD_CARD_HTML.slice(start,end),c);c.row=row;c.detail=detail;
 vm.runInContext('target=executionTarget(row);cacheKey=executionKey(target);executionDetails.set(cacheKey,{detail,expiresAt:target.expiresAt})',c);
 return {async render(next:any){c.row=next;c.parent=new ExecutionElement('div');
  vm.runInContext('nextTarget=executionTarget(row);sameKey=cacheKey===executionKey(nextTarget);sameDetail=executionCached(nextTarget)===detail;appendExecutionRecord(parent,row)',c);
  await vm.runInContext('loadExecutionDetail(row)',c);
  return {texts:c.parent.texts() as string[],sameKey:c.sameKey,sameDetail:c.sameDetail,reads:c.reads};
 }};
}
describe('Job-unit execution tabs and read-only exact detail',()=>{
 it.each(['orphaned','idle','not-loaded'])('keeps current %s badges with healthy cached detail and detail loaded after health loss',async state=>{
  const f=fixture();try{
   const job=f.seed('running',0,{threadId:'runtime-health-cache',executionName:'Cached exact name',summary:'Cached retained detail'});
   const healthy=await f.service().dashboardSnapshot(query),healthyRow=healthy.activeRows.find(x=>x.jobId===job.jobId)!;
   const cached=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:job.jobId,expectedExecutionRevision:healthyRow.executionRevision,expectedPolicyRevision:healthyRow.policyRevision});
   const renderer=cachedExecutionRenderer(healthyRow,cached,healthy.historyPolicy);
   expect((await renderer.render(healthyRow)).texts).toContain('running');
   const unhealthy=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state,backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...healthy.enrichment,state:'enriched'}} as any);
   const row=unhealthy.activeRows.find(x=>x.jobId===job.jobId)!,expected=state==='orphaned'?'orphaned':'liveness-unknown';
   const after=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:job.jobId,expectedExecutionRevision:row.executionRevision,expectedPolicyRevision:row.policyRevision});
   expect(row.executionRevision).toBe(healthyRow.executionRevision);expect(after.execution.status).toBe('running');
   for(const result of [await renderer.render(row),await cachedExecutionRenderer(row,after,unhealthy.historyPolicy).render(row),await renderer.render(unhealthy.backgroundRows!.find(x=>x.jobId===job.jobId))]){
    expect(result).toMatchObject({sameKey:true,sameDetail:true,reads:0});expect(result.texts).toContain(expected);expect(result.texts).not.toContain('running');expect(result.texts).not.toContain(job.jobId);expect(result.texts).not.toContain('Execution details');
   }
  }finally{await f.close();}
 });
 it.each(['input-required','approval-required','terminating','termination-failed','completed','failed','interrupted','cancelled'])('preserves %s presentation and exact-detail cache content',async status=>{
  const f=fixture();try{
   const blocking=status==='approval-required'?'command-approval':status==='input-required'?'question':undefined;
   const job=f.seed(blocking?'running':status,0,{summary:'Exact cached preview',...(blocking?{pendingInteractions:[{interactionId:'blocking',isBlocking:true,kind:blocking}]}:{})});
   const view=await f.service().dashboardSnapshot(query),row=[...view.activeRows,...view.terminalRows].find(x=>x.jobId===job.jobId)!;
   const detail=await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:job.jobId,expectedExecutionRevision:row.executionRevision});
   const result=await cachedExecutionRenderer(row,detail,view.historyPolicy).render(row);expect(result).toMatchObject({sameKey:true,sameDetail:true,reads:0});
   expect(result.texts).toContain(status);expect(result.texts).not.toContain(job.jobId);
   if(['completed','failed','interrupted','cancelled'].includes(status)){const stale=await cachedExecutionRenderer(row,detail,view.historyPolicy).render({...row,status:'orphaned'});expect(stale.texts).toContain(status);expect(stale.texts).not.toContain('orphaned');}
  }finally{await f.close();}
 });

 it('marks an omitted history body as omitted so first History selection fetches it',async()=>{
  const f=fixture();try{
   f.seed('completed',1);
   const first=await f.service().dashboardSnapshot({...query,includeHistory:false});
   expect(first.historyIncluded).toBe(false);expect(first.terminalRows).toEqual([]);expect(first.counts.executionCount).toBe(1);
   const fetched=await f.service().dashboardSnapshot({...query,includeHistory:true});expect(fetched.historyIncluded).toBe(true);expect(fetched.terminalRows).toHaveLength(1);
   const c=vm.createContext({view:first,selectedStatus:'all',problemMutationInFlight:false,mounted:true,historyLoadQueued:false,busy:false,requests:0,
    closeWorkDetails:()=>{},syncStatusFilter:()=>{},reload:async()=>{c.requests++;c.view=fetched;},paint:()=>{}});
   vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(x=>/^\s*async function selectStatus\(/.test(x))!,c);
   await vm.runInContext('selectStatus("history")',c);expect(c.requests).toBe(1);expect(c.view.terminalRows).toHaveLength(1);
  }finally{await f.close();}
 });
 it.each(['orphaned','idle','not-loaded'])('preserves %s runtime health on exact active Job rows and background owners',async state=>{
  const f=fixture();try{
   const live=f.seed('running',0,{threadId:'runtime-health-thread'});f.seed('completed',1);
   const first=await f.service().dashboardSnapshot(query);
   const view=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state,backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   const expected=state==='orphaned'?'orphaned':'liveness-unknown',row=view.activeRows.find(x=>x.jobId===live.jobId)!;
   expect(row.status).toBe(expected);expect(row.latestTurn?.status).toBe(expected);
   expect(view.backgroundRows?.find(x=>x.jobId===live.jobId)?.status).toBe(expected);
   expect(view.terminalRows[0].status).toBe('completed');
   await expect(f.service().dashboardExecutionDetail!({scopeId:scope,jobId:live.jobId,expectedExecutionRevision:row.executionRevision})).resolves.toMatchObject({jobId:live.jobId});
  }finally{await f.close();}
 });
 it.each(['running','completed'])('routes an exact %s Job handoff to its current owning Agent thread and rejects stale or unrelated targets',async status=>{
  const f=fixture();try{
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId:'33333333-3333-4333-8333-333333333333',backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   const job=f.seed(status,0,{threadId:'33333333-3333-4333-8333-333333333333'});
   f.writer.upsertSession({threadId:'33333333-3333-4333-8333-333333333333',scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const handoff=vi.spyOn(CodexJobRegistry.prototype,'threadHandoff').mockReturnValue({phase:'released',handoffRequested:true,evidence:'thread-unloaded'} as any);
   const v=await f.service().dashboardSnapshot(query),row=[...v.activeRows,...v.terminalRows].find(x=>x.jobId===job.jobId)!;
   expect(row.codexThreadUrl).toBe('codex://threads/33333333-3333-4333-8333-333333333333');
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:row.codexThreadUrl!,action:'request'})).resolves.toMatchObject({phase:'released',canOpen:true});
   expect(handoff).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333','request');
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:'codex://threads/foreign-thread',action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId:'44444444-4444-4444-8444-444444444444',backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now:now+1});
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:row.codexThreadUrl!,action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   expect(handoff).toHaveBeenCalledTimes(1);
  }finally{await f.close();}
 });

 it.each(['running','completed'])('keeps canonical links and exact handoff for an uppercase-thread %s Job',async status=>{
  const f=fixture();try{
   const threadId='AABBCCDD-ABCD-4ABC-8ABC-AABBCCDDEEFF',url='codex://threads/'+threadId.toLowerCase();
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const job=f.seed(status,0,{threadId});const handoff=vi.spyOn(CodexJobRegistry.prototype,'threadHandoff').mockReturnValue({phase:'released',handoffRequested:true,evidence:'thread-unloaded'} as any);
   const view=await f.service().dashboardSnapshot(query),row=[...view.activeRows,...view.terminalRows].find(x=>x.jobId===job.jobId)!;
   expect(row.codexThreadUrl).toBe(url);
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action:'request'})).resolves.toMatchObject({canOpen:true});
   expect(handoff).toHaveBeenCalledWith(threadId,'request');
  }finally{await f.close();}
 });
 it('resolves a retained older terminal Job when the newer Job has expired, with foreign and policy fences',async()=>{
  const f=fixture(7);try{
   const threadId='abcdefab-abcd-4abc-8abc-abcdefabcdef',url='codex://threads/'+threadId;
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const retained=f.seed('completed',6,{threadId,createdAt:now-10*day}),expired=f.seed('completed',8,{threadId,createdAt:now-9*day});
   expect(f.writer.latestControlJobs([f.agent.agentId]).get(f.agent.agentId)?.jobId).toBe(expired.jobId);
   const handoff=vi.spyOn(CodexJobRegistry.prototype,'threadHandoff').mockReturnValue({phase:'released',handoffRequested:true,evidence:'thread-unloaded'} as any);
   const view=await f.service().dashboardSnapshot(query),row=view.terminalRows.find(x=>x.jobId===retained.jobId)!;
   expect(view.counts.executionCount).toBe(1);expect(row.codexThreadUrl).toBe(url);
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action:'request'})).resolves.toMatchObject({canOpen:true});
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:'codex://threads/ffffffff-ffff-4fff-8fff-ffffffffffff',action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   f.writer.writeSettings({historyRetentionDays:0},1,now);
   const all=await f.service().dashboardSnapshot(query),expiredRow=all.terminalRows.find(x=>x.jobId===expired.jobId)!;
   f.writer.writeSettings({historyRetentionDays:7},2,now);
   await expect(f.service().threadHandoff({rowKey:expiredRow.rowKey,codexThreadUrl:url,action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   expect(handoff).toHaveBeenCalledTimes(1);
   f.writer.maintainRetention(now);expect(f.writer.workHistory.expired(expired.jobId)).toBe(true);
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action:'request'})).resolves.toMatchObject({canOpen:true});
   f.writer.writeSettings({historyRetentionDays:0},3,now);
   await expect(f.service().threadHandoff({rowKey:expiredRow.rowKey,codexThreadUrl:url,action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   expect(handoff).toHaveBeenCalledTimes(2);
  }finally{await f.close();}
 });
 it.each(['running','completed'])('preserves exact non-UUID %s thread links through their UUID session route',async status=>{
  const f=fixture();try{
   const threadId='opaque-app-thread',sessionId='ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF',url='codex://threads/'+sessionId.toLowerCase();
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId,sessionId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId,sessionId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const job=f.seed(status,0,{threadId});const handoff=vi.spyOn(CodexJobRegistry.prototype,'threadHandoff').mockReturnValue({phase:'released',handoffRequested:true,evidence:'thread-unloaded'} as any);
   const view=await f.service().dashboardSnapshot(query),row=[...view.activeRows,...view.terminalRows].find(x=>x.jobId===job.jobId)!;
   expect(row.codexThreadUrl).toBe(url);
   for(const action of ['request','status','cancel'] as const){await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action})).resolves.toMatchObject({canOpen:true});expect(handoff).toHaveBeenLastCalledWith(threadId,action);}
   const legacy=await f.service().dashboardSnapshot({...query,historyMode:undefined}),agentRow=[...legacy.activeRows,...legacy.terminalRows].find(x=>x.codexThreadUrl===url)!;
   await expect(f.service().threadHandoff({rowKey:agentRow.rowKey,codexThreadUrl:url,action:'request'})).resolves.toMatchObject({canOpen:true});expect(handoff).toHaveBeenLastCalledWith(threadId,'request');
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId:'different-opaque-thread',sessionId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now:now+1});
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action:'request'})).rejects.toThrow(/TARGET_CHANGED/);
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:url,action:'status'})).resolves.toMatchObject({canOpen:true});expect(handoff).toHaveBeenLastCalledWith(threadId,'status');
   await expect(f.service().threadHandoff({rowKey:agentRow.rowKey,codexThreadUrl:url,action:'status'})).rejects.toThrow(/TARGET_CHANGED/);
  }finally{await f.close();}
 });
 it('prefers an exact UUID thread over a different UUID session alias',async()=>{
  const f=fixture();try{
   const threadId='abcdefab-abcd-4abc-8abc-abcdefabcdef',sessionId='12345678-1234-4234-8234-123456789012';
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId,sessionId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId,sessionId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const job=f.seed('completed',0,{threadId}),handoff=vi.spyOn(CodexJobRegistry.prototype,'threadHandoff').mockReturnValue({phase:'released',handoffRequested:true,evidence:'thread-unloaded'} as any);
   const row=(await f.service().dashboardSnapshot(query)).terminalRows.find(x=>x.jobId===job.jobId)!;expect(row.codexThreadUrl).toBe('codex://threads/'+threadId);
   await expect(f.service().threadHandoff({rowKey:row.rowKey,codexThreadUrl:'codex://threads/'+sessionId,action:'request'})).rejects.toThrow(/TARGET_CHANGED/);expect(handoff).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
 it.each([['running','AABBCCDD-ABCD-4ABC-8ABC-AABBCCDDEEFF',undefined],['completed','AABBCCDD-ABCD-4ABC-8ABC-AABBCCDDEEFF',undefined],['running','durable-opaque-thread','abcdefab-abcd-4abc-8abc-abcdefabcdef'],['completed','durable-opaque-thread','abcdefab-abcd-4abc-8abc-abcdefabcdef']])('restores durable %s handoff state from stored thread %s rather than its URL route',async(status,threadId,sessionId)=>{
  const f=fixture();try{
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId:threadId!,sessionId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId:threadId!,sessionId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const job=f.seed(status,0,{threadId,backendKind:'app-server'});
   expect(f.writer.threadConnections.update(threadId!,{phase:'waiting',handoffRequested:true,reason:'active-work'},now)).toBeDefined();
   // Construct the read service only after durable intent exists: no client or
   // service-local handoff cache can supply the restored waiting/cancel state.
   const first=await f.service().dashboardSnapshot(query),row=[...first.activeRows,...first.terminalRows].find(x=>x.jobId===job.jobId)!;
   expect(row.handoff).toMatchObject({phase:'waiting',requested:true,canOpen:false,reason:'active-work'});
   const enriched=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state:status==='running'?'busy':'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   expect(enriched.backgroundRows).toHaveLength(1);expect(enriched.backgroundRows![0].handoff).toMatchObject({phase:'waiting',requested:true,canOpen:false});
   const legacy=await f.service().dashboardSnapshot({...query,historyMode:undefined}),legacyRows=[...legacy.activeRows,...legacy.terminalRows,...legacy.idleRows].filter(x=>x.codexThreadUrl===row.codexThreadUrl);
   expect(legacyRows.length).toBeGreaterThan(0);expect(legacyRows.every(x=>x.handoff?.requested===true)).toBe(true);
   f.writer.threadConnections.update(threadId!,{phase:'released',handoffRequested:true,evidence:'worker-exited'},now+1);
   const released=await f.service().dashboardSnapshot(query);expect([...released.activeRows,...released.terminalRows].find(x=>x.jobId===job.jobId)?.handoff).toMatchObject({phase:'released',requested:true,canOpen:true});
  }finally{await f.close();}
 });
 it('projects the stored Agent thread handoff when its Job uses different UUID case',async()=>{
  const f=fixture();try{
   const threadId='aabbccdd-abcd-4abc-8abc-aabbccddeeff';
   f.writer.linkAgentThread({agentId:f.agent.agentId,threadId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now});
   f.writer.upsertSession({threadId,scopeId:scope,cwd:f.root,lastUsedAt:now,backendKind:'app-server',visibleInCodexApp:true});
   const job=f.seed('running',0,{threadId:threadId.toUpperCase(),backendKind:'app-server'});
   f.writer.threadConnections.update(threadId,{phase:'waiting',handoffRequested:true,reason:'active-work'},now);
   const view=await f.service().dashboardSnapshot(query),row=view.activeRows.find(x=>x.jobId===job.jobId)!;
   expect(row.handoff).toMatchObject({phase:'waiting',requested:true,reason:'active-work'});
  }finally{await f.close();}
 });
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
 it('preserves each older Job model and reasoning effort in every history and problem page',async()=>{
  const f=fixture();try {
   const expected=new Map<string,string>();
   for(let i=0;i<13;i++){const j=f.seed(i%2?'failed':'completed',1+i/10,{error:i%2?'Recorded error':undefined,executionDecision:{effectiveSelection:{model:'model-'+i,reasoningEffort:i%2?'high':'low'},processingSpeed:'standard'}});expected.set(j.jobId,'model-'+i);}
   const problemIds:string[]=[];
   for(const offset of [0,5,10]) { const v=await f.service().dashboardSnapshot({...query,terminalOffset:offset,problems:{kind:'all',review:'pending',offset:offset===10?5:offset}});
    for(const row of v.terminalRows)expect(row.latestTurn?.execution?.model).toBe(expected.get(row.jobId!));
    for(const problem of v.problems!.rows){expect(problem.row.latestTurn?.execution?.model).toBe(expected.get(problem.jobId!));expect(problem.row.latestTurn?.execution?.reasoningEffort).toBe('high');if(offset!==10)problemIds.push(problem.jobId!);}
    expect(v.problems?.affectedExecutionCount).toBe(6);expect(v.problems?.page.total).toBe(6);
   }
   expect(new Set(problemIds).size).toBe(6);
  }finally{await f.close();}
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
 it('shows only failed, interrupted and cancelled Jobs once, excluding normal Jobs and recovery/system events',async()=>{
  const f=fixture(30);try {
   const failed=f.seed('failed',1),interrupted=f.seed('interrupted',1),cancelled=f.seed('cancelled',1);
   const c={key:automaticRecoveryKey('recheck',[failed.jobId,'later-distinct']),scopeId:scope,agentId:f.agent.agentId,jobId:failed.jobId,kind:'recheck' as const};
   f.writer.automaticRecovery.observeRecheck(c,true,now);f.writer.automaticRecovery.observeRecheck({...c,key:automaticRecoveryKey('recheck',['jobless']),jobId:undefined},true,now);
   const v=await f.service().dashboardSnapshot({...query,limit:12,problems:{view:'history',review:'pending',kind:'all',offset:0}});const p=v.problems!;
   expect(p.affectedExecutionCount).toBe(3);expect(p.page.total).toBe(3);expect(p.rows).toHaveLength(3);expect(p.rows.filter(x=>x.jobId===failed.jobId)).toHaveLength(1);
   expect(p.rows.find(x=>x.jobId===interrupted.jobId)?.kind).toBe('interrupted');expect(p.rows.find(x=>x.jobId===cancelled.jobId)?.kind).toBe('cancelled');
   expect(p.rows.filter(x=>x.source==='execution').every(x=>x.reason===null&&x.reasonAvailability==='unrecorded')).toBe(true);
   expect(p.rows.every(x=>x.source==='execution'&&x.executionAvailability==='retained')).toBe(true);
   expect(p.rows.every(x=>!x.canAcknowledge&&!x.canRecheck&&!x.canRetryStop)).toBe(true);
  } finally {await f.close();}
 });
 it('does not substitute the current Agent Job for an unavailable exact referenced execution',async()=>{
  const f=fixture(7);try {
   const old=f.seed('failed',40),current=f.seed('completed',1,{executionName:'Different current Job'});
   f.writer.automaticRecovery.observeRecheck({key:automaticRecoveryKey('recheck',['old-ref']),scopeId:scope,agentId:f.agent.agentId,jobId:old.jobId,kind:'recheck'},true,now);
   const v=await f.service().dashboardSnapshot({...query,problems:{view:'history',review:'pending',kind:'all',offset:0}});expect(v.problems?.affectedExecutionCount).toBe(0);expect(v.problems?.page.total).toBe(0);expect(v.problems?.rows).toEqual([]);expect(v.terminalRows[0]?.jobId).toBe(current.jobId);
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

 it('assigns a completed Job background observation to one current runtime owner without losing history or exact detail',async()=>{
  const f=fixture();try{
   const ended=f.seed('completed',1,{threadId:'completed-with-background',executionName:'Terminal execution'});
   const first=await f.service().dashboardSnapshot(query);
   const view=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state:'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   if(process.env.CAPTURE_BACKGROUND_PROJECTION==='1')writeFileSync('test/fixtures/terminal-background-projection.json',JSON.stringify(view,null,2)+'\n');
   expect(view.counts.backgroundProcesses).toBe(1);expect(view.counts.progressJobCount).toBe(0);expect(view.counts.executionCount).toBe(1);
   const owners=[...view.activeRows,...view.terminalRows].filter(row=>row.backgroundProcessCount>0);
   expect(owners).toHaveLength(1);expect(owners[0]?.bucket).toBe('active');expect(view.terminalRows.find(row=>row.jobId===ended.jobId)?.backgroundProcessCount).toBe(0);
   expect(await f.service().dashboardExecutionDetail!({scopeId:scope,jobId:ended.jobId})).toMatchObject({jobId:ended.jobId,execution:{status:'completed'}});
   const c=vm.createContext({next:view,selectedStatus:'background',activeRows:[],terminalRows:[],dashboardRowMatchesStatus:(row:any)=>row.backgroundProcessCount>0});
   const line=DASHBOARD_CARD_HTML.split('\n').find(x=>/^\s*function applyLocalStatus\(/.test(x))!;
   vm.runInContext(line,c);vm.runInContext('applyLocalStatus(next)',c);expect(c.activeRows.length+c.terminalRows.length).toBe(1);
  }finally{await f.close();}
 });
 it('keeps current background ownership independent of the terminal history page and logical expiry',async()=>{
  const f=fixture(7);try{
   const old=f.seed('completed',(7*day-1000)/day,{threadId:'same-current-thread'});
   for(let i=0;i<8;i++)f.seed('completed',1+i/10,{threadId:'same-current-thread'});
   const first=await f.service().dashboardSnapshot(query),enrichment={runtimeByAgent:[[f.agent.agentId,{state:'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}};
   for(const offset of [0,5]){const v=await f.service().dashboardSnapshotWithEnrichment!({...query,terminalOffset:offset},enrichment as any);expect([...v.activeRows,...v.terminalRows].filter(x=>x.backgroundProcessCount>0)).toHaveLength(1);expect(v.terminalRows.every(x=>x.backgroundProcessCount===0)).toBe(true);}
   vi.spyOn(Date,'now').mockReturnValue(now+1000);
   const expired=await f.service().dashboardSnapshotWithEnrichment!(query,enrichment as any);
   expect(expired.counts.executionCount).toBe(8);expect(expired.activeRows.filter(x=>x.backgroundProcessCount>0)).toHaveLength(1);
   await expect(f.service().dashboardExecutionDetail!({scopeId:scope,jobId:old.jobId})).rejects.toThrow(/UNAVAILABLE/);
  }finally{await f.close();}
 });
 it('keeps unrelated same-name Agents as distinct current background owners',async()=>{
  const f=fixture();try{
   f.seed('completed',1,{threadId:'owner-one-thread'});
   const second=f.writer.createAgent({scopeId:other,agentName:'Job owner'}),activity=f.writer.createActivity({scopeId:other,title:'Other work'});
   f.seed('completed',1,{scopeId:other,agentId:second.agentId,activityId:activity.activityId,threadId:'owner-two-thread'});
   const options={...query,scopeId:undefined},first=await f.service().dashboardSnapshot(options);
   const v=await f.service().dashboardSnapshotWithEnrichment!(options,{runtimeByAgent:[f.agent.agentId,second.agentId].map(id=>[id,{state:'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]),runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   const owners=[...v.activeRows,...v.terminalRows].filter(x=>x.backgroundProcessCount>0);
   expect(owners).toHaveLength(2);expect(new Set(owners.map(x=>x.rowKey)).size).toBe(2);expect(new Set(owners.map(x=>x.conversationKey)).size).toBe(2);
   expect(v.counts.backgroundProcesses).toBe(2);expect(v.counts.executionCount).toBe(2);
   const c=vm.createContext({next:v,selectedStatus:'background',activeRows:[],terminalRows:[],dashboardRowMatchesStatus:(row:any)=>row.backgroundProcessCount>0});
   vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(x=>/^\s*function applyLocalStatus\(/.test(x))!,c);vm.runInContext('applyLocalStatus(next)',c);
   expect(c.activeRows.length+c.terminalRows.length).toBe(2);
  }finally{await f.close();}
 });

 it.each([12,26])('makes a runtime-only background owner reachable beyond %i progress Jobs with a bounded independent page',async progress=>{
  const f=fixture();try{
   f.seed('completed',1,{threadId:'background-owner-thread'});
   for(let i=0;i<progress;i++){const agent=f.writer.createAgent({scopeId:scope,agentName:'Running '+i}),activity=f.writer.createActivity({scopeId:scope,title:'Running '+i});f.seed('running',0,{agentId:agent.agentId,activityId:activity.activityId,threadId:'running-thread-'+i});}
   const options={...query,limit:12},first=await f.service().dashboardSnapshot(options);
   const v=await f.service().dashboardSnapshotWithEnrichment!(options,{runtimeByAgent:[[f.agent.agentId,{state:'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   expect(v.activeRows).toHaveLength(12);expect(v.counts.progressJobCount).toBe(progress);expect(v.counts.executionCount).toBe(1);
   const c=vm.createContext({next:v,selectedStatus:'background',activeRows:[],terminalRows:[],dashboardRowMatchesStatus:(row:any)=>row.backgroundProcessCount>0});
   vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(x=>/^\s*function applyLocalStatus\(/.test(x))!,c);vm.runInContext('applyLocalStatus(next)',c);
   expect(c.activeRows.length+c.terminalRows.length).toBe(1);
   if(process.env.CAPTURE_BACKGROUND_PAGE==='1')writeFileSync('test/fixtures/background-independent-page.json',JSON.stringify(v,null,2)+'\n');
  }finally{await f.close();}
 });

 it('pages more than twelve current background owners independently and preserves exact active Job metadata',async()=>{
  const f=fixture();try{
   const agents=[f.agent];f.seed('running',0,{threadId:'active-bg-0'});
   for(let i=1;i<25;i++){const agent=f.writer.createAgent({scopeId:scope,agentName:'Background '+i}),activity=f.writer.createActivity({scopeId:scope,title:'Background '+i});agents.push(agent);f.seed('running',i/100,{agentId:agent.agentId,activityId:activity.activityId,threadId:'active-bg-'+i});}
   const options={...query,limit:12},first=await f.service().dashboardSnapshot(options),enrichment={runtimeByAgent:agents.map(agent=>[agent.agentId,{state:'busy',backgroundProcessState:'confirmed',backgroundProcessCount:1}]),runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}};
   let revision:string|undefined;const ids:string[]=[];
   for(const offset of [0,12,24]){const v=await f.service().dashboardSnapshotWithEnrichment!({...options,backgroundOffset:offset},enrichment as any);expect(v.backgroundRows!.length).toBeLessThanOrEqual(12);expect(v.backgroundPagination?.total).toBe(25);expect(v.backgroundPagination?.offset).toBe(offset);expect(v.counts.progressJobCount).toBe(25);expect(v.counts.executionCount).toBe(0);if(revision)expect(v.backgroundRevision).toBe(revision);revision=v.backgroundRevision;ids.push(...v.backgroundRows!.map(x=>x.jobId!));expect(v.backgroundRows!.every(x=>x.jobId&&x.scopeId===scope&&x.backgroundProcessCount===1)).toBe(true);}
   expect(new Set(ids).size).toBe(25);expect(ids).toHaveLength(25);
   const scoped=await f.service().dashboardSnapshotWithEnrichment!({...options,scopeId:other},enrichment as any);expect(scoped.backgroundRows).toEqual([]);expect(scoped.backgroundPagination?.total).toBe(0);
  }finally{await f.close();}
 });

 it('keeps deferred runtime-owner history on the same bounded policy/revision contract',async()=>{
  const f=fixture();try{
   for(const age of [1,2,3])f.seed('completed',age,{threadId:'history-background-thread'});
   const first=await f.service().dashboardSnapshot(query);
   const v=await f.service().dashboardSnapshotWithEnrichment!(query,{runtimeByAgent:[[f.agent.agentId,{state:'idle',backgroundProcessState:'confirmed',backgroundProcessCount:1}]],runtimeProbeSkippedAgents:0,weeklyUsage:null,summary:{...first.enrichment,state:'enriched'}} as any);
   const row=v.backgroundRows![0],detail=await f.service().dashboardHistoryDetail!({rowKey:row.rowKey,scopeId:scope});
   expect(row.policyRevision).toBe(detail.policyRevision);expect(row.historyRevision).toBe(detail.historyRevision);expect(row.representativeExecutionKey).toBe(detail.representativeExecutionKey);expect(row.nextExpiryAt).toBe(detail.nextExpiryAt);
  }finally{await f.close();}
 });

});
