import vm from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
const now=Date.UTC(2026,9,14),day=86400000;
afterEach(()=>vi.useRealTimers());
function load(name:string,context:vm.Context){const line=DASHBOARD_CARD_HTML.split('\n').find(x=>new RegExp('^\\s*(async )?function '+name+'\\(').test(x));expect(line).toBeDefined();vm.runInContext(line!,context);}
describe('PR257 independent review boundaries',()=>{
 it('keeps actual background work visible when the Job-mode status page contains only terminal history',()=>{
  const active={rowKey:'active',jobId:'live',bucket:'active',status:'running',backgroundProcessCount:1};
  const c=vm.createContext({selectedStatus:'background',activeRows:[],terminalRows:[],dashboardRowMatchesStatus:(r:any)=>r.backgroundProcessCount>0});
  load('applyLocalStatus',c);c.next={historyModeApplied:'jobs',activeRows:[active],terminalRows:[],statusRows:[]};vm.runInContext('applyLocalStatus(next)',c);
  expect(c.activeRows.map((x:any)=>x.jobId)).toEqual(['live']);
 });
 it('repaints a problem-only Job at its own expiry even when refreshing returns no new snapshot, then schedules the next boundary',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);let paints=0,reads=0;
  const failure={jobId:'old-failure',nextExpiryAt:new Date(now+1000).toISOString(),latestTurn:{endedAt:new Date(now-30*day+1000).toISOString()}};
  const next={historyModeApplied:'jobs',historyPolicy:{retentionDays:30},statusRows:[],activeRows:[],terminalRows:Array.from({length:12},()=>({nextExpiryAt:new Date(now+day).toISOString()})),problems:{rows:[{row:failure}]}};
  const c=vm.createContext({Date,setTimeout,clearTimeout,historyExpiryTimer:null,historyDetails:new Map(),executionDetails:new Map(),historyFresh:()=>true,executionFresh:()=>true,view:next,paint:()=>paints++,reload:async()=>{reads++}});
  load('scheduleHistoryExpiry',c);c.next=next;vm.runInContext('scheduleHistoryExpiry(next)',c);await vi.advanceTimersByTimeAsync(1000);
  expect(paints).toBe(1);expect(reads).toBe(1);
  // Cached stale data must not stop a later record's timer after the first expiry.
  vm.runInContext('scheduleHistoryExpiry(next)',c);await vi.advanceTimersByTimeAsync(day-1000);expect(paints).toBe(2);
 });
 it('hides expired execution incidents while retaining a fresh recovery event linked to the old Job',()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const old={source:'execution',occurredAt:new Date(now-30*day).toISOString(),reason:'expired error',row:{}};
  const recovery={source:'recovery',occurredAt:new Date(now).toISOString(),reason:'fresh recovery evidence',row:{}};
  const c=vm.createContext({Date});load('retainedProblemRows',c);c.rows=[old,recovery];c.next={historyPolicy:{retentionDays:30}};
  expect(vm.runInContext('retainedProblemRows(rows,next)',c)).toEqual([recovery]);
  c.next={historyPolicy:{retentionDays:0}};expect(vm.runInContext('retainedProblemRows(rows,next)',c)).toHaveLength(2);
 });

 for(const result of ['accept','scope-changed','owners-changed','policy-changed'])it(`pages bounded background owners and fences ${result}`,async()=>{
  const first=Array.from({length:12},(_,i)=>({rowKey:'owner-'+i})),last={rowKey:'owner-12'};let request:any,reloads=0,release!:(x:any)=>void;
  const c=vm.createContext({busy:false,mounted:true,view:{backgroundRows:first,backgroundRevision:'owners',historyPolicy:{policyRevision:'policy'},backgroundPagination:{offset:0,returned:12,total:13,hasNext:true}},hydrationEpoch:1,selectedStatus:'background',selectedScope:'all',widgetInstanceId:'widget',PAGE_LIMIT:12,setBusy:(value:boolean)=>{c.busy=value},unwrap:(x:any)=>x,dashboardRead:async(args:any)=>{request=args;return await new Promise(resolve=>{release=resolve})},mergeRows:(a:any[],b:any[])=>[...a,...b],paint:()=>{},reload:async()=>{reloads++},showError:()=>{},t:{'common.error':'error'}});
  load('loadMoreBackground',c);const pending=vm.runInContext('loadMoreBackground()',c);if(result==='scope-changed')c.hydrationEpoch=2;
  release({backgroundRows:[last],backgroundRevision:result==='owners-changed'?'different':'owners',historyPolicy:{policyRevision:result==='policy-changed'?'different':'policy'},backgroundPagination:{offset:12,returned:1,total:13,hasNext:false}});await pending;
  expect(request.backgroundOffset).toBe(12);expect(request.includeHistory).toBe(false);expect(request.enrich).toBe(true);
  expect(c.view.backgroundRows).toHaveLength(result==='accept'?13:12);expect(reloads).toBe(['owners-changed','policy-changed'].includes(result)?1:0);
 });

});
