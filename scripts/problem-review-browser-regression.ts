import {execFile} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {createServer} from "node:http";
import path from "node:path";
import {promisify} from "node:util";
import {DASHBOARD_CARD_HTML} from "../src/dashboardCard.js";
import {dashboardView} from "./card-browser-fixtures.js";

const artifacts=path.resolve("output/playwright/problem-review");mkdirSync(artifacts,{recursive:true});
const execute=promisify(execFile),session=`problem-review-${process.pid}`;
const prelude=`<script>(()=>{
 const fixture=${JSON.stringify(dashboardView("structural"))},base=fixture.terminalRows[0],epoch=Date.now();let sequence=0;
 const key=n=>n.toString(16).padStart(32,'0'),revision=n=>n.toString(16).padStart(64,'0');
 const failures=Array.from({length:113},(_,n)=>({problemKey:key(n+1),revision:revision(1),kind:'failed',source:'execution',review:'pending',acknowledgedAt:null,observedAt:new Date(epoch-3600000-n).toISOString(),reason:n===0?'실행 오류를 확인해 주세요.':null,canAcknowledge:true,canUnacknowledge:false,canRecheck:false,canRetryStop:false,other:n===112,
 row:{...base,rowKey:key(n+1000),agentName:'실패 검토 에이전트 '+(n+1),status:'failed',controlKind:null,history:[],historyCount:0,latestTurn:{...base.latestTurn,status:'failed',endedAt:new Date(epoch-3600000).toISOString(),durationMs:null}}}));
 const runtime=(n,kind)=>({problemKey:key(n),revision:revision(1),kind,source:'runtime',review:'pending',acknowledgedAt:null,observedAt:new Date(epoch).toISOString(),reason:null,canAcknowledge:false,canUnacknowledge:false,canRecheck:true,canRetryStop:kind==='termination-failed',...(kind==='termination-failed'?{stopImpact:{affectedJobIds:['run-a','run-b'],agentNames:['종료 대상 하나','종료 대상 둘']}}:{}),row:{...base,rowKey:key(n+1000),agentName:kind==='unknown'?'확인되지 않은 실행':'종료 실패 실행',status:kind==='unknown'?'liveness-unknown':kind,controlKind:null,history:[],historyCount:0}});
 let entries=[...failures,runtime(200,'unknown'),runtime(201,'termination-failed')];const proofs=new Map();
 window.__calls=[];window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
 window.openai={locale:'ko',notifyIntrinsicHeight:()=>{},callTool:async(name,args)=>{
  window.__calls.push({name,args});
  if(args.view==='problem-control'){const token='proof-'+proofs.size;proofs.set(token,{operation:args.operation,scope:args.scope});return {_meta:{'codex/problemControl@1':{token}},structuredContent:{kind:'control',ready:true}}}
  if(name==='codex_ui_problem'){
   const proof=proofs.get(args.token);if(!proof||!args.requestId||JSON.stringify(proof.operation.targets)!==JSON.stringify(args.targets)||proof.operation.action!==args.action)throw new Error('Invalid selection proof');
   await new Promise(resolve=>setTimeout(resolve,40));let changed=0;
   for(const target of args.targets){const item=entries.find(item=>item.problemKey===target.problemKey);if(!item||item.revision!==target.expectedRevision||proof.scope==='conversation'&&item.other)throw new Error('PROBLEM_TARGET_CHANGED');
    if(args.action==='acknowledge'||args.action==='unacknowledge'){item.review=args.action==='acknowledge'?'acknowledged':'pending';item.canAcknowledge=item.review==='pending';item.canUnacknowledge=!item.canAcknowledge;item.acknowledgedAt=item.canAcknowledge?null:new Date(epoch).toISOString();item.revision=revision(parseInt(item.revision,16)+1);changed++}
    if(args.action==='retry-stop'){if(args.acknowledgeAffectedJobIds?.join(',')!=='run-a,run-b')throw new Error('Wrong stop impact');entries=entries.filter(entry=>entry!==item);changed++}
   }return {structuredContent:{ok:true,changed}};
  }
  const scope=args.scope==='all'?'all':'conversation',query=args.problems||{review:'pending',kind:'all',offset:0},scoped=entries.filter(item=>scope==='all'||!item.other),filtered=scoped.filter(item=>item.review===query.review&&(query.kind==='all'||query.kind===item.kind));
  const limit=args.limit||12,offset=Math.min(query.offset,filtered.length?Math.floor((filtered.length-1)/limit)*limit:0),rows=filtered.slice(offset,offset+limit),pendingCount=scoped.filter(item=>item.review==='pending').length;
  const currentRows=[{...base,rowKey:key(9000),agentName:'진행 중인 실행',status:'running',bucket:'active',controlKind:null,history:[],historyCount:0}],recentRows=[failures[0].row],includeHistory=args.includeHistory!==false;
  const activeRows=includeHistory&&args.statusFilter!=='problems'?currentRows:[],terminalRows=includeHistory&&args.statusFilter!=='problems'?recentRows:[];
  return {structuredContent:{...fixture,statusFilter:args.statusFilter||'all',generatedAt:new Date(epoch+ ++sequence).toISOString(),filter:{mode:scope,conversationAvailable:true,conversationHasWork:true},activeRows,terminalRows,idleRows:[],
   statusRows:[...currentRows,...recentRows],statusRowsComplete:true,historyIncluded:includeHistory,
   counts:{...fixture.counts,running:1,problems:pendingCount,responseRequired:0},historyPolicy:{retentionDays:30,issueAttentionDays:7,reviewUntilRetention:true,lastCleanupAt:null,lastCleanupCount:0,totalRemoved:0},
   problems:{query:{...query,offset},revision:filtered.map(item=>item.problemKey+item.revision).join(''),pendingCount,acknowledgedCount:scoped.length-pendingCount,reviewableCount:scoped.filter(item=>item.canAcknowledge).length,rows,page:{offset,limit,total:filtered.length,returned:rows.length,hasPrevious:offset>0,hasNext:offset+rows.length<filtered.length}},
   pagination:{...fixture.pagination,active:{...fixture.pagination.active,returned:activeRows.length,total:activeRows.length},terminal:{...fixture.pagination.terminal,returned:terminalRows.length,total:terminalRows.length}}}};
 }};
})();</script>`;
const server=createServer((_request,response)=>{response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});response.end(DASHBOARD_CARD_HTML.replace("</head>",()=>prelude+"</head>"));});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function cli(...args:string[]){const result=await execute("npx",["--yes","--package","@playwright/cli@0.1.19","playwright-cli","--session",session,"--raw",...args],{timeout:55_000,maxBuffer:3*1024*1024});if(/Error:|TimeoutError:/.test(result.stdout))throw new Error(result.stdout);return result.stdout;}
try{
 await cli("open",origin);writeFileSync(path.join(artifacts,"initial.snapshot.txt"),await cli("snapshot"));
 await cli("run-code",`async page=>{
  await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='114');
  if(await page.locator('#active-section').isVisible()||await page.locator('#terminal-section').isVisible()||await page.locator('#problem-section').isVisible())throw new Error('Initial card did not stay on the summary');
  await page.locator('#history-filter').click();await page.locator('#history-policy').waitFor();
  if(!(await page.locator('#history-policy').innerText()).includes('보관 기간'))throw new Error('Run-history retention notice missing');
  if(!(await page.locator('#active-list').innerText()).includes('진행 중인'))throw new Error('Current work missing from run history');
  const before=await page.evaluate(()=>window.__calls.length);
  await page.locator('[data-status-filter="problems"]').click();
  await page.locator('#problem-list .problem-row').first().waitFor();
  if(await page.evaluate(()=>window.__calls.length)!==before)throw new Error('Opening the loaded problem list issued a data request');
  await page.waitForFunction(()=>document.querySelector('#active-list').closest('section').hidden);
  if(await page.locator('#terminal-list').isVisible())throw new Error('Problem filter still shows history');
  if(await page.locator('#history-policy').isVisible())throw new Error('Run-history policy remained visible in problem review');
  await page.locator('#problem-next').click();await page.waitForFunction(()=>document.querySelector('#problem-page-label').textContent.startsWith('13'));
  await page.locator('#problem-previous').click();await page.waitForFunction(()=>document.querySelector('#problem-page-label').textContent.startsWith('1–'));
  await page.locator('#problem-list input').first().check();await page.locator('#problem-ack-selected').click();
  await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='113');
  await page.locator('[data-problem-review="acknowledged"]').click();await page.getByRole('button',{name:'확인 취소',exact:true}).waitFor();
  if(!(await page.locator('#problem-list').innerText()).includes('실패'))throw new Error('Failure outcome disappeared');
  await page.getByRole('button',{name:'확인 취소',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='114');
  await page.locator('[data-problem-review="pending"]').click();await page.locator('#problem-kind').selectOption('unknown');
  await page.getByRole('button',{name:'상태 다시 확인',exact:true}).waitFor();
  if(await page.locator('#problem-list input').count()||await page.locator('#problem-ack-selected').isVisible())throw new Error('Unknown runtime can be bulk-reviewed');
  await page.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#problem-notice').textContent.includes('다시 확인했습니다'));
  if(!(await page.locator('#problem-list').innerText()).includes('확인되지 않은 실행'))throw new Error('Unresolved runtime hidden');
  await page.locator('#problem-kind').selectOption('termination-failed');await page.getByRole('button',{name:'종료 재시도',exact:true}).waitFor();
  await page.getByRole('button',{name:'종료 재시도',exact:true}).click();
  if(!(await page.locator('#problem-confirm').innerText()).includes('2개'))throw new Error('Missing termination impact');
 }`);
 await cli("snapshot");
 await cli("run-code",`async page=>{
  for(const width of [460,360]){await page.setViewportSize({width,height:900});if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Horizontal overflow');await page.screenshot({path:${JSON.stringify(artifacts)}+'/problem-'+width+'.png',fullPage:true})}
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:${JSON.stringify(artifacts)}+'/problem-dark.png',fullPage:true});
  await page.locator('#problem-confirm').getByRole('button',{name:'취소',exact:true}).click();
  if((await page.evaluate(()=>window.__calls.filter(call=>call.name==='codex_ui_problem'&&call.args.action==='retry-stop'))).length)throw new Error('Cancel stopped work');
  await page.getByRole('button',{name:'종료 재시도',exact:true}).click();await page.locator('#problem-confirm').getByRole('button',{name:'종료 재시도',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='113');
  await page.locator('#problem-kind').selectOption('failed');await page.locator('#problem-ack-all').click();
  await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='1');
  const batches=await page.evaluate(()=>window.__calls.filter(call=>call.name==='codex_ui_problem'&&call.args.action==='acknowledge').map(call=>call.args.targets.length));
  if(batches.join(',')!=='1,100,12')throw new Error('Wrong batches or repeated mutations: '+batches);
  const historyLeaks=await page.evaluate(()=>window.__calls.filter(call=>call.args?.statusFilter==='problems'&&call.args?.limit===50&&call.args?.includeHistory!==false).length);
  if(historyLeaks)throw new Error('Bulk problem paging requested run history');
  await page.locator('#problem-kind').selectOption('all');await page.locator('#scope-all').click();await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='2');
  for(const locale of ['en','ko','ja','zh-Hans','zh-Hant','es','fr','de','pt']){await page.evaluate(locale=>dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{locale}}})),locale);if(!(await page.locator('#problem-ack-all').innerText()).trim())throw new Error('Missing translation');if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Localized overflow: '+locale)}
  if((await page.evaluate(()=>window.__errors)).length)throw new Error(JSON.stringify(await page.evaluate(()=>window.__errors)));
 }`);
 const report={passed:19,artifacts,checks:["summary-first presentation","lazy run history","dedicated local problem view","retention notice","problem pagination","selected review","undo preserves outcome","unknown cannot be reviewed","recheck preserves unresolved runtime","exact termination impact","cancel does not stop","single confirmed stop","360/460 widths","dark mode","bulk beyond 100","history-free bulk paging","single mutation dispatch","conversation scope isolation","nine locales"]};
 writeFileSync(path.join(artifacts,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){writeFileSync(path.join(artifacts,"failure.snapshot.txt"),await cli("snapshot").catch(String));writeFileSync(path.join(artifacts,"failure-state.txt"),await cli("run-code",`async page=>console.log(JSON.stringify(await page.evaluate(()=>({calls:window.__calls.slice(-8),errors:window.__errors,message:document.querySelector('#message').textContent,page:document.querySelector('#problem-page-label').textContent,count:document.querySelector('#problems-count').textContent}))))`).catch(String));throw error;}finally{await cli("close").catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()));}
