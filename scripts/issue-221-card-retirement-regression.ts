import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { currentUiResourceUri, htmlForUiResource } from "../src/uiResources.js";
import { dashboardView } from "./card-browser-fixtures.js";

// Real Chromium with a synthetic MCP Apps host. This is not actual ChatGPT
// acceptance. v3 is the exact packaged script from baseline 4fc1619b.
const directory = path.resolve("output/playwright/issue-221-card-retirement");
mkdirSync(directory, { recursive: true });
const oldScript = readFileSync("test/fixtures/issue221-dashboard-v3.js.txt", "utf8");
const session = `issue-221-${process.pid}`;
const execute = promisify(execFile);
const jobId = "22100000-0000-4000-8000-000000000001";
const presentationRef = "a".repeat(64), receipt = "completion-" + "c".repeat(64);
const view = { ...dashboardView("structural"), scope: "conversation", historyIncluded: false,
  statusFilter: "all", statusRows: [], statusRowsComplete: true,
  filter: { mode: "conversation", conversationAvailable: true, conversationHasWork: true } };
function cardHtml(old: boolean): string {
  let html = htmlForUiResource("dashboard", currentUiResourceUri("dashboard"), DASHBOARD_CARD_HTML);
  if (old) html = html.replace(/<script>[\s\S]*?<\/script>/, () => `<script>${oldScript}</script>`);
  // Scale only the fixture timers, preserving the production state machine.
  html = html.replaceAll("TOOL_CALL_TIMEOUT_MS=15000", "TOOL_CALL_TIMEOUT_MS=300")
    .replaceAll("COMPLETION_WAIT_MS=8000", "COMPLETION_WAIT_MS=100")
    .replaceAll("COMPLETION_MESSAGE_TIMEOUT_MS=12000", "COMPLETION_MESSAGE_TIMEOUT_MS=250");
  return html.replace("</head>", `<script>window.__errors=[];window.addEventListener("error",e=>window.__errors.push(String(e.message)));window.addEventListener("unhandledrejection",e=>window.__errors.push(String(e.reason)));</script></head>`);
}
function hostHtml(scenario: string): string {
  const old = scenario.startsWith("old-");
  return `<!doctype html><html><body><script>(()=>{
    const scenario=${JSON.stringify(scenario)},old=${old},base=${JSON.stringify(view)};
    window.__events=[];window.__messages=0;window.__ready=0;window.__retired=!old||scenario==="old-wait-blocked";window.__teardown=0;
    const frames=[];
    const reply=(frame,id,result)=>frame.contentWindow.postMessage({jsonrpc:"2.0",id,result},"*");
    const send=(frame,method,params,id)=>frame.contentWindow.postMessage({jsonrpc:"2.0",method,params,...(id?{id}:{})},"*");
    const refused={isError:true,content:[{type:"text",text:"CARD_DELIVERY_RETIRED: Close old cards and refresh discovery."}]};
    for(let index=0;index<${scenario === "current-duplicates" ? 2 : 1};index++){
      const frame=document.createElement("iframe");frame.src="/card?old="+old;frames.push(frame);document.body.appendChild(frame);
    }
    window.addEventListener("message",event=>{
      const frame=frames.find(f=>f.contentWindow===event.source),message=event.data;if(!frame||message?.jsonrpc!=="2.0")return;
      if(message.method==="ui/initialize"){
        const legacy=old||scenario==="current-old-metadata";
        send(frame,"ui/notifications/tool-input",{arguments:legacy?{scope:"conversation",jobId:${JSON.stringify(jobId)},presentationRef:${JSON.stringify(presentationRef)}}:{scope:"conversation"}});
        send(frame,"ui/notifications/tool-result",{structuredContent:{kind:"dashboard"},_meta:legacy?{"codex/dashboardOpen@1":{scope:"conversation",automatic:true,presentationRef:${JSON.stringify(presentationRef)},completionDeliveryRoute:"live-card"}}:{"codex/dashboardOpen@2":{scope:"conversation",automatic:false}}});
        reply(frame,message.id,{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}});window.__ready++;return;
      }
      if(message.method==="tools/call"){
        const name=message.params.name,args=message.params.arguments||{};
        window.__events.push({name,operation:args.operation,view:args.view,scope:args.scope});
        if(name==="codex_ui_read"){
          const all=args.scope==="all";reply(frame,message.id,{structuredContent:{...base,generatedAt:new Date().toISOString(),scope:all?"bridge-wide":"conversation",filter:{...base.filter,mode:all?"all":"conversation"}}});return;
        }
        if(window.__retired){reply(frame,message.id,refused);return}
        if(name==="codex_status"){
          reply(frame,message.id,{structuredContent:{kind:"job",items:[{type:"job",id:${JSON.stringify(jobId)},terminal:true,state:"completed",answer:"Previously received original result"}]}});
          // The old iframe now owns result text. The deployed server has retired.
          if(scenario==="old-result-inflight")window.__retired=true;return;
        }
        if(name==="codex_ui_completion"){
          if(args.operation==="wait")reply(frame,message.id,{structuredContent:{kind:"job-completion-delivery",state:"claimed",receipt:${JSON.stringify(receipt)},attempt:1,deliveryState:"leased"}});
          else if(args.operation==="rejected"){
            reply(frame,message.id,{structuredContent:{kind:"job-completion-delivery",state:"waiting",deliveryState:"host-rejected"}});window.__retired=true;
          }else reply(frame,message.id,refused);return;
        }
      }
      if(message.method==="ui/message"){
        window.__messages++;window.__events.push({name:"ui/message"});
        if(scenario==="old-retry-blocked")frame.contentWindow.postMessage({jsonrpc:"2.0",id:message.id,error:{code:-32000,message:"model response still active"}},"*");
        else reply(frame,message.id,{});return;
      }
      if(message.id===9000)window.__teardown++;
    });
    window.teardown=()=>frames.forEach(f=>send(f,"ui/resource-teardown",{},9000));
  })();</script></body></html>`;
}
async function cli(...args: string[]): Promise<string> {
  const result = await execute("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://fixture.invalid");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(url.pathname === "/card" ? cardHtml(url.searchParams.get("old") === "true") : hostHtml(url.searchParams.get("scenario") || "current"));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const scenarios = ["current", "current-old-metadata", "current-duplicates", "old-wait-blocked", "old-result-inflight", "old-retry-blocked"];
const results: unknown[] = [];
try {
  for (const [index, scenario] of scenarios.entries()) {
    await cli(index ? "goto" : "open", `http://127.0.0.1:${port}/?scenario=${scenario}`);
    writeFileSync(path.join(directory, `${scenario}.snapshot.txt`), await cli("snapshot"));
    const raw = await cli("run-code", `async page=>{
      await page.waitForFunction(()=>window.__ready>0&&window.__events.some(e=>e.name==="codex_ui_read"));
      await page.waitForTimeout(1300);
      const frames=page.frames().filter(f=>f.url().includes("/card?"));
      if(${JSON.stringify(scenario)}.startsWith("current")){
        for(const frame of frames){await frame.locator("#refresh").click();await frame.locator("#scope-all").click()}
        await page.waitForTimeout(250);
      }
      const before=await page.evaluate(()=>({events:window.__events.slice(),messages:window.__messages,retired:window.__retired}));
      const datasets=await Promise.all(frames.map(f=>f.evaluate(()=>({...document.documentElement.dataset}))));
      const errors=(await Promise.all(frames.map(f=>f.evaluate(()=>window.__errors)))).flat();
      await page.evaluate(()=>window.teardown());await page.waitForTimeout(2500);
      return {...before,datasets,errors,afterMessages:await page.evaluate(()=>window.__messages),teardown:await page.evaluate(()=>window.__teardown)};
    }`);
    const observed = JSON.parse(raw);
    writeFileSync(path.join(directory, `${scenario}.observed.json`), JSON.stringify(observed, null, 2));
    assert.deepEqual(observed.errors, [], scenario);
    assert.equal(observed.afterMessages, observed.messages, `${scenario}: teardown stops instance`);
    assert.ok(observed.teardown > 0, scenario);
    if (scenario.startsWith("current")) {
      assert.equal(observed.messages, 0, scenario);
      assert.ok(observed.events.some((e: any) => e.name === "codex_ui_read" && e.scope === "all"), scenario);
      assert.ok(observed.events.every((e: any) => !["codex_ui_completion", "codex_status", "ui/message"].includes(e.name)), scenario);
      assert.ok(observed.datasets.every((d: any) => d.cardResourceUri === currentUiResourceUri("dashboard")), scenario);
    } else if (scenario === "old-wait-blocked") assert.equal(observed.messages, 0, scenario);
    else assert.equal(observed.messages, 1, `${scenario}: old in-memory host capability requires explicit teardown`);
    results.push({ scenario, ...observed, passed: true });
  }
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ evidence: "synthetic-host-real-browser", baseline: "4fc1619b07a50c4454daa6c079cbd495ba7d02b4",
    oldScriptSha256: createHash("sha256").update(oldScript).digest("hex"), scenarios: results }, null, 2));
  console.log(`Issue #221 card retirement: ${results.length}/${scenarios.length} scenarios passed; old in-memory sender requires teardown.`);
} finally { await cli("close").catch(() => {}); server.close(); }
