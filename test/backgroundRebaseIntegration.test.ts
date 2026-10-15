import vm from 'node:vm';
import {describe,expect,it} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
function load(name:string,c:vm.Context){const line=DASHBOARD_CARD_HTML.split('\n').find(value=>new RegExp('^\\s*(async )?function '+name+'\\(').test(value));expect(line).toBeDefined();vm.runInContext(line!,c)}
function fixture(){
 const old={backgroundRows:Array.from({length:12},(_,i)=>({rowKey:'old-'+i})),backgroundRevision:'owners-v1',historyPolicy:{policyRevision:'policy-v1'},backgroundPagination:{offset:0,returned:12,total:13,hasNext:true}};
 const fresh={...old,backgroundRows:[{rowKey:'fresh-owner'}],backgroundRevision:'owners-v2',historyPolicy:{policyRevision:'policy-v2'},backgroundPagination:{offset:0,returned:1,total:1,hasNext:false}};
 const requests:any[]=[],errors:any[]=[],pending:Array<{resolve:(value:any)=>void;reject:(error:any)=>void}>=[];
 let paints=0,inFlight=0,maximum=0,releaseHook:(()=>void)|undefined;
 const c=vm.createContext({busy:false,mounted:true,view:old,hydrationEpoch:1,selectedStatus:'background',selectedScope:'all',widgetInstanceId:'widget',PAGE_LIMIT:12,appendRequest:null,automaticRefreshDisabled:false,refreshFailed:false,historyLoadQueued:false,lastRefreshAt:0,problemQuery:()=>({kind:'all',offset:0}),queueEnrichment:()=>{},elements:{message:{textContent:'',classList:{remove:()=>{}}}},t:{'common.error':'error','common.loading':'loading'},setBusy:(value:boolean)=>{c.busy=value;if(!value&&releaseHook){const hook=releaseHook;releaseHook=undefined;hook()}},unwrap:(x:any)=>x,paint:()=>{paints++},render:(next:any)=>{c.view=next;paints++},showError:(error:any)=>{errors.push(error)},dashboardRead:async(args:any)=>{requests.push(args);maximum=Math.max(maximum,++inFlight);try{return await new Promise((resolve,reject)=>pending.push({resolve,reject}))}finally{inFlight--}}});
 for(const name of ['rowIdentity','mergeRows','refreshExpandedRunning','reload','loadMoreBackground'])load(name,c);
 const next=(change:string)=>({backgroundRows:[{rowKey:'mismatching-page'}],backgroundRevision:change==='owners'?'owners-v2':'owners-v1',historyPolicy:{policyRevision:change==='policy'?'policy-v2':'policy-v1'},backgroundPagination:{offset:12,returned:1,total:13,hasNext:false}});
 return {c,old,fresh,requests,errors,pending,next,paintCount:()=>paints,maximum:()=>maximum,onRelease:(hook:()=>void)=>{releaseHook=hook}};
}
async function until(predicate:()=>boolean){for(let i=0;i<30&&!predicate();i++)await Promise.resolve();expect(predicate()).toBe(true)}
describe('actual Background append and reload composition',()=>{
 for(const change of ['owners','policy'])it(`rebases changed ${change} with a real first-page read after releasing append busy`,async()=>{
  const f=fixture(),p=vm.runInContext('loadMoreBackground()',f.c);f.pending[0].resolve(f.next(change));
  await until(()=>f.requests.length===2);expect(f.requests[0].backgroundOffset).toBe(12);expect(f.requests[1].backgroundOffset).toBeUndefined();expect(f.c.busy).toBe(true);
  f.pending[1].resolve(f.fresh);await p;expect(f.c.view.backgroundRows.map((r:any)=>r.rowKey)).toEqual(['fresh-owner']);expect(f.c.view.historyPolicy.policyRevision).toBe('policy-v2');expect(f.paintCount()).toBe(1);expect(f.c.busy).toBe(false);expect(f.maximum()).toBe(1);
 });
 it('preserves ordinary 12/12/1 appends without first-page reload',async()=>{
  const f=fixture();f.c.view.backgroundPagination.total=25;
  let p=vm.runInContext('loadMoreBackground()',f.c);f.pending[0].resolve({...f.next('none'),backgroundRows:Array.from({length:12},(_,i)=>({rowKey:'old-'+(i+12)})),backgroundPagination:{offset:12,returned:12,total:25,hasNext:true}});await p;
  p=vm.runInContext('loadMoreBackground()',f.c);f.pending[1].resolve({...f.next('none'),backgroundRows:[{rowKey:'old-24'}],backgroundPagination:{offset:24,returned:1,total:25,hasNext:false}});await p;
  expect(f.c.view.backgroundRows).toHaveLength(25);expect(new Set(f.c.view.backgroundRows.map((r:any)=>r.rowKey)).size).toBe(25);expect(f.requests.map(x=>x.backgroundOffset)).toEqual([12,24]);expect(f.c.busy).toBe(false);
 });
 it('allows only one append and prevents ordinary reload from overlapping it',async()=>{
  const f=fixture(),p=vm.runInContext('loadMoreBackground()',f.c);await vm.runInContext('loadMoreBackground()',f.c);await vm.runInContext('reload(true,false)',f.c);expect(f.requests).toHaveLength(1);
  f.pending[0].resolve(f.next('none'));await p;const r=vm.runInContext('reload(true,false)',f.c);expect(f.requests).toHaveLength(2);f.pending[1].resolve(f.fresh);await r;expect(f.c.busy).toBe(false);expect(f.maximum()).toBe(1);
 });
 it('does not append during an ordinary reload',async()=>{
  const f=fixture(),p=vm.runInContext('reload(true,false)',f.c);await vm.runInContext('loadMoreBackground()',f.c);expect(f.requests).toHaveLength(1);f.pending[0].resolve(f.fresh);await p;expect(f.c.busy).toBe(false);
 });
 for(const change of ['scope','unmount'])it(`cancels the deferred rebase on ${change} change at release`,async()=>{
  const f=fixture();f.onRelease(()=>{f.c.hydrationEpoch++;if(change==='scope'){f.c.selectedScope='conversation';f.c.view=f.fresh}else f.c.mounted=false});
  const p=vm.runInContext('loadMoreBackground()',f.c);f.pending[0].resolve(f.next('owners'));await p;expect(f.requests).toHaveLength(1);expect(f.c.busy).toBe(false);expect(f.paintCount()).toBe(0);
 });
 it('lets an ordinary reload take ownership during release without a duplicate rebase or premature busy clear',async()=>{
  const f=fixture();let replacement:Promise<any>|undefined;f.onRelease(()=>{replacement=vm.runInContext('reload(true,false)',f.c)});
  const p=vm.runInContext('loadMoreBackground()',f.c);f.pending[0].resolve(f.next('owners'));await p;
  expect(f.requests).toHaveLength(2);expect(f.c.busy).toBe(true);f.pending[1].resolve(f.fresh);await replacement;expect(f.c.busy).toBe(false);expect(f.maximum()).toBe(1);
 });
 for(const stage of ['append','rebase'])it(`releases controls when ${stage} fails`,async()=>{
  const f=fixture(),p=vm.runInContext('loadMoreBackground()',f.c);
  if(stage==='append')f.pending[0].reject(Error('append failed'));else{f.pending[0].resolve(f.next('policy'));await until(()=>f.pending.length===2);f.pending[1].reject(Error('reload failed'))}
  await p;expect(f.errors).toHaveLength(1);expect(f.c.busy).toBe(false);expect(f.c.view.backgroundRows).toHaveLength(12);
 });
 it('does not replace a newer generation when the first-page reply is late',async()=>{
  const f=fixture(),p=vm.runInContext('loadMoreBackground()',f.c);f.pending[0].resolve(f.next('owners'));await until(()=>f.pending.length===2);
  f.c.hydrationEpoch++;f.c.selectedScope='conversation';f.c.view=f.fresh;f.c.busy=false;
  f.pending[1].resolve({...f.old,backgroundRows:[{rowKey:'wrong-old-scope'}]});await p;expect(f.c.view).toBe(f.fresh);expect(f.c.busy).toBe(false);expect(f.paintCount()).toBe(0);
 });
});
