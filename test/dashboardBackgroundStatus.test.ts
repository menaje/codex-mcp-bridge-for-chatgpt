import vm from 'node:vm';
import {describe,expect,it} from 'vitest';
import {DASHBOARD_CARD_HTML} from '../src/dashboardCard.js';

function unknown(counts:Record<string,number>,enrichment={},failed=false) {
  const context=vm.createContext({counts,enrichment,enrichmentFailed:failed});
  for(const name of ['runtimeDetailsIncomplete','backgroundStatusUnknown'])vm.runInContext(
    DASHBOARD_CARD_HTML.split('\n').find(line=>line.trimStart().startsWith(`function ${name}(`))!,context);
  return vm.runInContext('backgroundStatusUnknown(counts,enrichment)',context);
}
describe('background count confirmation',()=>{
  it('shows a confirmed zero even when foreground liveness is unavailable',()=>{
    expect(unknown({backgroundProcesses:0,backgroundProcessUnknownAgents:0,runtimeUnknownAgents:18,runtimeProbeSkippedAgents:0},
      {runtimeUnavailable:18,timeouts:1})).toBe(false);
  });
  it('keeps a partially confirmed positive count visible with its remaining uncertainty',()=>{
    expect(unknown({backgroundProcesses:2,backgroundProcessUnknownAgents:1,runtimeUnknownAgents:3,runtimeProbeSkippedAgents:0})).toBe(true);
  });
  it('does not claim completion while some background owners have not been inspected',()=>{
    expect(unknown({backgroundProcesses:0,backgroundProcessUnknownAgents:0,runtimeUnknownAgents:0,runtimeProbeSkippedAgents:503})).toBe(true);
  });
  it('does not show a confirmed zero when the live-worker inventory itself is unavailable',()=>{
    expect(unknown({backgroundProcesses:0,backgroundProcessUnknownAgents:0,runtimeUnknownAgents:0,runtimeProbeSkippedAgents:0},
      {backgroundInventoryUnavailable:true})).toBe(true);
  });
  it('retains compatibility with older snapshots that have no separate background coverage',()=>{
    expect(unknown({backgroundProcesses:0,runtimeUnknownAgents:1,runtimeProbeSkippedAgents:0})).toBe(true);
    expect(unknown({backgroundProcesses:0,runtimeUnknownAgents:0,runtimeProbeSkippedAgents:0},{runtimeUnavailable:1})).toBe(true);
    expect(unknown({backgroundProcesses:0,runtimeUnknownAgents:0,runtimeProbeSkippedAgents:0},{},true)).toBe(true);
  });
});
