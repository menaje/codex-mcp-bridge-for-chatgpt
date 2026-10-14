import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {ChildProcessTelemetryService} from '../src/telemetryService.js';
import {acquireHistoryPolicyGate} from '../src/historyPolicyGate.js';

const day=86400000;
async function waitFor(predicate:()=>boolean) {
 const deadline=Date.now()+4000;
 while(Date.now()<deadline) {if(predicate()) return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Timed out waiting for telemetry ACK');
}
async function fixture(ageDays=40,count=1) {
 const root=mkdtempSync(path.join(tmpdir(),'issue251-committed-deletion-'));
 const sourceFile=path.join(root,'state.sqlite'),file=path.join(root,'telemetry.sqlite');
 const state=new BridgeStateStore({file:sourceFile});state.writeSettings({historyRetentionDays:0},0);
 const options={sourceStateDatabaseId:state.databaseId,sourceStateFile:sourceFile};
 let service=await ChildProcessTelemetryService.start(file,options);await service.close();
 const db=new Database(file),at=Date.now()-ageDays*day,bridgeId=randomUUID();
 const put=db.prepare("INSERT INTO transport_observations(observation_id,kind,bridge_instance_id,reason_code,created_at) VALUES (?,'status-wait-aborted',?,'old-jobless',?)");
 db.transaction(()=>{for(let i=1;i<=count;i++) put.run(i,bridgeId,at);})();
 service=await ChildProcessTelemetryService.start(file,options);
 let revision=1;
 return {root,sourceFile,file,state,db,options,service,at,bridgeId,
  policy(days:number) {state.writeSettings({historyRetentionDays:days},revision++);},
  count() {return Number((db.prepare('SELECT count(*) n FROM transport_observations').get() as any).n);},
  async sweep() {service.maintainRetention();await waitFor(()=>((service as any).retentionRequests as Set<string>).size===0);},
  async close() {await service.close();db.close();state.close();rmSync(root,{recursive:true,force:true});}};
}
function interceptDeletionAck(service:ChildProcessTelemetryService) {
 const child=(service as any).child;
 const handler=child.listeners('message')[0];expect(handler).toBeTypeOf('function');
 let held:any;
 const interceptor=(message:any)=>{if(message.type==='retained') held=message;else handler(message);};
 child.removeListener('message',handler);child.on('message',interceptor);
 return {child,get held(){return held;},deliver(){expect(held?.ok).toBe(true);handler(held);},
  restore(){child.removeListener('message',interceptor);child.on('message',handler);}};
}

describe('#251 committed telemetry deletion and parent cache identity',()=>{
 it.each([0,90])('does not resurrect physically deleted jobless records after expansion to%s or restart',async(expanded)=>{
  const f=await fixture(expanded===0 ? 100 : 40);
  try {
   expect(f.service.listTransportObservations()).toHaveLength(1);f.policy(7);
   expect(f.service.listTransportObservations()).toHaveLength(0);await f.sweep();expect(f.count()).toBe(0);
   f.policy(expanded);expect(f.service.listTransportObservations()).toEqual([]);expect(f.service.status().failed).toBe(0);
   await f.service.close();const restarted=await ChildProcessTelemetryService.start(f.file,f.options);
   try {expect(restarted.listTransportObservations()).toEqual([]);expect(f.count()).toBe(0);}finally{await restarted.close();}
  }finally{await f.close();}
 });

 it('removes only each committed64-row slice and preserves unexpired, running-linked and not-yet-deleted originals',async()=>{
  const f=await fixture(40,130);
  try {
   const scope=randomUUID(),jobId=randomUUID();
   f.state.upsertJob({jobId,scopeId:scope,requestId:randomUUID(),status:'running',createdAt:f.at,updatedAt:Date.now()});
   const bridge=randomUUID();
   f.service.recordTransportObservation({kind:'status-wait-aborted',reasonCode:'fresh-jobless'},bridge);
   f.service.recordTransportObservation({kind:'status-wait-aborted',jobId,scopeId:scope,reasonCode:'running-linked',now:f.at},bridge);
   await waitFor(()=>f.service.status().queued===0 && f.service.status().inFlight===0);
   expect(f.count()).toBe(132);f.policy(7);await f.sweep();expect(f.count()).toBe(68);
   f.policy(90);
   const visible=f.service.listTransportObservations();expect(visible).toHaveLength(68);
   expect(visible.filter(r=>r.reasonCode==='old-jobless')).toHaveLength(66);
   expect(visible.map(r=>r.reasonCode)).toContain('fresh-jobless');expect(visible.map(r=>r.reasonCode)).toContain('running-linked');
   f.policy(7);await f.sweep();expect(f.count()).toBe(4);await f.sweep();expect(f.count()).toBe(2);
   f.policy(0);expect(f.service.listTransportObservations().map(r=>r.reasonCode).sort()).toEqual(['fresh-jobless','running-linked']);
   expect((f.state.listJobs()[0] as any).status).toBe('running');
  }finally{await f.close();}
 });

 it('does not permanently remove hidden records when the policy expands before any committed deletion',async()=>{
  const f=await fixture(40);
  try {
   f.policy(7);expect(f.service.listTransportObservations()).toEqual([]);
   f.policy(90);expect(f.service.listTransportObservations()).toHaveLength(1);
   await f.sweep();expect(f.count()).toBe(1);expect(f.service.listTransportObservations()).toHaveLength(1);
  }finally{await f.close();}
 });

 it('failed policy-gate ACK and unsolicited/replayed ACK cannot erase retained originals',async()=>{
  const f=await fixture(40);
  let release:undefined|(()=>void);
  try {
   f.policy(7);release=acquireHistoryPolicyGate(f.sourceFile);
   const child=(f.service as any).child;
   f.service.maintainRetention();const requestId=[...((f.service as any).retentionRequests as Set<string>)][0];
   await waitFor(()=>f.service.status().failed===1);
   expect(f.count()).toBe(1);release();release=undefined;f.policy(0);
   expect(f.service.listTransportObservations()).toHaveLength(1);
   const deleted=[{observationId:1,bridgeInstanceId:f.bridgeId,createdAt:f.at}];
   child.emit('message',{type:'retained',requestId,ok:true,deleted});
   child.emit('message',{type:'retained',requestId:randomUUID(),ok:true,deleted});
   expect(f.service.listTransportObservations()).toHaveLength(1);expect(f.count()).toBe(1);
   expect(f.service.status().failed).toBe(1);
  }finally{release?.();await f.close();}
 });

 it('a late committed ACK prunes exactly its deleted originals after expansion and concurrent new observation',async()=>{
  const f=await fixture(40),intercept=interceptDeletionAck(f.service);
  try {
   f.policy(7);f.service.maintainRetention();await waitFor(()=>Boolean(intercept.held));
   expect(f.count()).toBe(0);f.policy(90);
   f.service.recordTransportObservation({kind:'status-wait-aborted',reasonCode:'concurrent-new',now:f.at},f.bridgeId);
   await waitFor(()=>f.service.status().queued===0 && f.service.status().inFlight===0);
   expect(f.count()).toBe(1);intercept.deliver();intercept.deliver();
   expect(f.service.listTransportObservations().map(r=>r.reasonCode)).toEqual(['concurrent-new']);
   expect(f.service.status().retained).toBe(1);expect(f.count()).toBe(1);
  }finally{intercept.restore();await f.close();}
 });

 it('worker restart reconciles a committed deletion whose ACK was lost and fences the old child',async()=>{
  const f=await fixture(40),intercept=interceptDeletionAck(f.service);
  try {
   f.policy(7);f.service.maintainRetention();await waitFor(()=>Boolean(intercept.held));expect(f.count()).toBe(0);
   f.policy(0);const oldPid=f.service.processId;process.kill(oldPid!,'SIGKILL');
   await waitFor(()=>!f.service.status().connected);
   f.service.recordTransportObservation({kind:'status-wait-aborted',reasonCode:'pending-during-restart'},randomUUID());
   await waitFor(()=>f.service.status().connected && f.service.processId!==oldPid);
   await waitFor(()=>f.service.status().queued===0 && f.service.status().inFlight===0);
   intercept.deliver();
   expect(f.service.listTransportObservations().map(r=>r.reasonCode)).toEqual(['pending-during-restart']);expect(f.count()).toBe(1);
  }finally{intercept.restore();await f.close();}
 });

 it('an expired new write ACK cannot leave an unpersisted historical body that reappears after expansion',async()=>{
  const f=await fixture(40);
  try {
   f.policy(7);await f.sweep();
   f.service.recordTransportObservation({kind:'status-wait-aborted',reasonCode:'expired-write',now:f.at},randomUUID());
   await waitFor(()=>f.service.status().queued===0 && f.service.status().inFlight===0);
   expect(f.count()).toBe(0);f.policy(90);expect(f.service.listTransportObservations()).toEqual([]);
  }finally{await f.close();}
 });
});
