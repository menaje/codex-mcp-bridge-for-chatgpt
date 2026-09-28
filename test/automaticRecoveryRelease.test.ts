import { describe, expect, it } from "vitest";
import { automaticRecoveryKey } from "../src/automaticRecovery.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry, configureAutomaticRecovery } from "../src/tools.js";
import type { CodexUpstream } from "../src/upstream.js";

const scopeId = "11111111-1111-4111-8111-111111111111";

describe("automatic recovery of a bounded shared-worker connection page", () => {
  it.each([[32,false],[33,false],[33,true]] as const)(
    "releases the current incident at worker position %i with terminal peers %s", async (count,terminalPeers) => {
    const statements: string[] = [];
    let tracing = false;
    const state = new BridgeStateStore({file:":memory:",traceSql:sql => {
      if (tracing) statements.push(sql);
    }});
    const jobs = new CodexJobRegistry({stateStore:state});
    const workerPid = 4321;
    let agentId = "";
    for (let index = 0; index < count; index++) {
      const threadId = `thread-${String(index).padStart(3,"0")}`;
      const agent = jobs.createAgent({scopeId,agentName:`Owner ${index}`});
      state.linkAgentThread({agentId:agent.agentId,threadId,backendKind:"app-server",
        cwd:"/tmp",sandbox:"read-only",contextMode:"fresh",now:1_000});
      state.threadConnections.register({threadId,agentId:agent.agentId,scopeId,
        persistence:"persistent",workerPid},1_000);
      if (index === count - 1) agentId = agent.agentId;
      if (terminalPeers && index < count - 1) {
        const peerJobId = `failed-${threadId}`;
        const peerRunning = {jobId:peerJobId,requestId:`request-${threadId}`,scopeId,agentId:agent.agentId,
          threadId,backendKind:"app-server",threadPersistence:"persistent" as const,
          workerPid,upstreamRequestId:`turn-${threadId}`,status:"running",updatedAt:1_000};
        state.upsertJob(peerRunning);
        state.upsertJob({...peerRunning,status:"failed",updatedAt:2_000});
        expect(state.deleteJob(peerJobId,3_000)).toBe(true);
        const peerCandidate = {key:automaticRecoveryKey("release",[threadId,peerJobId]),
          scopeId,agentId:agent.agentId,jobId:peerJobId,kind:"release" as const};
        const attempt = state.automaticRecovery.begin(peerCandidate,3_000)!;
        state.automaticRecovery.finish(peerCandidate.key,attempt.attempts,
          {resolved:false,reason:"protected-peer",retryable:false},3_001);
      }
    }
    const target = `thread-${String(count-1).padStart(3,"0")}`;
    const jobId = `failed-${target}`;
    const running = {jobId,requestId:`request-${target}`,scopeId,agentId,
      threadId:target,backendKind:"app-server",threadPersistence:"persistent" as const,
      workerPid,upstreamRequestId:`turn-${target}`,status:"running",updatedAt:1_000};
    state.upsertJob(running);
    state.upsertJob({...running,status:"failed",updatedAt:2_000});
    expect(state.deleteJob(jobId,3_000)).toBe(true);
    expect(state.threadConnections.get(target)?.lastJobId).toBe(jobId);
    expect(state.workHistory.latestJob(agentId)?.jobId).toBe(jobId);
    const initialPage = state.threadConnections.listForWorker(workerPid).map(row => row.threadId);
    expect(initialPage.includes(target)).toBe(count === 32);

    const released: string[] = [];
    const upstream = {releaseThreadConnection:async (id, options) => {
      released.push(id);
      expect(id).toBe(target);
      expect(options.eligibleThreadIds).toContain(target);
      expect(options.eligibleThreadIds.length).toBeLessThanOrEqual(32);
      expect(options.eligibleThreadIds).not.toContain("thread-000");
      expect(await options.canRelease(id)).toBe(true);
      expect(await options.canRelease("thread-000")).toBe(false);
      return {phase:"released" as const,evidence:"thread-unloaded" as const};
    }} satisfies Pick<CodexUpstream,"releaseThreadConnection">;
    try {
      tracing = true;
      configureAutomaticRecovery(jobs,upstream as CodexUpstream,
        {} as Parameters<typeof configureAutomaticRecovery>[2],()=>true);
      const sweepStatements: number[] = [];
      for (let sweep = 0; sweep < 4 && released.length === 0; sweep++) {
        const before = statements.length;
        await jobs.sweepAutomaticRecovery();
        sweepStatements.push(statements.length-before);
      }
      tracing = false;
      expect(released).toEqual([target]);
      expect(Math.max(...sweepStatements),`SQL per sweep: ${sweepStatements.join(", ")}`).toBeLessThanOrEqual(384);
      expect(state.automaticRecovery.get(automaticRecoveryKey("release",[target,jobId])))
        .toMatchObject({state:"resolved",reason:"idle-connection-released",evidence:"thread-unloaded"});
      expect(state.threadConnections.get(target)?.phase).toBe("released");
    } finally {
      await jobs.closeThreadConnections();
      state.close();
    }
  });
});
