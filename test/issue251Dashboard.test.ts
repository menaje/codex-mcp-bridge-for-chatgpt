import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { loadConfig } from "../src/config.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";
import { createBridgeMcpServer } from "../src/server.js";
const scope="11111111-1111-4111-8111-111111111111";
function setup() {
  const root=mkdtempSync(path.join(tmpdir(),"issue251-dashboard-")),file=path.join(root,"state.sqlite");
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:"1",CODEX_MCP_BRIDGE_CODEX:"/usr/bin/false",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,"skills")});
  const writer=new BridgeStateStore({file});const settings=new UserSettingsStore(config,{stateStore:writer});
  writer.writeSettings({...settings.current,historyRetentionDays:0},0);
  new ScopeResolver({stateStore:writer});
  return {root,file,config,writer};
}
function seed(writer:BridgeStateStore,root:string,agent:string,activity:string,at:number,status="completed",pending:any[]=[]) {
  const jobId=randomUUID();
  writer.upsertJob({jobId,requestId:randomUUID(),scopeId:scope,agentId:agent,activityId:activity,
    status,createdAt:at,updatedAt:at+100,lastProgressAt:at+100,version:1,cwd:root,sandbox:"read-only",
    operation:"start",requestHash:"a".repeat(64),requestHashVersion:11,exclusiveKeys:[],trackingState:"connected",
    completionDeliveryPolicy:"direct-wait",sessionDecision:{requestedMode:"new",action:"start",reason:"explicit-new"},
    pendingInteractions:pending,result:{content:[{type:"text",text:"fixture original"}]},error:status==="failed"?"fixture failure":undefined});
  if(status!=="running") writer.deleteJob(jobId);
  return jobId;
}
function read(f:ReturnType<typeof setup>) {
  const reader=new BridgeStateStore({file:f.file,readOnly:true});
  const jobs=new CodexJobRegistry({stateStore:reader,projectionOnly:true});
  let probes=0;
  const upstream:any={listTools:async()=>({tools:[]}),callTool:async()=>{probes++;throw Error("No probes in structural fixture");},close:async()=>{}};
  const server=createBridgeMcpServer(f.config,upstream,new SessionRegistry({stateStore:reader,projectionOnly:true}),jobs,undefined,
    new UserSettingsStore(f.config,{stateStore:reader,projectionOnly:true}),new ScopeResolver({stateStore:reader}));
  return {reader,jobs,server,service:server.applicationService,probes:()=>probes};
}
describe("#251 bounded shared display contract",()=>{
  it("preloads three summaries, keeps progress-independent revisions, and pages remaining history",async()=>{
    const f=setup(),now=Date.now();
    const activity=f.writer.createActivity({scopeId:scope,title:"Retained work",now:now-100000});
    const agent=f.writer.createAgent({scopeId:scope,agentName:"Owner",now:now-100000});
    for(let n=0;n<30;n++) seed(f.writer,f.root,agent.agentId,activity.activityId,now-100000+n*1000);
    const active=seed(f.writer,f.root,agent.agentId,activity.activityId,now,"running");
    const r=read(f);
    try {
      const view=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:"all",inspectRuntime:false,includeHistory:false});
      const row=view.statusRows![0]!;
      expect(row.history).toHaveLength(3);expect(row.historyCount).toBe(30);expect(row.historyHasMore).toBe(true);
      expect(row.policyRevision).toMatch(/^[a-f0-9]{64}$/);expect(row.nextExpiryAt).toBeNull();
      const revision=row.historyRevision;
      f.writer.recordJobTelemetryEvent(active,"app-usage-updated",{type:"usage",details:{}},now+200,undefined,
        {updatedAt:now+200,version:2,lastProgressAt:now+200,pendingInteractions:[]});
      expect(f.writer.historyCacheMetadata([agent.agentId]).get(agent.agentId)?.historyRevision).toBe(revision);
      const first=await r.service.dashboardHistoryDetail!({rowKey:row.rowKey,scopeId:scope});
      expect(first.history).toHaveLength(12);expect(first.historyRevision).toBe(revision);expect(first.representativeExecutionKey).toBe(row.representativeExecutionKey);
      expect(first.history.slice(0,3)).toEqual(row.history);
      const second=await r.service.dashboardHistoryDetail!({rowKey:row.rowKey,scopeId:scope,historyCursor:first.nextCursor!});
      const third=await r.service.dashboardHistoryDetail!({rowKey:row.rowKey,scopeId:scope,historyCursor:second.nextCursor!});
      expect([...first.history,...second.history,...third.history]).toHaveLength(30);
      expect(new Set([...first.history,...second.history,...third.history].map(x=>x.executionKey)).size).toBe(30);
      expect(third.nextCursor).toBeNull();expect(r.probes()).toBe(0);
      f.writer.writeSettings({...f.writer.getSettingsRecord()!.payload as any,historyRetentionDays:7},1);
      await expect(r.service.dashboardHistoryDetail!({rowKey:row.rowKey,scopeId:scope,historyCursor:first.nextCursor!})).rejects.toThrow(/TARGET_CHANGED/);
    } finally {await r.server.close();r.reader.close();f.writer.close();}
  });
  it("sorts current runs by start time across old Activities and approval waits",async()=>{
    const f=setup(),now=Date.now();
    const old=f.writer.createActivity({scopeId:scope,title:"Older activity",now:now-100000});
    const fresh=f.writer.createActivity({scopeId:scope,title:"Newer activity",now:now-1000});
    const a=f.writer.createAgent({scopeId:scope,agentName:"Recent",now:now-100000});
    const b=f.writer.createAgent({scopeId:scope,agentName:"Earlier",now:now-1000});
    seed(f.writer,f.root,b.agentId,fresh.activityId,now-500,"running");
    seed(f.writer,f.root,a.agentId,old.activityId,now,"running",[{interactionId:"approval",isBlocking:true,kind:"command-approval",threadId:"fixture-thread",turnId:"fixture-turn",itemId:"fixture-item",summary:"Fixture approval"}]);
    const r=read(f);
    try {
      const v=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:"running",inspectRuntime:false,includeHistory:false});
      expect(v.statusRows?.map(x=>x.agentName)).toEqual(["Recent","Earlier"]);
      expect(v.statusRows?.[0]?.status).toBe("approval-required");expect(v.counts.approvalRequired).toBe(1);
    } finally {await r.server.close();r.reader.close();f.writer.close();}
  });
  it("returns one failure incident with recovery progression and no manual authority",async()=>{
    const f=setup(),now=Date.now();
    const activity=f.writer.createActivity({scopeId:scope,title:"Failed work",now});
    const agent=f.writer.createAgent({scopeId:scope,agentName:"Owner",now});
    const jobId=seed(f.writer,f.root,agent.agentId,activity.activityId,now-1000,"failed");
    const candidate={key:"failed-release",scopeId:scope,agentId:agent.agentId,jobId,kind:"release" as const};
    const attempt=f.writer.automaticRecovery.begin(candidate,now)!;
    f.writer.automaticRecovery.finish(candidate.key,attempt.attempts,{resolved:true,reason:"released",evidence:"exact source"},now+1);
    const r=read(f);
    try {
      const v=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:"all",inspectRuntime:false,
        problems:{review:"pending",kind:"all",offset:0},includeHistory:false});
      expect(v.problems?.incidentCount).toBe(1);expect(v.problems?.currentImpactCount).toBe(0);
      expect(v.problems?.rows[0]?.progress).toHaveLength(2);expect(v.counts.problems).toBe(1);
      expect(v.problems?.rows[0]).toMatchObject({currentImpact:"none",canAcknowledge:false,canUnacknowledge:false,canRecheck:false,canRetryStop:false});
      await expect(r.service.problemAction!({requestId:randomUUID(),action:"acknowledge",targets:[]},scope)).rejects.toThrow(/READ_ONLY/);
      expect(r.probes()).toBe(0);
    } finally {await r.server.close();r.reader.close();f.writer.close();}
  });
  it("bounds visible rows and response bytes while retaining large history populations",async()=>{
    const f=setup(),now=Date.now();
    for(let a=0;a<70;a++) {
      const activity=f.writer.createActivity({scopeId:scope,title:`Work ${a}`,now:now-100000});
      const agent=f.writer.createAgent({scopeId:scope,agentName:`Owner ${a}`,now:now-100000});
      for(let n=0;n<5;n++) seed(f.writer,f.root,agent.agentId,activity.activityId,now-100000+n*1000);
    }
    const r=read(f);
    try {
      const v=await r.service.dashboardSnapshot({scopeId:scope,statusFilter:"all",inspectRuntime:false,includeHistory:false,limit:12});
      expect(v.statusRows).toHaveLength(12);expect(v.statusRowsComplete).toBe(false);
      expect(v.statusPagination?.total).toBe(70);expect(v.counts.completed).toBe(350);
      expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(512*1024);
      expect(v.statusRows?.every(x=>x.history?.length===3)).toBe(true);
    } finally {await r.server.close();r.reader.close();f.writer.close();}
  });
});
