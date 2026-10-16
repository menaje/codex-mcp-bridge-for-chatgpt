// Diagnostic source adapted to require explicit private fixture paths.
// Timings include the cold first request; deadlines and capacity remain production defaults.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
const root=process.env.BRIDGE242_CONTROL_DIRECTORY;
if (!root) throw Error('Select a private directory containing a read-only DB backup as observed.sqlite');
const label=process.argv[2]||'ordinary';
const runtime=process.env.BRIDGE242_CONTROL_RUNTIME;
if (!runtime) throw Error('Select the built runtime directory explicitly');
const {ChildProcessStateReadService}=await import(pathToFileURL(runtime+'/dist/stateReadProcess.js'));
await fs.mkdir(root+'/home',{recursive:true,mode:0o700});
const env={PATH:process.env.PATH,HOME:root+'/home',CODEX_HOME:root+'/home/codex',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:'/',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:root+'/observed.sqlite',CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE:root+'/telemetry.sqlite',CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:root+'/models.json',CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:root+'/skills',CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS:'2000'};
const measurements=[],observations=[];
const service=await ChildProcessStateReadService.start(env.CODEX_MCP_BRIDGE_STATE_DATABASE_FILE,env,{onMeasurement:r=>{const {requestId,...safe}=r;measurements.push(safe)}});
const priority=execFileSync('/bin/ps',['-p',String(service.processId),'-o','pri=,nice='],{encoding:'utf8'}).trim();
try{
 const samples=Number(process.argv[3]||1);
 for(const includeHistory of [false,true])for(let index=0;index<samples;index++){
  const at=performance.now();
  try{const r=await service.dashboardSnapshot({limit:12,terminalOffset:0,inspectRuntime:false,statusFilter:'all',includeHistory,historyMode:'jobs',problems:{review:'pending',kind:'all',offset:0}},{deadlineAt:Date.now()+2500});const ms=performance.now()-at;observations.push({includeHistory,index,ms,ok:true,retainedJobs:r.counts.retainedJobs,rows:r.terminalRows.length})}
  catch(e){observations.push({includeHistory,index,ms:performance.now()-at,ok:false,error:e.message})}
  const drainDeadline=Date.now()+10000;
  while(service.health().inFlight>0&&Date.now()<drainDeadline)await new Promise(r=>setTimeout(r,25));
  if(service.health().inFlight)throw Error('Control reader failed to drain within its unchanged transport bound');
 }
}finally{
 await service.close();const report={label,priority,observations,measurements};await fs.writeFile(`${root}/control-${label}.json`,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}
