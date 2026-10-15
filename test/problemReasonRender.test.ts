import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';
class Element {
  children: Element[] = []; dataset: Record<string,string> = {}; textContent = ''; hidden = false; open = false;
  constructor(readonly tag: string, readonly className = '', text = '') { this.textContent = text; }
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.append(item); return item; }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  texts(): string[] { return [this.textContent, ...this.children.flatMap(child => child.texts())]; }
}
function render(problem: any, detail?: any) {
  const elements = new Map<string,Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id)!; };
  const next = {problems: {rows: [problem], page: {offset: 0, returned: 1, total: 1}}, historyPolicy: {retentionDays: 0}};
  const c = vm.createContext({document: {getElementById: element}, selectedStatus: 'problems', problemElements: {section: element('section'), list: element('list'), empty: element('empty'), page: element('page'), label: element('label')}, node: (tag:string,cls:string,text:string) => new Element(tag,cls,text), view: next, localeTag: 'en', t: {}, uiText: (_key:string,fallback:string) => fallback, formatNumber: String, syncProblemControls() {}, executionTarget: () => null, executionCached: () => detail, expandedExecutions: new Set(), executionErrors: new Map(), tone: () => '', statusLabel: (status:string) => status, scheduleSizeChanged() {}});
  for (const name of ['retainedProblemRows', 'problemContextReason', 'renderProblems']) {
    vm.runInContext(DASHBOARD_CARD_HTML.split('\n').find(line => line.trimStart().startsWith(`function ${name}(`))!,c);
  }
  const start = DASHBOARD_CARD_HTML.indexOf('    function appendExecutionRecord(');
  const end = DASHBOARD_CARD_HTML.indexOf('    function historyKey(',start);
  vm.runInContext(DASHBOARD_CARD_HTML.slice(start,end),c);
  vm.runInContext('renderProblems(view)',c);
  return element('list').texts();
}
function problem(status = 'failed', reason = 'Exact failure') {
  return {problemKey: 'event',jobId: 'job',source: 'execution',reason,kind: status,observedAt: '2026-09-10T00:00:00Z', row: {rowKey: 'row',status,latestTurn: {status,error: 'Exact failure',cancellation: {reason: 'Exact cancellation'}}}};
}
describe('actual problem and execution record rendering', () => {
  it('renders an exact execution failure only once', () => { expect(render(problem()).filter(x => x === 'Exact failure')).toHaveLength(1); });
  it('renders an exact cancellation reason only once', () => { expect(render(problem('cancelled','Exact cancellation')).filter(x => x.includes('Exact cancellation'))).toHaveLength(1); });
  it('preserves distinct runtime context and progress evidence', () => { const p = {...problem('failed','Worker recovery pending'),progress: [{at:'2026-09-10T00:00:00Z',reason:'Retry protected'}]}; const text = render(p); expect(text).toContain('Exact failure'); expect(text).toContain('Worker recovery pending'); expect(text.some(x => x.includes('Retry protected'))).toBe(true); });
  it('compares against the loaded exact detail', () => { expect(render(problem('failed','Detail failure'),{execution:{status:'failed',error:'Detail failure'}}).filter(x => x === 'Detail failure')).toHaveLength(1); });
  it('keeps a system incident reason even if its row has the same error', () => { const p = {...problem(),jobId:undefined,source:'runtime',executionAvailability:'not-linked'}; expect(render(p).filter(x => x === 'Exact failure')).toHaveLength(1); });
});
