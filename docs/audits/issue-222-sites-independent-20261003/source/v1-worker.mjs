// Public, harmless #222 fixture. No product code, user prompt/result or secrets.
const fixture = Object.freeze({probe:"issue-222",phase:"A",value:222});
const resource="ui://issue-222/receiver.html";
const html='<!doctype html><meta charset="utf-8"><title>Issue 222 fixture</title><main>Harmless metadata fixture. No local execution or result authority.</main>';
const tools=[{name:"read_fixture",description:"Read the fixed harmless #222 fixture",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:resource},"openai/ui":{entrypoints:[{type:"global"},{type:"thread"}],displayModes:["inline","pip"]}}},{name:"local_command_probe",description:"Report that no local execution channel is bound; never execute commands",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==="/")return new Response(html,{headers:{"content-type":"text/html;charset=utf-8"}});
 if(url.pathname==="/metadata")return json({fixture,storage:"not-configured",localChannel:false});
 if(url.pathname==="/ingest"&&request.method==="POST"){
  let value;try{value=await request.json()}catch{return json({accepted:false},400)}
  if(JSON.stringify(value)!==JSON.stringify(fixture))return json({accepted:false},400);
  return json({accepted:true,received:fixture,persisted:false});
 }
 if(url.pathname!=="/mcp")return json({error:"not-found"},404);
 if(request.method!=="POST")return json({error:"method-not-allowed"},405);
 let q;try{q=await request.json()}catch{return json({error:"invalid-json"},400)}
 const result=value=>json({jsonrpc:"2.0",id:q.id,result:value});
 if(q.method==="notifications/initialized")return new Response(null,{status:202});
 if(q.method==="initialize")return result({protocolVersion:q.params?.protocolVersion||"2026-07-28",capabilities:{tools:{},resources:{}},serverInfo:{name:"issue-222-harmless-fixture",version:"1"}});
 if(q.method==="tools/list")return result({tools});
 if(q.method==="resources/list")return result({resources:[{uri:resource,name:"Issue 222 fixture",mimeType:"text/html;profile=mcp-app"}]});
 if(q.method==="resources/read"&&q.params?.uri===resource)return result({contents:[{uri:resource,mimeType:"text/html;profile=mcp-app",text:html}]});
 if(q.method==="tools/call"&&q.params?.name==="read_fixture")return result({content:[{type:"text",text:JSON.stringify(fixture)}],structuredContent:fixture});
 if(q.method==="tools/call"&&q.params?.name==="local_command_probe")return result({content:[{type:"text",text:"No private local channel bound; zero commands executed."}],structuredContent:{accepted:false,localExecutions:0}});
 return json({jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"Method not found"}});
}};
