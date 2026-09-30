import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { AutomaticRecoveryController, automaticRecoveryKey } from "../src/automaticRecovery.js";

const candidate = {key:automaticRecoveryKey("recheck",["agent-a",1]),scopeId:"scope-a",agentId:"agent-a",jobId:"job-a",kind:"recheck" as const};

describe("bounded automatic recovery", () => {
  it("drains more than one page of obsolete retries without per-Agent cursor state", async () => {
    const state = new BridgeStateStore({file:":memory:"});
    const scopeId = "11111111-1111-4111-8111-111111111111";
    const agent = state.createAgent({scopeId,agentName:"Historical retries"});
    for (let index = 0; index < 96; index++) {
      const stale = {...candidate,scopeId,agentId:agent.agentId,
        key:automaticRecoveryKey("recheck",[agent.agentId,index])};
      state.automaticRecovery.begin(stale,1_000);
      state.automaticRecovery.finish(stale.key,1,
        {resolved:false,reason:"inspection-unconfirmed"},1_001);
    }
    const controller = new AutomaticRecoveryController(state.automaticRecovery,{
      pageAgents:(after,limit)=>state.recoveryAgentIds(after,limit),
      candidates:()=>[],attempt:async()=>({resolved:false,reason:"unused"}),
      now:()=>1_002
    });
    try {
      for (let page = 0; page < 3; page++) await controller.sweep();
      expect(state.automaticRecovery.pendingForAgent(agent.agentId)).toEqual([]);
      expect(state.automaticRecovery.list()).toHaveLength(96);
      expect(state.automaticRecovery.list().every(record => record.state === "blocked")).toBe(true);
    } finally {await controller.close();state.close();}
  });

  it("prioritizes a due retry outside the current reconciliation page", async () => {
    const state = new BridgeStateStore({file:":memory:"});
    const scopeId = "11111111-1111-4111-8111-111111111111";
    const agents = Array.from({length:80},(_,index) => state.createAgent({
      scopeId,agentName:`Due Agent ${index}`
    }));
    const owner = [...agents].sort((a,b) => a.agentId.localeCompare(b.agentId)).at(-1)!;
    const due = {...candidate,agentId:owner.agentId,key:automaticRecoveryKey("recheck",[owner.agentId,"due"])};
    const first = state.automaticRecovery.begin(due,1_000)!;
    state.automaticRecovery.finish(due.key,first.attempts,{resolved:false,reason:"inspection-unconfirmed"},1_001);
    let attempts = 0;
    const controller = new AutomaticRecoveryController(state.automaticRecovery,{
      pageAgents:(after,limit)=>state.recoveryAgentIds(after,limit),
      candidates:agentId=>agentId===owner.agentId?[due]:[],
      attempt:async()=>{attempts++;return {resolved:true,reason:"runtime-confirmed",evidence:"runtime-observed"};},
      now:()=>6_000
    });
    try {
      await controller.sweep();
      expect(attempts).toBe(1);
      expect(state.automaticRecovery.get(due.key)).toMatchObject({state:"resolved",attempts:2});
      expect(controller.lastObservation!.agents).toBeLessThanOrEqual(32);
    } finally {
      await controller.close();state.close();
    }
  });

  it("surveys 1,200 Agents and retained Jobs in small indexed pages, then reaches a late incident", async () => {
    const statements: string[] = [];
    let tracing = false;
    const state = new BridgeStateStore({ file: ":memory:", traceSql: sql => {
      if (tracing) statements.push(sql);
    } });
    const scopeId = "11111111-1111-4111-8111-111111111111";
    const agents = [];
    for (let index = 0; index < 1_200; index++) {
      const agent = state.createAgent({scopeId,agentName:`Scale Agent ${index}`});
      agents.push(agent);
      state.upsertJob({jobId:`${index.toString(16).padStart(8,"0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        scopeId,requestId:`scale-request-${index}`,agentId:agent.agentId,status:"failed",updatedAt:index+1});
      if (index < 600) {
        const blocked = {...candidate,agentId:agent.agentId,
          key:automaticRecoveryKey("recheck",[agent.agentId,"blocked"])};
        state.automaticRecovery.begin(blocked, 1_000);
        state.automaticRecovery.finish(blocked.key,1,{resolved:false,reason:"inspection-unconfirmed",retryable:false},1_001);
      }
    }
    const lastAgent = [...agents].sort((a,b) => a.agentId.localeCompare(b.agentId)).at(-1)!;
    const late = {...candidate,agentId:lastAgent.agentId,
      key:automaticRecoveryKey("recheck",[lastAgent.agentId,"late"])};
    let dispatched = 0;
    const controller = new AutomaticRecoveryController(state.automaticRecovery, {
      pageAgents: (after,limit) => state.recoveryAgentIds(after,limit),
      candidates: agentId => {
        expect(agentId).toBeDefined();
        state.getAgent(agentId!);
        state.threadConnections.listForAgent(agentId!);
        state.automaticRecovery.isBlocked(automaticRecoveryKey("recheck",[agentId,"blocked"]));
        return agentId === lastAgent.agentId ? [late] : [];
      },
      attempt: async () => { dispatched++;return {resolved:true,reason:"runtime-confirmed",evidence:"runtime-observed"}; }
    });
    try {
      tracing = true;
      await controller.sweep();
      tracing = false;
      expect(controller.lastObservation).toMatchObject({dispatched:0,full:true});
      expect(controller.lastObservation!.agents).toBeGreaterThan(0);
      expect(controller.lastObservation!.agents).toBeLessThanOrEqual(32);
      expect(statements.length).toBeLessThan(180);
      expect(statements.some(sql => /SELECT \* FROM automatic_recovery\s+WHERE agent_id=/u.test(sql))).toBe(true);
      expect(statements.some(sql => /SELECT recovery_key FROM automatic_recovery WHERE state='blocked'/u.test(sql))).toBe(false);
      for (let page = 0; page < 200 && dispatched === 0; page++) await controller.sweep();
      expect(dispatched).toBe(1);
      expect(state.automaticRecovery.get(late.key)).toMatchObject({state:"resolved",attempts:1});
    } finally {
      await controller.close();
      state.close();
    }
  }, 60_000);

  it("surveys a changed Agent without reconciling another Agent's pending incident", async () => {
    vi.useFakeTimers();
    const state = new BridgeStateStore({ file: ":memory:" });
    const other = { ...candidate, key: automaticRecoveryKey("recheck", ["agent-b", 1]),
      agentId: "agent-b" };
    state.automaticRecovery.begin(candidate, 1_000);
    state.automaticRecovery.begin(other, 1_000);
    const surveyed: Array<string | undefined> = [];
    const controller = new AutomaticRecoveryController(state.automaticRecovery, {
      candidates: agentId => { surveyed.push(agentId); return []; },
      attempt: async () => ({ resolved: false, reason: "unused" })
    });
    try {
      controller.schedule(candidate.agentId);
      await vi.advanceTimersByTimeAsync(120);
      expect(surveyed).toEqual([candidate.agentId]);
      expect(state.automaticRecovery.get(candidate.key)?.state).toBe("blocked");
      expect(state.automaticRecovery.get(other.key)?.state).toBe("retrying");
      controller.schedule();
      await vi.advanceTimersByTimeAsync(120);
      expect(surveyed).toEqual([candidate.agentId, undefined]);
      expect(state.automaticRecovery.get(other.key)?.state).toBe("blocked");
    } finally {
      await controller.close();
      state.close();
      vi.useRealTimers();
    }
  });

  it("persists attempts before dispatch, respects backoff across restart, and stops after three unconfirmed checks", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(),"bridge-recovery-")),"state.sqlite");
    let state = new BridgeStateStore({file}), now=1000, calls=0;
    const create = () => new AutomaticRecoveryController(state.automaticRecovery,{now:()=>now,candidates:()=>[candidate],
      attempt:async () => { calls++;expect(state.automaticRecovery.get(candidate.key)?.attempts).toBe(calls);
        return {resolved:false,reason:"inspection-unconfirmed"}; }});
    let controller=create();
    await Promise.all([controller.sweep(),controller.sweep()]);
    expect(calls).toBe(1);await controller.close();state.close();
    state=new BridgeStateStore({file});controller=create();
    await controller.sweep();expect(calls).toBe(1);
    now+=5000;await controller.sweep();expect(calls).toBe(2);
    now+=30000;await controller.sweep();expect(calls).toBe(3);
    expect(state.automaticRecovery.get(candidate.key)).toMatchObject({attempts:3,state:"blocked",reason:"inspection-unconfirmed"});
    now+=86400_000;await controller.sweep();expect(calls).toBe(3);
    await controller.close();state.close();
    state=new BridgeStateStore({file});controller=create();await controller.sweep();expect(calls).toBe(3);
    await controller.close();state.close();
  });

  it("requires evidence for resolution and never calls an interrupted final attempt successful", () => {
    const state=new BridgeStateStore({file:":memory:"}),store=state.automaticRecovery;
    const first=store.begin(candidate,1000)!;
    store.finish(candidate.key,first.attempts,{resolved:true,reason:"acknowledged-without-proof"},1001);
    expect(store.get(candidate.key)).toMatchObject({state:"retrying",reason:"recovery-unconfirmed"});
    const second=store.begin(candidate,6000)!;
    store.finish(candidate.key,second.attempts,{resolved:false,reason:"unconfirmed"},6001);
    store.begin(candidate,36000);
    store.reconcileInterrupted(36001);
    expect(store.get(candidate.key)).toMatchObject({state:"blocked",attempts:3,reason:"recovery-interrupted"});
    expect(store.get(candidate.key)?.evidence).toBeUndefined();
    const later={...candidate,key:automaticRecoveryKey("recheck",["agent-a",2])};
    store.begin(later,37000);store.finish(later.key,1,{resolved:true,reason:"runtime-confirmed",evidence:"not-loaded-no-background"},37001);
    expect(store.get(later.key)).toMatchObject({state:"resolved",evidence:"not-loaded-no-background"});
    state.close();
  });

  it("reaches later incidents without duplicating concurrent sweeps and preserves unresolved budgets", async () => {
    const state=new BridgeStateStore({file:":memory:"});let calls=0;
    const candidates=Array.from({length:9},(_,n)=>({...candidate,key:automaticRecoveryKey("recheck",n)}));
    const controller=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>candidates,
      attempt:async()=>{calls++;return {resolved:false,reason:"unconfirmed"};}});
    await Promise.all([controller.sweep(),controller.sweep(),controller.sweep()]);expect(calls).toBe(4);
    await controller.sweep();expect(calls).toBe(8);await controller.sweep();expect(calls).toBe(9);
    expect(state.automaticRecovery.list()).toHaveLength(9);
    await controller.close();state.close();
  });

  it("does not report success when the original incident disappears during later work", async () => {
    const state=new BridgeStateStore({file:":memory:"});let present=true;
    const controller=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>present?[candidate]:[],
      attempt:async()=>({resolved:false,reason:"inspection-unconfirmed"})});
    await controller.sweep();present=false;await controller.sweep();
    expect(state.automaticRecovery.get(candidate.key)).toMatchObject({state:"blocked",attempts:1,reason:"work-changed"});
    expect(state.automaticRecovery.get(candidate.key)?.evidence).toBeUndefined();
    await controller.close();state.close();
  });

  it("opens a new incident only after confirmed recovery, preserves old evidence, and retains the new budget across restart", () => {
    const file=path.join(mkdtempSync(path.join(tmpdir(),"bridge-recovery-recurrence-")),"state.sqlite");
    let state=new BridgeStateStore({file}),store=state.automaticRecovery;
    store.observeRecheck(candidate,true,1000);
    expect(store.recheckCandidate(candidate)).toEqual(candidate);
    for (const now of [1000,6000,36000]) {
      const attempt=store.begin(candidate,now)!;
      store.finish(candidate.key,attempt.attempts,{resolved:false,reason:"unconfirmed"},now);
      store.observeRecheck(candidate,true,now);
      expect(store.recheckCandidate(candidate)).toEqual(candidate);
    }
    expect(store.get(candidate.key)).toMatchObject({state:"blocked",attempts:3});
    expect(store.begin(candidate,100000)).toBeUndefined();
    store.observeRecheck(candidate,false,100000,"runtime-observed");
    const original=store.get(candidate.key)!;
    expect(original).toMatchObject({state:"resolved",attempts:3,evidence:"runtime-observed"});
    expect(store.recheckCandidate(candidate,true)).toBeUndefined();
    // Equal timestamps are valid: the fresh healthy -> unknown transition,
    // not a wall-clock gap or Agent version change, starts a new incident.
    store.observeRecheck(candidate,true,100000);
    const recurring=store.recheckCandidate(candidate)!;
    expect(recurring.key).not.toBe(candidate.key);
    expect(store.get(recurring.key)).toBeUndefined();
    store.begin(recurring,100000);store.finish(recurring.key,1,{resolved:false,reason:"unconfirmed"},100000);
    state.close();state=new BridgeStateStore({file});store=state.automaticRecovery;
    expect(store.recheckCandidate(candidate)).toEqual(recurring);
    expect(store.begin(recurring,104999)).toBeUndefined();
    expect(store.begin(recurring,105000)?.attempts).toBe(2);
    expect(store.get(candidate.key)).toEqual(original);
    state.close();
  });

});
