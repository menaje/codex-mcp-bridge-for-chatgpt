import vm from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
const day=86400000,now=Date.UTC(2026,9,15),policy='c'.repeat(64),revision='e'.repeat(64);
afterEach(()=>{vi.useRealTimers()});
function context(days=30,age=6){
 vi.useFakeTimers();vi.setSystemTime(now);
 const row={jobId:'exact-job',scopeId:'scope-a',projectKey:'project-a',executionRevision:revision,policyRevision:policy,latestTurn:{endedAt:new Date(now-age*day).toISOString()},status:'failed'};
 const c=vm.createContext({Date,widgetInstanceId:'widget',historySecurityGeneration:1,selectedScope:'conversation',mounted:true,hydrationEpoch:1,view:{historyModeApplied:'jobs',historyPolicy:{policyRevision:policy,retentionDays:days}},executionDetails:new Map(),executionRequests:new Map(),executionErrors:new Map(),normalizeHostToolResult:(x:any)=>x,parsedToolText:()=>null,uiText:(_k:string,f:string)=>f,errorText:(x:any)=>typeof x==='string'?x:x?.message||JSON.stringify(x),paint:()=>{}});
 for(const name of ['executionTarget','executionKey','executionFresh','executionCached','loadExecutionDetail','dashboardRead']){
  const line=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x));expect(line).toBeDefined();vm.runInContext(line!,c);
 }
 c.row=row;vm.runInContext('target=executionTarget(row)',c);
 const detail={kind:'dashboard-execution',jobId:row.jobId,scopeId:row.scopeId,executionRevision:revision,policyRevision:policy,execution:{...row.latestTurn,jobId:row.jobId,scopeId:row.scopeId,executionRevision:revision}};
 return {c,row,detail};
}
describe('Job exact-detail consumer contract',()=>{
 it('generated inline scripts parse',()=>{for(const script of DASHBOARD_CARD_HTML.match(/<script[^>]*>([\s\S]*?)<\/script>/g)||[])new vm.Script(script.replace(/<script[^>]*>/,'').replace(/<\/script>/,''))});
 for(const days of [0,7,30,90])it(`applies own detail expiry for ${days} days`,()=>{
  for(const age of [6,20,40,100]){const {c,detail}=context(days,age);c.detail=detail;vm.runInContext('executionDetails.set(executionKey(target),{detail,expiresAt:target.expiresAt})',c);expect(Boolean(vm.runInContext('executionCached(target)',c))).toBe(days===0||age<days)}
 });
 it('fetches an exact scoped Job once and preserves valid detail across unrelated refresh',async()=>{
  const {c,row,detail}=context();let reads=0,request:any;c.callTool=async(_name:string,args:any)=>{reads++;request=args;return {structuredContent:detail}};
  await vm.runInContext('loadExecutionDetail(row)',c);await vm.runInContext('loadExecutionDetail(row)',c);
  expect(reads).toBe(1);expect(request.jobId).toBe(row.jobId);expect(request.scopeId).toBe(row.scopeId);expect(request.expectedExecutionRevision).toBe(revision);expect(request.expectedPolicyRevision).toBe(policy);
  c.view={...c.view,generatedAt:new Date(now+100).toISOString()};expect(vm.runInContext('executionCached(target).jobId',c)).toBe(row.jobId);
  c.view.historyPolicy.policyRevision='f'.repeat(64);expect(vm.runInContext('executionCached(target)',c)).toBeNull();
 });
 it('rejects a different scope or Job without substituting Agent history',async()=>{
  const {c,detail}=context();let calls:any[]=[];c.callTool=async(_n:string,args:any)=>{calls.push(args);return {structuredContent:{...detail,scopeId:'wrong-scope'}}};
  await vm.runInContext('loadExecutionDetail(row)',c);expect(c.executionDetails.size).toBe(0);expect(calls).toHaveLength(1);expect(calls[0].view).not.toBe('dashboard-history');
 });
 it('rejects late exact replies after A-B-A scope or a policy boundary',async()=>{
  const {c,row,detail}=context(7,7-1000/day);let release!:(x:any)=>void;c.callTool=()=>new Promise(resolve=>release=resolve);
  const pending=vm.runInContext('loadExecutionDetail(row)',c);vi.setSystemTime(now+1000);release({structuredContent:detail});await pending;expect(c.executionDetails.size).toBe(0);
  vi.setSystemTime(now);let release2!:(x:any)=>void;c.callTool=()=>new Promise(resolve=>release2=resolve);const second=vm.runInContext('loadExecutionDetail(row)',c);c.hydrationEpoch+=2;c.executionRequests.clear();release2({structuredContent:detail});await second;expect(c.executionDetails.size).toBe(0);
 });
 it('retries legacy only when jobs mode is unsupported',async()=>{
  const {c}=context();let requests:any[]=[];c.callTool=async(_n:string,args:any)=>{requests.push(args);return args.historyMode?{isError:true,content:[{type:'text',text:'-32602 Unrecognized key historyMode'}]}:{kind:'dashboard'}};
  await vm.runInContext('dashboardRead({scope:"all"})',c);expect(requests).toHaveLength(2);expect(requests[0].historyMode).toBe('jobs');expect(requests[1].historyMode).toBeUndefined();
  requests=[];c.callTool=async(_n:string,args:any)=>{requests.push(args);return {isError:true,content:[{type:'text',text:'FORBIDDEN'}]}};
  await expect(vm.runInContext('dashboardRead({scope:"all"})',c)).rejects.toThrow();expect(requests).toHaveLength(1);
 });
});
