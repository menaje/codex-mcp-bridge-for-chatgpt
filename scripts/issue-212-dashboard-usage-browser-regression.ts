import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/issue-212-dashboard-usage");
mkdirSync(artifacts, { recursive: true });
const session = `issue-212-dashboard-${process.pid}`;
const execute = promisify(execFile);
const observedAt = "2026-09-29T01:00:00.000Z";
const weeklyUsage = {
  source: "codex-account-rate-limits", limitId: "codex", usedPercent: 35,
  remainingPercent: 65, windowDurationMins: 10_080, resetsAt: null, observedAt
};

const prelude = `<script>(()=>{
  const fixture=${JSON.stringify(dashboardView("structural"))};
  window.__errors=[];
  window.addEventListener("error",event=>window.__errors.push(String(event.message)));
  window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
  window.__usage={status:"available",value:${JSON.stringify(weeklyUsage)}};
  window.__setUsage=(status,value)=>{window.__usage={status,value}};
  window.openai={locale:"ko-KR",notifyIntrinsicHeight:()=>{},toolResponseMetadata:{},callTool:async(name,args)=>{
    if(name!=="codex_ui_read"||args.view!=="dashboard")throw new Error("Unexpected card request");
    const current=window.__usage;
    const view={...fixture,scope:"bridge-wide",filter:{mode:"all",conversationAvailable:false,conversationHasWork:false},
      historyIncluded:args.includeHistory!==false,weeklyUsage:current.value,usageDisplayStatus:current.status,
      enrichment:{...fixture.enrichment,state:args.enrich?"enriched":"structural",
        usageTimedOut:current.status==="timed-out",usageUnavailable:current.status==="unavailable"}};
    return {structuredContent:view};
  }};
})();</script>`;
const html = DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);

async function cli(...args: string[]): Promise<string> {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19",
    "playwright-cli", "--session", session, "--raw", ...args],
  { timeout: 30_000, maxBuffer: 3 * 1024 * 1024 });
  return result.stdout.trim();
}

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
try {
  await cli("open", `http://127.0.0.1:${port}`);
  writeFileSync(path.join(artifacts, "initial.snapshot.txt"), await cli("snapshot"));
  await cli("run-code", `async page=>{
    await page.waitForFunction(()=>document.querySelector('#weekly-usage')?.dataset.state==='available');
    if(!await page.locator('#weekly-usage').isVisible())throw new Error('Weekly usage section is hidden');
    if(await page.locator('#weekly-usage-value').innerText()!=='65%')throw new Error('Current usage is missing');
    if(!await page.locator('#weekly-usage-track').isVisible())throw new Error('Current usage bar is hidden');
    const observed=await page.locator('#weekly-usage-observed').innerText();
    if(!observed)throw new Error('Confirmation time is missing');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "available.png"))}});
    await page.evaluate(()=>window.__setUsage('checking',${JSON.stringify(weeklyUsage)}));
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#weekly-usage')?.dataset.state==='checking');
    if(await page.locator('#weekly-usage-value').innerText()!=='65%')throw new Error('Value disappeared while checking');
    if(await page.locator('#weekly-usage-observed').innerText()!==observed)throw new Error('Confirmation time changed while checking');
    await page.evaluate(()=>window.__setUsage('unavailable',${JSON.stringify(weeklyUsage)}));
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#weekly-usage')?.dataset.state==='unavailable');
    if(await page.locator('#weekly-usage-value').innerText()!=='65%')throw new Error('Last confirmed value was lost');
    if(await page.locator('#weekly-usage-observed').innerText()!==observed)throw new Error('Failed refresh changed confirmation time');
    if(!(await page.locator('#weekly-usage-status').innerText()).includes('마지막 확인값'))throw new Error('Failure status is missing');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "retained-after-failure.png"))}});
    for(const state of ['checking','switching','timed-out','unavailable','no-limit','signed-out','not-applicable']){
      await page.evaluate(state=>window.__setUsage(state,null),state);
      await page.locator('#refresh').click();
      await page.waitForFunction(state=>document.querySelector('#weekly-usage')?.dataset.state===state,state);
      if(await page.locator('#weekly-usage').isVisible())throw new Error(state+' displayed an empty usage card');
      if(await page.locator('#weekly-usage-value').textContent())throw new Error(state+' invented a percentage or placeholder');
      if(await page.locator('#weekly-usage-track').isVisible())throw new Error(state+' left the percentage bar visible');
      if(await page.locator('#weekly-usage-status').textContent())throw new Error(state+' left a missing-data explanation');
    }
    await page.setViewportSize({width:360,height:700});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('Mobile usage layout overflows');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "mobile-empty-state.png"))}});
    if((await page.evaluate(()=>window.__errors)).length)throw new Error('Browser error');
  }`);
  writeFileSync(path.join(artifacts, "states.snapshot.txt"), await cli("snapshot"));
  assert.doesNotMatch(await cli("snapshot"), /계정 전체 Codex 주간 잔여량/);
  process.stdout.write("Dashboard confirmed usage, retained value, timestamp, and omission of missing-data cards passed.\n");
} finally {
  await cli("close").catch(() => undefined);
  server.close();
}
