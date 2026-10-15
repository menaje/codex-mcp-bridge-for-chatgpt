import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {DASHBOARD_CARD_HTML,groupDashboardRowsByActivity,groupDashboardRowsByAgent} from '../src/dashboardCard.js';
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
  for(const name of ['jobRowVisible','cancellationHeading','appendCancellation','appendExecutionRecord','renderActivityGroup','renderActivityRows','retainedProblemRows','renderProblems']) {
    const line=DASHBOARD_CARD_HTML.split('\n').find(line=>line.trimStart().startsWith(`function ${name}(`));expect(line).toBeDefined();vm.runInContext(line!,c);
  }
  vm.runInContext('renderProblems(view)',c);
  return elements.list.texts();
}
function problem(status='failed', error: string|null='Recorded failure') {
  return {problemKey:'event',jobId:'internal-job-id',source:'execution',executionAvailability:'retained',reason:error,kind:status,observedAt:new Date().toISOString(),row:{rowKey:'row',jobId:'internal-job-id',agentId:'agent',agentName:'Agent name',activityKey:'activity',activityTitle:'Activity title',status,latestTurn:{status,error,...(status==='cancelled'?{cancellation:{reason:'Requested cancellation',targetKind:'job',requestedAt:new Date().toISOString()}}:{})}}};
}
describe('compact problem history presentation',()=>{
  it('renders the recorded error once under its Activity and Agent',()=>{const text=render([problem()]);for(const name of ['Activity title','Agent name','Recorded failure'])expect(text.filter(x=>x===name)).toHaveLength(1);});
  it('shows cancellation prose only once and no missing-error placeholder',()=>{expect(render([problem('cancelled')]).filter(x=>x.includes('Requested cancellation'))).toHaveLength(1);for(const status of ['failed','interrupted'])expect(render([problem(status,null)]).join(' ')).not.toMatch(/unrecorded|Unrecorded|Cancellation reason/);});
  it('uses the missing-reason label only for a cancellation with no recorded reason',()=>{const p=problem('cancelled');delete p.row.latestTurn.cancellation;expect(render([p]).join(' ')).toContain('Cancellation reason: Unrecorded');});
  it('omits IDs, exact-detail controls, repeated labels and recovery internals',()=>{const p={...problem(),progress:[{step:'internal-step',reason:'worker-protected'}]};const text=render([p]).join(' ');expect(text).not.toMatch(/internal-job-id|Execution details|Load exact|Recent Activity|internal-step|worker-protected/);});
  it('excludes completed Jobs, system/recovery events and expired Jobs',()=>{const expired=problem();expired.observedAt=new Date(Date.now()-31*86400000).toISOString();expect(render([expired,problem('completed'),{...problem(),source:'runtime'},{...problem(),source:'recovery'}],30)).not.toContain('Recorded failure');});
  it('groups several Jobs under one Agent and does not duplicate the same problem',()=>{const first=problem(),second=problem('interrupted','Interrupted message');second.jobId='second';second.row.jobId='second';second.row.rowKey='second';const text=render([first,{...first,problemKey:'duplicate'},second]);expect(text.filter(x=>x==='Agent name')).toHaveLength(1);expect(text.filter(x=>x==='Recorded failure')).toHaveLength(1);expect(text).toContain('Interrupted message');expect(text).toContain('1 Agents');});
});
