import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/dashboard-scope-regression");
mkdirSync(artifacts, { recursive: true });
const session = `dashboard-scope-${process.pid}`;
const execute = promisify(execFile);

function html(scenario: string): string {
  const prelude = `<script>(()=>{
    const fixture=${JSON.stringify(dashboardView("structural"))},scenario=${JSON.stringify(scenario)};
    let sequence=0;
    window.__calls=[];window.__errors=[];window.__pending=[];window.__defer=null;window.__failRefresh=false;
    window.__hasWork=scenario!=="empty"&&scenario!=="unidentified";
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    function row(prefix,index,active=false){const base=fixture.terminalRows[0],title=(prefix==="here"?"이 대화 작업 ":"다른 대화 작업 ")+index;
      return {...base,rowKey:prefix+"-"+(active?"active":index),activityKey:prefix+"-activity-"+index,
        conversationKey:prefix,projectKey:prefix,projectName:prefix==="here"?"현재 프로젝트":"다른 프로젝트",
        activityTitle:title,agentName:(prefix==="here"?"현재 에이전트 ":"다른 에이전트 ")+index,
        status:active?"running":"completed",bucket:active?"active":"recent",controlKind:active?"manage":null,
        history:[],historyCount:0,latestTurn:{...base.latestTurn,activityTitle:title,activityKey:prefix+"-activity-"+index,status:active?"running":"completed"}}}
    function response(args){
      const mode=args.scope==="auto"?(window.__hasWork?"conversation":"all"):args.scope||"all";
      const here=window.__hasWork?Array.from({length:24},(_,index)=>row("here",index+1)):[];
      const elsewhere=Array.from({length:8},(_,index)=>row("elsewhere",index+1));
      const activeHere=window.__hasWork&&scenario!=="completed"?[row("here",0,true)]:[];
      const activeRows=mode==="conversation"?activeHere:[...activeHere,row("elsewhere",0,true)];
      const terminal=mode==="conversation"?here:[...elsewhere,...here];
      const offset=args.terminalOffset||0,limit=args.limit||20,terminalRows=terminal.slice(offset,offset+limit);
      const view={...fixture,generatedAt:new Date(Date.now()+(++sequence)).toISOString(),scope:mode==="conversation"?"conversation":"bridge-wide",
        filter:{mode,conversationAvailable:scenario!=="unidentified",conversationHasWork:window.__hasWork},
        enrichment:{...fixture.enrichment,state:args.enrich?"enriched":"structural"},activeRows,terminalRows,idleRows:[],
        counts:{...fixture.counts,trackedConversations:mode==="conversation"?1:window.__hasWork?2:1,trackedProjects:mode==="conversation"?1:2,
          running:activeRows.length,active:activeRows.length,retainedJobs:terminal.length+activeRows.length,completed:terminal.length},
        pagination:{...fixture.pagination,active:{...fixture.pagination.active,returned:activeRows.length,total:activeRows.length},
          terminal:{...fixture.pagination.terminal,offset,limit,returned:terminalRows.length,total:terminal.length,hasPrevious:offset>0,hasNext:offset+terminalRows.length<terminal.length}}};
      return {structuredContent:view,_meta:{"codex/dashboardView@1":{kind:"codex/dashboardView",version:1,purpose:"bridge-wide-read-only-hydration",view}}};
    }
    function detail(args){return {structuredContent:{kind:"control",ready:true},_meta:{"codex/uiControl@1":{
      kind:"control",rowKey:args.rowKey,agentId:"fixture-agent",jobId:"fixture-job",agentName:"현재 에이전트",activityTitle:"현재 작업",
      jobVersion:1,status:"running",canStop:true,affectedJobIds:["fixture-job"],pendingInteractions:[],backgroundProcesses:[],
      card:{kind:"dashboard",token:"fixture-proof",activityId:"fixture-activity",generation:1,presentation:{kind:"explicit"}}}}}}
    window.__release=()=>{const pending=window.__pending.splice(0);for(const release of pending)release()};
    window.openai={locale:"ko-KR",notifyIntrinsicHeight:()=>{},toolResponseMetadata:{},callTool:async(name,args)=>{
      window.__calls.push({name,args});
      const read=()=>args.view==="control"?detail(args):response(args);
      if(args.view==="dashboard"&&!args.enrich&&window.__failRefresh){window.__failRefresh=false;return {isError:true,content:[{type:"text",text:"Refresh fixture failed"}]}}
      const shouldDefer=window.__defer==="details"&&args.view==="control"||window.__defer==="enrich"&&args.enrich||window.__defer==="page"&&!args.enrich&&args.terminalOffset>0;
      if(shouldDefer){window.__defer=null;return new Promise(resolve=>window.__pending.push(()=>resolve(read())))}
      return read();
    }};
  })();</script>`;
  return DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 3 * 1024 * 1024 });
  return result.stdout.trim();
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html(request.url?.slice(1) || "work"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const report: string[] = [];
try {
  await cli("open", `http://127.0.0.1:${port}/work`);
  writeFileSync(path.join(artifacts, "initial.snapshot.txt"), await cli("snapshot"));
  await cli("run-code", `async page=>{
    await page.waitForFunction(()=>document.querySelector('#scope-conversation').getAttribute('aria-pressed')==='true');
    if(await page.locator('h1').innerText()!=='Codex 현황')throw new Error('Status-card name is wrong');
    if((await page.locator('#active-list').innerText()).includes('다른 대화'))throw new Error('Initial conversation leaked other work');
    const calls=await page.evaluate(()=>window.__calls.filter(call=>call.args.view==='dashboard'));
    if(calls[0].args.scope!=='auto'||calls.find(call=>call.args.enrich)?.args.scope!=='conversation')throw new Error('Initial enrichment repeated auto selection');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "conversation-desktop.png"))}});
    await page.setViewportSize({width:360,height:850});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('Mobile overflow');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "conversation-mobile.png"))}});
    await page.setViewportSize({width:900,height:900});
  }`);
  report.push("Initial conversation selection, explicit enrichment, desktop and mobile layout");

  for (const scenario of ["completed", "empty", "unidentified"]) {
    await cli("goto", `http://127.0.0.1:${port}/${scenario}`);
    await cli("snapshot");
    await cli("run-code", `async page=>{
      const selected=${JSON.stringify(scenario === "completed" ? "#scope-conversation" : "#scope-all")};
      await page.waitForFunction(selector=>document.querySelector(selector).getAttribute('aria-pressed')==='true',selected);
      if(${JSON.stringify(scenario)}==='completed'&&await page.locator('#running-count').innerText()!=='0')throw new Error('Completed history was treated as running');
      if(await page.locator('#scope-conversation').isDisabled()!==${JSON.stringify(scenario === "unidentified")})throw new Error('Conversation availability is wrong');
      if((await page.evaluate(()=>window.__errors)).length)throw new Error('Browser error');
    }`);
    report.push(`${scenario}: correct initial selection and conversation availability`);
  }

  await cli("goto", `http://127.0.0.1:${port}/work`);
  await cli("snapshot");
  await cli("run-code", `async page=>{
    await page.locator('#scope-all').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='2');
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>window.__calls.filter(call=>call.args.view==='dashboard'&&!call.args.enrich&&call.args.scope==='all').length>=2&&document.querySelector('main.card').getAttribute('aria-busy')==='false');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "all-desktop.png"))}});
    await page.locator('#terminal-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===32);
    await page.locator('#scope-conversation').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='1'&&document.querySelectorAll('#terminal-list .activity-agent').length===20);
    if((await page.locator('#dashboard-content').innerText()).includes('다른 대화'))throw new Error('Scope switch retained all-work rows');
    await page.locator('#terminal-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===24);
    if(await page.locator('#terminal-more').isVisible())throw new Error('Scoped last page still advertises more');
  }`);
  await cli("snapshot");
  report.push("Two-way scope switching, sticky refresh and independent paginated rows/counts");

  await cli("run-code", `async page=>{
    await page.evaluate(()=>{window.__defer='enrich'});
    await page.locator('#scope-all').click();
    await page.waitForFunction(()=>window.__pending.length===1);
    await page.locator('#scope-conversation').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='1');
    await page.evaluate(()=>window.__release());
    await page.waitForFunction(()=>document.querySelector('main.card').getAttribute('aria-busy')==='false');
    if((await page.locator('#active-list').innerText()).includes('다른 대화'))throw new Error('Late enrichment replaced the selected scope');
    await page.evaluate(()=>{window.__defer='page'});
    await page.locator('#terminal-more').click();
    await page.waitForFunction(()=>window.__pending.length===1);
    await page.locator('#scope-all').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='2');
    await page.evaluate(()=>window.__release());
    if(await page.locator('#terminal-list .activity-agent').count()!==20)throw new Error('Late scoped page contaminated all-work cache');
  }`);
  await cli("snapshot");
  report.push("Late enrichment and load-more responses cannot cross scope changes");

  await cli("run-code", `async page=>{
    await page.locator('#scope-conversation').click();
    await page.locator('#active-list').getByRole('button',{name:'상세 보기',exact:true}).click();
    await page.locator('#work-details-body button').first().waitFor();
    await page.evaluate(()=>{window.__defer='details'});
    await page.locator('#work-details-refresh').click();
    await page.waitForFunction(()=>window.__pending.length===1);
    await page.locator('#scope-all').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='2');
    await page.evaluate(()=>window.__release());
    if(await page.locator('#work-details').isVisible()||await page.locator('#work-details-body').innerHTML()!=='')throw new Error('Old detail form reopened in the new scope');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await page.waitForTimeout(1100);
    const previous=await page.evaluate(()=>window.__calls.length);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForFunction(count=>window.__calls.length>count,previous);
    if((await page.evaluate(count=>window.__calls.slice(count).filter(call=>call.args.view==='dashboard'),previous)).some(call=>call.args.scope!=='all'))throw new Error('Restoration discarded manual scope');
    await page.waitForFunction(()=>document.querySelector('main.card').getAttribute('aria-busy')==='false');
    await page.evaluate(()=>{window.__failRefresh=true});
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('마지막'));
    if(await page.locator('#scope-all').getAttribute('aria-pressed')!=='true'||await page.locator('#scope-count').innerText()!=='2')throw new Error('Failed refresh discarded selection/data');
    await page.locator('#scope-conversation').click();
    await page.waitForFunction(()=>document.querySelector('#scope-count').textContent==='1');
    const result=await page.evaluate(()=>({errors:window.__errors,mutations:window.__calls.filter(call=>call.name!=='codex_ui_read')}));
    if(result.errors.length||result.mutations.length)throw new Error(JSON.stringify(result));
  }`);
  report.push("Detail proof/form reset, page restoration, refresh failure recovery, no mutations on switching");
  const errors = JSON.parse(await cli("run-code", "async page=>page.evaluate(()=>window.__errors)"));
  assert.deepEqual(errors, []);
  writeFileSync(path.join(artifacts, "report.json"), `${JSON.stringify({ report, errors }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.length, artifacts, report }, null, 2));
} finally {
  try { await cli("close"); } finally { server.close(); }
}
