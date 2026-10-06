import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { BackendAwareModelCatalog } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { cardPrelude } from "./card-browser-fixtures.js";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";
import { UI_TRANSLATIONS } from "../src/uiI18n.js";

// Real Settings persistence and discovery, with an isolated simulated upstream catalog.
const output = path.resolve("output/playwright/model-selection");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), "model-selection-browser-"));
const state = new BridgeStateStore({ file: path.join(temporary, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: temporary });
const settings = new UserSettingsStore(config, { stateStore: state });
const initial = [{ model: "gpt-6.1-sol", reasoningEffort: "high" }, { model: "gpt-6-luna", reasoningEffort: "low" }];
settings.update({ uiLocalePreference: "ko", modelPolicy: { mode: "automatic", allowedSelections: { kind: "explicit", selections: initial },
  constraints: { allowDelegation: true } }, modelDescriptionOverrides: { "retired-model": "Retained guidance" } }, 0);
const catalog = new BackendAwareModelCatalog("app-server", { async getCatalog() { throw new Error("No fallback"); } }, async () => ({
  data: ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol", "ultra-only", "rare-only"].map((model, index) => ({
    id: model, model, displayName: model.toUpperCase(), description: "Official model description.", hidden: false, isDefault: index === 0,
    defaultReasoningEffort: index === 4 ? "minimal" : index === 3 ? "ultra" : "high", supportedReasoningEfforts: (index === 4 ? ["minimal"] : index === 3 ? ["ultra"] : index === 0 ? ["low", "high", "ultra"] : ["low", "high"]).map(reasoningEffort => ({ reasoningEffort })), serviceTiers: []
  }))
}));
const bridge = createBridgeMcpServer(config, { async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("No model execution"); }, async close() {} }, undefined, undefined, catalog, settings);
const connection = await connectCurrentMcpServer(bridge, { name: "model-selection-browser", version: "1" });
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await connection.client.callTool({ name: body.name, arguments: body.args });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result)); return;
    }
    const prelude = cardPrelude("settings") + `<script>
      window.__selectionSaves=[];
      window.openai.callTool=async(name,args)=>{
        if(name==='codex_update_settings')window.__selectionSaves.push(structuredClone(args));
        const result=await(await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})})).json();
        if(name==='codex_ui_read'&&new URL(location.href).searchParams.has('empty')){
          result.structuredContent.catalog.models=[];
          if(result._meta&&result._meta['codex/settingsView'])result._meta['codex/settingsView'].catalog.models=[];
        }
        return result;
      };
    </script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(SETTINGS_CARD_HTML.replace("</head>", () => prelude + "</head>"));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`, session = `model-selection-${process.pid}`;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], {
    encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1024 * 1024
  }).catch(error => { throw new Error(error.stdout || error.message); });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await cli("open", origin);
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  const result = await cli("run-code", `async page => {
    const check=(value,message)=>{if(!value)throw new Error(message)};
    const tool=async(name,args={})=>page.evaluate(async({name,args})=>(await window.openai.callTool(name,args)).structuredContent,{name,args});
    const read=()=>tool('codex_ui_read',{view:'settings'});
    const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>!document.querySelector('#save').disabled);};
    const common=effort=>page.locator('#common-efforts input[data-effort="'+effort+'"]');
    const model=id=>page.locator('#allowed-models input[data-model="'+id+'"]');
    const ids=()=>page.locator('.model-description-row').evaluateAll(rows=>rows.map(row=>row.dataset.model));
    const policy=()=>read().then(view=>view.settings.modelPolicy);
    const pairs=async()=>JSON.stringify((await policy()).allowedSelections.selections.map(c=>c.model+'/'+c.reasoningEffort).sort());
    await page.goto(${JSON.stringify(origin + '/?empty=1')});
    await page.locator('#settings-form').waitFor({state:'visible'});
    await page.locator('#concurrency').fill('5');await save();
    check(!await page.evaluate(()=>window.__selectionSaves[0].operation.settings.modelPolicy),'An empty catalog must not rewrite policy while saving unrelated preferences');
    await page.goto(${JSON.stringify(origin)});
    await page.locator('#settings-form').waitFor({state:'visible'});
    check(await common('high').isChecked()&&await common('low').isChecked(),'Old per-model efforts become one checked common list');
    check(await page.locator('#model-specific-settings').count()===0,'Per-model controls are removed');
    check(await page.locator('#common-efforts input').evaluateAll(inputs=>inputs.every(input=>!input.indeterminate)),'No partial selection state remains');
    check(await common('minimal').count()===0,'An effort supported only by an unselected model is hidden');
    check(JSON.stringify(await ids())===JSON.stringify(['gpt-6.1-sol','gpt-6-luna']),'Default descriptions are allowed models in catalog order');
    await page.locator('#show-all-model-descriptions').check();
    check(JSON.stringify(await ids())===JSON.stringify(['gpt-6.1-sol','gpt-6-luna','gpt-5.6-sol','ultra-only','rare-only','retired-model']),'Full descriptions retain catalog order');
    await page.locator('#show-all-model-descriptions').uncheck();
    check((await policy()).allowedSelections.selections.length===2,'Reading the card does not silently write settings');
    await page.locator('#concurrency').fill('5');await save();
    check((await policy()).allowedSelections.selections.length===4,'Saving converts old model-specific choices to supported common pairs');
    await common('low').uncheck();await model('gpt-6-luna').uncheck();await model('gpt-5.6-sol').check();await model('gpt-6-luna').check();
    check(!await common('low').isChecked(),'Re-selecting a model must not restore its old per-model effort');
    await save();
    check(await pairs()===JSON.stringify(['gpt-5.6-sol/high','gpt-6-luna/high','gpt-6.1-sol/high'].sort()),'Common reasoning applies after model changes');
    await common('ultra').check();await save();
    const exclusions=()=>page.locator('#unsupported-model-efforts');
    check((await exclusions().textContent()).includes('GPT-6-LUNA 모델은 Ultra 추론을 지원하지 않아 적용되지 않습니다.'),'Luna Ultra exclusion is explained');
    const models=(await tool('codex_models')).models;
    check(models.find(model=>model.id==='gpt-6-luna').efforts.every(effort=>effort.id!=='ultra'),'Unsupported Luna Ultra is absent from execution choices');
    check(models.find(model=>model.id==='gpt-6.1-sol').efforts.some(effort=>effort.id==='ultra'),'Supported Ultra remains executable');
    await model('gpt-6.1-sol').uncheck();
    check(await common('ultra').count()===0,'Ultra disappears when no selected model supports it');
    check(await exclusions().isHidden(),'A hidden unsupported effort is removed from the common selection');
    await model('gpt-6.1-sol').check();check(!await common('ultra').isChecked(),'Hidden effort does not return as a per-model saved exception');
    await common('ultra').check();await page.locator('#allow-delegation').uncheck();await save();
    check((await policy()).allowedSelections.selections.length===4,'The separate Ultra eligibility gate retains supported saved choices');
    check((await tool('codex_models')).models.every(model=>model.efforts.every(effort=>effort.id!=='ultra')),'Ultra gate excludes Ultra from execution');
    check(await common('ultra').isChecked()&&await common('ultra').isDisabled(),'Saved gated Ultra is checked and inactive');
    check((await page.locator('#selection-count').textContent()).includes('조합 3개'),'Summary counts executable pairs');
    await page.locator('#allow-delegation').check();await common('ultra').uncheck();await model('ultra-only').check();
    check(await page.locator('#model-effort-warning').isVisible(),'A model with no supported selected effort explains how to resolve it');
    const before=await page.evaluate(()=>window.__selectionSaves.length);await save();
    check(await page.evaluate(()=>window.__selectionSaves.length)===before,'A policy omitting a selected model is not posted');
    await page.locator('#allow-delegation').uncheck();
    check(await model('ultra-only').isVisible(),'Inactive selected models stay removable');
    await model('ultra-only').click();await page.locator('#allow-delegation').check();
    await model('rare-only').check();check(await common('minimal').isVisible(),'Selecting a supporting model exposes its effort');
    await common('minimal').check();await save();
    check((await policy()).allowedSelections.selections.some(choice=>choice.model==='rare-only'&&choice.reasoningEffort==='minimal'),'New effort projects only onto its supporting model');
    await model('rare-only').uncheck();check(await common('minimal').count()===0,'Removing its last supporting model hides the effort again');
    await common('ultra').check();await save();await page.reload();await page.locator('#settings-form').waitFor({state:'visible'});
    check(await common('high').isChecked()&&await common('ultra').isChecked(),'Reload retains common reasoning choices');
    await page.locator('#model-policy-mode').selectOption('fixed');await page.locator('#model-policy-mode').selectOption('automatic');
    check(await common('high').isEnabled(),'Returning to automatic mode re-enables common controls');
    await page.locator('.model-description-row[data-model="gpt-6-luna"] [data-description-action="edit"]').click();
    await page.locator('.model-description-row[data-model="gpt-6-luna"] textarea').fill('Keep this pending description.');
    await model('gpt-6-luna').uncheck();
    check(await page.locator('.model-description-row[data-model="gpt-6-luna"] textarea').inputValue()==='Keep this pending description.','Filtering must retain an open description edit');
    await page.locator('.model-description-row[data-model="gpt-6-luna"] [data-description-action="cancel"]').click();
    check(!(await ids()).includes('gpt-6-luna'),'Non-allowed description hides after edit ends');
    await model('gpt-6-luna').check();
    const locales=[];
    for(const [locale,copy] of Object.entries(${JSON.stringify(UI_TRANSLATIONS)})){
      await page.setViewportSize({width:390,height:980});await page.locator('#ui-language').selectOption(locale);
      check((await page.locator('[data-i18n="settings.commonEfforts"]').textContent())===copy['settings.commonEfforts'],'Common controls translate: '+locale);
      const notice=copy['settings.unsupportedModelEfforts'].replace('{model}','GPT-6-LUNA').replace('{efforts}','Ultra');
      check((await page.locator('#unsupported-model-efforts').textContent()).includes(notice),'Unsupported notice translates: '+locale);
      const state=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,errors:window.__cardErrors}));
      check(!state.overflow&&!state.errors.length,'Card fits narrow view without script errors: '+locale);locales.push(locale);
    }
    await page.locator('#ui-language').selectOption('ko');await page.setViewportSize({width:720,height:1050});
    await page.locator('#automatic-policy-panel').screenshot({path:${JSON.stringify(path.join(output, "model-selection-ko.png"))}});
    return {legacyCommonConversion:true,emptyCatalogPolicyPreserved:true,supportedProjection:true,noPerModelExceptions:true,unsupportedEffortsHidden:true,unsupportedNotice:true,pendingModelRemovable:true,ultraGatePreserved:true,emptyModelBlocked:true,descriptionOrder:true,descriptionFilter:true,openEditPreserved:true,locales};
  }`);
  writeFileSync(path.join(output, "report.txt"), result); console.log(result);
} catch (error) {
  writeFileSync(path.join(output, "failure.snapshot.txt"), await cli("snapshot").catch(String));
  await cli("run-code", `async page=>page.screenshot({path:${JSON.stringify(path.join(output, "failure.png"))},fullPage:true})`).catch(() => undefined);
  throw error;
} finally {
  await cli("close").catch(() => undefined); await connection.close(); state.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
