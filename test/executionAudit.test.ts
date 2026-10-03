import { describe, expect, it } from "vitest";
import { executionAudit, readExecutionEvidence, retainedExecutionSummary, retainExecutionEvidence, type ExecutionEvidence } from "../src/executionAudit.js";
import type { ExecutionDecision } from "../src/modelPolicy.js";

const decision: ExecutionDecision = { policyRevision: 1, catalogFingerprint: "f".repeat(64), catalogValidation: "valid", backendKind: "app-server",
  effectiveSelection: { model: "sol", reasoningEffort: "medium", serviceTier: "fast", serviceTierScope: "turn" },
  effectiveReasoningEffort: "medium", savedSelectionSupported: true, source: "fixed", appliedAt: "turn-start", processingSpeed: "fast", reason: "fixture" };
const accepted = { eventId: "accepted", type: "turn", phase: "started", details: { evidence: "turn/start-accepted", evidenceVersion: 1,
  threadId: "thread-a", turnId: "turn-a", selection: { model: "sol", reasoningEffort: "medium", serviceTier: "fast" },
  sent: { model: "sol", reasoningEffort: "medium", serviceTierForTurn: "fast" } } };
const reroute = { eventId: "reroute", type: "model", phase: "updated", details: { kind: "rerouted", serverCorrelation: "explicit",
  threadId: "thread-a", turnId: "turn-a", fromModel: "sol", toModel: "astra", reason: "server-routing" } };
const job = (publicEvents: typeof accepted[] | any[] = []) => ({ executionDecision: structuredClone(decision), threadId: "thread-a", upstreamRequestId: "turn-a", publicEvents });

describe("field-specific execution evidence", () => {
  it("keeps sent and accepted values separate from actual processing", () => {
    const audit = executionAudit(job([accepted]))!;
    expect(audit.intent).toEqual({ modelSource: "fixed", processingSpeed: "fast", scope: "turn" });
    expect(audit.sent).toEqual(accepted.details.sent);
    expect(audit.acceptance).toMatchObject({ threadId: "thread-a", turnId: "turn-a" });
    expect(audit.actual).toEqual({ model: null, reasoningEffort: null, serviceTier: null });
    expect(audit.confirmed.serviceTier).toMatchObject({ confirmed: false, reason: "server-does-not-report-applied-value" });
  });
  it("does not backfill historical actual or transmission using a decision or old request echo", () => {
    const old = structuredClone(accepted) as any;
    delete old.details.evidenceVersion;
    delete old.details.sent;
    expect(executionAudit(job([old]))).toMatchObject({ sent: null, actual: { model: null, reasoningEffort: null, serviceTier: null } });
    expect(executionAudit(job())).toMatchObject({ sent: null, acceptance: null, confirmed: { model: { reason: "no-correlated-server-evidence" } } });
  });
  it("confirms only a correlated model reroute, with the source event and turn", () => {
    expect(executionAudit(job([accepted, reroute]))).toMatchObject({ actual: { model: "astra", reasoningEffort: null, serviceTier: null },
      confirmed: { model: { confirmed: true, evidence: "model/rerouted", eventId: "reroute", threadId: "thread-a", turnId: "turn-a" },
        reasoningEffort: { confirmed: false }, serviceTier: { confirmed: false } } });
  });
  it.each([{ threadId: "thread-b" }, { turnId: "previous-turn" }, { serverCorrelation: "unconfirmed" }])("ignores late, unrelated or uncorrelated evidence: %j", changed => {
    const event = { ...reroute, details: { ...reroute.details, ...changed } };
    expect(executionAudit(job([accepted, event]))!.actual.model).toBeNull();
  });
  it("leaves source records unchanged and never initiates work to get confirmation", () => {
    const source = job([accepted]);
    const before = structuredClone(source);
    executionAudit(source); executionAudit(source);
    expect(source).toEqual(before);
  });
  it("retains correlated proofs after progress eviction and storage reload", () => {
    const source = { ...job(), executionEvidence: undefined as ExecutionEvidence | undefined };
    source.executionEvidence = retainExecutionEvidence(source, accepted);
    source.executionEvidence = retainExecutionEvidence(source, reroute);
    const original = structuredClone(source.executionEvidence);
    source.executionEvidence = retainExecutionEvidence(source, { ...accepted, eventId: "duplicate", details: { ...accepted.details, sent: {} } });
    source.executionEvidence = retainExecutionEvidence(source, { ...reroute, details: { ...reroute.details, turnId: "previous-turn", toModel: "unrelated" } });
    expect(source.executionEvidence).toEqual(original);
    const restored = readExecutionEvidence(JSON.parse(JSON.stringify(source.executionEvidence)));
    expect(retainedExecutionSummary({ ...source, executionEvidence: restored })).toMatchObject({ model: "sol", reasoningEffort: "medium",
      serviceTier: "fast", serviceTierScope: "turn", processingSpeed: "fast", requestState: "accepted", reroutedModel: "astra" });
    expect(retainedExecutionSummary(job([accepted, reroute]))).toMatchObject({ requestState: "requested" });
    expect(retainedExecutionSummary(job([accepted, reroute]))).not.toHaveProperty("reroutedModel");
    expect(executionAudit({ ...job(), executionEvidence: restored })).toMatchObject({
      acceptance: { eventId: "accepted" }, sent: accepted.details.sent,
      actual: { model: "astra", reasoningEffort: null, serviceTier: null }
    });
    expect(executionAudit({ ...job(), upstreamRequestId: "other-turn", executionEvidence: restored })).toMatchObject({ acceptance: null, sent: null, actual: { model: null } });
    expect(readExecutionEvidence({ accepted: { eventId: 5 }, reroutedModel: accepted })).toBeUndefined();
  });
});
