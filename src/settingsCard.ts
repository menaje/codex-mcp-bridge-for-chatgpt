import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializedUiTranslations } from "./uiI18n.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  currentUiResourceUri,
  htmlForUiResource,
  uiResourceRevisions
} from "./uiResources.js";

export const SETTINGS_CARD_URI = currentUiResourceUri("settings");
export const SETTINGS_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const SETTINGS_CARD_RESOURCE_DESCRIPTOR = {
  title: `${PRODUCT_INFO.displayName} Settings`,
  description: "Localized interactive settings card for user-configurable Codex bridge preferences.",
  mimeType: SETTINGS_CARD_MIME_TYPE
} as const;
export const SETTINGS_CARD_CONTENT_METADATA = {
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    domain: "https://web-sandbox.oaiusercontent.com"
  },
  "openai/widgetDescription":
    `Configure saved access, exact model execution policy, working-directory, interface-language, and concurrency preferences for ${PRODUCT_INFO.displayName}.`,
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com"
} as const;

export function registerSettingsCardResource(server: McpServer): void {
  for (const [index, revision] of uiResourceRevisions("settings").entries()) {
    server.registerResource(
      index === 0 ? "codex-settings-card" : `codex-settings-card-compat-${index}`,
      revision.uri,
      SETTINGS_CARD_RESOURCE_DESCRIPTOR,
      async () => ({
        contents: [
          {
            uri: revision.uri,
            mimeType: SETTINGS_CARD_MIME_TYPE,
            text: htmlForUiResource("settings", revision.uri, SETTINGS_CARD_HTML),
            _meta: SETTINGS_CARD_CONTENT_METADATA
          }
        ]
      })
    );
  }
}

export const SETTINGS_CARD_HTML = String.raw`<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${PRODUCT_INFO.displayName} settings</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --surface:color-mix(in srgb,Canvas 96%,CanvasText 4%); --muted:color-mix(in srgb,CanvasText 62%,transparent); --border:color-mix(in srgb,CanvasText 16%,transparent); --accent:#1777ff; --danger:#c34132; }
    * { box-sizing:border-box; } body { margin:0; padding:12px; background:transparent; color:CanvasText; }
    .card { border:1px solid var(--border); border-radius:16px; background:var(--surface); padding:16px; }
    header { display:flex; gap:12px; justify-content:space-between; align-items:start; margin-bottom:14px; }
    h1 { font-size:18px; line-height:1.3; margin:0; } .scope,.hint { font-size:11px; line-height:1.45; color:var(--muted); font-weight:400; }
    .scope { margin:4px 0 0; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; } .wide { grid-column:1/-1; }
    label { display:grid; gap:6px; font-size:12px; font-weight:650; }
    select,input { width:100%; min-height:38px; border:1px solid var(--border); border-radius:10px; background:Canvas; color:CanvasText; padding:8px 10px; font:inherit; }
    input[type="checkbox"] { width:auto; min-height:auto; padding:0; accent-color:var(--accent); }
    .policy-panel { border:1px solid var(--border); border-radius:12px; padding:12px; }
    .policy-panel[hidden] { display:none; }
    .checkline { display:flex; align-items:center; gap:8px; font-weight:600; }
    .selection-list { display:grid; gap:7px; max-height:240px; overflow:auto; padding:8px; border:1px solid var(--border); border-radius:10px; }
    .selection-list .checkline { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
    .notice { margin-top:12px; padding:10px; border:1px solid var(--border); border-radius:10px; font-size:12px; color:var(--muted); line-height:1.45; }
    .inline-warning { color:var(--danger); }
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
    <header><div><h1>${PRODUCT_INFO.displayName}</h1><p class="scope" data-i18n="settings.scope"></p></div></header>
    <form id="settings-form">
      <div class="grid">
        <label class="wide"><span data-i18n="settings.access"></span><select id="access-strategy"></select><span class="hint" id="access-hint"></span></label>
        <label class="wide"><span data-i18n="settings.modelPolicy"></span><select id="model-policy-mode"><option value="fixed" data-i18n="settings.modelPolicy.fixed"></option><option value="automatic" data-i18n="settings.modelPolicy.automatic"></option></select></label>
        <label class="wide checkline"><input id="allow-delegation" type="checkbox" /><span data-i18n="settings.allowDelegation"></span></label>
        <section class="wide policy-panel" id="fixed-policy-panel">
          <div class="grid">
            <label><span data-i18n="settings.model"></span><select id="policy-model" required></select><span class="hint" data-i18n="settings.modelHint"></span></label>
            <label><span data-i18n="settings.effort"></span><select id="policy-effort" required aria-describedby="effort-description effort-compatibility"></select><span class="hint" id="effort-description" aria-live="polite"></span><span class="hint inline-warning" id="effort-compatibility"></span></label>
            <label class="wide"><span data-i18n="settings.serviceTier"></span><select id="policy-service-tier"></select></label>
          </div>
          <div class="notice" data-i18n="settings.fixedNotice"></div>
        </section>
        <section class="wide policy-panel" id="automatic-policy-panel" hidden>
          <div class="grid">
            <label><span data-i18n="settings.allowedScope"></span><select id="allowed-scope"><option value="catalog-visible" data-i18n="settings.allowedScope.catalog"></option><option value="explicit" data-i18n="settings.allowedScope.explicit"></option></select></label>
            <label><span data-i18n="settings.preferredSelection"></span><select id="preferred-selection"></select></label>
            <div class="wide" id="explicit-selection-panel" hidden><div class="hint" data-i18n="settings.allowedExactSelections"></div><div class="selection-list" id="allowed-selections"></div></div>
          </div>
          <div class="notice" data-i18n="settings.automaticNotice"></div>
        </section>
        <label class="wide"><span data-i18n="settings.cwd"></span><input id="default-cwd" type="text" list="allowed-roots" autocomplete="off" spellcheck="false" /><datalist id="allowed-roots"></datalist><span class="hint" id="cwd-hint"></span></label>
        <label><span data-i18n="settings.language"></span><select id="ui-language"></select><span class="hint" data-i18n="settings.languageHint"></span></label>
        <label><span data-i18n="settings.concurrency"></span><input id="concurrency" type="number" min="1" step="1" required /></label>
        <label><span data-i18n="settings.cardVisibility"></span><select id="activity-card-visibility"><option value="always" data-i18n="settings.cardVisibility.always"></option><option value="background-only" data-i18n="settings.cardVisibility.background"></option><option value="never" data-i18n="settings.cardVisibility.never"></option></select></label>
        <label><span data-i18n="settings.handoff"></span><select id="completion-handoff"><option value="off" data-i18n="settings.handoff.off"></option><option value="auto-handoff" data-i18n="settings.handoff.auto"></option></select><span class="hint" id="handoff-hint"></span></label>
      </div>
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
    let modelPolicyDirty = false;
    const initialMetadata = window.openai && window.openai.toolResponseMetadata || {};
    let hostLocaleTag = String(window.openai && window.openai.locale || initialMetadata.hostLocale || initialMetadata["openai/locale"] || initialMetadata["webplus/i18n"] || navigator.language || "en");
    let localePreference = "auto";
    let localeTag = hostLocaleTag;
    let locale = resolveLocale(localeTag);
    let t = BUNDLES[locale] || BUNDLES.en;
    const byId = (id) => document.getElementById(id);
    const elements = { form:byId("settings-form"),access:byId("access-strategy"),accessHint:byId("access-hint"),mode:byId("model-policy-mode"),delegation:byId("allow-delegation"),fixedPanel:byId("fixed-policy-panel"),automaticPanel:byId("automatic-policy-panel"),model:byId("policy-model"),effort:byId("policy-effort"),effortDescription:byId("effort-description"),effortCompatibility:byId("effort-compatibility"),serviceTier:byId("policy-service-tier"),allowedScope:byId("allowed-scope"),preferred:byId("preferred-selection"),explicitPanel:byId("explicit-selection-panel"),allowedSelections:byId("allowed-selections"),cwd:byId("default-cwd"),roots:byId("allowed-roots"),cwdHint:byId("cwd-hint"),language:byId("ui-language"),concurrency:byId("concurrency"),cardVisibility:byId("activity-card-visibility"),handoff:byId("completion-handoff"),handoffHint:byId("handoff-hint"),save:byId("save"),refresh:byId("refresh"),reset:byId("reset"),status:byId("status"),fullWarning:byId("full-warning"),catalogWarning:byId("catalog-warning") };
    const LANGUAGE_LABELS = {en:"English",ko:"한국어",ja:"日本語","zh-Hans":"简体中文","zh-Hant":"繁體中文",es:"Español",fr:"Français",de:"Deutsch",pt:"Português"};
    const KNOWN_EFFORTS = new Set(["minimal","low","medium","high","xhigh","max","ultra"]);
    function resolveLocale(value) { const v=String(value||"en").replaceAll("_","-").toLowerCase(); if(v==="ko"||v.startsWith("ko-"))return"ko";if(v==="ja"||v.startsWith("ja-"))return"ja";if(v==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(v))return"zh-Hant";if(v==="zh"||v==="zh-hans"||v.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(v===key||v.startsWith(key+"-"))return key;return"en"; }
    function effectiveLocaleTag() { return localePreference==="auto"?hostLocaleTag:localePreference; }
    function setLocale(value,rerender=true) { localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;for(const node of document.querySelectorAll("[data-i18n]"))node.textContent=t[node.dataset.i18n]||BUNDLES.en[node.dataset.i18n]||node.dataset.i18n;if(rerender&&view)render(view,true,true); }
    function option(value,label) { const node=document.createElement("option");node.value=value;node.textContent=label;return node; }
    function callTool(name,args) { if(window.openai&&typeof window.openai.callTool==="function")return window.openai.callTool(name,args);return new Promise((resolve,reject)=>{const id=nextRequestId++;const timer=setTimeout(()=>{pendingRequests.delete(id);reject(new Error(t["common.error"]));},REQUEST_TIMEOUT_MS);pendingRequests.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v);},reject:(e)=>{clearTimeout(timer);reject(e);}});window.parent.postMessage({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}},"*");}); }
    function unwrap(result) { if(result&&result._meta){const responseHostLocale=result._meta.hostLocale||result._meta["webplus/i18n"];if(responseHostLocale)hostLocaleTag=String(responseHostLocale);}if(result&&result.isError){const entry=Array.isArray(result.content)&&result.content.find((item)=>item&&item.type==="text"&&typeof item.text==="string");throw new Error(entry&&entry.text||t["common.error"]);}const next=result&&result.structuredContent||result;if(!next||!next.settings||!next.capabilities||!next.catalog)throw new Error(t["settings.invalidResponse"]);return next; }
    function modelFor(id) { return view&&view.catalog.models.find((entry)=>entry.id===id); }
    function defaultSelectionForModel(id) { const model=modelFor(id);if(!model)return null;const effort=model.defaultReasoningEffort||(model.supportedReasoningEfforts&&model.supportedReasoningEfforts[0]&&model.supportedReasoningEfforts[0].effort);if(!effort)return null;const tier=model.defaultServiceTier;return{model:model.id,reasoningEffort:effort,...(tier?{serviceTier:tier}:{})}; }
    function selectionKey(selection) { return JSON.stringify([selection.model,selection.reasoningEffort,selection.serviceTier||null]); }
    function selectionFromKey(value) { if(!value)return null;try{const parts=JSON.parse(value);if(!Array.isArray(parts)||typeof parts[0]!=="string"||typeof parts[1]!=="string")return null;return{model:parts[0],reasoningEffort:parts[1],...(typeof parts[2]==="string"&&parts[2]?{serviceTier:parts[2]}:{})};}catch{return null;} }
    function selectionLabel(selection) { const model=modelFor(selection.model);return (model&&model.displayName||selection.model)+" ["+selection.model+"] / "+selection.reasoningEffort+(selection.serviceTier?" / "+selection.serviceTier:""); }
    function effortPresentation(effort) { const model=modelFor(elements.model.value),entry=model&&(model.supportedReasoningEfforts||[]).find((item)=>item.effort===effort),known=KNOWN_EFFORTS.has(effort),label=known?(t["effort."+effort+".label"]||effort):effort;if(locale==="en"&&entry&&entry.description)return{label,description:entry.description,source:"upstream"};if(known)return{label,description:t["effort."+effort+".description"],source:"localized"};return{label,description:t["settings.effortFallbackDescription"],source:"fallback"}; }
    function updateEffortHelper() { const current=effortPresentation(elements.effort.value);elements.effortDescription.textContent=current.description||"";elements.effortDescription.dataset.descriptionSource=current.source; }
    function allCatalogSelections() { const selections=[];for(const model of view&&view.catalog.models||[]){if(model.hidden)continue;for(const effort of model.supportedReasoningEfforts||[]){selections.push({model:model.id,reasoningEffort:effort.effort});for(const tier of model.serviceTiers||[])selections.push({model:model.id,reasoningEffort:effort.effort,serviceTier:tier.id});}}const unique=new Map();for(const selection of selections)unique.set(selectionKey(selection),selection);return [...unique.values()]; }
    function operatorAllows(selection) { const ceiling=view&&view.capabilities.operatorModelCeiling;return !Array.isArray(ceiling)||ceiling.some((entry)=>selectionKey(entry)===selectionKey(selection)); }
    function availableSelections() { return allCatalogSelections().filter((selection)=>operatorAllows(selection)&&(elements.delegation.checked||selection.reasoningEffort!=="ultra")); }
    function renderFixedTiers(preferred) { const candidates=availableSelections().filter((selection)=>selection.model===elements.model.value&&selection.reasoningEffort===elements.effort.value);if(preferred&&preferred.model===elements.model.value&&preferred.reasoningEffort===elements.effort.value&&!candidates.some((selection)=>selectionKey(selection)===selectionKey(preferred)))candidates.push(preferred);elements.serviceTier.replaceChildren();for(const selection of candidates)elements.serviceTier.appendChild(option(selection.serviceTier||"",selection.serviceTier||t["settings.serviceTier.default"]));const wanted=preferred&&preferred.model===elements.model.value&&preferred.reasoningEffort===elements.effort.value?preferred.serviceTier||"":"";elements.serviceTier.value=Array.from(elements.serviceTier.options).some((entry)=>entry.value===wanted)?wanted:(elements.serviceTier.options[0]&&elements.serviceTier.options[0].value||""); }
    function renderFixedEfforts(preferred) { const modelId=elements.model.value,available=[...new Set(availableSelections().filter((selection)=>selection.model===modelId).map((selection)=>selection.reasoningEffort))],efforts=[...available],saved=preferred&&preferred.model===modelId?preferred.reasoningEffort:"",unsupported=Boolean(saved&&!available.includes(saved));if(unsupported)efforts.push(saved);elements.effort.replaceChildren();for(const effort of efforts)elements.effort.appendChild(option(effort,effortPresentation(effort).label));const modelDefault=defaultSelectionForModel(modelId),wanted=saved||(modelDefault&&modelDefault.reasoningEffort)||"";elements.effort.value=efforts.includes(wanted)?wanted:efforts[0]||"";elements.effortCompatibility.textContent=unsupported?t["settings.unsupportedEffort"]+" "+((modelDefault&&effortPresentation(modelDefault.reasoningEffort).label)||"—"):"";updateEffortHelper();renderFixedTiers(preferred); }
    function renderFixedSelection(preferred) { const available=availableSelections();const ids=[...new Set(available.map((selection)=>selection.model))];if(preferred&&!ids.includes(preferred.model))ids.push(preferred.model);elements.model.replaceChildren();for(const id of ids){const model=modelFor(id),missing=preferred&&id===preferred.model&&!available.some((selection)=>selection.model===id);elements.model.appendChild(option(id,(model&&model.displayName||id)+(missing?" ("+t["settings.savedModel"]+")":"")));}elements.model.value=preferred&&ids.includes(preferred.model)?preferred.model:ids[0]||"";renderFixedEfforts(preferred); }
    function currentFixedSelection() { if(!elements.model.value||!elements.effort.value)return null;return{model:elements.model.value,reasoningEffort:elements.effort.value,...(elements.serviceTier.value?{serviceTier:elements.serviceTier.value}:{})}; }
    function checkedExplicitSelections() { return [...elements.allowedSelections.querySelectorAll('input[type="checkbox"]:checked')].map((entry)=>selectionFromKey(entry.value)).filter(Boolean); }
    function renderAllowedSelections(selected) { const selectedKeys=new Set((selected||[]).map(selectionKey)),available=availableSelections(),candidates=[...available];for(const selection of selected||[])if(!candidates.some((entry)=>selectionKey(entry)===selectionKey(selection)))candidates.push(selection);elements.allowedSelections.replaceChildren();for(const selection of candidates){const label=document.createElement("label");label.className="checkline";const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.value=selectionKey(selection);checkbox.checked=selectedKeys.has(checkbox.value);const missing=!available.some((entry)=>selectionKey(entry)===checkbox.value);label.append(checkbox,document.createTextNode(selectionLabel(selection)+(missing?" ("+t["settings.savedModel"]+")":"")));elements.allowedSelections.appendChild(label);} }
    function automaticCandidates() { return elements.allowedScope.value==="explicit"?checkedExplicitSelections():availableSelections(); }
    function renderPreferred(preferred) { const candidates=automaticCandidates(),wanted=preferred?selectionKey(preferred):elements.preferred.value;if(preferred&&!candidates.some((entry)=>selectionKey(entry)===wanted))candidates.push(preferred);elements.preferred.replaceChildren(option("",t["settings.preferred.none"]));for(const selection of candidates){const available=availableSelections().some((entry)=>selectionKey(entry)===selectionKey(selection));elements.preferred.appendChild(option(selectionKey(selection),selectionLabel(selection)+(available?"":" ("+t["settings.savedModel"]+")")));}elements.preferred.value=candidates.some((entry)=>selectionKey(entry)===wanted)?wanted:""; }
    function ensureExplicitSelection() { if(elements.allowedScope.value!=="explicit"||checkedExplicitSelections().length>0)return;const preferred=selectionFromKey(elements.preferred.value);const first=[...elements.allowedSelections.querySelectorAll('input[type="checkbox"]')].find((entry)=>!preferred||entry.value===selectionKey(preferred))||elements.allowedSelections.querySelector('input[type="checkbox"]');if(first)first.checked=true; }
    function updatePolicyControls() { const fixed=elements.mode.value==="fixed";const explicit=!fixed&&elements.allowedScope.value==="explicit";elements.fixedPanel.hidden=!fixed;elements.automaticPanel.hidden=fixed;elements.explicitPanel.hidden=!explicit;elements.model.disabled=!fixed;elements.effort.disabled=!fixed;elements.serviceTier.disabled=!fixed;elements.allowedScope.disabled=fixed;elements.preferred.disabled=fixed;for(const checkbox of elements.allowedSelections.querySelectorAll('input[type="checkbox"]'))checkbox.disabled=!explicit;if(explicit)ensureExplicitSelection();renderPreferred(selectionFromKey(elements.preferred.value)); }
    function renderModelPolicy(policy,legacyPreferred) { elements.delegation.checked=policy.constraints&&policy.constraints.allowDelegation!==false;elements.mode.value=policy.mode;const preferred=policy.mode==="automatic"?policy.preferredSelection||legacyPreferred:null;const seed=policy.mode==="fixed"?policy.selection:preferred||availableSelections()[0];renderFixedSelection(seed);elements.allowedScope.value=policy.mode==="automatic"?policy.allowedSelections.kind:"catalog-visible";const selected=policy.mode==="automatic"&&policy.allowedSelections.kind==="explicit"?policy.allowedSelections.selections:(policy.mode==="fixed"?[policy.selection]:(preferred?[preferred]:[]));renderAllowedSelections(selected);renderPreferred(policy.mode==="automatic"?preferred:policy.selection);updatePolicyControls(); }
    function buildModelPolicy() { const constraints={allowDelegation:elements.delegation.checked};if(elements.mode.value==="fixed"){const selection=currentFixedSelection();if(!selection)throw new Error(t["settings.selectionRequired"]);return{mode:"fixed",selection,constraints};}const explicit=elements.allowedScope.value==="explicit";const selections=checkedExplicitSelections();if(explicit&&selections.length===0)throw new Error(t["settings.explicitRequired"]);const preferredSelection=selectionFromKey(elements.preferred.value);return{mode:"automatic",...(preferredSelection?{preferredSelection}:{}),allowedSelections:explicit?{kind:"explicit",selections}:{kind:"catalog-visible"},constraints}; }
    function updateAccessNotice() { const value=elements.access.value;const key=value==="read-only"?"settings.access.readOnlyHint":value==="always-full"?"settings.access.fullHint":"settings.access.adaptiveHint";elements.accessHint.textContent=t[key];elements.fullWarning.classList.toggle("show",value==="always-full"); }
    function updateCardPolicy() { const hidden=elements.cardVisibility.value==="never";if(hidden)elements.handoff.value="off";elements.handoff.disabled=hidden;elements.handoffHint.textContent=hidden?t["settings.handoffRequiresCard"]:""; }
    function render(next,localeReady=false,preserveLocalePreference=false) { if(!next||!next.settings)return;view=next;const settings=next.settings,limits=next.capabilities;if(!preserveLocalePreference)localePreference=settings.uiLocalePreference||"auto";if(!localeReady)setLocale(effectiveLocaleTag(),false);elements.access.replaceChildren();const accessLabels={"read-only":t["settings.access.readOnly"],adaptive:t["settings.access.adaptive"],"always-full":t["settings.access.full"]};for(const value of limits.availableAccessStrategies||[])elements.access.appendChild(option(value,accessLabels[value]||value));elements.access.value=settings.accessStrategy;renderModelPolicy(settings.modelPolicy,settings.legacyPreferredModel?defaultSelectionForModel(settings.legacyPreferredModel):null);modelPolicyDirty=false;elements.cwd.value=settings.defaultCwd||"";elements.roots.replaceChildren();for(const root of limits.allowedRoots||[])elements.roots.appendChild(option(root,root));elements.cwdHint.textContent=t["settings.cwdHint"]+" "+(limits.allowedRoots||[]).join(", ");elements.language.replaceChildren();for(const value of limits.availableUiLocalePreferences||["auto",...Object.keys(LANGUAGE_LABELS)])elements.language.appendChild(option(value,value==="auto"?t["settings.language.auto"]:LANGUAGE_LABELS[value]||value));elements.language.value=localePreference;elements.concurrency.value=String(settings.maxConcurrentJobs);elements.concurrency.max=String(limits.maxConcurrentJobs);elements.cardVisibility.value=settings.activityCardVisibility||"always";elements.handoff.value=settings.completionHandoff||"off";updateAccessNotice();updateCardPolicy();const warnings=[next.catalog.warning,...(next.warnings||[])].filter(Boolean).join("\n");elements.catalogWarning.textContent=warnings;elements.catalogWarning.classList.toggle("show",Boolean(warnings)); }
    function setBusy(busy,message) { for(const node of[elements.save,elements.refresh,elements.reset])node.disabled=busy;elements.status.classList.remove("error");elements.status.textContent=message||""; }
    function setError(error) { elements.status.classList.add("error");elements.status.textContent=error instanceof Error?error.message:String(error); }
    async function handleMutationError(error) { const value=error instanceof Error?error.message:String(error);if(!value.includes("SETTINGS_REVISION_CONFLICT")){setBusy(false);setError(error);return;}try{render(unwrap(await callTool("codex_settings",{})));setBusy(false);elements.status.classList.add("error");elements.status.textContent=t["settings.conflict"];}catch(refreshError){setBusy(false);setError(refreshError);} }
    function integerValue(input) { const value=Number(input.value);if(!Number.isSafeInteger(value))throw new Error(t["common.error"]);return value; }
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.id!==undefined&&pendingRequests.has(message.id)){const pending=pendingRequests.get(message.id);pendingRequests.delete(message.id);message.error?pending.reject(new Error(message.error.message||t["common.error"])):pending.resolve(message.result);return;}if(message.method==="ui/notifications/tool-result")render(message.params&&message.params.structuredContent);},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event.detail&&event.detail.globals,metadata=globals&&globals.toolResponseMetadata;const responseHostLocale=metadata&&(metadata.hostLocale||metadata["webplus/i18n"]||metadata["openai/locale"]);if(globals&&globals.locale)hostLocaleTag=String(globals.locale);else if(responseHostLocale)hostLocaleTag=String(responseHostLocale);if(localePreference==="auto"){setLocale(hostLocaleTag,false);updateAccessNotice();updateCardPolicy();}if(globals&&globals.toolOutput)render(globals.toolOutput);});
    window.addEventListener("pagehide",()=>{for(const [id,request] of pendingRequests){window.parent.postMessage({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:id,reason:"Settings card unmounted"}},"*");request.reject(new Error("Settings card unmounted"));}pendingRequests.clear();});
    elements.access.addEventListener("change",updateAccessNotice);
    elements.cardVisibility.addEventListener("change",updateCardPolicy);
    elements.mode.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();});
    elements.delegation.addEventListener("change",()=>{modelPolicyDirty=true;const fixed=currentFixedSelection(),selected=checkedExplicitSelections(),preferred=selectionFromKey(elements.preferred.value);renderFixedSelection(fixed);renderAllowedSelections(selected);renderPreferred(preferred);updatePolicyControls();});
    elements.model.addEventListener("change",()=>{modelPolicyDirty=true;renderFixedEfforts(null);});
    elements.effort.addEventListener("change",()=>{modelPolicyDirty=true;updateEffortHelper();elements.effortCompatibility.textContent="";renderFixedTiers(null);});
    elements.serviceTier.addEventListener("change",()=>{modelPolicyDirty=true;});
    elements.allowedScope.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();});
    elements.allowedSelections.addEventListener("change",()=>{modelPolicyDirty=true;renderPreferred(selectionFromKey(elements.preferred.value));});
    elements.preferred.addEventListener("change",()=>{modelPolicyDirty=true;});
    elements.language.addEventListener("change",()=>{localePreference=elements.language.value;setLocale(effectiveLocaleTag(),false);updateAccessNotice();updateCardPolicy();});
    elements.form.addEventListener("submit",async(event)=>{event.preventDefault();if(!view||!elements.form.reportValidity())return;setBusy(true,t["settings.saving"]);try{const args={expectedRevision:view.settings.revision,accessStrategy:elements.access.value,defaultCwd:elements.cwd.value.trim()||null,uiLocalePreference:elements.language.value,maxConcurrentJobs:integerValue(elements.concurrency),activityCardVisibility:elements.cardVisibility.value,completionHandoff:elements.handoff.value};if(modelPolicyDirty)args.modelPolicy=buildModelPolicy();const result=await callTool("codex_update_settings",args);render(unwrap(result));setBusy(false,t["settings.saved"]);}catch(error){await handleMutationError(error);}});
    elements.refresh.addEventListener("click",async()=>{setBusy(true,t["settings.refreshing"]);try{render(unwrap(await callTool("codex_settings",{refreshModels:true})));setBusy(false,t["settings.refreshed"]);}catch(error){setBusy(false);setError(error);}});
    elements.reset.addEventListener("click",async()=>{if(!view)return;setBusy(true,t["settings.resetting"]);try{render(unwrap(await callTool("codex_update_settings",{expectedRevision:view.settings.revision,reset:true})));setBusy(false,t["settings.resetDone"]);}catch(error){await handleMutationError(error);}});
    setLocale(localeTag);if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);else callTool("codex_settings",{}).then((result)=>render(unwrap(result))).catch(setError);
  </script>
</body>
</html>`;
