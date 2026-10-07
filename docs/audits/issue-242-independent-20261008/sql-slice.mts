import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { issue242Fixture } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008/scripts/issue-242-fixture.ts';
import { ChildProcessStateReadService } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008/dist/stateReadProcess.js';
const f=await issue242Fixture(40);
const marker=path.join(f.root,'slice-entered');
const observations=[];
const service=await ChildProcessStateReadService.start(f.file,{...f.environment,
  NODE_OPTIONS:'--import /tmp/issue-242-independent-20261008/sql-slice-hook.mjs',
  ISSUE_242_SQL_SLICE_MARKER:marker},{onMeasurement:value=>observations.push(value)});
const controller=new AbortController();
try {
  const start=performance.now();
  const pending=service.dashboardSnapshot({limit:2},{signal:controller.signal,deadlineAt:Date.now()+3000});
  const failure=assert.rejects(pending,/STATE_READ_CANCELLED/);
  while(!existsSync(marker)&&performance.now()-start<2000) await new Promise(resolve=>setTimeout(resolve,5));
  assert(existsSync(marker),'the real child must enter the synchronous SQL slice');
  assert.equal(service.health().inFlight,1);
  controller.abort();
  await failure;
  const afterCancellation=service.health().inFlight;
  assert.equal(afterCancellation,1,'a running synchronous slice remains physically charged');
  while(service.health().inFlight&&performance.now()-start<3000) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.health().inFlight,0);
  const wallMs=performance.now()-start;
  assert(wallMs>=500,'physical completion must wait for the injected synchronous slice');
  assert.equal(observations.length,1);
  assert.equal(observations[0].callerAbandoned,true);
  assert(observations[0].jobsMs>=500);
  const next=await service.dashboardSnapshot({limit:2});
  assert.equal(next.counts.retainedJobs,40);
  assert.equal(service.health().inFlight,0);
  assert.equal(f.store.listJobs().length,40);
  console.log(JSON.stringify({scope:'owned compiled read child; injected 500 ms synchronous SQL slice; no product source changes',
    scenarios:1,passed:1,failed:0,afterCancellation,afterPhysicalCompletion:0,wallMs,
    abandonedJobsMs:observations[0].jobsMs,retainedJobsAfterRecovery:next.counts.retainedJobs},null,2));
} finally {await service.close();await f.close();}
