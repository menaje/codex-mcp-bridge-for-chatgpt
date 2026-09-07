// Shared host fixtures for real-browser card regressions.
export const enrichment = (state: "structural" | "enriched") => ({
  state,
  runtimeRequests: state === "enriched" ? 1 : 0,
  cacheHits: 0,
  timeouts: 0,
  durationMs: state === "enriched" ? 650 : 0,
  usageTimedOut: false
});

export const activityView = (state: "structural" | "enriched") => ({
  scopeVersion: 7,
  generatedAt: state === "structural"
    ? "2026-09-03T00:00:00.000Z"
    : "2026-09-03T00:00:01.000Z",
  enrichment: enrichment(state),
  weeklyUsage: null,
  uiLocalePreference: "ko",
  completionHandoff: "off",
  pendingHandoffs: [],
  mountedActivity: { activityId: "progressive-activity", cardGeneration: 1 },
  mountedPresentation: { kind: "explicit" },
  watcherPolicy: {
    mode: "scope-version-long-poll",
    live: true,
    stopped: false,
    ownsCompletionHandoff: false
  },
  feed: {
    mode: "full",
    active: [{
      rowType: "activity",
      activityId: "progressive-activity",
      title: state === "structural" ? "구조 활동" : "보강 활동",
      lifecycle: "open",
      kind: "implementation",
      displayState: "running",
      elapsedMs: 1_000,
      counts: { total: 1, failed: 0 },
      agents: [],
      cancellations: [],
      canRequestVerification: false,
      canRetry: false,
      workspaceLabels: [],
      projectName: null
    }],
    activeCount: 1,
    activityTotal: 1,
    activeHasMore: false,
    showWorkspaceLabels: false,
    historySummary: { completedActivities: 0, endedActivities: 0, idleAgents: 0 },
    history: { rows: [], pagination: {} },
    idleAgents: { rows: [], pagination: {} }
  }
});

export const activityFixture = (
  state: "structural" | "enriched",
  scopeVersion: number,
  title: string
) => {
  const fixture = activityView(state);
  return {
    ...fixture,
    scopeVersion,
    feed: {
      ...fixture.feed,
      active: [{ ...fixture.feed.active[0], title }]
    }
  };
};

const dashboardPage = (total = 0) => ({
  offset: 0,
  limit: 20,
  returned: 0,
  total,
  returnedConversations: 0,
  conversationTotal: 0,
  hasPrevious: false,
  hasNext: false
});
const dashboardTurn = (
  activityKey: string,
  activityTitle: string,
  model: string | null,
  reasoningEffort: string | null
) => ({
  activityKey,
  activityTitle,
  ...(model && reasoningEffort
    ? {
        execution: {
          model,
          modelDisplayName: model === "gpt-5.6-sol" ? "GPT-5.6 Sol" : "GPT-5.6 Terra",
          reasoningEffort,
          isCurrent: false
        }
      }
    : {}),
  status: "completed",
  startedAt: "2026-09-02T23:58:00.000Z",
  updatedAt: "2026-09-02T23:59:00.000Z",
  endedAt: "2026-09-02T23:59:00.000Z",
  durationMs: 60_000
});
const dashboardLatest = dashboardTurn(
  "activity-a",
  "Repeated title",
  "gpt-5.6-sol",
  "high"
);
const dashboardHistoryRow = {
  rowKey: "row-a",
  activityKey: "activity-a",
  conversationKey: "conversation-a",
  sessionAlias: "Session TEST",
  bucket: "recent",
  projectKey: "project-a",
  projectName: "Project A",
  agentName: "History Agent",
  activityTitle: "Repeated title",
  execution: {
    model: "gpt-5.6-terra",
    modelDisplayName: "GPT-5.6 Terra",
    reasoningEffort: "xhigh",
    isCurrent: true
  },
  status: "completed",
  createdAt: dashboardLatest.startedAt,
  updatedAt: dashboardLatest.updatedAt,
  elapsedMs: dashboardLatest.durationMs,
  backgroundProcessCount: 0,
  latestTurn: dashboardLatest,
  history: [
    dashboardTurn("activity-a", "Repeated title", "gpt-5.6-terra", "max"),
    dashboardTurn("activity-b", "Repeated title", "gpt-5.6-sol", "high"),
    dashboardTurn("activity-b", "Repeated title", null, null),
    dashboardTurn("activity-c", "Different title", "gpt-5.6-sol", "medium")
  ],
  historyCount: 4
};
export const dashboardView = (state: "structural" | "enriched") => ({
  kind: "dashboard",
  generatedAt: state === "structural"
    ? "2026-09-03T00:00:00.000Z"
    : "2026-09-03T00:00:01.000Z",
  scope: "bridge-wide",
  statusSource: "codex-runtime-only",
  coverage: "bridge-known-retained",
  enrichment: enrichment(state),
  weeklyUsage: null,
  counts: {
    trackedProjects: 1,
    trackedConversations: 1,
    retainedJobs: 5,
    active: 0,
    running: 0,
    inputRequired: 0,
    approvalRequired: 0,
    terminating: 0,
    needsAttention: 0,
    backgroundProcesses: state === "enriched" ? 1 : 0,
    backgroundProcessAgents: state === "enriched" ? 1 : 0,
    runtimeUnknownAgents: 0,
    runtimeProbeSkippedAgents: 0,
    completed: 5,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    idleAgents: 0,
    orphanedAgents: 0
  },
  activeRows: [],
  terminalRows: [dashboardHistoryRow],
  idleRows: [],
  pagination: {
    active: dashboardPage(),
    terminal: { ...dashboardPage(1), returned: 1 },
    idle: dashboardPage()
  },
  uiLocalePreference: "ko"
});

const settingsView = {
  settings: {
    schemaVersion: 1,
    settingsRevision: 1,
    registryRevision: 0,
    accessStrategy: "read-only",
    modelPolicy: {
      mode: "fixed",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      constraints: { allowDelegation: true }
    },
    usePriorityServiceTier: false,
    showBridgeThreadsInCodexApp: true,
    uiLocalePreference: "ko",
    maxConcurrentJobs: 2,
    activityCardVisibility: "always",
    completionHandoff: "off",
    projects: []
  },
  capabilities: {
    availableAccessStrategies: ["read-only", "adaptive"],
    availableUiLocalePreferences: ["auto", "en", "ko"],
    projectAvailability: [],
    maxConcurrentJobs: 4,
    defaultBackend: "app-server",
    operatorModelCeiling: null
  },
  catalog: {
    source: "fixture",
    validation: "valid",
    stale: false,
    warning: null,
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }]
    }]
  },
  warnings: [],
  policyActivation: {
    policyRevision: 1,
    executionPolicyActive: true,
    descriptorProjectionUpdated: false,
    developerModeRefreshRequired: false
  }
};

export function cardPrelude(kind: "activity" | "dashboard" | "settings"): string {
  const initialActivityMetadata = {
    "codex/activityView@11": {
      kind: "codex/activityView",
      version: 11,
      purpose: "presentation-hydration-only",
      correlation: { scopeVersion: 7 },
      view: activityView("structural")
    }
  };
  return `<script>
    window.__fixtureStartedAt=performance.now();
    window.__structuralPaintElapsed=null;
    window.__cardErrors=[];
    window.__cardCalls=[];
    window.__activityTitles=[];
    window.__activityEnrichmentCalls=0;
    window.__activityWatchAdvanced=false;
    window.addEventListener("error",event=>window.__cardErrors.push(String(event.error&&event.error.message||event.message)));
    window.addEventListener("unhandledrejection",event=>window.__cardErrors.push(String(event.reason&&event.reason.message||event.reason)));
    document.addEventListener("DOMContentLoaded",()=>{
      const mark=()=>{
        const activityTitle=${JSON.stringify(kind)}==="activity"&&document.querySelector(".row .name")?.textContent||"";
        if(activityTitle&&window.__activityTitles.at(-1)!==activityTitle)window.__activityTitles.push(activityTitle);
        if(window.__structuralPaintElapsed!==null)return;
        const activityReady=${JSON.stringify(kind)}==="activity"&&document.querySelector(".row .name")?.textContent==="구조 활동";
        const dashboardReady=${JSON.stringify(kind)}==="dashboard"&&document.querySelector("#dashboard-content")?.hidden===false;
        const settingsReady=${JSON.stringify(kind)}==="settings"&&document.querySelector("#settings-form")?.hidden===false;
        if(activityReady||dashboardReady||settingsReady)window.__structuralPaintElapsed=performance.now()-window.__fixtureStartedAt;
      };
      new MutationObserver(mark).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      mark();
    });
    window.openai={
      locale:"ko-KR",
      notifyIntrinsicHeight:()=>{},
      ${kind === "activity" ? `toolResponseMetadata:${JSON.stringify(initialActivityMetadata)},` : ""}
      callTool:async(name,args)=>{
        window.__cardCalls.push({name,args,at:performance.now()-window.__fixtureStartedAt});
        if(${JSON.stringify(kind)}==="activity"){
          if(args&&args.afterVersion!==undefined){
            if(args.afterVersion===7&&!window.__activityWatchAdvanced){window.__activityWatchAdvanced=true;await new Promise(resolve=>setTimeout(resolve,100));return{structuredContent:Object.assign(${JSON.stringify(activityFixture("structural", 8, "새 구조 활동"))},{generatedAt:new Date().toISOString()})};}
            return new Promise(()=>{});
          }
          if(args&&args.enrich===true){const call=++window.__activityEnrichmentCalls;await new Promise(resolve=>setTimeout(resolve,call===1?650:50));return{structuredContent:Object.assign(call===1?${JSON.stringify(activityFixture("enriched", 7, "오래된 보강 활동"))}:${JSON.stringify(activityFixture("enriched", 8, "최신 보강 활동"))},{generatedAt:new Date().toISOString()})};}
          await new Promise(resolve=>setTimeout(resolve,20));return{structuredContent:Object.assign(${JSON.stringify(activityFixture("structural", 8, "새 구조 활동"))},{generatedAt:new Date().toISOString()})};
        }
        if(${JSON.stringify(kind)}==="dashboard"){
          await new Promise(resolve=>setTimeout(resolve,args&&args.enrich===true?650:20));
          return{structuredContent:args&&args.enrich===true?${JSON.stringify(dashboardView("enriched"))}:${JSON.stringify(dashboardView("structural"))}};
        }
        await new Promise(resolve=>setTimeout(resolve,20));
        return{structuredContent:${JSON.stringify(settingsView)}};
      }
    };
  </script>`;
}
