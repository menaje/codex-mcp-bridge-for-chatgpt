import vm from 'node:vm';
import {describe,expect,it} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
function load(name:string,c:vm.Context){const line=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x));expect(line).toBeDefined();vm.runInContext(line!,c)}
function fixture(initial='running',busy=false){
 const el=()=>({hidden:false,textContent:'',classList:{remove(){},add(){}},setAttribute(){}}),elements:any=new Proxy({}, {get(t:any,k:string){return t[k]??=el()}}),requests:any[]=[],visible:any={active:['old-current'],terminal:['old-all']},pending:any[]=[];
 const view={historyIncluded:false,historyModeApplied:'jobs',generatedAt:'2026-10-15T00:00:00Z',historyPolicy:{},counts:{running:1,inputRequired:0,approvalRequired:0,terminating:0,backgroundProcesses:0},pagination:{active:{},terminal:{total:1}},activeRows:[{jobId:'live',bucket:'active'}],terminalRows:[]};
 const c=vm.createContext({view,selectedStatus:initial,busy,mounted:true,problemMutationInFlight:false,historyLoadQueued:false,hydrationEpoch:1,selectedScope:'all',widgetInstanceId:'widget',PAGE_LIMIT:12,automaticRefreshDisabled:false,refreshFailed:false,appendRequest:null,historyActiveRows:[{jobId:'cached-active'}],historyTerminalRows:[{jobId:'cached-previous-history'}],activeRows:[],terminalRows:[],terminalPagination:{total:1},enrichmentFailed:false,localeTag:'en',elements,document:{getElementById:el,querySelectorAll:()=>[]},t:new Proxy({}, {get:(_t,k)=>String(k)}),uiText:(_k:string,f:string)=>f,formatNumber:String,agentCountText:String,problemQuery:()=>({}),closeWorkDetails(){},syncStatusFilter(){},syncProblemControls(){},syncLoadMoreControls(){},scheduleHistoryExpiry(){},syncScope(){},renderProblems(){},renderHistoryPolicy(){},prepareWorkControlPaint(){},renderWeeklyUsage(){},finishWorkControlPaint(){},runtimeDetailsIncomplete:()=>false,detailsIncomplete:()=>false,scheduleSizeChanged(){},jobRowVisible:()=>true,renderActivityRows:(list:any,rows:any[])=>{if(list===elements.activeList)visible.active=rows.slice();else visible.terminal=rows.slice()},dashboardRead:async(args:any)=>{requests.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}))},queueEnrichment(){},unwrap:(x:any)=>x,render(){throw Error('success path not used')}});
 for(const name of ['applyLocalStatus','paint','setBusy','showError','reload','selectStatus'])load(name,c);
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
