import { RELAY_TOOL_METADATA } from "./relayCard.js";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { authenticatedMcpPrincipal } from "./mcpPrincipal.js";
import type { BridgeStateStore } from "./stateStore.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import { RELAY_EVENT_PATTERN, RELAY_METADATA_KEY, RELAY_RETRY_METADATA_KEY, RelayEventUnavailableError, relayPresentationRef } from "./relayDelivery.js";

export const relayEventOutputSchema = z.strictObject({
  eventId: z.string().regex(RELAY_EVENT_PATTERN), jobId: z.string().uuid(), kind: z.enum(["terminal", "input"]),
  version: z.number().int().positive(), state: z.enum(["pending", "leased", "sending", "accepted", "unknown", "rejected"]),
  attemptId: z.string().uuid().optional(), cardId: z.string().uuid().optional(),
  leaseUntil: z.number().optional(), attempts: z.number().int().min(0), retryAt: z.number().optional()
});
export const relayWaitOutputSchema = z.strictObject({
  kind: z.literal("relay-wait"), revision: z.string(), stopped: z.boolean(), events: z.array(relayEventOutputSchema).max(64)
});
export const relayMutationOutputSchema = z.strictObject({
  kind: z.literal("relay"), stopped: z.boolean().optional(), recoveryAfter: z.string().nullable().optional(),
  event: relayEventOutputSchema.optional(), dispatch: z.boolean().optional()
});
export const relayControlOutputSchema = z.strictObject({ kind: z.literal("relay-control"), activityId: z.string().uuid(), stopped: z.enum(["relay", "followups"]) });
export const relayReviewOutputSchema = z.strictObject({
  kind: z.literal("result-review"), eventId: z.string().regex(RELAY_EVENT_PATTERN), version: z.number().int().positive(),
  holdUntil: z.number(), alreadyReviewed: z.boolean(), dispatchEntered: z.boolean()
});

const base = { contractGeneration: z.literal(1), activityId: z.string().uuid(), cardId: z.string().uuid() };
const eventAttempt = { eventId: z.string().regex(RELAY_EVENT_PATTERN), attemptId: z.string().uuid() };
const appMeta = { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true };
const waitPools = new WeakMap<BridgeStateStore, Map<string, AbortController>>();

/** Task/answer results alone carry the automatic UI association. The helper
 * cannot be reached by an internal wait/claim/ACK or an ordinary status read. */
export function relayToolResult<T extends { structuredContent?: unknown; _meta?: Record<string, unknown> }>(
  result: T, state: BridgeStateStore, openingRequestId: string
): T {
  const value = result.structuredContent as { jobId?: string } | undefined;
  if (!value?.jobId) return result;
  const job = state.getRelayJobSnapshot(value.jobId);
  if (!job || job.completionDeliveryPolicy === "events" || !state.retainedJobVisible(job.jobId)) return result;
  if (!state.relay.registration(job.jobId) && job.status === "running") state.transaction(() => {
    state.relay.register(job); state.relay.reconcileJob(job);
  });
  const registration = state.relay.registration(job.jobId);
  if (!registration) return result;
  return { ...result, _meta: { ...result._meta, ...RELAY_TOOL_METADATA, [RELAY_METADATA_KEY]: {
    contractGeneration: 1, jobId: job.jobId, activityId: registration.activityId,
    inputRequestId: openingRequestId, presentationRef: relayPresentationRef(openingRequestId)
  } } };
}

export function registerRelayTools(server: McpServer, state: BridgeStateStore, scopes: ScopeResolver): void {
  let pool = waitPools.get(state);
  if (!pool) { pool = new Map(); waitPools.set(state, pool); }
  const waits = pool;
  const owner = (meta: unknown, principal?: string) => {
    const resolved = scopes.resolve(meta as ToolCallMetadata);
    if (!resolved || resolved.source !== "host-metadata") throw new Error("RELAY_HOST_SCOPE_REQUIRED: Use the originating host conversation.");
    return { scopeId: resolved.scopeId, mcpPrincipal: principal };
  };
  const response = <T>(structuredContent: T) => ({ content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent });
  const retryableFailure = (message: string) => ({ isError: true,
    content: [{ type: "text" as const, text: message }],
    _meta: { [RELAY_RETRY_METADATA_KEY]: { delivery: "not-sent", retryable: true } } });

  const mutation = z.discriminatedUnion("action", [
    z.strictObject({ ...base, action: z.literal("connect"), inputRequestId: z.string().uuid(), presentationRef: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.strictObject({ ...base, action: z.literal("recover"), afterJob: z.string().uuid().optional() }),
    z.strictObject({ ...base, ...eventAttempt, action: z.literal("claim") }),
    z.strictObject({ ...base, ...eventAttempt, action: z.literal("enter") }),
    z.strictObject({ ...base, ...eventAttempt, action: z.literal("ack"), outcome: z.enum(["accepted", "unknown", "rejected", "retryable-rejection", "not-sent"]) })
  ]);
  server.registerTool("codex_relay", {
    title: "Relay Delivery Protocol", description: "App-only current-generation relay connection, bounded recovery, atomic claim, send entry and idempotent attempt outcome. References never grant scope or execution authority.",
    inputSchema: mutation, outputSchema: relayMutationOutputSchema, _meta: appMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args, extra) => {
    const auth = owner(extra.mcpReq._meta, authenticatedMcpPrincipal(extra));
    const goal = state.relay.requireGoal(args.activityId, auth);
    if (args.action === "connect") {
      if (relayPresentationRef(args.inputRequestId) !== args.presentationRef) throw new Error("RELAY_PRESENTATION_MISMATCH: Refresh the exact task result.");
      const connected = state.relay.connect(args.activityId, auth, args.cardId);
      if (connected.ended || connected.monitoringStopped) return response({ kind: "relay" as const, stopped: true });
      for (const [key, controller] of waits) if (key.startsWith(args.activityId + "/") && key !== `${args.activityId}/${args.cardId}`) controller.abort();
      return response({ kind: "relay" as const, stopped: false, recoveryAfter: state.relay.recover(args.activityId) });
    }
    if (args.action === "recover") {
      if (goal.cardId !== args.cardId || goal.ended || goal.monitoringStopped) return response({ kind: "relay" as const, stopped: true });
      return response({ kind: "relay" as const, recoveryAfter: state.relay.recover(args.activityId, args.afterJob) });
    }
    try {
      if (args.action === "claim") return response({ kind: "relay" as const, event: state.relay.claim(args.activityId, auth, args.cardId, args.eventId, args.attemptId) });
      if (args.action === "enter") return response({ kind: "relay" as const, dispatch: state.relay.enter(args.activityId, auth, args.cardId, args.eventId, args.attemptId) });
    } catch (error) {
      if (error instanceof RelayEventUnavailableError) return retryableFailure(error.message);
      throw error;
    }
    return response({ kind: "relay" as const, event: state.relay.acknowledge(args.activityId, auth, args.cardId, args.eventId, args.attemptId, args.outcome) });
  });

  server.registerTool("codex_relay_wait", {
    title: "Wait for Relay Events", description: "App-only bounded read of this Activity's registered event references. Never creates a card, executes a Job or marks a result reviewed.",
    inputSchema: z.strictObject({ ...base, after: z.string().max(100).optional(), waitMs: z.number().int().min(0).max(25_000).default(25_000) }),
    outputSchema: relayWaitOutputSchema, _meta: appMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args, extra) => {
    const auth = owner(extra.mcpReq._meta, authenticatedMcpPrincipal(extra));
    const read = () => {
      const goal = state.relay.requireGoal(args.activityId, auth);
      const stopped = Boolean(goal.ended || goal.monitoringStopped || goal.cardId !== args.cardId || state.isEventActivityEnded(args.activityId));
      return { kind: "relay-wait" as const, revision: state.relayRevision, stopped, events: stopped ? [] : state.relay.pending(args.activityId) };
    };
    const initial = read();
    if (initial.stopped || initial.events.length || args.after !== initial.revision || !args.waitMs) return response(initial);
    const key = `${args.activityId}/${args.cardId}`;
    waits.get(key)?.abort();
    waits.delete(key);
    if (waits.size >= 8 || [...waits.keys()].filter(key => key.startsWith(args.activityId + "/")).length >= 2) {
      return retryableFailure("RELAY_WAIT_CAPACITY: Retry with bounded backoff.");
    }
    const controller = new AbortController(); waits.set(key, controller);
    try {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); unsubscribe(); controller.signal.removeEventListener("abort", finish); extra.mcpReq.signal?.removeEventListener("abort", finish); resolve(); };
        const unsubscribe = state.subscribeRelayReady(activityId => { if (activityId === args.activityId) finish(); });
        const timer = setTimeout(finish, args.waitMs);
        controller.signal.addEventListener("abort", finish, { once: true });
        extra.mcpReq.signal?.addEventListener("abort", finish, { once: true });
        if (extra.mcpReq.signal?.aborted || read().revision !== initial.revision) finish();
      });
      return response(read());
    } finally { if (waits.get(key) === controller) waits.delete(key); }
  });

  server.registerTool("codex_relay_control", {
    title: "Stop Goal Relay or Followups", description: "Honor an explicit user stop for this conversation's Activity. Stop relay messages without cancelling Jobs, or stop new followup admission without cancelling current Jobs. Final goal completion uses codex_activity_update. Neither stop is cleared by a late ACK, remount or Job completion.",
    inputSchema: z.strictObject({ activityId: z.string().uuid(), stop: z.enum(["relay", "followups"]) }), outputSchema: relayControlOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async (args, extra) => {
    state.relay.stop(args.activityId, owner(extra.mcpReq._meta, authenticatedMcpPrincipal(extra)), args.stop);
    return response({ kind: "relay-control" as const, activityId: args.activityId, stopped: args.stop });
  });

  server.registerTool("codex_result_review", {
    title: "Confirm Exact Result Review",
    description: "After actually reviewing an exact completed Job result returned by codex_status, confirm its returned relayReview eventId and version in the original authenticated conversation. This postpones only its unsent Relay notice for 60 seconds; it does not prove an answer was posted, finish the Activity, authorize followups, or retract an entered send. Identical retries never extend the hold.",
    inputSchema: z.strictObject({ eventId: z.string().regex(RELAY_EVENT_PATTERN), version: z.number().int().positive() }),
    outputSchema: relayReviewOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args, extra) => {
    const reviewed = state.relay.reviewResult(owner(extra.mcpReq._meta, authenticatedMcpPrincipal(extra)), args.eventId, args.version);
    return response({ kind: "result-review" as const, ...args, holdUntil: reviewed.until,
      alreadyReviewed: reviewed.alreadyReviewed, dispatchEntered: reviewed.dispatchEntered });
  });
}
