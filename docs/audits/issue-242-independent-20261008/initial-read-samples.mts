import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { issue242Fixture,summary } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008/scripts/issue-242-fixture.ts';
import { ChildProcessStateReadService } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008/dist/stateReadProcess.js';
const f=await issue242Fixture(1200);
const observations=[];
const service=await ChildProcessStateReadService.start(f.file,f.environment,{onMeasurement:value=>observations.push(value)});
try {
  const groups={};
  let target;
  for(const history of [false,true]) {
    const options={limit:12,...(history?{}:{statusFilter:'all'}),includeHistory:history,inspectRuntime:false};
    const initial=await service.dashboardSnapshot(options);
    const rows=history?initial.terminalRows:initial.statusRows;
    assert.equal(rows.length,history?12:120,'preserve the paged history and complete status summary contracts');
    target=rows[0];
    const times=[];
    const offset=observations.length;
    for(let i=0;i<100;i++) {
      const start=performance.now();
      const view=await service.dashboardSnapshot(options);
      times.push(performance.now()-start);
      assert.deepEqual(view.counts,initial.counts);
      assert.deepEqual((history?view.terminalRows:view.statusRows).map(row=>row.rowKey),rows.map(row=>row.rowKey));
    }
    groups[history?'history-page-12':'native-status-summary-120']={latencyMs:summary(times),returnedRows:rows.length,
      selectStatements:summary(observations.slice(offset).map(value=>value.selectStatements))};
  }
  const times=[];
  const offset=observations.length;
  for(let i=0;i<100;i++) {
    const start=performance.now();
    const view=await service.dashboardHistoryDetail({rowKey:target.rowKey});
    times.push(performance.now()-start);
    assert.equal(view.historyRevision,target.historyRevision);
    assert.deepEqual(view.history,target.history);
  }
  groups.detail={latencyMs:summary(times),selectStatements:summary(observations.slice(offset).map(value=>value.selectStatements))};
  assert.equal(service.health().inFlight,0);
  console.log(JSON.stringify({scope:'1200 synthetic Jobs/120 Agents; populated 12-row history page and complete 120-row native status summary; compiled read child',
    coldWarm:'one warmup per list mode, same child; fresh registry per physical query; OS cache and host load uncontrolled',
    samplesPerMode:100,groups,deadlineFailures:observations.filter(value=>value.callerAbandoned).length,
    physicalReadCapacityAfter:service.health().inFlight,limits:['after-only supplementary sample; original exact-base comparison retained separately',
      'nine-byte synthetic Job results; population tails, installed latency, pure transport and SQL lock waits unproven']},null,2));
} finally {await service.close();await f.close();}
