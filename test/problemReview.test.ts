import { describe, expect, it } from "vitest";
import { ProblemReviewProofs, problemOperationDigest, problemOperationSchema } from "../src/problemReview.js";
import { BridgeStateStore } from "../src/stateStore.js";

const widget="11111111-1111-4111-8111-111111111111",host="22222222-2222-4222-8222-222222222222";
const target={problemKey:"a".repeat(32),expectedRevision:"b".repeat(64)};

describe("problem review authority",()=>{
  it("binds a short-lived proof to the complete action, widget and host",()=>{
    let now=1000;const proofs=new ProblemReviewProofs(()=>now);
    const operation=problemOperationSchema.parse({action:"retry-stop",targets:[target],acknowledgeAffectedJobIds:["job-a","job-b"]});
    const token=proofs.issue({widgetInstanceId:widget,hostScopeId:host,selectedScopeId:null,operationDigest:problemOperationDigest(operation)});
    expect(proofs.require(token,widget,host,operation).selectedScopeId).toBeNull();
    expect(()=>proofs.require(token,host,host,operation)).toThrow(/STALE/);
    expect(()=>proofs.require(token,widget,undefined,operation)).toThrow(/STALE/);
    expect(()=>proofs.require(token,widget,host,{...operation,acknowledgeAffectedJobIds:["job-a"]})).toThrow(/STALE/);
    expect(()=>proofs.require(token,widget,host,{action:"acknowledge",targets:[target]})).toThrow(/STALE/);
    expect(()=>new ProblemReviewProofs(()=>now).require(token,widget,host,operation)).toThrow(/STALE/);
    now+=300_000;expect(()=>proofs.require(token,widget,host,operation)).toThrow(/STALE/);
  });

  it("rejects duplicate targets and prevents bulk runtime or unbounded review actions",()=>{
    expect(()=>problemOperationSchema.parse({action:"acknowledge",targets:[target,target]})).toThrow();
    expect(()=>problemOperationSchema.parse({action:"recheck",targets:[target,{...target,problemKey:"c".repeat(32)}]})).toThrow();
    expect(()=>problemOperationSchema.parse({action:"acknowledge",targets:[target],acknowledgeAffectedJobIds:[]})).toThrow();
  });

  it("preserves outcomes through undo, invalidates old review revisions, and rolls back partial batches",()=>{
    const store=new BridgeStateStore({file:":memory:"});
    try {
      for(const jobId of ["a","b"])store.upsertJob({jobId,scopeId:host,requestId:jobId,status:"failed",createdAt:100,updatedAt:200});
      const before=store.workHistory.problemJobs(),revision=before.find(job=>job.jobId==="a")!.revision;
      store.workHistory.setAcknowledged("a",true,300);
      expect(store.workHistory.problemJobs().find(job=>job.jobId==="b")!.revision).toBe(before.find(job=>job.jobId==="b")!.revision);
      store.workHistory.setAcknowledged("a",false,400);
      expect(store.workHistory.problemJobs().find(job=>job.jobId==="a")).toMatchObject({status:"failed",acknowledgedAt:null});
      expect(store.workHistory.problemJobs().find(job=>job.jobId==="a")!.revision).not.toBe(revision);
      expect(()=>store.transaction(()=>{store.workHistory.setAcknowledged("a",true);store.workHistory.setAcknowledged("missing",true);})).toThrow();
      expect(store.workHistory.acknowledgedJobIds().size).toBe(0);
    } finally {store.close();}
  });
});
