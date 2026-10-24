/** Synthetic controller-level scale characterization for issue #193.
 * Run against an isolated checkout; no operational database is opened. */
import { performance } from "node:perf_hooks";
import { BridgeStateStore } from "../src/stateStore.js";
import { AutomaticRecoveryController, automaticRecoveryKey } from "../src/automaticRecovery.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const size = 1_200;
let tracing = false;
let sqlStatements = 0;
let hydratedRows = 0;
let lastSqlAt = 0;
let maxSqlGapMs = 0;
let maxSqlGapStatement = "";
const state = new BridgeStateStore({ file: ":memory:", traceSql: sql => {
  if (tracing) {
    sqlStatements++;
    const now = performance.now();
    if (lastSqlAt && now-lastSqlAt > maxSqlGapMs) {
      maxSqlGapMs=now-lastSqlAt;
      maxSqlGapStatement=sql.slice(0,80);
    }
    lastSqlAt=now;
  }
} });
const jobIds: string[] = [];
for (let index = 0; index < size; index++) {
  const agent = state.createAgent({scopeId,agentName:`Scale Agent ${index}`});
  const jobId = `${index.toString(16).padStart(8,"0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  jobIds.push(jobId);
  state.upsertJob({jobId,scopeId,requestId:`scale-request-${index}`,
    agentId:agent.agentId,status:"failed",updatedAt:index+1});
  state.threadConnections.register({threadId:`scale-thread-${index}`,scopeId,
    agentId:agent.agentId,persistence:"persistent"});
  if (index < 600) {
    const candidate = {key:automaticRecoveryKey("recheck",[agent.agentId,"blocked"]),
      scopeId,agentId:agent.agentId,jobId,kind:"recheck" as const};
    state.automaticRecovery.begin(candidate, 1_000);
    state.automaticRecovery.finish(candidate.key,1,
      {resolved:false,reason:"inspection-unconfirmed",retryable:false},1_001);
  }
}
const candidates = (agentId?: string) => {
  if (agentId) {
    hydratedRows += state.getAgent(agentId) ? 1 : 0;
    const current = state.currentAgentThread?.(agentId);
    if (current) hydratedRows++;
    const connections = state.threadConnections.listForAgent?.(agentId) || [];
    hydratedRows += connections.length;
    state.automaticRecovery.isBlocked?.(automaticRecoveryKey("recheck",[agentId,"blocked"]));
    return [];
  }
  // Mirrors the pre-#193 candidate discovery fan-out. This branch runs only
  // against the old controller, whose optional pageAgents callback is ignored.
  hydratedRows += state.listJobs().length;
  hydratedRows += state.automaticRecovery.blockedKeys().size;
  hydratedRows += state.automaticRecovery.blockedRecheckIdentityKeys().size;
  hydratedRows += state.threadConnections.list().length;
  const agents = [];
  for (let offset = 0; offset < size; offset += 1_000) {
    agents.push(...state.listAgents(undefined, 1_000, offset));
  }
  hydratedRows += agents.length;
  for (const agent of agents) {
    hydratedRows += state.listAgentThreads(agent.agentId).length;
    hydratedRows += state.workHistory.latestJob(agent.agentId) ? 1 : 0;
  }
  return [];
};
const controller = new AutomaticRecoveryController(state.automaticRecovery, {
  candidates,
  pageAgents: (after: string, limit: number) => state.recoveryAgentIds(after,limit),
  attempt: async () => ({resolved:false,reason:"unneeded"})
} as ConstructorParameters<typeof AutomaticRecoveryController>[1]);
await controller.sweep();
await new Promise<void>(resolve => setImmediate(resolve));
(globalThis as {gc?:()=>void}).gc?.();
const exactStartedAt = performance.now();
let exactLatencyMs = 0, exactQueueMs = 0, exactStatusMs = 0;
let exactInputMs = 0, exactResultMs = 0, heartbeatLagMs = 0;
const database = (state as unknown as {database:{prepare:(sql:string)=>{get:(id:string)=>unknown;all:(id:string)=>unknown}}}).database;
const heartbeatDueAt = performance.now() + 5;
const heartbeat = new Promise<void>(resolve => setTimeout(() => {
  heartbeatLagMs = Math.max(0,performance.now()-heartbeatDueAt);
  resolve();
},5));
const exactRead = new Promise<void>(resolve => setImmediate(() => {
  const entered = performance.now();
  exactQueueMs = entered - exactStartedAt;
  state.statusReadModel.job(jobIds.at(-1)!);
  const statusDone = performance.now();
  exactStatusMs = statusDone - entered;
  database.prepare("SELECT * FROM job_interactions WHERE job_id=?").all(jobIds.at(-1)!);
  const inputDone = performance.now();
  exactInputMs = inputDone - statusDone;
  database.prepare("SELECT payload FROM jobs WHERE job_id=?").get(jobIds.at(-1)!);
  exactResultMs = performance.now() - inputDone;
  exactLatencyMs = performance.now() - exactStartedAt;
  resolve();
}));
tracing = true;
const startedAt = performance.now();
await controller.sweep();
const sweepMs = performance.now() - startedAt;
await exactRead;
await heartbeat;
tracing = false;
console.log(JSON.stringify({schema:state.schemaVersion,agents:size,jobs:size,blockedIncidents:600,
  visitedAgents:controller.lastObservation?.agents ?? size,
  sliceDurationMs:controller.lastObservation?.durationMs,
  sqlStatements,maxSqlGapMs,maxSqlGapStatement,hydratedRows,sweepMs,exactQueueMs,exactStatusMs,exactInputMs,exactResultMs,exactLatencyMs,heartbeatLagMs},null,2));
await controller.close();
state.close();
