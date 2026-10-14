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
describe("conclusive orphan settlement",()=>{
  it.each([1,40])("ends a released orphan with %i-day history without editing incidents or budgets",async age=>{
    const f=fixture(age);
    try {
      const original=f.snapshot(),version=f.state.getAgent(f.agentId)!.version;
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
      expect(f.read).toHaveBeenCalledWith(f.threadId,"app-server");
      expect(f.state.getAgent(f.agentId)).toMatchObject({lifecycle:"idle",version:version+1});
      expect(f.state.getAgent(f.agentId)?.orphanedReason).toBeUndefined();
      expect(f.state.hasEndedOrphanProof(f.agentId)).toBe(true);expect(f.snapshot()).toBe(original);
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.version).toBe(version+1);
      const server=dashboard(f);
      const view=await server.applicationService.dashboardSnapshot({scopeId,statusFilter:"running",inspectRuntime:false,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(view.activeRows).toHaveLength(0);expect(view.counts.running).toBe(0);
      expect(view.problems?.currentImpactCount).toBe(0);
      const count=view.problems?.incidentCount;
      f.state.renameAgent(f.agentId,"Same stopped execution, renamed",now);
      expect(f.state.hasEndedOrphanProof(f.agentId)).toBe(true);
      const renamed=await server.applicationService.dashboardSnapshot({scopeId,statusFilter:"running",inspectRuntime:false,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(renamed.problems?.incidentCount).toBe(count);expect(renamed.problems?.currentImpactCount).toBe(0);
      f.upstream.probeThread=vi.fn(async()=>({state:"orphaned"}));
      const enriched=await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(f.upstream.probeThread).not.toHaveBeenCalled();expect(enriched.activeRows).toHaveLength(0);
      expect(enriched.problems?.currentImpactCount).toBe(0);expect(f.snapshot()).toBe(original);
      await server.close();
      await f.close();
      const reopened=new BridgeStateStore({file:f.file});
      expect(reopened.hasEndedOrphanProof(f.agentId)).toBe(true);expect(reopened.getAgent(f.agentId)?.lifecycle).toBe("idle");
      const restartedJobs=new CodexJobRegistry({stateStore:reopened,projectionOnly:true});
      const restartedServer=dashboard({...f,state:reopened,jobs:restartedJobs,upstream:{} as CodexUpstream});
      const restarted=await restartedServer.applicationService.dashboardSnapshot({scopeId,statusFilter:"running",inspectRuntime:false,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(restarted.activeRows).toHaveLength(0);expect(restarted.problems?.currentImpactCount).toBe(0);
      expect(restarted.problems?.incidentCount).toBe(count);await restartedServer.close();await restartedJobs.closeThreadConnections();reopened.close();
    } finally {await f.close();}
  });
  it("settles before an exhausted recovery budget would skip the Agent",async()=>{
    const f=fixture();
    try {
      let options!:ConstructorParameters<typeof AutomaticRecoveryController>[1];
      vi.spyOn(f.jobs,"configureAutomaticRecovery").mockImplementation(value=>{options=value;});
      configureAutomaticRecovery(f.jobs,f.upstream,{} as any,()=>true);
      const original=f.snapshot();expect(await options.candidates(f.agentId)).toEqual([]);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("idle");expect(f.snapshot()).toBe(original);
    } finally {await f.close();}
  });
  it.each(["idle","notLoaded","busy","unknown","orphaned","missing","throws"])("requires conclusive foreground evidence for loaded-empty %s",async status=>{
    const f=fixture();try {
      f.read.mockImplementation(async()=>[] as any);
      if(status!=="missing") f.upstream.probeThread=vi.fn(async()=> {
        if(status==="throws") throw Error("foreground unavailable");
        return ["idle","notLoaded"].includes(status) ? {state:"resumable",runtimeStatus:status} as any : {state:status} as any;
      });
      const original=f.snapshot(),before=f.state.getAgent(f.agentId);
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(["idle","notLoaded"].includes(status));
      expect(f.snapshot()).toBe(original);
      if(!["idle","notLoaded"].includes(status)) expect(f.state.getAgent(f.agentId)).toEqual(before);
      else expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("idle");
      if(status!=="missing") expect(f.upstream.probeThread).toHaveBeenCalledWith(f.threadId,"app-server");
    } finally {await f.close();}
  });
  it.each(["job","thread","connection","admission","question"])("rejects an idle foreground reply after a new %s",async kind=>{
    const f=fixture();try {
      f.read.mockImplementation(async()=>[] as any);
      let resolve!:(value:any)=>void;
      f.upstream.probeThread=vi.fn(()=>new Promise(r=>{resolve=r;}));
      const task=settleReleasedOrphan(f.jobs,f.upstream,f.agentId);
      for(let n=0;n<10&&!resolve;n++) await Promise.resolve();expect(resolve).toBeDefined();
      if(kind==="job") f.state.upsertJob({...f.source,jobId:randomUUID(),requestId:randomUUID(),status:"running",createdAt:now,updatedAt:now});
      if(kind==="thread") f.state.linkAgentThread({agentId:f.agentId,threadId:"new-thread",backendKind:"app-server",cwd:f.root,sandbox:"read-only",contextMode:"fresh"});
      if(kind==="connection") f.state.threadConnections.update(f.threadId,{phase:"connected"});
      if(kind==="admission") f.jobs.runtimeAdmission.admissionRevision++;
      if(kind==="question") f.state.upsertJob({...f.source,pendingInteractions:[{interactionId:"late-approval",isBlocking:true}]});
      const before=f.state.getAgent(f.agentId);resolve({state:"resumable",runtimeStatus:"idle"});
      expect(await task).toBe(false);expect(f.state.getAgent(f.agentId)).toEqual(before);expect(f.state.hasEndedOrphanProof(f.agentId)).toBe(false);
    } finally {await f.close();}
  });
  it("keeps observing new background work after settlement without editing the past incident or its budget",async()=>{
    const f=fixture();let server:ReturnType<typeof dashboard>|undefined;try {
      const original=f.snapshot();expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
      f.read.mockImplementation(async()=>[{processId:"later-background"}] as any);f.read.mockClear();
      f.upstream.probeThread=vi.fn(async()=>({state:"busy"} as any));server=dashboard(f);
      const view=await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(f.read).toHaveBeenCalled();expect(f.upstream.probeThread).not.toHaveBeenCalled();
      expect(view.counts.active).toBe(1);expect(view.counts.backgroundProcesses).toBe(1);
      expect(view.problems?.currentImpactCount).toBe(1);expect(f.snapshot()).toBe(original);
      vi.mocked(Date.now).mockReturnValue(now+3600000);f.read.mockImplementation(async()=>{throw Error("later unknown read");});
      const unknown=await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false,
        problems:{review:"pending",kind:"all",offset:0}});
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("idle");expect(unknown.counts.orphanedAgents).toBe(0);
      expect(f.snapshot()).toBe(original);
    } finally {await server?.close();await f.close();}
  });
  it.each(["running","terminating","termination-failed"])("protects a real %s execution",async status=>{
    const f=fixture();try {
      f.state.upsertJob({...f.source,jobId:randomUUID(),requestId:randomUUID(),status,createdAt:now-100,updatedAt:now});
      f.state.threadConnections.update(f.threadId,{phase:"released",evidence:"worker-exited"});
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("active");expect(f.read).not.toHaveBeenCalled();
    } finally {await f.close();}
  });
  it.each(["question","approval"])("protects a blocking %s even on a terminal Job",async kind=>{
    const f=fixture();try {
      f.state.upsertJob({...f.source,pendingInteractions:[{interactionId:kind,isBlocking:true}]});
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });
  it("protects a valid scope question",async()=>{
    const f=fixture();try {
      f.db.prepare("INSERT INTO user_questions(question_id,scope_id,request_id,expires_at,payload) VALUES (?,?,?,?,?)")
        .run(randomUUID(),scopeId,randomUUID(),now+day,JSON.stringify({status:"pending"}));
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });
  it.each(["recorded","dispatched"])("preserves a %s cancellation and blocks settlement",async status=>{
    const f=fixture();try {
      const {intent}=f.state.beginCancellationOperation({scopeId,requestId:randomUUID(),actionHash:"b".repeat(64),
        source:"operator",toolName:"test",actionName:"stop",target:{kind:"job",jobId:f.source.jobId,activityId:f.source.activityId,
          agentId:f.agentId,threadId:f.threadId},expectedVersion:1,reasonCode:"test-stop"});
      if(status==="dispatched") f.db.prepare("UPDATE cancellation_intents SET status='dispatched',dispatched_at=? WHERE intent_id=?").run(now,intent.intentId);
      const before=f.db.prepare("SELECT * FROM cancellation_intents").all();
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.db.prepare("SELECT * FROM cancellation_intents").all()).toEqual(before);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });
  it.each(["prepared","dispatching","uncertain"])("preserves a %s response journal and blocks settlement",async status=>{
    const f=fixture();try {
      const instance=f.db.prepare("SELECT instance_id FROM bridge_instances LIMIT 1").get() as {instance_id:string};
      f.db.prepare(`INSERT INTO steering_deliveries(scope_id,request_id,action_hash,job_id,expected_job_version,prompt_sha256,
        status,bridge_instance_id,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        scopeId,randomUUID(),"b".repeat(64),f.source.jobId,1,"c".repeat(64),status,instance.instance_id,now,now,status==="uncertain"?now:null);
      const before=f.db.prepare("SELECT * FROM steering_deliveries").all();
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.db.prepare("SELECT * FROM steering_deliveries").all()).toEqual(before);
    } finally {await f.close();}
  });
  it("does not accept a timeout or a late empty reply after connection evidence changed",async()=>{
    const f=fixture();try {
      vi.useFakeTimers();let resolve!:(value:null)=>void;
      f.read.mockImplementation(()=>new Promise(r=>{resolve=r;}));
      const task=settleReleasedOrphan(f.jobs,f.upstream,f.agentId);
      await vi.advanceTimersByTimeAsync(6001);expect(await task).toBe(false);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
      f.state.threadConnections.update(f.threadId,{phase:"blocked",reason:"new uncertainty"});
      resolve(null);await Promise.resolve();await Promise.resolve();
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });
  it("rejects an old empty reply superseded by a newer busy observation",async()=>{
    const f=fixture();const server=dashboard(f);try {
      let resolve!:(value:null)=>void;
      f.read.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
      f.upstream.probeThread=async()=>({state:"busy"} as any);
      const task=settleReleasedOrphan(f.jobs,f.upstream,f.agentId);await Promise.resolve();await Promise.resolve();
      await server.applicationService.dashboardSnapshot({scopeId,inspectRuntime:true,includeHistory:false});
      resolve(null);expect(await task).toBe(false);expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await server.close();await f.close();}
  });
  it.each(["unknown","positive","connection","scope","pending"])("does not settle from %s evidence",async kind=>{
    const f=fixture();try {
      if(kind==="unknown") f.read.mockImplementation(async()=>{throw Error("unavailable");});
      if(kind==="positive") f.read.mockImplementation(async()=>[{processId:"live"}] as any);
      if(kind==="connection") f.state.threadConnections.update(f.threadId,{phase:"blocked",reason:"unconfirmed"});
      if(kind==="scope") f.db.prepare("UPDATE thread_connections SET scope_id='other' WHERE thread_id=?").run(f.threadId);
      if(kind==="pending") f.jobs.runtimeAdmission.pendingAdmissions=1;
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.lifecycle).toBe("orphaned");
    } finally {await f.close();}
  });
  it.each(["job","thread","connection","admission","version","question"])("rejects a late empty reply after a new %s",async kind=>{
    const f=fixture();try {
      let resolve!:(value:null)=>void;f.read.mockImplementation(()=>new Promise(r=>{resolve=r;}));
      const task=settleReleasedOrphan(f.jobs,f.upstream,f.agentId);
      await Promise.resolve();await Promise.resolve();
      if(kind==="job") f.state.upsertJob({...f.source,jobId:randomUUID(),requestId:randomUUID(),status:"running",createdAt:now,updatedAt:now});
      if(kind==="thread") f.state.linkAgentThread({agentId:f.agentId,threadId:"new-thread",backendKind:"app-server",cwd:f.root,sandbox:"read-only",contextMode:"fresh"});
      if(kind==="connection") f.state.threadConnections.update(f.threadId,{phase:"connected"});
      if(kind==="admission") {f.jobs.runtimeAdmission.admissionRevision++;f.jobs.runtimeAdmission.pendingAdmissions=0;}
      if(kind==="version") f.state.renameAgent(f.agentId,"Changed while inspecting");
      if(kind==="question") f.state.upsertJob({...f.source,pendingInteractions:[{interactionId:"late-approval",isBlocking:true}]});
      const current=f.state.getAgent(f.agentId);
      resolve(null);expect(await task).toBe(false);expect(f.state.getAgent(f.agentId)).toEqual(current);
      expect(f.state.hasEndedOrphanProof(f.agentId)).toBe(false);
    } finally {await f.close();}
  });
  it("does not lend a prior proof to a newly admitted execution",async()=>{
    const f=fixture();try {
      expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(true);
      const jobId=randomUUID();f.state.upsertJob({...f.source,jobId,requestId:randomUUID(),status:"running",createdAt:now,updatedAt:now});
      f.state.setAgentExecutionState(f.agentId,"active",{currentJobId:jobId});
      expect(f.state.hasEndedOrphanProof(f.agentId)).toBe(false);expect(await settleReleasedOrphan(f.jobs,f.upstream,f.agentId)).toBe(false);
      expect(f.state.getAgent(f.agentId)?.currentJobId).toBe(jobId);
    } finally {await f.close();}
  });
});
