import type { ExecutionDecision } from "./modelPolicy.js";

type ExecutionEvent = { type: string; phase: string; eventId: string; details?: Record<string, unknown> };
export type ExecutionEvidence = { accepted?: ExecutionEvent; reroutedModel?: ExecutionEvent };
type AuditJob = {
  executionDecision?: ExecutionDecision;
  threadId?: string;
  upstreamRequestId?: string;
  publicEvents: ExecutionEvent[];
  executionEvidence?: ExecutionEvidence;
};
export type ExecutionFieldEvidence = {
  value: string | null;
  confirmed: boolean;
  reason: "server-does-not-report-applied-value" | "no-correlated-server-evidence" | null;
  evidence: "model/rerouted" | null;
  eventId: string | null;
  threadId: string | null;
  turnId: string | null;
};

function correlated(job: AuditJob, event: ExecutionEvent | undefined): boolean {
  return Boolean(job.threadId && job.upstreamRequestId && event?.details?.threadId === job.threadId &&
    event.details.turnId === job.upstreamRequestId);
}
function isAcceptance(event: ExecutionEvent): boolean {
  return event.type === "turn" && event.phase === "started" && event.details?.evidence === "turn/start-accepted";
}
function isReroute(event: ExecutionEvent): boolean {
  return event.type === "model" && event.details?.kind === "rerouted" && event.details.serverCorrelation === "explicit" &&
    typeof event.details.toModel === "string";
}

/** Keep small, correlated proofs outside the bounded progress-event ring. */
export function retainExecutionEvidence(job: AuditJob, event: ExecutionEvent): ExecutionEvidence | undefined {
  const acceptance = isAcceptance(event) && !job.executionEvidence?.accepted;
  const reroute = isReroute(event);
  if ((!acceptance && !reroute) || !correlated(job, event)) return job.executionEvidence;
  const retained = { type: event.type, phase: event.phase, eventId: event.eventId, details: structuredClone(event.details) };
  return acceptance ? { ...job.executionEvidence, accepted: retained } : { ...job.executionEvidence, reroutedModel: retained };
}

export function readExecutionEvidence(value: unknown): ExecutionEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Record<string, unknown>, evidence: ExecutionEvidence = {};
  for (const key of ["accepted", "reroutedModel"] as const) {
    const event = stored[key] as ExecutionEvent | undefined;
    if (event && typeof event.type === "string" && typeof event.phase === "string" && typeof event.eventId === "string" &&
      event.details && typeof event.details === "object" && !Array.isArray(event.details) &&
      (key === "accepted" ? isAcceptance(event) : isReroute(event))) evidence[key] = structuredClone(event);
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

/** Bounded request/evidence projection that remains readable after result expiry. */
export function retainedExecutionSummary(job: Record<string, unknown>): Record<string, unknown> | undefined {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const decision = record(job.executionDecision), selection = record(decision.effectiveSelection);
  if (typeof selection.model !== "string" || typeof selection.reasoningEffort !== "string") return undefined;
  const proofs = readExecutionEvidence(job.executionEvidence);
  const matches = (event: ExecutionEvent | undefined) => Boolean(job.threadId && job.upstreamRequestId &&
    event?.details?.threadId === job.threadId && event.details.turnId === job.upstreamRequestId);
  return { model: selection.model, reasoningEffort: selection.reasoningEffort,
    ...(typeof selection.serviceTier === "string" ? { serviceTier: selection.serviceTier } : {}),
    ...(selection.serviceTierScope === "turn" ? { serviceTierScope: "turn" } : {}),
    ...(typeof decision.processingSpeed === "string" ? { processingSpeed: decision.processingSpeed } : {}),
    requestState: matches(proofs?.accepted) ? "accepted" : "requested",
    ...(matches(proofs?.reroutedModel) ? { reroutedModel: proofs!.reroutedModel!.details!.toModel } : {}) };
}

/** Request acceptance and routing observation never prove unrelated execution fields. */
export function executionAudit(job: AuditJob) {
  const decision = job.executionDecision;
  if (!decision) return null;
  const events = [...job.publicEvents].reverse();
  const accepted = [job.executionEvidence?.accepted, ...events].find(event => event && isAcceptance(event) && correlated(job, event));
  const reroute = [job.executionEvidence?.reroutedModel, ...events].find(event => event && isReroute(event) && correlated(job, event));
  const unknown = (): ExecutionFieldEvidence => ({ value: null, confirmed: false,
    reason: accepted ? "server-does-not-report-applied-value" : "no-correlated-server-evidence", evidence: null,
    eventId: null, threadId: job.threadId || null, turnId: job.upstreamRequestId || null });
  const model: ExecutionFieldEvidence = reroute ? { value: reroute.details!.toModel as string, confirmed: true,
    reason: null, evidence: "model/rerouted", eventId: reroute.eventId, threadId: job.threadId!, turnId: job.upstreamRequestId! } : unknown();
  const reasoningEffort = unknown(), serviceTier = unknown();
  const selection = decision.effectiveSelection;
  return {
    requested: { model: selection.model, reasoningEffort: selection.reasoningEffort },
    intent: { modelSource: decision.source, processingSpeed: decision.processingSpeed || "legacy", scope: selection.serviceTierScope || "conversation" },
    // Historical decisions cannot establish what was sent; only a versioned transmission receipt does.
    sent: accepted?.details?.evidenceVersion === 1 && accepted.details.sent && typeof accepted.details.sent === "object"
      ? accepted.details.sent as Record<string, unknown> : null,
    acceptance: accepted ? { threadId: job.threadId!, turnId: job.upstreamRequestId!, eventId: accepted.eventId } : null,
    actual: { model: model.value, reasoningEffort: reasoningEffort.value, serviceTier: serviceTier.value },
    confirmed: { model, reasoningEffort, serviceTier },
    source: decision.source,
    evidence: reroute ? "model/rerouted" as const : accepted ? "turn/start-accepted" as const : "bridge-dispatch" as const,
    ...(reroute ? { reroute: { fromModel: typeof reroute.details!.fromModel === "string" ? reroute.details!.fromModel : selection.model,
      toModel: model.value!, reason: typeof reroute.details!.reason === "string" ? reroute.details!.reason : "unspecified" } } : {})
  };
}
