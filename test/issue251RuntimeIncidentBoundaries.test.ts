import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automaticRecoveryKey, type AutomaticRecoveryController } from "../src/automaticRecovery.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry, configureAutomaticRecovery } from "../src/tools.js";
import type { CodexUpstream } from "../src/upstream.js";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { createBridgeMcpServer } from "../src/server.js";

const scopeId="11111111-1111-4111-8111-111111111111";
const day=86_400_000, now=Date.UTC(2026,9,14,12);
type RecoveryOptions=ConstructorParameters<typeof AutomaticRecoveryController>[1];
afterEach(()=>vi.restoreAllMocks());

function fixture(ageDays=1,status="failed") {
  vi.spyOn(Date,"now").mockReturnValue(now);
  const root=mkdtempSync(path.join(tmpdir(),"runtime-incident-boundary-")),file=path.join(root,"state.sqlite");
  const state=new BridgeStateStore({file});
  const agent=state.createAgent({scopeId,agentName:"Boundary owner",now:now-40*day});
  const threadId="boundary-thread",jobId=randomUUID();
  const activity=state.createActivity({scopeId,title:"Boundary execution",now:now-40*day});
  state.linkAgentThread({agentId:agent.agentId,threadId,backendKind:"app-server",cwd:"/tmp",
    sandbox:"read-only",contextMode:"fresh",now:now-40*day});
  const source={jobId,scopeId,requestId:randomUUID(),agentId:agent.agentId,activityId:activity.activityId,threadId,
    backendKind:"app-server",createdAt:now-ageDays*day-1000,updatedAt:now-ageDays*day,status,
    lastProgressAt:now-ageDays*day,version:1,cwd:root,sandbox:"read-only",operation:"start",requestHash:"a".repeat(64),requestHashVersion:11,
    exclusiveKeys:[],trackingState:"connected",completionDeliveryPolicy:"direct-wait",
    sessionDecision:{requestedMode:"new",action:"start",reason:"explicit-new"},pendingInteractions:[]};
  state.upsertJob(source);
  state.setAgentExecutionState(agent.agentId,"orphaned",{orphanedReason:"historical thread unavailable",now:source.updatedAt});
  state.threadConnections.update(threadId,{phase:"released",evidence:"worker-exited"},source.updatedAt);
  if(ageDays>30) state.maintainHistoryRetention(now);
  const jobs=new CodexJobRegistry({stateStore:state,projectionOnly:true});
  let options!:RecoveryOptions;
  vi.spyOn(jobs,"configureAutomaticRecovery").mockImplementation(value=>{options=value;});
  const upstream={} as CodexUpstream;
  configureAutomaticRecovery(jobs,upstream,{} as Parameters<typeof configureAutomaticRecovery>[2],()=>true);
  const identity={key:automaticRecoveryKey("recheck",[agent.agentId,jobId,threadId]),scopeId,
    agentId:agent.agentId,jobId,kind:"recheck" as const};
  return {root,file,state,jobs,agentId:agent.agentId,threadId,jobId,source,options,identity,
    async candidates(){return await options.candidates(agent.agentId);},
    async close(){await jobs.closeThreadConnections();state.close();}};
}

function oldIncident(f:ReturnType<typeof fixture>,at=now-5000,includeJob=true) {
  const legacy={...f.identity,key:automaticRecoveryKey("recheck",[f.agentId,f.state.getAgent(f.agentId)!.version,includeJob ? f.jobId : undefined]),
    jobId:includeJob ? f.jobId : undefined};
  f.state.automaticRecovery.observeRecheck(legacy,true,at);
  for(const time of [at,at+5000,at+35000]) {
    const record=f.state.automaticRecovery.begin(legacy,time)!;
    f.state.automaticRecovery.finish(record.key,record.attempts,{resolved:false,reason:"inspection-unconfirmed"},time);
  }
  return legacy;
}

function openContext(f:ReturnType<typeof fixture>) {
  f.state.threadConnections.update(f.threadId,{phase:"blocked",reason:"shutdown-unconfirmed"},now-1000);
}

function dashboard(f:ReturnType<typeof fixture>,upstream:CodexUpstream) {
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:"1",CODEX_MCP_BRIDGE_CODEX:"/usr/bin/false",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:f.file,CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(f.root,"skills")});
  const settings=new UserSettingsStore(config,{stateStore:f.state});
  return createBridgeMcpServer(config,upstream,new SessionRegistry({stateStore:f.state,projectionOnly:true}),f.jobs,
    undefined,settings,new ScopeResolver({stateStore:f.state}));
}

describe("#251 current runtime incident boundaries",()=>{
  it.each([1,40])("does not create a new incident from an orphan and only a %i-day-old terminal Job",async age=>{
    const f=fixture(age);
    try {
      expect(await f.candidates()).toEqual([]);
      expect(f.state.automaticRecovery.list()).toEqual([]);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
      expect(f.state.latestControlJob(f.agentId)?.jobId).toBe(f.jobId);
    } finally {await f.close();}
  });

  it("leaves a past legacy fingerprint and its exhausted budget unchanged instead of repairing history",async()=>{
    const f=fixture(40);
    const legacy={...f.identity,key:automaticRecoveryKey("recheck",[f.agentId,f.state.getAgent(f.agentId)!.version,null]),jobId:undefined};
    const first=now-5*day;
    try {
      f.state.automaticRecovery.observeRecheck(legacy,true,first);
      for(const at of [first,first+5000,first+35000]) {
        const record=f.state.automaticRecovery.begin(legacy,at)!;
        f.state.automaticRecovery.finish(legacy.key,record.attempts,{resolved:false,reason:"inspection-unconfirmed"},at);
      }
      const original=f.state.automaticRecovery.get(legacy.key);
      expect(await f.candidates()).toEqual([]);
      expect(f.state.automaticRecovery.list()).toEqual([original]);
      expect(original).toMatchObject({state:"blocked",attempts:3,occurredAt:first});
    } finally {await f.close();}
  });

  it("keeps a current unresolved incident's identity, clock and budget when memory projection disappears",async()=>{
    const f=fixture();
    try {
      f.state.automaticRecovery.observeRecheck(f.identity,true,now-1000);
      const record=f.state.automaticRecovery.begin(f.identity,now-1000)!;
      f.state.automaticRecovery.finish(record.key,record.attempts,{resolved:false,reason:"inspection-unconfirmed"},now-999);
      const original=f.state.automaticRecovery.get(f.identity.key);
      expect(await f.candidates()).toEqual([f.identity]);
      vi.spyOn(f.jobs,"observedLatestJobForAgent").mockReturnValue(undefined);
      expect(await f.candidates()).toEqual([f.identity]);
      expect(f.state.automaticRecovery.get(f.identity.key)).toEqual(original);
      expect(f.state.automaticRecovery.list()).toHaveLength(1);
    } finally {await f.close();}
  });

  it("does not reopen an expired unresolved history body or replenish its attempts",async()=>{
    const f=fixture(40);
    try {
      const first=now-40*day;
      f.state.automaticRecovery.observeRecheck(f.identity,true,first);
      const record=f.state.automaticRecovery.begin(f.identity,first)!;
      f.state.automaticRecovery.finish(record.key,record.attempts,{resolved:false,reason:"unconfirmed",retryable:false},first+1);
      f.state.maintainRecoveryRetention(now);
      expect(f.state.automaticRecovery.list()).toEqual([]);
      await f.candidates(); await f.candidates();
      expect(f.state.automaticRecovery.list()).toEqual([]);
      expect(f.state.automaticRecovery.begin(f.identity,now)).toBeUndefined();
    } finally {await f.close();}
  });

  it("keeps safety rechecks for an unresolved persistent connection even with an expired Job",async()=>{
    const f=fixture(40);
    try {
      f.state.threadConnections.register({threadId:f.threadId,agentId:f.agentId,scopeId,persistence:"persistent",workerPid:4321},now-1000);
      f.state.threadConnections.update(f.threadId,{phase:"blocked",reason:"shutdown-unconfirmed"},now-1000);
      expect(await f.candidates()).toContainEqual(f.identity);
      expect(f.state.automaticRecovery.get(f.identity.key)).toMatchObject({attempts:0,occurredAt:now});
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });

  it.each([true,false])("hands off an exhausted legacy control with matching generation, stored Job %s",async includeJob=>{
    const f=fixture();
    try {
      const legacy=oldIncident(f,now-50000,includeJob),original=f.state.automaticRecovery.get(legacy.key);
      openContext(f);
      expect(await f.candidates()).toEqual([]);
      expect(f.state.automaticRecovery.handoffRecheckIdentity(f.identity)).toEqual({...f.identity,key:legacy.key});
      f.state.renameAgent(f.agentId,"Renamed without a new execution",now);
      expect(await f.candidates()).toEqual([]);
      expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
      expect(f.state.automaticRecovery.list()).toEqual([original]);
      expect(f.state.automaticRecovery.begin({...f.identity,key:legacy.key},now)).toBeUndefined();
    } finally {await f.close();}
  });

  it("persists the handoff across restart without changing the historical origin or first clock",async()=>{
    const f=fixture();let reopened:BridgeStateStore|undefined;
    try {
      const legacy=oldIncident(f,now-50000),original=f.state.automaticRecovery.get(legacy.key);
      openContext(f);await f.candidates();await f.close();
      reopened=new BridgeStateStore({file:f.file});
      expect(reopened.automaticRecovery.handoffRecheckIdentity(f.identity)).toEqual({...f.identity,key:legacy.key});
      expect(reopened.automaticRecovery.get(legacy.key)).toEqual(original);
      expect(reopened.automaticRecovery.canBegin({...f.identity,key:legacy.key},now)).toBe(false);
    } finally {if(reopened)reopened.close();else await f.close();}
  });

  it("inherits the remaining retry backoff and spends only the original final attempt",async()=>{
    const f=fixture();
    try {
      const first=now-10000;
      const legacy={...f.identity,key:automaticRecoveryKey("recheck",[f.agentId,f.state.getAgent(f.agentId)!.version,f.jobId])};
      f.state.automaticRecovery.observeRecheck(legacy,true,first);
      for(const time of [first,first+5000]) {
        const record=f.state.automaticRecovery.begin(legacy,time)!;
        f.state.automaticRecovery.finish(record.key,record.attempts,{resolved:false,reason:"inspection-unconfirmed"},time);
      }
      const original=f.state.automaticRecovery.get(legacy.key)!;openContext(f);
      expect(await f.candidates()).toContainEqual({...f.identity,key:legacy.key});
      expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
      expect(f.state.automaticRecovery.begin({...f.identity,key:legacy.key},now)).toBeUndefined();
      const last=f.state.automaticRecovery.begin({...f.identity,key:legacy.key},original.nextAttemptAt)!;
      expect(last).toMatchObject({attempts:3,occurredAt:first});
      f.state.automaticRecovery.finish(last.key,last.attempts,{resolved:false,reason:"unconfirmed"},original.nextAttemptAt);
      expect(f.state.automaticRecovery.begin({...f.identity,key:legacy.key},original.nextAttemptAt+100000)).toBeUndefined();
      expect(f.state.automaticRecovery.list()).toHaveLength(1);
    } finally {await f.close();}
  });

  it("hands off only the expired budget, keeping its body and dashboard history absent",async()=>{
    const f=fixture(40);
    try {
      const legacy=oldIncident(f,now-40*day),original=f.state.automaticRecovery.get(legacy.key)!;
      f.state.maintainRecoveryRetention(now);openContext(f);
      await f.candidates();
      expect(f.state.automaticRecovery.handoffRecheckIdentity(f.identity)).toEqual({...f.identity,key:legacy.key});
      expect(f.state.automaticRecovery.list()).toEqual([]);
      expect(f.state.automaticRecovery.listForDashboard(scopeId)).toEqual([]);
      expect(f.state.automaticRecovery.steps(legacy.key)).toEqual([]);
      expect(f.state.automaticRecovery.begin({...f.identity,key:legacy.key},now)).toBeUndefined();
      expect(original.attempts).toBe(3);
    } finally {await f.close();}
  });

  it.each([true,false])("does not hand a prior budget to a newly admitted Job, old stored Job %s",async includeJob=>{
    const f=fixture();
    try {
      const legacy=oldIncident(f,now-50000,includeJob),original=f.state.automaticRecovery.get(legacy.key);
      const jobId=randomUUID();
      f.state.upsertJob({...f.source,jobId,requestId:randomUUID(),status:"running",createdAt:now-1000,updatedAt:now-1000});
      f.state.setAgentExecutionState(f.agentId,"orphaned",{orphanedReason:"new runtime inspection unavailable",now:now-1000});
      openContext(f);
      const identity={...f.identity,jobId,key:automaticRecoveryKey("recheck",[f.agentId,jobId,f.threadId])};
      expect(await f.candidates()).toContainEqual(identity);
      expect(f.state.automaticRecovery.get(identity.key)).toMatchObject({attempts:0,occurredAt:now});
      expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
    } finally {await f.close();}
  });

  it("does not hand a prior budget to a new Thread generation",async()=>{
    const f=fixture();
    try {
      const legacy=oldIncident(f,now-50000,false),original=f.state.automaticRecovery.get(legacy.key);
      const threadId="new-thread-generation";
      f.state.linkAgentThread({agentId:f.agentId,threadId,backendKind:"app-server",cwd:"/tmp",sandbox:"read-only",contextMode:"fresh",now:now-1000});
      f.state.setAgentExecutionState(f.agentId,"orphaned",{orphanedReason:"new runtime inspection unavailable",now:now-1000});
      f.state.threadConnections.register({threadId,agentId:f.agentId,scopeId,persistence:"ephemeral"},now-1000);
      const identity={...f.identity,jobId:undefined,key:automaticRecoveryKey("recheck",[f.agentId,undefined,threadId])};
      expect(await f.candidates()).toContainEqual(identity);
      expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
      expect(f.state.automaticRecovery.list()).toHaveLength(2);
    } finally {await f.close();}
  });

  it("allows a real recurrence after confirming the same handed-off context",async()=>{
    const f=fixture();
    try {
      const legacy=oldIncident(f,now-50000);openContext(f);await f.candidates();
      const identity=f.state.automaticRecovery.handoffRecheckIdentity(f.identity);
      f.state.automaticRecovery.observeRecheck(identity,false,now,"runtime-observed");
      const original=f.state.automaticRecovery.get(legacy.key);
      f.state.automaticRecovery.observeRecheck(identity,true,now+1);
      const recurring=f.state.automaticRecovery.recheckCandidate(identity)!;
      expect(recurring.key).not.toBe(legacy.key);
      expect(f.state.automaticRecovery.get(recurring.key)).toMatchObject({attempts:0,occurredAt:now+1});
      expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
      expect(f.state.automaticRecovery.listForDashboard(scopeId)).toHaveLength(2);
    } finally {await f.close();}
  });

  it("does not inherit an already persisted alias when a new execution is admitted",async()=>{
    const f=fixture();
    try {
      const legacy=oldIncident(f,now-50000,false);openContext(f);await f.candidates();
      expect(f.state.automaticRecovery.handoffRecheckIdentity(f.identity).key).toBe(legacy.key);
      const jobId=randomUUID();
      f.state.upsertJob({...f.source,jobId,requestId:randomUUID(),status:"running",createdAt:now-1000,updatedAt:now-1000});
      f.state.setAgentExecutionState(f.agentId,"orphaned",{orphanedReason:"new execution unknown",now});
      const identity={...f.identity,jobId,key:automaticRecoveryKey("recheck",[f.agentId,jobId,f.threadId])};
      expect(await f.candidates()).toContainEqual(identity);
      expect(f.state.automaticRecovery.begin(identity,now)?.attempts).toBe(1);
      expect(f.state.automaticRecovery.get(legacy.key)).toMatchObject({state:"blocked",attempts:3});
    } finally {await f.close();}
  });

  it("does not guess a canonical origin when two compatible legacy controls are active",async()=>{
    const f=fixture();
    try {
      const first=oldIncident(f,now-50000,true),second=oldIncident(f,now-50000,false);
      const original=f.state.automaticRecovery.list();openContext(f);
      expect(f.state.automaticRecovery.handoffRecheckIdentity(f.identity)).toBeUndefined();
      expect(await f.candidates()).toEqual([]);
      expect(f.state.automaticRecovery.list()).toEqual(original);
      expect(f.state.automaticRecovery.get(first.key)?.attempts).toBe(3);
      expect(f.state.automaticRecovery.get(second.key)?.attempts).toBe(3);
    } finally {await f.close();}
  });

  it("confirmed display observation closes the same handed-off origin even after connection release",async()=>{
    const f=fixture();
    const upstream={probeThread:async()=>({state:"resumable",runtimeStatus:"notLoaded"}),listTools:async()=>({tools:[]}),close:async()=>{}} as unknown as CodexUpstream;
    let server:ReturnType<typeof dashboard>|undefined;
    try {
      const legacy=oldIncident(f,now-50000),first=f.state.automaticRecovery.get(legacy.key)!.occurredAt;
      openContext(f);await f.candidates();
      f.state.threadConnections.update(f.threadId,{phase:"released",evidence:"worker-exited"},now);
      server=dashboard(f,upstream);
      await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
      expect(f.state.automaticRecovery.get(legacy.key)).toMatchObject({state:"resolved",attempts:3,occurredAt:first,evidence:"runtime-observed"});
      expect(f.state.automaticRecovery.list()).toHaveLength(1);
    } finally {await server?.close();await f.close();}
  });

  it("observed busy work keeps safety inspection when the previous connection was released",async()=>{
    const f=fixture();
    const upstream={probeThread:async()=>({state:"busy"}),listLoadedBackgroundTerminals:async()=>{throw Error("background inspection unavailable");},
      listTools:async()=>({tools:[]}),close:async()=>{}} as unknown as CodexUpstream;
    const server=dashboard(f,upstream);
    try {
      await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
      expect(f.state.automaticRecovery.get(f.identity.key)).toMatchObject({attempts:0,occurredAt:now});
      expect(f.state.threadConnections.get(f.threadId)).toMatchObject({phase:"released",evidence:"worker-exited"});
    } finally {await server.close();await f.close();}
  });

  it("unavailable historical display inspection does not create an incident or a new budget",async()=>{
    const f=fixture(40);
    const probeThread=vi.fn(async()=>({state:"unknown"}));
    const upstream={probeThread,listTools:async()=>({tools:[]}),close:async()=>{}} as unknown as CodexUpstream;
    const server=dashboard(f,upstream);
    try {
      await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
      expect(probeThread).toHaveBeenCalled();
      expect(f.state.automaticRecovery.list()).toEqual([]);
      expect(await f.candidates()).toEqual([]);
    } finally {await server.close();await f.close();}
  });

  it("keeps unavailable display inspection as a current incident when a running Job is protected",async()=>{
    const f=fixture(1,"running");
    const upstream={probeThread:async()=>({state:"unknown"}),listTools:async()=>({tools:[]}),close:async()=>{}} as unknown as CodexUpstream;
    const server=dashboard(f,upstream);
    try {
      await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
      expect(f.state.automaticRecovery.get(f.identity.key)).toMatchObject({attempts:0,occurredAt:now});
      expect(f.jobs.get(f.jobId)?.status).toBe("running");
    } finally {await server.close();await f.close();}
  });
});
