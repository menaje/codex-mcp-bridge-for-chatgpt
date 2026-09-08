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
  const view = dashboardView("structural");
  const detail = { rowKey: "row-a", projectName: "Test project", activityTitle: "Selected work", agentName: "History Agent",
    agentId: "agent-1", jobId: "job-1", jobVersion: 1, agentVersion: 1, status: "running", canStop: false,
    card: { kind: "dashboard", token: "browser-only-fixture", activityId: "activity-1", generation: 1, presentation: { kind: "explicit" } },
    pendingInteractions: [interactions[index]], backgroundProcesses: [] };
  const prelude = `<script>(()=>{
    window.__calls=[];window.__errors=[];window.__opened=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    const view=${JSON.stringify(view)},detail=${JSON.stringify(detail)},metadata={};
    window.openai={locale:"ko-KR",toolOutput:view,toolResponseMetadata:metadata,notifyIntrinsicHeight:()=>{},
      openExternal:input=>window.__opened.push(input),
      callTool:async(name,args)=>{window.__calls.push({name,args});return name==="codex_interaction_respond"?{structuredContent:{ok:true}}:args.view==="control"?{structuredContent:{kind:"control",ready:true},_meta:{"codex/uiControl@1":detail}}:{structuredContent:view,_meta:metadata}}
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
    await cli("run-code", `async page=>{await page.getByRole("button",{name:"상세 보기",exact:true}).click();await page.locator('#work-details-body .interaction').waitFor();}`);
    await cli("snapshot");
    if (index === 0) await cli("run-code", `async page=>{await page.getByLabel("색상을 선택하세요").selectOption("0");await page.locator("#refresh").click();await page.waitForFunction(()=>window.__calls.filter(call=>call.name==="codex_ui_read"&&call.args.view==="dashboard").length>=3);if(await page.getByLabel("색상을 선택하세요").inputValue()!=="0")throw new Error("Overview refresh discarded a draft answer");if(await page.locator(".interaction input:visible").count())throw new Error("Closed choices exposed free text");await page.getByRole("button",{name:"답변 보내기",exact:true}).click()}`);
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
    results.push({ case: index, passed: true });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log("Dashboard details: 4 browser scenarios passed (simulated host and data; backend proof checks use MCP integration tests).");
} catch (error) {
  writeFileSync(path.join(artifacts, "failure.txt"), await cli("run-code", "async page=>page.evaluate(()=>({errors:window.__errors,text:document.body.innerText,calls:window.__calls}))").catch(String));
  throw error;
} finally {
  try { await cli("close"); } finally { server.close(); }
}
