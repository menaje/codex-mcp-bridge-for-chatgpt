import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/dashboard-summary-regression");
mkdirSync(artifacts, { recursive: true });
const execute = promisify(execFile);
const session = `dashboard-summary-${process.pid}`;
const fixture = dashboardView("structural");
function html(scenario: string) {
  return DASHBOARD_CARD_HTML.replace("</head>", `<script>(()=>{
    const fixture=${JSON.stringify(fixture)},scenario=${JSON.stringify(scenario)};
    let sequence=0;window.__calls=[];window.__errors=[];window.__pending=[];window.__defer=false;
    addEventListener('error',event=>window.__errors.push(event.message));
    addEventListener('unhandledrejection',event=>window.__errors.push(String(event.reason)));
    function row(status,index){const base=fixture.terminalRows[0];return {...base,
      rowKey:status+index,activityKey:status+index,agentName:status+' Agent '+index,
      activityTitle:'작업 '+index,status,bucket:status==='completed'?'recent':'active',
      backgroundProcessCount:status==='background-process-running'?2:0,
      latestTurn:{...base.latestTurn,status},history:index===0?base.history:[],historyCount:index===0?4:0}}
    const normal=['input-required','approval-required','failed','interrupted','liveness-unknown','running','running','terminating','background-process-running'].map(row);
    function response(args){
      const active=scenario==='empty'?[]:scenario==='terminating'?[row('terminating',0)]:normal;
      const recent=scenario==='empty'||scenario==='terminating'?[]:Array.from({length:25},(_,i)=>row('completed',i));
      const category=r=>['input-required','approval-required'].includes(r.status)?'response-required':['failed','interrupted','liveness-unknown'].includes(r.status)?'problems':r.status==='running'?'running':null;
      const includeHistory=args.includeHistory!==false,statusRows=active.filter(r=>category(r)||r.backgroundProcessCount>0),offset=args.terminalOffset||0,limit=args.limit||12;
      const view={...fixture,statusFilter:'all',generatedAt:new Date(Date.now()+ ++sequence).toISOString(),
        filter:{mode:'all',conversationAvailable:false,conversationHasWork:false},
        enrichment:{...fixture.enrichment,state:args.enrich?'enriched':'structural'},
        activeRows:includeHistory?active:[],terminalRows:includeHistory?recent.slice(offset,offset+limit):[],idleRows:[],statusRows,statusRowsComplete:true,historyIncluded:includeHistory,
        counts:{...fixture.counts,running:active.filter(r=>category(r)==='running').length,
          responseRequired:active.filter(r=>category(r)==='response-required').length,problems:active.filter(r=>category(r)==='problems').length,
          backgroundProcesses:scenario==='empty'||scenario==='terminating'?0:2,runtimeUnknownAgents:scenario==='unknown'?1:0,idleAgents:500},
        pagination:{...fixture.pagination,active:{...fixture.pagination.active,returned:includeHistory?active.length:0,total:includeHistory?active.length:0},
          terminal:{...fixture.pagination.terminal,offset,returned:includeHistory?Math.min(limit,Math.max(0,recent.length-offset)):0,total:includeHistory?recent.length:0,hasNext:includeHistory&&offset+limit<recent.length}}};
      return {structuredContent:view};
    }
    window.openai={locale:'ko',callTool:async(name,args)=>{
      window.__calls.push({name,args});const value=response(args);
      if(window.__defer&&args.enrich){window.__defer=false;return new Promise(resolve=>window.__pending.push(()=>resolve(value)))}
      return value;
    },notifyIntrinsicHeight:()=>{}};
  })();</script></head>`);
}
async function cli(...args: string[]) {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 3 * 1024 * 1024 });
  return result.stdout.trim();
}
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html(request.url?.slice(1) || "normal"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  await cli("open", `${url}/normal`);
  writeFileSync(path.join(artifacts, "initial.snapshot.txt"), await cli("snapshot"));
  await cli("run-code", `async page=>{
    await page.waitForFunction(()=>document.querySelector('#problems-count').textContent==='3');
    if(await page.locator('.counts button').count()!==3)throw new Error('Expected three summary buttons');
    if(await page.locator('#active-section').isVisible()||await page.locator('#terminal-section').isVisible())throw new Error('Initial card did not stay on the summary');
    if(await page.locator('#idle-list,#idle-count,#project-count,#scope-count').count())throw new Error('Retired overview remains');
    if(await page.locator('#response-count').innerText()!=='2')throw new Error('Response count is wrong');
    await page.setViewportSize({width:460,height:900});
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "summary-light.png"))}});
    await page.emulateMedia({colorScheme:'dark'});
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "summary-dark.png"))}});
    await page.emulateMedia({colorScheme:'light'});
    await page.setViewportSize({width:360,height:850});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile overflow');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "summary-mobile.png"))}});
  }`);
  for (const [filter, count] of [["response-required", 2], ["problems", 3], ["running", 2], ["background", 1]] as const) {
    await cli("snapshot");
    await cli("run-code", `async page=>{
      const before=await page.evaluate(()=>window.__calls.length);await page.locator('[data-status-filter="${filter}"]').click();
      await page.waitForFunction(()=>document.querySelector('[data-status-filter="${filter}"]').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#active-list .activity-agent').length===${count});
      if(await page.evaluate(()=>window.__calls.length)!==before)throw new Error('Local status filter issued a data request');
      if(await page.locator('#problems-count').innerText()!=='3'||await page.locator('#response-count').innerText()!=='2')throw new Error('Filtering changed full-scope totals');
      await page.locator('#refresh').click();
      await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
      if(await page.locator('[data-status-filter="${filter}"]').getAttribute('aria-pressed')!=='true')throw new Error('Refresh lost filter');
    }`);
  }
  await cli("snapshot");
  await cli("run-code", `async page=>{
    await page.locator('#status-all').click();
    await page.locator('#history-filter').click();
    await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===12);
    await page.locator('#terminal-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===24);
    await page.locator('#terminal-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('#terminal-list .activity-agent').length===25);
    await page.evaluate(()=>window.__defer=true);
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>window.__pending.length===1);
    await page.locator('[data-status-filter="problems"]').click();
    await page.locator('[data-status-filter="response-required"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#active-list .activity-agent').length===2);
    await page.evaluate(()=>window.__pending.splice(0).forEach(release=>release()));
    if((await page.locator('#active-list').innerText()).includes('failed Agent'))throw new Error('Late response crossed filters');
    if((await page.evaluate(()=>window.__errors)).length)throw new Error('Browser error');
  }`);
  for (const scenario of ["empty", "terminating", "unknown"]) {
    await cli("goto", `${url}/${scenario}`);
    await cli("snapshot");
    await cli("run-code", `async page=>{
      await page.waitForFunction(()=>document.querySelector('#dashboard-content').hidden===false);
      if('${scenario}'==='terminating'){await page.locator('#history-filter').click();await page.waitForFunction(()=>document.querySelector('#active-section').hidden===false);if(!(await page.locator('#active-list').innerText()).includes('종료 중'))throw new Error('Termination disappeared')}
      if('${scenario}'==='empty'&&await page.locator('#background-status').isVisible())throw new Error('Empty background count visible');
      if('${scenario}'==='unknown'&&!await page.locator('#background-unknown').isVisible())throw new Error('Unknown background state hidden');
      if((await page.evaluate(()=>window.__errors)).length)throw new Error('Browser error');
    }`);
  }
  const result = { passed: 9, artifacts, checks: ["three counts", "four filters", "scope totals", "refresh", "history pagination", "stale enrichment", "empty", "terminating", "unknown background"] };
  writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cli("close").catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
}
