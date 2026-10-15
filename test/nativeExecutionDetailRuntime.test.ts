import {randomUUID} from 'node:crypto';
import {mkdtemp, lstat, rm} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {describe, expect, it} from 'vitest';
import {startBridgeCompanionServer} from '../src/companionServer.js';
import {loadConfig} from '../src/config.js';
import {createIsolatedHttpServer, createIsolatedStdioRuntime} from '../src/runtimeProcess.js';
import {ScopeResolver} from '../src/scopeResolver.js';
import {BridgeStateStore} from '../src/stateStore.js';
import {UserSettingsStore} from '../src/userSettings.js';
import type {BridgeApplicationService, DashboardExecutionDetail, DashboardView} from '../src/tools.js';

const scopeId='11111111-1111-4111-8111-111111111111';
const otherScopeId='22222222-2222-4222-8222-222222222222';
const day=86400000;

// Actual native JSON-RPC -> parent proxy -> state-owner dispatcher -> read worker.
// No application service, dispatcher, read worker, or detail implementation is mocked.
function request(socketPath:string,method:string,params:unknown):Promise<any> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(socketPath);let buffer='';
    socket.setEncoding('utf8');socket.setTimeout(8000,()=>socket.destroy(new Error('Native fixture request timed out')));
    socket.once('connect',()=>socket.write(JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;const end=buffer.indexOf('\n');if(end<0)return;
      try{resolve(JSON.parse(buffer.slice(0,end)))}catch(error){reject(error)}finally{socket.end()}});
    socket.once('error',reject);
  });
}

describe('native execution detail through the production runtime boundary',()=>{
  it.each(['http','stdio'] as const)('returns exact details and preserves fences through %s dispatch',async transport=>{
    const root=await mkdtemp(path.join(tmpdir(),'nd-')),file=path.join(root,'state.sqlite'),socketPath=path.join(root,'b.sock');
    const environment={...process.env,HOME:root,CODEX_HOME:path.join(root,'codex'),
      CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_HOST:'127.0.0.1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE:path.join(root,'telemetry.sqlite'),
      CODEX_MCP_BRIDGE_RUNTIME_HOME:path.join(root,'runtime'),CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:path.join(root,'models.json'),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,'skills')};
    const config=loadConfig(environment),writer=new BridgeStateStore({file});
    new ScopeResolver({stateStore:writer});
    const settings=new UserSettingsStore(config,{stateStore:writer});writer.writeSettings({...settings.current,historyRetentionDays:30},0);
    const agent=writer.createAgent({scopeId,agentName:'Exact execution owner'}),activity=writer.createActivity({scopeId,title:'Native history'});
    const at=Date.now();
    function seed(age:number,name:string){
      const endedAt=at-age*day,job={jobId:randomUUID(),requestId:randomUUID(),scopeId,agentId:agent.agentId,activityId:activity.activityId,
        status:'failed',createdAt:endedAt-1000,updatedAt:endedAt,endedAt,endedAtSource:'recorded',lastProgressAt:endedAt,version:1,
        cwd:root,sandbox:'read-only',operation:'start',requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],
        trackingState:'connected',completionDeliveryPolicy:'direct-wait',sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},
        pendingInteractions:[],executionName:name,summary:'Retained native summary',error:'secret=abcdef0123456789 recorded failure'};
      writer.upsertJob(job);writer.deleteJob(job.jobId);return job;
    }
    const retained=seed(6,'Exact requested execution'),older=seed(20,'Older retained execution');
    writer.close(); // Respect production's single-owner startup fence after seeding the private fixture.
    let closeRuntime:(()=>Promise<void>)|undefined,companion:Awaited<ReturnType<typeof startBridgeCompanionServer>>|undefined;
    try{
      let service:BridgeApplicationService;
      if(transport==='http'){
        const runtime=await createIsolatedHttpServer(config,{childEnvironment:environment});
        service=runtime.applicationService;
        closeRuntime=()=>new Promise<void>((resolve,reject)=>runtime.close(error=>error?reject(error):resolve()));
      }else{
        const runtime=await createIsolatedStdioRuntime(config,{childEnvironment:environment,input:new PassThrough(),output:new PassThrough()});
        service=runtime.applicationService;closeRuntime=()=>runtime.close();
      }
      companion=await startBridgeCompanionServer({socketPath,applicationService:service});
      expect((await lstat(socketPath)).mode&0o777).toBe(0o600);
      const listed=await request(socketPath,'dashboard.snapshot',{historyMode:'jobs',includeHistory:true,enrich:false,limit:5});
      expect(listed.error).toBeUndefined();const view=listed.result as DashboardView;
      const row=view.terminalRows.find(x=>x.jobId===retained.jobId)!;
      const target={scopeId,jobId:retained.jobId,expectedExecutionRevision:row.executionRevision,expectedPolicyRevision:row.policyRevision};
      const response=await request(socketPath,'dashboard.execution-detail',target);
      expect(response.error).toBeUndefined();const detail=response.result as DashboardExecutionDetail;
      expect(detail).toMatchObject({kind:'dashboard-execution',scopeId,jobId:retained.jobId,executionRevision:row.executionRevision,
        policyRevision:row.policyRevision,nextExpiryAt:row.nextExpiryAt,execution:{jobId:retained.jobId,status:'failed',executionName:'Exact requested execution',summary:'Retained native summary'}});
      expect(detail.execution.error).toContain('[REDACTED]');expect(JSON.stringify(detail)).not.toContain('abcdef0123456789');
      expect(service.runtimeHealth?.().readService).toMatchObject({status:'ready',generation:expect.any(String)});
      for(const params of [{...target,scopeId:otherScopeId},{scopeId,jobId:'missing-exact-job'}]){
        const rejected=await request(socketPath,'dashboard.execution-detail',params);
        expect(rejected.result).toBeUndefined();expect(rejected.error.message).toContain('EXECUTION_DETAIL_UNAVAILABLE');
      }
      for(const params of [{...target,scopeId:'invalid'},{...target,maximumAccess:'full-access'}]){
        const rejected=await request(socketPath,'dashboard.execution-detail',params);expect(rejected.result).toBeUndefined();expect(rejected.error).toBeDefined();
      }
      const stale=await request(socketPath,'dashboard.execution-detail',{...target,expectedExecutionRevision:'f'.repeat(64)});
      expect(stale.error.message).toContain('EXECUTION_DETAIL_STALE');
      const aborted=new AbortController();aborted.abort();
      await expect(service.dashboardExecutionDetail!(target,{signal:aborted.signal})).rejects.toThrow('STATE_READ_CANCELLED');
      await expect(service.dashboardExecutionDetail!(target,{deadlineAt:Date.now()-1000})).rejects.toThrow('STATE_READ_STALE');

      const current=await service.settingsSnapshot();
      await service.updateSettings({expectedSettingsRevision:current.settings.settingsRevision,operation:{kind:'patch',settings:{historyRetentionDays:7}}});
      const oldPolicy=await request(socketPath,'dashboard.execution-detail',target);expect(oldPolicy.error.message).toContain('EXECUTION_DETAIL_STALE');
      const expired=await request(socketPath,'dashboard.execution-detail',{scopeId,jobId:older.jobId});
      expect(expired.result).toBeUndefined();expect(expired.error.message).toContain('EXECUTION_DETAIL_UNAVAILABLE');
      const refreshed=await request(socketPath,'dashboard.execution-detail',{scopeId,jobId:retained.jobId});
      expect(refreshed.result.nextExpiryAt).toBe(new Date(retained.endedAt+7*day).toISOString());
      expect(refreshed.result.policyRevision).not.toBe(detail.policyRevision);
    }finally{await companion?.close();await closeRuntime?.();await rm(root,{recursive:true,force:true})}
  },30000);
});
