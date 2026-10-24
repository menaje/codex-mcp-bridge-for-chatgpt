import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeStateStore } from '../src/stateStore.js';
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
  function seed(at:number,status='completed'){
    const jobId=randomUUID();store.upsertJob({jobId,requestId:randomUUID(),scopeId:scope,agentId:agent.agentId,activityId:activity.activityId,
      status,createdAt:at-1000,updatedAt:at,lastProgressAt:at,version:1,cwd:root,sandbox:'read-only',operation:'start',
      requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],trackingState:'connected',completionDeliveryPolicy:'direct-wait',
      sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},pendingInteractions:[],result:{content:[{type:'text',text:'R original'}]},error:status==='failed'?'R failure':undefined});
    if(status!=='running')store.deleteJob(jobId,now);return jobId;
  }
  function reader(){const r=new BridgeStateStore({file,readOnly:true});const jobs=new CodexJobRegistry({stateStore:r,projectionOnly:true});
    const upstream:any={listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('no probes');},close:async()=>{}};
    const server=createBridgeMcpServer(config,upstream,new SessionRegistry({stateStore:r,projectionOnly:true}),jobs,undefined,new UserSettingsStore(config,{stateStore:r,projectionOnly:true}),new ScopeResolver({stateStore:r}));
    return {r,server,service:server.applicationService};}
  return {root,file,store,db,activity,agent,seed,reader,close(){db.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
describe('R2 client logical expiry regression',()=>{
  it('R2: logical expiry invalidates an old detail page before physical cleanup',async()=>{
    const f=fixture();const expiredId=f.seed(now-7*day+1000),keptId=f.seed(now-6*day);f.seed(now,'running');const r=f.reader();
    try{
      const before=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});
      const row=before.statusRows![0]!;const detail=await r.service.dashboardHistoryDetail!({scopeId:scope,rowKey:row.rowKey});
      expect(detail.history).toHaveLength(2);vi.setSystemTime(now+2000);
      const after=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:'all',inspectRuntime:false});const fresh=after.statusRows![0]!;
      expect(fresh.historyCount).toBe(1);// Server revisions may also change at logical expiry; force the former shared identity below to independently test the client defense.
      expect(fresh.nextExpiryAt).not.toBe(row.nextExpiryAt);
      const context=vm.createContext({Date,widgetInstanceId:'r',historySecurityGeneration:1,selectedScope:'conversation',executionDetails:new Map(),historyDetails:new Map(),historyErrors:new Map()});
      for(const name of ['historyKey','historyFresh','cachedHistoryDetail']){
        const line=DASHBOARD_CARD_HTML.split('\n').find(x=>x.trimStart().startsWith('function '+name+'('))!;
        expect(line).toBeDefined();vm.runInContext(line,context);
      }
      context.oldRow=row;context.newRow={...fresh,historyRevision:row.historyRevision};context.detail=detail;
      vm.runInContext('historyDetails.set(historyKey(oldRow),detail); cached=cachedHistoryDetail(newRow)',context);
      expect(context.cached).toBeNull();
      expect(f.store.readRetainedJobDetail(scope,{kind:'job',id:expiredId})).toBeUndefined();
      expect(f.store.readRetainedJobDetail(scope,{kind:'job',id:keptId})).toBeDefined();
      expect(String((f.db.prepare('SELECT payload FROM jobs WHERE job_id=?').get(expiredId) as {payload:string}).payload)).toContain('R original');
    }finally{await r.server.close();r.r.close();f.close();}
  });
});

const identity={rowKey:'cache-row',historyRevision:'a'.repeat(64),policyRevision:'b'.repeat(64),representativeExecutionKey:'c'.repeat(32)};
function cacheContext(){
  vi.useFakeTimers();vi.setSystemTime(now);
  const row={...identity,historyCount:2,nextExpiryAt:new Date(now+1000).toISOString(),history:[{executionKey:'expired'},{executionKey:'kept'}]};
  const page={...row,kind:'dashboard-history',historyHasMore:true,nextCursor:'old-cursor'};
  const context=vm.createContext({Date,widgetInstanceId:'r2',historySecurityGeneration:1,selectedScope:'conversation',executionDetails:new Map(),historyDetails:new Map(),historyErrors:new Map(),historyLoading:new Set(),historyRequestTokens:new Map(),mounted:true,hydrationEpoch:1,activeRows:[],terminalRows:[],historyActiveRows:[],historyTerminalRows:[],view:{statusRows:[row]},scheduleSizeChanged:()=>{},paint:()=>{},unwrapHistoryDetail:(value:unknown)=>value,t:{'common.error':'error'},errorText:String});
  for(const name of ['historyKey','historyFresh','cachedHistoryDetail','loadAgentHistory']){
    const line=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x))!;
    expect(line).toBeDefined();vm.runInContext(line,context);
  }
  context.row=row;context.page=page;vm.runInContext('historyDetails.set(historyKey(row),page)',context);
  return {context,row,page};
}
describe('R2 cache and inflight page boundaries with unchanged logical identity',()=>{
  it('uses still-valid cache with zero history reads, then rejects at the exact original boundary',async()=>{
    const {context,row}=cacheContext();let reads=0;context.callTool=async()=>{reads++;throw Error('unexpected read')};
    vi.setSystemTime(now+999);await vm.runInContext('loadAgentHistory(row)',context);
    expect(reads).toBe(0);expect(vm.runInContext('cachedHistoryDetail(row).history.length',context)).toBe(2);
    vi.setSystemTime(now+1000);context.fresh={...row,nextExpiryAt:new Date(now+86400000).toISOString()};
    expect(vm.runInContext('cachedHistoryDetail(fresh)',context)).toBeNull();
    expect(context.historyDetails.size).toBe(0);
  });
  for(const newerDetail of [false,true])it(`rejects late page and expired base when reply has ${newerDetail?'advanced':'original'} expiry`,async()=>{
    const {context,row,page}=cacheContext();let release!:(value:unknown)=>void;
    context.callTool=()=>new Promise(resolve=>{release=resolve});
    const pending=vm.runInContext('loadAgentHistory(row,true)',context);
    vi.setSystemTime(now+1000);
    const fresh={...row,historyCount:1,nextExpiryAt:new Date(now+86400000).toISOString(),history:[{executionKey:'kept'}]};
    context.view={statusRows:[fresh]};
    release(newerDetail?{...page,...fresh}:page);await pending;
    context.fresh=fresh;expect(vm.runInContext('cachedHistoryDetail(fresh)',context)).toBeNull();
    expect(context.historyLoading.size).toBe(0);
  });
  it('a fresh post-boundary page discards old cursor/base and cannot reintroduce expired summaries',async()=>{
    const {context,row,page}=cacheContext();vi.setSystemTime(now+1000);
    const fresh={...row,historyCount:1,nextExpiryAt:new Date(now+86400000).toISOString(),history:[{executionKey:'kept'}]};
    context.fresh=fresh;context.view={statusRows:[fresh]};let request:any;
    context.callTool=async(_name:string,args:any)=>{request=args;return {...page,...fresh,historyHasMore:false,nextCursor:null}};
    await vm.runInContext('loadAgentHistory(fresh,true)',context);
    expect(request.historyCursor).toBeUndefined();
    expect(vm.runInContext('cachedHistoryDetail(fresh).history.map(x=>x.executionKey).join()',context)).toBe('kept');
  });
});

describe('R2 expiry timer target isolation',()=>{
  it('evicts only expired pages and keeps another target’s still-valid cached page',()=>{
    const {context,row,page}=cacheContext();
    const other={...row,rowKey:'other-row',nextExpiryAt:new Date(now+86400000).toISOString()};
    context.other=other;context.otherPage={...page,...other};
    vm.runInContext('historyDetails.set(historyKey(other),otherPage)',context);
    let callback!:()=>void, refreshes=0;
    context.historyExpiryTimer=null;context.setTimeout=(fn:()=>void)=>{callback=fn;return 1};context.clearTimeout=()=>{};
    context.reload=()=>{refreshes++};
    const line=DASHBOARD_CARD_HTML.split('\n').find(x=>x.trimStart().startsWith('function scheduleHistoryExpiry('))!;
    vm.runInContext(line,context);context.snapshot={statusRows:[row,other],activeRows:[],terminalRows:[]};
    vm.runInContext('scheduleHistoryExpiry(snapshot)',context);
    vi.setSystemTime(now+1000);callback();
    expect(vm.runInContext('cachedHistoryDetail(row)',context)).toBeNull();
    expect(vm.runInContext('cachedHistoryDetail(other).history.length',context)).toBe(2);
    expect(refreshes).toBe(1);
  });
});
