import {execFile} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {createServer} from "node:http";
import path from "node:path";
import {promisify} from "node:util";
import {DASHBOARD_CARD_HTML} from "../src/dashboardCard.js";
import {dashboardView} from "./card-browser-fixtures.js";

const artifacts=path.resolve("output/playwright/automatic-recovery");mkdirSync(artifacts,{recursive:true});
const execute=promisify(execFile),session=`automatic-recovery-${process.pid}`;
const prelude=`<script>(()=>{
 const fixture=${JSON.stringify(dashboardView("structural"))},base=fixture.terminalRows[0],epoch=Date.now();let sequence=0;
 const key=n=>n.toString(16).padStart(32,'0'),revision=n=>n.toString(16).padStart(64,'0');
 const failures=Array.from({length:113},(_,n)=>({problemKey:key(n+1),revision:revision(1),kind:'failed',source:'execution',review:'pending',acknowledgedAt:null,observedAt:new Date(epoch-3600000-n).toISOString(),reason:n===0?'실행 오류를 확인해 주세요.':null,canAcknowledge:true,canUnacknowledge:false,canRecheck:false,canRetryStop:false,other:n===112,
 row:{...base,rowKey:key(n+1000),agentName:'실패 검토 에이전트 '+(n+1),status:'failed',controlKind:null,history:[],historyCount:0,latestTurn:{...base.latestTurn,status:'failed',endedAt:new Date(epoch-3600000).toISOString(),durationMs:null}}}));
 const runtime=(n,kind)=>({problemKey:key(n),revision:revision(1),kind,source:'runtime',review:'pending',acknowledgedAt:null,observedAt:new Date(epoch).toISOString(),reason:null,canAcknowledge:false,canUnacknowledge:false,canRecheck:true,canRetryStop:kind==='termination-failed',...(kind==='termination-failed'?{stopImpact:{affectedJobIds:['run-a','run-b'],agentNames:['종료 대상 하나','종료 대상 둘']}}:{}),row:{...base,rowKey:key(n+1000),agentName:kind==='unknown'?'확인되지 않은 실행':'종료 실패 실행',status:kind==='unknown'?'liveness-unknown':kind,controlKind:null,history:[],historyCount:0}});
 const recovered={...runtime(202,'unknown'),source:'recovery',review:'automatic',canRecheck:false,canRetryStop:false,
 automatic:{kind:'release',state:'resolved',attempts:1,reason:'idle-connection-released',evidence:'worker-exited'},row:{...failures[0].row,agentName:'자동으로 정리된 실패 실행'}};
 const uncertain=runtime(200,'unknown');uncertain.automatic={kind:'recheck',state:'blocked',attempts:3,reason:'inspection-unconfirmed'};
 let entries=[...failures,uncertain,runtime(201,'termination-failed'),recovered];const proofs=new Map();
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
  const scope=args.scope==='all'?'all':'conversation',query=args.problems||{review:'pending',kind:'all',offset:0},scoped=entries.filter(item=>scope==='all'||!item.other),filtered=scoped.filter(item=>(query.view==='history'?item.source==='execution':query.view==='automatic'?item.source==='recovery':item.source==='runtime'&&item.review==='pending')&&(query.kind==='all'||query.kind===item.kind));
  const limit=args.limit||12,offset=Math.min(query.offset,filtered.length?Math.floor((filtered.length-1)/limit)*limit:0),rows=filtered.slice(offset,offset+limit),pendingCount=scoped.filter(item=>item.source==='runtime'&&item.review==='pending').length;
  const activeRows=args.statusFilter==='problems'?[]:[{...base,rowKey:key(9000),agentName:'진행 중인 실행',status:'running',bucket:'active',controlKind:null,history:[],historyCount:0}],terminalRows=args.statusFilter==='problems'?[]:[failures[0].row];
  return {structuredContent:{...fixture,statusFilter:args.statusFilter||'all',generatedAt:new Date(epoch+ ++sequence).toISOString(),filter:{mode:scope,conversationAvailable:true,conversationHasWork:true},activeRows,terminalRows,idleRows:[],
   counts:{...fixture.counts,running:1,problems:pendingCount,responseRequired:0},historyPolicy:{retentionDays:30,issueAttentionDays:7,reviewUntilRetention:true,automaticRecovery:true,lastCleanupAt:null,lastCleanupCount:0,totalRemoved:0},
   problems:{query:{...query,offset},revision:filtered.map(item=>item.problemKey+item.revision).join(''),pendingCount,historyCount:scoped.filter(item=>item.source==='execution').length,automaticCount:scoped.filter(item=>item.source==='recovery').length,acknowledgedCount:scoped.filter(item=>item.review==='acknowledged').length,reviewableCount:scoped.filter(item=>item.canAcknowledge).length,rows,page:{offset,limit,total:filtered.length,returned:rows.length,hasPrevious:offset>0,hasNext:offset+rows.length<filtered.length}},
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
  await page.locator('#problem-list .problem-row').first().waitFor();
  if(await page.locator('#problems-count').innerText()!=='2')throw new Error('Finished failures counted as actionable');
  for(const view of ['actionable','history','automatic'])if(!(await page.locator('[data-problem-view="'+view+'"]').isVisible()))throw new Error('Missing view '+view);
  if(await page.locator('[data-problem-review="acknowledged"]').isVisible())throw new Error('Mandatory review tabs remain');
  await page.locator('[data-status-filter="problems"]').click();
  await page.waitForFunction(()=>document.querySelector('#active-list').closest('section').hidden);
  if(await page.locator('#problem-ack-all').isVisible())throw new Error('Runtime problems can be reviewed away');
  if(!(await page.locator('#problem-list').innerText()).includes('3'))throw new Error('Missing automatic attempts');
  await page.locator('[data-problem-view="history"]').click();
  await page.waitForFunction(()=>document.querySelector('#problem-list').textContent.includes('실패 검토 에이전트'));
  await page.locator('#problem-next').click();await page.waitForFunction(()=>document.querySelector('#problem-page-label').textContent.startsWith('21'));
  await page.locator('#problem-previous').click();await page.waitForFunction(()=>document.querySelector('#problem-page-label').textContent.startsWith('1–'));
  const original=await page.locator('#problem-list .problem-row').first().getAttribute('data-problem-key');
  await page.locator('#problem-list input').first().check();await page.locator('#problem-ack-selected').click();
  await page.waitForFunction(()=>document.querySelector('#problem-notice').textContent.includes('1'));
  if(await page.locator('#problems-count').innerText()!=='2')throw new Error('Optional review changed actionable count');
  const reviewed=page.locator('[data-problem-key="'+original+'"]');
  await reviewed.getByRole('button',{name:'확인 취소',exact:true}).waitFor();
  if(!(await reviewed.innerText()).includes('실패'))throw new Error('Original failure outcome changed');
  await reviewed.getByRole('button',{name:'확인 취소',exact:true}).click();
  await reviewed.locator('input').waitFor();
  await page.locator('[data-problem-view="automatic"]').click();
  await page.waitForFunction(()=>document.querySelector('#problem-list').textContent.includes('자동으로 정리된 실패 실행'));
  if(await page.locator('#problem-list input').count()||await page.locator('#problem-list button').count())throw new Error('Automatic evidence has manual review controls');
  if(!(await page.locator('#problem-list').innerText()).includes('실패'))throw new Error('Cleanup rewrote outcome');
 }`);
 await cli("snapshot");
 await cli("run-code",`async page=>{
  for(const width of [460,360]){await page.setViewportSize({width,height:900});if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Horizontal overflow');await page.screenshot({path:${JSON.stringify(artifacts)}+'/automatic-'+width+'.png',fullPage:true})}
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:${JSON.stringify(artifacts)}+'/automatic-dark.png',fullPage:true});
  await page.locator('[data-problem-view="history"]').click();await page.locator('#problem-ack-all').click();
  await page.waitForFunction(()=>document.querySelector('#problem-ack-all').disabled&&!document.querySelector('#problem-list input'));
  if(await page.locator('#problems-count').innerText()!=='2')throw new Error('Bulk review hid runtime problems');
  const batches=await page.evaluate(()=>window.__calls.filter(call=>call.name==='codex_ui_problem'&&call.args.action==='acknowledge').map(call=>call.args.targets.length));
  if(batches.join(',')!=='1,100,12')throw new Error('Wrong batches or repeated mutations: '+batches);
  await page.locator('#scope-all').click();await page.waitForFunction(()=>document.querySelector('#problem-page-label').textContent.includes('113'));
  await page.locator('[data-problem-view="actionable"]').click();await page.locator('#problem-kind').selectOption('unknown');
  await page.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#problem-notice').textContent.includes('다시 확인했습니다'));
  if(!(await page.locator('#problem-list').innerText()).includes('확인되지 않은 실행'))throw new Error('Unconfirmed runtime hidden');
  for(const locale of ['en','ko','ja','zh-Hans','zh-Hant','es','fr','de','pt']){await page.evaluate(locale=>dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{locale}}})),locale);for(const view of ['history','automatic','actionable']){await page.locator('[data-problem-view="'+view+'"]').click();if(!(await page.locator('#problem-policy').innerText()).trim())throw new Error('Missing automatic translation');if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Localized overflow: '+locale+' '+view)}}
  if((await page.evaluate(()=>window.__errors)).length)throw new Error(JSON.stringify(await page.evaluate(()=>window.__errors)));
 }`);
 const report={passed:14,artifacts,checks:["finished failures excluded from actionable count","three automatic views","dedicated current/problem separation","runtime cannot be acknowledged","bounded attempt display","failure pagination","optional review and undo preserve outcome","automatic evidence remains read-only","360/460 widths","dark mode","bulk beyond 100 preserves runtime issues","single mutation dispatch","conversation scope isolation","nine locales and all three views"]};
 writeFileSync(path.join(artifacts,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){writeFileSync(path.join(artifacts,"failure.snapshot.txt"),await cli("snapshot").catch(String));writeFileSync(path.join(artifacts,"failure-state.txt"),await cli("run-code",`async page=>console.log(JSON.stringify(await page.evaluate(()=>({calls:window.__calls.slice(-8),errors:window.__errors,message:document.querySelector('#message').textContent,page:document.querySelector('#problem-page-label').textContent,count:document.querySelector('#problems-count').textContent}))))`).catch(String));throw error;}finally{await cli("close").catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()));}
