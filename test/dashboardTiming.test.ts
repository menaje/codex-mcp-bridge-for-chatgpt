import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
import {SUPPORTED_UI_LOCALES, UI_TRANSLATIONS} from '../src/generated/localization.js';

function time(turn:Record<string,unknown>, status?:string, locale='ko') {
  const context=vm.createContext({Date,Intl,localeTag:locale,t:UI_TRANSLATIONS[locale as keyof typeof UI_TRANSLATIONS],
    formatNumber:(value:number)=>new Intl.NumberFormat(locale).format(value),turn,status});
  for(const name of ['durationUnit','formatDuration','relativeTime','timeMeta']) {
    const line=DASHBOARD_CARD_HTML.split('\n').find(value=>value.trimStart().startsWith(`function ${name}(`));
    expect(line).toBeDefined();vm.runInContext(line!,context);
  }
  return vm.runInContext('timeMeta(turn,status)',context) as string;
}
const startedAt='2026-10-14T23:10:00Z',updatedAt='2026-10-15T02:11:00Z';

describe('dashboard work timestamps',()=>{
  for(const locale of SUPPORTED_UI_LOCALES)it(`shows the recorded start date and time for every ongoing status in ${locale}`,()=>{
    const expected=UI_TRANSLATIONS[locale]['dashboard.time.started'].replace('{time}',
      new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(startedAt)));
    for(const status of ['running','input-required','approval-required','terminating','termination-failed','liveness-unknown','orphaned','background-process-running']) {
      // Runtime health can override the durable turn status on an active row.
      expect(time({status:'running',startedAt,updatedAt,durationMs:599000},status,locale)).toBe(expected);
    }
  });
  it.each([undefined,null,'','invalid'])('omits an unavailable start (%s) instead of deriving one from duration or last update',started=>{
    expect(time({status:'running',startedAt:started,updatedAt,durationMs:599000})).toBe('');
  });
  it('preserves finished duration and relative completion time even if a row still has an active status',()=>{
    const endedAt=new Date(Date.now()-86400000).toISOString();
    const expected=UI_TRANSLATIONS.ko['dashboard.time.duration'].replace('{duration}','2'+UI_TRANSLATIONS.ko['dashboard.duration.minutes'].replace('{count}',''));
    const result=time({status:'completed',startedAt,updatedAt,endedAt,durationMs:120000},'running');
    expect(result).toContain(expected);expect(result).toContain(' · ');expect(result).not.toContain('시작 ');
    expect(time({status:'failed',updatedAt,endedAt,durationMs:null})).toContain(UI_TRANSLATIONS.ko['dashboard.time.durationUnknown']);
  });
});
