import vm from 'node:vm';
import {describe,expect,it} from 'vitest';
import {DASHBOARD_CARD_HTML,reconcileDashboardPageCaches} from '../src/dashboardCard.js';
function load(name:string,c:vm.Context){const line=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x));expect(line).toBeDefined();vm.runInContext(line!,c)}
function fixture(initial='running',busy=false){
 const el=()=>({hidden:false,textContent:'',classList:{remove(){},add(){}},setAttribute(){}}),elements:any=new Proxy({}, {get(t:any,k:string){return t[k]??=el()}}),requests:any[]=[],visible:any={active:['old-current'],terminal:['old-all']},pending:any[]=[];
 const view={historyIncluded:false,historyModeApplied:'jobs',generatedAt:'2026-10-15T00:00:00Z',historyPolicy:{},counts:{progressJobCount:2,running:1,inputRequired:0,approvalRequired:0,terminating:0,backgroundProcesses:0},backgroundRevision:'owners',backgroundRows:[{rowKey:'owner'}],backgroundPagination:{offset:0,returned:1,total:2,hasNext:true},pagination:{active:{offset:0,returned:1,total:2,hasNext:true},terminal:{offset:0,returned:1,total:2,hasNext:true},idle:{offset:0,total:0}},activeRows:[{jobId:'live',bucket:'active'}],terminalRows:[]};
 const c=vm.createContext({view,selectedStatus:initial,busy,mounted:true,problemMutationInFlight:false,historyLoadQueued:false,hydrationEpoch:1,historySecurityGeneration:0,historyDetails:new Map(),executionDetails:new Map(),executionRequests:new Map(),executionErrors:new Map(),expandedExecutions:new Set(),historyRequestTokens:new Map(),historyLoading:new Set(),enrichmentTarget:null,cancelPending(){},standardBridgeInitialized:true,selectedScope:'all',widgetInstanceId:'widget',PAGE_LIMIT:12,automaticRefreshDisabled:false,refreshFailed:false,appendRequest:null,historyActiveRows:[{jobId:'cached-active'}],historyTerminalRows:[{jobId:'cached-previous-history'}],activeRows:[],terminalRows:[],terminalPagination:{offset:0,returned:1,total:2,hasNext:true},idleRows:[],idlePagination:null,lastRenderedAt:0,scopeReady:false,conversationAvailable:false,reconcileDashboardPageCaches,effectiveLocaleTag:()=> 'en',setLocale(){},enrichmentFailed:false,enrichmentRunning:false,localeTag:'en',elements,document:{getElementById:el,querySelectorAll:()=>[]},t:new Proxy({}, {get:(_t,k)=>String(k)}),uiText:(_k:string,f:string)=>f,formatNumber:String,agentCountText:String,problemQuery:()=>({}),closeWorkDetails(){},syncStatusFilter(){},syncProblemControls(){},syncLoadMoreControls(){},scheduleHistoryExpiry(){},scheduleTimeUpdates(){},stopTimeUpdates(){},syncScope(){},renderProblems(){},renderHistoryPolicy(){},prepareWorkControlPaint(){},renderWeeklyUsage(){},finishWorkControlPaint(){},runtimeDetailsIncomplete:()=>false,detailsIncomplete:()=>false,scheduleSizeChanged(){},jobRowVisible:()=>true,renderActivityRows:(list:any,rows:any[])=>{if(list===elements.activeList)visible.active=rows.slice();else visible.terminal=rows.slice()},dashboardRead:async(args:any)=>{requests.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}))},queueEnrichment(){},unwrap:(x:any)=>x});
 for(const name of ['rowIdentity','mergeRows','hasMoreRunning','retainExpandedPages','applyLocalStatus','backgroundStatusUnknown','paint','render','setBusy','showError','refreshExpandedRunning','reload','selectStatus','loadMoreRunning','loadMoreBackground','loadMore','supersedeRequests'])load(name,c);
 return {c,visible,requests,pending,elements};
}
describe('actual History selection, paint and failed reload composition',()=>{
 for(const initial of ['all','running'])it(`clears ${initial} content immediately and after History read fails`,async()=>{
  const f=fixture(initial),p=vm.runInContext('selectStatus("history")',f.c);
  expect(f.c.selectedStatus).toBe('history');expect(f.requests[0].includeHistory).toBe(true);
  const immediate={active:f.visible.active.slice(),terminal:f.visible.terminal.slice()};
  f.pending[0].reject(Error('offline'));await p;
  expect(immediate.active).toEqual([]);expect(immediate.terminal).toEqual([]);
  expect(f.visible.active).toEqual([]);expect(f.visible.terminal).toEqual([]);expect(f.c.busy).toBe(false);expect(f.c.refreshFailed).toBe(true);
 });
 it('clears omitted content while a busy read queues History',async()=>{const f=fixture('running',true);await vm.runInContext('selectStatus("history")',f.c);expect(f.c.historyLoadQueued).toBe(true);expect(f.requests).toHaveLength(0);expect(f.visible.active).toEqual([]);expect(f.visible.terminal).toEqual([])});
});

async function until(predicate:()=>boolean){for(let i=0;i<40&&!predicate();i++)await Promise.resolve();expect(predicate()).toBe(true)}
function firstPage(f:ReturnType<typeof fixture>){return {...f.c.view,historyIncluded:true,activeRows:[],terminalRows:[{jobId:'history-job',rowKey:'history-job',bucket:'recent'}],idleRows:[]}}
describe('queued History drains through actual busy controllers',()=>{
 for(const owner of ['Running','Background'])for(const fail of [false,true])it(`${owner} ${fail?'failure':'success'} drains exactly one History read`,async()=>{
  const f=fixture(owner.toLowerCase()),append=vm.runInContext(`loadMore${owner}()`,f.c);
  await vm.runInContext('selectStatus("history")',f.c);expect(f.c.historyLoadQueued).toBe(true);
  if(fail)f.pending[0].reject(Error('append failed'));else f.pending[0].resolve({...f.c.view,activeRows:[],pagination:{...f.c.view.pagination,active:{offset:1}},backgroundRows:[],backgroundPagination:{hasNext:false}});
  await append;await until(()=>f.requests.length===2);
  expect(f.requests[1].includeHistory).toBe(true);expect(f.requests[1].terminalOffset).toBe(0);expect(f.c.busy).toBe(true);
  f.pending[1].resolve(firstPage(f));await until(()=>!f.c.busy);
  expect(f.requests).toHaveLength(2);expect(f.visible.terminal.map((r:any)=>r.jobId)).toEqual(['history-job']);expect(f.c.historyLoadQueued).toBe(false);
 });
 for(const owner of ['Running','Background'])for(const cancel of ['selection','unmount','scope','epoch'])it(`${owner} does not fetch stale History after ${cancel} change`,async()=>{
  const f=fixture(owner.toLowerCase()),append=vm.runInContext(`loadMore${owner}()`,f.c);
  await vm.runInContext('selectStatus("history")',f.c);
  if(cancel==='selection')await vm.runInContext('selectStatus("running")',f.c);
  if(cancel==='unmount')f.c.mounted=false;
  if(cancel==='scope'){f.c.selectedScope='conversation';f.c.hydrationEpoch++;f.c.busy=true}
  if(cancel==='epoch'){f.c.hydrationEpoch++;f.c.busy=true}
  f.pending[0].resolve({...f.c.view,pagination:{...f.c.view.pagination,active:{offset:1}},backgroundRows:[],backgroundPagination:{hasNext:false}});await append;await Promise.resolve();await Promise.resolve();
  expect(f.requests).toHaveLength(1);if(cancel==='scope'||cancel==='epoch')expect(f.c.busy).toBe(true);
 });
 for(const change of ['count','policy'])it(`Running ${change} change yields its rebase to queued History`,async()=>{
  const f=fixture('running'),append=vm.runInContext('loadMoreRunning()',f.c);
  await vm.runInContext('selectStatus("history")',f.c);
  f.pending[0].resolve({...f.c.view,counts:{...f.c.view.counts,...(change==='count'?{progressJobCount:2}:{})},historyPolicy:change==='policy'?{policyRevision:'changed'}:f.c.view.historyPolicy,pagination:{...f.c.view.pagination,active:{offset:1}},activeRows:[]});
  await append;await until(()=>f.requests.length===2);
  expect(f.requests[1].includeHistory).toBe(true);expect(f.requests[1].terminalOffset).toBe(0);
  f.pending[1].resolve(firstPage(f));await until(()=>!f.c.busy);
  expect(f.requests).toHaveLength(2);expect(f.c.historyLoadQueued).toBe(false);
 });
 it('lets reload finish an already queued History read without duplication',async()=>{
  const f=fixture('running'),p=vm.runInContext('reload(true,false)',f.c);await vm.runInContext('selectStatus("history")',f.c);
  f.pending[0].resolve(firstPage(f));await p;await Promise.resolve();expect(f.requests).toHaveLength(1);expect(f.c.busy).toBe(false);expect(f.c.historyLoadQueued).toBe(false);
 });
 it('drains History when a generic page fails after an omitted hydration arrives',async()=>{
  const f=fixture('history');f.c.view.historyIncluded=true;const p=vm.runInContext('loadMore("terminal")',f.c);
  f.c.view={...f.c.view,historyIncluded:false};await vm.runInContext('selectStatus("running")',f.c);await vm.runInContext('selectStatus("history")',f.c);
  f.pending[0].reject(Error('page failed'));await p;await until(()=>f.requests.length===2);expect(f.requests[1].includeHistory).toBe(true);
  f.pending[1].resolve(firstPage(f));await until(()=>!f.c.busy);expect(f.requests).toHaveLength(2);
 });
});
describe('shared busy release ownership fences',()=>{
 it('does not duplicate a replacement reload that acquires busy during append release',async()=>{
  const f=fixture('background'),append=vm.runInContext('loadMoreBackground()',f.c);await vm.runInContext('selectStatus("history")',f.c);
  let replacement:Promise<any>|undefined,fired=false;
  f.elements.card.setAttribute=()=>{if(!f.c.busy&&!fired){fired=true;replacement=vm.runInContext('reload(true,false)',f.c)}};
  f.pending[0].resolve({...f.c.view,pagination:{...f.c.view.pagination,active:{offset:1}},backgroundRows:[],backgroundPagination:{hasNext:false}});await append;await until(()=>f.requests.length===2);
  expect(f.c.busy).toBe(true);expect(f.requests[1].includeHistory).toBe(true);
  f.pending[1].resolve(firstPage(f));await replacement;await Promise.resolve();expect(f.requests).toHaveLength(2);expect(f.c.busy).toBe(false);expect(f.c.historyLoadQueued).toBe(false);
 });
 it('keeps the ordinary Background rebase as the only replacement read',async()=>{
  const f=fixture('background'),append=vm.runInContext('loadMoreBackground()',f.c);
  f.pending[0].resolve({...f.c.view,backgroundRevision:'changed',backgroundRows:[],backgroundPagination:{hasNext:false}});await until(()=>f.requests.length===2);
  expect(f.requests[1].includeHistory).toBe(false);expect(f.c.busy).toBe(true);
  f.pending[1].resolve({...f.c.view,backgroundRevision:'changed'});await append;expect(f.requests).toHaveLength(2);expect(f.c.busy).toBe(false);
 });
 it('lets History selected during Background rebase release replace that rebase with one History read',async()=>{
  const f=fixture('background'),append=vm.runInContext('loadMoreBackground()',f.c);let fired=false;
  f.elements.card.setAttribute=()=>{if(!f.c.busy&&!fired){fired=true;void vm.runInContext('selectStatus("history")',f.c)}};
  f.pending[0].resolve({...f.c.view,backgroundRevision:'changed',backgroundRows:[],backgroundPagination:{hasNext:false}});await append;await until(()=>f.requests.length===2);
  expect(f.requests[1].includeHistory).toBe(true);expect(f.c.busy).toBe(true);f.pending[1].resolve(firstPage(f));await until(()=>!f.c.busy);expect(f.requests).toHaveLength(2);
 });
 it('coalesces repeated release notifications and drops a superseded queued read',async()=>{
  const f=fixture('history',true);f.c.historyLoadQueued=true;vm.runInContext('setBusy(false);setBusy(false)',f.c);await until(()=>f.requests.length===1);
  f.pending[0].resolve(firstPage(f));await until(()=>!f.c.busy);expect(f.requests).toHaveLength(1);
  f.c.historyLoadQueued=true;f.c.view.historyIncluded=false;vm.runInContext('setBusy(false)',f.c);f.c.hydrationEpoch++;f.c.busy=true;await Promise.resolve();expect(f.requests).toHaveLength(1);expect(f.c.busy).toBe(true);
 });
});

describe('host-context supersession',()=>{
 it('clears queued intent and preserves the new request busy state when an old append completes',async()=>{
  const f=fixture('running'),append=vm.runInContext('loadMoreRunning()',f.c);await vm.runInContext('selectStatus("history")',f.c);
  vm.runInContext('supersedeRequests("host context changed")',f.c);expect(f.c.historyLoadQueued).toBe(false);
  f.c.view=null;const replacement=vm.runInContext('reload(true,false)',f.c);expect(f.requests).toHaveLength(2);
  f.pending[0].resolve({activeRows:[],pagination:{active:{}}});await append;await Promise.resolve();expect(f.c.busy).toBe(true);expect(f.requests).toHaveLength(2);
  f.pending[1].reject(Error('replacement failed'));await replacement;expect(f.c.busy).toBe(false);expect(f.requests).toHaveLength(2);
 });
});
describe('queued History read failure',()=>{
 it('releases busy without retrying forever when the drained History read fails',async()=>{
  const f=fixture('running'),append=vm.runInContext('loadMoreRunning()',f.c);await vm.runInContext('selectStatus("history")',f.c);
  f.pending[0].reject(Error('append failed'));await append;await until(()=>f.requests.length===2);f.pending[1].reject(Error('history failed'));await until(()=>!f.c.busy);
  await Promise.resolve();expect(f.requests).toHaveLength(2);expect(f.c.historyLoadQueued).toBe(false);expect(f.c.refreshFailed).toBe(true);expect(f.visible.terminal).toEqual([]);
 });
});
