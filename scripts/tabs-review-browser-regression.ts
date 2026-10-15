import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
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
const completedProjection=JSON.parse(readFileSync('test/fixtures/terminal-background-projection.json','utf8'));
const completedHtml=DASHBOARD_CARD_HTML.replace('</head>',`<script>const snapshot=${JSON.stringify({...completedProjection,uiLocalePreference:'en'})};window.openai={toolOutput:snapshot,toolResponseMetadata:{},locale:'en-US',notifyIntrinsicHeight:()=>{},callTool:async()=>({structuredContent:snapshot})};</script></head>`);
const independentProjection=JSON.parse(readFileSync('test/fixtures/background-independent-page.json','utf8'));
function independentHtml(many=false){return DASHBOARD_CARD_HTML.replace('</head>',`<script>
const base=${JSON.stringify({...independentProjection,uiLocalePreference:'en'})};window.__backgroundOffsets=[];
function response(offset=0){if(!${many})return base;const owner=base.backgroundRows[0],all=Array.from({length:13},(_,i)=>({...owner,rowKey:String(i+1).padStart(32,'0'),conversationKey:'owner-scope-'+i}));return {...base,counts:{...base.counts,backgroundProcesses:13,backgroundProcessAgents:13},backgroundRows:all.slice(offset,offset+12),backgroundPagination:{offset,limit:12,returned:Math.min(12,13-offset),total:13,returnedConversations:Math.min(12,13-offset),conversationTotal:13,hasPrevious:offset>0,hasNext:offset+12<13}}}
window.openai={toolOutput:response(),toolResponseMetadata:{},locale:'en-US',notifyIntrinsicHeight:()=>{},callTool:async(_name,args)=>{if(args.backgroundOffset!==undefined)__backgroundOffsets.push(args.backgroundOffset);return {structuredContent:response(args.backgroundOffset||0)}}};
</script></head>`)}
function rebaseHtml(change:string){return DASHBOARD_CARD_HTML.replace('</head>',`<script>
const base=${JSON.stringify({...independentProjection,uiLocalePreference:'en',scope:'bridge-wide',filter:{mode:'all',conversationAvailable:true,conversationHasWork:true}})},owner=base.backgroundRows[0];window.__reads=[];let changed=false;
const old={...base,counts:{...base.counts,backgroundProcesses:13,backgroundProcessAgents:13},backgroundRows:Array.from({length:12},(_,i)=>({...owner,rowKey:String(i+1).padStart(32,'0')})),backgroundPagination:{offset:0,limit:12,returned:12,total:13,hasNext:true,hasPrevious:false}};
const fresh={...base,backgroundRows:[{...owner,agentName:'Fresh owner'}],backgroundRevision:'b'.repeat(64),historyPolicy:{...base.historyPolicy,policyRevision:${JSON.stringify(change)}==='policy'?'c'.repeat(64):base.historyPolicy.policyRevision}};
window.openai={toolOutput:old,toolResponseMetadata:{},locale:'en-US',notifyIntrinsicHeight:()=>{},callTool:async(_name,args)=>{__reads.push(args);if(args.backgroundOffset!==undefined){changed=true;return {structuredContent:{...fresh,backgroundRevision:${JSON.stringify(change)}==='owners'?fresh.backgroundRevision:old.backgroundRevision,backgroundRows:[{...owner,agentName:'Must not merge'}],backgroundPagination:{offset:12,limit:12,returned:1,total:13,hasNext:false,hasPrevious:true}}}}return {structuredContent:changed?fresh:old}}};
</script></head>`)}
const omittedHistoryHtml=html.replace('window.openai={toolOutput:response,','response.historyIncluded=false;response.terminalRows=[];response.statusRows=[live];window.openai={toolOutput:response,').replace("callTool:async()=>{__reads++;if(__failReads)throw Error('FIXTURE_REFRESH_FAILED');return {structuredContent:response}}","callTool:async(_name,args)=>{__reads++;return args.includeHistory===true?{isError:true,content:[{type:'text',text:'FIXTURE_HISTORY_FAILED'}]}:{structuredContent:response}}");
const retainedIncidentHtml=html.replace("source:'execution',kind:'failed',jobId:failure.jobId","source:'recovery',kind:'failed',jobId:failure.jobId").replace('occurredAt:failure.latestTurn.endedAt,observedAt:failure.latestTurn.endedAt','occurredAt:new Date(__now).toISOString(),observedAt:new Date(__now).toISOString()');
const execute=promisify(execFile),session='tabs-review-'+process.pid;
const wrapper=path.join(process.env.CODEX_HOME || path.join(homedir(),'.codex'),'skills/playwright/scripts/playwright_cli.sh');
async function cli(...args:string[]){const r=await execute(existsSync(wrapper)?wrapper:'npx',[...(existsSync(wrapper)?[]:['--yes','--package','@playwright/cli@0.1.19','playwright-cli']),'--session',session,'--raw',...args],{timeout:40000,maxBuffer:3*1024*1024});if(r.stdout.includes('### Error'))throw Error(r.stdout);return r.stdout}
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/omitted-history'?omittedHistoryHtml:req.url==='/retained-incident'?retainedIncidentHtml:req.url==='/rebase-owners'?rebaseHtml('owners'):req.url==='/rebase-policy'?rebaseHtml('policy'):req.url==='/completed'?completedHtml:req.url==='/independent'?independentHtml():req.url==='/many-background'?independentHtml(true):html)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
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
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/completed');writeFileSync(artifacts+'/completed.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();if(await page.locator('#active-list .activity-agent').count()!==1||await page.locator('#terminal-list .activity-agent').count()!==0)throw Error('completed Job duplicated its current background owner');
 await page.locator('[data-status-filter="history"]').click();if(await page.locator('#terminal-list .execution-record').count()!==1)throw Error('completed Job history lost');
 if(await page.locator('#running-count').innerText()!=='0'||await page.locator('#response-count').innerText()!=='1')throw Error('runtime observation counted as a new Job');
 await page.screenshot({path:'output/playwright/tabs-review/completed-history.png'});
 }`));
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/independent');writeFileSync(artifacts+'/independent.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();if(await page.locator('#active-list .activity-agent').count()!==1)throw Error('full progress page hid independent background owner');
 if(await page.locator('#running-count').innerText()!=='26')throw Error('independent background changed Job totals');
 }`));
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/many-background');writeFileSync(artifacts+'/many-background.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();if(await page.locator('#active-list .activity-agent').count()!==12||!(await page.locator('#active-more').isVisible()))throw Error('bounded background page has no control');
 await page.locator('#active-more').click();await page.waitForFunction(()=>document.querySelectorAll('#active-list .activity-agent').length===13);
 if(await page.locator('#active-more').isVisible())throw Error('finished background page still offers more');
 if(JSON.stringify(await page.evaluate(()=>__backgroundOffsets))!==JSON.stringify([12]))throw Error('background offset is based on progress Jobs');
 await page.screenshot({path:'output/playwright/tabs-review/background-page-complete.png'});
 }`));
 for(const change of ['owners','policy']){
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/rebase-'+change);writeFileSync(artifacts+'/rebase-'+change+'.txt',await cli('snapshot'));
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();await page.locator('#active-more').click();
 await page.waitForFunction(()=>document.querySelector('#active-list').innerText.includes('Fresh owner'));
 if(await page.locator('#active-list .activity-agent').count()!==1||(await page.locator('#active-list').innerText()).includes('Must not merge'))throw Error('mismatching page was merged');
 const requests=await page.evaluate(()=>__reads),start=requests.findIndex(value=>value.backgroundOffset===12);if(start<0||requests.length<start+2||requests[start+1].backgroundOffset!==undefined)throw Error('first-page rebase read was suppressed: '+JSON.stringify(requests));
 if(await page.locator('#refresh').isDisabled()||await page.locator('main').getAttribute('aria-busy')!=='false')throw Error('rebase controls remain busy');
 await page.screenshot({path:'output/playwright/tabs-review/rebase-${change}.png'});
 }`));
 }
 for(const health of ['orphaned','liveness-unknown'])for(const timing of ['before','after']){
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/runtime-health');
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);
 await page.locator('#background-filter').click();
 await page.evaluate(()=>{window.__detailReads=0;window.openai.callTool=async(_name,args)=>{if(args.view==='dashboard-execution'){__detailReads++;return {structuredContent:{kind:'dashboard-execution',jobId:args.jobId,scopeId:args.scopeId,executionRevision:args.expectedExecutionRevision,policyRevision:args.expectedPolicyRevision,nextExpiryAt:null,execution:{...response.activeRows[0].latestTurn,jobId:args.jobId,scopeId:args.scopeId,executionRevision:args.expectedExecutionRevision,status:'running',summary:'Durable cached content'}}}}return {structuredContent:response}}});
 const load=async()=>{await page.locator('#active-list .execution-detail summary').click();await page.locator('#active-list [data-execution-load]').click();await page.waitForFunction(()=>document.querySelector('#active-list [data-execution-load]').disabled)};
 if('${timing}'==='before')await load();
 await page.evaluate(health=>{response.activeRows[0].status=health;response.activeRows[0].latestTurn.status=health},'${health}');
 await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
 if('${timing}'==='after')await load();
 const badge=page.locator('#active-list .execution-record .status');if(!(await badge.getAttribute('class')).includes('${health}'==='orphaned'?'failed':'attention'))throw Error('cached detail replaced current health');
 if(!(await page.locator('#active-list .execution-detail').innerText()).includes('Durable cached content'))throw Error('valid detail content was lost');
 if(await page.evaluate(()=>__detailReads)!==1)throw Error('health update invalidated durable detail cache');
 await page.screenshot({path:'output/playwright/tabs-review/runtime-${health}-${timing}.png'});
 }`));
 }
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/omitted-history');
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden&&!document.querySelector('#refresh').disabled);
 await page.locator('[data-status-filter="running"]').click();
 await page.screenshot({path:'output/playwright/tabs-review/omitted-history-before.png'});
 if(await page.locator('#active-list .execution-record').count()!==1)throw Error('omitted-history fixture has no previous current row');
 const before=await page.evaluate(()=>__reads);await page.locator('[data-status-filter="history"]').click();
 await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
 if(await page.evaluate(()=>__reads)<=before)throw Error('History fetch was not dispatched');
 if(await page.locator('[data-status-filter="history"]').getAttribute('aria-pressed')!=='true')throw Error('history selection lost');
 if(await page.locator('#active-list .execution-record').count()!==0||await page.locator('#terminal-list .execution-record').count()!==0)throw Error('failed first history read kept prior rows under History');
 await page.screenshot({path:'output/playwright/tabs-review/omitted-history-failure.png'});
 }`));
 await cli('goto','http://127.0.0.1:'+(server.address() as {port:number}).port+'/retained-incident');
 console.log(await cli('run-code',`async page=>{
 await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);await page.locator('[data-status-filter="problems"]').click();
 if(!(await page.locator('#problem-list').innerText()).includes('Expiring failure'))throw Error('retained incident initial reason missing');
 await page.evaluate(()=>{__failReads=true;__now+=1000});
 await page.waitForFunction(()=>document.querySelectorAll('#problem-list .execution-record').length===0);
 if(await page.locator('#problem-list .problem-row').count()!==1||!(await page.locator('#problem-list').innerText()).includes('Expiring failure'))throw Error('linked Job expiry hid retained incident reason');
 if(await page.locator('#problem-list .execution-record').count()!==0)throw Error('expired Job detail remains visible');
 await page.screenshot({path:'output/playwright/tabs-review/retained-incident-expiry.png'});
 }`));
 writeFileSync(artifacts+'/report.json',JSON.stringify({passed:true,checks:['active Job with background process outside terminal status page','problem-only Job expiry hides error and preview despite failed refresh','twelve valid success summaries remain','background execution survives expiry','completed Job and current runtime process have one display owner','completed execution history and Job totals remain','independent owner visible beyond twenty-six progress Jobs','bounded Background page has a working more control','Background paging preserves Job totals and uses owner offsets','actual owner-change reload replaces the first page after busy release','actual policy-change reload replaces the first page and releases controls','cached detail preserves current orphaned and unknown health before and after observation without refetch','failed first History read clears previously rendered current rows','retained incident keeps its reason after exact Job expiry even when refresh fails']},null,2));
}finally{await cli('close').catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()))}
