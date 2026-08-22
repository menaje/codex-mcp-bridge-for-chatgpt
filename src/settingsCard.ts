import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializedUiTranslations } from "./uiI18n.js";

export const SETTINGS_CARD_URI = "ui://codex-mcp-bridge/settings-v6.html";
export const SETTINGS_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export function registerSettingsCardResource(server: McpServer): void {
  server.registerResource(
    "codex-settings-card",
    SETTINGS_CARD_URI,
    {
      title: "Codex Bridge Settings",
      description: "Localized interactive settings card for user-configurable Codex bridge preferences.",
      mimeType: SETTINGS_CARD_MIME_TYPE
    },
    async () => ({
      contents: [
        {
          uri: SETTINGS_CARD_URI,
          mimeType: SETTINGS_CARD_MIME_TYPE,
          text: SETTINGS_CARD_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
              domain: "https://web-sandbox.oaiusercontent.com"
            },
            "openai/widgetDescription":
              "Configure saved access, model, working-directory, session, and concurrency defaults for the MacBook Air Codex Bridge.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
            "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com"
          }
        }
      ]
    })
  );
}

export const SETTINGS_CARD_HTML = String.raw`<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Codex Bridge settings</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --surface:color-mix(in srgb,Canvas 96%,CanvasText 4%); --muted:color-mix(in srgb,CanvasText 62%,transparent); --border:color-mix(in srgb,CanvasText 16%,transparent); --accent:#1777ff; --danger:#c34132; }
    * { box-sizing:border-box; } body { margin:0; padding:12px; background:transparent; color:CanvasText; }
    .card { border:1px solid var(--border); border-radius:16px; background:var(--surface); padding:16px; }
    header { display:flex; gap:12px; justify-content:space-between; align-items:start; margin-bottom:14px; }
    h1 { font-size:18px; line-height:1.3; margin:0; } .scope,.hint { font-size:11px; line-height:1.45; color:var(--muted); font-weight:400; }
    .scope { margin:4px 0 0; font-size:12px; } .revision { font-size:11px; color:var(--muted); white-space:nowrap; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; } .wide { grid-column:1/-1; }
    label { display:grid; gap:6px; font-size:12px; font-weight:650; }
    select,input { width:100%; min-height:38px; border:1px solid var(--border); border-radius:10px; background:Canvas; color:CanvasText; padding:8px 10px; font:inherit; }
    .notice { margin-top:12px; padding:10px; border:1px solid var(--border); border-radius:10px; font-size:12px; color:var(--muted); line-height:1.45; }
    .warning { display:none; margin-top:12px; border:1px solid color-mix(in srgb,var(--danger) 45%,transparent); border-radius:10px; padding:10px; color:var(--danger); font-size:12px; line-height:1.45; white-space:pre-line; }
    .warning.show { display:block; } .actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:16px; }
    button { min-height:36px; border:1px solid var(--border); border-radius:10px; padding:7px 12px; background:Canvas; color:CanvasText; font-weight:650; cursor:pointer; }
    button.primary { border-color:var(--accent); background:var(--accent); color:white; } button:disabled { cursor:wait; opacity:.6; }
    #status { flex:1; min-width:180px; font-size:12px; color:var(--muted); text-align:right; } #status.error { color:var(--danger); }
    @media (max-width:560px) { .grid{grid-template-columns:1fr}.wide{grid-column:auto}#status{text-align:left} }
  </style>
</head>
<body>
  <main class="card">
    <header><div><h1 data-i18n="settings.title"></h1><p class="scope" data-i18n="settings.scope"></p></div><span class="revision" id="revision" data-i18n="common.loading"></span></header>
    <form id="settings-form">
      <div class="grid">
        <label class="wide"><span data-i18n="settings.access"></span><select id="access-strategy"></select><span class="hint" id="access-hint"></span></label>
        <label><span data-i18n="settings.model"></span><select id="default-model"></select><span class="hint" data-i18n="settings.modelHint"></span></label>
        <label><span data-i18n="settings.effort"></span><select id="default-effort"></select><span class="hint" data-i18n="settings.effortHint"></span></label>
        <label class="wide"><span data-i18n="settings.cwd"></span><input id="default-cwd" type="text" list="allowed-roots" autocomplete="off" spellcheck="false" /><datalist id="allowed-roots"></datalist><span class="hint" id="cwd-hint"></span></label>
        <label><span data-i18n="settings.session"></span><select id="session-mode"><option value="auto" data-i18n="settings.session.auto"></option><option value="new" data-i18n="settings.session.new"></option></select></label>
        <label><span data-i18n="settings.resume"></span><input id="resume-hours" type="number" min="0.0167" step="any" required /></label>
        <label><span data-i18n="settings.concurrency"></span><input id="concurrency" type="number" min="1" step="1" required /></label>
        <label><span data-i18n="settings.delivery"></span><select id="completion-delivery"><option value="off" data-i18n="settings.delivery.off"></option><option value="card-only" data-i18n="settings.delivery.card"></option><option value="auto-handoff" data-i18n="settings.delivery.auto"></option></select></label>
      </div>
      <div class="notice" data-i18n="settings.unlimited"></div>
      <div class="warning" id="full-warning" data-i18n="settings.fullWarning"></div>
      <div class="warning" id="catalog-warning"></div>
      <div class="actions"><button class="primary" id="save" type="submit" data-i18n="settings.save"></button><button id="refresh" type="button" data-i18n="settings.refreshModels"></button><button id="reset" type="button" data-i18n="settings.reset"></button><span id="status" role="status" aria-live="polite"></span></div>
    </form>
  </main>
  <script>
    const BUNDLES = ${serializedUiTranslations()};
    const pendingRequests = new Map();
    const REQUEST_TIMEOUT_MS = 90000;
    let nextRequestId = 1;
    let view = null;
    const initialMetadata = window.openai && window.openai.toolResponseMetadata || {};
    let localeTag = String(window.openai && window.openai.locale || initialMetadata["openai/locale"] || initialMetadata["webplus/i18n"] || navigator.language || "en");
    let locale = resolveLocale(localeTag);
    let t = BUNDLES[locale] || BUNDLES.en;
    const byId = (id) => document.getElementById(id);
    const elements = { form:byId("settings-form"),access:byId("access-strategy"),accessHint:byId("access-hint"),model:byId("default-model"),effort:byId("default-effort"),cwd:byId("default-cwd"),roots:byId("allowed-roots"),cwdHint:byId("cwd-hint"),session:byId("session-mode"),resume:byId("resume-hours"),concurrency:byId("concurrency"),delivery:byId("completion-delivery"),save:byId("save"),refresh:byId("refresh"),reset:byId("reset"),status:byId("status"),revision:byId("revision"),fullWarning:byId("full-warning"),catalogWarning:byId("catalog-warning") };
    function resolveLocale(value) { const v=String(value||"en").replaceAll("_","-").toLowerCase(); if(v==="ko"||v.startsWith("ko-"))return"ko";if(v==="ja"||v.startsWith("ja-"))return"ja";if(v==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(v))return"zh-Hant";if(v==="zh"||v==="zh-hans"||v.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(v===key||v.startsWith(key+"-"))return key;return"en"; }
    function setLocale(value) { localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;for(const node of document.querySelectorAll("[data-i18n]"))node.textContent=t[node.dataset.i18n]||BUNDLES.en[node.dataset.i18n]||node.dataset.i18n;if(view)render(view); }
    function option(value,label) { const node=document.createElement("option");node.value=value;node.textContent=label;return node; }
    function callTool(name,args) { if(window.openai&&typeof window.openai.callTool==="function")return window.openai.callTool(name,args);return new Promise((resolve,reject)=>{const id=nextRequestId++;const timer=setTimeout(()=>{pendingRequests.delete(id);reject(new Error(t["common.error"]));},REQUEST_TIMEOUT_MS);pendingRequests.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v);},reject:(e)=>{clearTimeout(timer);reject(e);}});window.parent.postMessage({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}},"*");}); }
    function unwrap(result) { if(result&&result._meta){const responseLocale=result._meta["openai/locale"]||result._meta["webplus/i18n"];if(responseLocale)setLocale(responseLocale);}if(result&&result.isError){const entry=Array.isArray(result.content)&&result.content.find((item)=>item&&item.type==="text"&&typeof item.text==="string");throw new Error(entry&&entry.text||t["common.error"]);}const next=result&&result.structuredContent||result;if(!next||!next.settings||!next.capabilities||!next.catalog)throw new Error(t["settings.invalidResponse"]);return next; }
    function modelFor(id) { return view&&view.catalog.models.find((entry)=>entry.id===id); }
    function renderEfforts(preferred) { elements.effort.replaceChildren(option("",t["settings.effortDefault"]));const model=modelFor(elements.model.value);for(const item of model&&model.supportedReasoningEfforts||[])elements.effort.appendChild(option(item.effort,item.effort+(item.description?" — "+item.description:"")));if(preferred&&!Array.from(elements.effort.options).some((entry)=>entry.value===preferred))elements.effort.appendChild(option(preferred,preferred+" ("+t["settings.savedModel"]+")"));elements.effort.value=preferred||""; }
    function updateAccessNotice() { const value=elements.access.value;const key=value==="read-only"?"settings.access.readOnlyHint":value==="always-full"?"settings.access.fullHint":"settings.access.adaptiveHint";elements.accessHint.textContent=t[key];elements.fullWarning.classList.toggle("show",value==="always-full"); }
    function render(next) { if(!next||!next.settings)return;view=next;const settings=next.settings,limits=next.capabilities;elements.access.replaceChildren();const accessLabels={"read-only":t["settings.access.readOnly"],adaptive:t["settings.access.adaptive"],"always-full":t["settings.access.full"]};for(const value of limits.availableAccessStrategies||[])elements.access.appendChild(option(value,accessLabels[value]||value));elements.access.value=settings.accessStrategy;elements.model.replaceChildren(option("",t["settings.modelDefault"]));for(const model of next.catalog.models||[])elements.model.appendChild(option(model.id,model.displayName||model.id));if(settings.defaultModel&&!Array.from(elements.model.options).some((entry)=>entry.value===settings.defaultModel))elements.model.appendChild(option(settings.defaultModel,settings.defaultModel+" ("+t["settings.savedModel"]+")"));elements.model.value=settings.defaultModel||"";renderEfforts(settings.defaultReasoningEffort||"");elements.cwd.value=settings.defaultCwd||"";elements.roots.replaceChildren();for(const root of limits.allowedRoots||[])elements.roots.appendChild(option(root,root));elements.cwdHint.textContent=t["settings.cwdHint"]+" "+(limits.allowedRoots||[]).join(", ");elements.session.value=settings.defaultSessionMode;elements.resume.value=String(settings.autoResumeTtlMs/3600000);elements.resume.min=String(limits.minAutoResumeTtlMs/3600000);elements.resume.max=String(limits.maxAutoResumeTtlMs/3600000);elements.concurrency.value=String(settings.maxConcurrentJobs);elements.concurrency.max=String(limits.maxConcurrentJobs);elements.delivery.value=settings.completionDeliveryMode||"card-only";elements.revision.textContent="revision "+settings.revision;updateAccessNotice();const warnings=[next.catalog.warning,...(next.warnings||[])].filter(Boolean).join("\n");elements.catalogWarning.textContent=warnings;elements.catalogWarning.classList.toggle("show",Boolean(warnings)); }
    function setBusy(busy,message) { for(const node of[elements.save,elements.refresh,elements.reset])node.disabled=busy;elements.status.classList.remove("error");elements.status.textContent=message||""; }
    function setError(error) { elements.status.classList.add("error");elements.status.textContent=error instanceof Error?error.message:String(error); }
    function scaledInteger(input,multiplier) { const value=Number(input.value),result=Math.round(value*multiplier);if(!Number.isFinite(value)||!Number.isSafeInteger(result))throw new Error(t["common.error"]);return result; }
    function integerValue(input) { const value=Number(input.value);if(!Number.isSafeInteger(value))throw new Error(t["common.error"]);return value; }
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.id!==undefined&&pendingRequests.has(message.id)){const pending=pendingRequests.get(message.id);pendingRequests.delete(message.id);message.error?pending.reject(new Error(message.error.message||t["common.error"])):pending.resolve(message.result);return;}if(message.method==="ui/notifications/tool-result")render(message.params&&message.params.structuredContent);},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event.detail&&event.detail.globals,metadata=globals&&globals.toolResponseMetadata;const responseLocale=metadata&&(metadata["openai/locale"]||metadata["webplus/i18n"]);if(globals&&globals.locale)setLocale(globals.locale);else if(responseLocale)setLocale(responseLocale);if(globals&&globals.toolOutput)render(globals.toolOutput);});
    window.addEventListener("pagehide",()=>{for(const [id,request] of pendingRequests){window.parent.postMessage({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:id,reason:"Settings card unmounted"}},"*");request.reject(new Error("Settings card unmounted"));}pendingRequests.clear();});
    elements.access.addEventListener("change",updateAccessNotice);
    elements.model.addEventListener("change",()=>{const saved=view&&view.settings&&view.settings.defaultModel||"";renderEfforts(elements.model.value===saved?view.settings.defaultReasoningEffort||"":"");});
    elements.form.addEventListener("submit",async(event)=>{event.preventDefault();if(!view||!elements.form.reportValidity())return;setBusy(true,t["settings.saving"]);try{const result=await callTool("codex_update_settings",{expectedRevision:view.settings.revision,accessStrategy:elements.access.value,defaultModel:elements.model.value||null,defaultReasoningEffort:elements.effort.value||null,defaultCwd:elements.cwd.value.trim()||null,defaultSessionMode:elements.session.value,autoResumeTtlMs:scaledInteger(elements.resume,3600000),maxConcurrentJobs:integerValue(elements.concurrency),completionDeliveryMode:elements.delivery.value});render(unwrap(result));setBusy(false,t["settings.saved"]);}catch(error){setBusy(false);setError(error);}});
    elements.refresh.addEventListener("click",async()=>{setBusy(true,t["settings.refreshing"]);try{render(unwrap(await callTool("codex_settings",{refreshModels:true})));setBusy(false,t["settings.refreshed"]);}catch(error){setBusy(false);setError(error);}});
    elements.reset.addEventListener("click",async()=>{if(!view)return;setBusy(true,t["settings.resetting"]);try{render(unwrap(await callTool("codex_update_settings",{expectedRevision:view.settings.revision,reset:true})));setBusy(false,t["settings.resetDone"]);}catch(error){setBusy(false);setError(error);}});
    setLocale(localeTag);if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);else callTool("codex_settings",{}).then((result)=>render(unwrap(result))).catch(setError);
  </script>
</body>
</html>`;
