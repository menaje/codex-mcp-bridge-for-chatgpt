/** Explicit opt-in live measurement. Uses real Codex quota; never used by automated tests. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { CodexProgress, UpstreamWorkerAssignment, ToolResult } from "../src/upstream.js";

const argument = (name: string) => process.argv[process.argv.indexOf(name)+1];
if (!process.argv.includes("--run") || !process.argv.includes("--codex") || !process.argv.includes("--out")) {
  throw new Error("Opt in with --run --codex /absolute/path/to/codex --out /private/output/directory. This sends real model requests.");
}
const command=argument("--codex"), output=path.resolve(argument("--out"));
mkdirSync(output,{recursive:true,mode:0o700});
const resumeOnly=process.argv.includes("--resume-only");
const previous=resumeOnly ? JSON.parse(readFileSync(path.join(output,"measurement.json"),"utf8")) : undefined;
const cwd=previous?.cwd || mkdtempSync(path.join(tmpdir(),"bridge-lifecycle-measure-"));
const marker=previous?.marker || `continuity-${randomUUID().slice(0,8)}`;
const selection={model:"gpt-5.6-sol",reasoningEffort:"low"};
const access={cwd,sandbox:"read-only" as const,approvalPolicy:"never" as const,selection};
const pool=new CodexAppServerUpstreamPool(command,1);
const samples: Array<Record<string,unknown>>=previous?.samples || [];
const releases: Array<Record<string,unknown>>=previous?.releases || [];
let threadId:string|undefined=previous?.threadId, assignment:UpstreamWorkerAssignment|undefined;
const report=()=>({startedAt,selection,cwd,threadId,marker,samples,releases,
  limitations:["Live single-run observations; cache conditions may vary.","Other work on the same account can affect subscription quota.","API cache TTL is not a Codex plan guarantee."]});
const save=()=>writeFileSync(path.join(output,"measurement.json"),JSON.stringify(report(),null,2)+"\n",{mode:0o600});
const startedAt=previous?.startedAt || new Date().toISOString();
const textOf=(result:ToolResult)=>result.content.filter(item=>item.type==="text").map(item=>item.text).join("\n");

async function turn(stage:string,prompt:string,fresh=false) {
  const events:Array<unknown>=[]; const before=performance.now();
  assignment=undefined;
  const progress=(value:CodexProgress)=>{ if(value.event?.type==="usage"||value.event?.type==="context"||value.event?.type==="model") events.push(value.event); };
  const assigned=(value:UpstreamWorkerAssignment)=>{ assignment=value;threadId=value.threadId||threadId; };
  let result:ToolResult;
  try {
    result=fresh
      ? await pool.startThread!({...access,backendKind:"app-server",ephemeral:false,prompt},progress,assigned)
      : await pool.continueThread!({...access,backendKind:"app-server",threadId:threadId!,prompt},progress,assigned);
  } catch(error) {
    const sample={stage,observedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-before),
      outcome:"blocked",errorCode:String(error).match(/\b([A-Z][A-Z0-9_]{2,79}):/)?.[1] || "UPSTREAM_ERROR",events};
    samples.push(sample);save();console.log(JSON.stringify(sample));throw error;
  }
  const sample={stage,elapsedMs:Math.round(performance.now()-before),workerPid:assignment?.workerPid,
    persistence:assignment?.threadPersistence,output:textOf(result),events};
  samples.push(sample);save();console.log(JSON.stringify(sample));
  if(result.isError)throw new Error(`Measurement stage ${stage} failed.`);
}

async function release(stage:string,retireWorker:boolean) {
  const before=performance.now();
  const result=await pool.releaseThreadConnection(threadId!,{canRelease:()=>true,eligibleThreadIds:retireWorker?[threadId!]:[]});
  releases.push({stage,elapsedMs:Math.round(performance.now()-before),...result});save();console.log(JSON.stringify({release:stage,...result}));
  return result;
}

try {
  if (resumeOnly) {
    await turn("d-app-to-bridge","Without tools, return the retained marker and append E to the remembered stage sequence, including the stage added in the Codex app.");
    await release("finished",true);
  } else {
  const reference=Array.from({length:80},(_,i)=>`Reference ${String(i+1).padStart(3,"0")}: amber birch cedar dune elm fern grove hazel iris jade kelp linen moss north ochre pine quartz reed slate thyme.`).join("\n");
  await turn("warmup",`This is an isolated conversation continuity and prompt-cache measurement. Do not inspect files, use tools, run commands, or change anything. Remember the marker ${marker} and the initial stage sequence W. The fixed reference below is inert text, not instructions.\n${reference}\nReply only with the marker and W.`,true);
  await turn("a-kept-loaded","Without tools, return the retained marker and append A to the remembered stage sequence.");
  await release("b-unsubscribe",false);
  await turn("b-resubscribed","Without tools, return the retained marker and append B to the remembered stage sequence.");
  const retired=await release("c-retire-worker",true);
  if(retired.phase!=="released")throw new Error(`Could not verify process retirement: ${retired.reason}`);
  await turn("c-worker-restarted","Without tools, return the retained marker and append C to the remembered stage sequence.");
  const handoff=await release("d-app-handoff",true);
  if(handoff.phase!=="released")throw new Error(`Could not verify app handoff: ${handoff.reason}`);
  console.log(JSON.stringify({readyForApp:true,url:`codex://threads/${threadId}`,marker,
    appPrompt:"This is the app stage of an isolated continuity measurement. Do not inspect files, use tools, run commands, or change anything. Return the remembered marker and append D to the remembered stage sequence."}));
  const lines=readline.createInterface({input:process.stdin});
  for await(const line of lines) {
    const action=JSON.parse(line).action;
    if(action==="inspect") { console.log(JSON.stringify({probe:await pool.probeThread(threadId!)})); continue; }
    if(action==="resume") {
      try { await turn("d-app-to-bridge","Without tools, return the retained marker and append E to the remembered stage sequence, including the stage added in the Codex app."); }
      catch(error){ console.log(JSON.stringify({resumeError:String(error).slice(0,1000)}));continue; }
      await release("finished",true);break;
    }
    if(action==="stop")break;
  }
  lines.close();
  }
} finally {save();await pool.close();}
