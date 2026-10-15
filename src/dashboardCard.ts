const PROBLEM_REVIEW_CSS = `.problem-note{font-size:12px;color:var(--muted)}.problem-reason{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.agent-jobs{display:flex;flex-direction:column;gap:8px}.execution-record+.execution-record{border-top:1px solid var(--border);padding-top:8px}.execution-record .execution-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.execution-head>.execution{min-width:0;max-width:100%;margin-top:0;border-radius:8px}.execution-head>.job-status{display:inline-flex;align-items:center;gap:4px;margin:0 0 0 auto;padding:3px 6px;border-radius:999px;background:var(--faint);white-space:nowrap;line-height:1.35}.job-status-icon{display:inline-flex;flex:none;width:11px;height:11px}.job-status-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}`;
const PROBLEM_REVIEW_MARKUP = `<section class="section" id="problem-section" hidden><div class="section-head"><h2 data-i18n="dashboard.problems"></h2><span id="problem-list-count"></span></div><div class="list" id="problem-list"></div><p class="empty" id="problem-empty"></p><div class="load-more-wrap" id="problem-page" hidden><button class="load-more" type="button" id="problem-next" data-i18n="dashboard.loadMore"></button></div></section>`;
const PROBLEM_REVIEW_SCRIPT = String.raw`
    let problemMutationInFlight=false,problemOffset=0;
    const problemElements={section:document.getElementById("problem-section"),list:document.getElementById("problem-list"),empty:document.getElementById("problem-empty"),page:document.getElementById("problem-page"),next:document.getElementById("problem-next"),count:document.getElementById("problem-list-count")};
    function problemQuery(){return {kind:"all",offset:0}}
    function resetProblems(){problemOffset=0;problemElements.list.replaceChildren()}
    function syncProblemControls(){problemElements.next.disabled=busy||!view?.problems?.page.hasNext}
    function retainedProblemRows(rows,next){const days=next.historyPolicy?.retentionDays,cutoff=days>0?Date.now()-days*86400000:-Infinity,seen=new Set();return rows.filter(problem=>{const row=problem.row,jobId=problem.jobId||row.jobId||problem.problemKey,status=row.latestTurn?.status||problem.kind,at=Date.parse(problem.occurredAt||problem.observedAt);if(problem.source!=="execution"||["unavailable","not-linked"].includes(problem.executionAvailability)||!["failed","interrupted","cancelled"].includes(status)||!(at>cutoff)||!jobRowVisible(row,next.historyPolicy)||seen.has(jobId))return false;seen.add(jobId);return true})}
    function renderProblems(next){const data=next.problems;problemElements.section.hidden=!data||selectedStatus!=="problems";if(!data)return;const visible=retainedProblemRows(data.rows,next);problemOffset=data.page.offset;problemElements.count.textContent=formatNumber(data.affectedExecutionCount??data.page.total);renderActivityRows(problemElements.list,visible.map(problem=>({...problem.row,jobId:problem.jobId||problem.row.jobId,agentId:problem.agentId||problem.row.agentId,error:problem.row.error||problem.error||(problem.kind!=="cancelled"?problem.reason:null)})));problemElements.empty.hidden=visible.length>0;problemElements.empty.textContent=t["problem.historyEmpty"];problemElements.page.hidden=!data.page.hasNext;syncProblemControls()}
    async function loadMoreProblems(){const current=view?.problems,page=current?.page;if(busy||!mounted||!page?.hasNext)return;const epoch=++hydrationEpoch,scope=selectedScope,offset=page.offset+page.returned;let rebase=false;setBusy(true);try{const next=unwrap(await dashboardRead({widgetInstanceId,scope,statusFilter:"all",problems:{...problemQuery(),offset},limit:PAGE_LIMIT,enrich:false,includeHistory:false}));if(!mounted||epoch!==hydrationEpoch||scope!==selectedScope||selectedStatus!=="problems")return;const data=next.problems;if(!data||data.revision!==current.revision||data.page.offset!==offset||next.historyPolicy?.policyRevision!==view.historyPolicy?.policyRevision){rebase=true;return}const seen=new Set();view={...view,problems:{...data,rows:[...current.rows,...data.rows].filter(problem=>{const key=problem.jobId||problem.row.jobId||problem.problemKey;if(seen.has(key))return false;seen.add(key);return true})}};paint(view)}catch(error){if(mounted&&epoch===hydrationEpoch&&scope===selectedScope)showError(error)}finally{if(epoch===hydrationEpoch){setBusy(false);if(rebase&&mounted&&scope===selectedScope&&selectedStatus==="problems")await reload(true,false)}}}
    problemElements.next.addEventListener("click",()=>void loadMoreProblems());
`;
import { DASHBOARD_CONTROL_SCRIPT } from "./dashboardControls.js";
import { CARD_FORM_SCRIPT } from "./cardForms.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { executionSpeedBadge } from "./executionPresentation.js";
import {
  resolveHostUiLocaleTag,
  serializedUiTranslations,
  UI_LOCALE_RESOLUTION,
  UI_TRANSLATIONS
} from "./uiI18n.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  currentUiResourceUri,
  currentUiResourceRevision,
  htmlForUiResource,
  uiRevisionMetadata
} from "./uiResources.js";
import {
  hostToolResultMetadata,
  normalizeHostToolResult,
  parseUiJsonTextStrict,
  uiJsonTextIsWellFormed
} from "./uiHostToolResult.js";
import {
  callUiToolWithFallback,
  withUiToolCallTimeout
} from "./uiToolCallFallback.js";
import { serializeUiFunction } from "./uiFunctionSerialization.js";
import { dashboardRowMatchesStatus, dashboardSummaryCategory } from "./dashboardPresentation.js";

export const DASHBOARD_CARD_URI = currentUiResourceUri("dashboard");
export const DASHBOARD_CARD_CONTRACT_GENERATION = 38;
export const DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION = 1;
export const DASHBOARD_VIEW_METADATA_KEY = "codex/dashboardView@1";
export const DASHBOARD_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const DASHBOARD_CARD_HTML_MAX_BYTES = 213 * 1_024;

type DashboardExecutionComparable = {
  model?: unknown;
  reasoningEffort?: unknown;
  serviceTier?: unknown;
  reroutedModel?: unknown;
  isCurrent?: unknown;
  serviceTierScope?: unknown;
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
  const leftTier = typeof left.serviceTier === "string"
    ? left.serviceTier.trim().toLowerCase() || "default"
    : "default";
  const rightTier = typeof right.serviceTier === "string"
    ? right.serviceTier.trim().toLowerCase() || "default"
    : "default";
  return Boolean(leftModel && rightModel && leftEffort && rightEffort) &&
    leftModel === rightModel &&
    leftEffort === rightEffort &&
    (left.serviceTierScope || "conversation") === (right.serviceTierScope || "conversation") &&
    (leftTier === rightTier || /^(priority|fast)$/.test(leftTier) && /^(priority|fast)$/.test(rightTier)) &&
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

export function groupDashboardRowsByAgent<Row extends {agentId?: unknown; agentName?: unknown; conversationKey?: unknown; rowKey?: unknown}>(rows: readonly Row[]): Array<{agentKey: string; rows: Row[]}> {
  const groups: Array<{agentKey: string; rows: Row[]}> = [], byKey = new Map<string, (typeof groups)[number]>();
  for (const row of rows) {
    const agentKey = String(row.agentId || row.rowKey || groups.length) + ":" + String(row.conversationKey || "");
    let group = byKey.get(agentKey);
    if (!group) { group = {agentKey, rows: []}; groups.push(group); byKey.set(agentKey, group); }
    group.rows.push(row);
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

export type DashboardHistoryActivityHeading =
  | { kind: "none" }
  | { kind: "boundary" }
  | { kind: "title"; title: string };

export function dashboardHistoryActivityHeading(
  turn: DashboardHistoryTurnIdentity | null | undefined,
  previousTurn: DashboardHistoryTurnIdentity | null | undefined,
  enclosingActivity: DashboardHistoryTurnIdentity | null | undefined
): DashboardHistoryActivityHeading {
  const currentIdentity = dashboardHistoryActivityIdentity(turn);
  const previousIdentity = dashboardHistoryActivityIdentity(previousTurn) ||
    dashboardHistoryActivityIdentity(enclosingActivity);
  if (currentIdentity === previousIdentity) return { kind: "none" };

  const title = typeof turn?.activityTitle === "string" ? turn.activityTitle.trim() : "";
  const previousTitle = typeof previousTurn?.activityTitle === "string"
    ? previousTurn.activityTitle.trim()
    : "";
  const enclosingTitle = typeof enclosingActivity?.activityTitle === "string"
    ? enclosingActivity.activityTitle.trim()
    : "";
  if (!title || title === previousTitle || title === enclosingTitle) {
    return { kind: "boundary" };
  }
  return { kind: "title", title };
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
  title: `${PRODUCT_INFO.displayName} Codex Status`,
  description:
    "Codex status card with conversation-first defaults, an all-conversations view, nested Agents, retained turn history, and validated request review.",
  mimeType: DASHBOARD_CARD_MIME_TYPE
} as const;
export const DASHBOARD_CARD_CONTENT_METADATA = {
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    domain: "https://web-sandbox.oaiusercontent.com"
  },
  "openai/widgetDescription":
    "Shows Codex work and history from this conversation when records exist, otherwise all conversations. Switch scope at the top; both views use the same execution states and approval/input request review.",
  "openai/widgetPrefersBorder": false,
  "openai/widgetCSP": {
    connect_domains: [] as string[],
    resource_domains: [] as string[],
    redirect_domains: ["https://chatgpt.com"]
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
  const revision = currentUiResourceRevision("dashboard");
  const revisionMetadata = uiRevisionMetadata(
    revision,
    DASHBOARD_CARD_RESOURCE_DESCRIPTOR,
    DASHBOARD_CARD_CONTENT_METADATA
  );
  server.registerResource(
    "codex-dashboard-card",
    revision.uri,
    revisionMetadata.descriptor,
    async () => ({
      contents: [
        {
          uri: revision.uri,
          mimeType: DASHBOARD_CARD_MIME_TYPE,
          text: htmlForUiResource("dashboard", revision.uri, DASHBOARD_CARD_HTML),
          _meta: revisionMetadata.content
        }
      ]
    })
  );
}

const DASHBOARD_TRANSLATION_KEYS = Object.keys(UI_TRANSLATIONS.en).filter((key) =>
  key.startsWith("dashboard.") && ![
    "dashboard.projects",
    "dashboard.conversations",
    "dashboard.attention",
    "dashboard.backgroundProcesses",
    "dashboard.idleAgents"
  ].includes(key)
);

export const DASHBOARD_CARD_HTML = String.raw`<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Codex</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--muted:color-mix(in srgb,CanvasText 62%,transparent);--faint:color-mix(in srgb,CanvasText 8%,transparent);--border:color-mix(in srgb,CanvasText 15%,transparent);--active:#16875a;--warn:#b87503;--danger:#c34132;--ok:#1a8f55;--unknown:#68758d}
    *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:transparent;color:CanvasText}.card{padding:14px}.header,.section-head,.row-head,.footer,.row-context,.load-more-wrap{display:flex;align-items:center;gap:8px}.header,.section-head,.footer{justify-content:space-between}.header{align-items:flex-start}.title-wrap{min-width:0}h1{margin:0;font-size:17px}.scope-note,.source-note,.meta,.time,.empty,.message,.project-label,.activity-group-count{color:var(--muted)}.scope-note{margin:3px 0 0;font-size:11px;line-height:1.45}.source-note{margin:9px 0 0;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--faint);font-size:11px;line-height:1.4}.icon-button{width:30px;height:30px;padding:0;display:grid;place-items:center;font-size:16px}.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:11px}.count{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:62px;padding:8px 5px;border:1px solid var(--border);border-radius:8px;background:var(--faint)}.count-heading{display:flex;align-items:center;justify-content:center;gap:4px;color:var(--muted)}.count-icon{width:12px;height:12px;flex:none;fill:currentColor}.count-value{font-size:20px;line-height:1.2;font-weight:760;font-variant-numeric:tabular-nums}.count-label{font-size:11px;line-height:1.3;overflow-wrap:anywhere}.count[aria-pressed="true"],#history-filter[aria-pressed="true"],#background-filter[aria-pressed="true"]{border-color:Highlight;background:color-mix(in srgb,Highlight 12%,Canvas)}.count:focus-visible,.status-reset:focus-visible,#background-filter:focus-visible{outline:2px solid Highlight;outline-offset:2px}.status-reset,.background-status{margin-top:8px;font-size:11px}.status-reset,#background-filter{font-size:11px;padding:4px 7px}.background-status{color:var(--muted)}.section{margin-top:13px}.section-head{padding-bottom:5px;border-bottom:1px solid var(--border)}h2{margin:0;font-size:13px}.section-toggle{display:flex;align-items:center;gap:7px;border:0;border-radius:0;background:transparent;color:CanvasText;padding:0;text-align:left;font:inherit}.section-toggle:hover{background:transparent}.section-toggle:disabled{opacity:1;cursor:default}.chevron,.history-chevron{display:inline-block;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}.section-toggle[aria-expanded="true"] .chevron,.history[open] .history-chevron{transform:rotate(45deg)}.section-count{color:var(--muted);font-size:11px}.list{display:grid}.row{display:grid;grid-template-columns:12px minmax(0,1fr);gap:9px;padding:10px 0;border-bottom:1px solid var(--border)}.activity-group{grid-template-columns:minmax(0,1fr)}.row:last-child{border-bottom:0}.dot{width:9px;height:9px;margin-top:4px;border-radius:50%;background:var(--unknown)}.dot.running{background:var(--active)}.dot.attention{background:var(--warn)}.dot.failed{background:var(--danger)}.dot.completed{background:var(--ok)}.row-body{min-width:0}.row-head{justify-content:space-between;align-items:flex-start}.row-title{min-width:0;font-size:13px;font-weight:750;overflow-wrap:anywhere}.turn-title{margin-top:4px;font-size:12px;font-weight:620;line-height:1.4;overflow-wrap:anywhere}.status{flex:0 0 auto;font-size:10px;font-weight:700}.status.running{color:var(--active)}.status.attention{color:var(--warn)}.status.failed{color:var(--danger)}.status.completed{color:var(--ok)}.row-context{justify-content:flex-start;flex-wrap:wrap;margin-top:5px;font-size:10px;line-height:1.35}.project-label{overflow-wrap:anywhere}.conversation-link{color:CanvasText;font-weight:700;text-decoration:none;border:1px solid var(--border);border-radius:8px;padding:3px 6px;background:Canvas}.conversation-link:hover{background:var(--faint)}.meta,.time{margin-top:3px;font-size:11px;line-height:1.4;overflow-wrap:anywhere}.execution{display:inline-block;max-width:100%;margin-top:6px;padding:2px 7px;border:1px solid var(--border);border-radius:999px;background:var(--faint);color:var(--muted);font-size:11px;line-height:1.35;overflow-wrap:anywhere}.activity-group-count{margin-top:4px;font-size:10px}.activity-agent-list{display:grid;margin-top:8px;padding-left:11px;border-left:2px solid var(--border)}.activity-agent{min-width:0;padding:8px 0;border-bottom:1px solid var(--border)}.activity-agent:last-child{border-bottom:0;padding-bottom:1px}.activity-agent .row-title{font-size:12px;font-weight:700}.activity-agent .status{font-size:9px}.history{margin-top:8px}.history-toggle{display:flex;align-items:center;gap:7px;width:max-content;max-width:100%;color:var(--muted);font-size:11px;font-weight:650;cursor:pointer;list-style:none}.history-toggle::-webkit-details-marker{display:none}.history-list{margin-top:7px;padding-left:11px;border-left:2px solid var(--border)}.history-turn{padding:7px 0;border-bottom:1px solid var(--border)}.history-turn:last-child{border-bottom:0}.history-turn .row-title{font-size:12px;font-weight:650}.history-turn .status{font-size:9px}.history-turn .history-state-only{justify-content:flex-start}.empty{padding:11px 0;font-size:11px}.load-more-wrap{justify-content:center;margin-top:9px}.load-more{min-width:120px}.footer{margin-top:11px;align-items:flex-start}.message{font-size:11px}.message.error{color:var(--danger)}.updated{font-size:10px;color:var(--muted);white-space:nowrap}button{border:1px solid var(--border);border-radius:8px;background:Canvas;color:CanvasText;padding:5px 8px;font-size:11px;font-weight:650;cursor:pointer}button:hover{background:var(--faint)}button:focus-visible,.history-toggle:focus-visible,.conversation-link:focus-visible{outline:2px solid color-mix(in srgb,var(--active) 70%,transparent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    .history-activity-boundary{font-size:10px;font-weight:650}
    @media(max-width:560px){.card{padding:12px}.row-head{display:block}.status{display:block;margin-top:2px}.footer{display:grid}.updated{white-space:normal}}
    .weekly-usage{margin-top:10px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--faint)}.weekly-usage-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px}.weekly-usage-label{color:var(--muted);font-weight:650}.weekly-usage-value{font-size:14px}.weekly-usage-track{height:5px;margin-top:7px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,CanvasText 12%,transparent)}.weekly-usage-fill{display:block;height:100%;border-radius:inherit;background:var(--active);transition:width .2s ease}.weekly-usage-reset,.weekly-usage-status{margin-top:5px;color:var(--muted);font-size:10px}
    .cancellation{margin-top:8px;padding-left:11px;border-left:2px solid color-mix(in srgb,var(--danger) 32%,var(--border))}.cancellation-heading{font-size:11px;font-weight:650}.cancellation-meta{margin-top:2px;color:var(--muted);font-size:10px;line-height:1.35}.cancellation-reason{margin-top:2px;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
    .work-control{margin-top:8px}.work-control-toggle{display:flex;align-items:center;gap:7px}.work-control-toggle[aria-expanded="true"] .chevron{transform:rotate(45deg)}#work-details{border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:8px;min-width:0}#work-details h3{margin:0;font-size:12px}#work-details .header>div{display:flex;gap:6px;flex-wrap:wrap}#work-details .actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}#work-details .interaction{display:grid;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)}#work-details input,#work-details select,#work-details textarea{font:inherit;color:CanvasText;background:Canvas;border:1px solid var(--border);border-radius:7px;padding:8px;max-width:100%}
  .fast-mode{display:inline-flex;align-items:center;margin-left:6px;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,#497ec8 14%,transparent);color:CanvasText;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:10px;font-weight:650;white-space:nowrap}
    .scope-selector{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.scope-selector button{font-size:12px;padding:6px 12px;border-radius:7px}.scope-selector button[aria-pressed="true"]{background:color-mix(in srgb,CanvasText 12%,Canvas);border-color:color-mix(in srgb,CanvasText 42%,transparent);font-weight:650}.scope-selector button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
${PROBLEM_REVIEW_CSS.trimStart()}
  </style>
</head>
<body>
  <main class="card">
    <header class="header">
      <div class="title-wrap"><h1 data-i18n="dashboard.title"></h1><p class="scope-note" id="scope-note"></p></div>
      <button id="refresh" class="icon-button" type="button"><span aria-hidden="true">↻</span></button>
    </header>
    <div class="scope-selector" id="scope-selector" role="group" hidden>
      <button id="scope-conversation" type="button" aria-pressed="false" data-i18n="dashboard.scope.conversation"></button>
      <button id="scope-all" type="button" aria-pressed="false" data-i18n="dashboard.scope.all"></button>
    </div>
    <p class="source-note" data-i18n="dashboard.scope.runtimeNotice"></p>
    <section class="weekly-usage" id="weekly-usage" aria-labelledby="weekly-usage-label" hidden>
      <div class="weekly-usage-head"><span class="weekly-usage-label" id="weekly-usage-label" data-i18n="usage.weeklyRemaining"></span><strong class="weekly-usage-value" id="weekly-usage-value"></strong></div>
      <div class="weekly-usage-track" id="weekly-usage-track" role="progressbar"><span class="weekly-usage-fill" id="weekly-usage-fill"></span></div>
      <div class="weekly-usage-status" id="weekly-usage-status" role="status"></div>
      <div class="weekly-usage-reset" id="weekly-usage-reset"></div>
      <div class="weekly-usage-reset" id="weekly-usage-observed"></div>
    </section>
    <div id="dashboard-content" hidden>
      <section class="counts" role="group">
        <button class="count" type="button" data-status-filter="running" aria-pressed="false"><span class="count-heading"><svg class="count-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg><span class="count-label" data-i18n="dashboard.running"></span></span><strong class="count-value" id="running-count">—</strong></button>
        <button class="count" type="button" data-status-filter="history" aria-pressed="false"><span class="count-heading"><svg class="count-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11ZM7.25 4h1.5v4l3 1.5-.7 1.3-3.8-1.9Z" fill-rule="evenodd"/></svg><span class="count-label" data-i18n="dashboard.recent"></span></span><strong class="count-value" id="response-count">—</strong></button>
        <button class="count" type="button" data-status-filter="problems" aria-pressed="false"><span class="count-heading"><svg class="count-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1 7 13H1L8 1Zm-.6 4v5h1.2V5Zm0 6v1.3h1.2V11Z" fill-rule="evenodd"/></svg><span class="count-label" data-i18n="dashboard.problems"></span></span><strong class="count-value" id="problems-count">—</strong></button>
      </section>
      <div class="background-status" id="background-status" hidden><button id="background-filter" type="button" data-status-filter="background" aria-pressed="false"></button><span id="background-unknown" data-i18n="dashboard.backgroundUnknown" hidden></span></div>
      <section class="section" id="active-section" hidden>
        <div class="section-head"><h2 data-i18n="dashboard.active"></h2><span class="section-count" id="active-count"></span></div>
        <div class="list" id="active-list"></div><div class="empty" id="active-empty" data-i18n="dashboard.noActive"></div>
        <div class="load-more-wrap" id="active-more-wrap" hidden><button id="active-more" class="load-more" hidden type="button" data-i18n="dashboard.loadMore"></button></div>
      </section>
${PROBLEM_REVIEW_MARKUP.trimStart()}
      <section class="section" id="terminal-section" hidden>
        <div class="section-head"><h2 data-i18n="dashboard.recent"></h2><span class="section-count" id="terminal-count"></span></div>
        <div class="list" id="terminal-list"></div><div class="empty" id="terminal-empty" data-i18n="dashboard.noRecent"></div>
        <div class="load-more-wrap" id="terminal-more-wrap" hidden><button id="terminal-more" class="load-more" type="button" data-i18n="dashboard.loadMore"></button></div>
      </section>
    </div>
    <p id="history-policy" class="source-note" style="white-space:pre-line" hidden></p>
    <template id="work-details-template"><section id="work-details" role="region" aria-labelledby="work-details-title" hidden><header class="header"><h3 id="work-details-title"></h3><div><button id="work-details-refresh" type="button" data-i18n="common.refresh"></button><button id="work-details-close" type="button" data-i18n="dashboard.control.close"></button></div></header><p id="work-details-message" class="message" role="status"></p><div id="work-details-body"></div></section></template>
    <footer class="footer"><span class="message" id="message" role="status" aria-live="polite" data-i18n="common.loading"></span><span class="updated" id="updated"></span></footer>
  </main>
  <script>
    document.documentElement.dataset.cardResourceUri=${JSON.stringify(DASHBOARD_CARD_URI)};
    document.documentElement.dataset.cardContractGeneration=${DASHBOARD_CARD_CONTRACT_GENERATION};
    const BUNDLES=${serializedUiTranslations(["execution", "settings.processingSpeed", "problem", "common", "usage", "cancellation", "history.finite", "history.unlimited", "history.notice", "history.cleanup", "history.acknowledge", "history.started", ...DASHBOARD_TRANSLATION_KEYS, "activity.lastChanged", "activity.approve", "activity.approveSession", "activity.decline", "activity.answer", "activity.inputRequired", "activity.approval", "activity.optionalInput", "activity.openRequest", "activity.otherAnswer", "activity.yes", "activity.no", "question.gptHandles"], true)};
    const LOCALE_RESOLUTION=${JSON.stringify(UI_LOCALE_RESOLUTION)};
    ${serializeUiFunction(resolveHostUiLocaleTag)}
    ${serializeUiFunction(uiJsonTextIsWellFormed)}
    ${serializeUiFunction(parseUiJsonTextStrict)}
    ${serializeUiFunction(normalizeHostToolResult)}
    ${serializeUiFunction(hostToolResultMetadata)}
    ${serializeUiFunction(withUiToolCallTimeout)}
    ${serializeUiFunction(callUiToolWithFallback)}
    ${serializeUiFunction(reconcileDashboardPageCaches)}
    ${serializeUiFunction(groupDashboardRowsByActivity)}
    ${serializeUiFunction(groupDashboardRowsByAgent)}
    ${serializeUiFunction(dashboardHistoryActivityIdentity)}
    ${serializeUiFunction(dashboardHistoryActivityHeading)}
    ${serializeUiFunction(dashboardExecutionsEqual)}
    ${serializeUiFunction(shouldShowDashboardNextExecution)}
    ${serializeUiFunction(dispatchDashboardExternalUrl)}
    ${serializeUiFunction(dashboardSummaryCategory)}
    ${serializeUiFunction(dashboardRowMatchesStatus)}
    function createWidgetInstanceId(){const cryptoApi=globalThis.crypto;if(cryptoApi&&typeof cryptoApi.randomUUID==="function")return cryptoApi.randomUUID();const bytes=new Uint8Array(16);if(cryptoApi&&typeof cryptoApi.getRandomValues==="function")cryptoApi.getRandomValues(bytes);else for(let index=0;index<bytes.length;index+=1)bytes[index]=Math.floor(Math.random()*256);bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;const hex=Array.from(bytes,(value)=>value.toString(16).padStart(2,"0")).join("");return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20)}
    const DASHBOARD_VIEW_METADATA_KEY=${JSON.stringify(DASHBOARD_VIEW_METADATA_KEY)},DASHBOARD_OPEN_METADATA_KEY="codex/dashboardOpen@2",widgetInstanceId=createWidgetInstanceId(),pending=new Map(),PAGE_LIMIT=12,STANDARD_BRIDGE_INIT_TIMEOUT_MS=5000,TOOL_CALL_TIMEOUT_MS=15000,STANDARD_CALL_BUDGET_MS=STANDARD_BRIDGE_INIT_TIMEOUT_MS+TOOL_CALL_TIMEOUT_MS+1000;
    const initialToolInput=window.openai&&window.openai.toolInput,initialToolOutput=window.openai&&window.openai.toolOutput,initialResponseMetadata=window.openai&&window.openai.toolResponseMetadata||{},initialMetadata=hostToolResultMetadata(initialResponseMetadata);
    let selectedStatus="all",selectedScope="auto",conversationAvailable=false,scopeReady=false;
    let requestId=1,view=null,busy=false,mounted=true,tornDown=false,appendRequest=null,hydrationEpoch=0,automaticRefreshDisabled=false,refreshFailed=false,enrichmentFailed=false,historyLoadQueued=false,enrichmentTarget=null,enrichmentRunning=false,activeRows=[],terminalRows=[],idleRows=[],historyActiveRows=[],historyTerminalRows=[],terminalPagination=null,idlePagination=null,hostLocaleTag=resolveHostUiLocaleTag(window.openai&&window.openai.locale,initialMetadata,navigator.language),localePreference="auto",localeTag=hostLocaleTag,locale=resolveLocale(localeTag),t=BUNDLES[locale]||BUNDLES.en,standardBridgeReady=Promise.resolve(false),standardBridgeAttempt=null,standardBridgeInitialized=false,lastRefreshAt=0,lastRenderedAt=0,sizeReportingReady=false,sizeFrame=0,sizeChangeForced=false,resizeObserver=null,lastWidth=-1,lastHeight=-1;
    let historyExpiryTimer=null,historySecurityGeneration=0;
    const executionDetails=new Map(),executionRequests=new Map(),executionErrors=new Map(),expandedExecutions=new Set();
    const expandedHistories=new Set(),historyDetails=new Map(),historyLoading=new Set(),historyErrors=new Map(),historyRequestTokens=new Map();
    const elements={scopeSelector:document.getElementById("scope-selector"),scopeConversation:document.getElementById("scope-conversation"),scopeAll:document.getElementById("scope-all"),scopeNote:document.getElementById("scope-note"),card:document.querySelector("main.card"),content:document.getElementById("dashboard-content"),counts:document.querySelector("section.counts"),refresh:document.getElementById("refresh"),weeklyUsage:document.getElementById("weekly-usage"),weeklyUsageValue:document.getElementById("weekly-usage-value"),weeklyUsageTrack:document.getElementById("weekly-usage-track"),weeklyUsageFill:document.getElementById("weekly-usage-fill"),weeklyUsageStatus:document.getElementById("weekly-usage-status"),weeklyUsageReset:document.getElementById("weekly-usage-reset"),weeklyUsageObserved:document.getElementById("weekly-usage-observed"),runningCount:document.getElementById("running-count"),responseCount:document.getElementById("response-count"),problemsCount:document.getElementById("problems-count"),backgroundStatus:document.getElementById("background-status"),backgroundFilter:document.getElementById("background-filter"),backgroundUnknown:document.getElementById("background-unknown"),activeSection:document.getElementById("active-section"),activeCount:document.getElementById("active-count"),activeList:document.getElementById("active-list"),activeEmpty:document.getElementById("active-empty"),terminalSection:document.getElementById("terminal-section"),terminalCount:document.getElementById("terminal-count"),terminalList:document.getElementById("terminal-list"),terminalEmpty:document.getElementById("terminal-empty"),terminalMoreWrap:document.getElementById("terminal-more-wrap"),terminalMore:document.getElementById("terminal-more"),message:document.getElementById("message"),updated:document.getElementById("updated")};
    function openingScope(input,metadata){const args=input&&typeof input==="object"&&(input.arguments||input)||{},open=metadata&&metadata[DASHBOARD_OPEN_METADATA_KEY],scope=open&&open.automatic===false?open.scope:args.scope;return scope==="conversation"||scope==="all"?scope:"auto"}
    function applyOpeningScope(input,metadata){const scope=openingScope(input,metadata);if(scope!=="auto"&&selectedScope!==scope){if(view)void selectScope(scope);else selectedScope=scope}}
    function resolveLocale(value){const normalized=String(value||"en").replaceAll("_","-").toLowerCase();if(normalized==="ko"||normalized.startsWith("ko-"))return"ko";if(normalized==="ja"||normalized.startsWith("ja-"))return"ja";if(LOCALE_RESOLUTION.traditionalChineseTags.some((tag)=>normalized===tag||normalized.startsWith(tag+"-"))||LOCALE_RESOLUTION.traditionalChineseRegions.some((region)=>new RegExp("^zh-"+region+"(-|$)").test(normalized)))return"zh-Hant";if(normalized==="zh"||normalized==="zh-hans"||normalized.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(normalized===key||normalized.startsWith(key+"-"))return key;return"en"}
    function effectiveLocaleTag(){return localePreference==="auto"?hostLocaleTag:localePreference}
    function setLocale(value,rerender=true){localeTag=String(value||"en").replaceAll("_","-");locale=resolveLocale(localeTag);t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=localeTag;document.title=t["dashboard.title"];for(const item of document.querySelectorAll("[data-i18n]"))item.textContent=t[item.dataset.i18n]||BUNDLES.en[item.dataset.i18n]||item.dataset.i18n;for(const item of document.querySelectorAll("[data-i18n-aria]"))item.setAttribute("aria-label",t[item.dataset.i18nAria]);elements.counts.setAttribute("aria-label",t["dashboard.countsLabel"]);elements.refresh.setAttribute("aria-label",t["common.refresh"]);elements.refresh.setAttribute("title",t["common.refresh"]);if(rerender&&view)paint(view)}
    function rpcRequest(method,params,timeout=70000,timeoutCode=""){if(!mounted)return Promise.reject(new Error("Codex overview unmounted"));return new Promise((resolve,reject)=>{const id=requestId++,timer=setTimeout(()=>{pending.delete(id);const error=new Error(t["common.error"]);if(timeoutCode)error.code=timeoutCode;reject(error)},timeout);pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*")})}
    function rpcNotification(method,params){window.parent.postMessage({jsonrpc:"2.0",method,params},"*")}
    async function initializeStandardBridge(){try{const result=await rpcRequest("ui/initialize",{appInfo:{name:"codex-mcp-bridge-dashboard",version:"${DASHBOARD_CARD_CONTRACT_GENERATION}"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},STANDARD_BRIDGE_INIT_TIMEOUT_MS);if(!result||typeof result.protocolVersion!=="string")return false;standardBridgeInitialized=true;document.documentElement.dataset.mcpApps="initialized";const context=result.hostContext||{};if(context.locale)hostLocaleTag=String(context.locale);rpcNotification("ui/notifications/initialized",{});if(localePreference==="auto")setLocale(hostLocaleTag);if(sizeReportingReady)scheduleSizeChanged(true);return true}catch{document.documentElement.dataset.mcpApps="fallback";return false}}
    function beginStandardBridge(){if(standardBridgeInitialized)return Promise.resolve(true);if(standardBridgeAttempt)return standardBridgeAttempt;const attempt=initializeStandardBridge().finally(()=>{if(standardBridgeAttempt===attempt)standardBridgeAttempt=null});standardBridgeAttempt=attempt;standardBridgeReady=attempt;return attempt}
    async function standardToolCall(name,args){const ready=standardBridgeInitialized||await beginStandardBridge();if(!ready)throw new Error(t["common.error"]);const result=await rpcRequest("tools/call",{name,arguments:args},TOOL_CALL_TIMEOUT_MS,"MCP_TOOL_CALL_DISPATCH_TIMEOUT");return result&&result.result||result}
    async function callTool(name,args,readOnly=true){const compatibility=window.openai&&typeof window.openai.callTool==="function"?()=>window.openai.callTool(name,args):undefined;if(compatibility)return callUiToolWithFallback(compatibility,()=>standardToolCall(name,args),{standardTimeoutMs:TOOL_CALL_TIMEOUT_MS,compatibilityTimeoutMs:STANDARD_CALL_BUDGET_MS,timeoutMessage:t["common.error"],shouldFallback:(error)=>readOnly&&error?.code!=="MCP_TOOL_CALL_DISPATCH_TIMEOUT"});return callUiToolWithFallback(()=>standardToolCall(name,args),undefined,{standardTimeoutMs:STANDARD_CALL_BUDGET_MS,compatibilityTimeoutMs:TOOL_CALL_TIMEOUT_MS,timeoutMessage:t["common.error"]})}

    function privateView(metadataValue){const metadata=hostToolResultMetadata(metadataValue),candidate=metadata&&metadata[DASHBOARD_VIEW_METADATA_KEY];return candidate&&candidate.kind==="codex/dashboardView"&&candidate.version===${DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION}&&candidate.purpose==="bridge-wide-read-only-hydration"?candidate.view:null}
    function parsedToolText(result){const item=result&&Array.isArray(result.content)&&result.content.find((entry)=>entry&&entry.type==="text"&&typeof entry.text==="string");return item?parseUiJsonTextStrict(item.text):null}
    function errorText(value){if(typeof value==="string")return value;if(value&&typeof value.message==="string")return value.message;if(value&&value.error)return errorText(value.error);try{return JSON.stringify(value)}catch{return t["common.error"]}}
    function unwrap(value){const result=normalizeHostToolResult(value),metadata=hostToolResultMetadata(value),candidate=privateView(metadata)||result&&result.structuredContent||parsedToolText(result)||result;if(result&&result.isError)throw new Error(errorText(result));if(!candidate||candidate.kind!=="dashboard"||candidate.statusSource!=="codex-runtime-only"||!candidate.counts||!Array.isArray(candidate.activeRows)||!Array.isArray(candidate.terminalRows)||!Array.isArray(candidate.idleRows)||!candidate.pagination||!candidate.pagination.active||!candidate.pagination.terminal||!candidate.pagination.idle)throw new Error(t["common.error"]);const responseLocale=metadata.hostLocale||metadata["openai/locale"]||metadata["webplus/i18n"];if(responseLocale)hostLocaleTag=String(responseLocale);return candidate}
    function unwrapHistoryDetail(value){const result=normalizeHostToolResult(value),candidate=result&&result.structuredContent||parsedToolText(result)||result;if(result&&result.isError)throw new Error(errorText(result));if(!candidate||candidate.kind!=="dashboard-history"||typeof candidate.rowKey!=="string"||!Array.isArray(candidate.history)||!Number.isInteger(candidate.historyCount)||candidate.historyRevision!==undefined&&(typeof candidate.historyRevision!=="string"||!/^[a-f0-9]{64}$/.test(candidate.historyRevision)))throw new Error(t["common.error"]);return candidate}
    function node(tag,className,text){const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value}
    function formatNumber(value){return new Intl.NumberFormat(localeTag).format(Number(value)||0)}
    function detailsIncomplete(value){return Boolean(value&&(value.usageTimedOut||value.usageUnavailable||value.timeouts>0||value.runtimeUnavailable>0||value.backgroundInventoryUnavailable))}
    function runtimeDetailsIncomplete(value){return Boolean(value&&(value.timeouts>0||value.runtimeUnavailable>0))}
    function backgroundStatusUnknown(counts,enrichment){const dedicated=Number.isFinite(counts.backgroundProcessUnknownAgents);return (dedicated?counts.backgroundProcessUnknownAgents:counts.runtimeUnknownAgents)>0||counts.runtimeProbeSkippedAgents>0||Boolean(enrichment?.backgroundInventoryUnavailable)||!dedicated&&(enrichmentFailed||runtimeDetailsIncomplete(enrichment))}
    function renderWeeklyUsage(view){
      const usage=view.weeklyUsage,valid=usage&&typeof usage.remainingPercent==="number"&&Number.isFinite(usage.remainingPercent);
      const state=view.usageDisplayStatus||(valid?"available":view.enrichment?.usageTimedOut?"timed-out":view.enrichment?.usageUnavailable?"unavailable":"checking");
      elements.weeklyUsage.hidden=!valid;elements.weeklyUsage.dataset.state=state;
      elements.weeklyUsageTrack.hidden=!valid;elements.weeklyUsageReset.hidden=true;elements.weeklyUsageObserved.hidden=true;
      const statusKey=state==="available"?"":state==="checking"?(valid?"usage.status.refreshing":"usage.status.checking"):
        state==="timed-out"?(valid?"usage.status.timedOutRetained":"usage.status.timedOut"):
        state==="unavailable"?(valid?"usage.status.unavailableRetained":"usage.status.unavailable"):"usage.status."+state;
      elements.weeklyUsageStatus.textContent=statusKey?t[statusKey]||t["usage.status.unavailable"]:"";
      elements.weeklyUsageStatus.hidden=!statusKey;
      if(!valid){elements.weeklyUsageValue.textContent="";elements.weeklyUsageStatus.textContent="";elements.weeklyUsageStatus.hidden=true;elements.weeklyUsageFill.style.removeProperty("width");elements.weeklyUsageTrack.removeAttribute("aria-valuenow");elements.weeklyUsageTrack.removeAttribute("aria-valuetext");return}
      const observedAt=new Date(usage.observedAt);
      elements.weeklyUsageObserved.hidden=!Number.isFinite(observedAt.getTime());
      elements.weeklyUsageObserved.textContent=Number.isFinite(observedAt.getTime())?t["usage.observedAt"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"medium"}).format(observedAt)):"";
      const remaining=Math.min(100,Math.max(0,usage.remainingPercent)),formatted=new Intl.NumberFormat(localeTag,{maximumFractionDigits:1}).format(remaining)+"%";
      elements.weeklyUsageValue.textContent=formatted;elements.weeklyUsageFill.style.width=remaining+"%";
      elements.weeklyUsageTrack.setAttribute("aria-valuemin","0");elements.weeklyUsageTrack.setAttribute("aria-valuemax","100");
      elements.weeklyUsageTrack.setAttribute("aria-valuenow",String(remaining));elements.weeklyUsageTrack.setAttribute("aria-valuetext",(t["usage.weeklyRemaining"]||"")+" "+formatted);
      const resetAt=usage.resetsAt&&new Date(usage.resetsAt);
      if(resetAt&&Number.isFinite(resetAt.getTime())){elements.weeklyUsageReset.hidden=false;elements.weeklyUsageReset.textContent=t["usage.resetsAt"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"short"}).format(resetAt))}
      else{elements.weeklyUsageReset.textContent=""}
    }
    function durationUnit(key,count){return t["dashboard.duration."+key].replace("{count}",formatNumber(count))}
    function formatDuration(ms){const seconds=Math.max(0,Math.floor((Number(ms)||0)/1000));if(seconds<60)return durationUnit("seconds",seconds);const minutes=Math.floor(seconds/60);if(minutes<60)return durationUnit("minutes",minutes);const hours=Math.floor(minutes/60);if(hours<48){const values=[durationUnit("hours",hours)];if(minutes%60)values.push(durationUnit("minutes",minutes%60));return values.join(" ")}const days=Math.floor(hours/24),values=[durationUnit("days",days)];if(hours%24)values.push(durationUnit("hours",hours%24));return values.join(" ")}
    function relativeTime(value){const timestamp=Date.parse(value);if(!Number.isFinite(timestamp))return"";const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));let amount,unit;if(seconds<60){amount=seconds;unit="second"}else{const minutes=Math.floor(seconds/60);if(minutes<60){amount=minutes;unit="minute"}else{const hours=Math.floor(minutes/60);if(hours<48){amount=hours;unit="hour"}else{amount=Math.floor(hours/24);unit="day"}}}return new Intl.RelativeTimeFormat(localeTag,{numeric:"auto"}).format(-amount,unit)}
    function statusLabel(status){return t["dashboard.status."+status]||status}
    function tone(status){if(status==="running"||status==="background-process-running")return"running";if(["input-required","approval-required","terminating","liveness-unknown"].includes(status))return"attention";if(["termination-failed","failed","interrupted","orphaned"].includes(status))return"failed";if(status==="completed")return"completed";return"idle"}
    function latestTurn(row){if(Object.prototype.hasOwnProperty.call(row,"latestTurn"))return row.latestTurn&&typeof row.latestTurn==="object"?row.latestTurn:null;const terminal=["completed","failed","interrupted","cancelled"].includes(row.status),started=Date.parse(row.createdAt),ended=Date.parse(row.updatedAt),duration=terminal&&Number.isFinite(started)&&Number.isFinite(ended)?Math.max(0,ended-started):Math.max(0,Number(row.elapsedMs)||0);return{activityKey:row.activityKey,activityTitle:row.activityTitle||null,execution:row.execution,status:row.status,startedAt:row.createdAt,updatedAt:row.updatedAt,endedAt:terminal?row.updatedAt:null,durationMs:duration}}
    function timeMeta(turn,rowStatus){if(!turn)return"";const active=!turn.endedAt&&["running","input-required","approval-required","terminating","termination-failed","liveness-unknown","orphaned","background-process-running"].includes(rowStatus||turn.status);if(active){const started=Date.parse(turn.startedAt);return Number.isFinite(started)?t["dashboard.time.started"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"medium",timeStyle:"short"}).format(new Date(started))):""}const elapsed=turn.durationMs,duration=elapsed==null?t["dashboard.time.durationUnknown"]:t["dashboard.time.duration"].replace("{duration}",formatDuration(elapsed)),relative=relativeTime(turn.endedAt||turn.updatedAt);return[duration,relative].filter(Boolean).join(" · ")}
    function renderHistoryPolicy(policy){const element=document.getElementById("history-policy");element.hidden=!policy||selectedStatus!=="history";if(!policy)return;const values=[(policy.retentionDays===0?t["history.unlimited"]:t["history.finite"].replace("{days}",formatNumber(policy.retentionDays))),t[policy.automaticRecovery?"problem.automaticHistoryNotice":policy.reviewUntilRetention?"problem.historyNotice":"history.notice"]];if(policy.lastCleanupAt)values.push(t["history.cleanup"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"short"}).format(new Date(policy.lastCleanupAt))).replace("{count}",formatNumber(policy.lastCleanupCount)));element.textContent=values.join("\n")}
    function safeConversationUrl(value){if(typeof value!=="string"||!/^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return null;return value}
    function openConversationFallback(url){window.open(url,"_blank","noopener,noreferrer")}
    function openConversation(event,url){dispatchDashboardExternalUrl(event,url,window.openai,openConversationFallback)}
    function appendRowContext(parent,row,mode="row"){const context=node("div","row-context"),conversationUrl=safeConversationUrl(row.conversationUrl);if(mode!=="agent")context.appendChild(node("span","project-label",row.projectName||t["dashboard.unknownProject"]));if(mode!=="agent"&&conversationUrl){const link=node("a","conversation-link",t["dashboard.openConversation"]+" ↗");link.href=conversationUrl;link.target="_blank";link.rel="noopener noreferrer";link.addEventListener("click",(event)=>openConversation(event,conversationUrl));context.appendChild(link)}if(context.childElementCount)parent.appendChild(context)}
    function rowMeta(row){const values=[];if(Number(row.backgroundProcessCount)>0)values.push(t["dashboard.backgroundProcessCount"].replace("{count}",formatNumber(row.backgroundProcessCount)));return values.join(" · ")}
    ${serializeUiFunction(executionSpeedBadge)}
    function executionText(execution){const selected=execution.modelDisplayName||execution.model,rerouted=execution.reroutedModelDisplayName||execution.reroutedModel,effort=String(execution.reasoningEffort||"").trim().toLowerCase(),speed=executionSpeedBadge(execution);return selected+(speed?" "+speed:"")+(rerouted?" → "+rerouted:"")+" · "+effort}
    function appendExecution(parent,execution,required=false,templateKey=null){if(!execution&&!required)return;const value=execution?executionText(execution):t["dashboard.execution.unavailable"],text=templateKey?t[templateKey].replace("{execution}",value):value,badge=node("div","execution",text),speed=executionSpeedBadge(execution,true);badge.title=speed?t["dashboard.execution.speedBadgeHint"].replace("{speed}",speed):text;parent.appendChild(badge)}
    function cancellationHeading(cancellation){if(cancellation.status==="requested")return t["cancellation.requestReason"];if(cancellation.status==="failed")return t["cancellation.attemptReason"];return t["cancellation.reason"]}
    function appendCancellation(parent,cancellation){if(!cancellation||typeof cancellation.reason!=="string"||!cancellation.reason.trim())return;const block=node("div","cancellation"),meta=[t["cancellation.target."+cancellation.targetKind]||String(cancellation.targetKind||"")],requestedAt=new Date(cancellation.requestedAt);if(Number.isFinite(requestedAt.getTime()))meta.push(new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"short"}).format(requestedAt));block.append(node("div","cancellation-heading",cancellationHeading(cancellation)),node("div","cancellation-meta",meta.filter(Boolean).join(" · ")),node("div","cancellation-reason",cancellation.reason));parent.appendChild(block)}
    function uiText(key,fallback){return t[key]||BUNDLES.en[key]||fallback}
    async function dashboardRead(args){try{const value=await callTool("codex_ui_read",{view:"dashboard",...args,historyMode:"jobs",includeHistory:args.includeHistory??true});const result=normalizeHostToolResult(value);if(result?.isError)throw new Error(errorText(result));return value}catch(error){const message=errorText(error);if(!/historyMode/i.test(message)||!/unrecognized|unknown|unsupported|invalid|not.found|-3260[12]/i.test(message))throw error;return await callTool("codex_ui_read",{view:"dashboard",...args})}}
    function jobRowVisible(row,policy){if(!row.jobId||!(policy?.retentionDays>0)||!row.latestTurn?.endedAt)return true;const ended=Date.parse(row.latestTurn.endedAt);return Number.isFinite(ended)&&ended+policy.retentionDays*86400000>Date.now()}
    function executionTarget(row,problem){const source=problem||row,jobId=source.jobId||row.jobId,scopeId=source.scopeId||row.scopeId,revision=source.executionRevision||row.executionRevision,policy=row.policyRevision||view?.historyPolicy?.policyRevision;if(!jobId||!scopeId||!revision||!policy||source.executionAvailability==="unavailable"||source.executionAvailability==="not-linked")return null;const ended=Date.parse(row.latestTurn?.endedAt),days=view?.historyPolicy?.retentionDays,expiresAt=Number.isFinite(ended)&&days>0?ended+days*86400000:null;return {jobId,scopeId,revision,policy,project:row.projectKey,expiresAt}}
    function executionKey(target){return [widgetInstanceId,historySecurityGeneration,selectedScope,view?.historyModeApplied||"agents",view?.historyPolicy?.policyRevision||target.policy,target.project,target.scopeId,target.jobId,target.revision,target.policy].join("\u0000")}
    function executionFresh(target){return target&&(!target.expiresAt||target.expiresAt>Date.now())}
    function executionCached(target){if(!target)return null;const key=executionKey(target),cached=executionDetails.get(key);if(!cached)return null;if(!executionFresh(target)||!executionFresh(cached)){executionDetails.delete(key);return null}return cached.detail}
    async function loadExecutionDetail(row,problem){const target=executionTarget(row,problem);if(!executionFresh(target)||executionCached(target))return;const key=executionKey(target);if(executionRequests.has(key))return;const token=Symbol(),epoch=hydrationEpoch;executionRequests.set(key,token);executionErrors.delete(key);try{const result=normalizeHostToolResult(await callTool("codex_ui_read",{view:"dashboard-execution",scopeId:target.scopeId,jobId:target.jobId,expectedExecutionRevision:target.revision,expectedPolicyRevision:target.policy,widgetInstanceId,scope:selectedScope}));if(result?.isError)throw new Error(errorText(result));const detail=result?.structuredContent||parsedToolText(result)||result;if(!mounted||epoch!==hydrationEpoch||executionRequests.get(key)!==token||key!==executionKey(target)||!executionFresh(target))return;if(detail?.kind!=="dashboard-execution"||detail.jobId!==target.jobId||detail.scopeId!==target.scopeId||detail.executionRevision!==target.revision||detail.policyRevision!==target.policy||detail.execution?.jobId!==target.jobId||detail.execution?.scopeId!==target.scopeId||detail.execution?.executionRevision!==target.revision)throw new Error(uiText("execution.changed","Execution changed; refresh the list."));if(executionDetails.size>=128)executionDetails.delete(executionDetails.keys().next().value);executionDetails.set(key,{detail,expiresAt:target.expiresAt})}catch(error){if(mounted&&epoch===hydrationEpoch&&key===executionKey(target)&&executionFresh(target))executionErrors.set(key,errorText(error))}finally{if(executionRequests.get(key)===token){executionRequests.delete(key);if(mounted&&view)paint(view)}}}
    function appendExecutionRecord(parent,row,problem){if(!jobRowVisible(row,view?.historyPolicy))return;const turn=row.latestTurn||{},status=row.jobId&&!turn.endedAt?row.status:turn.status||row.status,record=node("div","execution-record"),head=node("div","row-head execution-head"),state=node("span","status job-status "+(status==="cancelled"?"idle":tone(status))),icon=node("span","job-status-icon"),symbols={running:"m6 3 7 5-7 5Z","background-process-running":"m6 3 7 5-7 5Z",completed:"m3 8 3.5 3.5L13 5",cancelled:"M4 4h8v8H4Z",terminating:"M4 4h8v8H4Z",interrupted:"M5 3v10M11 3v10",idle:"M5 3v10M11 3v10","input-required":"M5.5 5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M8 12v.01","approval-required":"m8 2 5 2v4c0 3-5 6-5 6S3 11 3 8V4Zm-2 6 1.5 1.5L11 6"};icon.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="'+(symbols[status]||'M8 2 14 13H2ZM8 6v3M8 11v.01')+'"/></svg>';state.append(icon,node("span","",statusLabel(status)));appendExecution(head,turn.execution,true,row.bucket==="idle"?"dashboard.execution.recent":"dashboard.execution.current");head.appendChild(state);record.appendChild(head);const time=timeMeta(turn,status);if(time)record.appendChild(node("div","time",time));const meta=rowMeta(row);if(meta)record.appendChild(node("div","meta",meta));if(status==="cancelled")appendCancellation(record,turn.cancellation);else if(["failed","interrupted","termination-failed"].includes(status)){const error=[turn.error,problem?.error,row.error].find(value=>typeof value==="string"&&value.trim());if(error)record.appendChild(node("p","problem-reason",error))}parent.appendChild(record)}
    function historyKey(row){return [widgetInstanceId,historySecurityGeneration,selectedScope,row.conversationKey,row.projectKey,row.rowKey,row.representativeExecutionKey,row.historyRevision,row.policyRevision].map(value=>String(value??"legacy")).join("\u0000")}
    function currentHistoryRevision(rowKey){const summary=Array.isArray(view&&view.statusRows)?view.statusRows:[],rows=[...summary,...activeRows,...terminalRows,...idleRows,...historyActiveRows,...historyTerminalRows],current=rows.find(candidate=>String(candidate&&candidate.rowKey||"")===rowKey);return current&&typeof current.historyRevision==="string"?current.historyRevision:null}
    function syncHistorySummary(details,label,shown,total){const partial=shown>0&&total>shown,key=partial?(details.open?"dashboard.history.hidePartial":"dashboard.history.showPartial"):(details.open?"dashboard.history.hide":"dashboard.history.show");label.textContent=t[key].replace("{shown}",formatNumber(shown)).replace("{count}",formatNumber(total))}
    function turnActivityTitle(turn){return turn&&turn.activityTitle||t["dashboard.jobFallback"]}
    function renderHistoryTurn(turn,heading){const item=node("div","history-turn"),head=node("div","row-head"),state=node("span","status "+tone(turn.status),statusLabel(turn.status));if(heading.kind==="title")head.append(node("div","row-title",heading.title),state);else if(heading.kind==="boundary")head.append(node("div","history-activity-boundary",t["dashboard.history.activityBoundary"]),state);else{head.classList.add("history-state-only");head.appendChild(state)}item.append(head,node("div","time",timeMeta(turn,turn.status)));appendExecution(item,turn.execution,true);appendCancellation(item,turn.cancellation);return item}
    function historyFresh(row){return Boolean(row.historyRevision&&row.policyRevision&&row.representativeExecutionKey)&&(!row.nextExpiryAt||Date.parse(row.nextExpiryAt)>Date.now())}
    function cachedHistoryDetail(row){const key=historyKey(row),detail=historyDetails.get(key);if(!detail)return null;if(!historyFresh(row)||!historyFresh(detail)||detail.nextExpiryAt!==row.nextExpiryAt||detail.historyCount!==row.historyCount||detail.policyRevision!==row.policyRevision||detail.representativeExecutionKey!==row.representativeExecutionKey||detail.historyRevision!==row.historyRevision){historyDetails.delete(key);historyErrors.delete(key);return null}return detail}
    async function loadAgentHistory(row,more=false){const key=historyKey(row),rowKey=String(row&&row.rowKey||""),scope=selectedScope,epoch=hydrationEpoch,previous=cachedHistoryDetail(row);if(!rowKey||!historyFresh(row)||scope!=="conversation"&&scope!=="all"||historyLoading.has(key)||!mounted)return;if(previous&&!more)return;const token=Symbol();historyRequestTokens.set(key,token);historyLoading.add(key);historyErrors.delete(key);scheduleSizeChanged(true);try{const detail=unwrapHistoryDetail(await callTool("codex_ui_read",{view:"dashboard-history",rowKey,widgetInstanceId,scope,...(more&&previous?.nextCursor?{historyCursor:previous.nextCursor}:{})}));if(!mounted||scope!==selectedScope||epoch!==hydrationEpoch||historyRequestTokens.get(key)!==token||detail.rowKey!==rowKey)return;const rows=[...(view?.statusRows||[]),...(view?.backgroundRows||[]),...activeRows,...terminalRows,...historyActiveRows,...historyTerminalRows],current=rows.find(candidate=>candidate.rowKey===rowKey);if(!current||historyKey(current)!==key||!historyFresh(current)||!historyFresh(row)||!historyFresh(detail)||detail.nextExpiryAt!==current.nextExpiryAt||detail.historyCount!==current.historyCount||previous&&!historyFresh(previous)||detail.historyRevision!==current.historyRevision||detail.policyRevision!==current.policyRevision||detail.representativeExecutionKey!==current.representativeExecutionKey)return;if(more){const seen=new Set();detail.history=[...(previous?.history||row.history||[]),...detail.history].filter(turn=>{const identity=turn.executionKey||[turn.startedAt,turn.updatedAt].join(":");if(seen.has(identity))return false;seen.add(identity);return true})}if(historyDetails.size>=128)historyDetails.delete(historyDetails.keys().next().value);historyDetails.set(key,detail)}catch(error){if(mounted&&scope===selectedScope&&epoch===hydrationEpoch&&historyRequestTokens.get(key)===token&&historyFresh(row))historyErrors.set(key,errorText(error)||t["common.error"])}finally{if(historyRequestTokens.get(key)!==token)return;historyRequestTokens.delete(key);historyLoading.delete(key);if(mounted&&scope===selectedScope&&view)paint(view);scheduleSizeChanged(true)}}
    function appendAgentHistory(parent,row,turn,enclosingActivityTitle){const key=historyKey(row),embedded=Array.isArray(row.history)?row.history:[],detail=cachedHistoryDetail(row),history=Array.isArray(detail&&detail.history)?detail.history:historyFresh(row)?embedded:[],historyTotal=Math.max(history.length,Number(row.historyCount)||0,Number(detail&&detail.historyCount)||0);if(!historyTotal)return;const details=node("details","history"),summary=node("summary","history-toggle"),chevron=node("span","history-chevron"),label=node("span","history-label"),list=node("div","history-list"),enclosingActivity={activityKey:row.activityKey,activityTitle:enclosingActivityTitle||row.activityTitle};chevron.setAttribute("aria-hidden","true");summary.append(chevron,label);details.open=expandedHistories.has(key);const renderContent=()=>{list.replaceChildren();if(!details.open)return;if(history.length){let previousTurn=turn||enclosingActivity;history.forEach((historicalTurn)=>{const heading=dashboardHistoryActivityHeading(historicalTurn,previousTurn,enclosingActivity);list.appendChild(renderHistoryTurn(historicalTurn,heading));previousTurn=historicalTurn});if(detail?.historyHasMore??row.historyHasMore){const more=node("button","",t["dashboard.loadMore"]);more.type="button";more.disabled=historyLoading.has(key);more.addEventListener("click",()=>void loadAgentHistory(row,true));list.appendChild(more)}return}if(detail){list.appendChild(node("div","empty",t["dashboard.noRecent"]));return}if(historyErrors.has(key)){const retry=node("button","",t["common.refresh"]);retry.type="button";retry.addEventListener("click",()=>{historyErrors.delete(key);void loadAgentHistory(row)});list.append(node("div","message error",historyErrors.get(key)),retry);return}list.appendChild(node("div","empty",t["common.loading"]));if(!historyLoading.has(key))void loadAgentHistory(row)};renderContent();details.append(summary,list);syncHistorySummary(details,label,history.length,historyTotal);details.addEventListener("toggle",()=>{if(details.open){expandedHistories.add(key);renderContent()}else expandedHistories.delete(key);syncHistorySummary(details,label,history.length,historyTotal);scheduleSizeChanged(true)});parent.appendChild(details)}
    function appendAgentBody(body,row,grouped=false,suppressIdleStatus=false,enclosingActivityTitle=null){if(row.jobId){appendExecutionRecord(body,row);appendWorkControl(body,row);return}const head=node("div","row-head"),title=node("div","row-title",row.agentName||t["dashboard.jobFallback"]),state=node("span","status "+tone(row.status),statusLabel(row.status)),turn=latestTurn(row);head.appendChild(title);if(!suppressIdleStatus||row.status!=="idle")head.appendChild(state);body.appendChild(head);if(!grouped&&turn)body.appendChild(node("div","turn-title",turnActivityTitle(turn)));appendRowContext(body,row,grouped?"agent":"row");if(turn)appendExecution(body,turn.execution,true,row.bucket==="idle"?"dashboard.execution.recent":"dashboard.execution.current");if(shouldShowDashboardNextExecution(row.execution,turn?.execution))appendExecution(body,row.execution,true,"dashboard.execution.next");const meta=rowMeta(row);if(meta)body.appendChild(node("div","meta",meta));if(turn){const time=timeMeta(turn,row.status);if(time)body.appendChild(node("div","time",time));if(!grouped||turn.cancellation&&turn.cancellation.targetKind!=="activity")appendCancellation(body,turn.cancellation)}else if(row.bucket!=="active")body.appendChild(node("div","time",[t["dashboard.time.durationUnknown"],relativeTime(row.updatedAt)].filter(Boolean).join(" · ")));appendAgentHistory(body,row,turn,enclosingActivityTitle);appendWorkControl(body,row)}
    function renderActivityGroup(parent,group,recentActivity=false){const representative=group.rows[0];if(!representative)return;const item=node("article","row activity-group"),body=node("div","row-body"),head=node("div","row-head"),identity=node("div","identity"),title=node("div","row-title",group.activityTitle||(recentActivity?t["dashboard.noRecentActivity"]:t["dashboard.jobFallback"])),agents=node("div","activity-agent-list"),agentGroups=groupDashboardRowsByAgent(group.rows),jobRows=group.rows.every(row=>Boolean(row.jobId));identity.appendChild(title);head.appendChild(identity);body.appendChild(head);appendRowContext(body,representative,"activity");body.appendChild(node("div","activity-group-count",t["dashboard.agentCount"].replace("{count}",formatNumber(agentGroups.length))));if(!jobRows){const cancellation=group.rows.map(row=>latestTurn(row)).find(turn=>turn?.cancellation?.targetKind==="activity")?.cancellation;appendCancellation(body,cancellation)}for(const agentGroup of agentGroups){const agent=node("div","activity-agent"),first=agentGroup.rows[0];if(jobRows){agent.appendChild(node("div","row-title",first.agentName||t["dashboard.jobFallback"]));const jobs=node("div","agent-jobs");for(const row of agentGroup.rows){appendExecutionRecord(jobs,row);appendWorkControl(jobs,row)}agent.appendChild(jobs)}else for(const row of agentGroup.rows)appendAgentBody(agent,row,true,recentActivity,group.activityTitle);agents.appendChild(agent)}body.appendChild(agents);item.appendChild(body);parent.appendChild(item)}
    function renderActivityRows(parent,rows,recentActivity=false){parent.replaceChildren();for(const group of groupDashboardRowsByActivity(rows))renderActivityGroup(parent,group,recentActivity)}
    function rowIdentity(row){return String(row.rowKey||[row.conversationKey,row.projectKey,row.agentName].map((value)=>String(value||"")).join("\u0000"))}
    function mergeRows(current,incoming){const merged=current.slice(),indexByKey=new Map(merged.map((row,index)=>[rowIdentity(row),index]));for(const row of incoming){const key=rowIdentity(row),index=indexByKey.get(key);if(index===undefined){indexByKey.set(key,merged.length);merged.push(row)}else merged[index]=row}return merged}
    function agentCountText(total){return (view?.historyModeApplied==="jobs"&&selectedStatus!=="background"?uiText("execution.count","{count} executions"):t["dashboard.agentCount"]).replace("{count}",formatNumber(total))}
    function syncStatusFilter(){for(const button of document.querySelectorAll("[data-status-filter]"))button.setAttribute("aria-pressed",String(button.dataset.statusFilter===selectedStatus))}
    function syncLoadMoreControls(){const activeMore=document.getElementById("active-more");activeMore.hidden=selectedStatus==="background"?!view?.backgroundPagination?.hasNext:selectedStatus!=="running"||(view?.historyModeApplied==="jobs"?view.activeRows.filter(row=>Boolean(row.jobId)).length>=view.counts.progressJobCount:!view?.statusPagination?.hasNext);document.getElementById("active-more-wrap").hidden=activeMore.hidden;activeMore.disabled=busy;const hasNext=selectedStatus==="history"&&Boolean(terminalPagination&&terminalPagination.hasNext);elements.terminalMoreWrap.hidden=!hasNext;elements.terminalMore.disabled=busy||!hasNext}
    function applyLocalStatus(next){if(selectedStatus==="all"||selectedStatus==="problems"&&next.problems){activeRows=[];terminalRows=[];return}if(selectedStatus==="history"){if(next.historyIncluded===false){activeRows=[];terminalRows=[];return}activeRows=next.historyModeApplied==="jobs"?[]:historyActiveRows.slice();terminalRows=next.historyModeApplied==="jobs"?historyTerminalRows.filter(row=>jobRowVisible(row,next.historyPolicy)):historyTerminalRows.slice();return}const rows=(next.historyModeApplied==="jobs"&&selectedStatus==="background"&&Array.isArray(next.backgroundRows)?next.backgroundRows:next.historyModeApplied==="jobs"&&(selectedStatus==="running"||selectedStatus==="background")?[...next.activeRows,...(selectedStatus==="background"?next.terminalRows:[])]:Array.isArray(next.statusRows)?next.statusRows:[...next.activeRows,...next.terminalRows]).filter(row=>(selectedStatus==="running"?row.bucket==="active"&&(next.historyModeApplied==="jobs"?Boolean(row.jobId):Boolean(row.jobId)||["running","input-required","approval-required","terminating","termination-failed"].includes(row.status)):dashboardRowMatchesStatus(row,selectedStatus)));activeRows=rows.filter(row=>row.bucket==="active");terminalRows=rows.filter(row=>row.bucket!=="active")}
    function scheduleHistoryExpiry(next){if(historyExpiryTimer!==null)clearTimeout(historyExpiryTimer);const rows=[...(next.statusRows||[]),...next.activeRows,...next.terminalRows,...(next.backgroundRows||[]),...(next.problems?.rows||[]).map(problem=>problem.row)],expiry=Math.min(...rows.map(row=>{const explicit=Date.parse(row.nextExpiryAt),ended=Date.parse(row.latestTurn?.endedAt);return Number.isFinite(explicit)?explicit:next.historyModeApplied==="jobs"&&next.historyPolicy?.retentionDays>0&&Number.isFinite(ended)?ended+next.historyPolicy.retentionDays*86400000:NaN}).concat((next.problems?.rows||[]).map(problem=>next.historyPolicy?.retentionDays>0?Date.parse(problem.occurredAt||problem.observedAt)+next.historyPolicy.retentionDays*86400000:NaN)).filter(value=>Number.isFinite(value)&&value>Date.now()));if(Number.isFinite(expiry))historyExpiryTimer=setTimeout(()=>{for(const [key,detail]of historyDetails)if(!historyFresh(detail))historyDetails.delete(key);for(const [key,detail]of executionDetails)if(!executionFresh(detail))executionDetails.delete(key);if(view)paint(view);void reload(true,false)},Math.min(2147483647,Math.max(1,expiry-Date.now())))}
    function paint(next){for(const label of document.querySelectorAll('[data-status-filter="history"] .count-label'))label.textContent=t["dashboard.recent"];scheduleHistoryExpiry(next);syncScope();applyLocalStatus(next);renderProblems(next);renderHistoryPolicy(next.historyPolicy);const controlFocus=prepareWorkControlPaint(),showLists=selectedStatus!=="all"&&(selectedStatus!=="problems"||!next.problems);renderWeeklyUsage(next);elements.content.hidden=false;elements.activeSection.hidden=!showLists||selectedStatus==="history"&&next.historyModeApplied==="jobs";elements.terminalSection.hidden=!showLists||(selectedStatus!=="history"&&terminalRows.length===0);elements.runningCount.textContent=formatNumber(next.counts.progressJobCount??next.counts.running+next.counts.inputRequired+next.counts.approvalRequired+next.counts.terminating);elements.responseCount.textContent=formatNumber(next.historyModeApplied==="jobs"?next.counts.executionCount??next.pagination.terminal.total:next.pagination.terminal.total);elements.problemsCount.textContent=formatNumber(next.problems?.affectedExecutionCount??next.counts.problems??Math.max(0,next.counts.needsAttention-next.counts.inputRequired-next.counts.approvalRequired));const backgroundKnown=next.counts.backgroundProcesses>0,backgroundUnknown=backgroundStatusUnknown(next.counts,next.enrichment);elements.backgroundStatus.hidden=false;elements.backgroundFilter.hidden=!backgroundKnown&&backgroundUnknown;elements.backgroundFilter.disabled=!backgroundKnown;elements.backgroundFilter.textContent=t["dashboard.backgroundCount"].replace("{count}",formatNumber(next.counts.backgroundProcesses));elements.backgroundUnknown.hidden=!backgroundUnknown;elements.activeCount.textContent=formatNumber(activeRows.length);elements.terminalCount.textContent=formatNumber(selectedStatus==="history"&&terminalPagination?terminalPagination.total:terminalRows.length);renderActivityRows(elements.activeList,activeRows);renderActivityRows(elements.terminalList,terminalRows,selectedStatus==="history");finishWorkControlPaint(controlFocus);elements.activeEmpty.hidden=activeRows.length>0;elements.terminalEmpty.hidden=terminalRows.length>0;syncStatusFilter();syncLoadMoreControls();elements.updated.textContent=t["dashboard.updated"].replace("{time}",new Intl.DateTimeFormat(localeTag,{dateStyle:"short",timeStyle:"medium"}).format(new Date(next.generatedAt)));const notices=[];if(enrichmentFailed||detailsIncomplete(next.enrichment))notices.push(t["common.detailsRefreshFailed"]);if(selectedStatus==="history"&&next.pagination.active.hasNext)notices.push(t["dashboard.activeTruncated"]);if(next.counts.runtimeUnknownAgents>0)notices.push(t["dashboard.runtimeUnknown"].replace("{count}",formatNumber(next.counts.runtimeUnknownAgents)));if(next.counts.runtimeProbeSkippedAgents>0)notices.push(t["dashboard.runtimeProbeSkipped"].replace("{count}",formatNumber(next.counts.runtimeProbeSkippedAgents)));elements.message.textContent=refreshFailed?t["dashboard.refreshFailedRetained"]:notices.join(" ");elements.message.classList.remove("error");sizeReportingReady=true;scheduleSizeChanged()}
    function render(next,localeReady=false,pageRequest=appendRequest){if(next.statusFilter!==undefined&&next.statusFilter!=="all")return false;const incomingScope=next.filter?.mode||(next.scope==="conversation"?"conversation":"all");if(selectedScope!=="auto"&&incomingScope!==selectedScope)throw new Error(t["common.error"]);const renderedAt=Date.parse(next.generatedAt);if(Number.isFinite(renderedAt)&&renderedAt<lastRenderedAt)return false;selectedScope=incomingScope;conversationAvailable=next.filter?.conversationAvailable===true;scopeReady=Boolean(next.filter);if(Number.isFinite(renderedAt))lastRenderedAt=renderedAt;if(view?.historyPolicy?.totalRemoved!==next.historyPolicy?.totalRemoved||view?.historyModeApplied!==next.historyModeApplied||view?.historyPolicy?.policyRevision!==next.historyPolicy?.policyRevision){pageRequest=null;historyTerminalRows=[];idleRows=[];}view=next;localePreference=next.uiLocalePreference||"auto";if(next.historyIncluded!==false){historyActiveRows=next.activeRows.slice();const cache=reconcileDashboardPageCaches({terminalRows:historyTerminalRows,idleRows,terminalPagination,idlePagination},{activeRows:next.activeRows,terminalRows:next.terminalRows,idleRows:next.idleRows,terminalPagination:next.pagination.terminal,idlePagination:next.pagination.idle},pageRequest,mergeRows,rowIdentity);historyTerminalRows=cache.terminalRows;idleRows=cache.idleRows;terminalPagination=cache.terminalPagination;idlePagination=cache.idlePagination}if(!localeReady)setLocale(effectiveLocaleTag(),false);paint(next);return true}
    // Defer queued History until the releasing owner has finished rebasing or yielded to a replacement request.
    function setBusy(value){busy=value;syncProblemControls();for(const button of document.querySelectorAll(".history-actions button"))button.disabled=value;elements.refresh.disabled=value;elements.card.setAttribute("aria-busy",String(value));syncLoadMoreControls();if(!value&&historyLoadQueued){const epoch=hydrationEpoch,scope=selectedScope;void Promise.resolve().then(()=>{if(busy||!mounted||epoch!==hydrationEpoch||scope!==selectedScope||selectedStatus!=="history"||!historyLoadQueued)return;historyLoadQueued=false;if(view?.historyIncluded!==true)void reload(true,false)})}}
    function showError(_error){refreshFailed=true;if(view){elements.message.textContent=t["dashboard.refreshFailedRetained"];elements.message.classList.remove("error");automaticRefreshDisabled=true}else{elements.message.textContent=t["dashboard.restoreFailed"];elements.message.classList.add("error")}sizeReportingReady=true;scheduleSizeChanged(true)}
    function intrinsicHeight(){const html=document.documentElement,original=html.style.height;html.style.height="max-content";const height=Math.ceil(html.getBoundingClientRect().height);html.style.height=original;return height}
    function emitSizeChanged(force=false){if(!sizeReportingReady)return;const compatibility=window.openai&&typeof window.openai.notifyIntrinsicHeight==="function";if(!standardBridgeInitialized&&!compatibility)return;const width=Math.ceil(window.innerWidth),height=intrinsicHeight();if(!force&&width===lastWidth&&height===lastHeight)return;lastWidth=width;lastHeight=height;if(standardBridgeInitialized)rpcNotification("ui/notifications/size-changed",{width,height});if(compatibility)window.openai.notifyIntrinsicHeight(height)}
    function scheduleSizeChanged(force=false){sizeChangeForced=sizeChangeForced||force;if(sizeFrame)return;sizeFrame=requestAnimationFrame(()=>{sizeFrame=0;const forced=sizeChangeForced;sizeChangeForced=false;emitSizeChanged(forced)})}
${PROBLEM_REVIEW_SCRIPT}
${CARD_FORM_SCRIPT}
${DASHBOARD_CONTROL_SCRIPT}
    function queueEnrichment(args,epoch,pageRequest=null,inspect=true){if(!enrichmentRunning&&!inspect)return;enrichmentTarget={args,epoch,pageRequest,inspect};if(!enrichmentRunning)void drainEnrichment()}
    async function drainEnrichment(){enrichmentRunning=true;let coveredScope=null,inspectionFailed=false;try{while(mounted&&enrichmentTarget){const target=enrichmentTarget;enrichmentTarget=null;const inspect=target.inspect&&coveredScope!=="all"&&coveredScope!==target.args.scope;try{const result=await dashboardRead({...target.args,enrich:inspect}),next=unwrap(result);if(inspect){coveredScope=target.args.scope;inspectionFailed=false}if(!mounted)return;if(enrichmentTarget)continue;if(target.epoch===hydrationEpoch){enrichmentFailed=inspectionFailed;render(next,false,target.pageRequest)}}catch{if(inspect)inspectionFailed=true;if(enrichmentTarget)continue;if(mounted&&target.epoch===hydrationEpoch&&view){enrichmentFailed=true;paint(view)}}}}finally{enrichmentRunning=false;if(!mounted)enrichmentTarget=null;else if(enrichmentTarget)void drainEnrichment()}}
    async function reload(manual=false,enrichAfter=true){if(busy||!mounted||!manual&&automaticRefreshDisabled)return;if(manual)automaticRefreshDisabled=false;const epoch=++hydrationEpoch;refreshFailed=false;setBusy(true);elements.message.textContent=t["common.loading"];elements.message.classList.remove("error");try{appendRequest=null;const args={widgetInstanceId,scope:selectedScope,statusFilter:"all",problems:problemQuery(),limit:PAGE_LIMIT,terminalOffset:0,idleOffset:0,enrich:false,includeHistory:selectedStatus==="history"},result=await dashboardRead(args);if(!mounted||epoch!==hydrationEpoch)return;render(unwrap(result));lastRefreshAt=Date.now();automaticRefreshDisabled=false;queueEnrichment({...args,scope:selectedScope},epoch,null,enrichAfter)}catch(error){if(mounted&&epoch===hydrationEpoch)showError(error)}finally{if(epoch===hydrationEpoch){appendRequest=null;setBusy(false)}}}
    async function loadMoreBackground(){const page=view?.backgroundPagination;if(busy||!mounted||!page?.hasNext)return;const epoch=hydrationEpoch,scope=selectedScope,revision=view.backgroundRevision;let rebase=false;setBusy(true);try{const next=unwrap(await dashboardRead({widgetInstanceId,scope:selectedScope,backgroundOffset:page.offset+page.returned,limit:PAGE_LIMIT,enrich:true,includeHistory:false}));if(!mounted||epoch!==hydrationEpoch||scope!==selectedScope||selectedStatus!=="background"||view.backgroundRevision!==revision)return;if(!Array.isArray(next.backgroundRows)||!next.backgroundPagination)throw new Error(t["common.error"]);if(next.backgroundRevision!==revision||next.historyPolicy?.policyRevision!==view.historyPolicy?.policyRevision){rebase=true;return}view={...view,backgroundRows:mergeRows(view.backgroundRows||[],next.backgroundRows),backgroundPagination:next.backgroundPagination};paint(view)}catch(error){if(mounted&&epoch===hydrationEpoch&&scope===selectedScope)showError(error)}finally{if(epoch===hydrationEpoch){setBusy(false);if(rebase&&mounted&&epoch===hydrationEpoch&&scope===selectedScope&&selectedStatus==="background")await reload(true,false)}}}
    async function loadMoreRunning(){if(busy||!mounted||!view)return;const epoch=hydrationEpoch,scope=selectedScope,current=view,offset=(view.historyModeApplied==="jobs"?view.activeRows:view.statusRows||[]).filter(row=>row.bucket==="active"&&(view.historyModeApplied!=="jobs"||Boolean(row.jobId))).length;let rebase=false;setBusy(true);try{const next=unwrap(await dashboardRead({widgetInstanceId,scope:selectedScope,statusFilter:"running",statusOffset:offset,limit:PAGE_LIMIT,enrich:false}));if(!mounted||epoch!==hydrationEpoch||scope!==selectedScope)return;if(current.historyModeApplied==="jobs"&&(next.counts.progressJobCount!==current.counts.progressJobCount||next.historyPolicy?.policyRevision!==current.historyPolicy?.policyRevision||next.pagination.active.offset!==offset)){rebase=true;return}view=view.historyModeApplied==="jobs"?{...view,activeRows:mergeRows(view.activeRows,next.activeRows),pagination:{...view.pagination,active:next.pagination.active}}:{...view,statusRows:mergeRows(view.statusRows||[],next.statusRows||[]),statusPagination:next.statusPagination};paint(view)}catch(error){if(epoch===hydrationEpoch)showError(error)}finally{if(epoch===hydrationEpoch){setBusy(false);if(rebase&&mounted&&epoch===hydrationEpoch&&scope===selectedScope&&selectedStatus==="running")await reload(true,false)}}}
    document.getElementById("active-more").addEventListener("click",()=>void (selectedStatus==="background"?loadMoreBackground():loadMoreRunning()));
    async function loadMore(bucket){if(busy||!mounted||!view||selectedStatus!=="history")return;if(view.historyModeApplied==="jobs"&&historyTerminalRows.some(row=>!jobRowVisible(row,view.historyPolicy))){void reload(true,false);return;}const page=bucket==="terminal"?terminalPagination:idlePagination;if(!page||!page.hasNext)return;const epoch=++hydrationEpoch;refreshFailed=false;setBusy(true);try{const nextOffset=page.offset+page.returned,args={widgetInstanceId,scope:selectedScope,statusFilter:"all",problems:problemQuery(),limit:PAGE_LIMIT,terminalOffset:bucket==="terminal"?nextOffset:0,idleOffset:bucket==="idle"?nextOffset:0,enrich:false,includeHistory:true},pageRequest={bucket,requestedOffset:nextOffset};appendRequest=pageRequest;const result=await dashboardRead(args);if(!mounted||epoch!==hydrationEpoch)return;const next=unwrap(result);if(view.historyModeApplied==="jobs"&&(view.counts.executionCount!==next.counts.executionCount||view.historyPolicy?.policyRevision!==next.historyPolicy?.policyRevision)){const first=unwrap(await dashboardRead({...args,terminalOffset:0,idleOffset:0}));if(!mounted||epoch!==hydrationEpoch)return;historyTerminalRows=[];render(first,false,null)}else render(next,false,pageRequest);lastRefreshAt=Date.now();automaticRefreshDisabled=false;queueEnrichment(args,epoch,pageRequest,false)}catch(error){if(mounted&&epoch===hydrationEpoch)showError(error)}finally{if(epoch===hydrationEpoch){appendRequest=null;setBusy(false)}}}
    function syncScope(){elements.scopeSelector.hidden=!scopeReady;elements.scopeSelector.setAttribute("aria-label",t["dashboard.scope.label"]);elements.scopeConversation.disabled=!conversationAvailable;elements.scopeConversation.setAttribute("aria-pressed",String(selectedScope==="conversation"));elements.scopeAll.setAttribute("aria-pressed",String(selectedScope==="all"));elements.scopeNote.textContent=!scopeReady?"":selectedScope==="conversation"?t["dashboard.scope.conversationNotice"]:conversationAvailable?t["dashboard.scope.allNotice"]:t["dashboard.scope.unavailable"]}
    async function selectScope(mode){if(problemMutationInFlight||!mounted||mode===selectedScope||mode==="conversation"&&!conversationAvailable)return;hydrationEpoch++;appendRequest=null;historyLoadQueued=false;setBusy(false);closeWorkDetails(false);resetProblems();selectedScope=mode;selectedStatus="all";view=null;activeRows=[];terminalRows=[];idleRows=[];historyActiveRows=[];historyTerminalRows=[];terminalPagination=null;idlePagination=null;lastRenderedAt=0;expandedHistories.clear();executionDetails.clear();executionRequests.clear();executionErrors.clear();expandedExecutions.clear();historyDetails.clear();historyLoading.clear();historyErrors.clear();historyRequestTokens.clear();elements.activeList.replaceChildren();elements.terminalList.replaceChildren();elements.content.hidden=true;elements.updated.textContent="";syncScope();await reload(true)}
    elements.scopeConversation.addEventListener("click",()=>void selectScope("conversation"));elements.scopeAll.addEventListener("click",()=>void selectScope("all"));
    elements.refresh.addEventListener("click",()=>void reload(true));elements.terminalMore.addEventListener("click",()=>void loadMore("terminal"));
    async function selectStatus(status){if(problemMutationInFlight||!mounted)return;const nextStatus=status===selectedStatus?"all":status;if(nextStatus===selectedStatus)return;selectedStatus=nextStatus;historyLoadQueued=false;closeWorkDetails(false);syncStatusFilter();if(nextStatus==="history"&&view?.historyIncluded!==true){if(view)paint(view);if(busy){historyLoadQueued=true;return}await reload(true,false);return}if(view)paint(view)}
    for(const button of document.querySelectorAll("[data-status-filter]"))button.addEventListener("click",()=>void selectStatus(button.dataset.statusFilter));
    function cancelPending(reason){for(const[id,request]of pending){rpcNotification("notifications/cancelled",{requestId:id,reason});request.reject(new Error(reason))}pending.clear()}
    function supersedeRequests(reason){hydrationEpoch++;historySecurityGeneration++;historyDetails.clear();executionDetails.clear();executionRequests.clear();executionErrors.clear();expandedExecutions.clear();historyRequestTokens.clear();historyLoading.clear();appendRequest=null;enrichmentTarget=null;historyLoadQueued=false;setBusy(false);cancelPending(reason);if(!standardBridgeInitialized)standardBridgeAttempt=null}
    window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.method==="ping"&&message.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(message.method==="ui/resource-teardown"){tornDown=true;mounted=false;if(resizeObserver)resizeObserver.disconnect();supersedeRequests("Codex overview unmounted");if(message.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(Object.prototype.hasOwnProperty.call(message,"id")&&pending.has(message.id)){const handler=pending.get(message.id);pending.delete(message.id);if(message.error){const error=new Error(errorText(message.error));error.code="MCP_RPC_RESPONSE_ERROR";handler.reject(error)}else handler.resolve(message.result);return}if(message.method==="ui/notifications/tool-input"){applyOpeningScope(message.params,{});return}if(message.method==="ui/notifications/tool-result"){applyOpeningScope(null,hostToolResultMetadata(message.params));return}if(message.method==="ui/notifications/host-context-changed"){const context=message.params||{};if(Object.keys(context).some(key=>key!=="locale")){supersedeRequests("Dashboard host context changed");view=null;elements.content.hidden=true;void reload(true,false)}if(context.locale){hostLocaleTag=String(context.locale);if(localePreference==="auto")setLocale(hostLocaleTag)}return}},{passive:true});
    window.addEventListener("openai:set_globals",(event)=>{const globals=event&&event.detail&&event.detail.globals||{};applyOpeningScope(globals.toolInput,hostToolResultMetadata(globals.toolResponseMetadata||{}));if(globals.locale){hostLocaleTag=String(globals.locale);if(localePreference==="auto")setLocale(hostLocaleTag)}});
    window.addEventListener("pagehide",()=>{mounted=false;supersedeRequests("Codex overview unmounted")});window.addEventListener("pageshow",()=>{if(tornDown)return;mounted=true;if(view)paint(view);else{applyOpeningScope(initialToolInput,initialMetadata);void reload();}if(!standardBridgeInitialized)void beginStandardBridge();});document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden"){return}if(!tornDown&&view){mounted=true;paint(view)}});
    window.addEventListener("online",()=>{if(mounted&&!standardBridgeInitialized)void beginStandardBridge()});
    standardBridgeReady=beginStandardBridge();setLocale(localeTag,false);if(typeof ResizeObserver==="function"){resizeObserver=new ResizeObserver(()=>scheduleSizeChanged());resizeObserver.observe(document.documentElement);resizeObserver.observe(document.body)}applyOpeningScope(initialToolInput,initialMetadata);void reload();
  </script>
</body>
</html>
`;
