import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DASHBOARD_CARD_HTML } from '../src/dashboardCard.js';
import { dashboardView } from './card-browser-fixtures.js';
const fixture=dashboardView('structural');
const artifacts='output/playwright/issue-251';mkdirSync(artifacts,{recursive:true});
const html=DASHBOARD_CARD_HTML.replace('</head>',`<script>
window.__calls=[];window.__errors=[];window.__pending=[];window.__hold=false;window.__revision='a'.repeat(64);window.__policy='b'.repeat(64);
addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
const base=${JSON.stringify(fixture)};
function turn(i){return {...base.terminalRows[0].latestTurn,executionKey:String(i).padStart(32,'0'),activityTitle:'History '+i}}
function row(){return {...base.terminalRows[0],rowKey:'row-251',status:'input-required',bucket:'active',representativeExecutionKey:'c'.repeat(32),historyRevision:__revision,policyRevision:__policy,nextExpiryAt:null,history:[turn(1),turn(2),turn(3)],historyCount:16,historyHasMore:true}}
function response(args){const r=row(),page={...base.pagination.terminal,total:1,returned:1,hasNext:false};return {...base,scope:args.scope==='all'?'all':'conversation',filter:{mode:args.scope==='all'?'all':'conversation',conversationAvailable:true},historyIncluded:true,statusRows:[r],statusRowsComplete:true,activeRows:[r],terminalRows:[],idleRows:[],counts:{...base.counts,active:1,running:0,problems:1},pagination:{active:page,terminal:page,idle:page},problems:{query:{kind:'all',offset:0},incidentCount:1,currentImpactCount:0,rows:[{problemKey:'incident',row:r,occurredAt:'2026-09-01T00:00:00Z',currentImpact:'none',reason:'Historical failure',canAcknowledge:true,canRetryStop:true,progress:[{at:'2026-09-01T00:01:00Z',step:'recovered',reason:'done'}]}],page}}}
window.openai={toolOutput:response({scope:'conversation'}),toolResponseMetadata:{},locale:'ko-KR',callTool:async(name,args)=>{__calls.push({name,args});if(args.view==='dashboard-history'){const detail={kind:'dashboard-history',rowKey:'row-251',history:Array.from({length:args.historyCursor?4:12},(_,i)=>turn(i+(args.historyCursor?13:1))),historyCount:16,historyRevision:__revision,representativeExecutionKey:'c'.repeat(32),policyRevision:__policy,nextExpiryAt:null,historyHasMore:!args.historyCursor,nextCursor:args.historyCursor?null:'page2'};if(__hold)await new Promise(resolve=>__pending.push(resolve));return {structuredContent:detail}}return {structuredContent:response(args)}},notifyIntrinsicHeight:()=>{}};
</script></head>`);
const execute=promisify(execFile),session='issue251-'+process.pid;
async function cli(...args:string[]){const result=await execute('npx',['--yes','--package','@playwright/cli@0.1.19','playwright-cli','--session',session,'--raw',...args],{timeout:40000,maxBuffer:3*1024*1024});if(result.stdout.includes('### Error'))throw new Error(result.stdout);return result.stdout}
const server=createServer((_,r)=>{r.setHeader('Content-Type','text/html');r.end(html)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 await cli('open','http://127.0.0.1:'+(server.address() as {port:number}).port);
 writeFileSync(artifacts+'/initial.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 if(await page.locator('.counts button').count()!==3||await page.locator('[data-status-filter="response-required"],#history-filter,[data-problem-review],[data-problem-view],#problem-ack-all').count())throw Error('retired controls remain');
 await page.locator('[data-status-filter="running"]').click();await page.locator('details.history summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===3);
 const count=()=>page.evaluate(()=>__calls.filter(x=>x.args.view==='dashboard-history').length);
 if(await count()!==0)throw Error('unfold fetched');
 await page.locator('details.history summary').click();await page.locator('details.history summary').click();
 await page.locator('[data-status-filter="history"]').click();await page.locator('[data-status-filter="running"]').click();
 if(await count()!==0)throw Error('reopen/tab fetched');
 await page.locator('.history-list button').click();await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===12);
 if(await count()!==1)throw Error('page request missing');await page.locator('.history-list button').click();await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===16);if(await count()!==2)throw Error('second page missing');
 await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 if(await page.locator('.history-turn').count()!==16)throw Error('ordinary refresh evicted cache');
 if(await count()!==2)throw Error('ordinary refresh fetched history');
 await page.locator('[data-status-filter="problems"]').click();
 if(await page.locator('#problem-list button,#problem-list input').count())throw Error('problem action leaked from legacy flags');
 if(!(await page.locator('#problem-list').innerText()).includes('recovered'))throw Error('progress missing');
 await page.screenshot({path:'output/playwright/issue-251/problems.png'});
 await page.locator('[data-status-filter="running"]').click();
 await page.evaluate(()=>{__policy='d'.repeat(64)});await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 if(!await page.locator('details.history').evaluate(el=>el.open))await page.locator('details.history summary').click();await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===3);
 await page.evaluate(()=>{__hold=true});await page.locator('.history-list button').click();await page.waitForFunction(()=>__pending.length===1);
 await page.locator('#scope-all').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 await page.locator('#scope-conversation').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 await page.locator('[data-status-filter="running"]').click();await page.locator('details.history summary').click();await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===3);
 await page.evaluate(()=>{__hold=false;__pending.splice(0).forEach(release=>release())});await page.waitForTimeout(100);
 if(await page.locator('.history-turn').count()!==3)throw Error('late A-B-A response leaked');
 if((await page.evaluate(()=>__errors)).length)throw Error(JSON.stringify(await page.evaluate(()=>__errors)));
 await page.screenshot({path:'output/playwright/issue-251/history.png'});
 }`));
 writeFileSync(artifacts+'/report.json',JSON.stringify({passed:true,checks:['3 tabs','embedded unfold zero requests','reopen and tab zero requests','explicit page','refresh cache retained','legacy action flags ignored','progress','policy invalidation','second page dedup','A-B-A late response rejected']},null,2));
}finally{await cli('close').catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()))}
