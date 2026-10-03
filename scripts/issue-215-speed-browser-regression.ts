import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { APP_SERVER_CAPABILITIES } from "../src/appServerUpstream.js";
import { loadConfig } from "../src/config.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { cardPrelude, dashboardView } from "./card-browser-fixtures.js";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";

// Real settings/MCP mutations; synthetic catalog and Dashboard history only.
// No installed settings, credentials, entitlement query or inference is used.
const output = path.resolve("output/playwright/issue-215-speed");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), "bridge-215-browser-"));
const state = new BridgeStateStore({ file: path.join(temporary, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: temporary });
const settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ uiLocalePreference: "en", modelPolicy: { mode: "fixed", selection: { model: "sol", reasoningEffort: "medium" }, constraints: { allowDelegation: true } } }, 0);
settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Speed preview", cwd: temporary } }], undefined, 0);
const catalog: CodexModelCatalogSnapshot = { source: "codex-cli", fetchedAt: new Date().toISOString(), fingerprint: "f".repeat(64), cached: true, stale: false, validation: "valid", models: [
  { id: "sol", displayName: "Sol", supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [{ id: "fast", name: "Fast" }], inputModalities: ["text"] },
  { id: "astra", displayName: "Astra", supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [{ id: "ultrafast", name: "Ultrafast" }], inputModalities: ["text"] }
] };
const bridge = createBridgeMcpServer(config, {
  capabilities: () => APP_SERVER_CAPABILITIES,
  async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("No inference in the speed browser regression"); },
  async close() {}
}, undefined, undefined, { async getCatalog() { return catalog; }, getCachedCatalog() { return catalog; } }, settings);
const connection = await connectCurrentMcpServer(bridge, { name: "issue-215-speed-browser", version: "1" });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = url.pathname === "/scenario"
        ? settings.update({ processingSpeed: body.processingSpeed }, settings.current.settingsRevision)
        : await connection.client.callTool({ name: body.name, arguments: body.args });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result)); return;
    }
    const dashboard = url.pathname === "/dashboard";
    const fixture = dashboardView("structural");
    const row = fixture.terminalRows[0]!;
    Object.assign(row.latestTurn.execution!, { processingSpeed: "fast", serviceTier: "fast", serviceTierScope: "turn", requestState: "accepted" });
    row.history.forEach(turn => { if (turn.execution) Object.assign(turn.execution, { processingSpeed: "legacy", requestState: "requested" }); });
    Object.assign(row.execution, { processingSpeed: "standard", serviceTier: "default", serviceTierScope: "turn" });
    const prelude = cardPrelude(dashboard ? "dashboard" : "settings") + `<script>
      window.__speedCalls=[];
      window.openai.locale='en';
      window.openai.callTool=async(name,args)=>{
        window.__speedCalls.push({name,args:structuredClone(args)});
        if(${dashboard}&&args.view==='dashboard')return {structuredContent:${JSON.stringify({ ...fixture, uiLocalePreference: "en", historyIncluded: true })}};
        return await(await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})})).json();
      };
    </script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end((dashboard ? DASHBOARD_CARD_HTML : SETTINGS_CARD_HTML).replace("</head>", () => prelude + "</head>"));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`, session = `issue-215-speed-${process.pid}`;
const execute = promisify(execFile);
async function cli(...args: string[]) {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], { timeout: 55_000, maxBuffer: 4 * 1024 * 1024 });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await cli("open", origin);
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  const settingsResult = await cli("run-code", `async page=>{
    const check=(value,message)=>{if(!value)throw new Error(message)};
    const speed=page.locator('#use-priority-service-tier');
    const tool=async(name,args)=>page.evaluate(async({name,args})=>await window.openai.callTool(name,args),{name,args});
    const read=async()=>(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>!document.querySelector('#save').disabled)};
    await page.locator('#settings-form').waitFor({state:'visible'});
    check(await speed.inputValue()==='legacy','Legacy behavior survives loading');
    check(!(await speed.locator('option').evaluateAll(options=>options.map(x=>x.value))).includes('ultrafast'),'Sol must not expose Astra-only Ultrafast');
    await speed.selectOption('fast');await save();
    let current=await read();check(current.settings.processingSpeed==='fast','Fast saves the canonical mode');
    check(current.settings.modelPolicy.selection.model==='sol'&&current.settings.modelPolicy.selection.reasoningEffort==='medium','Changing only speed preserves model and effort');
    check(current.capabilities.processingSpeedSupport.account==='unverified','Catalog is not account entitlement');
    await speed.selectOption('standard');await save();check((await read()).settings.processingSpeed==='standard','Standard remains an explicit mode');
    await page.locator('#policy-model').selectOption('astra');await save();
    await speed.selectOption('ultrafast');await save();current=await read();
    await tool('codex_update_settings',{expectedSettingsRevision:current.settings.settingsRevision,operation:{kind:'patch',settings:{usePriorityServiceTier:false,maxConcurrentJobs:3}}});
    check((await read()).settings.processingSpeed==='ultrafast','Old screen boolean cannot overwrite Ultrafast');
    await page.evaluate(async()=>await fetch('/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({processingSpeed:'future-tier'})}));
    await page.reload();await page.locator('#settings-form').waitFor({state:'visible'});
    check(await speed.inputValue()==='future-tier','Unknown saved mode is retained visibly');
    await page.locator('#concurrency').fill('4');await save();current=await read();
    check(current.settings.processingSpeed==='future-tier','Unrelated screen save preserves unknown mode');
    const last=await page.evaluate(()=>window.__speedCalls.filter(x=>x.name==='codex_update_settings').at(-1));
    check(last.args.operation.settings.processingSpeed===undefined&&last.args.operation.settings.usePriorityServiceTier===undefined,'Unknown mode is not resent or collapsed to a boolean');
    await page.screenshot({path:${JSON.stringify(path.join(output, "settings-unknown.png"))}});
    return {checks:7,savedMode:current.settings.processingSpeed};
  }`);
  await cli("goto", `${origin}/dashboard`);
  writeFileSync(path.join(output, "dashboard.snapshot.txt"), await cli("snapshot"));
  const dashboardResult = await cli("run-code", `async page=>{
    await page.locator('#history-filter').click();await page.locator('#terminal-section').waitFor({state:'visible'});
    const text=await page.locator('#terminal-section').innerText();
    if(!text.includes('Fast (this Job) requested')||!text.includes('request accepted')||!text.includes('actual speed unconfirmed'))throw new Error('Accepted requests must not become actual speed: '+text);
    await page.setViewportSize({width:360,height:900});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('Speed evidence causes mobile overflow');
    await page.screenshot({path:${JSON.stringify(path.join(output, "dashboard-mobile.png"))}});
    return {checks:2};
  }`);
  const report = { settingsResult, dashboardResult, inferenceExecuted: false, installedSettingsChanged: false };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await cli("close").catch(() => {});
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.close(); state.close(); rmSync(temporary, { recursive: true, force: true });
}
