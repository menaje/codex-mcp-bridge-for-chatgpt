import { mkdtempSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { AutomaticRecoveryController, automaticRecoveryKey } from "../src/automaticRecovery.js";

const candidate = {key:automaticRecoveryKey("recheck",["agent-a",1]),scopeId:"scope-a",agentId:"agent-a",jobId:"job-a",kind:"recheck" as const};

describe("bounded automatic recovery", () => {
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

  it("migrates v15 with a private consistent backup and retains failed outcomes", () => {
    const directory=mkdtempSync(path.join(tmpdir(),"bridge-recovery-migration-")),file=path.join(directory,"state.sqlite");
    let state=new BridgeStateStore({file});
    state.upsertJob({jobId:"original-failure",requestId:"original-request",scopeId:"11111111-1111-4111-8111-111111111111",status:"failed",updatedAt:Date.now()});
    state.close();
    const old=new Database(file);old.exec("DROP TABLE automatic_recovery;UPDATE bridge_meta SET value='15' WHERE key='schema_version'");old.close();
    state=new BridgeStateStore({file});expect(state.getMeta("schema_version")).toBe("18");
    expect(state.listJobs()[0]).toMatchObject({jobId:"original-failure",status:"failed"});
    const backups=readdirSync(directory).filter(name=>name.includes("pre-v18"));expect(backups).toHaveLength(1);
    expect(statSync(path.join(directory,backups[0])).mode & 0o777).toBe(0o600);
    const backup=new Database(path.join(directory,backups[0]),{readonly:true});
    expect(backup.pragma("quick_check",{simple:true})).toBe("ok");backup.close();state.close();
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

  it("adopts v16 budgets and creates a private backup before adding incident identities", () => {
    const directory=mkdtempSync(path.join(tmpdir(),"bridge-recovery-v16-")),file=path.join(directory,"state.sqlite");
    let state=new BridgeStateStore({file});
    state.automaticRecovery.begin(candidate,1000);
    state.automaticRecovery.finish(candidate.key,1,{resolved:false,reason:"unconfirmed"},1001);
    const resolved={...candidate,key:automaticRecoveryKey("recheck",["resolved-agent",1]),agentId:"resolved-agent"};
    state.automaticRecovery.begin(resolved,1000);
    state.automaticRecovery.finish(resolved.key,1,{resolved:true,reason:"runtime-confirmed",evidence:"runtime-observed"},1001);
    state.close();
    const old=new Database(file);
    old.exec("DROP TABLE automatic_recovery_incidents;UPDATE bridge_meta SET value='16' WHERE key='schema_version'");old.close();
    state=new BridgeStateStore({file});
    expect(state.schemaVersion).toBe(18);
    expect(readdirSync(directory).filter(name=>name.includes("pre-v18"))).toHaveLength(1);
    expect(state.automaticRecovery.recheckCandidate(candidate)).toEqual(candidate);
    expect(state.automaticRecovery.begin(candidate,6000)?.attempts).toBe(2);
    expect(state.automaticRecovery.recheckCandidate(resolved,true)).toBeUndefined();
    state.automaticRecovery.observeRecheck(resolved,true,6000);
    expect(state.automaticRecovery.recheckCandidate(resolved)?.key).not.toBe(resolved.key);
    expect(state.automaticRecovery.get(resolved.key)).toMatchObject({state:"resolved",attempts:1});
    state.close();
  });
});
