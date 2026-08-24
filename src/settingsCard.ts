import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializedUiTranslations } from "./uiI18n.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  currentUiResourceUri,
  htmlForUiResource,
  uiResourceRevisions
} from "./uiResources.js";

export const SETTINGS_CARD_URI = currentUiResourceUri("settings");
export const SETTINGS_CARD_CONTRACT_GENERATION = 3;
export const RETAINED_SETTINGS_CARD_CONTRACT_GENERATION = 2;
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
    `Configure named projects, saved access, model/effort policy, independent Priority processing, interface-language, concurrency, and per-response Activity-card visibility for ${PRODUCT_INFO.displayName}.`,
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com",
  "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
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
            _meta: {
              ...SETTINGS_CARD_CONTENT_METADATA,
              "codex/uiContractGeneration": revision.contractGeneration ||
                SETTINGS_CARD_CONTRACT_GENERATION
            }
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
    .explicit-layout { display:grid; grid-template-columns:minmax(180px,.7fr) minmax(260px,1.3fr); gap:10px; margin-top:8px; }
    .choice-group { min-width:0; margin:0; padding:0; border:0; }
    .choice-group > legend { margin-bottom:6px; padding:0; }
    .effort-groups { display:grid; gap:8px; }
    .effort-card { display:grid; min-width:0; margin:0; gap:8px; padding:10px; border:1px solid var(--border); border-radius:10px; }
    .effort-card-header { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
    .effort-card-title { min-width:0; font:650 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .effort-options { display:flex; flex-wrap:wrap; gap:7px 12px; }
    .effort-options .checkline { font-size:11px; }
    .selection-count { margin-top:8px; text-align:right; }
    .projects-panel { border:1px solid var(--border); border-radius:12px; padding:12px; }
    .projects-header { display:flex; align-items:start; justify-content:space-between; gap:12px; }
    .projects-header h2 { margin:0 0 4px; font-size:14px; }
    .allowed-roots-box { margin-top:10px; padding:10px; border-radius:10px; background:color-mix(in srgb,CanvasText 4%,transparent); }
    .allowed-roots-box strong { display:block; font-size:12px; margin-bottom:4px; }
    .allowed-root-list { display:grid; gap:3px; margin:0 0 5px; padding-left:20px; font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .project-list { display:grid; gap:9px; margin-top:10px; }
    .project-row { display:grid; grid-template-columns:minmax(110px,.55fr) minmax(140px,.8fr) minmax(220px,1.4fr) auto; gap:8px; align-items:end; padding:10px; border:1px solid var(--border); border-radius:10px; }
    .project-row.unavailable { border-color:color-mix(in srgb,var(--danger) 45%,transparent); }
    .project-row label { min-width:0; }
    .project-row input[readonly] { color:var(--muted); background:color-mix(in srgb,CanvasText 3%,Canvas); }
    .project-row-actions { display:grid; gap:6px; justify-items:end; }
    .project-availability { font-size:10px; color:var(--muted); white-space:nowrap; }
    .project-availability.unavailable { color:var(--danger); font-weight:650; }
    .project-remove { color:var(--danger); }
    .project-default { display:grid; gap:6px; margin-top:10px; }
    .no-projects { margin:10px 0 0; font-size:12px; color:var(--muted); }
    .field-error { display:none; margin:8px 0 0; color:var(--danger); font-size:12px; line-height:1.4; }
    .field-error.show { display:block; }
    .notice { margin-top:12px; padding:10px; border:1px solid var(--border); border-radius:10px; font-size:12px; color:var(--muted); line-height:1.45; }
    .inline-warning { color:var(--danger); }
    .warning { display:none; margin-top:12px; border:1px solid color-mix(in srgb,var(--danger) 45%,transparent); border-radius:10px; padding:10px; color:var(--danger); font-size:12px; line-height:1.45; white-space:pre-line; }
    .warning.show { display:block; } .warning button { margin-top:8px; } .access-warning { margin-top:2px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:16px; }
    button { min-height:36px; border:1px solid var(--border); border-radius:10px; padding:7px 12px; background:Canvas; color:CanvasText; font-weight:650; cursor:pointer; }
    button.primary { border-color:var(--accent); background:var(--accent); color:white; } button:disabled { cursor:wait; opacity:.6; }
    #status { flex:1; min-width:180px; font-size:12px; color:var(--muted); text-align:right; } #status.error { color:var(--danger); }
    @media (max-width:700px) { .project-row{grid-template-columns:1fr 1fr}.project-row label:nth-child(3){grid-column:1/-1}.project-row-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;width:100%} }
    @media (max-width:560px) { .grid,.explicit-layout,.project-row{grid-template-columns:1fr}.wide{grid-column:auto}.projects-header{display:grid}.project-row label:nth-child(3),.project-row-actions{grid-column:auto}#status{text-align:left} }
  </style>
</head>
<body>
  <main class="card">
    <header><div><h1>${PRODUCT_INFO.displayName}</h1><p class="scope" data-i18n="settings.scope"></p></div></header>
    <form id="settings-form">
      <div class="grid">
        <label class="wide"><span data-i18n="settings.access"></span><select id="access-strategy" aria-describedby="access-hint full-warning"></select><span class="hint" id="access-hint"></span><span class="warning access-warning" id="full-warning" role="status" aria-live="polite" aria-atomic="true" data-i18n="settings.fullWarning"></span></label>
        <label class="wide"><span data-i18n="settings.modelPolicy"></span><select id="model-policy-mode"><option value="fixed" data-i18n="settings.modelPolicy.fixed"></option><option value="automatic" data-i18n="settings.modelPolicy.automatic"></option></select></label>
        <label class="wide checkline"><input id="allow-delegation" type="checkbox" /><span data-i18n="settings.allowDelegation"></span></label>
        <div class="wide"><label class="checkline"><input id="use-priority-service-tier" type="checkbox" /><span data-i18n="settings.usePriority"></span></label><span class="hint" data-i18n="settings.usePriorityHint"></span></div>
        <section class="wide policy-panel" id="fixed-policy-panel">
          <div class="grid">
            <label><span data-i18n="settings.model"></span><select id="policy-model" required></select><span class="hint" data-i18n="settings.modelHint"></span></label>
            <label><span data-i18n="settings.effort"></span><select id="policy-effort" required aria-describedby="effort-description effort-compatibility"></select><span class="hint" id="effort-description" aria-live="polite"></span><span class="hint inline-warning" id="effort-compatibility"></span></label>
          </div>
          <div class="notice" data-i18n="settings.fixedNotice"></div>
        </section>
        <section class="wide policy-panel" id="automatic-policy-panel" hidden>
          <div class="grid">
            <label><span data-i18n="settings.allowedScope"></span><select id="allowed-scope"><option value="catalog-visible" data-i18n="settings.allowedScope.catalog"></option><option value="explicit" data-i18n="settings.allowedScope.explicit"></option></select></label>
            <label><span data-i18n="settings.preferredSelection"></span><select id="preferred-selection"></select></label>
            <div class="wide" id="explicit-selection-panel" hidden>
              <div class="hint" data-i18n="settings.allowedExactSelections"></div>
              <div class="explicit-layout">
                <fieldset class="choice-group"><legend class="hint" data-i18n="settings.allowedModels"></legend><div class="selection-list" id="allowed-models"></div></fieldset>
                <div><div class="hint" data-i18n="settings.effortsByModel"></div><div class="effort-groups" id="effort-groups"></div></div>
              </div>
              <div class="hint selection-count" id="selection-count" aria-live="polite"></div>
            </div>
          </div>
          <div class="notice" data-i18n="settings.automaticNotice"></div>
        </section>
        <section class="wide projects-panel" aria-labelledby="projects-title">
          <div class="projects-header"><div><h2 id="projects-title" data-i18n="settings.projects"></h2><div class="hint" data-i18n="settings.projectsHint"></div></div><button id="add-project" type="button" data-i18n="settings.addProject"></button></div>
          <div class="allowed-roots-box"><strong data-i18n="settings.allowedRoots"></strong><ul class="allowed-root-list" id="allowed-root-list"></ul><span class="hint" data-i18n="settings.allowedRootsHint"></span></div>
          <datalist id="allowed-roots"></datalist>
          <div class="project-list" id="project-list"></div>
          <p class="no-projects" id="no-projects" data-i18n="settings.noProjects"></p>
          <label class="project-default"><span data-i18n="settings.defaultProject"></span><select id="default-project"></select><span class="hint" data-i18n="settings.defaultProjectHint"></span></label>
          <p class="field-error" id="project-error" role="alert" aria-live="polite"></p>
        </section>
        <label><span data-i18n="settings.language"></span><select id="ui-language"></select><span class="hint" data-i18n="settings.languageHint"></span></label>
        <label><span data-i18n="settings.concurrency"></span><input id="concurrency" type="number" min="1" step="1" required /></label>
        <label><span data-i18n="settings.cardVisibility"></span><select id="activity-card-visibility"><option value="always" data-i18n="settings.cardVisibility.always"></option><option value="background-only" data-i18n="settings.cardVisibility.background"></option><option value="never" data-i18n="settings.cardVisibility.never"></option></select></label>
        <label><span data-i18n="settings.handoff"></span><select id="completion-handoff"><option value="off" data-i18n="settings.handoff.off"></option><option value="auto-handoff" data-i18n="settings.handoff.auto"></option></select><span class="hint" id="handoff-hint"></span></label>
      </div>
      <div class="warning" id="catalog-warning" role="status" aria-live="polite"><span id="catalog-warning-text"></span><br /><button id="retry-models" type="button" data-i18n="settings.refreshModels" hidden></button></div>
      <div class="actions"><button class="primary" id="save" type="submit" data-i18n="settings.save"></button><button id="reset" type="button" data-i18n="settings.reset"></button><span id="status" role="status" aria-live="polite"></span></div>
    </form>
  </main>
  <script>
    const BUNDLES = ${serializedUiTranslations()};
    const pendingRequests = new Map();
    const REQUEST_TIMEOUT_MS = 90000;
    let nextRequestId = 1;
    let view = null;
    let modelPolicyDirty = false;
    let savedPreferredKey = "";
    const explicitSelectedModels = new Set();
    const explicitSelectionMemory = new Map();
    const initialMetadata = window.openai && window.openai.toolResponseMetadata || {};
    let hostLocaleTag = String(window.openai && window.openai.locale || initialMetadata.hostLocale || initialMetadata["openai/locale"] || initialMetadata["webplus/i18n"] || navigator.language || "en");
    let localePreference = "auto";
    let localeTag = hostLocaleTag;
    let locale = resolveLocale(localeTag);
    let t = BUNDLES[locale] || BUNDLES.en;
    const byId = (id) => document.getElementById(id);
    const elements = { form:byId("settings-form"),access:byId("access-strategy"),accessHint:byId("access-hint"),mode:byId("model-policy-mode"),delegation:byId("allow-delegation"),priority:byId("use-priority-service-tier"),fixedPanel:byId("fixed-policy-panel"),automaticPanel:byId("automatic-policy-panel"),model:byId("policy-model"),effort:byId("policy-effort"),effortDescription:byId("effort-description"),effortCompatibility:byId("effort-compatibility"),allowedScope:byId("allowed-scope"),preferred:byId("preferred-selection"),explicitPanel:byId("explicit-selection-panel"),allowedModels:byId("allowed-models"),effortGroups:byId("effort-groups"),selectionCount:byId("selection-count"),addProject:byId("add-project"),projectList:byId("project-list"),noProjects:byId("no-projects"),defaultProject:byId("default-project"),projectError:byId("project-error"),roots:byId("allowed-roots"),rootList:byId("allowed-root-list"),language:byId("ui-language"),concurrency:byId("concurrency"),cardVisibility:byId("activity-card-visibility"),handoff:byId("completion-handoff"),handoffHint:byId("handoff-hint"),save:byId("save"),retryModels:byId("retry-models"),reset:byId("reset"),status:byId("status"),fullWarning:byId("full-warning"),catalogWarning:byId("catalog-warning"),catalogWarningText:byId("catalog-warning-text") };
    const LANGUAGE_LABELS = {en:"English",ko:"한국어",ja:"日本語","zh-Hans":"简体中文","zh-Hant":"繁體中文",es:"Español",fr:"Français",de:"Deutsch",pt:"Português"};
    const KNOWN_EFFORTS = new Set(["minimal","low","medium","high","xhigh","max","ultra"]);
    function resolveLocale(value) { const v=String(value||"en").replaceAll("_","-").toLowerCase(); if(v==="ko"||v.startsWith("ko-"))return"ko";if(v==="ja"||v.startsWith("ja-"))return"ja";if(v==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(v))return"zh-Hant";if(v==="zh"||v==="zh-hans"||v.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(v===key||v.startsWith(key+"-"))return key;return"en"; }
    function effectiveLocaleTag() { return localePreference==="auto"?hostLocaleTag:localePreference; }
    function setLocale(value,rerender=true) { localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;for(const node of document.querySelectorAll("[data-i18n]"))node.textContent=t[node.dataset.i18n]||BUNDLES.en[node.dataset.i18n]||node.dataset.i18n;if(rerender&&view)render(view,true,true); }
    function option(value,label) { const node=document.createElement("option");node.value=value;node.textContent=label;return node; }
    function callTool(name,args) { if(window.openai&&typeof window.openai.callTool==="function")return window.openai.callTool(name,args);return new Promise((resolve,reject)=>{const id=nextRequestId++;const timer=setTimeout(()=>{pendingRequests.delete(id);reject(new Error(t["common.error"]));},REQUEST_TIMEOUT_MS);pendingRequests.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v);},reject:(e)=>{clearTimeout(timer);reject(e);}});window.parent.postMessage({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}},"*");}); }
    function unwrap(result) { if(result&&result._meta){const responseHostLocale=result._meta.hostLocale||result._meta["webplus/i18n"];if(responseHostLocale)hostLocaleTag=String(responseHostLocale);}if(result&&result.isError){const entry=Array.isArray(result.content)&&result.content.find((item)=>item&&item.type==="text"&&typeof item.text==="string");throw new Error(entry&&entry.text||t["common.error"]);}const next=result&&result.structuredContent||result;if(!next||!next.settings||!next.capabilities||!next.catalog)throw new Error(t["settings.invalidResponse"]);return next; }
    function modelFor(id) { return view&&view.catalog.models.find((entry)=>entry.id===id); }
    function defaultSelectionForModel(id) { const model=modelFor(id);if(!model)return null;const effort=model.defaultReasoningEffort||(model.supportedReasoningEfforts&&model.supportedReasoningEfforts[0]&&model.supportedReasoningEfforts[0].effort);return effort?{model:model.id,reasoningEffort:effort}:null; }
    function selectionKey(selection) { return JSON.stringify([selection.model,selection.reasoningEffort]); }
    function selectionFromKey(value) { if(!value)return null;try{const parts=JSON.parse(value);if(!Array.isArray(parts)||typeof parts[0]!=="string"||typeof parts[1]!=="string")return null;return{model:parts[0],reasoningEffort:parts[1]};}catch{return null;} }
    function selectionLabel(selection) { const model=modelFor(selection.model);return (model&&model.displayName||selection.model)+" ["+selection.model+"] / "+selection.reasoningEffort; }
    function effortPresentation(effort) { const model=modelFor(elements.model.value),entry=model&&(model.supportedReasoningEfforts||[]).find((item)=>item.effort===effort),known=KNOWN_EFFORTS.has(effort),label=known?(t["effort."+effort+".label"]||effort):effort;if(locale==="en"&&entry&&entry.description)return{label,description:entry.description,source:"upstream"};if(known)return{label,description:t["effort."+effort+".description"],source:"localized"};return{label,description:t["settings.effortFallbackDescription"],source:"fallback"}; }
    function updateEffortHelper() { const current=effortPresentation(elements.effort.value);elements.effortDescription.textContent=current.description||"";elements.effortDescription.dataset.descriptionSource=current.source; }
    function allCatalogSelections() { const selections=[];for(const model of view&&view.catalog.models||[]){if(model.hidden)continue;for(const effort of model.supportedReasoningEfforts||[])selections.push({model:model.id,reasoningEffort:effort.effort});}return selections; }
    function operatorAllows(selection) { const ceiling=view&&view.capabilities.operatorModelCeiling;return !Array.isArray(ceiling)||ceiling.some((entry)=>selectionKey(entry)===selectionKey(selection)); }
    function availableSelections() { return allCatalogSelections().filter((selection)=>operatorAllows(selection)&&(elements.delegation.checked||selection.reasoningEffort!=="ultra")); }
    function renderFixedEfforts(preferred) { const modelId=elements.model.value,available=[...new Set(availableSelections().filter((selection)=>selection.model===modelId).map((selection)=>selection.reasoningEffort))],efforts=[...available],saved=preferred&&preferred.model===modelId?preferred.reasoningEffort:"",unsupported=Boolean(saved&&!available.includes(saved));if(unsupported)efforts.push(saved);elements.effort.replaceChildren();for(const effort of efforts)elements.effort.appendChild(option(effort,effortPresentation(effort).label));const modelDefault=defaultSelectionForModel(modelId),wanted=saved||(modelDefault&&modelDefault.reasoningEffort)||"";elements.effort.value=efforts.includes(wanted)?wanted:efforts[0]||"";elements.effortCompatibility.textContent=unsupported?t["settings.unsupportedEffort"]+" "+((modelDefault&&effortPresentation(modelDefault.reasoningEffort).label)||"—"):"";updateEffortHelper(); }
    function renderFixedSelection(preferred) { const available=availableSelections();const ids=[...new Set(available.map((selection)=>selection.model))];if(preferred&&!ids.includes(preferred.model))ids.push(preferred.model);elements.model.replaceChildren();for(const id of ids){const model=modelFor(id),missing=preferred&&id===preferred.model&&!available.some((selection)=>selection.model===id);elements.model.appendChild(option(id,(model&&model.displayName||id)+(missing?" ("+t["settings.savedModel"]+")":"")));}elements.model.value=preferred&&ids.includes(preferred.model)?preferred.model:ids[0]||"";renderFixedEfforts(preferred); }
    function currentFixedSelection() { if(!elements.model.value||!elements.effort.value)return null;return{model:elements.model.value,reasoningEffort:elements.effort.value}; }
    function checkedExplicitSelections() { return [...explicitSelectionMemory.values()].filter((selection)=>explicitSelectedModels.has(selection.model)); }
    function modelSelections(modelId,selections) { return selections.filter((selection)=>selection.model===modelId); }
    function exactSelectionsForEffort(modelId,effort) { return [...explicitSelectionMemory.values()].filter((selection)=>selection.model===modelId&&selection.reasoningEffort===effort); }
    function primarySelectionForEffort(modelId,effort,candidates) { const availableKeys=new Set(availableSelections().map(selectionKey)),allowed=candidates.filter((selection)=>availableKeys.has(selectionKey(selection)));return allowed[0]||candidates[0]||null; }
    function seedExplicitModel(modelId) { if([...explicitSelectionMemory.values()].some((selection)=>selection.model===modelId))return;const available=modelSelections(modelId,availableSelections()),modelDefault=defaultSelectionForModel(modelId),seed=available.find((selection)=>modelDefault&&selectionKey(selection)===selectionKey(modelDefault))||available[0];if(seed)explicitSelectionMemory.set(selectionKey(seed),seed); }
    function groupedModelSelections(modelId) { const unique=new Map();for(const selection of [...modelSelections(modelId,availableSelections()),...modelSelections(modelId,[...explicitSelectionMemory.values()])])unique.set(selectionKey(selection),selection);const groups=new Map();for(const selection of unique.values()){const entries=groups.get(selection.reasoningEffort)||[];entries.push(selection);groups.set(selection.reasoningEffort,entries);}return groups; }
    function renderExplicitPolicy() {
      const available=availableSelections(),availableKeys=new Set(available.map(selectionKey)),modelIds=[...new Set([...available.map((selection)=>selection.model),...[...explicitSelectionMemory.values()].map((selection)=>selection.model)])];
      elements.allowedModels.replaceChildren();
      for(const id of modelIds){const label=document.createElement("label"),checkbox=document.createElement("input"),model=modelFor(id),missing=!available.some((selection)=>selection.model===id);label.className="checkline";checkbox.type="checkbox";checkbox.dataset.action="model";checkbox.dataset.model=id;checkbox.checked=explicitSelectedModels.has(id);label.append(checkbox,document.createTextNode((model&&model.displayName||id)+" ["+id+"]"+(missing?" ("+t["settings.savedModel"]+")":"")));elements.allowedModels.appendChild(label);}
      elements.effortGroups.replaceChildren();
      for(const modelId of modelIds.filter((id)=>explicitSelectedModels.has(id))){
        const model=modelFor(modelId),groups=groupedModelSelections(modelId),card=document.createElement("fieldset"),header=document.createElement("div"),title=document.createElement("legend"),allLabel=document.createElement("label"),all=document.createElement("input"),options=document.createElement("div");
        card.className="effort-card";header.className="effort-card-header";title.className="effort-card-title";title.textContent=(model&&model.displayName||modelId)+" ["+modelId+"]";allLabel.className="checkline";all.type="checkbox";all.dataset.action="all-efforts";all.dataset.model=modelId;
        const allowedEfforts=[...groups].filter(([,entries])=>entries.some((selection)=>availableKeys.has(selectionKey(selection))));const selectedEfforts=[...groups].filter(([effort])=>exactSelectionsForEffort(modelId,effort).length>0);all.checked=allowedEfforts.length>0&&allowedEfforts.every(([effort])=>exactSelectionsForEffort(modelId,effort).length>0);all.indeterminate=!all.checked&&selectedEfforts.length>0;all.setAttribute("aria-checked",all.indeterminate?"mixed":String(all.checked));allLabel.title=all.indeterminate?t["settings.partialEffortsSelected"]:"";allLabel.append(all,document.createTextNode(t["settings.selectAllEfforts"]));header.append(allLabel);options.className="effort-options";
        for(const [effort,candidates] of groups){const primary=primarySelectionForEffort(modelId,effort,candidates);if(!primary)continue;const label=document.createElement("label"),checkbox=document.createElement("input"),effortAllowed=candidates.some((selection)=>availableKeys.has(selectionKey(selection)));label.className="checkline";checkbox.type="checkbox";checkbox.dataset.action="effort";checkbox.dataset.model=modelId;checkbox.dataset.effort=effort;checkbox.value=selectionKey(primary);checkbox.checked=exactSelectionsForEffort(modelId,effort).length>0;label.append(checkbox,document.createTextNode((t["effort."+effort+".label"]||effort)+(effortAllowed?"":" ("+t["settings.savedModel"]+")")));options.appendChild(label);}
        card.append(title,header,options);
        elements.effortGroups.appendChild(card);
      }
      elements.selectionCount.textContent=t["settings.selectionCount"].replace("{count}",String(checkedExplicitSelections().length));
    }
    function automaticCandidates() { return elements.allowedScope.value==="explicit"?checkedExplicitSelections():availableSelections(); }
    function renderPreferred(preferred) { const candidates=automaticCandidates(),wanted=preferred?selectionKey(preferred):elements.preferred.value;if(preferred&&!candidates.some((entry)=>selectionKey(entry)===wanted)&&!modelPolicyDirty&&wanted===savedPreferredKey)candidates.push(preferred);elements.preferred.replaceChildren(option("",t["settings.preferred.none"]));for(const selection of candidates){const available=availableSelections().some((entry)=>selectionKey(entry)===selectionKey(selection));elements.preferred.appendChild(option(selectionKey(selection),selectionLabel(selection)+(available?"":" ("+t["settings.savedModel"]+")")));}elements.preferred.value=candidates.some((entry)=>selectionKey(entry)===wanted)?wanted:""; }
    function ensureExplicitSelection() { if(elements.allowedScope.value!=="explicit"||explicitSelectedModels.size>0)return;const preferred=selectionFromKey(elements.preferred.value),modelId=preferred&&preferred.model||availableSelections()[0]&&availableSelections()[0].model;if(!modelId)return;explicitSelectedModels.add(modelId);seedExplicitModel(modelId);renderExplicitPolicy(); }
    function updatePolicyControls() { const fixed=elements.mode.value==="fixed",explicit=!fixed&&elements.allowedScope.value==="explicit";elements.fixedPanel.hidden=!fixed;elements.automaticPanel.hidden=fixed;elements.explicitPanel.hidden=!explicit;elements.model.disabled=!fixed;elements.effort.disabled=!fixed;elements.allowedScope.disabled=fixed;elements.preferred.disabled=fixed;if(explicit)ensureExplicitSelection();for(const checkbox of[...elements.allowedModels.querySelectorAll('input[type="checkbox"]'),...elements.effortGroups.querySelectorAll('input[type="checkbox"]')])checkbox.disabled=!explicit;renderPreferred(selectionFromKey(elements.preferred.value)); }
    function renderModelPolicy(policy,legacyPreferred) { elements.delegation.checked=policy.constraints&&policy.constraints.allowDelegation!==false;elements.mode.value=policy.mode;const preferred=policy.mode==="automatic"?policy.preferredSelection||legacyPreferred:null;const seed=policy.mode==="fixed"?policy.selection:preferred||availableSelections()[0];renderFixedSelection(seed);elements.allowedScope.value=policy.mode==="automatic"?policy.allowedSelections.kind:"catalog-visible";const selected=policy.mode==="automatic"&&policy.allowedSelections.kind==="explicit"?policy.allowedSelections.selections:(policy.mode==="fixed"?[policy.selection]:(preferred?[preferred]:[]));explicitSelectedModels.clear();explicitSelectionMemory.clear();for(const selection of selected){explicitSelectionMemory.set(selectionKey(selection),selection);if(policy.mode==="automatic"&&policy.allowedSelections.kind==="explicit")explicitSelectedModels.add(selection.model);}savedPreferredKey=preferred?selectionKey(preferred):"";renderExplicitPolicy();renderPreferred(policy.mode==="automatic"?preferred:policy.selection);updatePolicyControls(); }
    function buildModelPolicy() { const constraints={allowDelegation:elements.delegation.checked};if(elements.mode.value==="fixed"){const selection=currentFixedSelection();if(!selection)throw new Error(t["settings.selectionRequired"]);return{mode:"fixed",selection,constraints};}const explicit=elements.allowedScope.value==="explicit",selections=checkedExplicitSelections();if(explicit&&selections.length===0)throw new Error(t["settings.explicitRequired"]);if(explicit)for(const modelId of explicitSelectedModels)if(!selections.some((selection)=>selection.model===modelId))throw new Error(t["settings.modelEffortRequired"].replace("{model}",modelId));const preferredSelection=selectionFromKey(elements.preferred.value);return{mode:"automatic",...(preferredSelection?{preferredSelection}:{}),allowedSelections:explicit?{kind:"explicit",selections}:{kind:"catalog-visible"},constraints}; }
    function projectRows() { return [...elements.projectList.querySelectorAll(".project-row")]; }
    function normalizeProjectId(value) { const normalized=String(value||"").normalize("NFKC").trim().toLowerCase().replace(/[\s_]+/gu,"-").replace(/-+/g,"-");if(!normalized||normalized.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized))throw new Error(t["settings.projectInvalidId"]);return normalized; }
    function normalizeProjectLabel(value) { const normalized=String(value||"").normalize("NFC").trim();if(!normalized||[...normalized].length>120||/[\u0000-\u001f\u007f-\u009f]/u.test(normalized))throw new Error(t["settings.projectInvalidLabel"]);return normalized; }
    function normalizedPathKey(value) { const input=String(value||"").trim();if(!input.startsWith("/")||/[\r\n\u0000]/u.test(input))throw new Error(t["settings.projectInvalidCwd"]);const parts=[];for(const part of input.split("/")){if(!part||part===".")continue;if(part===".."){parts.pop();continue;}parts.push(part);}return"/"+parts.join("/"); }
    function clearProjectError() { elements.projectError.textContent="";elements.projectError.classList.remove("show"); }
    function showProjectError(message) { elements.projectError.textContent=message;elements.projectError.classList.add("show"); }
    function projectErrorMessage(value) { if(value.includes("PROJECT_DUPLICATE_ID"))return t["settings.projectDuplicateId"];if(value.includes("PROJECT_DUPLICATE_PATH"))return t["settings.projectDuplicatePath"];if(value.includes("PROJECT_ID_INVALID"))return t["settings.projectInvalidId"];if(value.includes("PROJECT_LABEL_INVALID"))return t["settings.projectInvalidLabel"];if(value.includes("PROJECT_CWD_INVALID")||value.includes("PROJECT_CWD_NOT_ALLOWED"))return t["settings.projectInvalidCwd"];if(value.includes("PROJECT_DEFAULT_NOT_FOUND"))return t["settings.projectDefaultMissing"];if(value.includes("PROJECT_UNAVAILABLE")||value.includes("DEFAULT_CWD_NOT_ALLOWED"))return t["settings.projectUnavailableSave"];return t["settings.projectError"]; }
    function projectField(key,input,className) { const label=document.createElement("label"),title=document.createElement("span");title.className=className;title.textContent=t[key];label.append(title,input);return label; }
    function updateProjectEmptyState() { const count=projectRows().length;elements.noProjects.hidden=count>0;elements.addProject.disabled=count>=100;elements.addProject.title=count>=100?t["settings.projectLimit"]:""; }
    function projectOptionLabel(row,id) { const label=row.querySelector(".project-label-input").value.trim();return(label||id)+" ["+id+"]"+(row.dataset.available==="false"?" ("+t["settings.projectUnavailable"]+")":""); }
    function renderDefaultProjectOptions(preferred) { const wanted=preferred===undefined?elements.defaultProject.value:String(preferred||"");elements.defaultProject.replaceChildren(option("",t["settings.defaultProjectNone"]));for(const row of projectRows()){const input=row.querySelector(".project-id-input");let id;try{id=normalizeProjectId(input.value);}catch{continue;}elements.defaultProject.appendChild(option(id,projectOptionLabel(row,id)));}elements.defaultProject.value=[...elements.defaultProject.options].some((entry)=>entry.value===wanted)?wanted:""; }
    function localizeProjectRows() { for(const row of projectRows()){row.querySelector(".project-id-title").textContent=t["settings.projectId"];row.querySelector(".project-label-title").textContent=t["settings.projectLabel"];row.querySelector(".project-cwd-title").textContent=t["settings.projectCwd"];const id=row.querySelector(".project-id-input");id.title=id.readOnly?t["settings.projectIdHint"]:"";const status=row.querySelector(".project-availability");status.textContent=row.dataset.persisted==="false"?t["settings.projectNew"]:row.dataset.available==="false"?t["settings.projectUnavailable"]:t["settings.projectAvailable"];row.querySelector(".project-remove").textContent=t["settings.removeProject"];}renderDefaultProjectOptions();updateProjectEmptyState(); }
    function appendProjectRow(project,persisted=false,available=true) {
      const row=document.createElement("div"),id=document.createElement("input"),label=document.createElement("input"),cwd=document.createElement("input"),actions=document.createElement("div"),status=document.createElement("span"),remove=document.createElement("button");
      row.className="project-row"+(available?"":" unavailable");row.dataset.persisted=String(persisted);row.dataset.available=String(available);
      id.className="project-id-input";id.type="text";id.required=true;id.maxLength=256;id.autocomplete="off";id.spellcheck=false;id.value=project.id||"";id.readOnly=persisted;
      label.className="project-label-input";label.type="text";label.required=true;label.maxLength=1000;label.autocomplete="off";label.value=project.label||"";
      cwd.className="project-cwd-input";cwd.type="text";cwd.required=true;cwd.maxLength=4096;cwd.autocomplete="off";cwd.spellcheck=false;cwd.setAttribute("list","allowed-roots");cwd.value=project.cwd||"";
      actions.className="project-row-actions";status.className="project-availability"+(available?"":" unavailable");remove.className="project-remove";remove.type="button";
      actions.append(status,remove);row.append(projectField("settings.projectId",id,"project-id-title"),projectField("settings.projectLabel",label,"project-label-title"),projectField("settings.projectCwd",cwd,"project-cwd-title"),actions);elements.projectList.appendChild(row);
      for(const input of[id,label,cwd])input.addEventListener("input",()=>{input.setCustomValidity("");clearProjectError();if(input===id||input===label)renderDefaultProjectOptions();});
      id.addEventListener("blur",()=>{try{id.value=normalizeProjectId(id.value);id.setCustomValidity("");renderDefaultProjectOptions();}catch(error){id.setCustomValidity(error.message);showProjectError(error.message);}});
      remove.addEventListener("click",()=>{row.remove();clearProjectError();renderDefaultProjectOptions();updateProjectEmptyState();});
      localizeProjectRows();return row;
    }
    function renderProjects(settings,limits) { elements.projectList.replaceChildren();elements.roots.replaceChildren();elements.rootList.replaceChildren();for(const root of limits.allowedRoots||[]){elements.roots.appendChild(option(root,root));const item=document.createElement("li"),code=document.createElement("code");code.textContent=root;item.appendChild(code);elements.rootList.appendChild(item);}const availability=new Map((limits.projectAvailability||[]).map((entry)=>[entry.id,entry.available]));for(const project of settings.projects||[])appendProjectRow(project,true,availability.get(project.id)!==false);renderDefaultProjectOptions(settings.defaultProjectId);updateProjectEmptyState();clearProjectError(); }
    function buildProjectSettings() {
      clearProjectError();const records=[];let firstInvalid=null;
      for(const row of projectRows()){const idInput=row.querySelector(".project-id-input"),labelInput=row.querySelector(".project-label-input"),cwdInput=row.querySelector(".project-cwd-input");for(const input of[idInput,labelInput,cwdInput])input.setCustomValidity("");let id,label,cwd,pathKey;try{id=normalizeProjectId(idInput.value);idInput.value=id;}catch(error){idInput.setCustomValidity(error.message);firstInvalid||=idInput;}try{label=normalizeProjectLabel(labelInput.value);labelInput.value=label;}catch(error){labelInput.setCustomValidity(error.message);firstInvalid||=labelInput;}try{cwd=String(cwdInput.value||"").trim();pathKey=normalizedPathKey(cwd);cwdInput.value=cwd;}catch(error){cwdInput.setCustomValidity(error.message);firstInvalid||=cwdInput;}records.push({id,label,cwd,pathKey,idInput,cwdInput});}
      const ids=new Map(),paths=new Map();for(const record of records){if(record.id){const previous=ids.get(record.id);if(previous){record.idInput.setCustomValidity(t["settings.projectDuplicateId"]);previous.setCustomValidity(t["settings.projectDuplicateId"]);firstInvalid||=previous;}else ids.set(record.id,record.idInput);}if(record.pathKey){const previous=paths.get(record.pathKey);if(previous){record.cwdInput.setCustomValidity(t["settings.projectDuplicatePath"]);previous.setCustomValidity(t["settings.projectDuplicatePath"]);firstInvalid||=previous;}else paths.set(record.pathKey,record.cwdInput);}}
      if(firstInvalid){const message=firstInvalid.validationMessage||t["settings.projectError"];showProjectError(message);firstInvalid.reportValidity();return null;}const projects=records.map(({id,label,cwd})=>({id,label,cwd})),defaultProjectId=elements.defaultProject.value||null;if(defaultProjectId&&!projects.some((project)=>project.id===defaultProjectId)){showProjectError(t["settings.projectDefaultMissing"]);return null;}return{projects,defaultProjectId};
    }
    function buildProjectOperations(projects) { const previous=new Map((view.settings.projects||[]).map((project)=>[project.id,project])),next=new Map(projects.map((project)=>[project.id,project])),operations=[];for(const project of previous.values())if(!next.has(project.id))operations.push({kind:"remove",projectId:project.id});for(const project of projects){const saved=previous.get(project.id);if(!saved){operations.push({kind:"add",project});continue;}if(project.label!==saved.label)operations.push({kind:"rename",projectId:project.id,label:project.label});if(project.cwd!==saved.cwd)operations.push({kind:"relocate",projectId:project.id,cwd:project.cwd});}return operations; }
    function updateAccessNotice() { const value=elements.access.value;const key=value==="read-only"?"settings.access.readOnlyHint":value==="always-full"?"settings.access.fullHint":"settings.access.adaptiveHint";elements.accessHint.textContent=t[key];elements.fullWarning.classList.toggle("show",value==="always-full"); }
    function updateCardPolicy() { const hidden=elements.cardVisibility.value==="never";if(hidden)elements.handoff.value="off";elements.handoff.disabled=hidden;elements.handoffHint.textContent=hidden?t["settings.handoffRequiresCard"]:""; }
    function render(next,localeReady=false,preserveLocalePreference=false) { if(!next||!next.settings)return;view=next;const settings=next.settings,limits=next.capabilities;if(!preserveLocalePreference)localePreference=settings.uiLocalePreference||"auto";if(!localeReady)setLocale(effectiveLocaleTag(),false);elements.access.replaceChildren();const accessLabels={"read-only":t["settings.access.readOnly"],adaptive:t["settings.access.adaptive"],"always-full":t["settings.access.full"]};for(const value of limits.availableAccessStrategies||[])elements.access.appendChild(option(value,accessLabels[value]||value));elements.access.value=settings.accessStrategy;elements.priority.checked=settings.usePriorityServiceTier===true;modelPolicyDirty=false;renderModelPolicy(settings.modelPolicy,settings.legacyPreferredModel?defaultSelectionForModel(settings.legacyPreferredModel):null);renderProjects(settings,limits);elements.language.replaceChildren();for(const value of limits.availableUiLocalePreferences||["auto",...Object.keys(LANGUAGE_LABELS)])elements.language.appendChild(option(value,value==="auto"?t["settings.language.auto"]:LANGUAGE_LABELS[value]||value));elements.language.value=localePreference;elements.concurrency.value=String(settings.maxConcurrentJobs);elements.concurrency.max=String(limits.maxConcurrentJobs);elements.cardVisibility.value=settings.activityCardVisibility||"always";elements.handoff.value=settings.completionHandoff||"off";updateAccessNotice();updateCardPolicy();const catalogProblem=Boolean(next.catalog.warning||next.catalog.stale||next.catalog.validation==="invalid"),warnings=[next.catalog.warning,...(next.warnings||[])].filter(Boolean).join("\n")||(catalogProblem?t["common.error"]:"");elements.catalogWarningText.textContent=warnings;elements.catalogWarning.classList.toggle("show",Boolean(warnings));elements.retryModels.hidden=!catalogProblem; }
    function setBusy(busy,message) { for(const node of[elements.save,elements.retryModels,elements.reset])node.disabled=busy;elements.addProject.disabled=busy||projectRows().length>=100;elements.status.classList.remove("error");elements.status.textContent=message||""; }
    function setError(error) { elements.status.classList.add("error");elements.status.textContent=error instanceof Error?error.message:String(error); }
    async function handleMutationError(error) { const value=error instanceof Error?error.message:String(error);if(value.includes("PROJECT_")||value.includes("DEFAULT_CWD_NOT_ALLOWED")){setBusy(false);showProjectError(projectErrorMessage(value));elements.status.classList.add("error");elements.status.textContent=t["settings.projectError"];return;}if(!value.includes("SETTINGS_REVISION_CONFLICT")){setBusy(false);setError(error);return;}try{render(unwrap(await callTool("codex_settings",{})));setBusy(false);elements.status.classList.add("error");elements.status.textContent=t["settings.conflict"];}catch(refreshError){setBusy(false);setError(refreshError);} }
    function integerValue(input) { const value=Number(input.value);if(!Number.isSafeInteger(value))throw new Error(t["common.error"]);return value; }
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.id!==undefined&&pendingRequests.has(message.id)){const pending=pendingRequests.get(message.id);pendingRequests.delete(message.id);message.error?pending.reject(new Error(message.error.message||t["common.error"])):pending.resolve(message.result);return;}if(message.method==="ui/notifications/tool-result")render(message.params&&message.params.structuredContent);},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event.detail&&event.detail.globals,metadata=globals&&globals.toolResponseMetadata;const responseHostLocale=metadata&&(metadata.hostLocale||metadata["webplus/i18n"]||metadata["openai/locale"]);if(globals&&globals.locale)hostLocaleTag=String(globals.locale);else if(responseHostLocale)hostLocaleTag=String(responseHostLocale);if(localePreference==="auto"){setLocale(hostLocaleTag,false);updateAccessNotice();updateCardPolicy();localizeProjectRows();}if(globals&&globals.toolOutput)render(globals.toolOutput);});
    window.addEventListener("pagehide",()=>{for(const [id,request] of pendingRequests){window.parent.postMessage({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:id,reason:"Settings card unmounted"}},"*");request.reject(new Error("Settings card unmounted"));}pendingRequests.clear();});
    elements.access.addEventListener("change",updateAccessNotice);
    elements.cardVisibility.addEventListener("change",updateCardPolicy);
    elements.addProject.addEventListener("click",()=>{if(projectRows().length>=100){showProjectError(t["settings.projectLimit"]);return;}const row=appendProjectRow({id:"",label:"",cwd:""});updateProjectEmptyState();row.querySelector(".project-id-input").focus();});
    elements.mode.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();});
    elements.delegation.addEventListener("change",()=>{modelPolicyDirty=true;const fixed=currentFixedSelection(),preferred=selectionFromKey(elements.preferred.value);renderFixedSelection(fixed);renderExplicitPolicy();renderPreferred(preferred);updatePolicyControls();});
    elements.model.addEventListener("change",()=>{modelPolicyDirty=true;renderFixedEfforts(null);});
    elements.effort.addEventListener("change",()=>{modelPolicyDirty=true;updateEffortHelper();elements.effortCompatibility.textContent="";});
    elements.allowedScope.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();renderExplicitPolicy();});
    elements.allowedModels.addEventListener("change",(event)=>{const target=event.target;if(!(target instanceof HTMLInputElement)||target.dataset.action!=="model")return;modelPolicyDirty=true;const modelId=target.dataset.model;if(!modelId)return;if(target.checked){explicitSelectedModels.add(modelId);seedExplicitModel(modelId);}else explicitSelectedModels.delete(modelId);const preferred=selectionFromKey(elements.preferred.value);renderExplicitPolicy();renderPreferred(preferred);});
    elements.effortGroups.addEventListener("change",(event)=>{const target=event.target;if(!(target instanceof HTMLInputElement))return;modelPolicyDirty=true;const action=target.dataset.action,modelId=target.dataset.model;if(action==="all-efforts"&&modelId){if(target.checked){const availableKeys=new Set(availableSelections().map(selectionKey));for(const [effort,candidates] of groupedModelSelections(modelId)){if(!candidates.some((selection)=>availableKeys.has(selectionKey(selection)))||exactSelectionsForEffort(modelId,effort).length>0)continue;const primary=primarySelectionForEffort(modelId,effort,candidates);if(primary)explicitSelectionMemory.set(selectionKey(primary),primary);}}else for(const [key,selection] of explicitSelectionMemory)if(selection.model===modelId)explicitSelectionMemory.delete(key);}else if(action==="effort"&&modelId){const effort=target.dataset.effort;if(!effort)return;if(target.checked){if(exactSelectionsForEffort(modelId,effort).length===0){const selection=selectionFromKey(target.value);if(selection)explicitSelectionMemory.set(selectionKey(selection),selection);}}else for(const [key,selection] of explicitSelectionMemory)if(selection.model===modelId&&selection.reasoningEffort===effort)explicitSelectionMemory.delete(key);}else return;const preferred=selectionFromKey(elements.preferred.value);renderExplicitPolicy();renderPreferred(preferred);});
    elements.preferred.addEventListener("change",()=>{modelPolicyDirty=true;});
    elements.language.addEventListener("change",()=>{localePreference=elements.language.value;setLocale(effectiveLocaleTag(),false);updateAccessNotice();updateCardPolicy();updateEffortHelper();renderExplicitPolicy();renderPreferred(selectionFromKey(elements.preferred.value));localizeProjectRows();});
    elements.form.addEventListener("submit",async(event)=>{event.preventDefault();if(!view)return;const projectSettings=buildProjectSettings();if(!projectSettings||!elements.form.reportValidity())return;setBusy(true,t["settings.saving"]);try{const settings={accessStrategy:elements.access.value,usePriorityServiceTier:elements.priority.checked,defaultProjectId:projectSettings.defaultProjectId,uiLocalePreference:elements.language.value,maxConcurrentJobs:integerValue(elements.concurrency),activityCard:{visibility:elements.cardVisibility.value,completionHandoff:elements.handoff.value}},projectOperations=buildProjectOperations(projectSettings.projects);if(projectOperations.length)settings.projectOperations=projectOperations;if(modelPolicyDirty)settings.modelPolicy=buildModelPolicy();const args={expectedRevision:view.settings.revision,operation:{kind:"patch",settings}};const result=await callTool("codex_update_settings",args);render(unwrap(result));setBusy(false,t["settings.saved"]);}catch(error){await handleMutationError(error);}});
    elements.retryModels.addEventListener("click",async()=>{setBusy(true,t["settings.refreshing"]);try{render(unwrap(await callTool("codex_settings",{refreshModels:true})));setBusy(false,t["settings.refreshed"]);}catch(error){setBusy(false);setError(error);}});
    elements.reset.addEventListener("click",async()=>{if(!view)return;setBusy(true,t["settings.resetting"]);try{render(unwrap(await callTool("codex_update_settings",{expectedRevision:view.settings.revision,operation:{kind:"reset"}})));setBusy(false,t["settings.resetDone"]);}catch(error){await handleMutationError(error);}});
    setLocale(localeTag);if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);else callTool("codex_settings",{}).then((result)=>render(unwrap(result))).catch(setError);
  </script>
</body>
</html>`;
