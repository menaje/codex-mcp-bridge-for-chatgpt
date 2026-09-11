import {execFile} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {createServer} from "node:http";
import path from "node:path";
import {promisify} from "node:util";
import {DASHBOARD_CARD_HTML} from "../src/dashboardCard.js";
import {dashboardView} from "./card-browser-fixtures.js";

const artifacts=path.resolve("output/playwright/work-history");mkdirSync(artifacts,{recursive:true});
const fixture=dashboardView("structural"),execute=promisify(execFile),session=`work-history-${process.pid}`;
const prelude=`<script>(()=>{
 const fixture=${JSON.stringify(fixture)};let sequence=0,ack=false,cleaned=false;
 window.__calls=[];window.__errors=[];window.__change=null;
 addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
 const epoch=Date.now();window.openai={locale:'ko',notifyIntrinsicHeight:()=>{},callTool:async(name,args)=>{
  window.__calls.push({name,args});
  if(name==='codex_ui_history'){if(args.token!=='fixture-proof'||!args.requestId||args.action!=='acknowledge')throw new Error('Invalid history mutation');ack=true;return {structuredContent:{ok:true}}}
  if(args.view==='history')return {_meta:{'codex/historyControl@1':{rowKey:args.rowKey,revision:args.expectedRevision,token:'fixture-proof'}},structuredContent:{kind:'control',ready:true}};
  const ended=new Date(epoch-7200000).toISOString(),base=fixture.terminalRows[0],row={...base,rowKey:'a'.repeat(32),agentName:'기록 검토 에이전트',activityTitle:'이전 작업 확인',status:'failed',updatedAt:ended,
   latestTurn:{...base.latestTurn,status:'failed',startedAt:null,endedAt:ended,updatedAt:ended,durationMs:null},
   historyControls:{revision:'b'.repeat(64),canAcknowledge:!ack}};
  const running={...base,rowKey:'c'.repeat(32),agentName:'현재 실행 에이전트',activityTitle:'실행 시간 확인',bucket:'active',status:'running',history:[],historyCount:0,
   latestTurn:{...base.latestTurn,status:'running',startedAt:new Date(epoch-90000).toISOString(),updatedAt:new Date(epoch).toISOString(),endedAt:null,durationMs:1}};
  const includeHistory=args.includeHistory!==false,rows=cleaned||args.statusFilter==='running'||args.statusFilter==='response-required'||args.statusFilter==='problems'&&ack?[]:[row];
  const activeRows=args.statusFilter==='problems'||args.statusFilter==='response-required'?[]:[running];
  const result={...fixture,statusFilter:args.statusFilter||'all',generatedAt:new Date(epoch+ ++sequence).toISOString(),filter:{mode:'all',conversationAvailable:false,conversationHasWork:false},
   activeRows:includeHistory?activeRows:[],terminalRows:includeHistory?rows:[],statusRows:[running,...rows],statusRowsComplete:true,historyIncluded:includeHistory,
   counts:{...fixture.counts,running:1,responseRequired:0,problems:ack||cleaned?0:1},historyPolicy:{retentionDays:30,issueAttentionDays:7,lastCleanupAt:ended,lastCleanupCount:12,totalRemoved:cleaned?13:12},
   pagination:{...fixture.pagination,active:{...fixture.pagination.active,returned:includeHistory?activeRows.length:0,total:includeHistory?activeRows.length:0},terminal:{...fixture.pagination.terminal,returned:includeHistory?rows.length:0,total:includeHistory?rows.length:0}}};
  return {structuredContent:result};
 }};window.__cleanup=()=>{cleaned=true};
})();</script>`;
const server=createServer((_request,response)=>{response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});response.end(DASHBOARD_CARD_HTML.replace("</head>",()=>prelude+"</head>"));});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function cli(...args:string[]){const result=await execute("npx",["--yes","--package","@playwright/cli@0.1.19","playwright-cli","--session",session,"--raw",...args],{timeout:55_000,maxBuffer:3*1024*1024});if(/Error:|TimeoutError:/.test(result.stdout))throw new Error(result.stdout);return result.stdout;}
try{
 await cli("open",origin);writeFileSync(path.join(artifacts,"initial.snapshot.txt"),await cli("snapshot"));
 await cli("run-code",`async page=>{
  const check=(value,message)=>{if(!value)throw new Error(message)};
  await page.locator('#history-filter').click();
  await page.locator('#terminal-list .history-actions button').first().waitFor();
  check((await page.locator('#active-list').innerText()).includes('현재 실행'),'Current work visible');
  check(!(await page.locator('#active-list').innerText()).includes('기록 검토'),'Failure belongs in history');
  const currentTime=await page.locator('#active-list .time').innerText();
  check(currentTime.includes('작업시간')&&!currentTime.includes('시작'),'Current work has one snapshot-fixed duration');
  check((await page.locator('#terminal-list .time').first().innerText()).includes('작업시간 확인 불가'),'Unknown duration remains unknown');
  await page.locator('#terminal-list summary.history-toggle').click();
  check((await page.locator('#terminal-list .history-turn .time').first().innerText()).includes(' · '),'History has duration and relative time');
  check((await page.locator('#history-policy').innerText()).includes('30일'),'Retention is disclosed');
  check((await page.locator('#history-policy').innerText()).includes('12건'),'Cleanup count is disclosed');
  check(!(await page.locator('#history-policy').innerText()).includes(String.fromCharCode(92)+'n'),'Policy uses real line breaks');
  for(const width of [460,360]){await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');await page.screenshot({path:${JSON.stringify(artifacts)}+'/history-'+width+'.png',fullPage:true})}
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:${JSON.stringify(artifacts)}+'/history-dark.png',fullPage:true});
 }`);
 await cli("snapshot");
 await cli("run-code",`async page=>{
  await page.getByRole('button',{name:'확인함',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='0');
  if(!(await page.locator('#terminal-list').innerText()).includes('실패'))throw new Error('Acknowledgement rewrote outcome');
  if(await page.getByRole('button',{name:/에이전트 (보관|복원)/}).count())throw new Error('Retired Agent archive control remains');
  await page.evaluate(()=>window.__cleanup());await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===0);
  if((await page.evaluate(()=>window.__errors)).length)throw new Error('Browser errors');
  const calls=await page.evaluate(()=>window.__calls.filter(call=>call.name==='codex_ui_history').map(call=>call.args.action));
  if(calls.join(',')!=='acknowledge')throw new Error('Wrong or repeated mutations');
 }`);
 const report={passed:12,artifacts,checks:["current/failed split","live relative time","unknown duration","expanded history time","policy notice","cleanup count","360/460 widths","dark mode","acknowledge","archive controls absent","single mutation dispatch","cleanup refresh"]};
 writeFileSync(path.join(artifacts,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await cli("close").catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()));}
