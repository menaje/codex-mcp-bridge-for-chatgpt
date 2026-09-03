import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_CARD_CONTRACT_GENERATION,
  ACTIVITY_CARD_HTML
} from "../src/activityCard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(repoRoot, "output", "playwright", "activity-card-regression");
const session = `activity-card-regression-${process.pid}`;
const browserTitle = "Browser hydration activity";
const recentTitle = "Recent browser activity";
const idleAgentName = "Idle browser Agent";
const execFileAsync = promisify(execFile);

mkdirSync(artifactDir, { recursive: true });

const view = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  scopeVersion: 1,
  uiLocalePreference: "ko",
  feed: {
    mode: "compact",
    active: [
      {
        activityId: "activity-browser-regression",
        title: browserTitle,
        lifecycle: "open",
        kind: "implementation",
        displayState: "running",
        elapsedMs: 1_000,
        counts: { total: 1, failed: 0 },
        agents: [],
        cancellations: [],
        canRequestVerification: false,
        canRetry: false
      }
    ],
    activeCount: 1,
    activityTotal: 2,
    activeHasMore: false,
    showWorkspaceLabels: false,
    history: {
      rows: [
        {
          activityId: "recent-browser-regression",
          title: recentTitle,
          lifecycle: "completed",
          kind: "implementation",
          displayState: "completed",
          elapsedMs: 2_000,
          counts: { total: 1, failed: 0 },
          agents: [
            {
              agentId: "recent-browser-agent",
              agentName: "Recent browser Agent",
              role: null,
              displayState: "completed",
              durationMs: 2_000,
              backgroundProcessCount: 0
            }
          ],
          cancellations: [],
          canRequestVerification: false,
          canRetry: false,
          updatedAt: "2026-09-02T23:59:00.000Z"
        }
      ],
      pagination: { limit: 3, returned: 1, total: 1, hasMore: false }
    },
    idleAgents: {
      agentCount: 1,
      rows: [
        {
          agentId: "idle-browser-agent",
          agentName: idleAgentName,
          role: null,
          latestActivityId: null,
          latestActivityTitle: null,
          workspaceLabels: [],
          updatedAt: "2026-09-02T23:58:00.000Z"
        }
      ],
      hasMore: false,
      pagination: { limit: 3, returned: 1, total: 1, hasMore: false }
    },
    historySummary: {
      completedActivities: 1,
      endedActivities: 0,
      idleAgents: 1
    }
  },
  watcherPolicy: {
    live: false,
    stopReason: "historical"
  },
  pendingHandoffs: [],
  mountedActivity: {
    activityId: "activity-browser-regression",
    cardGeneration: ACTIVITY_CARD_CONTRACT_GENERATION
  },
  mountedPresentation: {
    kind: "historical",
    jobId: "job-browser-regression",
    requestId: "request-browser-regression"
  }
};

const privateMetadata = {
  "codex/activityView@11": {
    kind: "codex/activityView",
    version: 11,
    purpose: "presentation-hydration-only",
    correlation: {
      activityId: "activity-browser-regression",
      jobId: "job-browser-regression",
      requestId: "request-browser-regression"
    },
    view
  }
};

const publicTask = {
  kind: "task",
  activityId: "activity-browser-regression",
  jobId: "job-browser-regression",
  requestId: "request-browser-regression"
};

const toolResult = {
  structuredContent: publicTask,
  content: [{ type: "text", text: JSON.stringify(publicTask) }],
  _meta: privateMetadata
};

const nestedMcpResult = { mcp_tool_result: toolResult };
const nestedCallResult = {
  call_tool_result: JSON.stringify({ result: toolResult })
};

function errorCapturePrelude(): string {
  return String.raw`
    window.__activityBrowserErrors=[];
    window.addEventListener("error",(event)=>window.__activityBrowserErrors.push(String(event.error&&event.error.message||event.message||event.error)));
    window.addEventListener("unhandledrejection",(event)=>window.__activityBrowserErrors.push(String(event.reason&&event.reason.message||event.reason)));
  `;
}

function compatibilityPrelude(
  metadata: unknown,
  toolOutput?: unknown,
  toolCallResult: unknown = nestedCallResult
): string {
  const outputProperty = toolOutput === undefined
    ? ""
    : `toolOutput:${JSON.stringify(toolOutput)},`;
  return `<script>${errorCapturePrelude()}
    const activityToolCallResult=${JSON.stringify(toolCallResult)};
    window.openai={
      locale:"ko-KR",
      toolResponseMetadata:${JSON.stringify(metadata)},
      ${outputProperty}
      notifyIntrinsicHeight:()=>{},
      callTool:async(name,args)=>{
        window.__activityToolCalls=(window.__activityToolCalls||[]).concat([{name,args}]);
        if(name==="codex_activity_rehydrate"||name==="codex_activity_snapshot")return activityToolCallResult;
        throw new Error("Unexpected Activity card tool: "+name);
      }
    };
  </script>`;
}

function standardHostHtml(): string {
  const cardHtml = fixtureHtml(`<script>${errorCapturePrelude()}</script>`);
  return `<!doctype html><html><body><iframe id="activity-card"></iframe><script>
    const activityPublicTask=${JSON.stringify(publicTask)};
    const activityPublicResult={structuredContent:activityPublicTask,content:[{type:"text",text:JSON.stringify(activityPublicTask)}]};
    const activityToolCallResult=${JSON.stringify({ tool_result: nestedCallResult })};
    const card=document.querySelector("#activity-card");
    window.__activityToolCalls=[];
    window.addEventListener("message",(event)=>{
      const value=event.data;
      if(event.source!==card.contentWindow||!value||value.jsonrpc!=="2.0"||value.id===undefined||!value.method)return;
      if(value.method==="ui/initialize"){
        setTimeout(()=>event.source.postMessage({jsonrpc:"2.0",id:value.id,result:{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}}},"*"),0);
        setTimeout(()=>event.source.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{result:{tool_result:activityPublicResult}}},"*"),10);
        return;
      }
      if(value.method==="tools/call"){
        window.__activityToolCalls.push({name:value.params&&value.params.name,args:value.params&&value.params.arguments});
        setTimeout(()=>event.source.postMessage({jsonrpc:"2.0",id:value.id,result:activityToolCallResult},"*"),0);
      }
    });
    card.srcdoc=${JSON.stringify(cardHtml).replaceAll("<", "\\u003c")};
  </script></body></html>`;
}

function setGlobalsPrelude(): string {
  return `<script>${errorCapturePrelude()}
    window.openai={locale:"ko-KR",notifyIntrinsicHeight:()=>{}};
    setTimeout(()=>window.dispatchEvent(new CustomEvent("openai:set_globals",{detail:{globals:{locale:"ko-KR",toolResponseMetadata:${JSON.stringify(nestedMcpResult)}}}})),25);
  </script>`;
}

function failureRetryPrelude(): string {
  return `<script>${errorCapturePrelude()}
    const activityPublicTask=${JSON.stringify(publicTask)};
    const activityToolCallResult=${JSON.stringify(nestedCallResult)};
    window.openai={locale:"ko-KR",notifyIntrinsicHeight:()=>{}};
    window.__recoverActivity=()=>{
      window.openai.toolOutput=activityPublicTask;
      window.openai.callTool=async(name,args)=>{
        window.__activityToolCalls=(window.__activityToolCalls||[]).concat([{name,args}]);
        if(name==="codex_activity_rehydrate")return activityToolCallResult;
        throw new Error("Unexpected Activity card tool: "+name);
      };
    };
  </script>`;
}

const cases = [
  { name: "raw-private-metadata", html: fixtureHtml(compatibilityPrelude(privateMetadata)), framed: false },
  { name: "direct-tool-result", html: fixtureHtml(compatibilityPrelude(toolResult)), framed: false },
  { name: "nested-mcp-result", html: fixtureHtml(compatibilityPrelude(nestedMcpResult)), framed: false },
  { name: "nested-call-json-result", html: fixtureHtml(compatibilityPrelude(nestedCallResult)), framed: false },
  { name: "cold-compatibility-rehydrate", html: fixtureHtml(compatibilityPrelude({}, publicTask)), framed: false },
  { name: "standard-tool-result", html: standardHostHtml(), framed: true },
  { name: "set-globals", html: fixtureHtml(setGlobalsPrelude()), framed: false }
] as const;

function fixtureHtml(prelude: string): string {
  return ACTIVITY_CARD_HTML.replace("</head>", `${prelude}\n</head>`);
}

async function cli(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(
    "npx",
    [
      "--yes",
      "--package",
      "@playwright/cli@0.1.19",
      "playwright-cli",
      "--session",
      session,
      "--raw",
      ...args
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  return stdout.trim();
}

async function waitFor(expression: string, framed = false): Promise<void> {
  await cli([
    "run-code",
    `async page=>{const frame=${framed ? "page.frames().find(frame=>frame!==page.mainFrame())" : "page.mainFrame()"};if(!frame)throw new Error("Activity card frame missing");await frame.waitForFunction(()=>${expression},null,{timeout:8000})}`
  ], 15_000);
}

type BrowserState = {
  bodyHidden: boolean;
  cardHidden: boolean;
  heading: string;
  count: string;
  title: string;
  recentTitle: string;
  idleAgentName: string;
  idleExpanded: string;
  idlePanelHidden: boolean;
  message: string;
  messageIsError: boolean;
  refreshLabel: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  errors: string[];
};

async function browserState(framed = false): Promise<BrowserState> {
  const state = JSON.parse(await cli([
    "run-code",
    `async page=>{const frame=${framed ? "page.frames().find(frame=>frame!==page.mainFrame())" : "page.mainFrame()"};if(!frame)throw new Error("Activity card frame missing");const state=await frame.evaluate(()=>({
      bodyHidden:document.body.hidden,
      cardHidden:document.querySelector("main.card").hidden,
      heading:document.querySelector("#activity-heading").textContent,
      count:document.querySelector("#current-count").textContent,
      title:document.querySelector(".row .name")&&document.querySelector(".row .name").textContent||"",
      recentTitle:document.querySelector(".groups .group-list .row .name")&&document.querySelector(".groups .group-list .row .name").textContent||"",
      idleAgentName:document.querySelector("#group-idle .activity-agent .name")&&document.querySelector("#group-idle .activity-agent .name").textContent||"",
      idleExpanded:document.querySelector('[aria-controls="group-idle"]')&&document.querySelector('[aria-controls="group-idle"]').getAttribute("aria-expanded")||"",
      idlePanelHidden:Boolean(document.querySelector("#group-idle")&&document.querySelector("#group-idle").hidden),
      message:document.querySelector("#message").textContent,
      messageIsError:document.querySelector("#message").classList.contains("error"),
      refreshLabel:document.querySelector("#refresh").getAttribute("aria-label")||"",
      toolCalls:window.__activityToolCalls||[],
      errors:window.__activityBrowserErrors||[]
    }));${framed ? "state.toolCalls=await page.evaluate(()=>window.__activityToolCalls||[]);" : ""}return state}`
  ])) as BrowserState;
  return state;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertRendered(name: string, state: BrowserState): void {
  assert(!state.bodyHidden, `${name}: body stayed hidden`);
  assert(!state.cardHidden, `${name}: card stayed hidden`);
  assert(state.heading === "현재 활동", `${name}: localized heading was not rendered`);
  assert(state.count === "· 1", `${name}: active count was not rendered`);
  assert(state.title === browserTitle, `${name}: Activity row was not rendered`);
  assert(state.recentTitle === recentTitle, `${name}: recent Activity was not visible by default`);
  assert(state.idleAgentName === idleAgentName, `${name}: idle Agent detail was not rendered`);
  assert(state.idleExpanded === "false", `${name}: idle section did not start collapsed`);
  assert(state.idlePanelHidden, `${name}: idle section content was visible by default`);
  assert(!state.messageIsError, `${name}: card rendered an error state`);
  assert(state.errors.length === 0, `${name}: browser errors: ${state.errors.join("; ")}`);
}

const report: Record<string, BrowserState> = {};
let opened = false;
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    const filename = pathname.slice(1);
    if (!/^[a-z0-9-]+\.html$/.test(filename)) {
      response.writeHead(404).end();
      return;
    }
    const html = readFileSync(path.join(artifactDir, filename));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(html);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object", "browser regression server did not start");
const fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

try {
  for (const [index, { name, html, framed }] of cases.entries()) {
    const fixturePath = path.join(artifactDir, `${name}.html`);
    writeFileSync(fixturePath, html);
    const fixtureUrl = `${fixtureBaseUrl}/${name}.html`;
    if (index === 0) {
      await cli(["open", fixtureUrl], 60_000);
      opened = true;
    } else {
      await cli(["goto", fixtureUrl]);
    }
    await waitFor(`document.querySelector(".row .name")&&document.querySelector(".row .name").textContent===${JSON.stringify(browserTitle)}`, framed);
    const state = await browserState(framed);
    assertRendered(name, state);
    if (name === "cold-compatibility-rehydrate" || name === "standard-tool-result") {
      assert(
        state.toolCalls.some((call) => call.name === "codex_activity_rehydrate"),
        `${name}: public task correlation did not invoke safe rehydration`
      );
    }
    report[name] = state;
  }

  const failurePath = path.join(artifactDir, "failure-retry.html");
  writeFileSync(failurePath, fixtureHtml(failureRetryPrelude()));
  await cli(["goto", `${fixtureBaseUrl}/failure-retry.html`]);
  await waitFor(`!document.body.hidden&&document.querySelector("#message").classList.contains("error")`);
  const failed = await browserState();
  assert(!failed.bodyHidden && !failed.cardHidden, "failure-retry: error UI stayed hidden");
  assert(failed.message === "Activity를 불러오지 못했습니다. 다시 시도하세요.", "failure-retry: understandable localized error was not shown");
  assert(failed.refreshLabel === "재시도", "failure-retry: retry action was not exposed");
  assert(failed.errors.length === 0, `failure-retry: browser errors: ${failed.errors.join("; ")}`);
  report["failure-visible"] = failed;

  await cli(["eval", "()=>window.__recoverActivity()"]);
  await cli(["run-code", "async page=>{await page.locator('#refresh').click()}"]);
  await waitFor(`document.querySelector(".row .name")&&document.querySelector(".row .name").textContent===${JSON.stringify(browserTitle)}`);
  const recovered = await browserState();
  assertRendered("failure-retry-recovered", recovered);
  assert(
    recovered.toolCalls.some((call) => call.name === "codex_activity_rehydrate"),
    "failure-retry-recovered: retry did not invoke safe rehydration"
  );
  report["failure-retry-recovered"] = recovered;

  const reportPath = path.join(artifactDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Activity card browser regression passed (${Object.keys(report).length} states).\n`);
  process.stdout.write(`${reportPath}\n`);
} finally {
  if (opened) {
    try {
      await cli(["close"]);
    } catch {
      // Preserve the original regression failure; a stale session can be closed manually.
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
