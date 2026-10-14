import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DASHBOARD_CARD_HTML } from '../src/dashboardCard.js';
import { dashboardView } from './card-browser-fixtures.js';
const fixture=dashboardView('structural');
const artifacts='output/playwright/issue-251-r2';mkdirSync(artifacts,{recursive:true});
const html=DASHBOARD_CARD_HTML.replace('</head>',`<script>
window.__start=Date.UTC(2026,9,14);window.__clock=__start;window.__expired=false;Date.now=()=>__clock;window.__calls=[];window.__errors=[];window.__pending=[];window.__hold=false;window.__revision='a'.repeat(64);window.__policy='b'.repeat(64);
addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
const base=${JSON.stringify(fixture)};
function turn(i){return {...base.terminalRows[0].latestTurn,executionKey:String(i).padStart(32,'0'),activityTitle:'History '+i}}
function row(){return {...base.terminalRows[0],rowKey:'row-251',status:'input-required',bucket:'active',representativeExecutionKey:'c'.repeat(32),historyRevision:__revision,policyRevision:__policy,nextExpiryAt:new Date(__start+(__expired?2:1)*86400000).toISOString(),history:[turn(2)],historyCount:__expired?1:2,historyHasMore:!__expired}}
function response(args){const r=row(),page={...base.pagination.terminal,total:1,returned:1,hasNext:false};return {...base,scope:args.scope==='all'?'all':'conversation',filter:{mode:args.scope==='all'?'all':'conversation',conversationAvailable:true},historyIncluded:true,statusRows:[r],statusRowsComplete:true,activeRows:[r],terminalRows:[],idleRows:[],counts:{...base.counts,active:1,running:0,problems:1},pagination:{active:page,terminal:page,idle:page},problems:{query:{kind:'all',offset:0},incidentCount:1,currentImpactCount:0,rows:[{problemKey:'incident',row:r,occurredAt:'2026-09-01T00:00:00Z',currentImpact:'none',reason:'Historical failure',canAcknowledge:true,canRetryStop:true,progress:[{at:'2026-09-01T00:01:00Z',step:'recovered',reason:'done'}]}],page}}}
window.openai={toolOutput:response({scope:'conversation'}),toolResponseMetadata:{},locale:'ko-KR',callTool:async(name,args)=>{__calls.push({name,args});if(args.view==='dashboard-history'){const detail={kind:'dashboard-history',rowKey:'row-251',history:__expired?[turn(2)]:[turn(1),turn(2)],historyCount:__expired?1:2,historyRevision:__revision,representativeExecutionKey:'c'.repeat(32),policyRevision:__policy,nextExpiryAt:new Date(__start+(__expired?2:1)*86400000).toISOString(),historyHasMore:false,nextCursor:null};if(__hold)await new Promise(resolve=>__pending.push(resolve));return {structuredContent:detail}}return {structuredContent:response(args)}},notifyIntrinsicHeight:()=>{}};
</script></head>`);
const execute=promisify(execFile),session='issue251-r2-'+process.pid;
async function cli(...args:string[]){const result=await execute('npx',['--yes','--package','@playwright/cli@0.1.19','playwright-cli','--session',session,'--raw',...args],{timeout:40000,maxBuffer:3*1024*1024});if(result.stdout.includes('### Error'))throw new Error(result.stdout);return result.stdout}
const server=createServer((_,r)=>{r.setHeader('Content-Type','text/html');r.end(html)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 await cli('open','http://127.0.0.1:'+(server.address() as {port:number}).port);
 writeFileSync(artifacts+'/initial.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('[data-status-filter="running"]').click();await page.locator('details.history summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===1);
 const reads=()=>page.evaluate(()=>__calls.filter(x=>x.args.view==='dashboard-history').length);
 if(await reads()!==0)throw Error('embedded read');
 await page.locator('.history-list button').click();await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===2);
 if(await reads()!==1)throw Error('page read missing');
 await page.evaluate(()=>{__clock=__start+86400000-60000});await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 if(await page.locator('.history-turn').count()!==2||await reads()!==1)throw Error('valid cache was evicted or refetched');
 // No sweep or history-revision change. An ordinary snapshot arrives before the old timer can run.
 await page.evaluate(()=>{__clock=__start+86400000;__expired=true});await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
 if(await page.locator('.history-turn').count()!==1)throw Error('expired summary revived by advanced nextExpiryAt');
 if(await reads()!==1)throw Error('expiry refresh fetched history implicitly '+JSON.stringify(await page.evaluate(()=>__calls)));
 await page.locator('details.history summary').click();await page.locator('details.history summary').click();
 await page.locator('[data-status-filter="problems"]').click();await page.locator('[data-status-filter="running"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.history-turn').length===1);
 if(await reads()!==1)throw Error('fresh retained cache/summary caused history read');
 if((await page.evaluate(()=>__errors)).length)throw Error(JSON.stringify(await page.evaluate(()=>__errors)));
 await page.screenshot({path:'output/playwright/issue-251-r2/expiry.png'});
 }`));
 writeFileSync(artifacts+'/report.json',JSON.stringify({passed:true,checks:['pre-boundary cache retained, zero extra reads','exact boundary before physical sweep','advanced snapshot expiry cannot revive old page','post-boundary summary/reopen/tab no extra reads']},null,2));
}finally{await cli('close').catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()))}
