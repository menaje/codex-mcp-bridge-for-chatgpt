import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { BackendAwareModelCatalog } from "../src/modelCatalog.js";
import { MODEL_DESCRIPTION_TRANSLATIONS } from "../src/modelDescriptionI18n.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { cardPrelude } from "./card-browser-fixtures.js";

// The browser talks to the real settings store and MCP tools. Only Codex's
// upstream catalog is simulated; no authenticated model turn or live setting is used.
const output = path.resolve("output/playwright/model-descriptions");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), "model-description-browser-"));
const state = new BridgeStateStore({ file: path.join(temporary, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: temporary });
const settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ uiLocalePreference: "ko" }, 0);
settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Settings preview", cwd: temporary } }], undefined, 0);
let now = Date.now(), officialVersion = 1, hideAstra = false, catalogRequests = 0;
const catalog = new BackendAwareModelCatalog("app-server", {
  async getCatalog() { throw new Error("No CLI fallback in this fixture"); }
}, async () => {
  catalogRequests += 1;
  return { data: [
    { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: officialVersion === 1 ? "Our most capable model for complex, demanding work." : "Updated official Astra description.", hidden: hideAstra },
    { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", description: "Fast and affordable agentic coding model.", hidden: false }
  ].map(model => ({ ...model, isDefault: model.model === "gpt-6-astra", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast responses with lighter reasoning" }, { reasoningEffort: "medium", description: "Balances speed and reasoning depth" }], serviceTiers: [] })) };
}, 600_000, () => now);
const bridge = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("Model execution is outside this regression"); },
  async close() {}
}, undefined, undefined, catalog, settings);
const client = new Client({ name: "model-description-browser", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      if (url.pathname === "/tool") result = await client.callTool({ name: body.name, arguments: body.args });
      else if (url.pathname === "/scenario") {
        if (body.officialVersion) officialVersion = body.officialVersion;
        if (body.advanceMs) now += body.advanceMs;
        if (typeof body.hideAstra === "boolean") hideAstra = body.hideAstra;
        if (body.overrides) settings.update({ modelDescriptionOverrides: body.overrides }, settings.current.settingsRevision);
        result = { catalogRequests };
      } else throw new Error("Unknown fixture route");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    const prelude = cardPrelude("settings") + `<script>
      window.__descriptionCalls=[];
      window.openai.callTool=async(name,args)=>{
        window.__descriptionCalls.push({name,args:structuredClone(args)});
        return await (await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})})).json();
      };
    </script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(SETTINGS_CARD_HTML.replace("</head>", () => prelude + "</head>"));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const session = `model-descriptions-${process.pid}`;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], {
    encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1024 * 1024
  });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await cli("open", origin);
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  const result = await cli("run-code", `async page => {
    const check=(value,message)=>{if(!value)throw new Error(message)};
    const tool=async(name,args={})=>page.evaluate(async({name,args})=>await window.openai.callTool(name,args),{name,args});
    const scenario=async(value)=>page.evaluate(async value=>await(await fetch('/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)})).json(),value);
    const row=page.locator('.model-description-row[data-model="gpt-6-astra"]');
    const action=(name)=>row.locator('[data-description-action="'+name+'"]');
    const official='Our most capable model for complex, demanding work.';
    await page.locator('#settings-form').waitFor({state:'visible'});
    await page.setViewportSize({width:720,height:1050});
    check((await row.locator('.model-description-text').first().textContent())===official,'Show official text before editing');
    await action('edit').click();
    check(await row.locator('textarea').inputValue()===official,'Prefill the official description');
    await action('cancel').click();
    check(await page.evaluate(()=>window.__descriptionCalls.filter(x=>x.name==='codex_update_settings').length)===0,'Cancel must not save');
    await action('edit').click();
    await action('save').click();
    check(await page.evaluate(()=>window.__descriptionCalls.filter(x=>x.name==='codex_update_settings').length)===0,'Untouched official text must not become an override');
    const custom='범위가 넓고 설계 판단이 필요한 작업에 사용합니다.\\n<script>window.__descriptionInjected=true</script>';
    await page.locator('#concurrency').fill('7');
    await action('edit').click();
    await row.locator('textarea').fill(custom);
    await action('save').click();
    await row.locator('[data-description-source="user"]').waitFor();
    check(await page.locator('#concurrency').inputValue()==='7','Description save must preserve unrelated unsaved fields');
    check(await page.evaluate(()=>window.__descriptionInjected===undefined),'User text must not execute');
    let listed=(await tool('codex_models',{contractVersion:'2'})).structuredContent;
    check(listed.models.find(x=>x.id==='gpt-6-astra').description===custom,'Real MCP result uses custom text');
    check(listed.models.find(x=>x.id==='gpt-6-astra').descriptionSource==='user','Mark user source');
    const stored=(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    check(stored.settings.maxConcurrentJobs===30,'Description-only patch must not save unrelated fields');
    check(stored.catalog.models.find(x=>x.id==='gpt-6-astra').description===official,'Catalog still contains official text');
    await row.locator('summary').click();
    check((await row.locator('details p').textContent())===official,'Compare official text');
    await page.locator('#save').click();
    await page.waitForFunction(()=>!document.querySelector('#save').disabled);
    check((await tool('codex_ui_read',{view:'settings'})).structuredContent.settings.maxConcurrentJobs===7,'General save after description save uses current revision');
    await page.reload();
    await row.locator('[data-description-source="user"]').waitFor();
    check((await row.locator('.model-description-text').first().textContent())===custom,'Reload preserves override');
    await scenario({officialVersion:2});
    let current=(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    check(current.catalog.models.find(x=>x.id==='gpt-6-astra').description===official,'Existing cache is unchanged');
    await scenario({advanceMs:600001});
    await page.reload();
    await row.locator('[data-description-source="user"]').waitFor();
    await row.locator('summary').click();
    check((await row.locator('details p').textContent())==='Updated official Astra description.','Official comparison follows existing cache expiry');
    check((await row.locator('.model-description-text').first().textContent())===custom,'Official refresh preserves custom text');
    await action('edit').click();
    await row.locator('textarea').fill('취소할 편집');
    await page.locator('#ui-language').selectOption('en');
    check(await row.locator('textarea').inputValue()==='취소할 편집','Locale change preserves editor text');
    await action('cancel').click();
    await action('restore').click();
    await row.locator('[data-description-source="catalog"]').waitFor();
    check((await row.locator('.model-description-text').first().textContent())==='Updated official Astra description.','Restore uses refreshed official text');
    await action('edit').click();
    await row.locator('textarea').fill('Keep this draft after a conflict.');
    await scenario({overrides:{'gpt-6-astra':'Saved in another settings window.','missing-model':'Preserve this saved model.'}});
    await action('save').click();
    await row.locator('.model-description-error').waitFor();
    check(await row.locator('textarea').inputValue()==='Keep this draft after a conflict.','Conflict must retain input');
    check((await row.locator('.model-description-text').first().textContent())==='Saved in another settings window.','Show conflicting saved text before retry');
    await action('save').click();
    await row.locator('textarea').waitFor({state:'detached'});
    current=(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    check(current.settings.modelDescriptionOverrides['missing-model']==='Preserve this saved model.','Retry preserves descriptions saved elsewhere');
    check(current.settings.modelDescriptionOverrides['gpt-6-astra']==='Keep this draft after a conflict.','Explicit retry saves reviewed text');
    await page.reload();
    await row.locator('[data-description-source="user"]').waitFor();
    await page.locator('#model-policy-mode').selectOption('fixed');
    await page.locator('#save').click();
    await page.waitForFunction(()=>!document.querySelector('#save').disabled);
    listed=(await tool('codex_models',{contractVersion:'2'})).structuredContent;
    const fixed=listed.models.find(x=>x.id==='gpt-6-astra');
    if(fixed)check(!fixed.descriptionSource&&fixed.description==='Updated official Astra description.','Fixed mode uses official text');
    await page.locator('#model-policy-mode').selectOption('automatic');
    await page.locator('#save').click();
    await page.waitForFunction(()=>!document.querySelector('#save').disabled);
    check((await tool('codex_models')).structuredContent.models.find(x=>x.id==='gpt-6-astra').description==='Keep this draft after a conflict.','Returning to automatic restores override');
    await scenario({hideAstra:true,advanceMs:600001});
    await page.reload();
    await row.locator('[data-description-source="user"]').waitFor();
    check(!(await tool('codex_models')).structuredContent.models.some(x=>x.id==='gpt-6-astra'),'Description must not make an unavailable model executable');
    check((await tool('codex_ui_read',{view:'settings'})).structuredContent.settings.modelDescriptionOverrides['gpt-6-astra'],'Keep description while model is absent');
    await scenario({hideAstra:false,advanceMs:600001});
    await page.reload();
    await row.locator('[data-description-source="user"]').waitFor();
    await action('edit').click();
    await row.locator('textarea').fill(' \\n\\t');
    await action('save').click();
    await row.locator('[data-description-source="catalog"]').waitFor();
    check(!(await tool('codex_ui_read',{view:'settings'})).structuredContent.settings.modelDescriptionOverrides['gpt-6-astra'],'Blank removes override');
    await action('edit').click();
    await row.locator('textarea').fill('여러 구성요소의 설계 판단이 필요한 작업에 사용합니다. 단순 조회나 정해진 수정은 다른 모델을 먼저 검토합니다.');
    await action('save').click();
    await row.locator('[data-description-source="user"]').waitFor();
    const bundles=${JSON.stringify(MODEL_DESCRIPTION_TRANSLATIONS)},locales=[];
    for(const [locale,copy] of Object.entries(bundles)){
      await page.locator('#ui-language').selectOption(locale);
      check(await page.locator('#model-descriptions-title').textContent()===copy['settings.modelDescriptions.title'],'Translated title: '+locale);
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'No horizontal overflow: '+locale);
      locales.push(locale);
    }
    await page.locator('#ui-language').selectOption('ko');
    await page.locator('.model-descriptions-panel').screenshot({path:${JSON.stringify(path.join(output, "settings-model-descriptions-ko.png"))}});
    await action('edit').click();
    await page.locator('.model-descriptions-panel').screenshot({path:${JSON.stringify(path.join(output, "settings-model-description-editor-ko.png"))}});
    await page.setViewportSize({width:390,height:1000});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'No mobile overflow');
    await page.locator('.model-descriptions-panel').screenshot({path:${JSON.stringify(path.join(output, "settings-model-descriptions-mobile-ko.png"))}});
    check((await page.evaluate(()=>window.__cardErrors)).length===0,'No page errors');
    return {realMcp:true,officialAndCustom:true,unchangedNoOverride:true,cancel:true,restore:true,blank:true,cacheExpiryUnchanged:true,conflictRetainsDraft:true,modeSwitch:true,unavailableModelRetained:true,plainText:true,locales};
  }`);
  writeFileSync(path.join(output, "report.txt"), result);
  console.log(result);
} catch (error) {
  writeFileSync(path.join(output, "failure.snapshot.txt"), await cli("snapshot").catch(String));
  await cli("run-code", `async page=>page.screenshot({path:${JSON.stringify(path.join(output, "failure.png"))},fullPage:true})`).catch(() => undefined);
  throw error;
} finally {
  await cli("close").catch(() => undefined);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await client.close();
  await bridge.close();
  state.close();
  rmSync(temporary, { recursive: true, force: true });
}
