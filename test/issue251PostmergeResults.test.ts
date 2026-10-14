import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {describe,it,expect} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {ScopeResolver} from '../src/scopeResolver.js';
import {UserSettingsStore} from '../src/userSettings.js';
import {loadConfig} from '../src/config.js';
import {createHttpServer} from '../src/server.js';

const cases=[4096,1048576].flatMap(bound=>['resident','archive','restart'].flatMap(residency=>
 ['absent','normal','oversized'].map(kind=>({bound,residency,kind}))));

describe('#251 retained originals and bounded actual MCP responses',()=>{
 it.each(cases)('$kind result, $residency, response limit $bound',async({bound,residency,kind})=>{
  const root=mkdtempSync(path.join(tmpdir(),'issue251-response-')),file=path.join(root,'state.sqlite');
  let state=new BridgeStateStore({file});
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:root,
   CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,
   CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:path.join(root,'models.json'),CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES:String(bound)});
  new UserSettingsStore(config,{stateStore:state});
  const metadata={'openai/session':'issue251-original-and-response'},scopeId=new ScopeResolver({stateStore:state}).resolve(metadata)!.scopeId;
  const agent=state.createAgent({scopeId,agentName:'bounded-result',now:Date.now()-1000}),jobId=randomUUID(),requestId=randomUUID();
  const original=kind==='absent' ? undefined : {content:[{type:'text',text:'RETAINED_ORIGINAL_'+ '한'.repeat(
   kind==='oversized' ? Math.max(70000,Math.ceil(2*bound/3)) : Math.floor(bound/12))}]};
  const omitted=kind==='oversized',resultBytes=original ? Buffer.byteLength(JSON.stringify(original)) : undefined;
  const preview={content:[{type:'text',text:'The complete sanitized original is retained; this response omits oversized content.'}],
   structuredContent:{resultOmitted:true,originalBytes:resultBytes,maxResponseBytes:bound}};
  const now=Date.now()-500;
  state.upsertJob({jobId,requestId,scopeId,agentId:agent.agentId,status:'completed',createdAt:now,updatedAt:now+1,
   version:1,cwd:root,sandbox:'read-only',operation:'start',requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],
   trackingState:'connected',completionDeliveryPolicy:'direct-wait',sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},
   pendingInteractions:[],...(original ? {result:omitted ? preview : original,resultBytes,resultOmitted:omitted} : {})});
  if(original) state.saveJobResultBody(jobId,original);
  if(residency!=='resident') state.deleteJob(jobId);
  if(residency==='restart') {state.close();state=new BridgeStateStore({file});}
  const detail=state.readRetainedJobDetail(scopeId,{kind:'job',id:jobId});
  expect(detail?.result).toEqual(original);
  if(omitted) expect(detail?.resultOmitted).toBe(true);
  let executionCalls=0;
  const upstream:any={listTools:async()=>({tools:[]}),callTool:async()=>{executionCalls++;throw Error('No execution authorized');},close:async()=>{}};
  const server=createHttpServer(config,upstream,undefined,{stateStore:state});
  const client=new Client({name:'issue251-bounded-result',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  try{
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
   await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+(server.address() as any).port+'/mcp')));
   for(const query of [{kind:'job',id:jobId},{kind:'request',requestId}]) {
    const response:any=await client.callTool({name:'codex_status',arguments:{query},_meta:metadata});
    expect(response.isError).not.toBe(true);
    const texts=response.content.filter((x:any)=>x.type==='text').map((x:any)=>x.text);
    const bytes=Buffer.byteLength(texts.join(''));
    expect(bytes).toBeLessThanOrEqual(bound);
    const item=response.structuredContent.items.find((x:any)=>x.id===jobId);
    expect(item.result.availability).toBe(kind==='normal' ? 'delivered' : omitted ? 'omitted' : 'unavailable');
    expect(item.result.omitted).toBe(omitted);
    if(kind==='normal') {expect(texts).toEqual([original!.content[0].text]);expect(Buffer.byteLength(item.answer)).toBeLessThanOrEqual(24576);}
    else {expect(texts.join('')).not.toContain('RETAINED_ORIGINAL_');expect(item.answer).toBeUndefined();}
    if(omitted) expect(JSON.stringify(response)).not.toContain(original!.content[0].text);
   }
   const foreign:any=await client.callTool({name:'codex_status',arguments:{query:{kind:'job',id:jobId}},
    _meta:{'openai/session':'other-scope'}});
   expect(foreign.isError).toBe(true);expect(JSON.stringify(foreign)).not.toContain('RETAINED_ORIGINAL_');
   expect(executionCalls).toBe(0);
   const db=new Database(file,{readonly:true});
   try {
    const row:any=db.prepare('SELECT payload FROM job_result_bodies WHERE job_id=?').get(jobId);
    expect(row ? JSON.parse(row.payload) : undefined).toEqual(original);
    if(omitted) {
     const payload=JSON.parse((db.prepare('SELECT payload FROM jobs WHERE job_id=?').get(jobId) as any).payload);
     expect(payload.resultOmitted).toBe(true);expect(payload.result).toEqual(preview);
    }
   }finally{db.close();}
   expect(state.readRetainedJobDetail(scopeId,{kind:'job',id:jobId})?.result).toEqual(original);
  }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));state.close();rmSync(root,{recursive:true,force:true});}
 });

 it('applies a smaller current response limit to a previously deliverable hydrated original',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'issue251-smaller-limit-')),file=path.join(root,'state.sqlite');
  const state=new BridgeStateStore({file});
  const config=loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:root,CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',
   CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:path.join(root,'models.json'),CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES:'4096'});
  new UserSettingsStore(config,{stateStore:state});
  const meta={'openai/session':'smaller-current-limit'},scopeId=new ScopeResolver({stateStore:state}).resolve(meta)!.scopeId;
  const agent=state.createAgent({scopeId,agentName:'lowered-response-limit',now:Date.now()}),jobId=randomUUID();
  const original={content:[{type:'text',text:'CURRENT_LIMIT_ORIGINAL_'+ 'x'.repeat(100000)}]};
  state.upsertJob({jobId,requestId:randomUUID(),scopeId,agentId:agent.agentId,status:'completed',createdAt:Date.now()-1,updatedAt:Date.now(),
   cwd:root,sandbox:'read-only',operation:'start',requestHash:'a'.repeat(64),requestHashVersion:11,exclusiveKeys:[],trackingState:'connected',
   completionDeliveryPolicy:'direct-wait',sessionDecision:{requestedMode:'new',action:'start',reason:'explicit-new'},pendingInteractions:[],result:original,
   resultBytes:Buffer.byteLength(JSON.stringify(original)),resultOmitted:false});
  state.saveJobResultBody(jobId,original);state.deleteJob(jobId);
  const upstream:any={listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('No execution');},close:async()=>{}};
  const server=createHttpServer(config,upstream,undefined,{stateStore:state});
  const client=new Client({name:'smaller-limit',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  try {
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
   await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+(server.address() as any).port+'/mcp')));
   const response:any=await client.callTool({name:'codex_status',arguments:{query:{kind:'job',id:jobId}},_meta:meta});
   expect(response.isError).not.toBe(true);expect(response.structuredContent.items[0].result).toMatchObject({availability:'omitted',omitted:true});
   expect(JSON.stringify(response)).not.toContain('CURRENT_LIMIT_ORIGINAL_');
   expect(Buffer.byteLength(response.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(''))).toBeLessThanOrEqual(4096);
   expect(state.readRetainedJobDetail(scopeId,{kind:'job',id:jobId})?.result).toEqual(original);
  }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));state.close();rmSync(root,{recursive:true,force:true});}
 });
});
