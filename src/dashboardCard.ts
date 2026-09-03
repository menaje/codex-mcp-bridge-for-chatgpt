import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveHostUiLocaleTag, serializedUiTranslations } from "./uiI18n.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  currentUiResourceUri,
  htmlForUiResource,
  uiResourceRevisions
} from "./uiResources.js";
import {
  hostToolResultMetadata,
  normalizeHostToolResult
} from "./uiHostToolResult.js";
import {
  callUiToolWithFallback,
  withUiToolCallTimeout
} from "./uiToolCallFallback.js";

export const DASHBOARD_CARD_URI = currentUiResourceUri("dashboard");
export const DASHBOARD_CARD_CONTRACT_GENERATION = 17;
export const DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION = 1;
export const DASHBOARD_VIEW_METADATA_KEY = "codex/dashboardView@1";
export const DASHBOARD_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const DASHBOARD_CARD_HTML_MAX_BYTES = 112 * 1_024;

type DashboardExecutionComparable = {
  model?: unknown;
  reasoningEffort?: unknown;
  reroutedModel?: unknown;
  isCurrent?: unknown;
};

export function dashboardExecutionsEqual(
  left: DashboardExecutionComparable | null | undefined,
  right: DashboardExecutionComparable | null | undefined
): boolean {
  if (!left || !right) return false;
  const leftModel = typeof left.model === "string" ? left.model.trim().toLowerCase() : "";
  const rightModel = typeof right.model === "string" ? right.model.trim().toLowerCase() : "";
  const leftEffort = typeof left.reasoningEffort === "string"
    ? left.reasoningEffort.trim().toLowerCase()
    : "";
  const rightEffort = typeof right.reasoningEffort === "string"
    ? right.reasoningEffort.trim().toLowerCase()
    : "";
  const leftRerouted = typeof left.reroutedModel === "string"
    ? left.reroutedModel.trim().toLowerCase()
    : "";
  const rightRerouted = typeof right.reroutedModel === "string"
    ? right.reroutedModel.trim().toLowerCase()
    : "";
  return Boolean(leftModel && rightModel && leftEffort && rightEffort) &&
    leftModel === rightModel &&
    leftEffort === rightEffort &&
    leftRerouted === rightRerouted;
}

export function shouldShowDashboardNextExecution(
  current: DashboardExecutionComparable | null | undefined,
  latest: DashboardExecutionComparable | null | undefined
): boolean {
  return Boolean(
    current?.isCurrent === true &&
    (!latest || !dashboardExecutionsEqual(current, latest))
  );
}

type DashboardExecutionRow = {
  execution?: DashboardExecutionComparable | null;
  latestTurn?: { execution?: DashboardExecutionComparable | null } | null;
};

export function commonDashboardExecution<Row extends DashboardExecutionRow>(
  rows: readonly Row[]
): DashboardExecutionComparable | null {
  if (rows.length < 2) return null;
  const first = rows[0]?.latestTurn?.execution || null;
  if (!first) return null;
  return rows.every((row) => dashboardExecutionsEqual(row.latestTurn?.execution, first))
    ? first
    : null;
}

export function commonDashboardNextExecution<Row extends DashboardExecutionRow>(
  rows: readonly Row[]
): DashboardExecutionComparable | null {
  if (rows.length < 2) return null;
  const next = (row: Row | undefined): DashboardExecutionComparable | null =>
    shouldShowDashboardNextExecution(row?.execution, row?.latestTurn?.execution)
      ? row?.execution || null
      : null;
  const first = next(rows[0]);
  if (!first) return null;
  return rows.every((row) => dashboardExecutionsEqual(next(row), first)) ? first : null;
}

type DashboardActivityGroupRow = {
  activityKey?: unknown;
  activityTitle?: unknown;
  rowKey?: unknown;
};

export function groupDashboardRowsByActivity<Row extends DashboardActivityGroupRow>(
  rows: readonly Row[]
): Array<{ activityKey: string; activityTitle: string | null; rows: Row[] }> {
  const groups: Array<{ activityKey: string; activityTitle: string | null; rows: Row[] }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const row of rows) {
    const activityKey = String(row.activityKey || row.rowKey || `row-${groups.length}`);
    const title = typeof row.activityTitle === "string" && row.activityTitle.trim()
      ? row.activityTitle.trim()
      : null;
    const existing = byKey.get(activityKey);
    if (existing) {
      existing.rows.push(row);
      if (!existing.activityTitle && title) existing.activityTitle = title;
      continue;
    }
    const group = { activityKey, activityTitle: title, rows: [row] };
    byKey.set(activityKey, group);
    groups.push(group);
  }
  return groups;
}

type DashboardHistoryTurnIdentity = {
  activityKey?: unknown;
  activityTitle?: unknown;
};

export function dashboardHistoryActivityIdentity(
  turn: DashboardHistoryTurnIdentity | null | undefined
): string | null {
  if (!turn) return null;
  const key = typeof turn.activityKey === "string" ? turn.activityKey.trim() : "";
  if (key) return `key:${key}`;
  const title = typeof turn.activityTitle === "string" ? turn.activityTitle.trim() : "";
  return title ? `legacy-title:${title}` : null;
}

export function dispatchDashboardExternalUrl(
  event: { preventDefault(): void },
  url: string,
  api: {
    openExternal?: (options: { href: string; redirectUrl: false }) => unknown;
  } | undefined,
  fallback: (url: string) => void
): boolean {
  if (!api || typeof api.openExternal !== "function") return false;
  event.preventDefault();
  try {
    const opened = api.openExternal({ href: url, redirectUrl: false });
    if (opened && typeof (opened as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(opened).catch(() => fallback(url));
    }
  } catch {
    fallback(url);
  }
  return true;
}

export const DASHBOARD_CARD_RESOURCE_DESCRIPTOR = {
  title: `${PRODUCT_INFO.displayName} Codex Overview`,
  description:
    "Read-only, Activity-first Codex runtime overview with nested Agents, project labels, Codex links for non-ephemeral App Server sessions, setting-independent GPT orchestration links when a UUID-shaped host route candidate was captured, expandable retained turn history, and model/effort selections.",
  mimeType: DASHBOARD_CARD_MIME_TYPE
} as const;
export const DASHBOARD_CARD_CONTENT_METADATA = {
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    domain: "https://web-sandbox.oaiusercontent.com"
  },
  "openai/widgetDescription":
    "Shows one read-only, Activity-first Codex overview with nested Agents, derived from retained Codex Jobs, threads, interaction state, model/effort selection, and bounded App Server runtime evidence.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": {
    connect_domains: [] as string[],
    resource_domains: [] as string[],
    redirect_domains: ["https://chatgpt.com", "codex://threads"]
  },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com",
  "codex/uiContractGeneration": DASHBOARD_CARD_CONTRACT_GENERATION
} as const;

type DashboardAppendRequest = {
  bucket: "terminal" | "idle";
  requestedOffset: number;
} | null;

type DashboardPageCache<Row, Page extends { offset: number; total: number }> = {
  terminalRows: Row[];
  idleRows: Row[];
  terminalPagination: Page | null;
  idlePagination: Page | null;
};

/**
 * Reconciles the independently paged recent and idle buckets. Snapshot
 * responses always include both buckets, but a load-more request advances
 * only one of them; the other offset-zero page must not replace rows the user
 * already appended.
 */
export function reconcileDashboardPageCaches<
  Row,
  Page extends { offset: number; total: number }
>(
  current: DashboardPageCache<Row, Page>,
  next: {
    activeRows?: Row[];
    terminalRows: Row[];
    idleRows: Row[];
    terminalPagination: Page;
    idlePagination: Page;
  },
  appendRequest: DashboardAppendRequest,
  mergeRows: (currentRows: Row[], incomingRows: Row[]) => Row[],
  rowKey: (row: Row) => string
): DashboardPageCache<Row, Page> {
  const responseBucket = appendRequest?.bucket || (
    next.terminalPagination.offset > 0 && next.idlePagination.offset === 0
      ? "terminal"
      : next.idlePagination.offset > 0 && next.terminalPagination.offset === 0
        ? "idle"
        : null
  );
  let terminalRows: Row[];
  let idleRows: Row[];
  let terminalPagination: Page;
  let idlePagination: Page;
  if (responseBucket === "terminal") {
    const canAppend = !appendRequest ||
      next.terminalPagination.offset === appendRequest.requestedOffset;
    terminalRows = canAppend
      ? mergeRows(current.terminalRows, next.terminalRows)
      : next.terminalRows.slice();
    idleRows = current.idleRows.slice();
    terminalPagination = next.terminalPagination;
    idlePagination = current.idlePagination || next.idlePagination;
  } else if (responseBucket === "idle") {
    const canAppend = !appendRequest ||
      next.idlePagination.offset === appendRequest.requestedOffset;
    terminalRows = current.terminalRows.slice();
    idleRows = canAppend
      ? mergeRows(current.idleRows, next.idleRows)
      : next.idleRows.slice();
    terminalPagination = current.terminalPagination || next.terminalPagination;
    idlePagination = next.idlePagination;
  } else {
    terminalRows = next.terminalRows.slice();
    idleRows = next.idleRows.slice();
    terminalPagination = next.terminalPagination;
    idlePagination = next.idlePagination;
  }

  // A row represents one Agent (or one unassigned Job) across buckets. New
  // evidence that a row moved must evict the stale cached copy immediately.
  const activeKeys = new Set(next.activeRows?.map(rowKey) || []);
  const incomingTerminalKeys = new Set(next.terminalRows.map(rowKey));
  const incomingIdleKeys = new Set(next.idleRows.map(rowKey));
  terminalRows = terminalRows.filter((row) =>
    !activeKeys.has(rowKey(row)) && !incomingIdleKeys.has(rowKey(row))
  );
  const terminalKeys = new Set(terminalRows.map(rowKey));
  idleRows = idleRows.filter((row) =>
    !activeKeys.has(rowKey(row)) &&
    !incomingTerminalKeys.has(rowKey(row)) &&
    !terminalKeys.has(rowKey(row))
  );

  if (terminalRows.length > terminalPagination.total) {
    terminalRows = next.terminalRows.slice(0, terminalPagination.total);
  }
  if (idleRows.length > idlePagination.total) {
    idleRows = next.idleRows.slice(0, idlePagination.total);
  }
  return {
    terminalRows,
    idleRows,
    terminalPagination,
    idlePagination
  };
}

export function registerDashboardCardResource(server: McpServer): void {
  for (const [index, revision] of uiResourceRevisions("dashboard").entries()) {
    server.registerResource(
      index === 0 ? "codex-dashboard-card" : `codex-dashboard-card-compat-${index}`,
      revision.uri,
      DASHBOARD_CARD_RESOURCE_DESCRIPTOR,
      async () => ({
        contents: [
          {
            uri: revision.uri,
            mimeType: DASHBOARD_CARD_MIME_TYPE,
            text: htmlForUiResource("dashboard", revision.uri, DASHBOARD_CARD_HTML),
            _meta: {
              ...DASHBOARD_CARD_CONTENT_METADATA,
              "codex/uiContractGeneration": revision.contractGeneration ||
                DASHBOARD_CARD_CONTRACT_GENERATION
            }
          }
        ]
      })
    );
  }
}

export const DASHBOARD_CARD_HTML = String.raw`<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Codex</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--muted:color-mix(in srgb,CanvasText 62%,transparent);--faint:color-mix(in srgb,CanvasText 8%,transparent);--border:color-mix(in srgb,CanvasText 15%,transparent);--active:#16875a;--warn:#b87503;--danger:#c34132;--ok:#1a8f55;--unknown:#68758d}
    *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:transparent;color:CanvasText}.card{padding:14px}.header,.section-head,.row-head,.footer,.row-context,.load-more-wrap{display:flex;align-items:center;gap:8px}.header,.section-head,.footer{justify-content:space-between}.header{align-items:flex-start}.title-wrap{min-width:0}h1{margin:0;font-size:17px}.scope-note,.source-note,.meta,.time,.empty,.message,.project-label,.activity-group-count{color:var(--muted)}.scope-note{margin:3px 0 0;font-size:11px;line-height:1.45}.source-note{margin:9px 0 0;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--faint);font-size:11px;line-height:1.4}.icon-button{width:30px;height:30px;padding:0;display:grid;place-items:center;font-size:16px}.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:7px;margin-top:11px}.count{min-width:0;padding:9px;border:1px solid var(--border);border-radius:10px;background:var(--faint)}.count-value{font-size:17px;font-weight:760;line-height:1.15}.count-label{margin-top:3px;color:var(--muted);font-size:10px;line-height:1.3}.section{margin-top:13px}.section-head{padding-bottom:5px;border-bottom:1px solid var(--border)}h2{margin:0;font-size:13px}.section-toggle{display:flex;align-items:center;gap:7px;border:0;border-radius:0;background:transparent;color:CanvasText;padding:0;text-align:left;font:inherit}.section-toggle:hover{background:transparent}.section-toggle:disabled{opacity:1;cursor:default}.chevron,.history-chevron{display:inline-block;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}.section-toggle[aria-expanded="true"] .chevron,.history[open] .history-chevron{transform:rotate(45deg)}.section-count{color:var(--muted);font-size:11px}.list{display:grid}.row{display:grid;grid-template-columns:12px minmax(0,1fr);gap:9px;padding:10px 0;border-bottom:1px solid var(--border)}.activity-group{grid-template-columns:minmax(0,1fr)}.row:last-child{border-bottom:0}.dot{width:9px;height:9px;margin-top:4px;border-radius:50%;background:var(--unknown)}.dot.running{background:var(--active)}.dot.attention{background:var(--warn)}.dot.failed{background:var(--danger)}.dot.completed{background:var(--ok)}.row-body{min-width:0}.row-head{justify-content:space-between;align-items:flex-start}.row-title{min-width:0;font-size:13px;font-weight:750;overflow-wrap:anywhere}.turn-title{margin-top:4px;font-size:12px;font-weight:620;line-height:1.4;overflow-wrap:anywhere}.status{flex:0 0 auto;font-size:10px;font-weight:700}.status.running{color:var(--active)}.status.attention{color:var(--warn)}.status.failed{color:var(--danger)}.status.completed{color:var(--ok)}.row-context{justify-content:flex-start;flex-wrap:wrap;margin-top:5px;font-size:10px;line-height:1.35}.project-label{overflow-wrap:anywhere}.conversation-link{color:CanvasText;font-weight:700;text-decoration:none;border:1px solid var(--border);border-radius:8px;padding:3px 6px;background:Canvas}.conversation-link:hover{background:var(--faint)}.meta,.time{margin-top:3px;font-size:11px;line-height:1.4;overflow-wrap:anywhere}.execution{display:inline-block;max-width:100%;margin-top:6px;padding:2px 7px;border:1px solid var(--border);border-radius:999px;background:var(--faint);color:var(--muted);font-size:11px;line-height:1.35;overflow-wrap:anywhere}.activity-group-count{margin-top:4px;font-size:10px}.activity-agent-list{display:grid;margin-top:8px;padding-left:11px;border-left:2px solid var(--border)}.activity-agent{min-width:0;padding:8px 0;border-bottom:1px solid var(--border)}.activity-agent:last-child{border-bottom:0;padding-bottom:1px}.activity-agent .row-title{font-size:12px;font-weight:700}.activity-agent .status{font-size:9px}.history{margin-top:8px}.history-toggle{display:flex;align-items:center;gap:7px;width:max-content;max-width:100%;color:var(--muted);font-size:11px;font-weight:650;cursor:pointer;list-style:none}.history-toggle::-webkit-details-marker{display:none}.history-list{margin-top:7px;padding-left:11px;border-left:2px solid var(--border)}.history-turn{padding:7px 0;border-bottom:1px solid var(--border)}.history-turn:last-child{border-bottom:0}.history-turn .row-title{font-size:12px;font-weight:650}.history-turn .status{font-size:9px}.history-turn .history-state-only{justify-content:flex-start}.empty{padding:11px 0;font-size:11px}.load-more-wrap{justify-content:center;margin-top:9px}.load-more{min-width:120px}.footer{margin-top:11px;align-items:flex-start}.message{font-size:11px}.message.error{color:var(--danger)}.updated{font-size:10px;color:var(--muted);white-space:nowrap}button{border:1px solid var(--border);border-radius:8px;background:Canvas;color:CanvasText;padding:5px 8px;font-size:11px;font-weight:650;cursor:pointer}button:hover{background:var(--faint)}button:focus-visible,.history-toggle:focus-visible,.cancellation-toggle:focus-visible,.conversation-link:focus-visible{outline:2px solid color-mix(in srgb,var(--active) 70%,transparent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    @media(max-width:560px){.card{padding:12px}.counts{grid-template-columns:repeat(2,minmax(0,1fr))}.row-head{display:block}.status{display:block;margin-top:2px}.footer{display:grid}.updated{white-space:normal}}
    .weekly-usage{margin-top:10px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--faint)}.weekly-usage-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px}.weekly-usage-label{color:var(--muted);font-weight:650}.weekly-usage-value{font-size:14px}.weekly-usage-track{height:5px;margin-top:7px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,CanvasText 12%,transparent)}.weekly-usage-fill{display:block;height:100%;border-radius:inherit;background:var(--active);transition:width .2s ease}.weekly-usage-reset{margin-top:5px;color:var(--muted);font-size:10px}
    .cancellation{margin-top:8px}.cancellation-toggle{display:flex;align-items:center;gap:7px;width:max-content;max-width:100%;color:var(--muted);font-size:11px;font-weight:650;cursor:pointer;list-style:none}.cancellation-toggle::-webkit-details-marker{display:none}.cancellation-chevron{display:inline-block;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}.cancellation[open] .cancellation-chevron{transform:rotate(45deg)}.cancellation-body{margin-top:6px;padding-left:11px;border-left:2px solid color-mix(in srgb,var(--danger) 32%,var(--border))}.cancellation-meta{color:var(--muted);font-size:10px;line-height:1.35}.cancellation-reason{margin-top:2px;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
  </style>
</head>
<body>
  <main class="card">
    <header class="header">
      <div class="title-wrap"><h1 data-i18n="dashboard.title"></h1><p class="scope-note" data-i18n="dashboard.scopeNotice"></p></div>
      <button id="refresh" class="icon-button" type="button"><span aria-hidden="true">↻</span></button>
    </header>
    <p class="source-note" data-i18n="dashboard.runtimeOnly"></p>
    <section class="weekly-usage" id="weekly-usage" aria-labelledby="weekly-usage-label" hidden>
      <div class="weekly-usage-head"><span class="weekly-usage-label" id="weekly-usage-label" data-i18n="usage.weeklyRemaining"></span><strong class="weekly-usage-value" id="weekly-usage-value"></strong></div>
      <div class="weekly-usage-track" id="weekly-usage-track" role="progressbar"><span class="weekly-usage-fill" id="weekly-usage-fill"></span></div>
      <div class="weekly-usage-reset" id="weekly-usage-reset"></div>
    </section>
    <div id="dashboard-content" hidden>
      <section class="counts">
        <div class="count"><div class="count-value" id="project-count">—</div><div class="count-label" data-i18n="dashboard.projects"></div></div>
        <div class="count"><div class="count-value" id="scope-count">—</div><div class="count-label" data-i18n="dashboard.conversations"></div></div>
        <div class="count"><div class="count-value" id="running-count">—</div><div class="count-label" data-i18n="dashboard.running"></div></div>
        <div class="count"><div class="count-value" id="attention-count">—</div><div class="count-label" data-i18n="dashboard.attention"></div></div>
        <div class="count"><div class="count-value" id="background-count">—</div><div class="count-label" data-i18n="dashboard.backgroundProcesses"></div></div>
        <div class="count"><div class="count-value" id="idle-count">—</div><div class="count-label" data-i18n="dashboard.idleAgents"></div></div>
      </section>
      <section class="section">
        <div class="section-head"><h2 data-i18n="dashboard.active"></h2><span class="section-count" id="active-count"></span></div>
        <div class="list" id="active-list"></div><div class="empty" id="active-empty" data-i18n="dashboard.noActive"></div>
      </section>
      <section class="section">
        <div class="section-head"><h2 data-i18n="dashboard.recent"></h2><span class="section-count" id="terminal-count"></span></div>
        <div class="list" id="terminal-list"></div><div class="empty" id="terminal-empty" data-i18n="dashboard.noRecent"></div>
        <div class="load-more-wrap" id="terminal-more-wrap" hidden><button id="terminal-more" class="load-more" type="button" data-i18n="dashboard.loadMore"></button></div>
      </section>
      <section class="section">
        <div class="section-head"><h2><button id="status-idle-toggle" class="section-toggle" type="button" aria-expanded="false" aria-controls="status-idle-panel" aria-describedby="status-idle-count"><span class="chevron" aria-hidden="true"></span><span data-i18n="dashboard.idle"></span></button></h2><span class="section-count" id="status-idle-count"></span></div>
        <div id="status-idle-panel" hidden><div class="list" id="idle-list"></div><div class="empty" id="idle-empty" data-i18n="dashboard.noIdle"></div><div class="load-more-wrap" id="idle-more-wrap" hidden><button id="idle-more" class="load-more" type="button" data-i18n="dashboard.loadMore"></button></div></div>
      </section>
    </div>
    <footer class="footer"><span class="message" id="message" role="status" aria-live="polite" data-i18n="common.loading"></span><span class="updated" id="updated"></span></footer>
  </main>
  <script>
    const BUNDLES=${serializedUiTranslations(["common", "usage", "cancellation", "dashboard", "activity.lastChanged"])};
    ${resolveHostUiLocaleTag.toString()}
    ${normalizeHostToolResult.toString()}
    ${hostToolResultMetadata.toString()}
    ${withUiToolCallTimeout.toString()}
    ${callUiToolWithFallback.toString()}
    ${reconcileDashboardPageCaches.toString()}
    ${dashboardExecutionsEqual.toString()}
    ${shouldShowDashboardNextExecution.toString()}
    ${commonDashboardExecution.toString()}
    ${commonDashboardNextExecution.toString()}
    ${groupDashboardRowsByActivity.toString()}
    ${dashboardHistoryActivityIdentity.toString()}
    ${dispatchDashboardExternalUrl.toString()}
    function createWidgetInstanceId(){const cryptoApi=globalThis.crypto;if(cryptoApi&&typeof cryptoApi.randomUUID==="function")return cryptoApi.randomUUID();const bytes=new Uint8Array(16);if(cryptoApi&&typeof cryptoApi.getRandomValues==="function")cryptoApi.getRandomValues(bytes);else for(let index=0;index<bytes.length;index+=1)bytes[index]=Math.floor(Math.random()*256);bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;const hex=Array.from(bytes,(value)=>value.toString(16).padStart(2,"0")).join("");return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20)}
    const DASHBOARD_VIEW_METADATA_KEY=${JSON.stringify(DASHBOARD_VIEW_METADATA_KEY)},widgetInstanceId=createWidgetInstanceId(),pending=new Map(),PAGE_LIMIT=20,STANDARD_BRIDGE_INIT_TIMEOUT_MS=5000,TOOL_CALL_TIMEOUT_MS=15000,STANDARD_CALL_BUDGET_MS=STANDARD_BRIDGE_INIT_TIMEOUT_MS+TOOL_CALL_TIMEOUT_MS+1000;
    const initialResponseMetadata=window.openai&&window.openai.toolResponseMetadata||{},initialMetadata=hostToolResultMetadata(initialResponseMetadata);
    let requestId=1,view=null,busy=false,mounted=true,statusIdleExpanded=false,appendRequest=null,hydrationEpoch=0,automaticRefreshDisabled=false,activeRows=[],terminalRows=[],idleRows=[],terminalPagination=null,idlePagination=null,hostLocaleTag=resolveHostUiLocaleTag(window.openai&&window.openai.locale,initialMetadata,navigator.language),localePreference="auto",localeTag=hostLocaleTag,locale=resolveLocale(localeTag),t=BUNDLES[locale]||BUNDLES.en,standardBridgeReady=Promise.resolve(false),standardBridgeAttempt=null,standardBridgeInitialized=false,lastRefreshAt=0,lastRenderedAt=0,sizeReportingReady=false,sizeFrame=0,sizeChangeForced=false,resizeObserver=null,lastWidth=-1,lastHeight=-1;
    const expandedHistories=new Set(),expandedCancellations=new Set();
    const elements={card:document.querySelector("main.card"),content:document.getElementById("dashboard-content"),counts:document.querySelector("section.counts"),refresh:document.getElementById("refresh"),weeklyUsage:document.getElementById("weekly-usage"),weeklyUsageValue:document.getElementById("weekly-usage-value"),weeklyUsageTrack:document.getElementById("weekly-usage-track"),weeklyUsageFill:document.getElementById("weekly-usage-fill"),weeklyUsageReset:document.getElementById("weekly-usage-reset"),projectCount:document.getElementById("project-count"),scopeCount:document.getElementById("scope-count"),runningCount:document.getElementById("running-count"),attentionCount:document.getElementById("attention-count"),backgroundCount:document.getElementById("background-count"),idleCount:document.getElementById("idle-count"),activeCount:document.getElementById("active-count"),activeList:document.getElementById("active-list"),activeEmpty:document.getElementById("active-empty"),terminalCount:document.getElementById("terminal-count"),terminalList:document.getElementById("terminal-list"),terminalEmpty:document.getElementById("terminal-empty"),terminalMoreWrap:document.getElementById("terminal-more-wrap"),terminalMore:document.getElementById("terminal-more"),statusIdleToggle:document.getElementById("status-idle-toggle"),statusIdlePanel:document.getElementById("status-idle-panel"),statusIdleCount:document.getElementById("status-idle-count"),idleList:document.getElementById("idle-list"),idleEmpty:document.getElementById("idle-empty"),idleMoreWrap:document.getElementById("idle-more-wrap"),idleMore:document.getElementById("idle-more"),message:document.getElementById("message"),updated:document.getElementById("updated")};
    function resolveLocale(value){const normalized=String(value||"en").replaceAll("_","-").toLowerCase();if(normalized==="ko"||normalized.startsWith("ko-"))return"ko";if(normalized==="ja"||normalized.startsWith("ja-"))return"ja";if(normalized==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(normalized))return"zh-Hant";if(normalized==="zh"||normalized==="zh-hans"||normalized.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(normalized===key||normalized.startsWith(key+"-"))return key;return"en"}
    function effectiveLocaleTag(){return localePreference==="auto"?hostLocaleTag:localePreference}
    function setLocale(value,rerender=true){localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;document.title=t["dashboard.title"];for(const item of document.querySelectorAll("[data-i18n]"))item.textContent=t[item.dataset.i18n]||BUNDLES.en[item.dataset.i18n]||item.dataset.i18n;elements.counts.setAttribute("aria-label",t["dashboard.countsLabel"]);elements.refresh.setAttribute("aria-label",t["common.refresh"]);elements.refresh.setAttribute("title",t["common.refresh"]);if(rerender&&view)paint(view)}
    function rpcRequest(method,params,timeout=70000,timeoutCode=""){if(!mounted)return Promise.reject(new Error("Codex overview unmounted"));return new Promise((resolve,reject)=>{const id=requestId++,timer=setTimeout(()=>{pending.delete(id);const error=new Error(t["common.error"]);if(timeoutCode)error.code=timeoutCode;reject(error)},timeout);pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*")})}
    function rpcNotification(method,params){window.parent.postMessage({jsonrpc:"2.0",method,params},"*")}
    async function initializeStandardBridge(){try{const result=await rpcRequest("ui/initialize",{appInfo:{name:"codex-mcp-bridge-dashboard",version:"${DASHBOARD_CARD_CONTRACT_GENERATION}"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},STANDARD_BRIDGE_INIT_TIMEOUT_MS);if(!result||typeof result.protocolVersion!=="string")return false;standardBridgeInitialized=true;document.documentElement.dataset.mcpApps="initialized";const context=result.hostContext||{};if(context.locale)hostLocaleTag=String(context.locale);rpcNotification("ui/notifications/initialized",{});if(localePreference==="auto")setLocale(hostLocaleTag);if(sizeReportingReady)scheduleSizeChanged(true);return true}catch{document.documentElement.dataset.mcpApps="fallback";return false}}
    function beginStandardBridge(){if(standardBridgeInitialized)return Promise.resolve(true);if(standardBridgeAttempt)return standardBridgeAttempt;standardBridgeAttempt=initializeStandardBridge().finally(()=>{standardBridgeAttempt=null});standardBridgeReady=standardBridgeAttempt;return standardBridgeAttempt}
    async function standardToolCall(name,args){const ready=standardBridgeInitialized||await standardBridgeReady;if(!ready)throw new Error(t["common.error"]);const result=await rpcRequest("tools/call",{name,arguments:args},TOOL_CALL_TIMEOUT_MS,"MCP_TOOL_CALL_DISPATCH_TIMEOUT");return result&&result.result||result}
    async function callTool(name,args){const compatibility=window.openai&&typeof window.openai.callTool==="function"?()=>window.openai.callTool(name,args):undefined;if(compatibility)return callUiToolWithFallback(compatibility,()=>standardToolCall(name,args),{standardTimeoutMs:TOOL_CALL_TIMEOUT_MS,compatibilityTimeoutMs:STANDARD_CALL_BUDGET_MS,timeoutMessage:t["common.error"]});return callUiToolWithFallback(()=>standardToolCall(name,args),undefined,{standardTimeoutMs:STANDARD_CALL_BUDGET_MS,compatibilityTimeoutMs:TOOL_CALL_TIMEOUT_MS,timeoutMessage:t["common.error"]})}
    function privateView(metadataValue){const metadata=hostToolResultMetadata(metadataValue),candidate=metadata&&metadata[DASHBOARD_VIEW_METADATA_KEY];return candidate&&candidate.kind==="codex/dashboardView"&&candidate.version===${DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION}&&candidate.purpose==="bridge-wide-read-only-hydration"?candidate.view:null}
    function parsedToolText(result){const item=result&&Array.isArray(result.content)&&result.content.find((entry)=>entry&&entry.type==="text"&&typeof entry.text==="string");if(!item)return null;try{return JSON.parse(item.text)}catch{return null}}
    function errorText(value){if(typeof value==="string")return value;if(value&&typeof value.message==="string")return value.message;if(value&&value.error)return errorText(value.error);try{return JSON.stringify(value)}catch{return t["common.error"]}}
    function unwrap(value){const result=normalizeHostToolResult(value),metadata=hostToolResultMetadata(value),candidate=privateView(metadata)||result&&result.structuredContent||parsedToolText(result)||result;if(result&&result.isError)throw new Error(errorText(result));if(!candidate||candidate.kind!=="dashboard"||candidate.statusSource!=="codex-runtime-only"||!candidate.counts||!Array.isArray(candidate.activeRows)||!Array.isArray(candidate.terminalRows)||!Array.isArray(candidate.idleRows)||!candidate.pagination||!candidate.pagination.active||!candidate.pagination.terminal||!candidate.pagination.idle)throw new Error(t["common.error"]);const responseLocale=metadata.hostLocale||metadata["openai/locale"]||metadata["webplus/i18n"];if(responseLocale)hostLocaleTag=String(responseLocale);return candidate}
    function node(tag,className,text){const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value}
    function formatNumber(value){return new Intl.NumberFormat(localeTag).format(Number(value)||0)}
    function renderWeeklyUsage(usage){const valid=usage&&Number.isFinite(Number(usage.remainingPercent));elements.weeklyUsage.hidden=!valid;if(!valid)return;const remaining=Math.min(100,Math.max(0,Number(usage.remainingPercent))),formatted=new Intl.NumberFormat(localeTag,{maximumFractionDigits:1}).format(remaining)+"%";elements.weeklyUsageValue.textContent=formatted;elements.weeklyUsageFill.style.width=remaining+"%";elements.weeklyUsageTrack.setAttribute("aria-valuemin","0");elements.weeklyUsageTrack.setAttribute("aria-valuemax","100");elements.weeklyUsageTrack.setAttribute("aria-valuenow",String(remaining));elements.weeklyUsageTrack.setAttribute("aria-valuetext",(t["usage.weeklyRemaining"]||"")+" "+formatted);const resetAt=usage.resetsAt&&new Date(usage.resetsAt);if(resetAt&&Number.isFinite(resetAt.getTime())){elements.weeklyUsageReset.hidden=false;elements.weeklyUsageReset.textContent=t["usage.resetsAt"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"short"}).format(resetAt))}else{elements.weeklyUsageReset.hidden=true;elements.weeklyUsageReset.textContent=""}}
    function durationUnit(key,count){return t["dashboard.duration."+key].replace("{count}",formatNumber(count))}
    function formatDuration(ms){const seconds=Math.max(0,Math.floor((Number(ms)||0)/1000));if(seconds<60)return durationUnit("seconds",seconds);const minutes=Math.floor(seconds/60);if(minutes<60)return durationUnit("minutes",minutes);const hours=Math.floor(minutes/60);if(hours<48){const values=[durationUnit("hours",hours)];if(minutes%60)values.push(durationUnit("minutes",minutes%60));return values.join(" ")}const days=Math.floor(hours/24),values=[durationUnit("days",days)];if(hours%24)values.push(durationUnit("hours",hours%24));return values.join(" ")}
    function relativeTime(value){const timestamp=Date.parse(value);if(!Number.isFinite(timestamp))return"";const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));let amount,unit;if(seconds<60){amount=seconds;unit="second"}else{const minutes=Math.floor(seconds/60);if(minutes<60){amount=minutes;unit="minute"}else{const hours=Math.floor(minutes/60);if(hours<48){amount=hours;unit="hour"}else{amount=Math.floor(hours/24);unit="day"}}}return new Intl.RelativeTimeFormat(localeTag,{numeric:"auto"}).format(-amount,unit)}
    function statusLabel(status){return t["dashboard.status."+status]||status}
    function tone(status){if(status==="running"||status==="background-process-running")return"running";if(["input-required","approval-required","terminating","liveness-unknown"].includes(status))return"attention";if(["termination-failed","failed","interrupted","orphaned"].includes(status))return"failed";if(status==="completed")return"completed";return"idle"}
    function latestTurn(row){if(Object.prototype.hasOwnProperty.call(row,"latestTurn"))return row.latestTurn&&typeof row.latestTurn==="object"?row.latestTurn:null;const terminal=["completed","failed","interrupted","cancelled"].includes(row.status),started=Date.parse(row.createdAt),ended=Date.parse(row.updatedAt),duration=terminal&&Number.isFinite(started)&&Number.isFinite(ended)?Math.max(0,ended-started):Math.max(0,Number(row.elapsedMs)||0);return{activityKey:row.activityKey,activityTitle:row.activityTitle||null,execution:row.execution,status:row.status,startedAt:row.createdAt,updatedAt:row.updatedAt,endedAt:terminal?row.updatedAt:null,durationMs:duration}}
    function timeMeta(turn,rowStatus){if(!turn)return"";const active=!turn.endedAt&&["running","input-required","approval-required","terminating","termination-failed","liveness-unknown","orphaned"].includes(rowStatus);if(active)return turn.durationMs==null?t["dashboard.time.durationUnknown"]:t["dashboard.time.active"].replace("{duration}",formatDuration(turn.durationMs));const duration=turn.durationMs==null?t["dashboard.time.durationUnknown"]:t["dashboard.time.duration"].replace("{duration}",formatDuration(turn.durationMs)),ended=t["dashboard.time.terminal"].replace("{status}",statusLabel(turn.status)).replace("{relative}",relativeTime(turn.endedAt||turn.updatedAt));return[duration,ended].filter(Boolean).join(" · ")}
    function safeConversationUrl(value){if(typeof value!=="string"||!/^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return null;return value}
    function safeCodexThreadUrl(value){if(typeof value!=="string"||!/^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return null;return value}
    function openConversationFallback(url){window.open(url,"_blank","noopener,noreferrer")}
    function openConversation(event,url){dispatchDashboardExternalUrl(event,url,window.openai,openConversationFallback)}
    function appendRowContext(parent,row,mode="row"){const context=node("div","row-context"),codexUrl=safeCodexThreadUrl(row.codexThreadUrl),conversationUrl=safeConversationUrl(row.conversationUrl);if(mode!=="agent")context.appendChild(node("span","project-label",row.projectName||t["dashboard.unknownProject"]));if(mode!=="activity"&&codexUrl){const link=node("a","conversation-link codex-session-link",t["dashboard.openCodexSession"]+" ↗");link.href=codexUrl;link.target="_blank";link.rel="noopener noreferrer";link.addEventListener("click",(event)=>openConversation(event,codexUrl));context.appendChild(link)}if(mode!=="agent"&&conversationUrl){const link=node("a","conversation-link",t["dashboard.openConversation"]+" ↗");link.href=conversationUrl;link.target="_blank";link.rel="noopener noreferrer";link.addEventListener("click",(event)=>openConversation(event,conversationUrl));context.appendChild(link)}if(context.childElementCount)parent.appendChild(context)}
    function rowMeta(row){const values=[];if(Number(row.backgroundProcessCount)>0)values.push(t["dashboard.backgroundProcessCount"].replace("{count}",formatNumber(row.backgroundProcessCount)));return values.join(" · ")}
    function executionText(execution){const selected=execution.modelDisplayName||execution.model,rerouted=execution.reroutedModelDisplayName||execution.reroutedModel,model=rerouted?selected+" → "+rerouted:selected;return model+" · "+execution.reasoningEffort}
    function appendExecution(parent,execution,next=false){if(!execution)return;const value=executionText(execution),text=next?t["dashboard.execution.next"].replace("{execution}",value):value,badge=node("div","execution",text);badge.title=text;parent.appendChild(badge)}
    function cancellationHeading(cancellation){if(cancellation.status==="requested")return t["cancellation.requestReason"];if(cancellation.status==="failed")return t["cancellation.attemptReason"];return t["cancellation.reason"]}
    function appendCancellation(parent,cancellation,key){if(!cancellation||typeof cancellation.reason!=="string"||!cancellation.reason.trim())return;const details=node("details","cancellation"),summary=node("summary","cancellation-toggle"),chevron=node("span","cancellation-chevron"),body=node("div","cancellation-body"),meta=[t["cancellation.target."+cancellation.targetKind]||String(cancellation.targetKind||"")],requestedAt=new Date(cancellation.requestedAt);chevron.setAttribute("aria-hidden","true");summary.append(chevron,node("span","",cancellationHeading(cancellation)));if(Number.isFinite(requestedAt.getTime()))meta.push(new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"short"}).format(requestedAt));body.append(node("div","cancellation-meta",meta.filter(Boolean).join(" · ")),node("div","cancellation-reason",cancellation.reason));details.append(summary,body);details.open=expandedCancellations.has(key);details.addEventListener("toggle",()=>{if(details.open)expandedCancellations.add(key);else expandedCancellations.delete(key);scheduleSizeChanged(true)});parent.appendChild(details)}
    function historyKey(row){return String(row.rowKey||[row.conversationKey||row.sessionAlias,row.projectKey||row.projectName,row.agentName].join("\u0000"))}
    function syncHistorySummary(details,label,shown,total){const partial=total>shown,key=partial?(details.open?"dashboard.history.hidePartial":"dashboard.history.showPartial"):(details.open?"dashboard.history.hide":"dashboard.history.show");label.textContent=t[key].replace("{shown}",formatNumber(shown)).replace("{count}",formatNumber(total))}
    function turnActivityTitle(turn){return turn&&turn.activityTitle||t["dashboard.jobFallback"]}
    function renderHistoryTurn(turn,key,showActivityTitle){const item=node("div","history-turn"),head=node("div","row-head"),state=node("span","status "+tone(turn.status),statusLabel(turn.status));if(showActivityTitle)head.append(node("div","row-title",turnActivityTitle(turn)),state);else{head.classList.add("history-state-only");head.appendChild(state)}item.append(head,node("div","time",timeMeta(turn,turn.status)));appendExecution(item,turn.execution);appendCancellation(item,turn.cancellation,key);return item}
    function appendAgentHistory(parent,row,turn){const history=Array.isArray(row.history)?row.history:[],historyTotal=Math.max(history.length,Number(row.historyCount)||0);if(!history.length)return;const key=historyKey(row),details=node("details","history"),summary=node("summary","history-toggle"),chevron=node("span","history-chevron"),label=node("span","history-label"),list=node("div","history-list");let previousActivityIdentity=dashboardHistoryActivityIdentity(turn);chevron.setAttribute("aria-hidden","true");summary.append(chevron,label);history.forEach((historicalTurn,index)=>{const activityIdentity=dashboardHistoryActivityIdentity(historicalTurn);list.appendChild(renderHistoryTurn(historicalTurn,key+"\u0000history\u0000"+index+"\u0000"+String(historicalTurn.cancellation&&historicalTurn.cancellation.requestedAt||""),activityIdentity!==previousActivityIdentity));previousActivityIdentity=activityIdentity});details.append(summary,list);details.open=expandedHistories.has(key);syncHistorySummary(details,label,history.length,historyTotal);details.addEventListener("toggle",()=>{if(details.open)expandedHistories.add(key);else expandedHistories.delete(key);syncHistorySummary(details,label,history.length,historyTotal);scheduleSizeChanged(true)});parent.appendChild(details)}
    function appendAgentBody(body,row,grouped=false,suppressExecution=false,suppressNextExecution=false){const head=node("div","row-head"),title=node("div","row-title",row.agentName||t["dashboard.jobFallback"]),state=node("span","status "+tone(row.status),statusLabel(row.status)),turn=latestTurn(row),rowKey=historyKey(row);head.append(title,state);body.appendChild(head);if(!grouped&&turn)body.appendChild(node("div","turn-title",turnActivityTitle(turn)));appendRowContext(body,row,grouped?"agent":"row");const meta=rowMeta(row);if(meta)body.appendChild(node("div","meta",meta));if(turn){body.appendChild(node("div","time",timeMeta(turn,row.status)));if(!suppressExecution)appendExecution(body,turn.execution);if(!grouped||turn.cancellation&&turn.cancellation.targetKind!=="activity")appendCancellation(body,turn.cancellation,rowKey+"\u0000current\u0000"+String(turn.cancellation&&turn.cancellation.requestedAt||""))}else if(row.bucket!=="active")body.appendChild(node("div","time",[t["dashboard.time.durationUnknown"],relativeTime(row.updatedAt)].filter(Boolean).join(" · ")));if(!suppressNextExecution&&shouldShowDashboardNextExecution(row.execution,turn&&turn.execution))appendExecution(body,row.execution,true);appendAgentHistory(body,row,turn)}
    function renderActivityGroup(parent,group,recentActivity=false){const representative=group.rows[0];if(!representative)return;const item=node("article","row activity-group"),body=node("div","row-body"),head=node("div","row-head"),identity=node("div","identity"),title=node("div","row-title",group.activityTitle||(recentActivity?t["dashboard.noRecentActivity"]:t["dashboard.jobFallback"])),agents=node("div","activity-agent-list"),commonExecution=commonDashboardExecution(group.rows),commonNextExecution=commonDashboardNextExecution(group.rows),activityCancellation=group.rows.map((row)=>latestTurn(row)).find((turn)=>turn&&turn.cancellation&&turn.cancellation.targetKind==="activity")?.cancellation;if(recentActivity)identity.appendChild(node("div","meta",t["dashboard.recentActivity"]));identity.appendChild(title);head.appendChild(identity);body.appendChild(head);appendRowContext(body,representative,"activity");body.appendChild(node("div","activity-group-count",t["dashboard.agentCount"].replace("{count}",formatNumber(group.rows.length))));appendExecution(body,commonExecution);appendExecution(body,commonNextExecution,true);appendCancellation(body,activityCancellation,"activity\u0000"+group.activityKey+"\u0000"+String(activityCancellation&&activityCancellation.requestedAt||""));for(const row of group.rows){const agent=node("div","activity-agent");appendAgentBody(agent,row,true,Boolean(commonExecution),Boolean(commonNextExecution));agents.appendChild(agent)}body.appendChild(agents);item.appendChild(body);parent.appendChild(item)}
    function renderActivityRows(parent,rows,recentActivity=false){parent.replaceChildren();for(const group of groupDashboardRowsByActivity(rows))renderActivityGroup(parent,group,recentActivity)}
    function rowIdentity(row){return String(row.rowKey||[row.conversationKey,row.projectKey,row.agentName].map((value)=>String(value||"")).join("\u0000"))}
    function mergeRows(current,incoming){const merged=current.slice(),indexByKey=new Map(merged.map((row,index)=>[rowIdentity(row),index]));for(const row of incoming){const key=rowIdentity(row),index=indexByKey.get(key);if(index===undefined){indexByKey.set(key,merged.length);merged.push(row)}else merged[index]=row}return merged}
    function agentCountText(total){return t["dashboard.agentCount"].replace("{count}",formatNumber(total))}
    function syncDisclosure(){const total=idlePagination?idlePagination.total:0,visible=total>0&&statusIdleExpanded;elements.statusIdleToggle.disabled=total===0;elements.statusIdleToggle.setAttribute("aria-expanded",String(visible));elements.statusIdlePanel.hidden=!visible}
    function syncLoadMoreControls(){const terminalHasNext=Boolean(terminalPagination&&terminalPagination.hasNext),idleHasNext=Boolean(idlePagination&&idlePagination.hasNext);elements.terminalMoreWrap.hidden=!terminalHasNext;elements.idleMoreWrap.hidden=!idleHasNext;elements.terminalMore.disabled=busy||!terminalHasNext;elements.idleMore.disabled=busy||!idleHasNext}
    function paint(next){renderWeeklyUsage(next.weeklyUsage);elements.content.hidden=false;elements.projectCount.textContent=formatNumber(next.counts.trackedProjects);elements.scopeCount.textContent=formatNumber(next.counts.trackedConversations);elements.runningCount.textContent=formatNumber(next.counts.running);elements.attentionCount.textContent=formatNumber(next.counts.needsAttention);elements.backgroundCount.textContent=formatNumber(next.counts.backgroundProcesses);elements.idleCount.textContent=formatNumber(next.counts.idleAgents);elements.activeCount.textContent=agentCountText(next.pagination.active.total);elements.terminalCount.textContent=agentCountText(terminalPagination?terminalPagination.total:terminalRows.length);elements.statusIdleCount.textContent=agentCountText(idlePagination?idlePagination.total:idleRows.length);renderActivityRows(elements.activeList,activeRows);renderActivityRows(elements.terminalList,terminalRows);renderActivityRows(elements.idleList,idleRows,true);elements.activeEmpty.hidden=activeRows.length>0;elements.terminalEmpty.hidden=terminalRows.length>0;elements.idleEmpty.hidden=idleRows.length>0;syncDisclosure();syncLoadMoreControls();elements.updated.textContent=t["dashboard.updated"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"medium"}).format(new Date(next.generatedAt)));const notices=[];if(next.pagination.active.hasNext)notices.push(t["dashboard.activeTruncated"]);if(next.counts.runtimeUnknownAgents>0)notices.push(t["dashboard.runtimeUnknown"].replace("{count}",formatNumber(next.counts.runtimeUnknownAgents)));if(next.counts.runtimeProbeSkippedAgents>0)notices.push(t["dashboard.runtimeProbeSkipped"].replace("{count}",formatNumber(next.counts.runtimeProbeSkippedAgents)));elements.message.textContent=notices.join(" ");elements.message.classList.remove("error");sizeReportingReady=true;scheduleSizeChanged()}
    function render(next,localeReady=false,pageRequest=appendRequest){const renderedAt=Date.parse(next.generatedAt);if(Number.isFinite(renderedAt)&&renderedAt<lastRenderedAt)return false;if(Number.isFinite(renderedAt))lastRenderedAt=renderedAt;view=next;localePreference=next.uiLocalePreference||"auto";activeRows=next.activeRows.slice();const cache=reconcileDashboardPageCaches({terminalRows,idleRows,terminalPagination,idlePagination},{activeRows:next.activeRows,terminalRows:next.terminalRows,idleRows:next.idleRows,terminalPagination:next.pagination.terminal,idlePagination:next.pagination.idle},pageRequest,mergeRows,rowIdentity);terminalRows=cache.terminalRows;idleRows=cache.idleRows;terminalPagination=cache.terminalPagination;idlePagination=cache.idlePagination;if(!localeReady)setLocale(effectiveLocaleTag(),false);paint(next);return true}
    function invalidateDashboardView(){view=null;activeRows=[];terminalRows=[];idleRows=[];terminalPagination=null;idlePagination=null;appendRequest=null;lastRenderedAt=0;elements.content.hidden=true;elements.updated.textContent="";elements.message.textContent=t["common.loading"];elements.message.classList.remove("error");sizeReportingReady=true;scheduleSizeChanged(true)}
    function setBusy(value){busy=value;elements.refresh.disabled=value;elements.card.setAttribute("aria-busy",String(value));syncLoadMoreControls()}
    function showError(_error){if(view){elements.message.textContent=t["dashboard.refreshFailedRetained"];elements.message.classList.remove("error");automaticRefreshDisabled=true}else{elements.message.textContent=t["dashboard.restoreFailed"];elements.message.classList.add("error")}sizeReportingReady=true;scheduleSizeChanged(true)}
    function intrinsicHeight(){const html=document.documentElement,original=html.style.height;html.style.height="max-content";const height=Math.ceil(html.getBoundingClientRect().height);html.style.height=original;return height}
    function emitSizeChanged(force=false){if(!sizeReportingReady)return;const compatibility=window.openai&&typeof window.openai.notifyIntrinsicHeight==="function";if(!standardBridgeInitialized&&!compatibility)return;const width=Math.ceil(window.innerWidth),height=intrinsicHeight();if(!force&&width===lastWidth&&height===lastHeight)return;lastWidth=width;lastHeight=height;if(standardBridgeInitialized)rpcNotification("ui/notifications/size-changed",{width,height});if(compatibility)window.openai.notifyIntrinsicHeight(height)}
    function scheduleSizeChanged(force=false){sizeChangeForced=sizeChangeForced||force;if(sizeFrame)return;sizeFrame=requestAnimationFrame(()=>{sizeFrame=0;const forced=sizeChangeForced;sizeChangeForced=false;emitSizeChanged(forced)})}
    async function enrich(args,epoch,pageRequest=null){try{const result=await callTool("codex_dashboard_snapshot",{...args,enrich:true});if(mounted&&epoch===hydrationEpoch)render(unwrap(result),false,pageRequest)}catch{} }
    async function reload(manual=false){if(busy||!mounted||!manual&&automaticRefreshDisabled)return;if(manual)automaticRefreshDisabled=false;const epoch=++hydrationEpoch;setBusy(true);try{appendRequest=null;const args={widgetInstanceId,limit:PAGE_LIMIT,terminalOffset:0,idleOffset:0,enrich:false},result=await callTool("codex_dashboard_snapshot",args);render(unwrap(result));lastRefreshAt=Date.now();automaticRefreshDisabled=false;void enrich(args,epoch)}catch(error){if(mounted)showError(error)}finally{appendRequest=null;setBusy(false)}}
    async function loadMore(bucket){if(busy||!mounted||!view)return;const page=bucket==="terminal"?terminalPagination:idlePagination;if(!page||!page.hasNext)return;const epoch=++hydrationEpoch;setBusy(true);try{const nextOffset=page.offset+page.returned,args={widgetInstanceId,limit:PAGE_LIMIT,terminalOffset:bucket==="terminal"?nextOffset:0,idleOffset:bucket==="idle"?nextOffset:0,enrich:false},pageRequest={bucket,requestedOffset:nextOffset};appendRequest=pageRequest;const result=await callTool("codex_dashboard_snapshot",args);render(unwrap(result),false,pageRequest);lastRefreshAt=Date.now();automaticRefreshDisabled=false;void enrich(args,epoch,pageRequest)}catch(error){if(mounted)showError(error)}finally{appendRequest=null;setBusy(false)}}
    elements.refresh.addEventListener("click",()=>void reload(true));elements.terminalMore.addEventListener("click",()=>void loadMore("terminal"));elements.idleMore.addEventListener("click",()=>void loadMore("idle"));elements.statusIdleToggle.addEventListener("click",()=>{if(!idlePagination||idlePagination.total===0)return;statusIdleExpanded=!statusIdleExpanded;syncDisclosure();scheduleSizeChanged(true)});
    function cancelPending(reason){for(const[id,request]of pending){rpcNotification("notifications/cancelled",{requestId:id,reason});request.reject(new Error(reason))}pending.clear()}
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.method==="ping"&&message.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(message.method==="ui/resource-teardown"){mounted=false;if(resizeObserver)resizeObserver.disconnect();cancelPending("Codex overview unmounted");if(message.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(Object.prototype.hasOwnProperty.call(message,"id")&&pending.has(message.id)){const handler=pending.get(message.id);pending.delete(message.id);if(message.error)handler.reject(new Error(errorText(message.error)));else handler.resolve(message.result);return}if(message.method==="ui/notifications/host-context-changed"){const context=message.params||{};if(context.locale){hostLocaleTag=String(context.locale);if(localePreference==="auto")setLocale(hostLocaleTag)}return}},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event&&event.detail&&event.detail.globals||{};if(globals.locale){hostLocaleTag=String(globals.locale);if(localePreference==="auto")setLocale(hostLocaleTag)}});
    window.addEventListener("pagehide",()=>{mounted=false;cancelPending("Codex overview unmounted")});window.addEventListener("pageshow",()=>{mounted=true;const requiresFresh=Date.now()-lastRefreshAt>1000;if(view&&requiresFresh)invalidateDashboardView();else if(view){syncDisclosure();syncLoadMoreControls();scheduleSizeChanged(true)}if(!standardBridgeInitialized)void beginStandardBridge();if(requiresFresh){automaticRefreshDisabled=false;void reload()}});document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible"||Date.now()-lastRefreshAt<=30000)return;automaticRefreshDisabled=false;if(view)invalidateDashboardView();void reload()});
    standardBridgeReady=beginStandardBridge();setLocale(localeTag,false);if(typeof ResizeObserver==="function"){resizeObserver=new ResizeObserver(()=>scheduleSizeChanged());resizeObserver.observe(document.documentElement);resizeObserver.observe(document.body)}void reload();
  </script>
</body>
</html>`;
