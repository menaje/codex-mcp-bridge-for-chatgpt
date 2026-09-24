import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML as SOURCE_DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML as SOURCE_SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { dashboardView, settingsView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/issue-143-card-stale");
mkdirSync(artifacts, { recursive: true });
const execute = promisify(execFile);
const session = `issue-143-card-stale-${process.pid}`;
const installedRuntime = path.join(
  "/Applications/Codex MCP Bridge for ChatGPT.app",
  "Contents/Resources/Runtime/dist"
);
const useInstalledBundle = process.argv.includes("--installed-app");
let DASHBOARD_CARD_HTML = SOURCE_DASHBOARD_CARD_HTML;
let SETTINGS_CARD_HTML = SOURCE_SETTINGS_CARD_HTML;
if (useInstalledBundle) {
  const [dashboard, settings] = await Promise.all([
    import(pathToFileURL(path.join(installedRuntime, "dashboardCard.js")).href),
    import(pathToFileURL(path.join(installedRuntime, "settingsCard.js")).href)
  ]);
  DASHBOARD_CARD_HTML = dashboard.DASHBOARD_CARD_HTML;
  SETTINGS_CARD_HTML = settings.SETTINGS_CARD_HTML;
}
function prelude(kind: "dashboard" | "settings"): string {
  const fixture = kind === "dashboard" ? dashboardView("structural") : settingsView;
  return `<script>(()=>{
    window.__calls=[];window.__messages=[];window.__errors=[];window.__failReads=false;
    addEventListener("error",event=>window.__errors.push(String(event.error?.message||event.message)));
    addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason?.message||event.reason)));
    const nativePost=window.postMessage.bind(window);
    window.postMessage=(message,target,...rest)=>{window.__messages.push(structuredClone(message));return nativePost(message,target,...rest)};
    window.openai={locale:"ko-KR",notifyIntrinsicHeight:()=>{},callTool:async(name,args)=>{
      window.__calls.push({name,args:structuredClone(args)});
      if(window.__failReads&&name==="codex_ui_read")throw Object.assign(new Error("dispatched read timeout"),{code:"MCP_TOOL_CALL_DISPATCH_TIMEOUT"});
      return {structuredContent:${JSON.stringify(fixture)}};
    }};
  })();</script>`;
}

function card(kind: "dashboard" | "settings"): string {
  const source = kind === "dashboard"
    ? DASHBOARD_CARD_HTML
        .replace(
          "STANDARD_BRIDGE_INIT_TIMEOUT_MS=5000,TOOL_CALL_TIMEOUT_MS=15000",
          "STANDARD_BRIDGE_INIT_TIMEOUT_MS=80,TOOL_CALL_TIMEOUT_MS=120"
        )
    : SETTINGS_CARD_HTML.replace("REQUEST_TIMEOUT_MS = 90000", "REQUEST_TIMEOUT_MS = 120");
  return source.replace("</head>", `${prelude(kind)}</head>`);
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute(
    "npx",
    ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  );
  if (/Error:|TimeoutError:/u.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout.trim();
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(card(request.url === "/settings" ? "settings" : "dashboard"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

try {
  await cli("open", `${origin}/dashboard`);
  writeFileSync(path.join(artifacts, "dashboard-initial.snapshot.txt"), await cli("snapshot"));
  await cli("run-code", `async page=>{
    await page.locator('#dashboard-content').waitFor({state:'visible'});
    await page.waitForTimeout(200);
    const before=await page.evaluate(()=>({calls:window.__calls.length,tools:window.__messages.filter(x=>x.method==='tools/call').length,updated:document.querySelector('#updated').textContent}));
    await page.evaluate(()=>{window.__failReads=true});
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
    const after=await page.evaluate(()=>({calls:window.__calls.length,tools:window.__messages.filter(x=>x.method==='tools/call').length,updated:document.querySelector('#updated').textContent,message:document.querySelector('#message').textContent,visible:document.querySelector('#dashboard-content').hidden===false,errors:window.__errors}));
    if(after.calls!==before.calls+1)throw new Error('Dashboard timeout issued a duplicate compatibility call');
    if(after.tools!==before.tools)throw new Error('Dashboard timeout retried through standard tools/call');
    if(!after.visible||after.updated!==before.updated)throw new Error('Dashboard timeout replaced the last confirmed view');
    if(!after.message||after.errors.length)throw new Error('Dashboard stale presentation failed');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "dashboard-stale.png"))},fullPage:true});
  }`);

  await cli("goto", `${origin}/settings`);
  writeFileSync(path.join(artifacts, "settings-initial.snapshot.txt"), await cli("snapshot"));
  await cli("run-code", `async page=>{
    await page.locator('#settings-form').waitFor({state:'visible'});
    await page.waitForTimeout(200);
    const before=await page.evaluate(()=>({calls:window.__calls.length,tools:window.__messages.filter(x=>x.method==='tools/call').length,access:document.querySelector('#access-strategy').value}));
    await page.evaluate(()=>{window.__failReads=true;document.querySelector('#retry-models').hidden=false});
    await page.evaluate(()=>document.querySelector('#retry-models').click());
    await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));
    const after=await page.evaluate(()=>({calls:window.__calls.length,tools:window.__messages.filter(x=>x.method==='tools/call').length,access:document.querySelector('#access-strategy').value,visible:document.querySelector('#settings-form').hidden===false,status:document.querySelector('#status').textContent,errors:window.__errors}));
    if(after.calls!==before.calls+1)throw new Error('Settings timeout issued a duplicate call');
    if(after.tools!==before.tools)throw new Error('Settings timeout retried through standard tools/call');
    if(!after.visible||after.access!==before.access)throw new Error('Settings timeout replaced the last confirmed view');
    if(!after.status||after.errors.length)throw new Error('Settings stale presentation failed');
    await page.screenshot({path:${JSON.stringify(path.join(artifacts, "settings-stale.png"))},fullPage:true});
  }`);

  const report = {
    passed: true,
    source: useInstalledBundle ? installedRuntime : "current checkout",
    artifacts,
    checks: [
      "Dashboard keeps its last confirmed DOM after a dispatched read timeout",
      "Settings keeps its last confirmed form after a dispatched read timeout",
      "neither card retries the timed-out read through a second tool-call path"
    ]
  };
  writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await cli("close").catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
}
