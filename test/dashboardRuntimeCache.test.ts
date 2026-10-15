import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadConfig} from '../src/config.js';
import {ScopeResolver} from '../src/scopeResolver.js';
import {createBridgeMcpServer} from '../src/server.js';
import {SessionRegistry} from '../src/sessionRegistry.js';
import {BridgeStateStore} from '../src/stateStore.js';
import {ChildProcessStateReadService} from '../src/stateReadProcess.js';
import {CodexJobRegistry} from '../src/tools.js';
import {UserSettingsStore} from '../src/userSettings.js';

const scope='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
afterEach(()=>vi.restoreAllMocks());

async function fixture(count=3,withInventory=false) {
  const root=await mkdtemp(path.join(tmpdir(),'dashboard-runtime-cache-')),file=path.join(root,'state.sqlite');
  const environment={...process.env,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_RUNTIME_HOME:path.join(root,'runtime'),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,'skills')};
  const config=loadConfig(environment),writer=new BridgeStateStore({file});
  new ScopeResolver({stateStore:writer});new UserSettingsStore(config,{stateStore:writer});
  const owners:Array<{agentId:string,threadId:string,scopeId:string}>=[];
  writer.transaction(()=>{
    for(let index=0;index<count;index++) {
      const scopeId=index===1?other:scope,now=Date.now(),threadId=randomUUID();
      const agent=writer.createAgent({scopeId,agentName:'Owner '+index,lifecycle:'idle',now});
      writer.linkAgentThread({agentId:agent.agentId,threadId,backendKind:'app-server',cwd:root,sandbox:'read-only',contextMode:'fresh',now});
      const activity=writer.createActivity({scopeId,title:'Background owner '+index,now}),jobId=randomUUID();
      writer.upsertJob({jobId,requestId:randomUUID(),scopeId,agentId:agent.agentId,activityId:activity.activityId,
        status:'completed',createdAt:now-1000,updatedAt:now,endedAt:now,version:1,threadId});
      writer.deleteJob(jobId);owners.push({agentId:agent.agentId,threadId,scopeId});
    }
  });
  const reader=new BridgeStateStore({file,readOnly:true}),jobs=new CodexJobRegistry({stateStore:reader,projectionOnly:true});
  const worker=await ChildProcessStateReadService.start(file,environment);
  const list=vi.fn(async (threadId:string)=>{
    const index=owners.findIndex(owner=>owner.threadId===threadId);
    return index===0||index===1 ? Array.from({length:index+2},(_,i)=>({processId:'process-'+i,itemId:'item-'+i,command:'fixture task',cwd:root})) : null;
  });
  const probe=vi.fn(async()=>({state:'resumable' as const,runtimeStatus:'idle' as const}));
  const inventory=vi.fn(async()=>owners.slice(0,2).map(owner=>owner.threadId));
  const upstream={listTools:async()=>({tools:[]}),callTool:async()=>({content:[]}),close:async()=>{},
    listLoadedBackgroundTerminals:list,probeThread:probe,...(withInventory?{listLoadedThreadIds:inventory}:{})};
  const server=createBridgeMcpServer(config,upstream,new SessionRegistry({stateStore:reader,projectionOnly:true}),jobs,undefined,
    new UserSettingsStore(config,{stateStore:reader,projectionOnly:true}),new ScopeResolver({stateStore:reader}),undefined,undefined,undefined,worker);
  const read=(enrich:boolean,scopeId?:string)=>server.applicationService.dashboardSnapshot({historyMode:'jobs',statusFilter:'all',includeHistory:true,limit:12,inspectRuntime:enrich,scopeId});
  function activateFirstOwner() {
    const owner=owners[0],now=Date.now(),jobId=randomUUID();
    const activity=writer.createActivity({scopeId:owner.scopeId,title:'Current background work',now});
    writer.upsertJob({jobId,requestId:randomUUID(),scopeId:owner.scopeId,agentId:owner.agentId,activityId:activity.activityId,
      status:'running',createdAt:now,updatedAt:now,version:1,threadId:owner.threadId});
    writer.setAgentExecutionState(owner.agentId,'active',{currentJobId:jobId,now});
  }
  return {writer,reader,owners,list,probe,inventory,read,activateFirstOwner,async close(){await server.close();await worker.close();reader.close();writer.close();await rm(root,{recursive:true,force:true});}};
}

describe('background observations across isolated dashboard reads',()=>{
  it('inspects only live materialized owners among hundreds of historical threads, including completed Jobs with live processes',async()=>{
    const f=await fixture(800,true);try {
      const next=await f.read(true);
      expect(f.list.mock.calls.map(([id])=>id).sort()).toEqual(f.owners.slice(0,2).map(owner=>owner.threadId).sort());
      expect(f.probe).not.toHaveBeenCalled();expect(next.counts.backgroundProcesses).toBe(5);
      expect(next.backgroundRows).toHaveLength(2);expect(next.counts.runtimeProbeSkippedAgents).toBe(0);
      expect(next.counts.backgroundProcessUnknownAgents).toBe(0);expect(next.enrichment.backgroundInventoryUnavailable).not.toBe(true);
      const cached=await f.read(false);expect(cached.counts.backgroundProcesses).toBe(5);
      expect(cached.counts.runtimeProbeSkippedAgents).toBe(0);expect(cached.enrichment.cacheHits).toBe(2);
      expect(f.inventory).toHaveBeenCalledOnce();expect(f.list).toHaveBeenCalledTimes(2);
      for(const [scopeId,count] of [[scope,2],[other,3]] as const) {
        const scoped=await f.read(false,scopeId);expect(scoped.counts.backgroundProcesses).toBe(count);
        expect(scoped.counts.runtimeProbeSkippedAgents).toBe(0);
      }
    }finally{await f.close();}
  },20000);

  it('drops cached processes as soon as their owner is no longer loaded and discovers newly loaded owners',async()=>{
    const f=await fixture(20,true);try {
      expect((await f.read(true)).counts.backgroundProcesses).toBe(5);
      f.inventory.mockResolvedValue([]);
      const unloaded=await f.read(true);expect(unloaded.counts.backgroundProcesses).toBe(0);
      expect(unloaded.backgroundRows).toEqual([]);expect(unloaded.counts.runtimeProbeSkippedAgents).toBe(0);
      expect(f.list).toHaveBeenCalledTimes(2);expect((await f.read(false)).counts.backgroundProcesses).toBe(0);
      f.inventory.mockResolvedValue(f.owners.slice(0,2).map(owner=>owner.threadId));
      const loaded=await f.read(true);expect(loaded.counts.backgroundProcesses).toBe(5);expect(loaded.backgroundRows).toHaveLength(2);
      expect(f.list).toHaveBeenCalledTimes(4);
    }finally{await f.close();}
  },15000);

  it('keeps an inventory failure explicit without inspecting the historical thread list',async()=>{
    const f=await fixture(50,true);try {
      f.inventory.mockRejectedValue(new Error('Worker inventory unavailable'));
      const next=await f.read(true);expect(next.enrichment.backgroundInventoryUnavailable).toBe(true);
      expect(f.list).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
      const cached=await f.read(false);expect(cached.enrichment.backgroundInventoryUnavailable).toBe(true);
      expect(cached.backgroundRows).toEqual([]);expect(f.inventory).toHaveBeenCalledOnce();
      f.inventory.mockResolvedValue(f.owners.slice(0,2).map(owner=>owner.threadId));
      const recovered=await f.read(true);expect(recovered.enrichment.backgroundInventoryUnavailable).not.toBe(true);
      expect(recovered.counts.backgroundProcesses).toBe(5);expect(f.list).toHaveBeenCalledTimes(2);
    }finally{await f.close();}
  },15000);

  it('retains the last confirmed live owners while inventory is temporarily unavailable',async()=>{
    const f=await fixture(20,true);try {
      expect((await f.read(true)).counts.backgroundProcesses).toBe(5);
      f.inventory.mockRejectedValue(new Error('Temporary inventory failure'));
      const partial=await f.read(true);expect(partial.counts.backgroundProcesses).toBe(5);
      expect(partial.enrichment.backgroundInventoryUnavailable).toBe(true);
      const cached=await f.read(false);expect(cached.counts.backgroundProcesses).toBe(5);
      expect(cached.enrichment.backgroundInventoryUnavailable).toBe(true);expect(f.list).toHaveBeenCalledTimes(2);
    }finally{await f.close();}
  },15000);

  it('does not use an older unloaded inventory as proof about newly started work',async()=>{
    const f=await fixture(3,true);try {
      f.inventory.mockResolvedValue([]);await f.read(true);
      f.activateFirstOwner();
      const cached=await f.read(false,scope);expect(cached.counts.runtimeProbeSkippedAgents).toBe(1);
      expect(f.list).not.toHaveBeenCalled();
      f.inventory.mockResolvedValue([f.owners[0].threadId]);
      expect((await f.read(true,scope)).counts.backgroundProcesses).toBe(2);
    }finally{await f.close();}
  },15000);

  it('bounds and coalesces slow inventory reads, then publishes late completion to structural refreshes',async()=>{
    const f=await fixture(10,true);let release:((ids:string[])=>void)|undefined;
    try {
      f.inventory.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
      const first=await f.read(true);expect(first.enrichment.backgroundInventoryUnavailable).toBe(true);
      expect(first.enrichment.pendingReads).toBe(1);expect(f.list).not.toHaveBeenCalled();
      const pending=await f.read(false);expect(pending.enrichment.pendingReads).toBe(1);
      await f.read(true);expect(f.inventory).toHaveBeenCalledOnce();
      release!(f.owners.slice(0,2).map(owner=>owner.threadId));
      await new Promise(resolve=>setTimeout(resolve,30));
      const next=await f.read(false);expect(next.enrichment.backgroundInventoryUnavailable).not.toBe(true);
      expect(next.counts.runtimeProbeSkippedAgents).toBe(2);
      f.inventory.mockResolvedValue(f.owners.slice(0,2).map(owner=>owner.threadId));
      const observed=await f.read(true);expect(observed.counts.backgroundProcesses).toBe(5);
      expect(f.list).toHaveBeenCalledTimes(2);
    }finally{release?.([]);await f.close();}
  },15000);

  it.each(['unknown','error','orphaned'])('still observes loaded background processes when the liveness probe is %s',async state=>{
    const f=await fixture();try {
      f.activateFirstOwner();
      if(state==='error')f.probe.mockRejectedValue(new Error('Liveness unavailable'));
      else f.probe.mockResolvedValue({state} as any);
      const next=await f.read(true,scope);
      expect(f.probe).toHaveBeenCalledOnce();
      expect(next.counts.backgroundProcesses).toBe(2);expect(next.backgroundRows).toHaveLength(1);
      expect(next.backgroundRows![0].backgroundProcessCount).toBe(2);
      expect(next.counts.backgroundProcessUnknownAgents).toBe(0);
      const cached=await f.read(false,scope);
      expect(cached.counts.backgroundProcesses).toBe(2);expect(cached.backgroundRows).toHaveLength(1);
    }finally{await f.close();}
  },15000);

  it('replaces a previous positive count with a confirmed empty list even when liveness becomes unknown',async()=>{
    const f=await fixture();try {
      f.activateFirstOwner();
      f.probe.mockResolvedValue({state:'busy'} as any);
      expect((await f.read(true,scope)).counts.backgroundProcesses).toBe(2);
      f.probe.mockResolvedValue({state:'unknown'} as any);
      f.list.mockResolvedValue([]);
      const afterFreshness=Date.now()+5001;vi.spyOn(Date,'now').mockReturnValue(afterFreshness);
      const next=await f.read(true,scope);expect(next.counts.backgroundProcesses).toBe(0);expect(next.backgroundRows).toEqual([]);
      expect(next.counts.backgroundProcessUnknownAgents).toBe(0);
      const cached=await f.read(false,scope);expect(cached.counts.backgroundProcesses).toBe(0);expect(cached.backgroundRows).toEqual([]);
    }finally{await f.close();}
  },15000);

  it('keeps confirmed counts and owner rows through structural refreshes and conversation filters without new runtime reads',async()=>{
    const f=await fixture();try {
      const enriched=await f.read(true);expect(enriched.counts.backgroundProcesses).toBe(5);expect(enriched.backgroundRows).toHaveLength(2);
      const reads=f.list.mock.calls.length;
      for(const [scopeId,count,owners] of [[undefined,5,2],[scope,2,1],[other,3,1],[undefined,5,2]] as const) {
        const next=await f.read(false,scopeId);
        expect(next.counts.backgroundProcesses).toBe(count);expect(next.backgroundRows).toHaveLength(owners);
        expect(next.backgroundPagination?.total).toBe(owners);expect(next.counts.runtimeProbeSkippedAgents).toBe(0);
        expect(next.enrichment).toMatchObject({state:'structural',runtimeRequests:0,pendingReads:0});
        if(scopeId)expect(next.backgroundRows!.every(row=>row.conversationKey===enriched.backgroundRows!.find(owner=>owner.backgroundProcessCount===count)!.conversationKey)).toBe(true);
        expect(next.terminalRows.every(row=>row.backgroundProcessCount===0)).toBe(true);
      }
      expect(f.list).toHaveBeenCalledTimes(reads);
    }finally{await f.close();}
  },15000);

  it('rejects an observation after its owning thread changes and expires old observations',async()=>{
    const f=await fixture();try {
      await f.read(true);
      f.writer.linkAgentThread({agentId:f.owners[0].agentId,threadId:randomUUID(),backendKind:'app-server',cwd:tmpdir(),sandbox:'read-only',contextMode:'fresh'});
      const changed=await f.read(false,scope);expect(changed.counts.backgroundProcesses).toBe(0);expect(changed.backgroundRows).toEqual([]);expect(changed.counts.runtimeProbeSkippedAgents).toBe(1);
      expect((await f.read(false,other)).counts.backgroundProcesses).toBe(3);
      const expiredAt=Date.now()+15*60000+1;vi.spyOn(Date,'now').mockReturnValue(expiredAt);
      const expired=await f.read(false);expect(expired.counts.backgroundProcesses).toBe(0);expect(expired.backgroundRows).toEqual([]);
      expect(expired.counts.runtimeProbeSkippedAgents).toBe(3);
    }finally{await f.close();}
  },15000);

  it('finishes coverage beyond 512 current threads and retains the earliest background owner',async()=>{
    const f=await fixture(525);try {
      let next=await f.read(true);
      for(let page=1;page<3;page++)next=await f.read(true);
      expect(next.counts.runtimeProbeSkippedAgents).toBe(0);expect(next.counts.backgroundProcesses).toBe(5);
      const cached=await f.read(false);expect(cached.counts.runtimeProbeSkippedAgents).toBe(0);
      expect(cached.enrichment.cacheHits).toBe(525);expect(cached.backgroundRows).toHaveLength(2);
      expect(cached.counts.backgroundProcesses).toBe(5);
    }finally{await f.close();}
  },20000);

  it('carries pending reads and then applies late process counts on a structural refresh',async()=>{
    const f=await fixture();let release:((value:any)=>void)|undefined;
    try {
      const read=f.list.getMockImplementation()!;
      f.list.mockImplementation(thread=>thread===f.owners[0].threadId?new Promise(resolve=>{release=resolve;}):read(thread));
      const first=await f.read(true,scope);expect(first.enrichment.pendingReads).toBe(1);
      const pending=await f.read(false,scope);expect(pending.enrichment.pendingReads).toBe(1);expect(pending.backgroundRows).toEqual([]);
      release!([{processId:'late-process',itemId:'late-item',command:'fixture task',cwd:tmpdir()}]);
      await new Promise(resolve=>setTimeout(resolve,30));
      const ready=await f.read(false,scope);expect(ready.enrichment.pendingReads).toBe(0);
      expect(ready.counts.backgroundProcesses).toBe(1);expect(ready.backgroundRows).toHaveLength(1);
      expect(ready.counts.runtimeProbeSkippedAgents).toBe(0);
    }finally{release?.([]);await f.close();}
  },15000);
});
