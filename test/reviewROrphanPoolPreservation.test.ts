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
describe('R independent bounded settlement preservation interactions',()=>{
 it('preserves the real controller retry journal when the shared observation pool has no free slot',async()=>{
  const f=fixture(1,1);let controller:AutomaticRecoveryController|undefined;const resolves:Array<(x:null)=>void>=[];
  const tasks:Promise<boolean>[]=[];
  try {
   f.read.mockImplementation(()=>new Promise(r=>resolves.push(r)));
   for(let n=0;n<8;n++) {
    const a=f.state.createAgent({scopeId,agentName:'Held-reader-'+n,now:now-day}),threadId='held-thread-'+n;
    f.state.linkAgentThread({agentId:a.agentId,threadId,backendKind:'app-server',cwd:f.root,sandbox:'read-only',contextMode:'fresh',now:now-day});
    f.state.upsertJob({...f.source,jobId:randomUUID(),requestId:randomUUID(),agentId:a.agentId,threadId});
    f.state.setAgentExecutionState(a.agentId,'orphaned',{orphanedReason:'awaiting held transport',now:now-day});
    f.state.threadConnections.update(threadId,{phase:'released',evidence:'worker-exited'},now-day);
    tasks.push(settleReleasedOrphan(f.jobs,f.upstream,a.agentId));
   }
   for(let n=0;n<30 && resolves.length<8;n++) await Promise.resolve();
   expect(resolves).toHaveLength(8);
   let options!:ConstructorParameters<typeof AutomaticRecoveryController>[1];
   vi.spyOn(f.jobs,'configureAutomaticRecovery').mockImplementation(x=>{options=x;});
   configureAutomaticRecovery(f.jobs,f.upstream,{} as any,()=>true);
   const before=f.state.automaticRecovery.get(f.identity.key);
   controller=new AutomaticRecoveryController(f.state.automaticRecovery,options);
   await controller.sweep(undefined,f.agentId);
   const after=f.state.automaticRecovery.get(f.identity.key);
   console.log(JSON.stringify({case:'no-read-pool-slot',before:{state:before?.state,attempts:before?.attempts,reason:before?.reason},after:{state:after?.state,attempts:after?.attempts,reason:after?.reason},backgroundCalls:f.read.mock.calls.length,agentState:f.state.getAgent(f.agentId)?.lifecycle}));
   expect(after).toEqual(before);
   // Repeated surveys with no slot must preserve the journal and leave room
   // for a later fresh read once those physical reservations settle.
   await controller.sweep(undefined,f.agentId);
   expect(f.state.automaticRecovery.get(f.identity.key)).toEqual(before);
   expect(f.read).toHaveBeenCalledTimes(8);
   for(const resolve of resolves)resolve(null);await Promise.allSettled(tasks);
   f.read.mockImplementation(async()=>null);
   await controller.sweep(undefined,f.agentId);
   for(let n=0;n<20;n++) await Promise.resolve();
   expect(f.state.getAgent(f.agentId)?.lifecycle).toBe('idle');
   expect(f.state.automaticRecovery.get(f.identity.key)).toEqual(before);
  }finally{for(const resolve of resolves)resolve(null);await Promise.allSettled(tasks);await controller?.close();await f.close();}
 });
});
