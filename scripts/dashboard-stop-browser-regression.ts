import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/dashboard-stop-regression");
mkdirSync(artifacts, { recursive: true });
const session = `dashboard-stop-${process.pid}`;
const execute = promisify(execFile);

function pageHtml(kind: "job" | "process"): string {
  const source = dashboardView("structural").terminalRows[0];
  const row = {
    ...source,
    rowKey: kind === "job" ? "a".repeat(32) : "b".repeat(32),
    bucket: "active",
    status: kind === "job" ? "running" : "background-process-running",
    controlKind: "execution",
    backgroundProcessCount: kind === "process" ? 1 : 0,
    history: [],
    historyCount: 0
  };
  const structural = dashboardView("structural");
  const view = {
    ...structural,
    activeRows: [row],
    terminalRows: [],
    statusRows: [row],
    statusRowsComplete: true,
    historyIncluded: true,
    counts: {
      ...structural.counts,
      active: 1,
      running: kind === "job" ? 1 : 0,
      backgroundProcesses: kind === "process" ? 1 : 0,
      backgroundProcessAgents: kind === "process" ? 1 : 0
    },
    pagination: {
      ...structural.pagination,
      active: { ...structural.pagination.active, total: 1, returned: 1 },
      terminal: { ...structural.pagination.terminal, total: 0, returned: 0 }
    }
  };
  const detail = {
    rowKey: row.rowKey,
    projectName: "Test project",
    activityTitle: "Selected work",
    agentName: "History Agent",
    agentId: "agent-1",
    jobId: "job-1",
    jobVersion: 7,
    agentVersion: 4,
    status: row.status,
    canStop: kind === "job",
    affectedJobIds: ["job-1", "job-2"],
    backgroundProcesses: kind === "process" ? [{ processId: "process-42" }] : [],
    pendingInteractions: [],
    card: { kind: "dashboard", token: "browser-only-fixture" }
  };
  const prelude = `<script>(()=>{
    window.__calls=[];window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    const view=${JSON.stringify(view)},detail=${JSON.stringify(detail)};
    window.openai={locale:"ko-KR",toolOutput:view,toolResponseMetadata:{},notifyIntrinsicHeight:()=>{},callTool:async(name,args)=>{
      window.__calls.push({name,args});
      if(name==="codex_ui_stop"){detail.canStop=false;detail.backgroundProcesses=[];return{structuredContent:{ok:true}};}
      if(args&&args.view==="control")return{structuredContent:{kind:"control",ready:true},_meta:{"codex/uiControl@1":detail}};
      return{structuredContent:view};
    }};
  })();</script>`;
  return DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);
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
  const kind = new URL(request.url || "/", "http://localhost").searchParams.get("kind") === "process"
    ? "process"
    : "job";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(pageHtml(kind));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

try {
  for (const kind of ["job", "process"] as const) {
    await cli("open", `${origin}/?kind=${kind}`);
    const initial = JSON.parse(await cli("run-code", `async page=>{
      await page.waitForTimeout(6500);
      return page.evaluate(()=>({
        contentHidden:document.querySelector('#dashboard-content')?.hidden,
        message:document.querySelector('#message')?.textContent,
        errors:window.__errors
      }));
    }`));
    assert.equal(initial.contentHidden, false, `Dashboard did not render: ${JSON.stringify(initial)}`);
    assert.deepEqual(initial.errors, []);

    const opened = JSON.parse(await cli("run-code", `async page=>page.evaluate(async()=>{
      document.querySelector('[data-status-filter=${JSON.stringify(kind === "process" ? "background" : "running")}]')?.click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const toggle=document.querySelector('.work-control-toggle');
      if(toggle)toggle.click();
      await new Promise(resolve=>setTimeout(resolve,200));
      return {details:document.querySelectorAll('#work-details').length,toggles:document.querySelectorAll('.work-control-toggle').length,active:document.querySelector('#active-list')?.textContent,fixtureRows:window.openai.toolOutput.statusRows?.map(row=>({status:row.status,bucket:row.bucket,controlKind:row.controlKind})),filters:Array.from(document.querySelectorAll('[data-status-filter]')).map(button=>({value:button.dataset.statusFilter,pressed:button.getAttribute('aria-pressed'),disabled:button.disabled})),buttons:Array.from(document.querySelectorAll('#work-details button')).map(button=>button.textContent?.trim()),calls:window.__calls.filter(call=>call.name==='codex_ui_stop').length,errors:window.__errors};
    })`));
    assert.equal(opened.details, 1, `Dashboard control did not open: ${JSON.stringify(opened)}`);
    assert.ok(opened.buttons.includes("강제 종료"), `Dashboard stop control is missing: ${JSON.stringify(opened)}`);
    assert.equal(opened.calls, 0);

    const confirmation = JSON.parse(await cli("run-code", `async page=>page.evaluate(async()=>{
      const stop=Array.from(document.querySelectorAll('#work-details button')).find(button=>button.textContent?.trim()==='강제 종료');
      if(stop)stop.click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const panel=document.querySelector('#work-stop-confirmation');
      return {text:panel?.textContent||'',calls:window.__calls.filter(call=>call.name==='codex_ui_stop').length};
    })`));
    assert.equal(confirmation.calls, 0, "Stop was sent before confirmation.");
    assert.match(confirmation.text, /Test project/);

    const cancelled = JSON.parse(await cli("run-code", `async page=>page.evaluate(async()=>{
      const cancel=Array.from(document.querySelectorAll('#work-stop-confirmation button')).find(button=>button.textContent?.trim()==='취소');
      if(cancel)cancel.click();
      await new Promise(resolve=>setTimeout(resolve,25));
      return {confirmation:document.querySelectorAll('#work-stop-confirmation').length,calls:window.__calls.filter(call=>call.name==='codex_ui_stop').length};
    })`));
    assert.equal(cancelled.confirmation, 0);
    assert.equal(cancelled.calls, 0);

    const result = JSON.parse(await cli("run-code", `async page=>page.evaluate(async()=>{
      const stop=Array.from(document.querySelectorAll('#work-details button')).find(button=>button.textContent?.trim()==='강제 종료');
      if(stop)stop.click();
      await new Promise(resolve=>setTimeout(resolve,25));
      const confirm=Array.from(document.querySelectorAll('#work-stop-confirmation button')).find(button=>button.textContent?.trim()==='강제 종료');
      if(confirm)confirm.click();
      await new Promise(resolve=>setTimeout(resolve,100));
      return {calls:window.__calls.filter(call=>call.name==='codex_ui_stop'),errors:window.__errors};
    })`));
    await cli("run-code", `async page=>page.screenshot({path:${JSON.stringify(artifacts)}+'/${kind}.png'})`);
    assert.deepEqual(result.errors, []);
    assert.equal(result.calls.length, 1);
    const args = result.calls[0].args;
    assert.equal(args.kind, kind);
    assert.equal(args.card.token, "browser-only-fixture");
    assert.ok(args.requestId && args.widgetInstanceId);
    if (kind === "job") {
      assert.equal(args.jobId, "job-1");
      assert.equal(args.expectedJobVersion, 7);
      assert.deepEqual(args.acknowledgeAffectedJobIds, ["job-1", "job-2"]);
    } else {
      assert.equal(args.agentId, "agent-1");
      assert.equal(args.expectedAgentVersion, 4);
      assert.equal(args.processId, "process-42");
    }
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ passed: ["job", "process"] }, null, 2) + "\n");
  console.log("Dashboard job and background-process stop confirmations passed.");
} finally {
  try { await cli("close"); } finally { server.close(); }
}
