import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {DASHBOARD_CARD_HTML,groupDashboardRowsByActivity,groupDashboardRowsByAgent} from '../src/dashboardCard.js';
import {SUPPORTED_UI_LOCALES,UI_TRANSLATIONS} from '../src/generated/localization.js';
class Element {
  children: Element[] = []; dataset: Record<string,string> = {}; textContent = ''; hidden = false; open = false;
  constructor(readonly tag: string, readonly className = '', text = '') { this.textContent = text; }
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.append(item); return item; }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  texts(): string[] { return [this.textContent, ...this.children.flatMap(child => child.texts())]; }
}
function render(problems: any[], retentionDays = 0) {
  const element = () => new Element('div');
  const elements={section:element(),list:element(),empty:element(),page:element(),count:element()};
  const next={problems:{rows:problems,page:{offset:0,returned:problems.length,total:problems.length}},historyPolicy:{retentionDays}};
  const c=vm.createContext({Date,selectedStatus:'problems',problemElements:elements,node:(tag:string,cls:string,text:string)=>new Element(tag,cls,text),view:next,localeTag:'en',t:{'dashboard.agentCount':'{count} Agents','cancellation.reason':'Cancellation reason'},uiText:(_key:string,fallback:string)=>fallback,formatNumber:String,syncProblemControls(){},tone:()=>'',statusLabel:(status:string)=>status,groupDashboardRowsByActivity,groupDashboardRowsByAgent,appendRowContext(){},appendWorkControl(){},appendExecution:(parent:Element)=>parent.appendChild(new Element('div','','Model · high')),timeMeta:()=> 'Recorded time',rowMeta:()=>'',latestTurn:(row:any)=>row.latestTurn});
  for(const name of ['jobRowVisible','cancellationHeading','appendCancellation','timeNode','appendExecutionRecord','renderActivityGroup','renderActivityRows','retainedProblemRows','renderProblems']) {
    const line=DASHBOARD_CARD_HTML.split('\n').find(line=>line.trimStart().startsWith(`function ${name}(`));expect(line).toBeDefined();vm.runInContext(line!,c);
  }
  vm.runInContext('renderProblems(view)',c);
  return elements.list.texts();
}
function problem(status='failed', error: string|null='Recorded failure') {
  return {problemKey:'event',jobId:'internal-job-id',source:'execution',executionAvailability:'retained',reason:error,kind:status,observedAt:new Date().toISOString(),row:{error,rowKey:'row',jobId:'internal-job-id',agentId:'agent',agentName:'Agent name',activityKey:'activity',activityTitle:'Activity title',status,latestTurn:{status,error,...(status==='cancelled'?{cancellation:{reason:'Requested cancellation',targetKind:'job',requestedAt:new Date().toISOString()}}:{})}}};
}
describe('compact problem history presentation',()=>{
  for(const language of SUPPORTED_UI_LOCALES)it(`localizes both cancellation targets and every outcome in ${language}`,()=>{
    const translations=UI_TRANSLATIONS[language],parent=new Element('div');
    const context=vm.createContext({Date,localeTag:language,t:translations,node:(tag:string,cls:string,text:string)=>new Element(tag,cls,text)});
    for(const name of ['cancellationHeading','appendCancellation'])vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(line=>line.trimStart().startsWith(`function ${name}(`))!,context);
    for(const targetKind of ['activity','job'] as const)for(const status of ['requested','succeeded','failed'] as const){
      parent.replaceChildren();
      const reason='사용자가 취소를 요청했습니다.';
      context.parent=parent;context.cancellation={targetKind,status,reason,requestedAt:'2026-10-13T00:47:25.657Z'};
      vm.runInContext('appendCancellation(parent,cancellation)',context);
      const text=parent.texts(),heading=status==='requested'?'cancellation.requestReason':status==='failed'?'cancellation.attemptReason':'cancellation.reason';
      expect(text).toContain(translations[heading]);
      expect(text.some(value=>value.startsWith(translations[`cancellation.target.${targetKind}`]+' · '))).toBe(true);
      expect(text).toContain(reason);
      expect(text.join(' ')).not.toContain('Localized text');
    }
  });
  it('renders the recorded error once under its Activity and Agent',()=>{const text=render([problem()]);for(const name of ['Activity title','Agent name','Recorded failure'])expect(text.filter(x=>x===name)).toHaveLength(1);});
  it('shows cancellation prose only once and no missing-error placeholder',()=>{expect(render([problem('cancelled')]).filter(x=>x.includes('Requested cancellation'))).toHaveLength(1);for(const status of ['failed','interrupted'])expect(render([problem(status,null)]).join(' ')).not.toMatch(/unrecorded|Unrecorded|Cancellation reason/);});
  for(const status of ['failed','interrupted','cancelled'])for(const reason of [null,'',String.fromCharCode(32,10,9)])it(`omits absent or blank ${status} reasons while keeping its status`,()=>{const p=problem(status,reason);if(status==='cancelled'){if(reason===null)delete p.row.latestTurn.cancellation;else p.row.latestTurn.cancellation!.reason=reason;}const text=render([p]);expect(text).toContain(status);expect(text).toContain('Agent name');expect(text.join(' ')).not.toMatch(/unrecorded|Unrecorded|Cancellation reason|Requested cancellation/);});
  it('uses an actual recorded error when another error field is blank',()=>{const p=problem('failed','  ');p.row.error='실행 중 연결이 끊어졌습니다.';expect(render([p])).toContain(p.row.error);});
  it('omits IDs, exact-detail controls, repeated labels and recovery internals',()=>{const p={...problem(),progress:[{step:'internal-step',reason:'worker-protected'}]};const text=render([p]).join(' ');expect(text).not.toMatch(/internal-job-id|Execution details|Load exact|Recent Activity|internal-step|worker-protected/);});
  it('excludes completed Jobs, system/recovery events and expired Jobs',()=>{const expired=problem();expired.observedAt=new Date(Date.now()-31*86400000).toISOString();expect(render([expired,problem('completed'),{...problem(),source:'runtime'},{...problem(),source:'recovery'}],30)).not.toContain('Recorded failure');});
  it('groups several Jobs under one Agent and does not duplicate the same problem',()=>{const first=problem(),second=problem('interrupted','Interrupted message');second.jobId='second';second.row.jobId='second';second.row.rowKey='second';const text=render([first,{...first,problemKey:'duplicate'},second]);expect(text.filter(x=>x==='Agent name')).toHaveLength(1);expect(text.filter(x=>x==='Recorded failure')).toHaveLength(1);expect(text).toContain('Interrupted message');expect(text).toContain('1 Agents');});
});
