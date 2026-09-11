import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { htmlForUiResource } from "../src/uiResources.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/dashboard-stop-regression");
mkdirSync(artifacts, { recursive: true });
const session = `dashboard-stop-${process.pid}`, execute = promisify(execFile);
const retainedUris = ["ui://codex-mcp-bridge/dashboard/942a289cb691.html", "ui://codex-mcp-bridge/dashboard/07b8cdf45ca3.html"];
const variants = [DASHBOARD_CARD_HTML, ...retainedUris.map(uri => htmlForUiResource("dashboard", uri, DASHBOARD_CARD_HTML))];
const results: unknown[] = [];

function html(index: number, kind: string): string {
  const view = dashboardView("structural");
  Object.assign(view.terminalRows[0], { controlKind: "manage", backgroundProcessCount: kind === "process" ? 1 : 0 });
  const detail = { rowKey: "row-a", projectName: "Test project", activityTitle: "Selected work", agentName: "History Agent",
    agentId: "agent-1", jobId: "job-1", jobVersion: 7, agentVersion: 4, status: kind === "job" ? "running" : "completed",
    canStop: kind === "job", affectedJobIds: ["job-1", "job-2"], pendingInteractions: [],
    card: { kind: "dashboard", token: "browser-only-fixture", activityId: "activity-1", generation: 1, presentation: { kind: "explicit" } },
    backgroundProcesses: kind === "process" ? [{ processId: "process-42" }] : [] };
  const prelude = `<script>(()=>{
    window.__calls=[];window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    const view=${JSON.stringify(view)},detail=${JSON.stringify(detail)};
    window.openai={locale:"ko-KR",toolOutput:view,toolResponseMetadata:{},notifyIntrinsicHeight:()=>{},
      callTool:async(name,args)=>{window.__calls.push({name,args});if(name==="codex_ui_stop"){
        await new Promise(resolve=>setTimeout(resolve,100));detail.canStop=false;detail.backgroundProcesses=[];return {structuredContent:{ok:true}};
      }return args.view==="control"?{structuredContent:{kind:"control",ready:true},_meta:{"codex/uiControl@1":detail}}:{structuredContent:view};}
    };
  })();</script>`;
  return variants[index].replace("</head>", `${prelude}</head>`);
}
async function cli(...args: string[]): Promise<string> {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(url.pathname === "/card" ? html(Number(url.searchParams.get("revision")), url.searchParams.get("kind") || "job")
    : `<!doctype html><iframe title="sandboxed dashboard" sandbox="allow-scripts allow-same-origin allow-forms" style="width:100%;height:100vh" src="/card${url.search}"></iframe>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
try {
  await cli("open", `http://127.0.0.1:${port}/?revision=0&kind=job`);
  const current = JSON.parse(await cli("run-code", `async page=>{
    const frame=page.frameLocator('iframe');
    if(await frame.getByRole('button',{name:'작업 관리',exact:true}).count())throw new Error('Current dashboard still exposes work management');
    if(await frame.locator('#work-stop-confirmation').count())throw new Error('Current dashboard mounted a stop confirmation');
    return page.frames()[1].evaluate(()=>({calls:window.__calls.filter(call=>call.name==='codex_ui_stop'),errors:window.__errors}));
  }`));
  assert.deepEqual(current.errors, []);
  assert.deepEqual(current.calls, []);
  results.push({ revision: "current", managementControls: "absent", passed: true });
  for (let revision = 1; revision < variants.length; revision++) for (const kind of ["job", "process"]) {
    await cli("goto", `http://127.0.0.1:${port}/?revision=${revision}&kind=${kind}`);
    await cli("snapshot");
    const result = JSON.parse(await cli("run-code", `async page=>{
      const frame=page.frameLocator('iframe'),stop=frame.getByRole('button',{name:'에이전트 강제 종료…',exact:true}),confirmation=frame.locator('#work-stop-confirmation');
      await frame.getByRole('button',{name:'상세 보기',exact:true}).click();
      await stop.click();await confirmation.waitFor();
      const text=await confirmation.innerText();if(!text.includes('Test project')||!text.includes('Selected work')||!text.includes('History Agent'))throw new Error('Stop target missing');
      const before=await page.frames()[1].evaluate(()=>window.__calls.filter(call=>call.name==='codex_ui_stop').length);
      if(before)throw new Error('Stop sent before confirmation');
      await confirmation.getByRole('button',{name:'취소',exact:true}).click();
      if(await confirmation.count())throw new Error('Cancel left confirmation mounted');
      await stop.click();await confirmation.waitFor();
      await frame.locator('#work-details-refresh').click();await confirmation.waitFor({state:'detached'});
      await stop.click();await confirmation.waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts, `confirm-${revision}-${kind}.png`))}});
      await confirmation.getByRole('button',{name:'에이전트 강제 종료…',exact:true}).dblclick();
      await confirmation.waitFor({state:'detached'});
      return page.frames()[1].evaluate(()=>({calls:window.__calls.filter(call=>call.name==='codex_ui_stop'),errors:window.__errors}));
    }`));
    assert.deepEqual(result.errors, []);
    assert.equal(result.calls.length, 1);
    const args = result.calls[0].args;
    assert.equal(args.kind, kind);
    assert.equal(args.card.token, "browser-only-fixture");
    assert.ok(args.requestId && args.widgetInstanceId);
    if (kind === "job") {
      assert.equal(args.jobId, "job-1"); assert.equal(args.expectedJobVersion, 7);
      assert.deepEqual(args.acknowledgeAffectedJobIds, ["job-1", "job-2"]);
    } else {
      assert.equal(args.agentId, "agent-1"); assert.equal(args.expectedAgentVersion, 4);
      assert.equal(args.processId, "process-42");
    }
    results.push({ revision: revision ? retainedUris[revision - 1] : "current", kind, passed: true });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log("Current Dashboard management controls are absent; four retained-card stop compatibility scenarios passed.");
} finally {
  try { await cli("close"); } finally { server.close(); }
}
