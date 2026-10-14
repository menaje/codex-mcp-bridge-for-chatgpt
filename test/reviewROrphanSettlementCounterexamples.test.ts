import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {describe,it,expect,vi,afterEach} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {CodexJobRegistry,settleReleasedOrphan,configureAutomaticRecovery} from "../src/tools.js";
import {automaticRecoveryKey,type AutomaticRecoveryController} from "../src/automaticRecovery.js";
import {loadConfig} from "../src/config.js";
import {ScopeResolver} from "../src/scopeResolver.js";
import {SessionRegistry} from "../src/sessionRegistry.js";
import {UserSettingsStore} from "../src/userSettings.js";
import {createBridgeMcpServer} from "../src/server.js";
import type {CodexUpstream} from "../src/upstream.js";
const scopeId="11111111-1111-4111-8111-111111111111",now=Date.UTC(2026,9,14,12),day=86400000;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(age=1) {
  vi.spyOn(Date,"now").mockReturnValue(now);
  const root=mkdtempSync(path.join(tmpdir(),"orphan-settlement-")),file=path.join(root,"state.sqlite");
  const state=new BridgeStateStore({file}),db=new Database(file);
  const agent=state.createAgent({scopeId,agentName:"Stopped orphan",now:now-40*day});
  const activity=state.createActivity({scopeId,title:"Preserved execution",now:now-40*day});
  const threadId="stopped-thread",jobId=randomUUID();
  state.linkAgentThread({agentId:agent.agentId,threadId,backendKind:"app-server",cwd:root,sandbox:"read-only",contextMode:"fresh",now:now-40*day});
  const source={jobId,scopeId,requestId:randomUUID(),agentId:agent.agentId,activityId:activity.activityId,threadId,
    backendKind:"app-server",createdAt:now-age*day-1000,updatedAt:now-age*day,status:"failed",lastProgressAt:now-age*day,
    version:1,cwd:root,sandbox:"read-only",operation:"start",requestHash:"a".repeat(64),requestHashVersion:11,
    exclusiveKeys:[],trackingState:"connected",completionDeliveryPolicy:"direct-wait",
    sessionDecision:{requestedMode:"new",action:"start",reason:"explicit-new"},pendingInteractions:[],result:{original:"preserved"}};
  state.upsertJob(source);state.setAgentExecutionState(agent.agentId,"orphaned",{orphanedReason:"missing worker",now:now-age*day});
  state.threadConnections.update(threadId,{phase:"released",evidence:"worker-exited"},now-age*day);
  const identity={key:automaticRecoveryKey("recheck",[agent.agentId,jobId,threadId]),scopeId,agentId:agent.agentId,jobId,kind:"recheck" as const};
  const first=now-age*day;
  state.automaticRecovery.observeRecheck(identity,true,first);
  for(const at of [first,first+5000,first+35000]) {
    const r=state.automaticRecovery.begin(identity,at)!;
    state.automaticRecovery.finish(r.key,r.attempts,{resolved:false,reason:"inspection-unconfirmed"},at);
  }
  if(age>30) {state.maintainHistoryRetention(now);state.maintainRecoveryRetention(now);}
  const jobs=new CodexJobRegistry({stateStore:state,projectionOnly:true});
  const read=vi.fn(async()=>null);
  let closed=false;
  const upstream={listLoadedBackgroundTerminals:read} as unknown as CodexUpstream;
  const proof=()=>({agentId:agent.agentId,version:state.getAgent(agent.agentId)!.version,threadId,
    connectionRevision:state.threadConnections.get(threadId)!.revision,controlJobId:state.latestControlJob(agent.agentId)?.jobId});
  const snapshot=()=>JSON.stringify({jobs:db.prepare("SELECT * FROM jobs").all(),bodies:db.prepare("SELECT * FROM job_result_bodies").all(),
    recovery:db.prepare("SELECT * FROM automatic_recovery").all(),steps:db.prepare("SELECT * FROM automatic_recovery_steps").all(),
    controls:db.prepare("SELECT * FROM recovery_controls").all(),incidents:db.prepare("SELECT * FROM automatic_recovery_incidents").all()});
  return {state,db,file,root,jobs,upstream,read,source,identity,threadId,agentId:agent.agentId,proof,snapshot,
    async close(){if(closed)return;closed=true;await jobs.closeThreadConnections();db.close();state.close();}};
}
function dashboard(f:ReturnType<typeof fixture>) {
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:"1",CODEX_MCP_BRIDGE_CODEX:"/usr/bin/false",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:f.file,CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(f.root,"skills")});
  return createBridgeMcpServer(config,f.upstream,new SessionRegistry({stateStore:f.state,projectionOnly:true}),f.jobs,
    undefined,new UserSettingsStore(config,{stateStore:f.state}),new ScopeResolver({stateStore:f.state}));
}
describe('R independent orphan settlement counterexamples',()=>{
 it('does not infer foreground absence from a loaded thread with zero background terminals and no runtime cache',async()=>{
  const f=fixture();try {
   f.read.mockImplementation(async()=>[]);
   f.upstream.probeThread=vi.fn(async()=>({state:'busy'}));
   const original=f.snapshot(),before=f.state.getAgent(f.agentId);
   const settled=await settleReleasedOrphan(f.jobs,f.upstream,f.agentId);
   console.log(JSON.stringify({case:'loaded-empty-background-but-foreground-busy',settled,probeCalls:vi.mocked(f.upstream.probeThread).mock.calls.length,lifecycle:f.state.getAgent(f.agentId)?.lifecycle,proof:f.state.hasEndedOrphanProof(f.agentId)}));
   expect(settled).toBe(false);
   expect(f.state.getAgent(f.agentId)).toEqual(before);expect(f.snapshot()).toBe(original);
  }finally{await f.close();}
 });
 it('does not permanently skip a subsequently positive actual background observation on the same idle thread',async()=>{
  const f=fixture();let server:ReturnType<typeof dashboard>|undefined;try {
   expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
   f.read.mockImplementation(async()=>[{processId:'new-real-background'}] as any);f.read.mockClear();
   f.upstream.probeThread=vi.fn(async()=>({state:'busy'}));
   server=dashboard(f);
   const view=await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false,
     problems:{review:'pending',kind:'all',offset:0}});
   console.log(JSON.stringify({case:'positive-after-ended-proof',backgroundReads:f.read.mock.calls.length,probeCalls:vi.mocked(f.upstream.probeThread).mock.calls.length,active:view.counts.active,background:view.counts.backgroundProcesses,currentImpact:view.problems?.currentImpactCount}));
   expect(f.read).toHaveBeenCalled();
   expect(view.counts.backgroundProcesses).toBeGreaterThan(0);
  }finally{await server?.close();await f.close();}
 });
});
