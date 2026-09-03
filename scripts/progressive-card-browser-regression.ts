import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(repoRoot, "output", "playwright", "progressive-card-regression");
const session = `progressive-card-regression-${process.pid}`;
const execFileAsync = promisify(execFile);
mkdirSync(artifactDir, { recursive: true });

const enrichment = (state: "structural" | "enriched") => ({
  state,
  runtimeRequests: state === "enriched" ? 1 : 0,
  cacheHits: 0,
  timeouts: 0,
  durationMs: state === "enriched" ? 650 : 0,
  usageTimedOut: false
});

const activityView = (state: "structural" | "enriched") => ({
  scopeVersion: 7,
  generatedAt: state === "structural"
    ? "2026-09-03T00:00:00.000Z"
    : "2026-09-03T00:00:01.000Z",
  enrichment: enrichment(state),
  weeklyUsage: null,
  uiLocalePreference: "ko",
  completionHandoff: "off",
  pendingHandoffs: [],
  mountedActivity: { activityId: "progressive-activity", cardGeneration: 1 },
  mountedPresentation: { kind: "explicit" },
  watcherPolicy: {
    mode: "scope-version-long-poll",
    live: true,
    stopped: false,
    ownsCompletionHandoff: false
  },
  feed: {
    mode: "full",
    active: [{
      rowType: "activity",
      activityId: "progressive-activity",
      title: state === "structural" ? "구조 활동" : "보강 활동",
      lifecycle: "open",
      kind: "implementation",
      displayState: "running",
      elapsedMs: 1_000,
      counts: { total: 1, failed: 0 },
      agents: [],
      cancellations: [],
      canRequestVerification: false,
      canRetry: false,
      workspaceLabels: [],
      projectName: null
    }],
    activeCount: 1,
    activityTotal: 1,
    activeHasMore: false,
    showWorkspaceLabels: false,
    historySummary: { completedActivities: 0, endedActivities: 0, idleAgents: 0 },
    history: { rows: [], pagination: {} },
    idleAgents: { rows: [], pagination: {} }
  }
});

const activityFixture = (
  state: "structural" | "enriched",
  scopeVersion: number,
  title: string
) => {
  const fixture = activityView(state);
  return {
    ...fixture,
    scopeVersion,
    feed: {
      ...fixture.feed,
      active: [{ ...fixture.feed.active[0], title }]
    }
  };
};

const dashboardPage = (total = 0) => ({
  offset: 0,
  limit: 20,
  returned: 0,
  total,
  returnedConversations: 0,
  conversationTotal: 0,
  hasPrevious: false,
  hasNext: false
});
const dashboardView = (state: "structural" | "enriched") => ({
  kind: "dashboard",
  generatedAt: state === "structural"
    ? "2026-09-03T00:00:00.000Z"
    : "2026-09-03T00:00:01.000Z",
  scope: "bridge-wide",
  statusSource: "codex-runtime-only",
  coverage: "bridge-known-retained",
  enrichment: enrichment(state),
  weeklyUsage: null,
  counts: {
    trackedProjects: 1,
    trackedConversations: 1,
    retainedJobs: 0,
    active: 0,
    running: 0,
    inputRequired: 0,
    approvalRequired: 0,
    terminating: 0,
    needsAttention: 0,
    backgroundProcesses: state === "enriched" ? 1 : 0,
    backgroundProcessAgents: state === "enriched" ? 1 : 0,
    runtimeUnknownAgents: 0,
    runtimeProbeSkippedAgents: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    idleAgents: 0,
    orphanedAgents: 0
  },
  activeRows: [],
  terminalRows: [],
  idleRows: [],
  pagination: {
    active: dashboardPage(),
    terminal: dashboardPage(),
    idle: dashboardPage()
  },
  uiLocalePreference: "ko"
});

const settingsView = {
  settings: {
    schemaVersion: 1,
    settingsRevision: 1,
    registryRevision: 0,
    accessStrategy: "read-only",
    modelPolicy: {
      mode: "fixed",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      constraints: { allowDelegation: true }
    },
    usePriorityServiceTier: false,
    showBridgeThreadsInCodexApp: true,
    uiLocalePreference: "ko",
    maxConcurrentJobs: 2,
    activityCardVisibility: "always",
    completionHandoff: "off",
    projects: []
  },
  capabilities: {
    availableAccessStrategies: ["read-only", "adaptive"],
    availableUiLocalePreferences: ["auto", "en", "ko"],
    projectAvailability: [],
    maxConcurrentJobs: 4,
    defaultBackend: "app-server",
    operatorModelCeiling: null
  },
  catalog: {
    source: "fixture",
    validation: "valid",
    stale: false,
    warning: null,
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }]
    }]
  },
  warnings: [],
  policyActivation: {
    policyRevision: 1,
    executionPolicyActive: true,
    descriptorProjectionUpdated: false,
    developerModeRefreshRequired: false
  }
};

function prelude(kind: "activity" | "dashboard" | "settings"): string {
  const initialActivityMetadata = {
    "codex/activityView@11": {
      kind: "codex/activityView",
      version: 11,
      purpose: "presentation-hydration-only",
      correlation: { scopeVersion: 7 },
      view: activityView("structural")
    }
  };
  return `<script>
    window.__fixtureStartedAt=performance.now();
    window.__structuralPaintElapsed=null;
    window.__cardErrors=[];
    window.__cardCalls=[];
    window.__activityTitles=[];
    window.__activityEnrichmentCalls=0;
    window.__activityWatchAdvanced=false;
    window.addEventListener("error",event=>window.__cardErrors.push(String(event.error&&event.error.message||event.message)));
    window.addEventListener("unhandledrejection",event=>window.__cardErrors.push(String(event.reason&&event.reason.message||event.reason)));
    document.addEventListener("DOMContentLoaded",()=>{
      const mark=()=>{
        const activityTitle=${JSON.stringify(kind)}==="activity"&&document.querySelector(".row .name")?.textContent||"";
        if(activityTitle&&window.__activityTitles.at(-1)!==activityTitle)window.__activityTitles.push(activityTitle);
        if(window.__structuralPaintElapsed!==null)return;
        const activityReady=${JSON.stringify(kind)}==="activity"&&document.querySelector(".row .name")?.textContent==="구조 활동";
        const dashboardReady=${JSON.stringify(kind)}==="dashboard"&&document.querySelector("#dashboard-content")?.hidden===false;
        const settingsReady=${JSON.stringify(kind)}==="settings"&&document.querySelector("#settings-form")?.hidden===false;
        if(activityReady||dashboardReady||settingsReady)window.__structuralPaintElapsed=performance.now()-window.__fixtureStartedAt;
      };
      new MutationObserver(mark).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      mark();
    });
    window.openai={
      locale:"ko-KR",
      notifyIntrinsicHeight:()=>{},
      ${kind === "activity" ? `toolResponseMetadata:${JSON.stringify(initialActivityMetadata)},` : ""}
      callTool:async(name,args)=>{
        window.__cardCalls.push({name,args,at:performance.now()-window.__fixtureStartedAt});
        if(${JSON.stringify(kind)}==="activity"){
          if(args&&args.afterVersion!==undefined){
            if(args.afterVersion===7&&!window.__activityWatchAdvanced){window.__activityWatchAdvanced=true;await new Promise(resolve=>setTimeout(resolve,100));return{structuredContent:Object.assign(${JSON.stringify(activityFixture("structural", 8, "새 구조 활동"))},{generatedAt:new Date().toISOString()})};}
            return new Promise(()=>{});
          }
          if(args&&args.enrich===true){const call=++window.__activityEnrichmentCalls;await new Promise(resolve=>setTimeout(resolve,call===1?650:50));return{structuredContent:Object.assign(call===1?${JSON.stringify(activityFixture("enriched", 7, "오래된 보강 활동"))}:${JSON.stringify(activityFixture("enriched", 8, "최신 보강 활동"))},{generatedAt:new Date().toISOString()})};}
          await new Promise(resolve=>setTimeout(resolve,20));return{structuredContent:Object.assign(${JSON.stringify(activityFixture("structural", 8, "새 구조 활동"))},{generatedAt:new Date().toISOString()})};
        }
        if(${JSON.stringify(kind)}==="dashboard"){
          await new Promise(resolve=>setTimeout(resolve,args&&args.enrich===true?650:20));
          return{structuredContent:args&&args.enrich===true?${JSON.stringify(dashboardView("enriched"))}:${JSON.stringify(dashboardView("structural"))}};
        }
        await new Promise(resolve=>setTimeout(resolve,20));
        return{structuredContent:${JSON.stringify(settingsView)}};
      }
    };
  </script>`;
}

const fixtures = {
  "activity.html": ACTIVITY_CARD_HTML.replace("</head>", `${prelude("activity")}</head>`),
  "dashboard.html": DASHBOARD_CARD_HTML.replace("</head>", `${prelude("dashboard")}</head>`),
  "settings.html": SETTINGS_CARD_HTML.replace("</head>", `${prelude("settings")}</head>`)
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

  await cli(["goto", `${baseUrl}/dashboard.html`]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden,null,{timeout:2000})}"]);
  const dashboardStructural = JSON.parse(await cli(["eval", "()=>({elapsed:window.__structuralPaintElapsed,calls:window.__cardCalls,errors:window.__cardErrors,background:document.querySelector('#background-count').textContent})"]));
  assert(dashboardStructural.elapsed < 500, `Dashboard compatibility paint took ${dashboardStructural.elapsed}ms`);
  assert(dashboardStructural.calls[0]?.args?.enrich === false, "Dashboard did not request structure first");
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>document.querySelector('#background-count').textContent==='1',null,{timeout:2500})}"]);
  const dashboardEnriched = JSON.parse(await cli(["eval", "()=>({calls:window.__cardCalls,errors:window.__cardErrors})"]));
  assert(dashboardEnriched.calls.some((call: any) => call.args?.enrich === true), "Dashboard enrichment was not requested");
  assert(dashboardEnriched.errors.length === 0, `Dashboard browser errors: ${dashboardEnriched.errors.join("; ")}`);
  await cli(["goto", "about:blank"]);
  await cli(["go-back"]);
  await cli(["run-code", "async page=>{await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden,null,{timeout:2000})}"]);
  report.dashboard = { structural: dashboardStructural, enriched: dashboardEnriched, reentry: true };

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
