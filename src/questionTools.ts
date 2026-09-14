import * as z from "zod/v4";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/server";
import type { CodexJobRegistry } from "./tools.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import { ordinaryCodexQuestion, questionReference } from "./codexInputs.js";
import { questionHash, type UserQuestionRecord } from "./questionStore.js";
import { QUESTION_CARD_URI, registerQuestionCardResource } from "./questionCard.js";
import { defineToolResultContract, projectToolResult } from "./toolResultContracts.js";
import { guidance, modelNextActionOutputSchema } from "./nextActions.js";

export const USER_QUESTION_META = "codex/userQuestion@1";
const identifier = z.string().trim().min(1).max(200);
const questionField = z.strictObject({
  id: identifier, header: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(1000), isOther: z.boolean().optional(),
  options: z.array(z.strictObject({ label: z.string().trim().min(1).max(120),
    description: z.string().max(300) })).min(1).max(10).optional()
});
const answersSchema = z.record(identifier, z.array(z.string().trim().min(1).max(2000)).min(1).max(10));
const cardAnswersSchema = z.record(identifier, z.array(z.string().trim().min(1).max(2000)).length(1));
export const QUESTION_MODEL_OUTPUT_SCHEMAS = {
  status_input: z.strictObject({ kind: z.literal("codex-input"), jobId: identifier, jobVersion: z.number().int().positive(),
    cursor: z.string(), changed: z.boolean(), active: z.boolean(),
    questions: z.array(z.strictObject({ questionRef: z.string(), isBlocking: z.boolean(), questions: z.array(questionField) })),
    approvals: z.array(z.strictObject({ kind: z.string(), isBlocking: z.boolean(), reason: z.string() })),
    messages: z.array(z.strictObject({ id: z.string(), text: z.string(), createdAt: z.number() })),
    historyLimited: z.boolean(), hasMoreQuestions: z.boolean(), nextActions: z.array(modelNextActionOutputSchema), waitedMs: z.number(), timedOut: z.boolean() }),
  codex_answer: z.strictObject({ kind: z.literal("codex-answer"), jobId: identifier, questionRef: z.string(),
    delivery: z.enum(["delivered", "uncertain"]), answersPersisted: z.literal(false), nextActions: z.array(modelNextActionOutputSchema) }),
  codex_ask_user: z.strictObject({ kind: z.literal("user-question"), questionId: z.string(), status: z.enum(["pending", "answered", "cancelled"]),
    expiresAt: z.number(), nextActions: z.array(modelNextActionOutputSchema) }),
  codex_user_answer: z.strictObject({ kind: z.literal("user-answers"), responses: z.array(z.strictObject({
    questionId: z.string(), responseRef: z.string(), status: z.enum(["answered", "cancelled"]), title: z.string(),
    questions: z.array(questionField).optional(), answers: z.array(z.strictObject({ questionId: z.string(), values: z.array(z.string()) })).optional(), expiresAt: z.number() })) })
};
const cardOutput = z.strictObject({ kind: z.literal("user-question-card"), status: z.enum(["pending", "answered", "cancelled"]) });
export const QUESTION_APP_OUTPUT_SCHEMAS = {
  card: cardOutput,
  notification: z.strictObject({ kind: z.literal("question-notification"), send: z.boolean().optional(),
    attempt: z.string().optional(), responseRef: z.string().optional(), acknowledged: z.boolean().optional() })
};
const cardProof = { questionId: z.string().uuid(), revision: z.number().int().positive(), presentationToken: z.string().uuid(), scopeId: z.string().uuid().optional() };
const appMeta = { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const inFlight = new WeakMap<CodexJobRegistry, Map<string, { hash: string; promise: Promise<Record<string, unknown>> }>>();

export function registerQuestionTools(server: McpServer, jobs: CodexJobRegistry, scopeResolver: ScopeResolver, uiLocale: () => string) {
  registerQuestionCardResource(server);
  const store = jobs.admissionStateStore.questions;
  const scope = (meta: unknown) => scopeResolver.require(meta as ToolCallMetadata, undefined, "GPT question orchestration").scopeId;
  // Some card hosts omit conversation metadata on app-only calls. The private
  // bootstrap supplies routing, while the exact card proof still gates access.
  // Authoritative host metadata always takes precedence over this fallback.
  const cardScope = (meta: unknown, scopeId?: string) => scopeResolver.require(meta as ToolCallMetadata, scopeId, "GPT question card").scopeId;
  const ownedJob = (scopeId: string, id: string) => {
    const job = jobs.get(id), activity = job && jobs.getActivity(job.activityId), agent = job?.agentId && jobs.getAgent(job.agentId);
    if (!job || job.scopeId !== scopeId || activity?.scopeId !== scopeId || !agent || agent.scopeId !== scopeId) {
      throw new Error("INPUT_JOB_UNAVAILABLE: The Job is unavailable in this conversation.");
    }
    return job;
  };

  const questionInputSchema = z.strictObject({ jobId: identifier, afterCursor: z.string().regex(/^[a-f0-9]{64}$/).optional(), waitMs: z.number().int().min(0).max(60_000).optional() });
  const readInput = async (args: z.infer<typeof questionInputSchema>, extra: Parameters<ToolCallback<typeof questionInputSchema>>[1]) => {
    const scopeId = scopeResolver.require(extra.mcpReq._meta as ToolCallMetadata, undefined, "GPT question orchestration").scopeId;
    ownedJob(scopeId, args.jobId);
    const result = await jobs.waitForInput(args.jobId, args.afterCursor, args.waitMs, extra.mcpReq.signal);
    ownedJob(scopeId, args.jobId);
    return resultOf({ kind: "codex-input", ...result });
  };

  server.registerTool("codex_answer", {
    title: "Answer a Codex Question", description: "Answer a current ordinary Codex question in this conversation. This cannot grant approvals, supply authentication secrets, or start another turn.",
    inputSchema: z.strictObject({ requestId: z.string().uuid().describe("Idempotency UUID for this exact answer. Uncertain delivery must never be automatically resent."), jobId: identifier, questionRef: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact current ordinary question reference. Unrelated Job progress does not invalidate it."), answers: answersSchema.describe("Answers keyed by the exact question IDs; preserve allowed option labels.") }),
    outputSchema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_answer, annotations: { ...writeAnnotations, destructiveHint: true }
  }, async (args, extra) => {
    const scopeId = scope(extra.mcpReq._meta);
    ownedJob(scopeId, args.jobId);
    const hash = questionHash(args), key = scopeId + ":" + args.requestId;
    const operations = inFlight.get(jobs) || new Map();
    inFlight.set(jobs, operations);
    const pending = operations.get(key);
    if (pending) {
      if (pending.hash !== hash) throw new Error("ANSWER_REQUEST_CONFLICT: A different answer is already being dispatched.");
      return resultOf(await pending.promise);
    }
    const previous = store.delivery(scopeId, args.requestId, hash);
    if (previous) return resultOf(answerResult(args.jobId, args.questionRef, previous === "delivered" ? "delivered" : "uncertain"));
    const operation = (async () => {
      const job = ownedJob(scopeId, args.jobId);
      if (job.status !== "running" || job.trackingState !== "connected" || !job.workerId || job.workerGeneration === undefined) {
        throw new Error("QUESTION_UNAVAILABLE: The original worker and turn are no longer active.");
      }
      const input = job.pendingInteractions.find(q => questionReference(job, q) === args.questionRef);
      if (!input || !ordinaryCodexQuestion(input) || input.threadId !== job.threadId || input.turnId !== job.upstreamRequestId) {
        throw new Error("QUESTION_UNAVAILABLE: This is not a current ordinary question. Refresh codex_status query kind=input.");
      }
      validateAnswers(input.questions!, args.answers);
      store.beginDelivery(scopeId, args.requestId, args.questionRef, hash);
      try {
        await jobs.respondToInteraction(job.jobId, input.interactionId, { answers: args.answers });
        store.finishDelivery(scopeId, args.requestId, "delivered");
        return answerResult(job.jobId, args.questionRef, "delivered");
      } catch {
        try { store.finishDelivery(scopeId, args.requestId, "uncertain"); } catch { /* Durable dispatch intent prevents resend. */ }
        return answerResult(job.jobId, args.questionRef, "uncertain");
      }
    })();
    operations.set(key, { hash, promise: operation });
    try { return resultOf(await operation); } finally { operations.delete(key); }
  });

  server.registerTool("codex_ask_user", {
    title: "Ask the User", description: "Open a question card for the user and store their response for GPT. GPT decides how to use the answer; submission does not directly answer or approve Codex.",
    inputSchema: z.strictObject({ requestId: z.string().uuid().describe("Idempotency UUID for one question card. Reuse only for the identical questions."), title: z.string().trim().min(1).max(160), questions: z.array(questionField).min(1).max(3), expiresInMinutes: z.number().int().min(1).max(1440).optional().describe("Question and answer lifetime in minutes, at most 24 hours.") }),
    outputSchema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_ask_user, annotations: writeAnnotations,
    _meta: { ui: { resourceUri: QUESTION_CARD_URI, visibility: ["model"] }, "openai/outputTemplate": QUESTION_CARD_URI }
  }, async (args, extra) => {
    if (new Set(args.questions.map(q => q.id)).size !== args.questions.length) throw new Error("QUESTION_IDS_INVALID: Question IDs must be unique.");
    for (const q of args.questions) if (q.options && new Set(q.options.map(o => o.label)).size !== q.options.length) throw new Error("QUESTION_OPTIONS_INVALID: Option labels must be unique.");
    const record = jobs.admissionStateStore.transaction(() => store.create(scope(extra.mcpReq._meta), args));
    return { ...resultOf({ kind: "user-question", questionId: record.questionId, status: record.status,
      expiresAt: record.expiresAt, nextActions: [guidance("The card returns the user's answer to GPT. Read it with codex_user_answer, then decide whether and how to answer Codex.")] }),
      _meta: { [USER_QUESTION_META]: { ...proofOf(record), uiLocalePreference: uiLocale() } } };
  });

  server.registerTool("codex_user_answer", {
    title: "Read the User's Answer", description: "Read responses to GPT's question cards in this conversation. Reading a specific response marks it as seen.",
    inputSchema: z.strictObject({ responseRef: z.string().uuid().optional().describe("Exact response reference: returns its body and marks it seen. Omit to list up to 20 unread references without bodies or marking them seen.") }), outputSchema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_user_answer, annotations: readAnnotations
  }, async (args, extra) => resultOf({ kind: "user-answers", responses: jobs.admissionStateStore.transaction(() =>
    store.readResponses(scope(extra.mcpReq._meta), args.responseRef).map(record => ({ questionId: record.questionId,
      responseRef: record.responseRef, status: record.status, title: record.title,
      ...(args.responseRef ? { questions: record.questions, ...(record.answers ? { answers: Object.entries(record.answers).map(([questionId, values]) => ({ questionId, values })) } : {}) } : {}),
      expiresAt: record.expiresAt }))) }));

    const questionCardInputSchema = z.strictObject(cardProof);
  const readCard: ToolCallback<typeof questionCardInputSchema> = async (args, extra) => cardResult(store.requireCard(cardScope(extra.mcpReq._meta, args.scopeId), args), uiLocale());

  const questionSubmitInputSchema = z.strictObject({ ...cardProof, response: z.union([z.strictObject({ answers: cardAnswersSchema }), z.strictObject({ cancel: z.literal(true) })]) });
  const submitCard: ToolCallback<typeof questionSubmitInputSchema> = async (args, extra) => {
    const record = jobs.admissionStateStore.transaction(() => {
      const record = store.requireCard(cardScope(extra.mcpReq._meta, args.scopeId), args);
      if ("cancel" in args.response) return record.status === "cancelled" ? record : store.cancel(record);
      validateAnswers(record.questions, args.response.answers);
      return store.submit(record, args.response.answers);
    });
    return cardResult(record, uiLocale());
  };

  const questionNotifyInputSchema = z.strictObject({ ...cardProof, operation: z.union([z.strictObject({ kind: z.literal("claim") }), z.strictObject({ kind: z.literal("ack"), attempt: z.string().uuid(), state: z.enum(["requested", "failed", "uncertain"]) })]) });
  const notifyCard: ToolCallback<typeof questionNotifyInputSchema> = async (args, extra) => {
    const result = jobs.admissionStateStore.transaction(() => {
      const record = store.requireCard(cardScope(extra.mcpReq._meta, args.scopeId), args);
      if (args.operation.kind === "claim") return { ...store.claimNotification(record), responseRef: record.responseRef };
      store.acknowledgeNotification(record, args.operation.attempt, args.operation.state);
      return { acknowledged: true };
    });
    return resultOf({ kind: "question-notification", ...result });
  };

  const questionActionInput = questionCardInputSchema.extend({ operation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("submit"), response: questionSubmitInputSchema.shape.response }),
    z.strictObject({ kind: z.literal("claim") }),
    z.strictObject({ kind: z.literal("ack"), attempt: z.string().uuid(), state: z.enum(["requested", "failed", "uncertain"]) })
  ]) });
  server.registerTool("codex_question_action", {
    title: "Update Question Card", description: "App-only user answer submission and follow-up delivery tracking. Answer storage, notification claim, host acknowledgment, and GPT consumption are separate states.",
    inputSchema: questionActionInput,
    outputSchema: z.union([cardOutput, QUESTION_APP_OUTPUT_SCHEMAS.notification]),
    annotations: writeAnnotations, _meta: appMeta
  }, async (args, extra) => {
    const { operation, ...proof } = args;
    if (operation.kind === "submit") return submitCard({ ...proof, response: operation.response }, extra);
    const result = await notifyCard({ ...proof, operation }, extra);
    return { ...result, _meta: cardResult(store.requireCard(cardScope(extra.mcpReq._meta, proof.scopeId), proof), uiLocale())._meta };
  });
  return { readInput, readCard, questionInputSchema, questionCardInputSchema };
}

export function validateAnswers(questions: Array<{ id: string; isOther?: boolean; options?: Array<{ label: string }> }>, answers: Record<string, string[]>): void {
  if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(questions.map(q => q.id).sort())) throw new Error("ANSWER_IDS_INVALID: Answer the exact question IDs.");
  for (const q of questions) if (q.options?.length && q.isOther === false && answers[q.id].some(answer => !q.options!.some(o => o.label === answer))) {
    throw new Error("ANSWER_OPTION_INVALID: Choose one of the available answers.");
  }
}

function proofOf(record: UserQuestionRecord) {
  return { questionId: record.questionId, revision: record.revision, presentationToken: record.presentationToken, scopeId: record.scopeId };
}

function cardResult(record: UserQuestionRecord, uiLocalePreference: string) {
  return { ...resultOf({ kind: "user-question-card", status: record.status }),
    _meta: { [USER_QUESTION_META]: { ...proofOf(record), uiLocalePreference, title: record.title, questions: record.questions,
      status: record.status, expiresAt: record.expiresAt, responseRef: record.responseRef,
      notification: record.notification, consumed: Boolean(record.consumedAt) } } };
}

function resultOf(value: Record<string, unknown>) {
  const resultContracts = {
    "codex-input": { toolName: "codex_status", channel: "model-orchestrator-semantic" as const, schema: QUESTION_MODEL_OUTPUT_SCHEMAS.status_input },
    "codex-answer": { toolName: "codex_answer", channel: "model-orchestrator-semantic" as const, schema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_answer },
    "user-question": { toolName: "codex_ask_user", channel: "model-orchestrator-semantic" as const, schema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_ask_user },
    "user-answers": { toolName: "codex_user_answer", channel: "model-orchestrator-semantic" as const, schema: QUESTION_MODEL_OUTPUT_SCHEMAS.codex_user_answer },
    "user-question-card": { toolName: "codex_ui_read", channel: "app-hydration" as const, schema: cardOutput },
    "question-notification": { toolName: "codex_question_action", channel: "app-hydration" as const, schema: QUESTION_APP_OUTPUT_SCHEMAS.notification }
  } as const;
  const selected = resultContracts[String(value.kind) as keyof typeof resultContracts];
  if (!selected) throw new Error("Unknown question output contract.");
  const contract = defineToolResultContract({ toolName: selected.toolName, channel: selected.channel,
    outputSchema: selected.schema, structured: { maxBytes: 128 * 1024 },
    compatibility: { channel: "text-protocol-compatibility", format: "compact-json", maxBytes: 128 * 1024, completeness: "primary-payload" } });
  return projectToolResult(contract, { canonical: value,
    authoritative: { channel: contract.channel, value: selected.schema.parse(value) }, compatibility: { channel: "text-protocol-compatibility", text: JSON.stringify(value) } });
}

function answerResult(jobId: string, questionRef: string, delivery: string) {
  return { kind: "codex-answer", jobId, questionRef, delivery, answersPersisted: false,
    nextActions: delivery === "delivered"
      ? [guidance("Read Codex input or its terminal result.")]
      : [guidance("Delivery is uncertain. Inspect the exact Job; do not resend automatically or under a new request ID.")] };
}
