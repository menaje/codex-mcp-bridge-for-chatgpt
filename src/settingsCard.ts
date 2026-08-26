import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializedUiTranslations } from "./uiI18n.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  currentUiResourceUri,
  htmlForUiResource,
  uiResourceRevisions
} from "./uiResources.js";

export const SETTINGS_CARD_URI = currentUiResourceUri("settings");
export const SETTINGS_CARD_CONTRACT_GENERATION = 7;
export const RETAINED_SETTINGS_CARD_CONTRACT_GENERATION = 7;
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
    `Configure named projects, saved access, model/effort policy, independent Priority processing, interface-language, concurrency, and Activity-card visibility for ${PRODUCT_INFO.displayName}.`,
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com",
  "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
} as const;

export const SETTINGS_PROJECT_ID_HELPERS = String.raw`
    function projectIdStem(value) { return String(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").replace(/-+/g,"-").slice(0,64).replace(/-+$/g,""); }
    function allocateProjectId(label,cwd,reserved) { const folder=String(cwd||"").replace(/\/+$/g,"").split("/").pop()||"",base=projectIdStem(label)||projectIdStem(folder)||"project";if(!reserved.has(base))return base;for(let suffix=2;suffix<10000;suffix+=1){const tail="-"+suffix,candidate=(base.slice(0,64-tail.length).replace(/-+$/g,"")||"project")+tail;if(!reserved.has(candidate))return candidate;}throw new Error("PROJECT_ID_ALLOCATION_FAILED"); }
    function validProjectId(value) { return typeof value==="string"&&value.length>0&&value.length<=64&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }`;

export function uiBridgeErrorMessage(
  value: unknown,
  fallback = "Something went wrong."
): string {
  const visited = new Set<object>();
  const visit = (candidate: unknown): string => {
    if (typeof candidate === "string") {
      const message = candidate.trim();
      return message === "[object Object]" ? "" : message;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return String(candidate);
    }
    if (candidate === null || typeof candidate !== "object") return "";
    if (visited.has(candidate)) return "";
    visited.add(candidate);

    const record = candidate as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    let message = "";
    for (const key of ["message", "error", "data", "cause", "detail", "details"]) {
      message = visit(record[key]);
      if (message) break;
    }
    if (!message && Array.isArray(record.content)) {
      for (const item of record.content) {
        if (
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          message = visit((item as Record<string, unknown>).text);
          if (message) break;
        }
      }
    }
    if (!message) {
      try {
        const serialized = JSON.stringify(candidate);
        if (serialized && serialized !== "{}") message = serialized;
      } catch {
        // Circular or otherwise non-serializable host errors fall through.
      }
    }
    if (code && message && !message.includes(code)) return `${code}: ${message}`;
    return message || code;
  };

  return visit(value) || fallback;
}

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
    .project-list { display:grid; gap:9px; margin-top:10px; }
    .project-row { display:grid; grid-template-columns:minmax(160px,.8fr) minmax(240px,1.4fr) auto; gap:8px; align-items:end; padding:10px; border:1px solid var(--border); border-radius:10px; }
    .project-row.unavailable { border-color:color-mix(in srgb,var(--danger) 45%,transparent); }
    .project-row label { min-width:0; }
    .project-row-actions { display:grid; gap:6px; justify-items:end; }
    .project-availability { font-size:10px; color:var(--muted); white-space:nowrap; }
    .project-availability.unavailable { color:var(--danger); font-weight:650; }
    .project-remove { color:var(--danger); }
    .no-projects { margin:10px 0 0; padding:12px; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border)); border-radius:10px; background:color-mix(in srgb,var(--accent) 7%,transparent); font-size:12px; line-height:1.5; }
    .field-error { display:none; margin:8px 0 0; color:var(--danger); font-size:12px; line-height:1.4; }
    .field-error.show { display:block; }
    .notice { margin-top:12px; padding:10px; border:1px solid var(--border); border-radius:10px; font-size:12px; color:var(--muted); line-height:1.45; }
    .experimental-notice { margin:0 0 14px; border-color:color-mix(in srgb,var(--danger) 45%,transparent); color:var(--danger); }
    .inline-warning { color:var(--danger); }
    .warning { display:none; margin-top:12px; border:1px solid color-mix(in srgb,var(--danger) 45%,transparent); border-radius:10px; padding:10px; color:var(--danger); font-size:12px; line-height:1.45; white-space:pre-line; }
    .warning.show { display:block; } .warning button { margin-top:8px; } .access-warning { margin-top:2px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:16px; }
    button { min-height:36px; border:1px solid var(--border); border-radius:10px; padding:7px 12px; background:Canvas; color:CanvasText; font-weight:650; cursor:pointer; }
    button.primary { border-color:var(--accent); background:var(--accent); color:white; } button:disabled { cursor:wait; opacity:.6; }
    #status { flex:1; min-width:180px; font-size:12px; color:var(--muted); text-align:right; } #status.error { color:var(--danger); }
    @media (max-width:700px) { .project-row{grid-template-columns:1fr 1fr}.project-row-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;width:100%} }
    @media (max-width:560px) { .grid,.explicit-layout,.project-row{grid-template-columns:1fr}.wide{grid-column:auto}.projects-header{display:grid}.project-row-actions{grid-column:auto}#status{text-align:left} }
  </style>
</head>
<body>
  <main class="card">
    <header><div><h1>${PRODUCT_INFO.displayName}</h1><p class="scope" data-i18n="settings.scope"></p></div></header>
    <aside class="notice experimental-notice" data-i18n="settings.appServerExperimental"></aside>
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
            <label class="wide"><span data-i18n="settings.allowedScope"></span><select id="allowed-scope"><option value="catalog-visible" data-i18n="settings.allowedScope.catalog"></option><option value="explicit" data-i18n="settings.allowedScope.explicit"></option></select></label>
            <label><span data-i18n="settings.preferredModel"></span><select id="preferred-model"></select></label>
            <label><span data-i18n="settings.preferredEffort"></span><select id="preferred-effort"></select></label>
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
          <div class="project-list" id="project-list"></div>
          <p class="no-projects" id="no-projects" data-i18n="settings.noProjects"></p>
          <p class="field-error" id="project-error" role="alert" aria-live="polite"></p>
        </section>
        <label><span data-i18n="settings.language"></span><select id="ui-language"></select><span class="hint" data-i18n="settings.languageHint"></span></label>
        <label><span data-i18n="settings.concurrency"></span><input id="concurrency" type="number" min="1" step="1" required /></label>
        <label><span data-i18n="settings.cardVisibility"></span><select id="activity-card-visibility"><option value="always" data-i18n="settings.cardVisibility.always"></option><option value="background-only" data-i18n="settings.cardVisibility.background"></option><option value="never" data-i18n="settings.cardVisibility.never"></option></select></label>
        <label><span data-i18n="settings.handoff"></span><select id="completion-handoff"><option value="off" data-i18n="settings.handoff.off"></option><option value="auto-handoff" data-i18n="settings.handoff.auto"></option></select><span class="hint" id="handoff-hint"></span></label>
      </div>
      <div class="warning" id="catalog-warning" role="status" aria-live="polite"><span id="catalog-warning-text"></span><br /><button id="retry-models" type="button" data-i18n="settings.refreshModels" hidden></button></div>
      <div class="actions"><button class="primary" id="save" type="submit" data-i18n="settings.save"></button><button id="reset" type="button" data-i18n="settings.reset"></button><span id="status" role="status" aria-live="polite"></span></div>
      <div class="hint" data-i18n="settings.resetHint"></div>
    </form>
  </main>
  <script>
    const BUNDLES = ${serializedUiTranslations()};
    ${uiBridgeErrorMessage.toString()}
    const pendingRequests = new Map();
    const REQUEST_TIMEOUT_MS = 90000;
    let nextRequestId = 1;
    let standardBridgeReady = Promise.resolve(false);
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
    const elements = { form:byId("settings-form"),access:byId("access-strategy"),accessHint:byId("access-hint"),mode:byId("model-policy-mode"),delegation:byId("allow-delegation"),priority:byId("use-priority-service-tier"),fixedPanel:byId("fixed-policy-panel"),automaticPanel:byId("automatic-policy-panel"),model:byId("policy-model"),effort:byId("policy-effort"),effortDescription:byId("effort-description"),effortCompatibility:byId("effort-compatibility"),allowedScope:byId("allowed-scope"),preferredModel:byId("preferred-model"),preferredEffort:byId("preferred-effort"),explicitPanel:byId("explicit-selection-panel"),allowedModels:byId("allowed-models"),effortGroups:byId("effort-groups"),selectionCount:byId("selection-count"),addProject:byId("add-project"),projectList:byId("project-list"),noProjects:byId("no-projects"),projectError:byId("project-error"),language:byId("ui-language"),concurrency:byId("concurrency"),cardVisibility:byId("activity-card-visibility"),handoff:byId("completion-handoff"),handoffHint:byId("handoff-hint"),save:byId("save"),retryModels:byId("retry-models"),reset:byId("reset"),status:byId("status"),fullWarning:byId("full-warning"),catalogWarning:byId("catalog-warning"),catalogWarningText:byId("catalog-warning-text") };
    const LANGUAGE_LABELS = {en:"English",ko:"한국어",ja:"日本語","zh-Hans":"简体中文","zh-Hant":"繁體中文",es:"Español",fr:"Français",de:"Deutsch",pt:"Português"};
    const KNOWN_EFFORTS = new Set(["minimal","low","medium","high","xhigh","max","ultra"]);
    function resolveLocale(value) { const v=String(value||"en").replaceAll("_","-").toLowerCase(); if(v==="ko"||v.startsWith("ko-"))return"ko";if(v==="ja"||v.startsWith("ja-"))return"ja";if(v==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(v))return"zh-Hant";if(v==="zh"||v==="zh-hans"||v.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(v===key||v.startsWith(key+"-"))return key;return"en"; }
    function effectiveLocaleTag() { return localePreference==="auto"?hostLocaleTag:localePreference; }
    function setLocale(value,rerender=true) { localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;for(const node of document.querySelectorAll("[data-i18n]"))node.textContent=t[node.dataset.i18n]||BUNDLES.en[node.dataset.i18n]||node.dataset.i18n;if(rerender&&view)render(view,true,true); }
    function option(value,label) { const node=document.createElement("option");node.value=value;node.textContent=label;return node; }
    function rpcRequest(method,params,timeout=REQUEST_TIMEOUT_MS) { return new Promise((resolve,reject)=>{const id=nextRequestId++;const timer=setTimeout(()=>{pendingRequests.delete(id);reject(new Error(t["common.error"]));},timeout);pendingRequests.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v);},reject:(e)=>{clearTimeout(timer);reject(e);}});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");}); }
    function rpcNotification(method,params) { window.parent.postMessage({jsonrpc:"2.0",method,params},"*"); }
    async function initializeStandardBridge() { try { const result=await rpcRequest("ui/initialize",{appInfo:{name:"codex-mcp-bridge-settings",version:"${SETTINGS_CARD_CONTRACT_GENERATION}"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},5000);if(!result||typeof result.protocolVersion!=="string")return false;document.documentElement.dataset.mcpApps="initialized";const context=result.hostContext||{};if(context.locale)hostLocaleTag=String(context.locale);rpcNotification("ui/notifications/initialized",{});if(localePreference==="auto")setLocale(hostLocaleTag);return true;}catch{document.documentElement.dataset.mcpApps="fallback";return false;} }
    async function callTool(name,args) { if(window.openai&&typeof window.openai.callTool==="function"){try{return await window.openai.callTool(name,args);}catch(error){throw new Error(uiBridgeErrorMessage(error,t["common.error"]));}}await standardBridgeReady;return rpcRequest("tools/call",{name,arguments:args}); }
    function toolText(result) { const entry=result&&Array.isArray(result.content)&&result.content.find((item)=>item&&item.type==="text"&&typeof item.text==="string");return entry&&entry.text||""; }
    function parsedToolText(result) { const value=toolText(result);if(!value)return null;try{return JSON.parse(value);}catch{return null;} }
    function toolErrorMessage(result,parsed) { const payload=result&&result.structuredContent||parsed||result,error=payload&&payload.error,message=uiBridgeErrorMessage(error,"");return message||toolText(result)||uiBridgeErrorMessage(result,t["common.error"]); }
    function privateSettingsView(metadata) { const candidate=metadata&&metadata["codex/settingsView"];return candidate&&candidate.settings&&candidate.capabilities&&candidate.catalog?candidate:null; }
    function unwrap(result) { if(result&&result._meta){const responseHostLocale=result._meta.hostLocale||result._meta["webplus/i18n"];if(responseHostLocale)hostLocaleTag=String(responseHostLocale);}const parsed=parsedToolText(result),next=privateSettingsView(result&&result._meta)||result&&result.structuredContent||parsed||result;if(result&&result.isError||next&&next.error&&!next.settings)throw new Error(toolErrorMessage(result,parsed));if(!next||!next.settings||!next.capabilities||!next.catalog||(next.settings.projects||[]).some((project)=>typeof project.cwd!=="string")){const text=toolText(result);if(text&&!parsed)throw new Error(text);throw new Error(t["settings.invalidResponse"]);}return next; }
    function modelFor(id) { return view&&view.catalog.models.find((entry)=>entry.id===id); }
    function defaultSelectionForModel(id) { const model=modelFor(id);if(!model)return null;const effort=model.defaultReasoningEffort||(model.supportedReasoningEfforts&&model.supportedReasoningEfforts[0]&&model.supportedReasoningEfforts[0].effort);return effort?{model:model.id,reasoningEffort:effort}:null; }
    function selectionKey(selection) { return JSON.stringify([selection.model,selection.reasoningEffort]); }
    function selectionFromKey(value) { if(!value)return null;try{const parts=JSON.parse(value);if(!Array.isArray(parts)||typeof parts[0]!=="string"||typeof parts[1]!=="string")return null;return{model:parts[0],reasoningEffort:parts[1]};}catch{return null;} }
    function modelDisplayName(id) { const model=modelFor(id);return model&&model.displayName||id; }
    function effortPresentationFor(modelId,effort) { const model=modelFor(modelId),entry=model&&(model.supportedReasoningEfforts||[]).find((item)=>item.effort===effort),known=KNOWN_EFFORTS.has(effort),label=known?(t["effort."+effort+".label"]||effort):effort;if(locale==="en"&&entry&&entry.description)return{label,description:entry.description,source:"upstream"};if(known)return{label,description:t["effort."+effort+".description"],source:"localized"};return{label,description:t["settings.effortFallbackDescription"],source:"fallback"}; }
    function effortPresentation(effort) { return effortPresentationFor(elements.model.value,effort); }
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
      for(const id of modelIds){const label=document.createElement("label"),checkbox=document.createElement("input"),missing=!available.some((selection)=>selection.model===id);label.className="checkline";checkbox.type="checkbox";checkbox.dataset.action="model";checkbox.dataset.model=id;checkbox.checked=explicitSelectedModels.has(id);label.append(checkbox,document.createTextNode(modelDisplayName(id)+(missing?" ("+t["settings.savedModel"]+")":"")));elements.allowedModels.appendChild(label);}
      elements.effortGroups.replaceChildren();
      for(const modelId of modelIds.filter((id)=>explicitSelectedModels.has(id))){
        const groups=groupedModelSelections(modelId),card=document.createElement("fieldset"),header=document.createElement("div"),title=document.createElement("legend"),allLabel=document.createElement("label"),all=document.createElement("input"),options=document.createElement("div");
        card.className="effort-card";header.className="effort-card-header";title.className="effort-card-title";title.textContent=modelDisplayName(modelId);allLabel.className="checkline";all.type="checkbox";all.dataset.action="all-efforts";all.dataset.model=modelId;
        const allowedEfforts=[...groups].filter(([,entries])=>entries.some((selection)=>availableKeys.has(selectionKey(selection))));const selectedEfforts=[...groups].filter(([effort])=>exactSelectionsForEffort(modelId,effort).length>0);all.checked=allowedEfforts.length>0&&allowedEfforts.every(([effort])=>exactSelectionsForEffort(modelId,effort).length>0);all.indeterminate=!all.checked&&selectedEfforts.length>0;all.setAttribute("aria-checked",all.indeterminate?"mixed":String(all.checked));allLabel.title=all.indeterminate?t["settings.partialEffortsSelected"]:"";allLabel.append(all,document.createTextNode(t["settings.selectAllEfforts"]));header.append(allLabel);options.className="effort-options";
        for(const [effort,candidates] of groups){const primary=primarySelectionForEffort(modelId,effort,candidates);if(!primary)continue;const label=document.createElement("label"),checkbox=document.createElement("input"),effortAllowed=candidates.some((selection)=>availableKeys.has(selectionKey(selection)));label.className="checkline";checkbox.type="checkbox";checkbox.dataset.action="effort";checkbox.dataset.model=modelId;checkbox.dataset.effort=effort;checkbox.value=selectionKey(primary);checkbox.checked=exactSelectionsForEffort(modelId,effort).length>0;label.append(checkbox,document.createTextNode((t["effort."+effort+".label"]||effort)+(effortAllowed?"":" ("+t["settings.savedModel"]+")")));options.appendChild(label);}
        card.append(title,header,options);
        elements.effortGroups.appendChild(card);
      }
      elements.selectionCount.textContent=t["settings.selectionCount"].replace("{count}",String(checkedExplicitSelections().length));
    }
    function automaticCandidates() { return elements.allowedScope.value==="explicit"?checkedExplicitSelections():availableSelections(); }
    function currentPreferredSelection() { if(!elements.preferredModel.value||!elements.preferredEffort.value)return null;return{model:elements.preferredModel.value,reasoningEffort:elements.preferredEffort.value}; }
    function preferredCandidates(preferred) { const candidates=[...automaticCandidates()],wanted=preferred?selectionKey(preferred):"";if(preferred&&!candidates.some((entry)=>selectionKey(entry)===wanted)&&!modelPolicyDirty&&wanted===savedPreferredKey)candidates.push(preferred);return candidates; }
    function renderPreferredEfforts(preferred,candidates) { const modelId=elements.preferredModel.value,efforts=[...new Set(candidates.filter((selection)=>selection.model===modelId).map((selection)=>selection.reasoningEffort))];elements.preferredEffort.replaceChildren();if(!modelId){elements.preferredEffort.appendChild(option("",t["settings.preferred.none"]));elements.preferredEffort.value="";elements.preferredEffort.disabled=true;return;}for(const effort of efforts){const selection={model:modelId,reasoningEffort:effort},available=availableSelections().some((entry)=>selectionKey(entry)===selectionKey(selection));elements.preferredEffort.appendChild(option(effort,effortPresentationFor(modelId,effort).label+(available?"":" ("+t["settings.savedModel"]+")")));}const modelDefault=defaultSelectionForModel(modelId),wanted=preferred&&preferred.model===modelId?preferred.reasoningEffort:(modelDefault&&modelDefault.reasoningEffort)||"";elements.preferredEffort.value=efforts.includes(wanted)?wanted:efforts[0]||"";elements.preferredEffort.disabled=elements.mode.value==="fixed"||efforts.length===0; }
    function renderPreferred(preferred) { const wanted=preferred||currentPreferredSelection(),candidates=preferredCandidates(wanted),modelIds=[...new Set(candidates.map((selection)=>selection.model))];elements.preferredModel.replaceChildren(option("",t["settings.preferred.none"]));for(const modelId of modelIds)elements.preferredModel.appendChild(option(modelId,modelDisplayName(modelId)));elements.preferredModel.value=wanted&&modelIds.includes(wanted.model)?wanted.model:"";renderPreferredEfforts(wanted,candidates); }
    function ensureExplicitSelection() { if(elements.allowedScope.value!=="explicit"||explicitSelectedModels.size>0)return;const preferred=currentPreferredSelection(),modelId=preferred&&preferred.model||availableSelections()[0]&&availableSelections()[0].model;if(!modelId)return;explicitSelectedModels.add(modelId);seedExplicitModel(modelId);renderExplicitPolicy(); }
    function updatePolicyControls() { const preferred=currentPreferredSelection(),fixed=elements.mode.value==="fixed",explicit=!fixed&&elements.allowedScope.value==="explicit";elements.fixedPanel.hidden=!fixed;elements.automaticPanel.hidden=fixed;elements.explicitPanel.hidden=!explicit;elements.model.disabled=!fixed;elements.effort.disabled=!fixed;elements.allowedScope.disabled=fixed;elements.preferredModel.disabled=fixed;if(explicit)ensureExplicitSelection();for(const checkbox of[...elements.allowedModels.querySelectorAll('input[type="checkbox"]'),...elements.effortGroups.querySelectorAll('input[type="checkbox"]')])checkbox.disabled=!explicit;renderPreferred(preferred); }
    function renderModelPolicy(policy,legacyPreferred) { elements.delegation.checked=policy.constraints&&policy.constraints.allowDelegation!==false;elements.mode.value=policy.mode;const preferred=policy.mode==="automatic"?policy.preferredSelection||legacyPreferred:null;const seed=policy.mode==="fixed"?policy.selection:preferred||availableSelections()[0];renderFixedSelection(seed);elements.allowedScope.value=policy.mode==="automatic"?policy.allowedSelections.kind:"catalog-visible";const selected=policy.mode==="automatic"&&policy.allowedSelections.kind==="explicit"?policy.allowedSelections.selections:(policy.mode==="fixed"?[policy.selection]:(preferred?[preferred]:[]));explicitSelectedModels.clear();explicitSelectionMemory.clear();for(const selection of selected){explicitSelectionMemory.set(selectionKey(selection),selection);if(policy.mode==="automatic"&&policy.allowedSelections.kind==="explicit")explicitSelectedModels.add(selection.model);}savedPreferredKey=preferred?selectionKey(preferred):"";renderExplicitPolicy();renderPreferred(policy.mode==="automatic"?preferred:policy.selection);updatePolicyControls(); }
    function buildModelPolicy() { const constraints={allowDelegation:elements.delegation.checked};if(elements.mode.value==="fixed"){const selection=currentFixedSelection();if(!selection)throw new Error(t["settings.selectionRequired"]);return{mode:"fixed",selection,constraints};}const explicit=elements.allowedScope.value==="explicit",selections=checkedExplicitSelections();if(explicit&&selections.length===0)throw new Error(t["settings.explicitRequired"]);if(explicit)for(const modelId of explicitSelectedModels)if(!selections.some((selection)=>selection.model===modelId))throw new Error(t["settings.modelEffortRequired"].replace("{model}",modelId));const preferredSelection=currentPreferredSelection();return{mode:"automatic",...(preferredSelection?{preferredSelection}:{}),allowedSelections:explicit?{kind:"explicit",selections}:{kind:"catalog-visible"},constraints}; }
    function projectRows() { return [...elements.projectList.querySelectorAll(".project-row")]; }
${SETTINGS_PROJECT_ID_HELPERS}
    function normalizeProjectLabel(value) { const normalized=String(value||"").normalize("NFC").trim();if(!normalized||[...normalized].length>120||/[\u0000-\u001f\u007f-\u009f]/u.test(normalized))throw new Error(t["settings.projectInvalidLabel"]);return normalized; }
    function normalizedPathKey(value) { const input=String(value||"").trim();if(!input.startsWith("/")||/[\r\n\u0000]/u.test(input))throw new Error(t["settings.projectInvalidCwd"]);const parts=[];for(const part of input.split("/")){if(!part||part===".")continue;if(part===".."){parts.pop();continue;}parts.push(part);}return"/"+parts.join("/"); }
    function clearProjectError() { elements.projectError.textContent="";elements.projectError.classList.remove("show"); }
    function showProjectError(message) { elements.projectError.textContent=message;elements.projectError.classList.add("show"); }
    function projectErrorMessage(value) { if(value.includes("PROJECT_DUPLICATE_PATH"))return t["settings.projectDuplicatePath"];if(value.includes("PROJECT_LABEL_INVALID"))return t["settings.projectInvalidLabel"];if(value.includes("PROJECT_CWD_INVALID")||value.includes("PROJECT_CWD_NOT_ALLOWED"))return t["settings.projectInvalidCwd"];if(value.includes("PROJECT_UNAVAILABLE"))return t["settings.projectUnavailableSave"];return t["settings.projectError"]; }
    function projectField(key,input,className) { const label=document.createElement("label"),title=document.createElement("span");title.className=className;title.textContent=t[key];label.append(title,input);return label; }
    function updateProjectEmptyState() { const count=projectRows().length;elements.noProjects.hidden=count>0;elements.addProject.textContent=count===0?t["settings.addFirstProject"]:t["settings.addProject"];elements.addProject.disabled=count>=100;elements.addProject.title=count>=100?t["settings.projectLimit"]:""; }
    function localizeProjectRows() { for(const row of projectRows()){row.querySelector(".project-label-title").textContent=t["settings.projectLabel"];row.querySelector(".project-cwd-title").textContent=t["settings.projectCwd"];const status=row.querySelector(".project-availability");status.textContent=row.dataset.persisted==="false"?t["settings.projectNew"]:row.dataset.available==="false"?t["settings.projectUnavailable"]:t["settings.projectAvailable"];row.querySelector(".project-remove").textContent=t["settings.removeProject"];}updateProjectEmptyState(); }
    function appendProjectRow(project,persisted=false,available=true) {
      const row=document.createElement("div"),label=document.createElement("input"),cwd=document.createElement("input"),actions=document.createElement("div"),status=document.createElement("span"),remove=document.createElement("button");
      row.className="project-row"+(available?"":" unavailable");row.dataset.persisted=String(persisted);row.dataset.available=String(available);if(project.id)row.dataset.projectId=project.id;
      label.className="project-label-input";label.type="text";label.required=true;label.maxLength=1000;label.autocomplete="off";label.value=project.label||"";
      cwd.className="project-cwd-input";cwd.type="text";cwd.required=true;cwd.maxLength=4096;cwd.autocomplete="off";cwd.spellcheck=false;cwd.value=project.cwd||"";
      actions.className="project-row-actions";status.className="project-availability"+(available?"":" unavailable");remove.className="project-remove";remove.type="button";
      actions.append(status,remove);row.append(projectField("settings.projectLabel",label,"project-label-title"),projectField("settings.projectCwd",cwd,"project-cwd-title"),actions);elements.projectList.appendChild(row);
      for(const input of[label,cwd])input.addEventListener("input",()=>{input.setCustomValidity("");clearProjectError();});
      remove.addEventListener("click",()=>{row.remove();clearProjectError();updateProjectEmptyState();});
      localizeProjectRows();return row;
    }
    function renderProjects(settings,limits) { elements.projectList.replaceChildren();const availability=new Map((limits.projectAvailability||[]).map((entry)=>[entry.id,entry.available]));for(const project of settings.projects||[])appendProjectRow(project,true,availability.get(project.id)!==false);updateProjectEmptyState();clearProjectError(); }
    function buildProjectSettings() {
      clearProjectError();const records=[];let firstInvalid=null;
      for(const row of projectRows()){const labelInput=row.querySelector(".project-label-input"),cwdInput=row.querySelector(".project-cwd-input");for(const input of[labelInput,cwdInput])input.setCustomValidity("");let label,cwd,pathKey;try{label=normalizeProjectLabel(labelInput.value);labelInput.value=label;}catch(error){labelInput.setCustomValidity(error.message);firstInvalid||=labelInput;}try{cwd=String(cwdInput.value||"").trim();pathKey=normalizedPathKey(cwd);cwdInput.value=cwd;}catch(error){cwdInput.setCustomValidity(error.message);firstInvalid||=cwdInput;}records.push({row,id:row.dataset.projectId||"",label,cwd,pathKey,cwdInput});}
      const paths=new Map();for(const record of records)if(record.pathKey){const previous=paths.get(record.pathKey);if(previous){record.cwdInput.setCustomValidity(t["settings.projectDuplicatePath"]);previous.setCustomValidity(t["settings.projectDuplicatePath"]);firstInvalid||=previous;}else paths.set(record.pathKey,record.cwdInput);}
      if(firstInvalid){const message=firstInvalid.validationMessage||t["settings.projectError"];showProjectError(message);firstInvalid.reportValidity();return null;}
      const visibleIds=new Set(),reservedIds=new Set((view.settings.projects||[]).map((project)=>project.id));for(const record of records)if(record.id){if(!validProjectId(record.id)||visibleIds.has(record.id)){showProjectError(t["settings.projectError"]);return null;}visibleIds.add(record.id);reservedIds.add(record.id);}for(const record of records)if(!record.id){record.id=allocateProjectId(record.label,record.cwd,reservedIds);record.row.dataset.projectId=record.id;reservedIds.add(record.id);}
      return{projects:records.map(({id,label,cwd})=>({id,label,cwd}))};
    }
    function buildProjectOperations(projects) { const previous=new Map((view.settings.projects||[]).map((project)=>[project.id,project])),next=new Map(projects.map((project)=>[project.id,project])),operations=[];for(const project of previous.values())if(!next.has(project.id))operations.push({kind:"remove",projectId:project.id});for(const project of projects){const saved=previous.get(project.id);if(!saved){operations.push({kind:"add",project});continue;}if(project.label!==saved.label)operations.push({kind:"rename",projectId:project.id,label:project.label});if(project.cwd!==saved.cwd)operations.push({kind:"relocate",projectId:project.id,cwd:project.cwd});}return operations; }
    function updateAccessNotice() { const value=elements.access.value;const key=value==="read-only"?"settings.access.readOnlyHint":value==="always-full"?"settings.access.fullHint":"settings.access.adaptiveHint";elements.accessHint.textContent=t[key];elements.fullWarning.classList.toggle("show",value==="always-full"); }
    function updateCardPolicy() { const hidden=elements.cardVisibility.value==="never";if(hidden)elements.handoff.value="off";elements.handoff.disabled=hidden;elements.handoffHint.textContent=hidden?t["settings.handoffRequiresCard"]:""; }
    function render(next,localeReady=false,preserveLocalePreference=false) { if(!next||!next.settings)return;view=next;const settings=next.settings,limits=next.capabilities;if(!preserveLocalePreference)localePreference=settings.uiLocalePreference||"auto";if(!localeReady)setLocale(effectiveLocaleTag(),false);elements.access.replaceChildren();const accessLabels={"read-only":t["settings.access.readOnly"],adaptive:t["settings.access.adaptive"],"always-full":t["settings.access.full"]};for(const value of limits.availableAccessStrategies||[])elements.access.appendChild(option(value,accessLabels[value]||value));elements.access.value=settings.accessStrategy;elements.priority.checked=settings.usePriorityServiceTier===true;modelPolicyDirty=false;renderModelPolicy(settings.modelPolicy,settings.legacyPreferredModel?defaultSelectionForModel(settings.legacyPreferredModel):null);renderProjects(settings,limits);elements.language.replaceChildren();for(const value of limits.availableUiLocalePreferences||["auto",...Object.keys(LANGUAGE_LABELS)])elements.language.appendChild(option(value,value==="auto"?t["settings.language.auto"]:LANGUAGE_LABELS[value]||value));elements.language.value=localePreference;elements.concurrency.value=String(settings.maxConcurrentJobs);elements.concurrency.max=String(limits.maxConcurrentJobs);elements.cardVisibility.value=settings.activityCardVisibility||"always";elements.handoff.value=settings.completionHandoff||"off";updateAccessNotice();updateCardPolicy();const catalogProblem=Boolean(next.catalog.warning||next.catalog.stale||next.catalog.validation==="invalid"),warnings=[next.catalog.warning,...(next.warnings||[])].filter(Boolean).join("\n")||(catalogProblem?t["common.error"]:"");elements.catalogWarningText.textContent=warnings;elements.catalogWarning.classList.toggle("show",Boolean(warnings));elements.retryModels.hidden=!catalogProblem; }
    function setBusy(busy,message) { for(const node of[elements.save,elements.retryModels,elements.reset])node.disabled=busy;elements.addProject.disabled=busy||projectRows().length>=100;elements.status.classList.remove("error");elements.status.textContent=message||""; }
    function setError(error) { elements.status.classList.add("error");elements.status.textContent=uiBridgeErrorMessage(error,t["common.error"]); }
    async function handleMutationError(error) { const value=uiBridgeErrorMessage(error,t["common.error"]);if(value.includes("PROJECT_")){setBusy(false);showProjectError(projectErrorMessage(value));elements.status.classList.add("error");elements.status.textContent=t["settings.projectError"];return;}if(!value.includes("SETTINGS_REVISION_CONFLICT")){setBusy(false);setError(error);return;}try{render(unwrap(await callTool("codex_settings",{})));setBusy(false);elements.status.classList.add("error");elements.status.textContent=t["settings.conflict"];}catch(refreshError){setBusy(false);setError(refreshError);} }
    function integerValue(input) { const value=Number(input.value);if(!Number.isSafeInteger(value))throw new Error(t["common.error"]);return value; }
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.method==="ping"&&message.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return;}if(message.method==="ui/resource-teardown"&&message.id!==undefined){for(const request of pendingRequests.values())request.reject(new Error("Settings card unmounted"));pendingRequests.clear();window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return;}if(message.id!==undefined&&pendingRequests.has(message.id)){const pending=pendingRequests.get(message.id);pendingRequests.delete(message.id);message.error?pending.reject(new Error(uiBridgeErrorMessage(message.error,t["common.error"]))):pending.resolve(message.result);return;}if(message.method==="ui/notifications/host-context-changed"&&message.params&&message.params.locale){hostLocaleTag=String(message.params.locale);if(localePreference==="auto")setLocale(hostLocaleTag);return;}if(message.method==="ui/notifications/tool-result"){const next=privateSettingsView(message.params&&message.params._meta);if(next)render(next);}},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event.detail&&event.detail.globals,metadata=globals&&globals.toolResponseMetadata;const responseHostLocale=metadata&&(metadata.hostLocale||metadata["webplus/i18n"]||metadata["openai/locale"]);if(globals&&globals.locale)hostLocaleTag=String(globals.locale);else if(responseHostLocale)hostLocaleTag=String(responseHostLocale);if(localePreference==="auto"){setLocale(hostLocaleTag,false);updateAccessNotice();updateCardPolicy();localizeProjectRows();}const next=privateSettingsView(metadata);if(next)render(next);});
    window.addEventListener("pagehide",()=>{for(const [id,request] of pendingRequests){window.parent.postMessage({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:id,reason:"Settings card unmounted"}},"*");request.reject(new Error("Settings card unmounted"));}pendingRequests.clear();});
    elements.access.addEventListener("change",updateAccessNotice);
    elements.cardVisibility.addEventListener("change",updateCardPolicy);
    elements.addProject.addEventListener("click",()=>{if(projectRows().length>=100){showProjectError(t["settings.projectLimit"]);return;}const row=appendProjectRow({id:"",label:"",cwd:""});updateProjectEmptyState();row.querySelector(".project-label-input").focus();});
    elements.mode.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();});
    elements.delegation.addEventListener("change",()=>{modelPolicyDirty=true;const fixed=currentFixedSelection(),preferred=currentPreferredSelection();renderFixedSelection(fixed);renderExplicitPolicy();renderPreferred(preferred);updatePolicyControls();});
    elements.model.addEventListener("change",()=>{modelPolicyDirty=true;renderFixedEfforts(null);});
    elements.effort.addEventListener("change",()=>{modelPolicyDirty=true;updateEffortHelper();elements.effortCompatibility.textContent="";});
    elements.allowedScope.addEventListener("change",()=>{modelPolicyDirty=true;updatePolicyControls();renderExplicitPolicy();});
    elements.allowedModels.addEventListener("change",(event)=>{const target=event.target;if(!(target instanceof HTMLInputElement)||target.dataset.action!=="model")return;modelPolicyDirty=true;const preferred=currentPreferredSelection(),modelId=target.dataset.model;if(!modelId)return;if(target.checked){explicitSelectedModels.add(modelId);seedExplicitModel(modelId);}else explicitSelectedModels.delete(modelId);renderExplicitPolicy();renderPreferred(preferred);});
    elements.effortGroups.addEventListener("change",(event)=>{const target=event.target;if(!(target instanceof HTMLInputElement))return;modelPolicyDirty=true;const preferred=currentPreferredSelection(),action=target.dataset.action,modelId=target.dataset.model;if(action==="all-efforts"&&modelId){if(target.checked){const availableKeys=new Set(availableSelections().map(selectionKey));for(const [effort,candidates] of groupedModelSelections(modelId)){if(!candidates.some((selection)=>availableKeys.has(selectionKey(selection)))||exactSelectionsForEffort(modelId,effort).length>0)continue;const primary=primarySelectionForEffort(modelId,effort,candidates);if(primary)explicitSelectionMemory.set(selectionKey(primary),primary);}}else for(const [key,selection] of explicitSelectionMemory)if(selection.model===modelId)explicitSelectionMemory.delete(key);}else if(action==="effort"&&modelId){const effort=target.dataset.effort;if(!effort)return;if(target.checked){if(exactSelectionsForEffort(modelId,effort).length===0){const selection=selectionFromKey(target.value);if(selection)explicitSelectionMemory.set(selectionKey(selection),selection);}}else for(const [key,selection] of explicitSelectionMemory)if(selection.model===modelId&&selection.reasoningEffort===effort)explicitSelectionMemory.delete(key);}else return;renderExplicitPolicy();renderPreferred(preferred);});
    elements.preferredModel.addEventListener("change",()=>{modelPolicyDirty=true;renderPreferredEfforts(null,preferredCandidates(null));});
    elements.preferredEffort.addEventListener("change",()=>{modelPolicyDirty=true;});
    elements.language.addEventListener("change",()=>{const preferred=currentPreferredSelection();localePreference=elements.language.value;setLocale(effectiveLocaleTag(),false);updateAccessNotice();updateCardPolicy();updateEffortHelper();renderExplicitPolicy();renderPreferred(preferred);localizeProjectRows();});
    elements.form.addEventListener("submit",async(event)=>{event.preventDefault();if(!view)return;const projectSettings=buildProjectSettings();if(!projectSettings||!elements.form.reportValidity())return;setBusy(true,t["settings.saving"]);try{const settings={accessStrategy:elements.access.value,usePriorityServiceTier:elements.priority.checked,uiLocalePreference:elements.language.value,maxConcurrentJobs:integerValue(elements.concurrency),activityCard:{visibility:elements.cardVisibility.value,completionHandoff:elements.handoff.value}},projectOperations=buildProjectOperations(projectSettings.projects);if(projectOperations.length)settings.projectOperations=projectOperations;if(modelPolicyDirty)settings.modelPolicy=buildModelPolicy();const args={expectedRevision:view.settings.revision,operation:{kind:"patch",settings}};const result=await callTool("codex_update_settings",args);render(unwrap(result));setBusy(false,t["settings.saved"]);}catch(error){await handleMutationError(error);}});
    elements.retryModels.addEventListener("click",async()=>{setBusy(true,t["settings.refreshing"]);try{render(unwrap(await callTool("codex_settings",{refreshModels:true})));setBusy(false,t["settings.refreshed"]);}catch(error){setBusy(false);setError(error);}});
    elements.reset.addEventListener("click",async()=>{if(!view)return;setBusy(true,t["settings.resetting"]);try{render(unwrap(await callTool("codex_update_settings",{expectedRevision:view.settings.revision,operation:{kind:"reset"}})));setBusy(false,t["settings.resetDone"]);}catch(error){await handleMutationError(error);}});
    standardBridgeReady=initializeStandardBridge();setLocale(localeTag);const initialView=privateSettingsView(initialMetadata);if(initialView)render(initialView);else callTool("codex_settings",{}).then((result)=>render(unwrap(result))).catch(setError);
  </script>
</body>
</html>`;
