import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/dashboard-controls-regression");
mkdirSync(artifacts, { recursive: true });
const session = `dashboard-controls-${process.pid}`, execute = promisify(execFile);
const base = { interactionId: "input-1", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", summary: "입력 처리 확인" };
const interactions = [
  { ...base, kind: "user-input", isBlocking: false, questions: [{ id: "choice", question: "색상을 선택하세요", isSecret: false, isOther: false, options: [{ label: "파랑", description: "파란색" }] }] },
  { ...base, kind: "user-input", isBlocking: true, questions: [{ id: "choice", question: "직접 답변하세요", isSecret: true, isOther: true, options: [{ label: "기본", description: "기본값" }] }] },
  { ...base, kind: "mcp-elicitation", elicitation: { mode: "form", serverName: "fixture", requestedSchema: { type: "object", required: ["color", "count", "enabled", "tags"], properties: {
    color: { type: "string", title: "색상", oneOf: [{ const: "blue", title: "파랑" }, { const: "red", title: "빨강" }] },
    count: { type: "integer", title: "개수", minimum: 1, maximum: 3 },
    enabled: { type: "boolean", title: "사용 여부" },
    tags: { type: "array", title: "태그", items: { anyOf: [{ const: "a", title: "가" }, { const: "b", title: "나" }] } }
  } } } },
  { ...base, kind: "mcp-elicitation", elicitation: { mode: "url", serverName: "fixture", url: "https://example.test/verify?state=browser-fixture" } }
];

function html(index: number): string {
  const original = dashboardView("structural"), row = original.terminalRows[0];
  const view = { ...original,
    activeRows: ["row-a", "row-b"].map((rowKey, offset) => ({ ...row, rowKey,
      agentName: offset ? "Second Agent" : row.agentName, bucket: "active", status: "input-required", controlKind: "request",
      history: [], historyCount: 0 })),
    terminalRows: Array.from({ length: 12 }, (_, offset) => ({ ...row, rowKey: `completed-${offset}`,
      activityKey: `completed-activity-${offset}`, agentName: `Completed Agent ${offset + 1}`, controlKind: null, history: [], historyCount: 0 })),
    counts: { ...original.counts, active: 2, inputRequired: 2, needsAttention: 2 },
    pagination: { ...original.pagination,
      active: { ...original.pagination.active, total: 2, returned: 2 },
      terminal: { ...original.pagination.terminal, total: 12, returned: 12 } }
  };
  const detail = { rowKey: "row-a", projectName: "Test project", activityTitle: "Selected work", agentName: "History Agent",
    agentId: "agent-1", jobId: "job-1", jobVersion: 1, agentVersion: 1, status: "running", canStop: false,
    card: { kind: "dashboard", token: "browser-only-fixture", activityId: "activity-1", generation: 1, presentation: { kind: "explicit" } },
    pendingInteractions: [interactions[index]], backgroundProcesses: [] };
  const prelude = `<script>(()=>{
    window.__calls=[];window.__errors=[];window.__opened=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    const view=window.__view=${JSON.stringify(view)},detail=window.__detail=${JSON.stringify(detail)},metadata={};
    window.openai={locale:"ko-KR",toolOutput:view,toolResponseMetadata:metadata,notifyIntrinsicHeight:()=>{},
      openExternal:input=>window.__opened.push(input),
      callTool:async(name,args)=>{window.__calls.push({name,args});return name==="codex_interaction_respond"?{structuredContent:{ok:true}}:args.view==="control"?{structuredContent:{kind:"control",ready:true},_meta:{"codex/uiControl@1":{...detail,rowKey:args.rowKey,jobId:args.rowKey==="row-b"?"job-2":"job-1"}}}:{structuredContent:view,_meta:metadata}}
    };
  })();</script>`;
  return DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
const server = createServer((request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html(Number(request.url?.slice(1)) || 0)); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const results: unknown[] = [];
try {
  await cli("open", `http://127.0.0.1:${port}/0`);
  for (let index = 0; index < interactions.length; index++) {
    if (index) await cli("goto", `http://127.0.0.1:${port}/${index}`);
    writeFileSync(path.join(artifacts, `case-${index}.snapshot.txt`), await cli("snapshot"));
    await cli("run-code", `async page=>{
      if(await page.locator('#terminal-list .work-control-toggle').count())throw new Error('Completed work has an empty control');
      if((await page.locator('#dashboard-content').innerText()).includes('다음 실행 설정:'))throw new Error('Next-run preview leaked into the overview');
      await page.locator('[data-control-row="row-a"]').getByRole('button',{name:'요청 확인',exact:true}).click();
      await page.locator('#work-details-body .interaction').waitFor();
      if(await page.locator('[data-control-row="row-a"] #work-details').count()!==1)throw new Error('Panel is not inside the selected row');
      const bounds=await page.evaluate(()=>({panel:document.querySelector('#work-details').getBoundingClientRect().bottom,next:document.querySelector('[data-control-row="row-b"]').closest('.activity-agent').getBoundingClientRect().top}));
      if(bounds.panel>bounds.next)throw new Error('Panel expanded below another Agent');
    }`);
    await cli("snapshot");
    if (index === 0) await cli("run-code", `async page=>{
      const first=page.locator('[data-control-row="row-a"] .work-control-toggle');
      await first.click();if(await page.locator('#work-details').count())throw new Error('Disclosure did not collapse');
      if(await first.getAttribute('aria-expanded')!=='false')throw new Error('Collapsed ARIA state is wrong');
      await first.click();await page.locator('#work-details-body .interaction').waitFor();
      await page.locator('[data-control-row="row-b"] .work-control-toggle').click();await page.locator('[data-control-row="row-b"] #work-details-body .interaction').waitFor();
      if(await page.locator('#work-details').count()!==1)throw new Error('Switching Agents duplicated the panel');
      await first.click();await page.locator('#work-details-body .interaction').waitFor();
      await page.getByLabel("색상을 선택하세요").selectOption("0");await page.getByLabel("색상을 선택하세요").focus();
      await page.evaluate(()=>{window.__draftField=document.activeElement;document.querySelector('#refresh').click()});
      await page.waitForFunction(()=>window.__calls.filter(call=>call.name==="codex_ui_read"&&call.args.view==="dashboard").length>=4&&document.querySelector('main.card').getAttribute('aria-busy')==='false');
      if(!await page.evaluate(()=>window.__draftField===document.activeElement&&window.__draftField.isConnected))throw new Error('Refresh lost the focused form node');
      if(await page.getByLabel("색상을 선택하세요").inputValue()!=="0")throw new Error("Overview refresh discarded a draft answer");
      if(await page.locator(".interaction input:visible").count())throw new Error("Closed choices exposed free text");
      await page.getByRole("button",{name:"답변 보내기",exact:true}).click();
    }`);
    if (index === 1) await cli("run-code", `async page=>{await page.getByLabel("직접 답변하세요").selectOption("other");await page.locator('.interaction input[type="password"]').fill("직접 작성");await page.getByRole("button",{name:"답변 보내기",exact:true}).click()}`);
    if (index === 2) await cli("run-code", `async page=>{await page.getByLabel("색상",{exact:true}).selectOption("0");await page.getByLabel("개수",{exact:true}).fill("2");await page.getByLabel("사용 여부",{exact:true}).selectOption("1");await page.getByLabel("태그",{exact:true}).selectOption(["1"]);await page.screenshot({path:${JSON.stringify(path.join(artifacts, "form.png"))}});await page.getByRole("button",{name:"승인",exact:true}).click()}`);
    if (index === 3) await cli("run-code", `async page=>{const link=page.getByRole("link",{name:"요청 링크 열기"});if(await link.getAttribute("href")!=="https://example.test/verify?state=browser-fixture")throw new Error("Original request URL was changed");await page.getByRole("button",{name:"승인",exact:true}).click()}`);
    const result = JSON.parse(await cli("run-code", `async page=>page.evaluate(()=>({responses:window.__calls.filter(call=>call.name==="codex_interaction_respond"),errors:window.__errors,opened:window.__opened}))`));
    assert.deepEqual(result.errors, []);
    assert.equal(result.responses.length, 1);
    const expected = index < 2 ? { answers: { choice: [index === 0 ? "파랑" : "직접 작성"] } }
      : { elicitation: { action: "accept", content: index === 3 ? null : { color: "blue", count: 2, enabled: false, tags: ["b"] } } };
    assert.deepEqual(result.responses[0].args.response, expected);
    assert.equal(result.responses[0].args.card.kind, "dashboard");
    assert.equal(result.responses[0].args.jobId, "job-1");
    if (index === 2) await cli("run-code", `async page=>{
      await page.setViewportSize({width:360,height:900});
      if(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('Inline controls overflow on mobile');
      await page.screenshot({path:${JSON.stringify(path.join(artifacts, "inline-mobile.png"))}});
      await page.setViewportSize({width:900,height:900});
      await page.screenshot({path:${JSON.stringify(path.join(artifacts, "inline-desktop.png"))}});
      await page.evaluate(()=>{window.__view.activeRows=window.__view.activeRows.filter(row=>row.rowKey!=='row-a');document.querySelector('#refresh').click()});
      await page.locator('#work-details').waitFor({state:'detached'});
      if(await page.locator('[data-control-row="row-a"]').count())throw new Error('A removed row left stale controls');
    }`);
    results.push({ case: index, passed: true });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log("Dashboard inline controls: 4 input scenarios, local placement, collapse/switch, retained draft/focus, completed-row hiding, removal, mobile/desktop layout, and actual-run-only execution passed (simulated host and data).");
} catch (error) {
  writeFileSync(path.join(artifacts, "failure.txt"), await cli("run-code", "async page=>page.evaluate(()=>({errors:window.__errors,text:document.body.innerText,calls:window.__calls}))").catch(String));
  throw error;
} finally {
  try { await cli("close"); } finally { server.close(); }
}
