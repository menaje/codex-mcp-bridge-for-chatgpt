import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { USER_QUESTION_META } from "../src/questionTools.js";
const builtRenderer = process.argv.includes("--built");
const legacyRenderer = process.argv.includes("--legacy");
const renderer = await import((builtRenderer ? "../dist/" : "../src/") + (legacyRenderer ? "activityCard.js" : "questionCard.js"));
const CARD_HTML = legacyRenderer ? renderer.ACTIVITY_CARD_HTML : renderer.QUESTION_CARD_HTML;

// Production MCP handlers, SQLite and renderer. Only the ChatGPT host is simulated.
const root = await mkdtemp(path.join(tmpdir(), "question-card-browser-"));
const artifacts = path.resolve("output/playwright/question-card-regression" + (builtRenderer ? "-built" : "") + (legacyRenderer ? "-legacy" : ""));
await mkdir(artifacts, { recursive: true });
const store = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
const jobs = new CodexJobRegistry({ stateStore: store });
let codexCalls = 0;
const server = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; },
  async callTool() { codexCalls++; throw new Error("No Codex execution expected"); },
  async respondToInteraction() { codexCalls++; throw new Error("No direct Codex answer expected"); },
  async close() {}
}, new SessionRegistry({ stateStore: store }), jobs, {
  async getCatalog() { return { source: "codex-cli", fetchedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
    fingerprint: "a".repeat(64), cached: true, stale: false, validation: "valid", models: [] }; }
}, new UserSettingsStore(config, { stateStore: store }));
const client = new Client({ name: "question-browser", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(a), server.connect(b)]);
const meta = { "openai/session": "isolated-question-browser" };
const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args, _meta: meta }) as Promise<any>;
const records = new Map<string, { bootstrap: any; calls: string[]; followUps: number }>();
for (const mode of ["standard", "compatibility", "metadata-missing", "denied", "uncertain", "expired", ...(!legacyRenderer ? ["read-retry", "storage-denied", "host-private-state"] : [])]) {
  const bootstrap = await call("codex_ask_user", { requestId: randomUUID(), title: "화면 색상 선택", questions: [{
    id: "color", header: "색상", question: "어떤 색상을 사용할까요?", isOther: true,
    options: [{ label: "파랑", description: "기본 색상" }, { label: "빨강", description: "강조 색상" }]
  }] });
  assert.notEqual(bootstrap.isError, true, JSON.stringify(bootstrap));
  records.set(mode, { bootstrap, calls: [], followUps: 0 });
}
const http = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1"), mode = url.searchParams.get("mode") || "standard", record = records.get(mode)!;
    if (request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (url.pathname === "/call") {
        record.calls.push(input.name + (input.name === "codex_question_action" ? ":" + input.arguments.operation.kind : ""));
        if (mode === "read-retry" && input.name === "codex_ui_read" && record.calls.length === 1) {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: "Transient read failure" }] })); return;
        }
        const result = mode === "metadata-missing"
          ? await client.callTool({ name: input.name, arguments: input.arguments }) as any
          : await call(input.name, input.arguments);
        if (mode === "expired" && (input.name === "codex_question_card" || input.name === "codex_ui_read") && result._meta?.[USER_QUESTION_META]) result._meta[USER_QUESTION_META].expiresAt = Date.now() - 1;
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result)); return;
      }
      record.followUps++;
      assert.ok(Array.isArray(input.content), "Standard ui/message uses a content array");
      const result = mode === "denied" && record.followUps === 1 ? { isError: true } : { accepted: true };
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result)); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/card") {
      const prelude = `<script>window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
        ${["storage-denied", "host-private-state"].includes(mode) ? `Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Storage blocked','SecurityError')}});` : ""}
        ${mode === "host-private-state" ? `window.openai={widgetState:JSON.parse(parent.sessionStorage.getItem('host-private-state')||'null'),setWidgetState(state){this.widgetState=state;parent.sessionStorage.setItem('host-private-state',JSON.stringify(state))}};` : ""}
        ${mode === "compatibility" ? `window.openai={locale:"ko-KR",toolOutput:${JSON.stringify(record.bootstrap.structuredContent)},toolResponseMetadata:${JSON.stringify(record.bootstrap._meta)},callTool:async(name,args)=>(await fetch('/call?mode=${mode}',{method:'POST',body:JSON.stringify({name,arguments:args})})).json(),sendFollowUpMessage:async({prompt})=>(await fetch('/followup?mode=${mode}',{method:'POST',body:JSON.stringify({role:'user',content:[{type:'text',text:prompt}]})})).json(),notifyIntrinsicHeight:()=>{}};` : ""}
      </script>`;
      response.end(CARD_HTML.replace("</head>", prelude + "</head>")); return;
    }
    response.end(`<html><head><meta charset="utf-8"></head><body style="margin:0"><iframe id="card" style="border:0;width:100%;height:650px" src="/card?mode=${mode}"></iframe><script>
      const frame=document.getElementById('card');
      window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow)return;const value=event.data;if(!value||value.jsonrpc!=='2.0')return;
        const reply=result=>frame.contentWindow.postMessage({jsonrpc:'2.0',id:value.id,result},'*');
        if(value.method==='ui/initialize'){reply(${mode === "compatibility" ? "{}" : "{protocolVersion:'2026-01-26',hostContext:{locale:'ko-KR'}}"});return}
        if(value.method==='ui/notifications/initialized'){frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(record.bootstrap)}},'*');return}
        if(value.method==='tools/call'){reply(await(await fetch('/call?mode=${mode}',{method:'POST',body:JSON.stringify(value.params)})).json());return}
        if(value.method==='ui/message'){${mode === "uncertain" ? "frame.contentWindow.postMessage({jsonrpc:'2.0',id:value.id,error:{code:-32603,message:'Uncertain host delivery'}},'*');return;" : `reply(await(await fetch('/followup?mode=${mode}',{method:'POST',body:JSON.stringify(value.params)})).json());return;`}}
      });
    </script></body></html>`);
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const port = (http.address() as { port: number }).port;
const exec = promisify(execFile), session = `question-card-${process.pid}`;
const cli = async (...args: string[]) => {
  const output = (await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (/Error:|TimeoutError:/.test(output)) throw new Error(output);
  return output;
};
const results: unknown[] = [];
try {
  await cli("open", `http://127.0.0.1:${port}/?mode=standard`);
  for (const [mode, record] of records) {
    if (mode !== "standard") await cli("goto", `http://127.0.0.1:${port}/?mode=${mode}`);
    await writeFile(path.join(artifacts, `${mode}-before.txt`), await cli("snapshot"));
    if (mode === "read-retry") {
      await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.locator('#message.error').waitFor();await frame.getByRole('button',{name:/새로고침/}).click();await frame.getByLabel('어떤 색상을 사용할까요?').waitFor()}`);
    }
    if (mode === "expired") {
      await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.getByText('질문이 만료되었거나 사용할 수 없습니다.').waitFor();if(await frame.getByRole('button',{name:'GPT에 답변 보내기'}).count())throw new Error('Expired form is still editable')}`);
    } else {
      if (mode === "standard") {
        await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('0');await frame.getByRole('button',{name:/새로고침/}).click();await frame.getByLabel('어떤 색상을 사용할까요?').waitFor();if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='0')throw new Error('Refresh lost the selected answer');if(${!legacyRenderer}){await page.frames().find(f=>f.url().includes('/card')).evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await frame.getByRole('button',{name:/새로고침/}).waitFor();await frame.getByLabel('어떤 색상을 사용할까요?').waitFor();if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='0')throw new Error('Restoration lost the selected answer')}await page.evaluate(()=>{const frame=document.getElementById('card');frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{locale:'en-US'}},'*')});await frame.getByRole('button',{name:'Send to GPT',exact:true}).waitFor();if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='0')throw new Error('Locale change lost the selected answer');await frame.getByRole('heading',{name:'화면 색상 선택',exact:true}).waitFor();await page.evaluate(()=>{const frame=document.getElementById('card');frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{locale:'ko-KR'}},'*')});await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor()}`);
        await cli("screenshot", "--filename", path.join(artifacts, "question.png"));
        if (!legacyRenderer) {
          // Changing the actual ChatGPT language reloads the document, unlike
          // a host-context notification. Exercise that distinct failure mode.
          await cli("run-code", `async page=>{
            const frame=page.frameLocator('#card');await page.reload();
            await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
            if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='0')throw new Error('Document reload lost the selected answer');
            await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('other');
            await frame.locator('input:not([hidden])').fill('locale-draft-0910');
            await page.reload();await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
            if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='other'||await frame.locator('input:not([hidden])').inputValue()!=='locale-draft-0910')throw new Error('Document reload lost the free-text draft');
            await page.goto(${JSON.stringify(`http://127.0.0.1:${port}/?mode=compatibility`)});
            await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
            if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='')throw new Error('A different question inherited the draft');
            await page.goto(${JSON.stringify(`http://127.0.0.1:${port}/?mode=standard`)});
            await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
            if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='other'||await frame.locator('input:not([hidden])').inputValue()!=='locale-draft-0910')throw new Error('Re-entry lost the question draft');
            for(const defect of ['scope','revision','expiry']){
              await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('0');
              await page.frames().find(f=>f.url().includes('/card')).evaluate(defect=>{
                const key=Object.keys(sessionStorage).find(key=>key.startsWith('codex.question.draft.v1:'));
                if(!key)throw new Error('Draft was not saved');const draft=JSON.parse(sessionStorage.getItem(key));
                if(defect==='scope')draft.scopeId='different-scope';
                if(defect==='revision')draft.revision+=1;
                if(defect==='expiry')draft.expiresAt=Date.now()-1;
                sessionStorage.setItem(key,JSON.stringify(draft));
              },defect);
              await page.reload();await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
              if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='')throw new Error('Restored invalid draft: '+defect);
            }
          }`);
        }
      }
      if (mode === "host-private-state") {
        // ChatGPT may recreate an isolated iframe without its browser storage.
        // The host, not the iframe, owns this widget-scoped private snapshot.
        await cli("run-code", `async page=>{
          const frame=page.frameLocator('#card');
          await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('other');
          await frame.locator('input:not([hidden])').fill('private-draft-0910');
          await page.reload();await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
          if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='other'||await frame.locator('input:not([hidden])').inputValue()!=='private-draft-0910')throw new Error('Host re-entry lost the private draft');
          const state=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('host-private-state')));
          if(state.modelContent!==''||state.imageIds.length!==0||!state.privateContent.questionDraft)throw new Error('Draft leaked into model-visible widget state');
          for(const defect of ['question','scope','revision','expiry']){
            await page.evaluate(defect=>{const state=JSON.parse(sessionStorage.getItem('host-private-state'));const draft=state.privateContent.questionDraft;
              if(defect==='question')draft.questionId='different-question';if(defect==='scope')draft.scopeId='different-scope';
              if(defect==='revision')draft.revision+=1;if(defect==='expiry')draft.expiresAt=Date.now()-1;
              sessionStorage.setItem('host-private-state',JSON.stringify(state));},defect);
            await page.reload();await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).waitFor();
            if(await frame.getByLabel('어떤 색상을 사용할까요?').inputValue()!=='')throw new Error('Restored invalid host draft: '+defect);
            await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('0');
          }
        }`);
      }
      await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.getByLabel('어떤 색상을 사용할까요?').selectOption('0');await frame.getByRole('button',{name:'GPT에 답변 보내기',exact:true}).click();await frame.getByText(${JSON.stringify(mode === "uncertain" ? "응답은 저장됐습니다. 이 대화에서 GPT에게 계속 진행을 요청해 주세요." : mode === "denied" ? "답변을 저장했습니다." : "GPT에 후속 처리를 요청했습니다.")},{exact:true}).waitFor()}`);
      if (mode === "denied") {
        await cli("snapshot");
        await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.getByRole('button',{name:'GPT에 후속 처리 요청',exact:true}).click();await frame.getByText('GPT에 후속 처리를 요청했습니다.',{exact:true}).waitFor()}`);
      }
      if (mode === "host-private-state") await cli("run-code", `async page=>{const state=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('host-private-state')));if(state.privateContent.questionDraft)throw new Error('Submitted draft remains in host widget state')}`);
      const { questionId, revision, presentationToken } = record.bootstrap._meta[USER_QUESTION_META];
      const refreshed = await call("codex_ui_read", { view: "question", questionId, revision, presentationToken });
      const responseRef = refreshed._meta[USER_QUESTION_META].responseRef;
      const read = await call("codex_user_answer", { responseRef });
      assert.deepEqual(read.structuredContent.responses[0].answers, [{ questionId: "color", values: ["파랑"] }]);
      if (mode === "standard") {
        await cli("snapshot");
        await cli("run-code", `async page=>{const frame=page.frameLocator('#card');await frame.getByRole('button',{name:/새로고침/}).click();await frame.getByText('GPT가 답변을 확인했습니다.',{exact:true}).waitFor()}`);
        if (!legacyRenderer) await cli("run-code", `async page=>{const frame=page.frames().find(f=>f.url().includes('/card'));if(await frame.evaluate(()=>Object.keys(sessionStorage).some(key=>key.startsWith('codex.question.draft.v1:'))))throw new Error('Submitted draft remains in browser storage')}`);
      }
    }
    await cli("run-code", "async page=>{const frame=page.frames().find(f=>f.url().includes('/card'));const errors=await frame.evaluate(()=>window.__errors);if(errors.length)throw new Error(JSON.stringify(errors))}");
    assert.equal(record.calls.filter(name => name === (legacyRenderer ? "codex_question_submit" : "codex_question_action:submit")).length, mode === "expired" ? 0 : 1);
    assert.equal(record.followUps, mode === "expired" || mode === "uncertain" ? 0 : mode === "denied" ? 2 : 1);
    assert.ok(!record.calls.some(name => name.startsWith("codex_activity") || name === "codex_interaction_respond"));
    results.push({ mode, calls: record.calls, followUps: record.followUps, passed: true });
    await writeFile(path.join(artifacts, `${mode}-after.txt`), await cli("snapshot"));
    if (mode === "standard") await cli("screenshot", "--filename", path.join(artifacts, "answered.png"));
  }
  assert.equal(codexCalls, 0);
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ builtRenderer, legacyRenderer, codexCalls, results }, null, 2));
  process.stdout.write(JSON.stringify({ passed: results.length, builtRenderer, codexCalls, artifacts }) + "\n");
} catch (error) {
  await writeFile(path.join(artifacts, "failure-snapshot.txt"), await cli("snapshot").catch(String));
  await writeFile(path.join(artifacts, "failure-errors.txt"), await cli("run-code", "async page=>{for(const frame of page.frames()){if(frame.url().includes('/card'))console.log(await frame.evaluate(()=>({errors:window.__errors,text:document.body.innerText,bridge:document.documentElement.dataset.mcpApps})))}}").catch(String));
  await writeFile(path.join(artifacts, "failure-calls.json"), JSON.stringify([...records].map(([mode, record]) => ({mode, calls:record.calls, followUps:record.followUps})), null, 2));
  throw error;
} finally {
  await cli("close").catch(() => {}); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true });
}
