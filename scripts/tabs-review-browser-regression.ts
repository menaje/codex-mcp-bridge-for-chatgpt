import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
import {dashboardView} from './card-browser-fixtures.js';
const artifacts='output/playwright/tabs-review';mkdirSync(artifacts,{recursive:true});
const html=DASHBOARD_CARD_HTML.replace('</head>',`<script>
window.__now=Date.UTC(2026,9,14);Date.now=()=>__now;window.__failReads=false;window.__reads=0;window.__errors=[];
addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
const base=${JSON.stringify(dashboardView('structural'))},day=86400000,scopeId='11111111-1111-4111-8111-111111111111';
function row(id,status,ended){const source=base.terminalRows[0],meta={jobId:id,scopeId,activityId:'review-activity',agentId:'review-agent',executionRevision:'e'.repeat(64),executionName:id,summary:status==='failed'?'Expiring preview':'Current summary',error:status==='failed'?'Expiring failure':null};return {...source,...meta,rowKey:id.padEnd(32,'0'),bucket:ended?'recent':'active',status,backgroundProcessCount:ended?0:1,policyRevision:'c'.repeat(64),nextExpiryAt:ended?new Date(ended+30*day).toISOString():null,history:[],historyCount:0,latestTurn:{...source.latestTurn,...meta,status,startedAt:new Date((ended||__now)-1000).toISOString(),endedAt:ended?new Date(ended).toISOString():null}}}
const live=row('live-background','running',null),successes=Array.from({length:12},(_,i)=>row('success-'+i,'completed',__now-day)),failure=row('old-failure','failed',__now-30*day+1000);
const page={offset:0,limit:12,returned:12,total:12,hasPrevious:false,hasNext:false};
const problem={problemKey:'failure-event',source:'execution',kind:'failed',jobId:failure.jobId,scopeId,executionRevision:'e'.repeat(64),executionAvailability:'retained',reason:'Expiring failure',occurredAt:failure.latestTurn.endedAt,observedAt:failure.latestTurn.endedAt,row:failure,progress:[]};
const response={...base,uiLocalePreference:'en',executionContractVersion:2,historyModeApplied:'jobs',historyIncluded:true,historyPolicy:{retentionDays:30,policyRevision:'c'.repeat(64)},counts:{...base.counts,progressJobCount:1,executionCount:13,backgroundProcesses:1,backgroundProcessAgents:1},activeRows:[live],terminalRows:successes,statusRows:[],idleRows:[],pagination:{...base.pagination,terminal:page},problems:{query:{kind:'all',offset:0},incidentCount:1,affectedExecutionCount:1,systemIncidentCount:0,unavailableExecutionCount:0,currentImpactCount:0,rows:[problem],page:{...page,returned:1,total:1}}};
window.openai={toolOutput:response,toolResponseMetadata:{},locale:'en-US',notifyIntrinsicHeight:()=>{},callTool:async()=>{__reads++;if(__failReads)throw Error('FIXTURE_REFRESH_FAILED');return {structuredContent:response}}};
</script></head>`);
const execute=promisify(execFile),session='tabs-review-'+process.pid;
const wrapper=path.join(process.env.CODEX_HOME || path.join(homedir(),'.codex'),'skills/playwright/scripts/playwright_cli.sh');
async function cli(...args:string[]){const r=await execute(existsSync(wrapper)?wrapper:'npx',[...(existsSync(wrapper)?[]:['--yes','--package','@playwright/cli@0.1.19','playwright-cli']),'--session',session,'--raw',...args],{timeout:40000,maxBuffer:3*1024*1024});if(r.stdout.includes('### Error'))throw Error(r.stdout);return r.stdout}
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 await cli('open','http://127.0.0.1:'+(server.address() as {port:number}).port);writeFileSync(artifacts+'/initial.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();if(!(await page.locator('#active-list').innerText()).includes('live-background'))throw Error('background work absent');
 await page.locator('[data-status-filter="problems"]').click();if(!(await page.locator('#problem-list').innerText()).includes('Expiring failure'))throw Error('pre-expiry fixture missing');
 await page.evaluate(()=>{__failReads=true;__now+=1000});
 await page.waitForFunction(()=>!document.querySelector('#problem-list').innerText.includes('Expiring failure')&&!document.querySelector('#problem-list').innerText.includes('Expiring preview'));
 if(await page.evaluate(()=>__reads<1))throw Error('expiry refresh was not attempted');
 await page.locator('[data-status-filter="history"]').click();if(await page.locator('#terminal-list .execution-record').count()!==12)throw Error('valid successes were hidden');
 await page.locator('#background-filter').click();if(!(await page.locator('#active-list').innerText()).includes('live-background'))throw Error('expiry hid actual execution');
 if((await page.evaluate(()=>__errors)).length)throw Error(JSON.stringify(await page.evaluate(()=>__errors)));
 await page.screenshot({path:'output/playwright/tabs-review/after-expiry-background.png'});
 }`));
 writeFileSync(artifacts+'/report.json',JSON.stringify({passed:true,checks:['active Job with background process outside terminal status page','problem-only Job expiry hides error and preview despite failed refresh','twelve valid success summaries remain','background execution survives expiry']},null,2));
}finally{await cli('close').catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()))}
