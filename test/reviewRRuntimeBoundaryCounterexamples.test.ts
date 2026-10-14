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

describe('R independent current runtime boundary counterexamples',()=>{
 it('preserves a same-context exhausted legacy budget when rename occurs BEFORE first handoff',async()=>{
  const f=fixture();
  try {
   const legacy=oldIncident(f,now-50000),original=f.state.automaticRecovery.get(legacy.key);
   f.state.renameAgent(f.agentId,'Renamed before current identity handoff',now-1000);
   openContext(f);
   const candidates=await f.candidates();
   console.log(JSON.stringify({case:'rename-before-handoff',legacyAttempts:original?.attempts,
     candidates:candidates.map(x=>({sameKey:x.key===legacy.key,kind:x.kind})),
     records:f.state.automaticRecovery.list().map(x=>({sameKey:x.key===legacy.key,attempts:x.attempts,state:x.state,occurredAt:x.occurredAt}))}));
   expect(candidates).toEqual([]);
   expect(f.state.automaticRecovery.get(legacy.key)).toEqual(original);
   expect(f.state.automaticRecovery.list()).toEqual([original]);
  }finally{await f.close();}
 });
 it('permits real current uncertainty AFTER a first confirmed healthy observation without a prior alias',async()=>{
  const f=fixture();let server:ReturnType<typeof dashboard>|undefined;
  try {
   const legacy=oldIncident(f,now-50000),first=f.state.automaticRecovery.get(legacy.key)!.occurredAt;
   // No candidates/adoption call before this observation: connection already released.
   let busy=false;
   server=dashboard(f,{probeThread:async()=>busy ? {state:'busy'} : {state:'resumable',runtimeStatus:'notLoaded'},listLoadedBackgroundTerminals:async()=>{throw Error('current background unavailable');},listTools:async()=>({tools:[]}),close:async()=>{}} as unknown as CodexUpstream);
   await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
   console.log(JSON.stringify({case:'first-healthy-without-alias',state:f.state.automaticRecovery.get(legacy.key)?.state,records:f.state.automaticRecovery.list().length}));
   // Preserving an old history row is allowed. Its control must not swallow a
   // subsequent real occurrence after this authoritative healthy observation.
   expect(f.state.automaticRecovery.get(legacy.key)?.occurredAt).toBe(first);
   busy=true;
   vi.mocked(Date.now).mockReturnValue(now+3600000);
   await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
   const history=f.state.automaticRecovery.list();
   console.log(JSON.stringify({case:'healthy-then-current-busy-unavailable',records:history.map(x=>({sameKey:x.key===legacy.key,state:x.state,attempts:x.attempts,occurredAt:x.occurredAt}))}));
   expect(history).toHaveLength(2);
   expect(history.find(x=>x.key!==legacy.key)).toMatchObject({attempts:0,occurredAt:now+3600000});
  }finally{await server?.close();await f.close();}
 });
});
