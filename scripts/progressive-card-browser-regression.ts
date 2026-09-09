import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { activityFixture, cardPrelude, enrichment } from "./card-browser-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(repoRoot, "output", "playwright", "progressive-card-regression");
const session = `progressive-card-regression-${process.pid}`;
const execFileAsync = promisify(execFile);
mkdirSync(artifactDir, { recursive: true });

function recoveryPrelude(historical = false): string {
  const initial = activityFixture("structural", 7, "복구 검사 Activity");
  const restored = historical ? {
    ...initial,
    mountedPresentation: { kind: "historical", jobId: "recovery-job", requestId: "recovery-request" },
    watcherPolicy: { ...initial.watcherPolicy, live: false, mode: "one-shot" }
  } : initial;
  return `<script>
    window.__cardCalls=[];
    window.__cardErrors=[];
    window.__failEnrichment=1;
    window.__failRefresh=0;
    window.__pendingWatch=null;
    window.__duplicateWatches=0;
    window.__fixtureScope="41414141-4141-4141-8141-414141414141";
    window.__fixtureView=${JSON.stringify(restored)};
    window.addEventListener("error",event=>window.__cardErrors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__cardErrors.push(String(event.reason)));
    window.openai={
      locale:"ko-KR",notifyIntrinsicHeight:()=>{},
      toolResponseMetadata:{"codex/activityScopeId":window.__fixtureScope},
      toolOutput:window.__fixtureView,
      callTool:async(name,args)=>{
        window.__cardCalls.push({name,args});
        const failure=()=>({isError:true,content:[{type:"text",text:"Temporarily unavailable"}]});
        if(args.scopeId!==window.__fixtureScope)return{isError:true,content:[{type:"text",text:"Activity snapshot requires conversation scope"}]};
        if(args.afterVersion!==undefined){
          if(window.__pendingWatch){window.__duplicateWatches++;return failure()}
          return new Promise(resolve=>{window.__pendingWatch=()=>{
            window.__pendingWatch=null;
            resolve({structuredContent:{...window.__fixtureView,generatedAt:new Date().toISOString()}});
          }});
        }
        if(args.enrich===true&&window.__failEnrichment-->0)return failure();
        if(args.enrich!==true&&window.__failRefresh-->0)return failure();
        const view={...window.__fixtureView,generatedAt:new Date().toISOString(),enrichment:${JSON.stringify(enrichment("enriched"))}};
        if(args.enrich!==true)view.enrichment=${JSON.stringify(enrichment("structural"))};
        else view.weeklyUsage={remainingPercent:42,resetsAt:null};
        return{structuredContent:view};
      }
    };
  </script>`;
}

const fixtures = {
  "activity.html": ACTIVITY_CARD_HTML.replace("</head>", `${cardPrelude("activity")}</head>`),
  "activity-recovery.html": ACTIVITY_CARD_HTML.replace("</head>", `${recoveryPrelude()}</head>`),
  "activity-historical-recovery.html": ACTIVITY_CARD_HTML.replace("</head>", `${recoveryPrelude(true)}</head>`),
  "dashboard.html": DASHBOARD_CARD_HTML.replace("</head>", `${cardPrelude("dashboard")}</head>`),
  "settings.html": SETTINGS_CARD_HTML.replace("</head>", `${cardPrelude("settings")}</head>`)
};
for (const [filename, html] of Object.entries(fixtures)) {
  writeFileSync(path.join(artifactDir, filename), html);
}

async function cli(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(
    "npx",
    ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { cwd: repoRoot, encoding: "utf8", timeout, maxBuffer: 8 * 1_024 * 1_024 }
  );
  return stdout.trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const server = createServer((request, response) => {
  try {
    const filename = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname).slice(1);
    if (!Object.prototype.hasOwnProperty.call(fixtures, filename)) throw new Error("missing");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(readFileSync(path.join(artifactDir, filename)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object", "fixture server did not start");
const baseUrl = `http://127.0.0.1:${address.port}`;
const report: Record<string, unknown> = {};
let opened = false;

try {
  await cli(["open", `${baseUrl}/activity.html`], 60_000);
  opened = true;
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('.row .name')?.textContent==='최신 보강 활동',null,{timeout:2500})}"]);
  const activityStructural = JSON.parse(await cli(["eval", "()=>({elapsed:window.__structuralPaintElapsed,calls:window.__cardCalls,errors:window.__cardErrors,titles:window.__activityTitles})"]));
  assert(activityStructural.elapsed < 500, `Activity structural paint took ${activityStructural.elapsed}ms`);
  const activityEnriched = JSON.parse(await cli(["eval", "()=>({calls:window.__cardCalls,errors:window.__cardErrors})"]));
  assert(activityEnriched.calls.some((call: any) => call.args?.enrich === true), "Activity enrichment was not requested");
  assert(activityEnriched.calls[0]?.args?.enrich === true, "Activity did not dispatch enrichment before its long watch");
  assert(activityEnriched.calls[1]?.args?.afterVersion !== undefined, "Activity long watch was not dispatched after enrichment");
  assert(activityStructural.titles.includes("새 구조 활동"), "Activity did not apply the newer watch result");
  assert(!activityStructural.titles.includes("오래된 보강 활동"), "A stale Activity enrichment overwrote newer structural state");
  assert(activityEnriched.errors.length === 0, `Activity browser errors: ${activityEnriched.errors.join("; ")}`);
  const manualStructuralBefore = activityEnriched.calls.filter(
    (call: any) => call.args?.enrich === false && call.args?.afterVersion === undefined
  ).length;
  const activityClick = JSON.parse(await cli([
    "eval",
    "()=>{const button=document.querySelector('#refresh');button.click();const disabled=button.disabled;button.click();return{disabled}}"
  ]));
  assert(activityClick.disabled, "Activity refresh did not become busy synchronously");
  await cli(["run-code", `async page=>{await page.waitForFunction(count=>window.__cardCalls.filter(call=>call.args&&call.args.enrich===false&&call.args.afterVersion===undefined).length>count,${manualStructuralBefore},{timeout:2000})}`]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('.row .name')?.textContent==='최신 보강 활동',null,{timeout:2500})}"]);
  const activityManual = JSON.parse(await cli(["eval", "()=>({calls:window.__cardCalls,errors:window.__cardErrors,busy:document.querySelector('main.card').getAttribute('aria-busy')})"]));
  const manualStructuralAfter = activityManual.calls.filter(
    (call: any) => call.args?.enrich === false && call.args?.afterVersion === undefined
  ).length;
  assert(manualStructuralAfter === manualStructuralBefore + 1, "Rapid Activity refresh clicks dispatched duplicate structural reads");
  assert(activityManual.busy === "false", "Activity remained busy after refresh");
  assert(activityManual.errors.length === 0, `Activity refresh browser errors: ${activityManual.errors.join("; ")}`);
  report.activity = { structural: activityStructural, enriched: activityEnriched, manual: activityManual };

  for (const historical of [false, true]) {
    await cli(["goto", `${baseUrl}/activity-${historical ? "historical-" : ""}recovery.html`]);
    await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('#weekly-usage-value')?.textContent==='42%',null,{timeout:5000})}"]);
    const recovered = JSON.parse(await cli(["eval", "()=>({calls:window.__cardCalls,errors:window.__cardErrors})"]));
    assert(recovered.calls.filter((call: any) => call.args.enrich === true).length >= 2,
      "Activity did not retry a transient enrichment failure");
    if (historical) {
      assert(recovered.calls.every((call: any) => call.name === "codex_activity_rehydrate" && call.args.afterVersion === undefined),
        "Historical enrichment recovery acquired a live watcher");
    } else {
      const refreshCount = recovered.calls.filter((call: any) => call.args.enrich === false && call.args.afterVersion === undefined).length;
      await cli(["eval", "()=>{window.__failRefresh=1;document.querySelector('#refresh').click()}"]);
      await cli(["run-code", `async page=>{await page.waitForFunction(count=>window.__cardCalls.filter(call=>call.args.enrich===false&&call.args.afterVersion===undefined).length>=count+2&&document.querySelector('main.card').getAttribute('aria-busy')==='false',${refreshCount},{timeout:5000})}`]);
      const beforeWatch = JSON.parse(await cli(["eval", "()=>({count:window.__cardCalls.filter(call=>call.args.afterVersion!==undefined).length,duplicates:window.__duplicateWatches})"]));
      assert(beforeWatch.duplicates === 0, "Activity refresh opened a second watch before the first finished");
      await cli(["eval", "()=>window.__pendingWatch?.()"]);
      await cli(["run-code", `async page=>{await page.waitForFunction(count=>window.__cardCalls.filter(call=>call.args.afterVersion!==undefined).length>count,${beforeWatch.count},{timeout:5000})}`]);

      // Exhaust the immediate retries, then finish the old watch. Live updates
      // must resume without another click, even though its result is obsolete.
      await cli(["eval", "()=>{window.__failRefresh=3;document.querySelector('#refresh').click()}"]);
      await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('새로고침하지 못해'),null,{timeout:5000})}"]);
      const failedWatchCount = JSON.parse(await cli(["eval", "()=>window.__cardCalls.filter(call=>call.args.afterVersion!==undefined).length"]));
      await cli(["eval", "()=>window.__pendingWatch?.()"]);
      await cli(["run-code", `async page=>{await page.waitForFunction(count=>window.__cardCalls.filter(call=>call.args.afterVersion!==undefined).length>count,${failedWatchCount},{timeout:5000})}`]);
      assert(JSON.parse(await cli(["eval", "()=>window.__duplicateWatches"])) === 0,
        "Recovery leaked overlapping Activity watchers");
    }
    assert(recovered.errors.length === 0, "Activity recovery produced browser errors");
    report[historical ? "historicalRecovery" : "liveRecovery"] = recovered;
  }

  await cli(["goto", `${baseUrl}/dashboard.html`]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden,null,{timeout:2000})}"]);
  const dashboardStructural = JSON.parse(await cli(["eval", "()=>({elapsed:window.__structuralPaintElapsed,calls:window.__cardCalls,errors:window.__cardErrors,background:document.querySelector('#background-count').textContent})"]));
  assert(dashboardStructural.elapsed < 500, `Dashboard compatibility paint took ${dashboardStructural.elapsed}ms`);
  assert(dashboardStructural.calls[0]?.args?.enrich === false, "Dashboard did not request structure first");
  const dashboardPresentation = JSON.parse(await cli([
    "eval",
    "()=>({titles:[...document.querySelectorAll('#terminal-list .row-title')].map(node=>node.textContent),boundaries:[...document.querySelectorAll('#terminal-list .history-activity-boundary')].map(node=>node.textContent),executions:[...document.querySelectorAll('#terminal-list .execution')].map(node=>node.textContent)})"
  ]));
  assert(
    dashboardPresentation.titles.filter((title: string) => title === "Repeated title").length === 1,
    "Dashboard repeated the enclosing Activity title in Agent history"
  );
  assert(
    dashboardPresentation.boundaries.filter((title: string) => title === "이전 Activity").length === 1,
    "Dashboard lost or duplicated a same-title Activity boundary"
  );
  assert(
    dashboardPresentation.titles.includes("Different title"),
    "Dashboard omitted a distinct historical Activity title"
  );
  for (const execution of [
    "GPT-5.6 Sol · high",
    "GPT-5.6 Terra · max",
    "모델 · 추론 확인 불가",
    "GPT-5.6 Sol · medium"
  ]) {
    assert(
      dashboardPresentation.executions.includes(execution),
      `Dashboard omitted turn execution detail: ${execution}`
    );
  }
  assert(!dashboardPresentation.executions.some((execution: string) => execution.startsWith("다음 실행 설정:")),
    "Dashboard included a saved next-run selection beside actual execution history");
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('#background-count').textContent==='1',null,{timeout:2500})}"]);
  const dashboardEnriched = JSON.parse(await cli(["eval", "()=>({calls:window.__cardCalls,errors:window.__cardErrors})"]));
  assert(dashboardEnriched.calls.some((call: any) => call.args?.enrich === true), "Dashboard enrichment was not requested");
  assert(dashboardEnriched.errors.length === 0, `Dashboard browser errors: ${dashboardEnriched.errors.join("; ")}`);
  await cli(["goto", "about:blank"]);
  await cli(["go-back"]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden,null,{timeout:2000})}"]);
  report.dashboard = {
    structural: dashboardStructural,
    presentation: dashboardPresentation,
    enriched: dashboardEnriched,
    reentry: true
  };

  await cli(["goto", `${baseUrl}/settings.html`]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>!document.querySelector('#settings-form').hidden,null,{timeout:2000})}"]);
  const settings = JSON.parse(await cli(["eval", "()=>({elapsed:window.__structuralPaintElapsed,calls:window.__cardCalls,errors:window.__cardErrors})"]));
  assert(settings.elapsed < 500, `Settings cold paint took ${settings.elapsed}ms`);
  assert(settings.errors.length === 0, `Settings browser errors: ${settings.errors.join("; ")}`);
  report.settings = settings;

  const reportPath = path.join(artifactDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Progressive card browser regression passed.\n${reportPath}\n`);
} finally {
  if (opened) {
    try { await cli(["close"]); } catch { /* Preserve the regression failure. */ }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
