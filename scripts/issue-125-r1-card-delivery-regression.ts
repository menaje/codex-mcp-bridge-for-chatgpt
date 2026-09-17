import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

// Reconstructed R1 fixture for issue #125. The discarded UI-3/FRESH probe is
// not presented as recovered history; this fixture preserves the new contract
// and makes the previously unobserved host-to-card delivery boundary repeatable.
const artifacts = path.resolve("output/playwright/issue-125-r1-card-delivery");
mkdirSync(artifacts, { recursive: true });
const session = `issue-125-r1-card-delivery-${process.pid}`;
const execute = promisify(execFile);
const jobId = "12500000-0000-4000-8000-000000000001";
const presentationRef = "1".repeat(64);
const otherPresentationRef = "2".repeat(64);

const toolInput = (ref = presentationRef) => ({
  arguments: { scope: "conversation", jobId, presentationRef: ref }
});
const toolResult = (ref = presentationRef) => ({
  structuredContent: {
    kind: "dashboard",
    scope: "bridge-wide",
    readOnly: true,
    statusSource: "codex-runtime-only",
    summary: "R1 delivery fixture"
  },
  _meta: {
    "codex/dashboardOpen@1": {
      scope: "conversation",
      automatic: true,
      presentationRef: ref,
      completionDeliveryRoute: "disabled"
    }
  }
});

function cardHtml(scenario: string): string {
  const base = dashboardView("structural");
  const view = {
    ...base,
    scope: "conversation",
    statusFilter: "all",
    historyIncluded: false,
    statusRows: [],
    statusRowsComplete: true,
    filter: {
      mode: "conversation",
      conversationAvailable: true,
      conversationHasWork: true
    }
  };
  const initial = scenario === "initial-compatibility";
  const prelude = `<script>(()=>{
    const view=${JSON.stringify(view)},initialInput=${JSON.stringify(toolInput())},initialResult=${JSON.stringify(toolResult())};
    window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.error&&event.error.message||event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason&&event.reason.message||event.reason)));
    window.openai={
      locale:"ko-KR",
      toolInput:${initial ? "initialInput.arguments" : "null"},
      toolOutput:${initial ? "initialResult.structuredContent" : "null"},
      toolResponseMetadata:${initial ? "initialResult._meta" : "null"},
      notifyIntrinsicHeight:()=>{},
      callTool:async()=>({structuredContent:view})
    };
  })();</script>`;
  return DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);
}

function hostHtml(scenario: string): string {
  return `<!doctype html><html><body><script>(()=>{
    const scenario=${JSON.stringify(scenario)},input=${JSON.stringify(toolInput())},result=${JSON.stringify(toolResult())},mismatch=${JSON.stringify(toolResult(otherPresentationRef))};
    window.__hostEvents=[];window.__initResponded=false;window.__emptyGlobalsSent=false;
    const frame=document.createElement("iframe");frame.id="card";frame.src="/card?scenario="+encodeURIComponent(scenario);document.body.appendChild(frame);
    const send=(method,params)=>{window.__hostEvents.push(method);frame.contentWindow.postMessage({jsonrpc:"2.0",method,params},"*")};
    const globals=(value)=>{const EventCtor=frame.contentWindow.CustomEvent;frame.contentWindow.dispatchEvent(new EventCtor("openai:set_globals",{detail:{globals:value}}))};
    window.addEventListener("message",event=>{
      if(event.source!==frame.contentWindow)return;
      const message=event.data;if(!message||message.jsonrpc!=="2.0")return;
      if(message.method!=="ui/initialize"||message.id===undefined)return;
      if(scenario==="standard-before-init"||scenario==="empty-after-ready"){send("ui/notifications/tool-input",input);send("ui/notifications/tool-result",result)}
      if(scenario==="result-before-input")send("ui/notifications/tool-result",result);
      if(scenario==="mismatch-then-recover"){send("ui/notifications/tool-input",input);send("ui/notifications/tool-result",mismatch)}
      frame.contentWindow.postMessage({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}}},"*");
      window.__initResponded=true;
      if(scenario==="result-before-input")setTimeout(()=>send("ui/notifications/tool-input",input),4000);
      if(scenario==="mismatch-then-recover")setTimeout(()=>send("ui/notifications/tool-result",result),4000);
      if(scenario==="late-compatibility")setTimeout(()=>globals({toolInput:input.arguments,toolOutput:result.structuredContent,toolResponseMetadata:result._meta}),4000);
      if(scenario==="empty-after-ready")setTimeout(()=>{globals({toolInput:null,toolOutput:null,toolResponseMetadata:null});window.__emptyGlobalsSent=true},4000);
    });
  })();</script></body></html>`;
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute(
    "npx",
    ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
  );
  return result.stdout.trim();
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const scenario = url.searchParams.get("scenario") || "standard-before-init";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(url.pathname === "/card" ? cardHtml(scenario) : hostHtml(scenario));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const scenarios = [
  "standard-before-init",
  "result-before-input",
  "mismatch-then-recover",
  "late-compatibility",
  "initial-compatibility",
  "empty-after-ready"
] as const;
const results: Array<Record<string, unknown>> = [];

try {
  await cli("open", `http://127.0.0.1:${port}/?scenario=${scenarios[0]}`);
  for (const [index, scenario] of scenarios.entries()) {
    if (index > 0) await cli("goto", `http://127.0.0.1:${port}/?scenario=${scenario}`);
    const transitional = scenario === "result-before-input" ? "result-only"
      : scenario === "mismatch-then-recover" ? "mismatch"
      : scenario === "late-compatibility" ? "missing"
      : null;
    if (transitional) {
      await cli("run-code", `async page=>{
        await page.waitForFunction(()=>window.__initResponded===true);
        const frame=page.frames().find(candidate=>candidate.url().includes('/card?'));
        await frame.waitForFunction(expected=>document.documentElement.dataset.dashboardPresentation===expected,${JSON.stringify(transitional)});
      }`);
    }
    if (scenario === "empty-after-ready") {
      await cli("run-code", "async page=>page.waitForFunction(()=>window.__emptyGlobalsSent===true)");
    }
    const raw = await cli("run-code", `async page=>{
      const frame=page.frames().find(candidate=>candidate.url().includes('/card?'));
      await frame.waitForFunction(()=>document.documentElement.dataset.dashboardPresentation==='ready');
      return frame.evaluate(()=>({dataset:{...document.documentElement.dataset},errors:window.__errors}));
    }`);
    const observed = JSON.parse(raw) as { dataset: Record<string, string>; errors: string[] };
    assert.equal(observed.dataset.dashboardPresentation, "ready", scenario);
    assert.equal(observed.dataset.dashboardPresentationInput, "received", scenario);
    assert.equal(observed.dataset.dashboardPresentationResult, "received", scenario);
    assert.equal(observed.dataset.dashboardPresentationOutput, "received", scenario);
    assert.deepEqual(observed.errors, [], scenario);
    const diagnosticText = JSON.stringify(observed.dataset);
    assert.equal(diagnosticText.includes(jobId), false, `${scenario}: raw Job ID leaked into diagnostics`);
    assert.equal(diagnosticText.includes(presentationRef), false, `${scenario}: correlation reference leaked into diagnostics`);
    results.push({ scenario, dataset: observed.dataset, passed: true });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(artifacts, "final.snapshot.txt"), await cli("snapshot"));
  console.log(`Issue #125 R1 card delivery: ${results.length}/${scenarios.length} reconstructed host-order scenarios passed.`);
} catch (error) {
  writeFileSync(path.join(artifacts, "failure.txt"), String(error));
  throw error;
} finally {
  try {
    await cli("close");
  } finally {
    server.close();
  }
}
