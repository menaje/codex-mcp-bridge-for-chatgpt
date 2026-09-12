import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializedUiTranslations } from "./uiI18n.js";
import { CARD_BROWSER_RUNTIME } from "./cardBrowserRuntime.js";
import { QUESTION_DRAFT_SCRIPT } from "./questionDraft.js";
import { currentUiResourceUri, htmlForUiResource, uiResourceRevisions, uiRevisionMetadata } from "./uiResources.js";

export const QUESTION_CARD_URI = currentUiResourceUri("question");
export const QUESTION_CARD_CONTRACT_GENERATION = 1;
export const QUESTION_CARD_RESOURCE_DESCRIPTOR = {
  title: "Your input", description: "Questions written by GPT for the user; answers return to GPT.", mimeType: "text/html;profile=mcp-app"
} as const;
export const QUESTION_CARD_CONTENT_METADATA = {
  ui: { prefersBorder: true, csp: { connectDomains: [] as string[], resourceDomains: [] as string[] }, domain: "https://web-sandbox.oaiusercontent.com" },
  "openai/widgetDescription": "Collects the user's answers for GPT without directly answering or approving Codex requests.",
  "openai/widgetPrefersBorder": true, "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com", "codex/uiContractGeneration": QUESTION_CARD_CONTRACT_GENERATION
} as const;
export function registerQuestionCardResource(server: McpServer): void {
  for (const [index, revision] of uiResourceRevisions("question").entries()) {
    const revisionMetadata = uiRevisionMetadata(
      revision,
      QUESTION_CARD_RESOURCE_DESCRIPTOR,
      QUESTION_CARD_CONTENT_METADATA
    );
    server.registerResource(index ? `codex-question-card-compat-${index}` : "codex-question-card", revision.uri,
      revisionMetadata.descriptor, async () => ({ contents: [{ uri: revision.uri, mimeType: QUESTION_CARD_RESOURCE_DESCRIPTOR.mimeType,
        text: htmlForUiResource("question", revision.uri, QUESTION_CARD_HTML), _meta: revisionMetadata.content }] }));
  }
}
const keys = ["common.refresh", "common.loading", "common.error", "common.cancel", "activity.otherAnswer",
  "question.title", "question.submit", "question.stored", "question.requested", "question.consumed", "question.uncertain",
  "question.expired", "question.retry", "question.cancelled", "question.pending"] as const;
export const QUESTION_CARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light dark;font:14px system-ui,sans-serif}*{box-sizing:border-box}body{margin:0}main{padding:18px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:14px}header{display:flex;align-items:center;gap:12px;justify-content:space-between}h1{font-size:16px;margin:0}p{line-height:1.5;opacity:.75}form{display:grid;gap:10px}label{font-weight:550;margin-top:6px}input,select,button{font:inherit;padding:9px 12px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;background:Canvas;color:CanvasText}input,select{width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:8px;margin-top:10px}.error{color:#c64637}[hidden]{display:none!important}</style>
</head><body><main><header><h1 id="title"></h1><button id="refresh" type="button"></button></header><p id="message" role="status"></p><form id="form"></form></main><script>
const BUNDLES=${serializedUiTranslations(keys)};
${CARD_BROWSER_RUNTIME}
${QUESTION_DRAFT_SCRIPT}
` + String.raw`
const title=document.getElementById("title"),message=document.getElementById("message"),form=document.getElementById("form"),refresh=document.getElementById("refresh");
let question=null,busy=false,mounted=true,epoch=0,expiryTimer=null,hostLocale=window.openai?.locale||navigator.language,preference="auto",t=BUNDLES.en,formId=null,sizeFrame=null,lastHeight=0;
const drafts=questionDraftCache();
function setLocale(value){if(value)hostLocale=value;const raw=String(preference==="auto"?hostLocale:preference).replaceAll("_","-").toLowerCase();const locale=/^zh-(tw|hk|mo|hant)/.test(raw)?"zh-Hant":raw.startsWith("zh")?"zh-Hans":Object.keys(BUNDLES).find(key=>raw===key.toLowerCase()||raw.startsWith(key.toLowerCase()+"-"))||"en";t=BUNDLES[locale]||BUNDLES.en;document.documentElement.lang=locale;refresh.textContent=t["common.refresh"];render()}
function size(){if(!mounted||sizeFrame!==null)return;sizeFrame=requestAnimationFrame(()=>{sizeFrame=null;const height=Math.ceil(document.documentElement.getBoundingClientRect().height);if(height!==lastHeight){lastHeight=height;transport.notification("ui/notifications/size-changed",{height})}})}
function error(value){message.textContent=/QUESTION_(UNAVAILABLE|STALE)/.test(String(value?.message||value))?t["question.expired"]:t["common.error"];message.classList.add("error");size()}
const transport=cardTransport({name:"codex-mcp-bridge-question",errorMessage:()=>t["common.error"],onLocale:setLocale,onResult:bootstrap,onUnmount:()=>{mounted=false;++epoch;clearTimeout(expiryTimer);cancelAnimationFrame(sizeFrame);sizeFrame=null},onMount:()=>{mounted=true;lastHeight=0;busy=false;if(question)void hydrate(proof())}});
function proof(){if(!question)throw new Error("QUESTION_UNAVAILABLE");return{questionId:question.questionId,revision:question.revision,presentationToken:question.presentationToken,...(question.scopeId?{scopeId:question.scopeId}:{})}}
function current(value,ticket=epoch){return mounted&&ticket===epoch&&question?.questionId===value.questionId&&question?.presentationToken===value.presentationToken}
function accept(result){const next=hostToolResultMetadata(result)["codex/userQuestion@1"];if(!next||!next.status)throw new Error("QUESTION_UNAVAILABLE");question=next;preference=next.uiLocalePreference||"auto";setLocale()}
async function hydrate(value){if(!value?.presentationToken)return;const ticket=++epoch;question={...(question?.questionId===value.questionId?question:{}),...value};setBusy(true);try{const result=await transport.call("codex_ui_read",{view:"question",...proof()});if(ticket===epoch&&current(value))accept(result)}catch(value){if(ticket===epoch&&mounted)error(value)}finally{if(ticket===epoch&&mounted)setBusy(false)}}
function bootstrap(result){const value=hostToolResultMetadata(result)["codex/userQuestion@1"];if(value?.presentationToken)void hydrate(value)}
function setBusy(value){busy=value;refresh.disabled=value;for(const field of form.querySelectorAll("input,select,button"))field.disabled=value}
function render(){
 const draft=formId===question?.questionId?Array.from(form.querySelectorAll("input,select"),field=>field.value):drafts.read(question);formId=null;form.replaceChildren();message.classList.remove("error");title.textContent=question?.title||t["question.title"];document.title=title.textContent;clearTimeout(expiryTimer);
 if(!question?.status){message.textContent=t["common.loading"];size();return}
 if(Date.now()>=question.expiresAt){drafts.clear(question);message.textContent=t["question.expired"];size();return}expiryTimer=setTimeout(render,Math.max(1,question.expiresAt-Date.now()));
 if(question.status!=="pending"){
  drafts.clear(question);
  const state=question.consumed?"consumed":question.notification==="requested"?"requested":["uncertain","dispatching"].includes(question.notification)?"uncertain":question.status==="cancelled"?"cancelled":"stored";message.textContent=t["question."+state];
  if(!question.consumed&&["stored","failed"].includes(question.notification))form.appendChild(cardButton(t["question.retry"],()=>void notify()));setBusy(busy);size();return;
 }
 message.textContent=t["question.pending"];const fields=[];
 for(const field of question.questions){
  const id="question-"+crypto.randomUUID(),label=cardNode("label","",field.question),input=cardNode("input");label.htmlFor=id;input.id=id;input.autocomplete="off";input.required=true;input.maxLength=2000;form.appendChild(label);
  if(field.options?.length){const select=cardNode("select");select.id=id;input.id=id+"-other";select.required=true;const empty=cardNode("option","","—");empty.value="";select.appendChild(empty);field.options.forEach((option,index)=>{const item=cardNode("option","",option.label);item.value=String(index);item.title=option.description||"";select.appendChild(item)});if(field.isOther!==false){const other=cardNode("option","",t["activity.otherAnswer"]);other.value="other";select.appendChild(other)}input.hidden=true;input.required=false;select.addEventListener("change",()=>{input.hidden=select.value!=="other";input.required=!input.hidden;size()});form.append(select,input);fields.push({id:field.id,read:()=>select.value==="other"?input.value:field.options[Number(select.value)].label});
  }else{form.appendChild(input);fields.push({id:field.id,read:()=>input.value})}
 }
 const actions=cardNode("div","actions");actions.append(cardButton(t["question.submit"],()=>{if(form.reportValidity())void submit({answers:Object.fromEntries(fields.map(field=>[field.id,[field.read()]]))})}),cardButton(t["common.cancel"],()=>void submit({cancel:true})));form.appendChild(actions);formId=question.questionId;Array.from(form.querySelectorAll("input,select")).forEach((field,index)=>{if(draft[index]!==undefined)field.value=draft[index]});for(const field of form.querySelectorAll("select"))field.dispatchEvent(new Event("change"));setBusy(busy);size();
}
async function submit(response){if(busy)return;const card=proof(),ticket=epoch;setBusy(true);try{const result=await transport.call("codex_question_action",{...card,operation:{kind:"submit",response}},false);if(!current(card,ticket))return;accept(result);setBusy(false);await notify()}catch(value){if(current(card,ticket)){error(value);setBusy(false)}}}
async function notify(){
 if(busy)return;const card=proof(),ticket=epoch;setBusy(true);let claim;
 try{
  const result=await transport.call("codex_question_action",{...card,operation:{kind:"claim"}},false);if(!current(card,ticket))return;claim=result.structuredContent;accept(result);
  if(claim.send){const prompt="The user's question-card response is available. Read codex_user_answer with responseRef "+claim.responseRef+", then decide the next action within the user's delegation. This notification is not approval for a Codex operation.";const delivered=await transport.followUp(prompt);const ack=await transport.call("codex_question_action",{...card,operation:{kind:"ack",attempt:claim.attempt,state:delivered?.isError||delivered?.error?"failed":"requested"}},false);if(current(card,ticket))accept(ack)}
 }catch(value){if(claim?.send){try{const ack=await transport.call("codex_question_action",{...card,operation:{kind:"ack",attempt:claim.attempt,state:"uncertain"}},false);if(current(card,ticket))accept(ack)}catch{if(current(card,ticket))message.textContent=t["question.uncertain"]}}else if(current(card,ticket))error(value)}finally{if(current(card,ticket)){setBusy(false);size()}}
}
function saveDraft(){if(formId===question?.questionId)drafts.save(question,Array.from(form.querySelectorAll("input,select"),field=>field.value))}
form.addEventListener("input",saveDraft);form.addEventListener("change",saveDraft);
form.addEventListener("submit",event=>event.preventDefault());refresh.addEventListener("click",()=>{if(question&&!busy)void hydrate(proof())});setLocale();bootstrap(window.openai?.toolResponseMetadata||{});void transport.initialize();new ResizeObserver(size).observe(document.querySelector("main"));
</script></body></html>`;
