import type { McpServer } from "@modelcontextprotocol/server";
import { currentUiResourceRevision, uiRevisionMetadata } from "./uiResources.js";
import { hostToolResultMetadata, normalizeHostToolResult, parseUiJsonTextStrict, uiJsonTextIsWellFormed } from "./uiHostToolResult.js";
import { serializeUiFunction } from "./uiFunctionSerialization.js";
import { RELAY_GUIDANCE, RELAY_METADATA_KEY } from "./relayDelivery.js";

// A new immutable contract: no historical Dashboard sender is re-enabled.
export const RELAY_CARD_URI = "ui://codex-mcp-bridge/relay/v1.html";
export const RELAY_CARD_CONTRACT_GENERATION = 1;
export const RELAY_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const RELAY_TOOL_METADATA = {
  ui: { resourceUri: RELAY_CARD_URI }, "openai/outputTemplate": RELAY_CARD_URI,
  "openai/widgetAccessible": true
};
export const RELAY_CARD_RESOURCE_DESCRIPTOR = {
  title: "Codex Relay", description: "Automatic event relay for the originating Codex goal.", mimeType: RELAY_CARD_MIME_TYPE
};
export const RELAY_CARD_CONTENT_METADATA = {
  ui: { prefersBorder: false, csp: { connectDomains: [] as string[], resourceDomains: [] as string[] }, domain: "https://web-sandbox.oaiusercontent.com" },
  "openai/widgetPrefersBorder": false, "openai/widgetDescription": "Blank automatic relay; no status or management UI.",
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com", "codex/uiContractGeneration": RELAY_CARD_CONTRACT_GENERATION
};

export function registerRelayCardResource(server: McpServer): void {
  const revision = currentUiResourceRevision("relay");
  const metadata = uiRevisionMetadata(revision, RELAY_CARD_RESOURCE_DESCRIPTOR, RELAY_CARD_CONTENT_METADATA);
  server.registerResource("codex-relay-card", RELAY_CARD_URI, metadata.descriptor, async () => ({
    contents: [{ uri: RELAY_CARD_URI, mimeType: RELAY_CARD_MIME_TYPE, text: RELAY_CARD_HTML, _meta: metadata.content }]
  }));
}

export const RELAY_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;border:0;height:0;min-height:0;max-height:0;overflow:hidden;background:transparent}</style>
</head><body><script>
${serializeUiFunction(uiJsonTextIsWellFormed)}
${serializeUiFunction(parseUiJsonTextStrict)}
${serializeUiFunction(normalizeHostToolResult)}
${serializeUiFunction(hostToolResultMetadata)}
const OPEN_KEY=${JSON.stringify(RELAY_METADATA_KEY)},GUIDANCE=${JSON.stringify(RELAY_GUIDANCE)};
const cardId=crypto.randomUUID(),pending=new Map();
let nextId=1,mounted=true,tornDown=false,stopped=false,running=false,timer=0,connected=false,standard=false,messageSupported=false;
let openingInput=null,openingResult=null,linked=null,revision,ackPending=null,initializing;

function notify(method,params){window.parent.postMessage({jsonrpc:"2.0",method,params},"*")}
function rpc(method,params,timeout=35000){
  if(!mounted)return Promise.reject(new Error("RELAY_UNMOUNTED"));
  return new Promise((resolve,reject)=>{const id=nextId++,timeoutId=setTimeout(()=>{
    pending.delete(id);notify("notifications/cancelled",{requestId:id,reason:"Relay request timed out"});reject(new Error("RELAY_TIMEOUT"));
  },timeout);pending.set(id,{resolve(value){clearTimeout(timeoutId);resolve(value)},reject(error){clearTimeout(timeoutId);reject(error)}});
  window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*")});
}
function cancelRequests(){for(const[id,entry]of pending){notify("notifications/cancelled",{requestId:id,reason:"Relay detached"});entry.reject(new Error("RELAY_UNMOUNTED"))}pending.clear()}
function schedule(delay=0){if(timer||running||!mounted||stopped||!linked)return;timer=setTimeout(()=>{timer=0;void watch()},delay)}
async function correlate(){
  if(linked||!openingInput||!openingResult)return;
  const input=openingInput.arguments||openingInput,result=openingResult;
  if(input.requestId!==result.inputRequestId||input.jobId&&input.jobId!==result.jobId)return;
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("codex/relay-open/v1"+String.fromCharCode(0)+input.requestId));
  const ref=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,"0")).join("");
  if(linked||openingResult!==result||ref!==result.presentationRef)return;
  linked=result;document.documentElement.dataset.relay="linked";schedule();
}
function receiveInput(value){if(!value||typeof value!=="object"||linked)return;const input=value.arguments||value;if(typeof input.requestId!=="string")return;openingInput=value;void correlate()}
function receiveResult(value){if(linked)return;const metadata=hostToolResultMetadata(value),result=metadata&&metadata[OPEN_KEY];
  if(!result||result.contractGeneration!==1||typeof result.activityId!=="string"||typeof result.jobId!=="string"||typeof result.presentationRef!=="string"||typeof result.inputRequestId!=="string")return;
  openingResult=result;void correlate();
}
async function initialize(){
  try{const result=await rpc("ui/initialize",{appInfo:{name:"codex-mcp-bridge-relay",version:"1"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},5000);
    if(!result||typeof result.protocolVersion!=="string")return;
    standard=true;messageSupported=Boolean(result.hostCapabilities&&result.hostCapabilities.message);
    notify("ui/notifications/initialized",{});notify("ui/notifications/size-changed",{height:0});
  }catch{/* The compatibility path is selected before any message or mutation. */}
}
async function tool(name,args){
  await initializing;if(!mounted)throw new Error("RELAY_UNMOUNTED");
  const value=standard?await rpc("tools/call",{name,arguments:args}):
    await bounded(()=>window.openai.callTool(name,args),35000);
  const result=normalizeHostToolResult(value);
  if(!result||result.isError)throw new Error("RELAY_TOOL_FAILED");
  return result.structuredContent||result;
}
function bounded(operation,timeout){return new Promise((resolve,reject)=>{const id=setTimeout(()=>reject(new Error("RELAY_TIMEOUT")),timeout);Promise.resolve().then(operation).then(value=>{clearTimeout(id);resolve(value)},error=>{clearTimeout(id);reject(error)})})}
function base(){return {contractGeneration:1,activityId:linked.activityId,cardId}}
async function mutate(args,retry=true){let error;for(let count=0;count<(retry?3:1);count++){try{return await tool("codex_relay",{...base(),...args})}catch(caught){error=caught;if(!mounted)break;await bounded(()=>new Promise(resolve=>setTimeout(resolve,1000*(count+1))),4000)}}throw error}
async function flushAck(){if(!ackPending)return;const current=ackPending;await mutate({action:"ack",...current});if(ackPending===current)ackPending=null}
async function deliver(event){
  const compat=window.openai&&typeof window.openai.sendFollowUpMessage==="function";
  // Choose exactly one path before claiming. No send fallback after entry.
  const sender=standard&&(messageSupported||!compat)?"standard":compat?"compatibility":null;
  if(!sender)throw new Error("RELAY_MESSAGE_UNAVAILABLE");
  const attemptId=crypto.randomUUID(),attempt={eventId:event.eventId,attemptId};
  const claim=await mutate({action:"claim",...attempt});
  if(!claim.event||claim.event.state!=="leased"||claim.event.attemptId!==attemptId)return;
  if(!mounted){ackPending={...attempt,outcome:"not-sent"};return}
  // An enter response loss is a conservative no-send gap. Retrying entry can
  // never return another dispatch grant for this same attempt.
  const entered=await mutate({action:"enter",...attempt},false);
  if(!entered.dispatch)return;
  let outcome="unknown";
  const query=event.kind==="input"?{kind:"input",jobId:event.jobId}:{kind:"job",id:event.jobId};
  const prompt=GUIDANCE+String.fromCharCode(10)+JSON.stringify({eventId:event.eventId,result:{tool:"codex_status",query}});
  try{
    if(mounted){const result=sender==="standard"?await rpc("ui/message",{role:"user",content:[{type:"text",text:prompt}]},12000):
      await bounded(()=>window.openai.sendFollowUpMessage({prompt,scrollToBottom:false}),12000);
      outcome=result&&result.isError===true?"rejected":"accepted";
    }
  }catch(error){
    // Only an actual JSON-RPC error response proves an explicit rejection.
    // Strings, thrown compatibility errors, timeout and teardown stay unknown.
    if(error&&error.relayRpcRejection===true)outcome=error.relayRetryable===true?"retryable-rejection":"rejected";
  }
  ackPending={...attempt,outcome};if(mounted)await flushAck();
}
async function watch(){
  if(running||!mounted||!linked||stopped)return;running=true;let retryDelay=2000;
  try{
    await initializing;if(!standard&&!(window.openai&&typeof window.openai.callTool==="function")){initializing=initialize();await initializing}await flushAck();
    if(!connected){const result=await mutate({action:"connect",inputRequestId:linked.inputRequestId,presentationRef:linked.presentationRef});
      if(result.stopped){stopped=true;return}connected=true;let after=result.recoveryAfter;
      while(after&&mounted){const next=await mutate({action:"recover",afterJob:after});if(next.stopped){stopped=true;return}after=next.recoveryAfter}
    }
    const result=await tool("codex_relay_wait",{...base(),...(revision?{after:revision}:{}),waitMs:25000});
    revision=result.revision;if(result.stopped){stopped=true;return}
    for(const event of result.events||[]){if(!mounted)break;await deliver(event)}
    document.documentElement.dataset.relay="waiting";retryDelay=(result.events||[]).length?2000:0;
  }catch{document.documentElement.dataset.relay="recovering";}
  finally{running=false;schedule(retryDelay)}
}

// Install every receiver before ui/initialize can cause host notifications.
window.addEventListener("message",event=>{
  if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;
  if(message.method==="ping"&&message.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}
  if(message.method==="ui/resource-teardown"){tornDown=true;mounted=false;clearTimeout(timer);timer=0;cancelRequests();if(message.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}
  if(message.method===undefined&&pending.has(message.id)&&(Object.prototype.hasOwnProperty.call(message,"result")||Object.prototype.hasOwnProperty.call(message,"error"))){const entry=pending.get(message.id);pending.delete(message.id);if(message.error){const error=new Error("RELAY_RPC_REJECTED");error.relayRpcRejection=true;error.relayRetryable=message.error.data&&message.error.data.delivery==="not-sent"&&message.error.data.retryable===true;entry.reject(error)}else entry.resolve(message.result);return}
  if(message.method==="ui/notifications/tool-input")receiveInput(message.params);
  if(message.method==="ui/notifications/tool-result")receiveResult(message.params);
});
window.addEventListener("openai:set_globals",event=>{const globals=event&&event.detail&&event.detail.globals||{};receiveInput(globals.toolInput);receiveResult(globals.toolResponseMetadata);schedule()});
window.addEventListener("pagehide",()=>{mounted=false;connected=false;clearTimeout(timer);timer=0;cancelRequests()});
window.addEventListener("pageshow",()=>{if(!tornDown){mounted=true;schedule()}});
window.addEventListener("online",()=>schedule());
receiveInput(window.openai&&window.openai.toolInput);receiveResult(window.openai&&window.openai.toolResponseMetadata);
initializing=initialize();
</script></body></html>`;
