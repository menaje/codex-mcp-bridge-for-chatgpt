import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {describe,it,expect,vi,afterEach} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {CodexJobRegistry,settleReleasedOrphan,configureAutomaticRecovery} from "../src/tools.js";
import {automaticRecoveryKey,AutomaticRecoveryController} from "../src/automaticRecovery.js";
import {loadConfig} from "../src/config.js";
import {ScopeResolver} from "../src/scopeResolver.js";
import {SessionRegistry} from "../src/sessionRegistry.js";
import {UserSettingsStore} from "../src/userSettings.js";
import {createBridgeMcpServer} from "../src/server.js";
import type {CodexUpstream} from "../src/upstream.js";
const scopeId="11111111-1111-4111-8111-111111111111",now=Date.UTC(2026,9,14,12),day=86400000;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(age=1,attempts=3,traceSql?:(sql:string)=>void) {
  vi.spyOn(Date,"now").mockReturnValue(now);
  const root=mkdtempSync(path.join(tmpdir(),"orphan-settlement-")),file=path.join(root,"state.sqlite");
  const state=new BridgeStateStore({file,traceSql}),db=new Database(file);
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
  for(const at of [first,first+5000,first+35000].slice(0,attempts)) {
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

describe("R reloaded foreground boundaries",()=>{
  it.each(["null","idle","unknown","orphaned","throws"])("rechecks a prior busy generation after a fresh %s observation",async status=>{
    const f=fixture();let server:ReturnType<typeof dashboard>|undefined;try {
      const original=f.snapshot();expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
      f.read.mockImplementation(async()=>[] as any);
      f.upstream.probeThread=vi.fn(async()=>({state:"busy"} as any));server=dashboard(f);
      const query={scopeId,inspectRuntime:true,includeHistory:false,problems:{review:"pending" as const,kind:"all" as const,offset:0}};
      const busy=await server.applicationService.dashboardSnapshot(query);expect(busy.counts.active).toBe(1);expect(busy.problems?.currentImpactCount).toBe(1);
      vi.mocked(Date.now).mockReturnValue(now+6000);f.read.mockClear();vi.mocked(f.upstream.probeThread).mockClear();
      if(status==="null")f.read.mockImplementation(async()=>null);
      else f.upstream.probeThread=vi.fn(async()=>{if(status==="throws")throw Error("read failed");return status==="idle"?{state:"resumable",runtimeStatus:"idle"} as any:{state:status} as any;});
      const after=await server.applicationService.dashboardSnapshot(query);
      console.log(JSON.stringify({case:`busy-to-${status}`,active:after.counts.active,currentImpact:after.problems?.currentImpactCount,reads:f.read.mock.calls.length,probes:vi.mocked(f.upstream.probeThread).mock.calls.length,enrichment:after.enrichment}));
      expect(f.read).toHaveBeenCalled();expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("idle");expect(after.counts.orphanedAgents).toBe(0);expect(f.snapshot()).toBe(original);
      if(status==="null"){
        vi.mocked(Date.now).mockReturnValue(now+12000);
        const repeated=await server.applicationService.dashboardSnapshot(query);
        console.log(JSON.stringify({case:"busy-to-null-repeat",active:repeated.counts.active,currentImpact:repeated.problems?.currentImpactCount,reads:f.read.mock.calls.length,probes:vi.mocked(f.upstream.probeThread).mock.calls.length,enrichment:repeated.enrichment}));
        expect(f.snapshot()).toBe(original);
      }
      if(["null","idle"].includes(status)){expect(after.counts.active).toBe(0);expect(after.problems?.currentImpactCount).toBe(0);}
      if(status==="null")expect(f.upstream.probeThread).not.toHaveBeenCalled();
    }finally{await server?.close();await f.close();}
  });
  it("observes a terminal that starts during reloaded foreground idle probing",async()=>{
    const f=fixture();let server:ReturnType<typeof dashboard>|undefined;try{
      const original=f.snapshot();expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
      f.read.mockImplementationOnce(async()=>[] as any).mockImplementationOnce(async()=>[{processId:"new-terminal"}] as any);
      f.upstream.probeThread=vi.fn(async()=>({state:"resumable",runtimeStatus:"idle"} as any));server=dashboard(f);
      const view=await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false,problems:{review:"pending",kind:"all",offset:0}});
      expect(view.counts.active).toBe(1);expect(view.counts.backgroundProcesses).toBe(1);expect(view.problems?.currentImpactCount).toBe(1);expect(f.snapshot()).toBe(original);
    }finally{await server?.close();await f.close();}
  });
  it("rejects a late reloaded-busy result after changing to a different Thread",async()=>{
    const f=fixture();let server:ReturnType<typeof dashboard>|undefined;try{
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);const original=f.snapshot();
      f.read.mockImplementation(async()=>[] as any);
      let finish!:(value:any)=>void;f.upstream.probeThread=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
      server=dashboard(f);const query={scopeId,inspectRuntime:true,includeHistory:false,problems:{review:"pending" as const,kind:"all" as const,offset:0}};
      const old=server.applicationService.dashboardSnapshot(query);
      for(let n=0;n<30&&!finish;n++)await Promise.resolve();expect(finish).toBeDefined();
      f.state.linkAgentThread({agentId:f.agentId,threadId:"replacement-thread",backendKind:"app-server",cwd:f.root,sandbox:"read-only",contextMode:"fresh"});
      f.read.mockImplementation(async()=>null);
      const current=await server.applicationService.dashboardSnapshot(query);expect(current.counts.active).toBe(0);
      finish({state:"busy"});await old;
      const after=await server.applicationService.dashboardSnapshot(query);
      expect(after.counts.active).toBe(0);expect(after.problems?.currentImpactCount).toBe(0);expect(f.snapshot()).toBe(original);
    }finally{await server?.close();await f.close();}
  });

});
