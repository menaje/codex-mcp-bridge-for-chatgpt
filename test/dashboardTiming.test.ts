import vm from 'node:vm';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
import {SUPPORTED_UI_LOCALES, UI_TRANSLATIONS} from '../src/generated/localization.js';

function define(context: vm.Context, name: string) {
  const line=DASHBOARD_CARD_HTML.split('\n').find(value=>value.trimStart().startsWith(`function ${name}(`));
  expect(line).toBeDefined();vm.runInContext(line!,context);
}
function timingContext(locale='ko', extra:Record<string,unknown>={}) {
  const context=vm.createContext({Date,Intl,localeTag:locale,t:UI_TRANSLATIONS[locale as keyof typeof UI_TRANSLATIONS],
    formatNumber:(value:number)=>new Intl.NumberFormat(locale).format(value),...extra});
  for(const name of ['durationUnit','formatDuration','relativeTime','timeMeta'])define(context,name);
  return context;
}
function time(turn:Record<string,unknown>, status?:string, locale='ko') {
  return vm.runInContext('timeMeta(turn,status)',timingContext(locale,{turn,status})) as string;
}
const startedAt='2026-10-15T00:00:00Z',updatedAt='2026-10-15T00:04:59Z';

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-10-15T00:05:00Z')});
afterEach(()=>vi.useRealTimers());

describe('dashboard work timestamps',()=>{
  for(const locale of SUPPORTED_UI_LOCALES)it(`uses the shared relative start format for every ongoing status in ${locale}`,()=>{
    for(const [elapsed,amount,unit] of [[300_000,5,'minute'],[7_200_000,2,'hour'],[259_200_000,3,'day']] as const) {
      vi.setSystemTime(Date.parse(startedAt)+elapsed);
      const expected=UI_TRANSLATIONS[locale]['history.started'].replace('{relative}',
        new Intl.RelativeTimeFormat(locale,{numeric:'auto'}).format(-amount,unit));
      for(const status of ['running','input-required','approval-required','terminating','termination-failed','liveness-unknown','orphaned','background-process-running']) {
        // Health overrides and last-update/duration values must not change the start reference.
        expect(time({status:'running',startedAt,updatedAt,durationMs:599000},status,locale)).toBe(expected);
      }
    }
  });
  it('shows concise Korean start and completed labels',()=>{
    expect(time({status:'running',startedAt,updatedAt})).toBe('5분 전 시작');
    expect(UI_TRANSLATIONS.ko['dashboard.status.completed']).toBe('완료');
  });
  it.each([undefined,null,'','invalid'])('omits an unavailable start (%s) instead of deriving one from duration or last update',started=>{
    expect(time({status:'running',startedAt:started,updatedAt,durationMs:599000})).toBe('');
  });
  it('preserves finished duration and relative completion time even if a row still has an active status',()=>{
    const endedAt=new Date(Date.now()-86400000).toISOString();
    const expected=UI_TRANSLATIONS.ko['dashboard.time.duration'].replace('{duration}','2'+UI_TRANSLATIONS.ko['dashboard.duration.minutes'].replace('{count}',''));
    const result=time({status:'completed',startedAt,updatedAt,endedAt,durationMs:120000},'running');
    expect(result).toContain(expected);expect(result).toContain(' · ');expect(result).not.toContain('시작');
    expect(time({status:'failed',updatedAt,endedAt,durationMs:null})).toContain(UI_TRANSLATIONS.ko['dashboard.time.durationUnknown']);
  });
  it('updates existing labels without repainting controls or reading the server, and stops off screen',()=>{
    const nodes:Array<{textContent:string;turnTime?:unknown}>=[],scheduleSizeChanged=vi.fn();
    const context=timingContext('ko',{mounted:true,tornDown:false,view:{},timeRefreshTimer:null,setTimeout,clearTimeout,scheduleSizeChanged,
      node:(_tag:string,_className:string,textContent:string)=>({textContent}),
      document:{visibilityState:'visible',querySelectorAll:()=>nodes,querySelector:()=>nodes[0]},
      paint:()=>{throw new Error('Clock must not repaint controls')},dashboardRead:()=>{throw new Error('Clock must not read the server')},
      turn:{status:'running',startedAt,updatedAt},
      ended:{status:'completed',endedAt:startedAt,updatedAt,durationMs:120000}});
    for(const name of ['timeNode','refreshTimeLabels','stopTimeUpdates','scheduleTimeUpdates'])define(context,name);
    nodes.push(vm.runInContext('timeNode(turn,"running")',context),vm.runInContext('timeNode(ended,"completed")',context));
    const first=nodes[0],finished=nodes[1],finishedText=finished.textContent;
    vm.runInContext('scheduleTimeUpdates()',context);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(nodes[0]).toBe(first);expect(first.textContent).toBe('6분 전 시작');
    expect(nodes[1]).toBe(finished);expect(finished.textContent).not.toBe(finishedText);
    expect(finished.textContent).toContain('작업시간 2분');expect(scheduleSizeChanged).toHaveBeenCalledTimes(1);
    context.document.visibilityState='hidden';vm.runInContext('scheduleTimeUpdates()',context);expect(vi.getTimerCount()).toBe(0);
    context.document.visibilityState='visible';vm.runInContext('refreshTimeLabels();scheduleTimeUpdates()',context);expect(vi.getTimerCount()).toBe(1);
    context.mounted=false;vm.runInContext('scheduleTimeUpdates()',context);expect(vi.getTimerCount()).toBe(0);
    context.mounted=true;context.tornDown=true;vm.runInContext('scheduleTimeUpdates()',context);expect(vi.getTimerCount()).toBe(0);
    context.tornDown=false;nodes.length=0;vm.runInContext('scheduleTimeUpdates()',context);expect(vi.getTimerCount()).toBe(0);
  });
});
