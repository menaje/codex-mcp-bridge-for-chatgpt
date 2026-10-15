import vm from 'node:vm';
import {describe,it,expect} from 'vitest';
import {DASHBOARD_CARD_HTML,reconcileDashboardPageCaches} from '../src/dashboardCard.js';

const row=(id:string)=>({rowKey:id,jobId:id,bucket:id.startsWith('R')?'active':'recent',status:id.startsWith('R')?'running':'failed'});
const rows=(prefix:string)=>Array.from({length:24},(_,i)=>row(prefix+(24-i)));
const page=(offset=0)=>({offset,limit:12,returned:12,total:24,hasPrevious:offset>0,hasNext:offset===0});
function snapshot(offset=0){
 const history=rows('H'),problemRows=history.slice(offset,offset+12).map(r=>({problemKey:r.jobId,jobId:r.jobId,row:r}));
 return {statusFilter:'all',generatedAt:'2026-10-15T00:00:00Z',scope:'conversation',filter:{mode:'conversation'},historyModeApplied:'jobs',progressRevision:'progress-a',executionHistoryRevision:'history-a',
  historyIncluded:true,historyPolicy:{policyRevision:'policy-a',totalRemoved:0},counts:{progressJobCount:24,executionCount:24},activeRows:rows('R').slice(offset,offset+12),terminalRows:history.slice(offset,offset+12),idleRows:[],
  pagination:{active:page(offset),terminal:page(offset),idle:{offset:0,total:0,hasNext:false}},
  problems:{revision:'problems-a',query:{kind:'all',offset},rows:problemRows,page:page(offset)}};
}
function context(first=snapshot()){
 const c=vm.createContext({view:first,busy:false,mounted:true,selectedScope:'conversation',selectedStatus:'running',hydrationEpoch:1,widgetInstanceId:'test',PAGE_LIMIT:12,appendRequest:null,
  lastRenderedAt:0,lastRefreshAt:0,automaticRefreshDisabled:false,refreshFailed:false,enrichmentFailed:false,enrichmentTarget:null,enrichmentRunning:false,
  historyTerminalRows:first.terminalRows.slice(),historyActiveRows:[],idleRows:[],terminalPagination:first.pagination.terminal,idlePagination:first.pagination.idle,
  elements:{message:{textContent:'',classList:{remove:()=>{}}}},t:{},unwrap:(x:any)=>x,rowIdentity:(r:any)=>r.rowKey,problemQuery:()=>({kind:'all',offset:0}),jobRowVisible:()=>true,
  mergeRows:(a:any[],b:any[])=>[...new Map([...a,...b].map(r=>[r.rowKey,r])).values()],reconcileDashboardPageCaches,
  setBusy:(value:boolean)=>{c.busy=value},setLocale:()=>{},effectiveLocaleTag:()=>'',paint:(next:any)=>{c.view=next},queueEnrichment:()=>{},showError:(e:any)=>{throw e}});
 for(const name of ['hasMoreRunning','retainExpandedPages','render','reload','loadMoreRunning','loadMore','loadMoreProblems'])define(c,name);
 return c;
}
function define(c:vm.Context,name:string){const source=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x));expect(source).toBeDefined();vm.runInContext(source!,c)}
const ids=(list:any[])=>list.map(r=>r.jobId);

describe('Dashboard tab pagination consistency',()=>{
 it.each(['running','history'])('rebases %s on changed membership even when count and policy are unchanged',async tab=>{
  const c=context();c.selectedStatus=tab;const fresh=snapshot(),next=snapshot(12),calls:any[]=[];
  if(tab==='running'){fresh.progressRevision=next.progressRevision='progress-b';fresh.activeRows=[row('R25'),...rows('R').slice(0,11)];next.activeRows=rows('R').slice(11,23)}
  else {fresh.executionHistoryRevision=next.executionHistoryRevision='history-b';fresh.terminalRows=[row('H25'),...rows('H').slice(0,11)];next.terminalRows=rows('H').slice(11,23)}
  c.dashboardRead=async(args:any)=>{calls.push(args);return args.statusOffset>0||args.terminalOffset>0?next:fresh};
  await vm.runInContext(tab==='running'?'loadMoreRunning()':'loadMore("terminal")',c);
  expect(calls).toHaveLength(2);expect(calls[1].statusOffset??calls[1].terminalOffset).toBe(0);
  const displayed=tab==='running'?c.view.activeRows:c.historyTerminalRows;expect(ids(displayed)).toEqual(ids(tab==='running'?fresh.activeRows:fresh.terminalRows));expect(displayed).toHaveLength(12);
 });
 it('preserves expanded rows and offsets in all three tabs on unchanged first-page refresh',()=>{
  const first=snapshot(12);first.activeRows=rows('R');first.terminalRows=rows('H');first.problems.rows=rows('H').map(r=>({problemKey:r.jobId,jobId:r.jobId,row:r}));
  const c=context(first),next=snapshot();next.activeRows[0]={...next.activeRows[0],status:'input-required'};c.next=next;vm.runInContext('render(next)',c);
  expect(ids(c.view.activeRows)).toEqual(ids(rows('R')));expect(c.view.activeRows[0].status).toBe('input-required');expect(c.view.pagination.active.offset).toBe(12);
  expect(ids(c.historyTerminalRows)).toEqual(ids(rows('H')));expect(c.terminalPagination.offset).toBe(12);expect(c.view.problems.rows).toHaveLength(24);expect(c.view.problems.page.offset).toBe(12);
 });
 it('drops stale expanded history even when the changed history body was omitted',()=>{
  const first=snapshot(12);first.terminalRows=rows('H');const c=context(first),omitted=snapshot();omitted.historyIncluded=false;omitted.terminalRows=[];omitted.executionHistoryRevision='history-b';c.next=omitted;
  vm.runInContext('render(next)',c);expect(c.historyTerminalRows).toHaveLength(0);
  const fresh=snapshot();fresh.executionHistoryRevision='history-b';fresh.terminalRows=[row('H25'),...fresh.terminalRows.slice(0,11)];c.next=fresh;vm.runInContext('render(next)',c);
  expect(c.historyTerminalRows).toHaveLength(12);expect(c.historyTerminalRows[0].jobId).toBe('H25');expect(c.terminalPagination.offset).toBe(0);
 });
 it('replaces a shorter first problem page when no additional page was expanded',()=>{
  const c=context(),next=snapshot();next.problems.rows=next.problems.rows.slice(0,1);c.next=next;
  vm.runInContext('render(next)',c);expect(c.view.problems.rows).toHaveLength(1);
 });
 it.each(['progressRevision','executionHistoryRevision','policy','mode','scope','missingRevision'])('does not retain an expanded bucket across a %s boundary',boundary=>{
  const first=snapshot(12);first.activeRows=rows('R');first.terminalRows=rows('H');const c=context(first),next:any=snapshot();
  if(boundary==='policy')next.historyPolicy.policyRevision='policy-b';else if(boundary==='mode')next.historyModeApplied='agents';else if(boundary==='scope')next.scope='bridge-wide';else if(boundary==='missingRevision'){delete next.progressRevision;delete next.executionHistoryRevision}else next[boundary]+='-changed';
  c.next=next;const retained=vm.runInContext('retainExpandedPages(next,view)',c);
  if(boundary!=='executionHistoryRevision')expect(retained.activeRows).toHaveLength(12);
  if(boundary!=='progressRevision')expect(retained.terminalRows).toHaveLength(12);
 });
 it('does not display or request More when pagination has reached its end',async()=>{
  const c=context();c.view.pagination.active.hasNext=false;let calls=0;c.dashboardRead=async()=>{calls++;return snapshot()};
  expect(vm.runInContext('hasMoreRunning(view)',c)).toBe(false);await vm.runInContext('loadMoreRunning()',c);expect(calls).toBe(0);
 });
 it('keeps appended running rows when a pending first-page enrichment finishes',async()=>{
  const c=context();define(c,'queueEnrichment');define(c,'drainEnrichment');let resolve!:(value:any)=>void;const calls:any[]=[];
  c.dashboardRead=(args:any)=>{calls.push(args);if(args.enrich)return new Promise(r=>resolve=r);const next=snapshot(args.statusOffset||0);if(args.statusOffset)next.statusFilter='running';return Promise.resolve(next)};
  vm.runInContext('queueEnrichment({scope:selectedScope,statusFilter:"all"},hydrationEpoch)',c);
  await vm.runInContext('loadMoreRunning()',c);expect(c.view.activeRows).toHaveLength(24);
  resolve(snapshot());for(let i=0;i<10&&c.enrichmentRunning;i++)await new Promise(r=>setTimeout(r,0));
  expect(c.enrichmentRunning).toBe(false);expect(calls).toHaveLength(3);expect(ids(c.view.activeRows)).toEqual(ids(rows('R')));expect(c.view.pagination.active.hasNext).toBe(false);
 });
});
