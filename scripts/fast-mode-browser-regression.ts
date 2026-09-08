import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { ACTIVITY_CARD_CONTRACT_GENERATION, ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { SUPPORTED_UI_LOCALES, UI_TRANSLATIONS } from "../src/uiI18n.js";
import { activityView, cardPrelude, dashboardView } from "./card-browser-fixtures.js";

type CardKind = "activity" | "dashboard" | "settings";
const output = path.resolve("output/playwright/fast-mode");
mkdirSync(output, { recursive: true });
const htmlByKind = { activity: ACTIVITY_CARD_HTML, dashboard: DASHBOARD_CARD_HTML, settings: SETTINGS_CARD_HTML };
const selection = { model: "gpt-5.6-sol", modelDisplayName: "GPT-5.6 Sol", reasoningEffort: "high", isCurrent: false };
const activity = activityView("enriched");
const agents = [undefined, "priority", "fast"].map((serviceTier, index) => ({
  agentId: `fast-agent-${index}`,
  agentName: ["Standard Agent", "Priority Agent", "Fast Agent"][index],
  displayState: "running",
  elapsedMs: 2_000,
  execution: { ...selection, isCurrent: true, ...(serviceTier ? { serviceTier } : {}) }
}));
const activityFixture = {
  ...activity,
  mountedActivity: { ...activity.mountedActivity, cardGeneration: ACTIVITY_CARD_CONTRACT_GENERATION },
  feed: {
    ...activity.feed,
    active: [{ ...activity.feed.active[0], title: "Fast mode", agents, counts: { total: 3, failed: 0 } }]
  }
};
const dashboard = dashboardView("enriched");
const row = dashboard.terminalRows[0];
const dashboardFixture = {
  ...dashboard,
  terminalRows: [{
    ...row,
    execution: { ...selection, isCurrent: true, serviceTier: "fast" },
    latestTurn: { ...row.latestTurn, execution: selection },
    history: [
      { ...row.history[0], execution: { ...selection, serviceTier: "priority" } },
      { ...row.history[1], execution: selection }
    ],
    historyCount: 2
  }]
};

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const kind = url.pathname.slice(1) as CardKind;
  const locale = url.searchParams.get("locale") || "ko";
  if (!Object.hasOwn(htmlByKind, kind)) { response.writeHead(404).end(); return; }
  const view = kind === "activity" ? activityFixture : dashboardFixture;
  const prelude = cardPrelude(kind) + `<script>
    window.openai.locale=${JSON.stringify(locale)};
    window.__fastFixture=${JSON.stringify(view)};
    window.__fastFixture.uiLocalePreference=${JSON.stringify(locale)};
    if(${JSON.stringify(kind)}==="activity"){
      window.openai.toolResponseMetadata["codex/activityView@11"].view=window.__fastFixture;
    }
    const originalCall=window.openai.callTool;
    window.openai.callTool=async(name,args)=>{
      if(${JSON.stringify(kind)}==="settings"){
        const result=await originalCall(name,args);
        result.structuredContent.settings.uiLocalePreference=${JSON.stringify(locale)};
        result.structuredContent.settings.usePriorityServiceTier=true;
        return result;
      }
      window.__cardCalls.push({name,args});
      if(args.afterVersion!==undefined)return new Promise(()=>{});
      return {structuredContent:JSON.parse(JSON.stringify(window.__fastFixture))};
    };
  </script>`;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(htmlByKind[kind].replace("</head>", () => prelude + "</head>"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const session = `fast-mode-${process.pid}`;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], {
    encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1_024 * 1_024
  });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
const report: Record<string, string> = {};
try {
  await cli("open", `${origin}/activity?locale=ko`);
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  for (const kind of ["activity", "dashboard", "settings"] as const) {
    const cases = SUPPORTED_UI_LOCALES.map(locale => ({
      locale,
      badge: `⚡ ${UI_TRANSLATIONS[locale]["dashboard.execution.fast"]}`,
      setting: UI_TRANSLATIONS[locale]["settings.usePriority"],
      hint: UI_TRANSLATIONS[locale]["settings.usePriorityHint"]
    }));
    report[kind] = await cli("run-code", `async page => {
      const checked=[];
      await page.setViewportSize({width:360,height:980});
      for(const entry of ${JSON.stringify(cases)}){
        await page.goto(${JSON.stringify(origin + "/" + kind + "?locale=")}+entry.locale);
        if(${JSON.stringify(kind)}==="settings"){
          await page.locator('#settings-form').waitFor({state:'visible'});
          const label=page.locator('label').filter({has:page.locator('#use-priority-service-tier')});
          if((await label.textContent()).trim()!==entry.setting)throw new Error('Wrong settings label: '+entry.locale);
          if(!await page.locator('#use-priority-service-tier').isChecked())throw new Error('Saved Fast setting is missing');
          if(!await page.getByText(entry.hint,{exact:true}).isVisible())throw new Error('Missing settings explanation');
        }else{
          await page.locator('.fast-mode').first().waitFor({state:'visible'});
          if(${JSON.stringify(kind)}==="activity"){
            const standard=page.locator('.activity-agent').filter({hasText:'Standard Agent'});
            if(await standard.locator('.fast-mode').count())throw new Error('Standard Agent incorrectly marked Fast');
            if(await page.locator('.activity-agent .fast-mode').count()!==2)throw new Error('Both tier aliases must have a badge');
          }else{
            await page.locator('summary.history-toggle').first().click();
            if(await page.locator('.history-list .fast-mode').count()!==1)throw new Error('History must keep its original processing mode');
          }
          for(const text of await page.locator('.fast-mode').allTextContents()){
            if(text!==entry.badge)throw new Error('Wrong localized badge: '+text);
          }
        }
        const layout=await page.evaluate(()=>({
          overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
          clipped:[...document.querySelectorAll('.fast-mode')].filter(element=>element.getClientRects().length).some(element=>element.getBoundingClientRect().right>document.documentElement.clientWidth),
          errors:window.__cardErrors
        }));
        if(layout.errors.length||layout.overflow||layout.clipped)throw new Error(JSON.stringify({locale:entry.locale,...layout}));
        if(['ko','en','de'].includes(entry.locale))await page.screenshot({path:${JSON.stringify(path.join(output, kind + "-"))}+entry.locale+'.png',fullPage:true});
        checked.push(entry.locale);
      }
      return checked;
    }`);
    console.log(`Passed ${kind}: nine languages, narrow layout, and execution-specific badges.`);
  }
} finally {
  await cli("close").catch(() => {});
  server.close();
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
