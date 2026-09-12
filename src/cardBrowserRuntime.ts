import { hostToolResultMetadata, normalizeHostToolResult } from "./uiHostToolResult.js";
import { withUiToolCallTimeout, callUiToolWithFallback } from "./uiToolCallFallback.js";

/** Shared transport for standalone cards. Read retries are safe; mutations and
 * host follow-up messages are never replayed after an uncertain dispatch. */
export const CARD_BROWSER_RUNTIME = `
const normalizeHostToolResult=${normalizeHostToolResult.toString()};
const hostToolResultMetadata=${hostToolResultMetadata.toString()};
const withUiToolCallTimeout=${withUiToolCallTimeout.toString()};
const callUiToolWithFallback=${callUiToolWithFallback.toString()};
` + String.raw`
function cardTransport(options){
  let sequence=0,mounted=true,initialized=false,initializing=null,generation=0;
  const pending=new Map(),reads=new Map();
  function error(){return new Error(options.errorMessage())}
  function notification(method,params){if(mounted)window.parent.postMessage({jsonrpc:"2.0",method,params},"*")}
  function rpc(method,params,timeout=15000){
    if(!mounted)return Promise.reject(error());
    return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(error())},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:reason=>{clearTimeout(timer);reject(reason)}});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*")});
  }
  async function initialize(){
    if(initialized)return true;if(initializing)return initializing;
    const ticket=generation;initializing=(async()=>{try{const value=await rpc("ui/initialize",{appInfo:{name:options.name,version:"1"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},1500);if(!mounted||ticket!==generation||!value||!value.protocolVersion)return false;initialized=true;document.documentElement.dataset.mcpApps="initialized";notification("ui/notifications/initialized",{});if(value.hostContext?.locale)options.onLocale?.(value.hostContext.locale);return true}catch{return false}finally{if(ticket===generation)initializing=null}})();return initializing;
  }
  async function standard(name,args){if(!await initialize())throw error();return rpc("tools/call",{name,arguments:args})}
  async function dispatch(name,args,readOnly){
    const compatibility=typeof window.openai?.callTool==="function"?()=>window.openai.callTool(name,args):undefined;
    const result=compatibility?await callUiToolWithFallback(compatibility,readOnly?()=>standard(name,args):undefined,{standardTimeoutMs:15000,compatibilityTimeoutMs:17000,timeoutMessage:options.errorMessage()}):await standard(name,args);
    const normalized=normalizeHostToolResult(result);if(normalized?.isError)throw new Error((normalized.content||[]).filter(v=>v.type==="text").map(v=>v.text).join(" ")||options.errorMessage());return normalized;
  }
  function call(name,args,readOnly=true){
    if(!mounted)return Promise.reject(error());if(!readOnly)return dispatch(name,args,false);
    const key=JSON.stringify([name,args]);if(reads.has(key))return reads.get(key);
    const promise=dispatch(name,args,true).finally(()=>{if(reads.get(key)===promise)reads.delete(key)});reads.set(key,promise);return promise;
  }
  async function followUp(prompt){
    if(!mounted)throw error();
    if(await initialize())return rpc("ui/message",{role:"user",content:[{type:"text",text:prompt}]},10000);
    if(typeof window.openai?.sendFollowUpMessage==="function")return withUiToolCallTimeout(()=>window.openai.sendFollowUpMessage({prompt}),10000,options.errorMessage());
    throw error();
  }
  function close(){if(!mounted)return;mounted=false;++generation;initialized=false;initializing=null;for(const request of pending.values())request.reject(error());pending.clear();reads.clear();options.onUnmount?.()}
  window.addEventListener("message",event=>{if(event.source!==window.parent)return;const value=event.data;if(!value||value.jsonrpc!=="2.0")return;
    if(value.id!==undefined&&pending.has(value.id)){const request=pending.get(value.id);pending.delete(value.id);value.error?request.reject(new Error(value.error.message||options.errorMessage())):request.resolve(value.result);return}
    if(value.method==="ui/resource-teardown"){close();if(value.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:value.id,result:{}},"*");return}
    if(value.method==="ping"&&value.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:value.id,result:{}},"*");return}
    if(mounted&&value.method==="ui/notifications/tool-result")options.onResult?.(value.params);
    if(mounted&&value.method==="ui/notifications/host-context-changed"&&value.params?.locale)options.onLocale?.(value.params.locale);
  });
  window.addEventListener("openai:set_globals",event=>{if(!mounted)return;const value=event.detail?.globals;if(value?.locale)options.onLocale?.(value.locale);if(value?.toolResponseMetadata)options.onResult?.(value.toolResponseMetadata)});
  window.addEventListener("pagehide",close);
  window.addEventListener("pageshow",event=>{if(event.persisted&&!mounted){mounted=true;options.onMount?.();void initialize()}});
  return {call,followUp,initialize,notification,close};
}
function cardNode(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function cardButton(text,action){const node=cardNode("button","",text);node.type="button";node.addEventListener("click",action);return node}
`;
