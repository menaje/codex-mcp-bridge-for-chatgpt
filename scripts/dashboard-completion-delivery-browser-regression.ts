import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

type Scenario = "accepted" | "rejected" | "uncertain";

const artifacts = path.resolve("output/playwright/dashboard-completion-delivery-regression");
mkdirSync(artifacts, { recursive: true });
const session = `dashboard-completion-delivery-${process.pid}`;
const execute = promisify(execFile);

function cardHtml(): string {
  const fixture = dashboardView("structural");
  const prelude = `<script>(()=>{
    const fixture=${JSON.stringify(fixture)};
    let sequence=0;
    let queued=[{outboxId:71,eventId:"completion-fixture-71"}];
    window.__toolCalls=[];
    window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason)));
    function view(){return {...fixture,generatedAt:new Date(Date.now()+(++sequence)).toISOString(),scope:"conversation",filter:{mode:"conversation",conversationAvailable:true,conversationHasWork:true},completionDelivery:{route:"dashboard",events:queued}}}
    function completion(action,args){
      const events=queued.filter(event=>args.outboxIds.includes(event.outboxId));
      if(action!=="completion-claim")queued=[];
      return {structuredContent:{kind:"completion-delivery",action,state:action==="completion-claim"?"claimed":action==="completion-delivered"?"delivered":action==="completion-release"?"released":"uncertain",events}};
    }
    window.openai={
      locale:"ko-KR",
      notifyIntrinsicHeight:()=>{},
      toolResponseMetadata:{"codex/dashboardOpen@1":{automatic:true,scope:"conversation",presentationToken:"completion-browser-proof"}},
      callTool:async(name,args)=>{
        window.__toolCalls.push({name,args});
        if(name==="codex_ui_problem")return completion(args.action,args);
        if(name==="codex_ui_read")return {structuredContent:view()};
        throw new Error("Unexpected tool "+name);
      }
    };
  })();</script>`;
  return DASHBOARD_CARD_HTML.replace("</head>", `${prelude}</head>`);
}

function hostHtml(scenario: Scenario): string {
  const encodedCard = Buffer.from(cardHtml(), "utf8").toString("base64");
  return `<!doctype html><html><body><script>
    window.__hostMessages=[];
    const scenario=${JSON.stringify(scenario)};
    window.addEventListener("message",event=>{
      const message=event.data;
      if(!message||message.jsonrpc!=="2.0")return;
      window.__hostMessages.push(message);
      if(message.method==="ui/initialize"){
        event.source.postMessage({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}}},"*");
        return;
      }
      if(message.method==="ui/message"){
        const result=scenario==="accepted"?{}:scenario==="rejected"?{isError:true}:null;
        event.source.postMessage({jsonrpc:"2.0",id:message.id,result},"*");
      }
    });
    const frame=document.createElement("iframe");
    frame.id="card";
    frame.style.width="900px";
    frame.style.height="900px";
    frame.srcdoc=atob(${JSON.stringify(encodedCard)});
    document.body.appendChild(frame);
  </script></body></html>`;
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
  const candidate = new URL(request.url || "/", "http://localhost").searchParams.get("scenario");
  const scenario: Scenario = candidate === "rejected" || candidate === "uncertain" ? candidate : "accepted";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(hostHtml(scenario));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const expectedActions: Record<Scenario, string[]> = {
  accepted: ["completion-claim", "completion-delivered"],
  rejected: ["completion-claim", "completion-release"],
  uncertain: ["completion-claim", "completion-uncertain"]
};
const reports: unknown[] = [];

try {
  await cli("open", `${origin}/?scenario=accepted`);
  for (const scenario of Object.keys(expectedActions) as Scenario[]) {
    await cli("goto", `${origin}/?scenario=${scenario}`);
    const result = JSON.parse(await cli("run-code", `async page=>{
      const frame=page.frames().find(candidate=>candidate!==page.mainFrame());
      if(!frame)throw new Error("Dashboard frame is missing");
      await frame.locator("main.card").waitFor();
      await page.waitForTimeout(1400);
      return {
        hostMessages:await page.evaluate(()=>window.__hostMessages),
        toolCalls:await frame.evaluate(()=>window.__toolCalls),
        errors:await frame.evaluate(()=>window.__errors),
        bridge:await frame.evaluate(()=>document.documentElement.dataset.mcpApps)
      };
    }`));
    assert.equal(result.bridge, "initialized", `${scenario}: standard bridge did not initialize`);
    assert.deepEqual(result.errors, [], `${scenario}: card emitted a browser error`);
    const messages = result.hostMessages.filter((message: { method?: string }) => message.method === "ui/message");
    assert.equal(messages.length, 1, `${scenario}: completion prompt was not sent exactly once`);
    assert.equal(messages[0].params.role, "user");
    assert.match(messages[0].params.content[0].text, /completion-fixture-71/);
    const actions = result.toolCalls
      .filter((call: { name: string }) => call.name === "codex_ui_problem")
      .map((call: { args: { action: string } }) => call.args.action);
    assert.deepEqual(actions, expectedActions[scenario], `${scenario}: outbox state transition is wrong`);
    const claims = result.toolCalls.filter((call: { args: { action?: string; presentationToken?: string; widgetInstanceId?: string } }) =>
      call.args.action === "completion-claim"
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].args.presentationToken, "completion-browser-proof");
    assert.match(claims[0].args.widgetInstanceId, /^[0-9a-f-]{36}$/i);
    await cli("run-code", `async page=>page.screenshot({path:${JSON.stringify(artifacts)}+"/${scenario}.png"})`);
    reports.push({ scenario, actions, standardMessageCount: messages.length });
  }
  writeFileSync(path.join(artifacts, "results.json"), `${JSON.stringify(reports, null, 2)}\n`);
  console.log("Dashboard completion delivery passes standard ui/message success, rejection, and uncertain-response outbox transitions.");
} finally {
  try { await cli("close"); } finally { server.close(); }
}
