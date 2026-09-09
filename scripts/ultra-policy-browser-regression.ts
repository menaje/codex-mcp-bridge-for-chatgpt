import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { ULTRA_POLICY_TRANSLATIONS } from "../src/ultraPolicyI18n.js";
import { cardPrelude } from "./card-browser-fixtures.js";

const output = path.resolve("output/playwright/ultra-policy");
mkdirSync(output, { recursive: true });
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const locale = url.searchParams.get("locale") || "ko";
  const fixed = url.searchParams.get("mode") === "fixed";
  const prelude = cardPrelude("settings") + `<script>
    const originalCall=window.openai.callTool;
    let current=null;
    window.__ultraSaves=[];
    window.openai.callTool=async(name,args)=>{
      if(!current){
        current=structuredClone((await originalCall(name,args)).structuredContent);
        current.settings.uiLocalePreference=${JSON.stringify(locale)};
        current.capabilities.availableUiLocalePreferences=${JSON.stringify(["auto", ...Object.keys(ULTRA_POLICY_TRANSLATIONS)])};
        current.catalog.models[0].defaultReasoningEffort="max";
        current.catalog.models[0].supportedReasoningEfforts=[{effort:"max"},{effort:"ultra"}];
        const ultra={model:"gpt-5.6-sol",reasoningEffort:"ultra"};
        current.settings.modelPolicy=${fixed
          ? '{mode:"fixed",selection:ultra,constraints:{allowDelegation:true}}'
          : '{mode:"automatic",allowedSelections:{kind:"explicit",selections:[{...ultra,reasoningEffort:"max"},ultra]},constraints:{allowDelegation:true}}'};
      }
      if(name==="codex_update_settings"){
        if(args.expectedSettingsRevision!==current.settings.settingsRevision)throw new Error("Stale settings revision");
        window.__ultraSaves.push(structuredClone(args));
        Object.assign(current.settings,args.operation.settings);
        current.settings.settingsRevision++;
      }
      return{structuredContent:structuredClone(current)};
    };
  </script>`;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(SETTINGS_CARD_HTML.replace("</head>", () => prelude + "</head>"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const session = `ultra-policy-${process.pid}`;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], {
    encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1024 * 1024
  });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await cli("open", `${origin}/?locale=ko`);
  await cli("run-code", "async page => { await page.locator('#settings-form').waitFor({state:'visible'}); }");
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  const result = await cli("run-code", `async page => {
    const check=(value,message)=>{if(!value)throw new Error(message)};
    await page.setViewportSize({width:390,height:980});
    const ultra=page.locator('input[data-action="effort"][data-effort="ultra"]');
    await page.locator('#allow-delegation').uncheck();
    check(await ultra.isChecked()&&await ultra.isDisabled(),'Saved Ultra must stay checked but inactive');
    check(!(await page.locator('#ultra-policy-warning').isVisible()),'Max is still executable');
    await page.locator('#save').click();
    await page.waitForFunction(()=>window.__ultraSaves.length===1);
    await page.waitForFunction(()=>!document.querySelector('#save').disabled);
    let saved=await page.evaluate(()=>window.__ultraSaves[0].operation.settings.modelPolicy);
    check(saved.constraints.allowDelegation===false&&saved.allowedSelections.selections.length===2,'OFF must preserve both choices');
    await page.locator('#allow-delegation').check();
    check(await ultra.isChecked()&&await ultra.isEnabled(),'Re-enabling must restore saved Ultra');
    await page.locator('#allow-delegation').uncheck();
    await page.locator('input[data-action="effort"][data-effort="max"]').uncheck();
    check(await page.locator('#ultra-policy-warning').isVisible(),'Suspended policy must explain empty executable choices');
    await page.locator('#save').click();
    await page.waitForFunction(()=>window.__ultraSaves.length===2);
    await page.waitForFunction(()=>!document.querySelector('#save').disabled);
    saved=await page.evaluate(()=>window.__ultraSaves[1].operation.settings.modelPolicy);
    check(saved.allowedSelections.selections.length===1&&saved.allowedSelections.selections[0].reasoningEffort==='ultra','Suspended save must not add a fallback');
    await page.screenshot({path:${JSON.stringify(path.join(output, "automatic-suspended-ko.png"))},fullPage:true});
    await page.goto(${JSON.stringify(origin + "/?locale=ko&mode=fixed")});
    await page.locator('#settings-form').waitFor({state:'visible'});
    await page.locator('#allow-delegation').uncheck();
    check(await page.locator('#policy-effort').inputValue()==='ultra','Fixed choice must not silently change');
    check(await page.locator('#ultra-policy-warning').isVisible(),'Fixed conflict must be visible');
    check(!await page.locator('#policy-effort').evaluate(element=>element.checkValidity()),'Fixed conflict must prevent submit');
    await page.locator('#save').click();
    check(await page.evaluate(()=>window.__ultraSaves.length)===0,'Invalid fixed policy must not be posted');
    await page.screenshot({path:${JSON.stringify(path.join(output, "fixed-conflict-ko.png"))},fullPage:true});
    await page.locator('#policy-effort').selectOption('max');
    check(await page.locator('#policy-effort').evaluate(element=>element.checkValidity()),'User replacement must clear the conflict');
    await page.locator('#save').click();
    await page.waitForFunction(()=>window.__ultraSaves.length===1);
    saved=await page.evaluate(()=>window.__ultraSaves[0].operation.settings.modelPolicy);
    check(saved.selection.reasoningEffort==='max'&&saved.constraints.allowDelegation===false,'Save the deliberate replacement');
    const translations=${JSON.stringify(ULTRA_POLICY_TRANSLATIONS)},locales=[];
    await page.goto(${JSON.stringify(origin + "/?locale=ko")});
    await page.locator('#settings-form').waitFor({state:'visible'});
    await page.locator('#allow-delegation').uncheck();
    await page.locator('input[data-action="effort"][data-effort="max"]').uncheck();
    for(const [locale,copy] of Object.entries(translations)){
      await page.locator('#ui-language').selectOption(locale);
      check((await page.locator('#ultra-hint').textContent()).trim()===copy['settings.ultraHint'],'Wrong hint: '+locale);
      check((await page.locator('#ultra-policy-warning').textContent()).trim()===copy['settings.ultraNoSelection'],'Wrong warning: '+locale);
      check((await ultra.locator('..').textContent()).includes(copy['settings.ultraDisabled']),'Wrong inactive label: '+locale);
      check(await ultra.isChecked()&&await ultra.isDisabled(),'Locale change lost the disabled saved choice');
      const state=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,errors:window.__cardErrors}));
      check(!state.overflow&&!state.errors.length,JSON.stringify({locale,...state}));
      if(locale==='en'||locale==='de')await page.screenshot({path:${JSON.stringify(path.join(output, "automatic-suspended-"))}+locale+'.png',fullPage:true});
      locales.push(locale);
    }
    return {automaticSaved:true,suspendedSaved:true,fixedConflictBlocked:true,fixedReplacementSaved:true,locales};
  }`);
  writeFileSync(path.join(output, "report.txt"), result);
  console.log(result);
} catch (error) {
  writeFileSync(path.join(output, "failure.snapshot.txt"), await cli("snapshot").catch(String));
  await cli("run-code", `async page => page.screenshot({path:${JSON.stringify(path.join(output, "failure.png"))},fullPage:true})`).catch(() => undefined);
  throw error;
} finally {
  await cli("close").catch(() => undefined);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
