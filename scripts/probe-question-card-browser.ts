import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { ACTIVITY_CARD_HTML, ACTIVITY_CARD_CONTRACT_GENERATION } from "../src/activityCard.js";

// Reuse the actual card renderer in an isolated copy. The replacement submit
// handler and host/server callbacks are prototypes, not production behavior.
const artifacts = path.resolve("output/playwright/question-gpt-card-probe");
mkdirSync(artifacts, { recursive: true });
const session = `question-gpt-${process.pid}`, execute = promisify(execFile);
const replacement = String.raw`async function respondInteraction(row,agent,control,interaction,response,button){
  button.disabled=true;
  let record;
  try {
    const result=await callTool("probe_question_submit",{questionId:interaction.interactionId,requestId:mutationId(),response,card:cardProof()},TOOL_CALL_TIMEOUT_MS,false);
    record=result.structuredContent;
    for(const input of button.closest(".interaction").querySelectorAll("input,select,textarea"))input.disabled=true;
  } catch(error){showError(error);button.disabled=false;return}
  const notify=async()=>{await sendFollowUp("User answer available. responseRef="+record.responseRef);button.textContent="GPT에 전달 요청됨"};
  try {await notify()} catch(error){
    showError(error);
    const retry=actionButton("GPT에 답변 전달 재시도",async()=>{retry.disabled=true;try{await notify();retry.remove()}catch(error){showError(error);retry.disabled=false}});
    button.parentElement.appendChild(retry);
  }
}`;
assert.match(ACTIVITY_CARD_HTML, /async function respondInteraction[^\n]+/);
const prototypeHtml = ACTIVITY_CARD_HTML.replace(/async function respondInteraction[^\n]+/, replacement);

function html(mode: string): string {
  const view = {
    generatedAt: new Date().toISOString(), scopeVersion: 1, uiLocalePreference: "ko",
    feed: { mode: "compact", activeCount: 1, activityTotal: 1, active: [{ activityId: "activity-1", title: "GPT 의견 확인",
      lifecycle: "open", kind: "discussion", displayState: "running", counts: { total: 1, failed: 0 },
      agents: [{ agentId: "agent-1", agentName: "GPT 질문", displayState: "running" }] }],
      history: { rows: [], pagination: { total: 0 } }, historySummary: { completedActivities: 0, endedActivities: 0, idleAgents: 0 } },
    mountedActivity: { activityId: "activity-1", cardGeneration: ACTIVITY_CARD_CONTRACT_GENERATION },
    mountedPresentation: { kind: "explicit" }, watcherPolicy: { live: false }, pendingHandoffs: []
  };
  const metadata = { "codex/activityScopeId": "11111111-1111-4111-8111-111111111111", interactionControls: { agents: [{
    agentId: "agent-1", jobId: "job-1", jobVersion: 1, pendingInteractions: [{ interactionId: "gpt-question-1", kind: "user-input",
      summary: "작업에 사용할 색상을 확인합니다.", questions: [{ id: "color", question: "어떤 색상을 사용할까요?", isSecret: false,
        isOther: false, options: [{ label: "Blue", description: "파랑" }, { label: "Red", description: "빨강" }] }] }]
  }] } };
  const prelude = `<script>
    window.__calls=[];window.__followUps=[];window.__saved=[];window.__errors=[];
    const mode=${JSON.stringify(mode)},view=${JSON.stringify(view)},metadata=${JSON.stringify(metadata)};
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    window.openai={locale:"ko-KR",toolOutput:view,toolResponseMetadata:metadata,notifyIntrinsicHeight:()=>{},
      callTool:async(name,args)=>{window.__calls.push({name,args});
        if(name==="codex_interaction_respond")throw new Error("Direct Codex response is forbidden in the prototype");
        if(name==="probe_question_submit"){
          if(mode==="expired")throw new Error("질문의 유효 기간이 지났습니다.");
          window.__saved.push(args.response);return {structuredContent:{responseRef:"response-fixture-1"}};
        }
        return {structuredContent:view,_meta:metadata};
      },
      sendFollowUpMessage:async message=>{window.__followUps.push(message);if(mode==="retry"&&window.__followUps.length===1)throw new Error("답변은 저장되었지만 GPT에 전달하지 못했습니다.");}
    };
  </script>`;
  return prototypeHtml.replace("</head>", `${prelude}</head>`);
}
async function cli(...args: string[]): Promise<string> {
  return (await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
const server = createServer((request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html(request.url?.slice(1) || "normal")); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const results: Array<Record<string, unknown>> = [];
try {
  await cli("open", `http://127.0.0.1:${port}/normal`);
  for (const mode of ["normal", "retry", "expired"]) {
    if (mode !== "normal") await cli("goto", `http://127.0.0.1:${port}/${mode}`);
    writeFileSync(path.join(artifacts, `${mode}.snapshot.txt`), await cli("snapshot"));
    await cli("run-code", `async page=>{await page.getByLabel("어떤 색상을 사용할까요?").selectOption("0");await page.getByRole("button",{name:"답변 보내기",exact:true}).click()}`);
    if (mode === "retry") {
      writeFileSync(path.join(artifacts, "retry-failure.snapshot.txt"), await cli("snapshot"));
      const before = JSON.parse(await cli("run-code", `async page=>page.evaluate(()=>({saved:window.__saved.length,followUps:window.__followUps.length}))`));
      assert.deepEqual(before, { saved: 1, followUps: 1 });
      await cli("run-code", `async page=>page.getByRole("button",{name:"GPT에 답변 전달 재시도",exact:true}).click()`);
    }
    const result = JSON.parse(await cli("run-code", `async page=>page.evaluate(()=>({calls:window.__calls,saved:window.__saved,followUps:window.__followUps,errors:window.__errors}))`));
    assert.deepEqual(result.errors, []);
    assert.equal(result.calls.filter((call: { name: string }) => call.name === "codex_interaction_respond").length, 0);
    assert.equal(result.calls.filter((call: { name: string }) => call.name === "probe_question_submit").length, 1);
    assert.equal(result.saved.length, mode === "expired" ? 0 : 1);
    assert.equal(result.followUps.length, mode === "expired" ? 0 : mode === "retry" ? 2 : 1);
    if (mode !== "expired") {
      assert.deepEqual(result.saved[0], { answers: { color: ["Blue"] } });
      assert.equal(result.followUps[0].prompt, "User answer available. responseRef=response-fixture-1");
    }
    if (mode === "normal") await cli("run-code", `async page=>page.screenshot({path:${JSON.stringify(path.join(artifacts, "submitted.png"))}})`);
    results.push({ mode, passed: true, saved: result.saved.length, followUpAttempts: result.followUps.length, directCodexResponses: 0 });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({ scope: "Real Chromium and existing card renderer; prototype submit handler and simulated ChatGPT host.", results }, null, 2));
  console.log("GPT question card prototype: 3 browser scenarios passed.");
} finally {
  try { await cli("close"); } finally { server.close(); }
}
