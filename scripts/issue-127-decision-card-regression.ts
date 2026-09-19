import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DECISION_CARD_HTML, DECISION_CARD_METADATA_KEY } from "../src/decisionCard.js";
import { prepareDecisionCardContent } from "../src/decisionCardContent.js";

const artifacts = path.resolve("output/playwright/issue-127-decision-card");
mkdirSync(artifacts, { recursive: true });
rmSync(path.join(artifacts, "failure.txt"), { force: true });
const session = `issue-127-decision-${process.pid}`;
const execute = promisify(execFile);
const cardId = "12700000-0000-4000-8000-000000000001";
const presentationRef = "d".repeat(64);
const receipt = `decision_${"e".repeat(64)}`;
const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const rawLayouts = {
  prose: `
    <article><h2>Why this choice matters</h2>
      <p>The reversible window lasts seven days. No option is preselected.</p>
      <p><strong>Unknown:</strong> peak traffic during the first hour.</p>
    </article>`,
  table: `
    <article style="display:grid;gap:12px;background:u\\72l(http://127.0.0.1/leak-escaped.css)">
      <h2>Release plan</h2>
      <script>fetch('/leak-script')</script>
      <iframe src="/leak-frame"></iframe>
      <img src="/leak-image" onerror="fetch('/leak-error')" alt="blocked remote image">
      <a href="https://example.invalid/escape">external navigation</a>
      <svg viewBox="0 0 20 20" aria-label="Escaped external SVG paint">
        <rect width="20" height="20" fill="u\\72l(http://127.0.0.1/leak-paint.svg)"></rect>
      </svg>
      <table><thead><tr><th>Plan</th><th>Downtime</th><th>Rollback</th></tr></thead>
        <tbody><tr><td>Staged transition</td><td>Low</td><td>Checkpointed</td></tr>
        <tr><td>Direct migration</td><td>Medium</td><td>Full restore</td></tr></tbody></table>
      <label>Migration plan
        <select name="plan" required>
          <option value="staged">Staged transition — reversible checkpoints</option>
          <option value="direct">Direct migration — shortest transition</option>
        </select>
      </label>
      <label>Maximum transition
        <input name="weeks" type="range" min="1" max="12" step="1" value="4" data-decision-unit="weeks">
      </label>
      <output data-decision-output-for="weeks"></output>
      <label><input name="compatibility" type="checkbox"> Preserve the existing API</label>
      <label>Plan conditions <textarea name="conditions" maxlength="300"></textarea></label>
    </article>`,
  visual: `
    <figure><figcaption>Relative migration risk</figcaption>
      <svg viewBox="0 0 240 72" role="img" aria-label="Staged risk 30, direct risk 70">
        <rect x="0" y="8" width="72" height="20" fill="#16875a"></rect>
        <text x="78" y="23">Staged 30</text>
        <rect x="0" y="42" width="168" height="20" fill="#c76b28"></rect>
        <text x="174" y="57">Direct 70</text>
      </svg>
      <p><strong>Evidence confidence</strong><br>
        <img src="${onePixelPng}" width="80" height="8" style="background-color:#3b82f6;border-radius:4px" alt="Embedded raster marker: medium confidence">
      </p>
    </figure>
    <fieldset><legend>Risk posture</legend>
      <label><input type="radio" name="risk" value="lower" required> Lower risk — staged transition</label>
      <label><input type="radio" name="risk" value="faster"> Faster result — direct migration</label>
    </fieldset>`
} as const;

type LayoutName = keyof typeof rawLayouts;
const preparationMetrics: Array<Record<string, number | string>> = [];
const preparedLayouts = Object.fromEntries(Object.entries(rawLayouts).map(([name, html]) => {
  const startedAt = process.hrtime.bigint();
  const prepared = prepareDecisionCardContent(html);
  preparationMetrics.push({
    layout: name,
    rawBytes: Buffer.byteLength(html, "utf8"),
    sanitizedBytes: Buffer.byteLength(prepared.html, "utf8"),
    fields: prepared.fields.length,
    prepareMicroseconds: Number((process.hrtime.bigint() - startedAt) / 1_000n)
  });
  return [name, {
    kind: "codex/decisionCard",
    version: 1,
    card: {
      cardId,
      cardVersion: 1,
      title: name === "prose" ? "Understand the rollout" : name === "table" ? "Choose a release plan" : "Choose a risk posture",
      html: prepared.html,
      contentDigest: prepared.contentDigest,
      fields: prepared.fields,
      policy: prepared.policy,
      presentationRef,
      expiresAt: "2026-09-20T00:00:00.000Z"
    },
    latestSubmission: null,
    compatibilityScopeId: null
  }];
})) as Record<LayoutName, any>;

assert(!preparedLayouts.table.card.html.includes("script"));
assert(!preparedLayouts.table.card.html.includes("iframe"));
assert(!preparedLayouts.table.card.html.includes("/leak"));
assert(!preparedLayouts.table.card.html.includes("href="));
assert(preparedLayouts.visual.card.html.includes("<svg"));
assert(preparedLayouts.visual.card.html.includes("data:image/png"));

const scenarioDefinitions = [
  { name: "prose-explanation", layout: "prose", frames: 1 },
  { name: "table-accept-offered", layout: "table", frames: 1 },
  { name: "visual-defer", layout: "visual", frames: 1 },
  { name: "required-field", layout: "visual", frames: 1 },
  { name: "double-click", layout: "table", frames: 1 },
  { name: "duplicate-cards", layout: "table", frames: 2 },
  { name: "modified-resubmit", layout: "table", frames: 1 },
  { name: "reject-retry", layout: "table", frames: 1 },
  { name: "timeout-unknown", layout: "table", frames: 1 },
  { name: "teardown-before-send", layout: "table", frames: 1 },
  { name: "teardown-during-send", layout: "table", frames: 1 },
  { name: "stale-version", layout: "table", frames: 1 }
] as const;

function cardHtml(layout: LayoutName, frameIndex: number, scenario: string): string {
  const hydration = preparedLayouts[layout];
  const initialMetadata = scenario === "prose-explanation"
    ? null
    : { [DECISION_CARD_METADATA_KEY]: hydration };
  const prelude = `<script>(()=>{
    window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.error&&event.error.message||event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason&&event.reason.message||event.reason)));
    window.openai={
      locale:"ko-KR",
      toolResponseMetadata:${JSON.stringify(initialMetadata)},
      toolOutput:null,
      callTool:(name,args)=>window.parent.__decisionTool(${frameIndex},name,args)
    };
  })();</script>`;
  return DECISION_CARD_HTML
    .replace("TOOL_TIMEOUT=15000,INIT_TIMEOUT=5000,MESSAGE_TIMEOUT=12000", "TOOL_TIMEOUT=600,INIT_TIMEOUT=400,MESSAGE_TIMEOUT=250")
    .replace("},5000)}", "},100)}")
    .replace("</head>", `${prelude}</head>`);
}

function hostHtml(scenarioName: string): string {
  const scenario = scenarioDefinitions.find((candidate) => candidate.name === scenarioName) || scenarioDefinitions[0];
  const hydration = preparedLayouts[scenario.layout];
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{display:block;width:100%;height:1100px;border:0}</style></head><body><script>(()=>{
    const scenario=${JSON.stringify(scenario.name)},layout=${JSON.stringify(scenario.layout)},hydration=${JSON.stringify(hydration)},receipt=${JSON.stringify(receipt)};
    const frames=[];
    const state=window.__state={events:[],messages:[],submissions:[],messageCount:0,submitCalls:0,readCalls:0,claimed:false,current:null};
    const send=(frame,method,params,id)=>frame.contentWindow.postMessage({jsonrpc:"2.0",...(id===undefined?{}:{id}),method,params},"*");
    const reply=(frame,id,result,error)=>frame.contentWindow.postMessage({jsonrpc:"2.0",id,...(error?{error}:{result})},"*");
    const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
    function selectionFor(definition,raw){
      const values=raw&&Array.isArray(raw.values)?raw.values:[];
      let selected;
      if(definition.kind==="boolean")selected=[{value:values.includes("true")?"true":"false",label:values.includes("true")?"Yes":"No"}];
      else if(definition.kind==="choice"||definition.kind==="multi-choice")selected=values.map(value=>{const option=(definition.options||[]).find(candidate=>candidate.value===value);return{value,label:option?option.label:value}});
      else selected=values.map(value=>({value,label:value}));
      return{name:definition.name,label:definition.label,kind:definition.kind,values:selected,unit:definition.unit||null};
    }
    function semanticKey(args){return JSON.stringify({intent:args.intent,fields:args.fields,comment:args.comment||null})}
    function makeSubmission(args){
      const prior=state.submissions[state.submissions.length-1],sequence=state.submissions.length+1;
      return{submissionId:args.submissionId,receipt,sequence,supersedesSubmissionId:prior?prior.submissionId:null,intent:args.intent,
        selections:hydration.card.fields.map(definition=>selectionFor(definition,(args.fields||[]).find(field=>field.name===definition.name))),
        comment:args.comment||null,summary:"browser semantic decision",deliveryState:"stored",attemptCount:0,
        hostAcceptedAt:null,acceptanceUnknownAt:null,resultOfferedAt:null,confirmedAt:"2026-09-19T00:00:00.000Z",semanticKey:semanticKey(args)};
    }
    function output(operation,submission=state.current,sendValue=false){return{structuredContent:{kind:"decision-ui",operation,cardId:hydration.card.cardId,version:hydration.card.cardVersion,deliveryState:submission?submission.deliveryState:null,send:sendValue,receipt:submission?submission.receipt:null,submission:submission?clone(Object.fromEntries(Object.entries(submission).filter(([key])=>key!=="semanticKey"))):null}}}
    async function operate(frameIndex,name,args){
      if(name!=="codex_ui_decision")throw new Error("UNEXPECTED_TOOL: "+name);
      const operation=args&&args.operation;state.events.push({type:"tool",frame:frameIndex,operation,args:clone(args)});
      if(scenario==="stale-version")throw new Error("DECISION_CARD_STALE: Reopen the current card version.");
      if(operation==="read"){
        state.readCalls+=1;
        if(scenario==="table-accept-offered"&&state.current&&state.current.deliveryState==="host-accepted"){
          state.current.resultOfferedAt="2026-09-19T00:00:03.000Z";
        }
        return output(operation);
      }
      if(operation==="submit"){
        state.submitCalls+=1;
        const key=semanticKey(args),duplicate=state.submissions.find(submission=>submission.semanticKey===key);
        if(duplicate){state.current=duplicate;return output(operation,duplicate)}
        const submission=makeSubmission(args);state.submissions.push(submission);state.current=submission;state.claimed=false;return output(operation,submission);
      }
      if(!state.current||args.receipt!==state.current.receipt)throw new Error("DECISION_RESULT_UNAVAILABLE");
      if(operation==="claim"){
        const claimable=!state.claimed&&(state.current.deliveryState==="stored"||state.current.deliveryState==="host-rejected"&&args.retryRejected===true);
        if(!claimable)return output(operation,state.current,false);
        state.claimed=true;state.current.deliveryState="leased";state.current.attemptCount+=1;
        const claimedOutput=output(operation,state.current,true);
        if(scenario==="teardown-before-send"){
          send(frames[frameIndex],"ui/resource-teardown",{},8100+frameIndex);
          await new Promise(resolve=>setTimeout(resolve,30));
        }
        return claimedOutput;
      }
      if(operation==="outcome"){
        state.claimed=false;
        if(args.outcome==="accepted"){state.current.deliveryState="host-accepted";state.current.hostAcceptedAt="2026-09-19T00:00:02.000Z"}
        else if(args.outcome==="rejected")state.current.deliveryState="host-rejected";
        else if(args.outcome==="uncertain"){state.current.deliveryState="acceptance-unknown";state.current.acceptanceUnknownAt="2026-09-19T00:00:02.000Z"}
        else state.current.deliveryState="stored";
        return output(operation,state.current,false);
      }
      throw new Error("UNEXPECTED_OPERATION: "+operation);
    }
    window.__decisionTool=(frameIndex,name,args)=>operate(frameIndex,name,args);
    for(let index=0;index<${scenario.frames};index+=1){const frame=document.createElement("iframe");frame.src="/card?layout="+layout+"&index="+index+"&scenario="+scenario;frame.dataset.index=String(index);document.body.appendChild(frame);frames.push(frame)}
    if(scenario==="prose-explanation")setTimeout(()=>{for(const frame of frames){const EventCtor=frame.contentWindow.CustomEvent;frame.contentWindow.dispatchEvent(new EventCtor("openai:set_globals",{detail:{globals:{toolResponseMetadata:{${JSON.stringify(DECISION_CARD_METADATA_KEY)}:hydration}}}}))}},100);
    window.addEventListener("message",async event=>{
      const frame=frames.find(candidate=>candidate.contentWindow===event.source);if(!frame)return;
      const message=event.data;if(!message||message.jsonrpc!=="2.0")return;
      const frameIndex=Number(frame.dataset.index);
      if(message.method==="ui/initialize"&&message.id!==undefined){reply(frame,message.id,{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}});return}
      if(message.method==="tools/call"&&message.id!==undefined){try{reply(frame,message.id,await operate(frameIndex,message.params.name,message.params.arguments))}catch(error){reply(frame,message.id,undefined,{code:-32000,message:String(error&&error.message||error)})}return}
      if(message.method==="ui/message"&&message.id!==undefined){
        state.messageCount+=1;state.messages.push(clone(message.params));state.events.push({type:"message",frame:frameIndex,number:state.messageCount});
        if(scenario==="timeout-unknown")return;
        if(scenario==="teardown-during-send"){send(frame,"ui/resource-teardown",{},8200+frameIndex);return}
        if(scenario==="reject-retry"&&state.messageCount===1){reply(frame,message.id,undefined,{code:-32000,message:"model response still active"});return}
        reply(frame,message.id,{});return;
      }
    });
  })();</script></body></html>`;
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute(
    "npx",
    ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  );
  return result.stdout.trim();
}

let blockedNetworkRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/leak")) {
    blockedNetworkRequests += 1;
    response.statusCode = 500;
    response.end("unexpected generated-content request");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/card") {
    const layout = url.searchParams.get("layout") as LayoutName;
    response.end(cardHtml(
      layout in preparedLayouts ? layout : "prose",
      Number(url.searchParams.get("index") || 0),
      url.searchParams.get("scenario") || ""
    ));
  } else {
    response.end(hostHtml(url.searchParams.get("scenario") || scenarioDefinitions[0].name));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const results: Array<Record<string, unknown>> = [];

try {
  await cli("open", `http://127.0.0.1:${port}/?scenario=${scenarioDefinitions[0].name}`);
  for (const [scenarioIndex, scenario] of scenarioDefinitions.entries()) {
    const scenarioStartedAt = process.hrtime.bigint();
    if (scenarioIndex > 0) await cli("goto", `http://127.0.0.1:${port}/?scenario=${scenario.name}`);
    const screenshotPath = ["prose-explanation", "table-accept-offered", "visual-defer"].includes(scenario.name)
      ? path.join(artifacts, `${scenario.name}.png`)
      : null;
    const raw = await cli("run-code", `async page=>{
      const scenario=${JSON.stringify(scenario.name)},screenshotPath=${JSON.stringify(screenshotPath)};
      await page.setViewportSize({width:390,height:900});
      await page.waitForFunction(expected=>{
        const frames=[...document.querySelectorAll("iframe")];
        return frames.length===expected&&frames.every(frame=>frame.contentDocument&&!frame.contentDocument.getElementById("common").hidden);
      },${scenario.frames},{timeout:3000});
      const frames=page.frames().filter(frame=>frame.url().includes("/card?"));
      const tableInput=async frame=>{
        await frame.locator('[name="plan"]').selectOption("staged");
        await frame.locator('[name="weeks"]').fill("6");
        await frame.locator('[name="compatibility"]').check();
        await frame.locator('[name="conditions"]').fill("Keep legacy clients for one release.");
        await frame.locator("#comment").fill("Proceed only after the verified backup.");
      };
      if(scenario==="prose-explanation")await frames[0].locator("#explain").click();
      else if(scenario==="visual-defer")await frames[0].locator("#defer").click();
      else if(scenario==="required-field")await frames[0].locator("#confirm").click();
      else if(scenario==="duplicate-cards")await Promise.all(frames.map(async frame=>{await tableInput(frame);await frame.locator("#confirm").click()}));
      else{
        await tableInput(frames[0]);
        if(scenario==="double-click")await frames[0].locator("#confirm").evaluate(button=>{button.click();button.click()});
        else await frames[0].locator("#confirm").click();
      }
      await page.waitForFunction(scenario=>{
        const state=window.__state,current=state.current;
        if(scenario==="required-field"||scenario==="stale-version")return state.submitCalls===0;
        if(scenario==="table-accept-offered")return current&&current.resultOfferedAt;
        if(scenario==="reject-retry")return current&&current.deliveryState==="host-rejected";
        if(scenario==="timeout-unknown"||scenario==="teardown-during-send")return current&&current.deliveryState==="acceptance-unknown";
        if(scenario==="teardown-before-send")return current&&current.deliveryState==="stored"&&state.events.some(event=>event.operation==="outcome");
        return current&&current.deliveryState==="host-accepted";
      },scenario,{timeout:4000}).catch(()=>{});
      if(scenario==="reject-retry"){
        await frames[0].locator("#retry").click();
        await page.waitForFunction(()=>window.__state.current&&window.__state.current.deliveryState==="host-accepted",undefined,{timeout:3000});
      }
      if(scenario==="modified-resubmit"){
        await frames[0].locator('[name="plan"]').selectOption("direct");
        await frames[0].locator('[name="conditions"]').fill("Switch only after the canary remains healthy.");
        await frames[0].locator("#comment").fill("This replaces the earlier condition.");
        await frames[0].locator("#confirm").click();
        await page.waitForFunction(()=>window.__state.submissions.length===2&&window.__state.current.deliveryState==="host-accepted",undefined,{timeout:3000});
      }
      if(scenario==="timeout-unknown")await page.waitForTimeout(500);
      if(screenshotPath)await page.screenshot({path:screenshotPath,fullPage:true});
      const host=await page.evaluate(()=>JSON.parse(JSON.stringify(window.__state)));
      const cards=await Promise.all(frames.map(async frame=>({
        status:await frame.locator("#status").textContent(),
        statusClass:await frame.locator("#status").getAttribute("class"),
        retryHidden:await frame.locator("#retry").evaluate(element=>element.hidden),
        preview:await frame.locator("#review").textContent(),
        bodyText:await frame.locator("body").innerText(),
        generatedHtml:await frame.locator("#generated").innerHTML(),
        svgCount:await frame.locator("#generated svg").count(),
        imageWidths:await frame.locator("#generated img").evaluateAll(images=>images.map(image=>image.naturalWidth)),
        overflow:await frame.locator("body").evaluate(body=>({client:body.clientWidth,scroll:body.scrollWidth})),
        errors:await frame.evaluate(()=>window.__errors)
      })));
      return{host,cards};
    }`);
    const observed = JSON.parse(raw) as {
      host: {
        events: Array<{ type: string; operation?: string; args?: Record<string, unknown> }>;
        messages: Array<{ content?: Array<{ text?: string }> }>;
        submissions: Array<Record<string, any>>;
        messageCount: number;
        submitCalls: number;
        readCalls: number;
        current: Record<string, any> | null;
      };
      cards: Array<{
        status: string;
        statusClass: string;
        retryHidden: boolean;
        preview: string;
        bodyText: string;
        generatedHtml: string;
        svgCount: number;
        imageWidths: number[];
        overflow: { client: number; scroll: number };
        errors: string[];
      }>;
    };

    assert.deepEqual(observed.cards.flatMap((card) => card.errors), [], scenario.name);
    for (const card of observed.cards) {
      assert(card.overflow.scroll <= card.overflow.client + 1, `${scenario.name}: mobile body overflow`);
      assert(!card.bodyText.includes(receipt), `${scenario.name}: receipt leaked into visible card text`);
      assert(!card.bodyText.includes(presentationRef), `${scenario.name}: presentation proof leaked into visible card text`);
    }
    for (const message of observed.host.messages) {
      const prompt = message.content?.map((entry) => entry.text || "").join(" ") || "";
      assert(prompt.includes("codex_decision_result exactly once"), `${scenario.name}: exact lookup instruction missing`);
      assert(prompt.includes("not execution approval"), `${scenario.name}: authority boundary missing`);
    }

    if (scenario.name === "prose-explanation") {
      assert.equal(observed.host.current?.intent, "request-explanation");
      assert.equal(observed.host.current?.selections.length, 0);
      assert.equal(observed.host.messageCount, 1);
    } else if (scenario.name === "table-accept-offered") {
      assert.equal(observed.host.current?.deliveryState, "host-accepted");
      assert.equal(observed.host.current?.resultOfferedAt, "2026-09-19T00:00:03.000Z");
      assert(observed.cards[0]!.status.includes("정확한 결정"));
      assert(observed.cards[0]!.preview.includes("Staged transition — reversible checkpoints"));
      assert(observed.cards[0]!.preview.includes("6 weeks"));
      assert(!observed.cards[0]!.generatedHtml.includes("script"));
      assert(!observed.cards[0]!.generatedHtml.includes("iframe"));
      assert(!observed.cards[0]!.generatedHtml.includes("/leak"));
      assert.equal(observed.host.current?.comment, "Proceed only after the verified backup.");
      assert.equal(observed.host.current?.selections.find((entry: any) => entry.name === "plan")?.values[0]?.label,
        "Staged transition — reversible checkpoints");
    } else if (scenario.name === "visual-defer") {
      assert.equal(observed.host.current?.intent, "defer");
      assert.equal(observed.cards[0]!.svgCount, 1);
      assert.deepEqual(observed.cards[0]!.imageWidths, [1]);
      assert.deepEqual(observed.host.current?.selections.find((entry: any) => entry.name === "risk")?.values, []);
      assert(observed.cards[0]!.preview.includes("입력하지 않음"));
    } else if (scenario.name === "required-field") {
      assert.equal(observed.host.submitCalls, 0);
      assert.equal(observed.host.messageCount, 0);
      assert(observed.cards[0]!.status.includes("필수 항목"));
    } else if (scenario.name === "double-click") {
      assert.equal(observed.host.submitCalls, 1);
      assert.equal(observed.host.submissions.length, 1);
      assert.equal(observed.host.messageCount, 1);
    } else if (scenario.name === "duplicate-cards") {
      assert.equal(observed.host.submitCalls, 2);
      assert.equal(observed.host.submissions.length, 1);
      assert.equal(observed.host.messageCount, 1);
      assert.equal(observed.host.events.filter((event) => event.operation === "accepted").length, 0);
      assert.equal(observed.host.events.filter((event) => event.operation === "outcome" && (event.args as any)?.outcome === "accepted").length, 1);
    } else if (scenario.name === "modified-resubmit") {
      assert.equal(observed.host.submissions.length, 2);
      assert.equal(observed.host.messageCount, 2);
      assert.equal(observed.host.submissions[1]?.sequence, 2);
      assert.equal(observed.host.submissions[1]?.supersedesSubmissionId, observed.host.submissions[0]?.submissionId);
      assert.equal(observed.host.submissions[1]?.selections.find((entry: any) => entry.name === "plan")?.values[0]?.label,
        "Direct migration — shortest transition");
    } else if (scenario.name === "reject-retry") {
      assert.equal(observed.host.submitCalls, 1);
      assert.equal(observed.host.messageCount, 2);
      assert.equal(observed.host.current?.attemptCount, 2);
      assert.deepEqual(observed.host.events.filter((event) => event.operation === "outcome").map((event) => (event.args as any)?.outcome), ["rejected", "accepted"]);
    } else if (scenario.name === "timeout-unknown" || scenario.name === "teardown-during-send") {
      assert.equal(observed.host.messageCount, 1);
      assert.equal(observed.host.current?.deliveryState, "acceptance-unknown");
      assert.equal(observed.cards[0]!.retryHidden, true);
      assert.deepEqual(observed.host.events.filter((event) => event.operation === "outcome").map((event) => (event.args as any)?.outcome), ["uncertain"]);
    } else if (scenario.name === "teardown-before-send") {
      assert.equal(observed.host.messageCount, 0);
      assert.equal(observed.host.current?.deliveryState, "stored");
      assert.deepEqual(observed.host.events.filter((event) => event.operation === "outcome").map((event) => (event.args as any)?.outcome), ["release"]);
    } else if (scenario.name === "stale-version") {
      assert.equal(observed.host.submitCalls, 0);
      assert.equal(observed.host.messageCount, 0);
      assert(observed.cards[0]!.status.includes("최신 버전"));
    }
    results.push({
      scenario: scenario.name,
      harnessMilliseconds: Number((process.hrtime.bigint() - scenarioStartedAt) / 1_000_000n),
      observed,
      passed: true
    });
  }
  assert.equal(blockedNetworkRequests, 0, "sanitized generated content attempted an external/local resource request");
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({
    blockedNetworkRequests,
    preparationMetrics,
    results
  }, null, 2));
  writeFileSync(path.join(artifacts, "final.snapshot.txt"), await cli("snapshot"));
  console.log(`Issue #127 decision card: ${results.length}/${scenarioDefinitions.length} Chromium scenarios passed.`);
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
