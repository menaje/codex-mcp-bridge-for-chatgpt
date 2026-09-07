import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cardPrelude, dashboardView } from "./card-browser-fixtures.js";

// Exercise both source-rendered snapshots and the packaged runtime with --built.
const directory = process.argv.includes("--built") ? "dist" : "src";
const group = process.argv.find((arg) => arg.startsWith("--group="))?.slice(8);
const [{ ACTIVITY_CARD_HTML, ACTIVITY_CARD_CONTRACT_GENERATION }, { DASHBOARD_CARD_HTML },
  { SETTINGS_CARD_HTML }, { htmlForUiResource, uiResourceRevisions }] = await Promise.all([
  import(`../${directory}/activityCard.js`), import(`../${directory}/dashboardCard.js`),
  import(`../${directory}/settingsCard.js`), import(`../${directory}/uiResources.js`)
]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(repoRoot, "output/playwright/card-resilience", directory);
mkdirSync(artifactDir, { recursive: true });
const session = `card-resilience-${process.pid}`;
const exec = promisify(execFile);
const current = { activity: ACTIVITY_CARD_HTML, dashboard: DASHBOARD_CARD_HTML, settings: SETTINGS_CARD_HTML };
function fixture(kind: keyof typeof current, code = "", html = current[kind]): string {
  return html.replace("</head>", () => `${cardPrelude(kind)}<script>
    window.__hostCalls=[];
    window.addEventListener('message',event=>{if(event.data?.method==='tools/call')window.__hostCalls.push(event.data.params)});
    ${code}
  </script></head>`);
}
const fixtures: Record<string, string> = {};
for (const wrapper of ["direct", "mcp_tool_result", "call_tool_result", "result", "tool_result", "nested", "private"]) {
  fixtures[`settings-${wrapper}`] = fixture("settings", `
    const originalCall=window.openai.callTool;
    window.openai.callTool=async(...args)=>{
      const result=await originalCall(...args),kind=${JSON.stringify(wrapper)};
      if(kind==='direct')return result;
      if(kind==='nested')return JSON.stringify({result:{mcp_tool_result:JSON.stringify(result)}});
      if(kind==='private')return{mcp_tool_result:{structuredContent:{ok:true},_meta:{'codex/settingsView':result.structuredContent}}};
      return{[kind]:result};
    };`);
}
fixtures["settings-initial-failure"] = fixture("settings", `
  const originalCall=window.openai.callTool;let fail=true;
  window.openai.callTool=async(...args)=>{if(fail){fail=false;window.__cardCalls.push({name:args[0],args:args[1]});return{mcp_tool_result:{isError:true,content:[{type:'text',text:'SNAPSHOT_UNAVAILABLE: Try again'}]}}}return originalCall(...args)};`);
fixtures["settings-timeout"] = fixture("settings", `
  window.__healthyCall=window.openai.callTool;
  window.openai.callTool=(name,args)=>{window.__cardCalls.push({name,args});return new Promise(resolve=>{window.__lateSettings=resolve})};`);
fixtures["settings-mutation-timeout"] = fixture("settings", `
  const originalCall=window.openai.callTool;
  window.openai.callTool=(name,args)=>{if(name==='codex_update_settings'){window.__cardCalls.push({name,args});return new Promise(()=>{})}return originalCall(name,args)};`);
fixtures["settings-locale"] = fixture("settings", `
  const originalCall=window.openai.callTool;
  window.openai.callTool=async(...args)=>{const result=await originalCall(...args);result.structuredContent.settings.uiLocalePreference='auto';result.structuredContent.catalog.models[0].supportedReasoningEfforts.push({effort:'high'});return result};`);
fixtures["activity-errors"] = fixture("activity", `
  const fixtureView=window.openai.toolResponseMetadata['codex/activityView@11'].view;
  fixtureView.generatedAt=new Date().toISOString();fixtureView.enrichment.state='enriched';fixtureView.mountedActivity.cardGeneration=${ACTIVITY_CARD_CONTRACT_GENERATION};
  fixtureView.feed.active[0].agents=[{agentId:'11111111-1111-4111-8111-111111111111',agentName:'Test Agent',displayState:'running',canForceStop:true,durationMs:1000,backgroundProcessCount:1}];
  const fixtureControls={agents:[{agentId:'11111111-1111-4111-8111-111111111111',jobId:'22222222-2222-4222-8222-222222222222',jobVersion:3,agentVersion:2,backgroundProcesses:[{processId:'test-process'}],pendingInteractions:[{interactionId:'33333333-3333-4333-8333-333333333333',kind:'user-input',summary:'Input request',questions:[{id:'answer',question:'Your answer',isSecret:false}]}]}]};
  window.openai.toolResponseMetadata.interactionControls=fixtureControls;window.confirm=()=>true;
  window.openai.callTool=async(name,args)=>{
    window.__cardCalls.push({name,args});
    if(['codex_interaction_respond','codex_activity_job_cancel','codex_background_process_terminate'].includes(name))return{mcp_tool_result:{isError:true,content:[{type:'text',text:'JOB_VERSION_CHANGED: This control is stale.'}]}};
    if(args.afterVersion!==undefined)return new Promise(()=>{});
    return{structuredContent:{...fixtureView,generatedAt:new Date().toISOString()},_meta:{interactionControls:fixtureControls}};
  };`);
fixtures["dashboard-deferred"] = fixture("dashboard", `
  const originalCall=window.openai.callTool;window.__reads=[];window.__enrichments=[];window.__nowOffset=0;const realNow=Date.now;Date.now=()=>realNow()+window.__nowOffset;
  window.openai.callTool=async(name,args)=>{
    const result=await originalCall(name,{...args,enrich:false});
    return new Promise((resolve,reject)=>{(args.enrich===true?window.__enrichments:window.__reads).push({args,reject,resolve:(title)=>{
      const view=result.structuredContent;view.generatedAt=new Date().toISOString();
      view.terminalRows[0].activityTitle=title;view.terminalRows[0].latestTurn.activityTitle=title;
      view.pagination.terminal={...view.pagination.terminal,offset:args.terminalOffset||0,returned:1,total:3,hasNext:true};
      resolve(result);
    }})});
  };`);
const standardDashboardHtml = DASHBOARD_CARD_HTML.replace("</head>", () => `<script>
  window.addEventListener('error',event=>parent.__cardErrors.push(String(event.message)));
  window.addEventListener('unhandledrejection',event=>parent.__cardErrors.push(String(event.reason)));
</script></head>`);
fixtures["dashboard-standard-init"] = `<!doctype html><html><body><iframe id="dashboard-card"></iframe><script>
  const frame=document.querySelector('#dashboard-card');
  window.__initializations=[];window.__cardErrors=[];window.__cardCalls=[];window.__hostCalls=window.__cardCalls;
  window.__replyInitialization=()=>frame.contentWindow.postMessage({jsonrpc:'2.0',id:window.__initializations.at(-1),result:{protocolVersion:'2026-01-26',hostContext:{locale:'ko-KR'}}},'*');
  window.addEventListener('message',event=>{
    const message=event.data;if(event.source!==frame.contentWindow||message?.jsonrpc!=='2.0')return;
    if(message.method==='ui/initialize')window.__initializations.push(message.id);
    if(message.method==='tools/call'){
      window.__cardCalls.push({name:message.params.name,args:message.params.arguments});
      const view=${JSON.stringify(dashboardView("structural"))};view.generatedAt=new Date().toISOString();
      event.source.postMessage({jsonrpc:'2.0',id:message.id,result:{structuredContent:view}},'*');
    }
  });
  frame.srcdoc=${JSON.stringify(standardDashboardHtml).replaceAll("<", "\\u003c")};
</script></body></html>`;
const retainedSettings = uiResourceRevisions("settings").slice(1);
for (const [index, revision] of [retainedSettings[0], retainedSettings.at(-1)].entries()) {
  fixtures[`retained-settings-${index}`] = fixture("settings", `
    window.openai.callTool=async()=>({isError:true,content:[{type:'text',text:'SNAPSHOT_UNAVAILABLE: Try again'}]});`,
  htmlForUiResource("settings", revision.uri, SETTINGS_CARD_HTML));
}
for (const revision of uiResourceRevisions("dashboard").slice(1)) {
  const html = htmlForUiResource("dashboard", revision.uri, DASHBOARD_CARD_HTML);
  if (!html.includes("__name(")) continue;
  fixtures[`retained-dashboard-${revision.digest.slice(0, 12)}`] = fixture("dashboard", `
    const originalCall=window.openai.callTool;
    window.openai.callTool=async(...args)=>{const result=await originalCall(...args),view=result.structuredContent;view.terminalRows.push({...view.terminalRows[0],rowKey:'second-agent',agentName:'Second Test Agent'});view.pagination.terminal.returned=2;view.pagination.terminal.total=2;return result};`, html);
}
for (const [name, html] of Object.entries(fixtures)) writeFileSync(path.join(artifactDir, `${name}.html`), html);
const server = createServer((request, response) => {
  const name = new URL(request.url || "/", "http://127.0.0.1").pathname.slice(1);
  if (!Object.hasOwn(fixtures, name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(fixtures[name]);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
async function cli(...args: string[]): Promise<string> {
  const { stdout } = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
const run = (code: string) => cli("run-code", `async page=>{${code}}`);
const evaluate = async (code: string) => JSON.parse(await cli("eval", code));
async function open(name: string): Promise<void> {
  await cli("goto", `${origin}/${name}`);
  await cli("snapshot");
}
let clockInstalled = false;
async function installClock(): Promise<void> {
  if (clockInstalled) return;
  await run("await page.clock.install();");
  clockInstalled = true;
}
const report: Record<string, unknown> = {};
async function record(name: string): Promise<void> {
  const state = await evaluate("()=>({calls:window.__cardCalls,hostCalls:window.__hostCalls,errors:window.__cardErrors})");
  assert.deepEqual(state.errors, [], `${name}: browser runtime error`);
  report[name] = state;
  process.stdout.write(`Passed ${name}\n`);
}
const waitForSettings = "await page.locator('#settings-form').waitFor({state:'visible',timeout:3000});";
const waitForRead = (count: number) => `await page.waitForFunction(count=>window.__reads.length>=count,${count},{timeout:3000});`;
try {
  await cli("open", "about:blank");
  if (!group || group === "settings") {
    for (const wrapper of ["direct", "mcp_tool_result", "call_tool_result", "result", "tool_result", "nested", "private"]) {
      await open(`settings-${wrapper}`);
      await run(waitForSettings + "await page.locator('#save').click();await page.waitForFunction(()=>window.__cardCalls.some(call=>call.name==='codex_update_settings')&&!document.querySelector('#save').disabled);");
      const state = await evaluate("()=>({error:document.querySelector('#status').classList.contains('error'),count:window.__cardCalls.length})");
      assert.equal(state.error, false, `${wrapper}: save failed`);
      assert.equal(state.count, 2, `${wrapper}: unexpected tool call`);
      await record(`settings-${wrapper}`);
    }
    await open("settings-initial-failure");
    await run("await page.locator('#retry-load').waitFor({state:'visible'});");
    assert.match(await evaluate("()=>document.querySelector('#settings-loading').textContent"), /SNAPSHOT_UNAVAILABLE/);
    await run("await page.evaluate(()=>{document.querySelector('#retry-load').click();document.querySelector('#retry-load').click()});" + waitForSettings);
    assert.equal(await evaluate("()=>window.__cardCalls.length"), 2, "initial retry was dispatched more than once");
    await record("settings-initial-failure");

    await open("settings-locale");
    await run(waitForSettings + `
      await page.locator('#concurrency').fill('3');await page.locator('#access-strategy').selectOption('adaptive');
      await page.locator('#use-priority-service-tier').check();await page.locator('#show-bridge-threads-in-codex-app').uncheck();
      await page.locator('#model-policy-mode').selectOption('automatic');await page.locator('#allowed-scope').selectOption('explicit');
      await page.locator('input[data-effort="high"]').check();await page.locator('#add-project').click();
      await page.locator('.project-label-input').fill('Unsaved project');await page.locator('.project-cwd-input').fill('/tmp/unsaved-project');
      await page.evaluate(()=>{window.__draftFocus=document.activeElement;window.dispatchEvent(new MessageEvent('message',{source:window.parent,data:{jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{locale:'en-US'}}}))});
    `);
    assert.equal(await evaluate("()=>document.activeElement===window.__draftFocus"), true, "host locale lost project focus");
    assert.equal(await evaluate("()=>document.querySelector('#access-strategy option:checked').textContent"), "GPT chooses per task");
    await run(`await page.locator('input[data-effort="high"]').focus();await page.evaluate(()=>{window.__draftFocus=document.activeElement;window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{locale:'ja-JP'}}}))});`);
    assert.equal(await evaluate("()=>document.activeElement===window.__draftFocus"), true, "host locale replaced model controls");
    const draft = await evaluate("()=>({concurrency:document.querySelector('#concurrency').value,project:document.querySelector('.project-label-input')?.value,cwd:document.querySelector('.project-cwd-input')?.value,high:document.querySelector('input[data-effort=high]').checked,locale:document.documentElement.lang})");
    assert.deepEqual(draft, { concurrency: "3", project: "Unsaved project", cwd: "/tmp/unsaved-project", high: true, locale: "ja-JP" });
    await run("await page.locator('#save').click();await page.waitForFunction(()=>window.__cardCalls.some(call=>call.name==='codex_update_settings'));");
    const patch = await evaluate("()=>window.__cardCalls.find(call=>call.name==='codex_update_settings').args.operation.settings");
    assert.equal(patch.maxConcurrentJobs, 3);
    assert.equal(patch.accessStrategy, "adaptive");
    assert.equal(patch.usePriorityServiceTier, true);
    assert.equal(patch.showBridgeThreadsInCodexApp, false);
    assert.equal(patch.modelPolicy.mode, "automatic");
    assert(patch.modelPolicy.allowedSelections.selections.some((selection: any) => selection.reasoningEffort === "high"), "locale discarded dirty model policy");
    assert.equal(patch.projectOperations[0].project.name, "Unsaved project");
    await record("settings-locale");
  }

  if (!group || group === "activity") {
    await open("activity-errors");
    await run("await page.locator('.activity-agent .danger').first().waitFor({state:'visible'});");
    const before = await evaluate("()=>window.__cardCalls.filter(call=>call.name==='codex_activity_snapshot').length");
    for (const action of ["force", "answer", "background"]) {
      const selector = action === "answer" ? ".interaction button" : ".activity-agent .danger";
      const index = action === "background" ? 1 : 0;
      await run((action === "answer" ? "await page.locator('.interaction input').fill('answer');" : "") + `await page.locator(${JSON.stringify(selector)}).nth(${index}).click();await page.waitForFunction(()=>document.querySelector('#message').classList.contains('error'));`);
      const result = await evaluate("()=>({message:document.querySelector('#message').textContent,reads:window.__cardCalls.filter(call=>call.name==='codex_activity_snapshot').length})");
      assert.match(result.message, /JOB_VERSION_CHANGED/, `${action}: mutation error was hidden`);
      assert.equal(result.reads, before, `${action}: rejected mutation entered success refresh`);
      await run(`if(await page.locator(${JSON.stringify(selector)}).nth(${index}).isDisabled())throw new Error('control remained disabled');`);
      await record(`activity-${action}-error`);
    }
  }

  if (!group || group === "dashboard") {
    for (const outcome of ["old-first", "new-first", "old-error", "page", "visibility"]) {
      await open("dashboard-deferred");
      await run(waitForRead(1));
      let oldIndex = 0, newIndex = 1;
      if (outcome === "page") {
        await run("await page.evaluate(()=>window.__reads[0].resolve('Initial page'));await page.waitForFunction(()=>window.__enrichments.length===1);await page.locator('#terminal-more').click();" + waitForRead(2));
        oldIndex = 1; newIndex = 2;
      }
      await run(`await page.evaluate(()=>{window.__nowOffset=31000;${outcome === "visibility"
        ? "Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));"
        : "window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));"}});` + waitForRead(newIndex + 1));
      if (outcome === "new-first") {
        await run(`await page.evaluate(()=>window.__reads[${newIndex}].resolve('Fresh after return'));await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);`);
      }
      await run(`await page.evaluate(()=>window.__reads[${oldIndex}].${outcome === "old-error" ? "reject(new Error('Old request failed'))" : "resolve('STALE BEFORE LEAVE')"});`);
      if (outcome !== "new-first") {
        assert.equal(await evaluate("()=>document.querySelector('#refresh').disabled"), true, `${outcome}: stale completion cleared fresh request busy state`);
        await run(`await page.evaluate(()=>window.__reads[${newIndex}].resolve('Fresh after return'));await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);`);
      }
      if (outcome === "page") await run("await page.waitForFunction(()=>window.__enrichments.length===2);");
      // Late enrichment from before suspension must also remain obsolete.
      await run("await page.evaluate(()=>{for(const request of window.__enrichments.slice(0,-1))request.resolve('STALE ENRICHMENT')});");
      const state = await evaluate("()=>({text:document.body.innerText,busy:document.querySelector('#refresh').disabled})");
      assert(state.text.includes("Fresh after return"), `${outcome}: fresh state missing`);
      assert(!state.text.includes("STALE"), `${outcome}: obsolete response rendered`);
      assert.equal(state.busy, false);
      await record(`dashboard-${outcome}`);
    }
    for (const lifecycle of ["pageshow", "visibility", "online"]) {
      await open("dashboard-deferred");
      await run(waitForRead(1) + "await page.evaluate(()=>window.__reads[0].resolve('Last successful overview'));await page.waitForFunction(()=>window.__enrichments.length===1);");
      const updated = await evaluate("()=>document.querySelector('#updated').textContent");
      await run(`await page.evaluate(()=>{window.__nowOffset=31000;${lifecycle === "pageshow"
        ? "window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));"
        : lifecycle === "online" ? "window.dispatchEvent(new Event('online'));"
        : "Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));"}});` + waitForRead(2));
      assert.equal(await evaluate("()=>document.querySelector('#dashboard-content').hidden"), false, `${lifecycle}: hid last successful snapshot during refresh`);
      await run("await page.evaluate(()=>window.__reads[1].reject(new Error('Transport unavailable')));await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);");
      let state = await evaluate("()=>({hidden:document.querySelector('#dashboard-content').hidden,text:document.body.innerText,message:document.querySelector('#message').textContent,updated:document.querySelector('#updated').textContent})");
      assert.equal(state.hidden, false, `${lifecycle}: lost last successful snapshot on failure`);
      assert(state.text.includes("Last successful overview"), `${lifecycle}: missing retained rows`);
      assert.match(state.message, /마지막으로 불러온 현황/);
      assert.equal(state.updated, updated, `${lifecycle}: replaced last successful timestamp`);
      await run("await page.evaluate(()=>window.__enrichments[0].resolve('OBSOLETE ENRICHMENT'));await page.locator('#refresh').click();" + waitForRead(3));
      await run("await page.evaluate(()=>window.__reads[2].resolve('Recovered in the same card'));await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);");
      state = await evaluate("()=>({hidden:document.querySelector('#dashboard-content').hidden,text:document.body.innerText,message:document.querySelector('#message').textContent})");
      assert.equal(state.hidden, false);
      assert(state.text.includes("Recovered in the same card"));
      assert(!state.text.includes("OBSOLETE"));
      assert(!state.message.includes("마지막으로 불러온 현황"));
      await record(`dashboard-retain-and-retry-${lifecycle}`);
    }
    await open("dashboard-deferred");
    await run(waitForRead(1) + "await page.evaluate(()=>window.__reads[0].reject(new Error('Transport unavailable')));await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);");
    assert.match(await evaluate("()=>document.querySelector('#message').textContent"), /새로고침을 눌러 다시 시도/);
    await run("await page.locator('#refresh').click();" + waitForRead(2) + "await page.evaluate(()=>window.__reads[1].resolve('Recovered cold card'));await page.waitForFunction(()=>!document.querySelector('#dashboard-content').hidden);");
    await record("dashboard-cold-retry");
  }

  if (!group || group === "retained") {
    for (const name of Object.keys(fixtures).filter((name) => name.startsWith("retained-"))) {
      await open(name);
      if (name.startsWith("retained-settings")) {
        await run("await page.waitForFunction(()=>document.querySelector('#settings-loading.error, #status.error'));");
        assert.match(await evaluate("()=>document.querySelector('#settings-loading.error, #status.error').textContent"), /SNAPSHOT_UNAVAILABLE/);
      } else {
        await run("await page.waitForFunction(()=>document.body.innerText.includes('Second Test Agent'));");
      }
      await record(name);
    }
  }

  if (!group || group === "standard") {
    for (const lifecycle of ["page", "visibility"]) {
      // Keep navigation and the remount in one CLI call so its process startup
      // cannot consume the real five-second initialization deadline.
      await run(`
        await page.goto(${JSON.stringify(origin + "/dashboard-standard-init")});
        await page.waitForFunction(()=>window.__initializations.length>=1);
        const before=await page.evaluate(()=>window.__initializations.length);
        await page.evaluate(()=>{const widget=document.querySelector('#dashboard-card').contentWindow;${lifecycle === "page"
          ? "widget.dispatchEvent(new Event('pagehide'));widget.dispatchEvent(new Event('pageshow'));"
          : "Object.defineProperty(widget.document,'visibilityState',{configurable:true,value:'visible'});widget.document.dispatchEvent(new Event('visibilitychange'));"}});
        await page.waitForFunction(count=>window.__initializations.length>count,before);
        await page.evaluate(()=>window.__replyInitialization());
        await page.waitForFunction(()=>!document.querySelector('#dashboard-card').contentDocument.querySelector('#dashboard-content').hidden);
      `);
      await cli("snapshot");
      assert.equal(await evaluate("()=>document.querySelector('#dashboard-card').contentDocument.documentElement.dataset.mcpApps"), "initialized");
      await record(`dashboard-standard-init-${lifecycle}`);
    }
  }

  if (!group || group === "timeout") {
    // Virtual time makes the 90-second timeout deterministic without a real wait.
    await installClock();
    for (const mutation of [false, true]) {
      await open(mutation ? "settings-mutation-timeout" : "settings-timeout");
      if (mutation) await run(waitForSettings + "await page.locator('#save').click();");
      await run("await page.clock.fastForward(90001);");
      if (mutation) {
        const state = await evaluate("()=>({error:document.querySelector('#status').classList.contains('error'),busy:document.querySelector('#save').disabled,mutations:window.__cardCalls.filter(call=>call.name==='codex_update_settings').length,standard:window.__hostCalls.length})");
        assert.deepEqual(state, { error: true, busy: false, mutations: 1, standard: 0 });
      } else {
        await run("await page.locator('#retry-load').waitFor({state:'visible'});await page.evaluate(()=>{window.openai.callTool=window.__healthyCall});await page.locator('#retry-load').click();" + waitForSettings);
        assert.equal(await evaluate("()=>window.__cardCalls.length"), 2);
        await run("await page.evaluate(()=>window.__lateSettings({isError:true,content:[{type:'text',text:'LATE_FAILURE'}]}));");
        assert.equal(await evaluate("()=>document.querySelector('#settings-loading').hidden"), true);
      }
      await record(mutation ? "settings-mutation-timeout" : "settings-timeout");
      await run("await page.clock.resume();");
    }
  }

  process.stdout.write(`Card resilience browser regression passed (${Object.keys(report).length} scenarios, ${directory}).\n`);
} catch (error) {
  const failure = await evaluate("()=>({errors:window.__cardErrors,text:document.body.innerText,initializations:window.__initializations,hostCalls:window.__hostCalls,calls:window.__cardCalls})").catch(() => null);
  report.failure = failure;
  process.stderr.write(JSON.stringify(failure, null, 2) + "\n");
  throw error;
} finally {
  writeFileSync(path.join(artifactDir, group ? `report-${group}.json` : "report.json"), JSON.stringify(report, null, 2) + "\n");
  try { await cli("close"); } catch { /* Preserve the original assertion. */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
