import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { DEFAULT_THREAD_IDLE_MS, ThreadConnectionController, type ThreadReleaseOptions, type ThreadReleaseResult } from "../src/threadConnections.js";
import type { CodexUpstream } from "../src/upstream.js";
import { loadConfig } from "../src/config.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const job = (threadId = "thread", updatedAt = 1000) => ({ jobId: `job-${threadId}`, requestId: `request-${threadId}`, scopeId, threadId,
  backendKind: "app-server", threadPersistence: "persistent" as const, workerPid: 1234, upstreamRequestId: `turn-${threadId}`, status: "running", updatedAt });
function finish(store: BridgeStateStore, threadId = "thread", now = 2000) {
  store.upsertJob(job(threadId));
  store.upsertJob({ ...job(threadId), status: "completed", updatedAt: now });
}
function fake(release: (threadId: string, options: ThreadReleaseOptions) => Promise<ThreadReleaseResult>) {
  return { releaseThreadConnection: release } as unknown as CodexUpstream;
}

describe("durable thread connection lifetime", () => {
  it("finds unfinished work through each indexed thread, source, and Agent identity", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    store.upsertJob(job("direct-thread"));
    store.upsertJob({ ...job("worker-thread"), sourceThreadId: "source-thread" });
    const agent = store.createAgent({ scopeId, agentName: "Indexed owner", now: 1000 });
    store.threadConnections.register({
      threadId: "agent-thread",
      agentId: agent.agentId,
      scopeId,
      persistence: "persistent"
    });
    store.upsertJob({ ...job("agent-worker"), agentId: agent.agentId });

    expect(store.threadConnections.hasUnfinishedWork("direct-thread")).toBe(true);
    expect(store.threadConnections.hasUnfinishedWork("source-thread")).toBe(true);
    expect(store.threadConnections.hasUnfinishedWork("agent-thread")).toBe(true);
    expect(store.threadConnections.hasUnfinishedWork("unrelated-thread")).toBe(false);
    store.close();
  });

  it("uses a separate six-hour clock, untouched by reads, sessions and terminal refreshes", async () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    let now = 2000, calls = 0;
    finish(store);
    const controller = new ThreadConnectionController(store.threadConnections, fake(async () => { calls++; return { phase: "released", evidence: "worker-exited" }; }), { now: () => now });
    now += DEFAULT_THREAD_IDLE_MS - 1;
    store.upsertSession({ threadId: "thread", scopeId, cwd: "/tmp", lastUsedAt: now, visibleInCodexApp: true });
    store.upsertJob({ ...job(), status: "completed", updatedAt: now });
    await controller.sweep();
    expect(calls).toBe(0);
    expect(store.threadConnections.get("thread")?.lastFinishedAt).toBe(2000);
    now++;
    await controller.sweep();
    expect(calls).toBe(1);
    expect(store.threadConnections.get("thread")?.phase).toBe("released");
    await controller.close(); store.close();
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_JOB_TTL_MS: "1234", CODEX_MCP_BRIDGE_THREAD_IDLE_MS: "0" });
    expect(config.jobTtlMs).toBe(1234); expect(config.threadIdleMs).toBe(0);
  });

  it("restores the actual finish time after restart and requires new release evidence", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "thread-lifetime-"));
    const file = path.join(directory, "state.sqlite");
    let store = new BridgeStateStore({ file }); finish(store); store.close();
    store = new BridgeStateStore({ file });
    let previousPid: number | undefined;
    const controller = new ThreadConnectionController(store.threadConnections, fake(async (_id, options) => {
      previousPid = options.previousWorkerPid; return { phase: "blocked", reason: "ownership-unconfirmed" };
    }), { now: () => 2000 + DEFAULT_THREAD_IDLE_MS });
    await controller.sweep();
    expect(previousPid).toBe(1234);
    expect(store.threadConnections.get("thread")).toMatchObject({ phase: "blocked", lastFinishedAt: 2000 });
    expect(readdirSync(directory).filter(name => name.includes("pre-v14"))).toHaveLength(0);
    await controller.close(); store.close();
  });

  it("gates new turns during a handoff without cancelling active work and distinguishes unsubscribe from release", async () => {
    const store = new BridgeStateStore({ file: ":memory:" }); store.upsertJob(job());
    let calls = 0;
    const controller = new ThreadConnectionController(store.threadConnections, fake(async () => { calls++; return { phase: "unsubscribed", reason: "upstream-unload-grace" }; }));
    controller.request("thread"); await controller.sweep();
    expect(calls).toBe(0); expect(store.listJobs()).toEqual([expect.objectContaining({status:"running"})]);
    expect(() => store.threadConnections.assertAdmission(undefined, "thread")).toThrow(/HANDOFF_PENDING/);
    store.upsertJob({ ...job(), status: "completed", updatedAt: 2000 });
    await controller.sweep();
    expect(calls).toBe(1); expect(store.threadConnections.get("thread")?.phase).toBe("unsubscribed");
    expect(() => store.threadConnections.assertAdmission(undefined, "thread")).toThrow(/HANDOFF_PENDING/);
    controller.cancel("thread"); expect(() => store.threadConnections.assertAdmission(undefined, "thread")).not.toThrow();
    await controller.close(); store.close();
  });

  it("preserves ephemeral and unknown conversations and rolls back finish clocks with failed result commits", async () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    store.upsertJob(job());
    expect(() => store.transaction(() => { store.upsertJob({...job(), status:"completed", updatedAt:2000}); throw new Error("disk failure"); })).toThrow();
    expect(store.threadConnections.get("thread")?.lastFinishedAt).toBeUndefined();
    for (const persistence of ["ephemeral", "unknown"] as const) store.threadConnections.register({threadId:persistence,scopeId,persistence});
    let calls=0;
    const controller = new ThreadConnectionController(store.threadConnections, fake(async () => { calls++; return {phase:"released", evidence:"worker-exited"}; }));
    controller.request("ephemeral"); controller.request("unknown"); await controller.sweep();
    expect(calls).toBe(0);
    expect(store.threadConnections.get("ephemeral")?.phase).toBe("blocked");
    expect(() => store.threadConnections.register({threadId:"ephemeral",scopeId,persistence:"persistent"})).toThrow(/PERSISTENCE_CONFLICT/);
    await controller.close(); store.close();
  });

  it("rechecks release eligibility when another admission arrives while the runtime is inspected", async () => {
    const store = new BridgeStateStore({ file: ":memory:" }); finish(store);
    let check!: () => boolean, settle!: (result: ThreadReleaseResult) => void;
    const controller = new ThreadConnectionController(store.threadConnections, fake(async (id, options) => {
      check = () => options.canRelease(id); return new Promise(resolve => { settle=resolve; });
    }), {now: () => DEFAULT_THREAD_IDLE_MS+2000});
    const sweep = controller.sweep();
    expect(check()).toBe(true);
    expect(() => store.threadConnections.assertAdmission(undefined,"thread")).toThrow(/HANDOFF_PENDING/);
    expect(() => store.upsertJob({...job(),jobId:"new-job",requestId:"new-request",updatedAt:3000})).toThrow(/HANDOFF_PENDING/);
    store.upsertJob({...job(),status:"terminating",updatedAt:3000});
    expect(check()).toBe(false);
    settle({phase:"blocked",reason:"active-work"}); await sweep;
    expect(store.threadConnections.get("thread")?.phase).not.toBe("released");
    await controller.close();store.close();
  });

  it("releases an obsolete handoff gate when an already active fork changes the Agent's current thread", () => {
    const store = new BridgeStateStore({file:":memory:"});
    const agent = store.createAgent({scopeId,agentName:"Forking",now:1000});
    const link = {agentId:agent.agentId,backendKind:"app-server",cwd:"/tmp",sandbox:"read-only",contextMode:"fresh" as const,now:1000};
    store.linkAgentThread({...link,threadId:"source"});
    store.upsertJob({...job("source"),agentId:agent.agentId});
    store.threadConnections.requestHandoff("source");
    expect(() => store.threadConnections.assertAdmission(agent.agentId)).toThrow(/HANDOFF_PENDING/);
    store.linkAgentThread({...link,threadId:"fork",contextMode:"fork",forkedFromThreadId:"source",now:2000});
    expect(store.threadConnections.get("source")).toMatchObject({handoffRequested:false,reason:"target-changed"});
    expect(() => store.threadConnections.assertAdmission(agent.agentId,"fork")).not.toThrow();
    store.close();
  });

  it("does not release a terminal Job with a retained blocking question", async () => {
    const store=new BridgeStateStore({file:":memory:"});finish(store);
    store.upsertJob({...job(),status:"completed",pendingInteractions:[{interactionId:"approval",isBlocking:true}]});
    let releases=0;
    const controller=new ThreadConnectionController(store.threadConnections,fake(async()=>{releases++;return {phase:"released",evidence:"worker-exited"};}),{now:()=>2000+DEFAULT_THREAD_IDLE_MS});
    controller.request("thread");await controller.sweep();expect(releases).toBe(0);
    store.upsertJob({...job(),status:"completed",pendingInteractions:[]});await controller.sweep();expect(releases).toBe(1);
    await controller.close();store.close();
  });

  it("advances past a full batch of permanently blocked requests", async () => {
    const store = new BridgeStateStore({file:":memory:"});
    for(let index=0;index<101;index++) {
      const threadId=`blocked-${String(index).padStart(3,"0")}`;
      store.threadConnections.register({threadId,scopeId,persistence:"ephemeral"});
      store.threadConnections.requestHandoff(threadId);
    }
    finish(store,"eligible");
    let released=0;
    const controller = new ThreadConnectionController(store.threadConnections,fake(async () => {
      released++;return {phase:"released",evidence:"worker-exited"};
    }),{now:()=>2000+DEFAULT_THREAD_IDLE_MS});
    await controller.sweep();expect(released).toBe(0);
    await controller.sweep();expect(released).toBe(1);
    await controller.close();store.close();
  });

  it("keeps a released current conversation available after 30 days", () => {
    const store=new BridgeStateStore({file:":memory:"});
    const agent=store.createAgent({scopeId,agentName:"Long lived",now:1000});
    store.linkAgentThread({agentId:agent.agentId,threadId:"thread",backendKind:"app-server",cwd:"/tmp",sandbox:"read-only",contextMode:"fresh",now:1000});
    store.upsertJob({...job(),agentId:agent.agentId});
    store.upsertJob({...job(),agentId:agent.agentId,status:"completed",updatedAt:2000});
    const later=2001+30*86400_000;
    store.maintainRetention(later);expect(store.getAgent(agent.agentId)?.lifecycle).toBe("idle");
    store.threadConnections.update("thread",{phase:"released",evidence:"worker-exited"},3000);
    store.maintainRetention(later);expect(store.getAgent(agent.agentId)?.lifecycle).toBe("idle");
    expect(store.listAgentThreads(agent.agentId)).toEqual([expect.objectContaining({threadId:"thread",isCurrent:true})]);
    expect(store.getAgent(agent.agentId)?.currentThreadId).toBe("thread");
    store.close();
  });
});
