import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer, ProtocolError, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";
import type { CodexJobRegistry } from "./tools.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import { JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT, lifecycleEvent, type JobEventName, type EventJob, type EventSubscription } from "./mcpEventStore.js";
import { EventDestinationVault, sendPublicWebhook, signedHeaders, validateCallbackUrl, validateSigningSecret, type WebhookSender } from "./mcpWebhook.js";
import { FOLLOWUP_ID_PATTERN } from "./taskFollowups.js";
import { mcpOAuthPrincipal } from "./mcpOAuth.js";
import { EVENT_ACCESS_LIFETIME_MS, eventAccessOutputSchema, eventCallbackHash, SUBSCRIPTION_REF_PATTERN, type EventAccessReceipt } from "./mcpEventAccess.js";

const argsSchema = z.strictObject({ jobId: z.string().uuid(),
  subscriptionRef: z.string().regex(SUBSCRIPTION_REF_PATTERN).optional() });
const deliverySchema = z.strictObject({ mode: z.literal("webhook"), url: z.string().max(4_096), secret: z.string().max(100) });
const subscribeSchema = z.strictObject({
  name: z.enum([JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT]), arguments: argsSchema, delivery: deliverySchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional()
});
const unsubscribeSchema = z.strictObject({
  name: z.enum([JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT]), arguments: argsSchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
  delivery: deliverySchema.omit({ secret: true })
});
const SUBSCRIPTION_TTL_MS = 60 * 60 * 1_000;
const MAX_TTL_MS = 24 * SUBSCRIPTION_TTL_MS;
const MAX_ATTEMPTS = 8;
const VERIFICATION_CACHE_MS = 5 * 60 * 1_000;
const ROTATION_MS = 5 * 60 * 1_000;

export { mcpBearerPrincipal, authenticatedMcpPrincipal } from "./mcpPrincipal.js";
import { mcpBearerPrincipal, authenticatedMcpPrincipal } from "./mcpPrincipal.js";

export const JOB_TERMINAL_EVENT_DEFINITION = {
  name: JOB_TERMINAL_EVENT,
  description: "An exact owned Codex Job has a committed terminal result or failure. Retrieve and review its original state with codex_status. Notification grants no authority. Continue within the original user goal through its declared receipt or ordinary codex_task continue, preserving exact requestId retries and decision/stop boundaries.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(argsSchema),
  payloadSchema: {
    type: "object", additionalProperties: false,
    properties: {
      jobId: { type: "string", format: "uuid" },
      activityId: { type: ["string", "null"] }, agentId: { type: ["string", "null"] },
      state: { enum: ["completed", "failed", "interrupted", "cancelled"] },
      terminalVersion: { type: "integer", minimum: 1 },
      availableFollowups: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
        properties: { followupId: { type: "string", pattern: FOLLOWUP_ID_PATTERN.source } }, required: ["followupId"] } },
      result: { type: "object", additionalProperties: false,
        properties: { tool: { const: "codex_status" }, query: { type: "object", additionalProperties: false,
          properties: { kind: { const: "job" }, id: { type: "string", format: "uuid" } }, required: ["kind", "id"] } }, required: ["tool", "query"] }
    }, required: ["jobId", "activityId", "agentId", "state", "terminalVersion", "result"]
  }
};

export const JOB_LIFECYCLE_EVENT_DEFINITION = {
  name: JOB_LIFECYCLE_EVENT,
  description: "Opt-in monitoring from an exact root Events Job: current input and terminal results for that root and later Events Jobs in the same original scope, Activity, Agent and project. One verified root receiver remains connected across A/B admission and response loss. Read the supplied exact codex_status query in the original tool scope; notifications never authorize answers, approvals, tasks or overall completion. No host resumption guarantee is implied.",
  delivery: ["webhook"], inputSchema: z.toJSONSchema(argsSchema),
  payloadSchema: { type: "object", additionalProperties: false, properties: {
    rootJobId: { type: "string", format: "uuid" }, jobId: { type: "string", format: "uuid" },
    activityId: { type: "string", format: "uuid" }, agentId: { type: "string", format: "uuid" },
    kind: { enum: ["input-required", "terminal"] }, state: { type: "string" }, version: { type: "integer", minimum: 1 },
    result: { type: "object", additionalProperties: false, properties: { tool: { const: "codex_status" }, query: { oneOf: [
      { type: "object", additionalProperties: false, properties: { kind: { const: "job" }, id: { type: "string", format: "uuid" } }, required: ["kind", "id"] },
      { type: "object", additionalProperties: false, properties: { kind: { const: "input" }, jobId: { type: "string", format: "uuid" } }, required: ["kind", "jobId"] }
    ] } }, required: ["tool", "query"] }
  }, required: ["rootJobId", "jobId", "activityId", "agentId", "kind", "state", "version", "result"] }
};

/** One bounded outbound worker in the existing state owner. HTTP request-scoped
 * SDK servers share it; it observes durable subscriptions rather than polling
 * Codex, predicting completion, or admitting any work. */
export class McpEventsController {
  private readonly vault?: EventDestinationVault;
  private readonly principal?: string;
  private readonly stop = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly verifying = new Map<string, number>();

  constructor(private readonly config: BridgeConfig, private readonly jobs: CodexJobRegistry,
    private readonly scopes: ScopeResolver, private readonly sender: WebhookSender = sendPublicWebhook) {
    if (config.experimentalProfile !== "events" || !config.eventsEnabled) {
      throw new Error("EVENTS_PROFILE_DISABLED: Select the explicit Events experiment before initializing its services.");
    }
    if (config.token && !config.noAuth) {
      this.principal = config.oauth ? mcpOAuthPrincipal(config.oauth) : mcpBearerPrincipal(config.token);
      this.vault = new EventDestinationVault(config.token);
    }
    jobs.admissionStateStore.configureExperimentalEvents(true);
    jobs.configureEventDelivery(config.oauth ? this.principal : undefined);
    this.unsubscribe = jobs.admissionStateStore.subscribeMcpEventReady(() => this.wake());
    const ledger = jobs.admissionStateStore.mcpEvents;
    for (const root of ledger.lifecycleRoots()) {
      if (jobs.admissionStateStore.isEventActivityEnded(root.lifecycleRoot!.activityId)) {
        jobs.activityTransaction(() => ledger.stopActivity(root.lifecycleRoot!.activityId));
      } else ledger.reconcileLifecycle(root);
    }
    this.wake();
  }

  install(server: McpServer): void {
    if (this.config.oauth && this.vault) {
      server.registerTool("codex_event_access", {
        title: "Delegate Exact Job Events",
        description: "Issue or recover a Bridge-generated subscriptionRef for this exact Events Job, or revoke its delegations. After explicit revocation or unsubscribe, issue a new reference only when the user asks to resume monitoring; never treat their stop as an automatic recovery step. Requires an authenticated ordinary tool call in the original conversation. Supply only the returned Job ID; never invent a reference or scope. Select event=codex.job.lifecycle for current input and later Events Jobs in this original Activity/Agent/project through one verified receiver. Omit event for exact terminal-only consent. Pass the returned event and exact arguments unchanged to native events/subscribe, refresh and unsubscribe. This grants monitoring only, never result reads, task execution or configuration. Subscription success does not prove the callback belongs to the original conversation. No Dashboard, ui/message, scheduled task or polling fallback is permitted.",
        inputSchema: z.strictObject({ action: z.enum(["issue", "revoke"]), jobId: z.string().uuid(),
          event: z.enum([JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT]).optional().describe("Omit for exact terminal monitoring. Select codex.job.lifecycle to explicitly monitor this root and later Events Jobs in the same original Activity/Agent/project, including current questions. This is receiver consent only, never tool authority.") }),
        outputSchema: eventAccessOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }, (args, context) => {
        const principal = this.authorize(context);
        const scopeId = this.requireScope(context);
        const structuredContent = this.jobs.activityTransaction(() => {
          this.authorize(context);
          const event = args.event || JOB_TERMINAL_EVENT;
          const job = this.requireJob(args.jobId, scopeId, principal, event);
          if (job.completionDeliveryPolicy !== "events") throw this.denied();
          const access = this.jobs.admissionStateStore.mcpEventAccess;
          if (args.action === "revoke") {
            access.revoke(job.jobId, principal, scopeId);
            return eventAccessOutputSchema.parse({ jobId: job.jobId, state: "revoked", event });
          }
          const issued = access.issue(job, principal, this.config.token!, Date.now(), event);
          return eventAccessOutputSchema.parse({ jobId: job.jobId,
            ...access.subscriptionState(job, Date.now(), event),
            event, arguments: { jobId: job.jobId, subscriptionRef: issued.subscriptionRef },
            expiresAt: new Date(issued.record.expiresAt).toISOString() });
        });
        this.wake();
        return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
      });
    }
    // SDK v2's core types do not yet include the draft Events extension.
    server.server.registerCapabilities({ events: {} } as Parameters<typeof server.server.registerCapabilities>[0]);
    server.server.setRequestHandler("events/list", { params: z.strictObject({ cursor: z.null().optional(), _meta: z.record(z.string(), z.unknown()).optional() }) }, (_params, context) => {
      this.authorize(context);
      const definition = this.config.oauth ? {
        ...JOB_TERMINAL_EVENT_DEFINITION,
        description: JOB_TERMINAL_EVENT_DEFINITION.description + " For an Events Job, obtain its subscriptionRef through codex_event_access in the original conversation and preserve both arguments on subscribe, refresh and unsubscribe.",
        inputSchema: { type: "object", additionalProperties: false, properties: {
          jobId: { type: "string", format: "uuid" },
          subscriptionRef: { type: "string", pattern: SUBSCRIPTION_REF_PATTERN.source }
        }, required: ["jobId", "subscriptionRef"] }
      } : JOB_TERMINAL_EVENT_DEFINITION;
      return { events: [definition, ...(this.config.oauth ? [{ ...JOB_LIFECYCLE_EVENT_DEFINITION, inputSchema: definition.inputSchema }] : [])], ttlMs: 0, cacheScope: "private" };
    });
    server.server.setRequestHandler("events/subscribe", { params: subscribeSchema }, (params, context) => this.subscribe(params, context));
    server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeSchema }, (params, context) => {
      const principal = this.authorize(context);
      const { scopeId, access } = this.resolveAccess(params.arguments, context, principal, true, params.name);
      const id = this.identity(principal, scopeId, params.arguments, params.delivery.url, params.name);
      if (this.verifying.has(id)) this.verifying.set(id, this.verifying.get(id)! + 1);
      const ledger = this.jobs.admissionStateStore.mcpEvents;
      this.jobs.activityTransaction(() => {
        this.authorize(context);
        const currentAccess = this.resolveAccess(params.arguments, context, principal, true, params.name).access;
        if (access && currentAccess?.revision !== access.revision) throw this.changed();
        const record = ledger.get(params.arguments.jobId, id);
        if (currentAccess) {
          if (currentAccess.callbackHash && (currentAccess.callbackHash !== eventCallbackHash(params.delivery.url) ||
              currentAccess.subscriptionId !== id)) throw this.denied();
          // Also fences a still-pending first challenge without creating a binding.
          if (!this.jobs.admissionStateStore.mcpEventAccess.unsubscribe(currentAccess)) throw this.changed();
        }
        if (!record) return;
        if (record.scopeId !== scopeId || record.principal !== principal) throw this.denied();
        if (!ledger.save({ ...record, revision: record.revision + 1, disabled: "unsubscribed" }, record.revision)) {
          throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        }
        if (params.name === JOB_LIFECYCLE_EVENT) ledger.stopLifecycleChildren(record, "unsubscribed");
      });
      return {};
    });
  }

  private async subscribe(params: z.infer<typeof subscribeSchema>, context: ServerContext) {
    const principal = this.authorize(context);
    const { scopeId, access } = this.resolveAccess(params.arguments, context, principal, false, params.name);
    const id = this.identity(principal, scopeId, params.arguments, params.delivery.url, params.name);
    if (access?.callbackHash && (access.callbackHash !== eventCallbackHash(params.delivery.url) || access.subscriptionId !== id)) throw this.denied();
    const ledger = this.jobs.admissionStateStore.mcpEvents;
    ledger.maintain();
    const old = ledger.get(params.arguments.jobId, id);
    if (this.verifying.has(id) || this.verifying.size >= 8) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "verification_busy" });
    this.verifying.set(id, 0);
    try {
      let destination;
      try {
        validateCallbackUrl(params.delivery.url);
        validateSigningSecret(params.delivery.secret);
        destination = old && old.principal === principal ? this.vault!.open(id, old.destination) : undefined;
      } catch { throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "invalid_destination_or_secret" }); }
      const now = Date.now();
      if (!old || old.disabled || old.verifiedAt + VERIFICATION_CACHE_MS <= now || destination?.secret !== params.delivery.secret) {
        const challenge = randomUUID();
        const body = JSON.stringify({ type: "verification", challenge });
        const verificationId = "msg_verification_" + randomUUID();
        try {
          const response = await this.sender(params.delivery.url, body,
            signedHeaders(verificationId, id, body, [params.delivery.secret]),
            AbortSignal.any([this.stop.signal, context.mcpReq.signal, AbortSignal.timeout(10_000)]));
          const returned = JSON.parse(response.body).challenge;
          const expected = Buffer.from(challenge);
          const actual = typeof returned === "string" ? Buffer.from(returned) : Buffer.alloc(0);
          if (response.status < 200 || response.status >= 300 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("challenge_failed");
        } catch (error) {
          const reason = error instanceof Error && error.message === "timeout" ? "timeout" : "challenge_failed";
          throw new ProtocolError(-32015, "CallbackEndpointError", { reason });
        }
      }
      const verifiedAt = Date.now();
      this.authorize(context); // A token can expire while the callback challenge is running.
      const expiresAt = Math.min(verifiedAt + Math.min(params.ttlMs ?? SUBSCRIPTION_TTL_MS, MAX_TTL_MS),
        context.http?.authInfo?.expiresAt !== undefined ? context.http.authInfo.expiresAt * 1_000 : Infinity,
        access?.expiresAt ?? Infinity);
      this.jobs.activityTransaction(() => {
        this.authorize(context);
        const current = ledger.get(params.arguments.jobId, id);
        if (this.verifying.get(id) !== 0) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        if ((current?.revision || 0) !== (old?.revision || 0)) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        const currentAuthorization = this.resolveAccess(params.arguments, context, principal, false, params.name);
        const currentAccess = currentAuthorization.access;
        if (access && currentAccess?.revision !== access.revision) throw this.changed();
        const job = currentAuthorization.job!;
        if (context.mcpReq.signal.aborted || this.stop.signal.aborted) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "timeout" });
        const rotating = destination && destination.secret !== params.delivery.secret;
        if (currentAccess) {
          if (currentAccess.callbackHash && (currentAccess.callbackHash !== eventCallbackHash(params.delivery.url) ||
              currentAccess.subscriptionId !== id)) throw this.denied();
          if (!currentAccess.callbackHash && !this.jobs.admissionStateStore.mcpEventAccess.save({
            ...currentAccess, callbackHash: eventCallbackHash(params.delivery.url), subscriptionId: id,
            revision: currentAccess.revision + 1
          }, currentAccess.revision)) throw this.changed();
        }
        // Delivery can advance without changing the grant revision while the
        // challenge awaits. Preserve its event, ACK, attempts and retry state.
        const saved = ledger.save({
          ...current,
          id, jobId: job.jobId, scopeId, principal, verifiedAt, expiresAt, revision: (current?.revision || 0) + 1,
          ...(params.name === JOB_LIFECYCLE_EVENT ? { name: params.name,
            lifecycleRoot: { jobId: job.jobId, activityId: job.activityId!, agentId: job.agentId!, projectId: job.projectId!, createdAt: access!.rootCreatedAt! } } : {}),
          accessReferenceHash: currentAccess?.referenceHash,
          disabled: undefined,
          destination: this.vault!.seal(id, { url: params.delivery.url, secret: params.delivery.secret,
            ...(rotating ? { previousSecret: destination!.secret, rotateUntil: verifiedAt + ROTATION_MS }
              : destination?.rotateUntil && destination.rotateUntil > verifiedAt ? { previousSecret: destination.previousSecret, rotateUntil: destination.rotateUntil } : {}) }),
          delivery: current?.delivery || "waiting", attempts: current?.attempts || 0, nextAttemptAt: current?.nextAttemptAt || 0
        }, current?.revision ?? 0);
        if (!saved) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        if (params.name === JOB_LIFECYCLE_EVENT) {
          const root = ledger.get(job.jobId, id)!;
          ledger.refreshLifecycleChildren(root);
          ledger.reconcileLifecycle(root);
        } else ledger.enqueue(job);
      });
      this.wake();
      return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    } finally { this.verifying.delete(id); }
  }

  private authorize(context: ServerContext): string {
    if (!this.principal || authenticatedMcpPrincipal(context) !== this.principal) throw this.denied();
    return this.principal;
  }

  private denied() { return new ProtocolError(-32001, "Events require an authenticated connection and the original conversation's owned Job."); }

  private changed() { return new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" }); }

  private resolveAccess(args: z.infer<typeof argsSchema>, context: ServerContext, principal: string, allowInactive = false, event: JobEventName = JOB_TERMINAL_EVENT): {
    scopeId: string; access?: EventAccessReceipt; job?: EventJob;
  } {
    const metadata = context.mcpReq._meta as ToolCallMetadata;
    // Presence is distinct from validity. A malformed or different session
    // never falls back to a reference, even if the reference itself is valid.
    const hasSession = metadata && Object.prototype.hasOwnProperty.call(metadata, "openai/session");
    const hostScope = hasSession ? this.requireScope(context) : undefined;
    if (!args.subscriptionRef) {
      if (event === JOB_LIFECYCLE_EVENT) throw this.denied();
      const scopeId = hostScope || this.requireScope(context);
      const job = this.requireJob(args.jobId, scopeId, principal);
      if (job.completionDeliveryPolicy === "events") throw this.denied();
      return { scopeId, job };
    }
    if (!this.config.oauth) throw this.denied();
    const access = this.jobs.admissionStateStore.mcpEventAccess.get(args.subscriptionRef, this.config.token!);
    if (!access || access.principal !== principal || access.jobId !== args.jobId || access.event !== event ||
        hostScope && hostScope !== access.scopeId ||
        !allowInactive && (access.revokedAt !== undefined || access.unsubscribedAt !== undefined || access.expiresAt <= Date.now() ||
          access.subscriptionId && this.jobs.admissionStateStore.mcpEvents.get(access.jobId, access.subscriptionId)?.disabled === "unsubscribed")) throw this.denied();
    const job = !allowInactive ? this.requireJob(args.jobId, access.scopeId, principal, event) : undefined;
    if (job) {
      if (!this.jobs.admissionStateStore.mcpEventAccess.matches(access, job, principal)) throw this.denied();
    }
    return { scopeId: hostScope || access.scopeId, access, job };
  }

  private requireScope(context: ServerContext): string {
    let scope;
    try {
      scope = this.scopes.resolve(context.mcpReq._meta as ToolCallMetadata);
    } catch {
      throw new ProtocolError(-32001, "Events require valid original conversation metadata.", { reason: "invalid_conversation_scope" });
    }
    if (!scope) {
      throw new ProtocolError(-32001, "Events require original conversation metadata.", { reason: "missing_conversation_scope" });
    }
    return scope.scopeId;
  }

  private requireJob(jobId: string, scopeId: string, principal: string, event: JobEventName = JOB_TERMINAL_EVENT): EventJob {
    const job = this.jobs.get(jobId);
    const activity = job && this.jobs.getActivity(job.activityId);
    const agent = job?.agentId && this.jobs.getAgent(job.agentId);
    if (!job || !this.jobs.admissionStateStore.isEventJobRetained(jobId) || job.scopeId !== scopeId || job.mcpPrincipal !== principal ||
        activity?.scopeId !== scopeId || !agent || agent.scopeId !== scopeId ||
        job.projectId && !this.jobs.admissionStateStore.isEventProjectAvailable(job.projectId) ||
        event === JOB_LIFECYCLE_EVENT && this.jobs.admissionStateStore.isEventActivityEnded(job.activityId)) throw this.denied();
    const completion = this.jobs.admissionStateStore.getJobCompletionDelivery(jobId, scopeId);
    return { ...job, terminalVersion: completion?.terminalVersion, updatedAt: completion?.createdAt || job.updatedAt };
  }

  private identity(principal: string, scopeId: string, args: z.infer<typeof argsSchema>, url: string, event: JobEventName = JOB_TERMINAL_EVENT): string {
    return "sub_" + createHash("sha256").update(JSON.stringify([principal, scopeId, event,
      { jobId: args.jobId, ...(args.subscriptionRef ? { subscriptionRef: args.subscriptionRef } : {}) }, url])).digest("hex");
  }

  wake(): void {
    if (this.stop.signal.aborted || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let deliveryFailed = false;
      this.running = this.deliver().catch(() => { deliveryFailed = true; }).finally(() => {
        this.running = undefined;
        if (!this.stop.signal.aborted) {
          try {
            const now = Date.now();
            const deadlines = [...this.jobs.admissionStateStore.mcpEventAccess.list().map(grant => grant.expiresAt + EVENT_ACCESS_LIFETIME_MS),
              ...this.jobs.admissionStateStore.mcpEvents.list().flatMap(record => [
              Math.max(record.expiresAt, record.recoverUntil || 0),
              ...(!record.disabled && record.expiresAt > now && record.event && record.delivery === "pending" ? [record.nextAttemptAt] : [])
            ])];
            if (deadlines.length) {
              this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, Math.max(deliveryFailed ? 10_000 : 100, Math.min(...deadlines) - now));
              this.timer.unref();
            }
          } catch {
            // A state failure delays only delivery. No execution is inferred.
            this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, 10_000);
            this.timer.unref();
          }
        }
      });
    }, 0);
    this.timer.unref();
  }

  private async deliver(): Promise<void> {
    const ledger = this.jobs.admissionStateStore.mcpEvents;
    this.jobs.admissionStateStore.mcpEventAccess.maintain();
    ledger.maintain();
    for (const root of ledger.lifecycleRoots().filter(record => record.recoveryPending)) ledger.reconcileLifecycle(root);
    for (const { jobId, id } of ledger.list()) {
      if (this.stop.signal.aborted) break;
      // Another subscription's network await may have allowed this grant to
      // expire, renew or unsubscribe. The list supplies identities only.
      const record = ledger.get(jobId, id);
      if (!record || record.disabled || record.expiresAt <= Date.now() || record.delivery !== "pending" || record.nextAttemptAt > Date.now()) continue;
      if (!record.event) continue;
      if (record.attempts >= MAX_ATTEMPTS) { ledger.save({ ...record, delivery: "failed" }, record.revision); continue; }
      try {
        const job = this.requireDeliveryJob(record);
        if (record.lifecycleRoot && lifecycleEvent(job, record.lifecycleRoot)?.eventId !== record.event.eventId) {
          this.jobs.activityTransaction(() => ledger.enqueueLifecycle(job));
          continue;
        }
      }
      catch (error) {
        // An unavailable state read is not evidence of revoked access.
        if (!(error instanceof ProtocolError)) throw error;
        ledger.save({ ...record, revision: record.revision + 1, disabled: "revoked" }, record.revision); continue;
      }
      let response;
      // Persist before opening keys or sending, including failed signing attempts.
      record.attempts += 1;
      if (!ledger.save(record, record.revision)) continue;
      try {
        const destination = this.vault!.open(record.id, record.destination);
        const body = JSON.stringify(record.event);
        const secrets = [destination.secret];
        if (destination.previousSecret && (destination.rotateUntil || 0) > Date.now()) secrets.push(destination.previousSecret);
        response = await this.sender(destination.url, body,
          signedHeaders(record.event.eventId, record.id, body, secrets),
          AbortSignal.any([this.stop.signal, AbortSignal.timeout(10_000)]));
      } catch { response = { status: 0 }; }
      if (this.stop.signal.aborted) break;
      const current = ledger.get(record.jobId, record.id);
      if (!current || current.revision !== record.revision || current.disabled || current.expiresAt <= Date.now() ||
          current.delivery !== "pending" || current.event?.eventId !== record.event.eventId) continue;
      if (current.lifecycleRoot) {
        try {
          const latest = this.requireDeliveryJob(current);
          if (lifecycleEvent(latest, current.lifecycleRoot)?.eventId !== current.event?.eventId) {
            this.jobs.activityTransaction(() => ledger.enqueueLifecycle(latest));
            continue;
          }
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          ledger.save({ ...current, disabled: "revoked", revision: current.revision + 1 }, current.revision);
          continue;
        }
      }
      const status = response.status;
      const acknowledged = status >= 200 && status < 300;
      const transient = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
      const failed = !acknowledged && (!transient || current.attempts >= MAX_ATTEMPTS);
      ledger.save({ ...current, lastStatus: status,
        delivery: acknowledged ? "acknowledged" : failed ? "failed" : "pending",
        ...(status === 410 ? { disabled: "gone" as const, revision: current.revision + 1 } : {}),
        ...(acknowledged ? { acknowledgedAt: Date.now() } : {}),
        nextAttemptAt: Date.now() + Math.min(60_000, 1_000 * 2 ** current.attempts)
      }, current.revision);
      if (status === 410 && current.lifecycleRoot) this.jobs.activityTransaction(() => {
        const root = ledger.get(current.lifecycleRoot!.jobId, current.id);
        if (!root) return;
        if (!root.disabled) ledger.save({ ...root, disabled: "gone", revision: root.revision + 1 }, root.revision);
        ledger.stopLifecycleChildren(root, "gone");
      });
    }
  }

  private requireDeliveryJob(record: EventSubscription): EventJob {
    if (record.principal !== this.principal) throw this.denied();
    const event = record.name || JOB_TERMINAL_EVENT;
    const job = this.requireJob(record.jobId, record.scopeId, record.principal, event);
    if (!record.accessReferenceHash) {
      if (job.completionDeliveryPolicy === "events" || event === JOB_LIFECYCLE_EVENT) throw this.denied();
      return job;
    }
    const access = this.jobs.admissionStateStore.mcpEventAccess.getByHash(record.accessReferenceHash);
    if (!access || access.event !== event || access.revokedAt !== undefined || access.unsubscribedAt !== undefined || access.expiresAt <= Date.now() || access.subscriptionId !== record.id) throw this.denied();
    const root = record.lifecycleRoot;
    const owner = root ? this.requireJob(root.jobId, record.scopeId, record.principal, event) : job;
    if (!this.jobs.admissionStateStore.mcpEventAccess.matches(access, owner, record.principal)) throw this.denied();
    if (root) {
      const receiver = this.jobs.admissionStateStore.mcpEvents.get(root.jobId, record.id);
      if (!receiver || receiver.disabled || receiver.expiresAt <= Date.now() || receiver.accessReferenceHash !== record.accessReferenceHash ||
          record.jobId !== root.jobId && record.rootRevision !== receiver.revision ||
          !this.jobs.admissionStateStore.mcpEvents.matchesLifecycle(receiver, job)) throw this.denied();
      // Registry observation can run ahead of a failed/deferred source commit.
      // Reconciliation may publish only the exact durable source, never invent
      // an input/terminal intent from an uncommitted in-memory observation.
      const durable = this.jobs.admissionStateStore.getEventJobSnapshot(record.jobId);
      if (!durable || !this.jobs.admissionStateStore.mcpEvents.matchesLifecycle(receiver, durable)) throw this.denied();
      return durable;
    }
    return job;
  }

  async close(): Promise<void> { this.stop.abort(); this.unsubscribe(); if (this.timer) clearTimeout(this.timer); await this.running; this.jobs.configureEventDelivery(undefined, false); this.jobs.admissionStateStore.configureExperimentalEvents(false); }
}
