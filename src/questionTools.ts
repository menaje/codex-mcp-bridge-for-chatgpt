import * as z from "zod/v4";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/server";
import type { CodexJobRegistry } from "./tools.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import { ordinaryCodexQuestion, questionReference } from "./codexInputs.js";
import { questionHash } from "./questionStore.js";
import { defineToolResultContract, projectToolResult } from "./toolResultContracts.js";
import { guidance, modelNextActionOutputSchema } from "./nextActions.js";

const identifier = z.string().trim().min(1).max(200);
const questionField = z.strictObject({
  id: identifier,
  header: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(1000),
  isOther: z.boolean().optional(),
  options: z.array(z.strictObject({
    label: z.string().trim().min(1).max(120),
    description: z.string().max(300)
  })).min(1).max(10).optional()
});
const answersSchema = z.record(identifier, z.array(z.string().trim().min(1).max(2000)).min(1).max(10));

/** Model-visible contracts for ordinary Codex input and its answer. User
 * questions are handled by the host conversation, so no question-card tool is
 * registered here. */
export const CODEX_INPUT_MODEL_OUTPUT_SCHEMAS = {
  status_input: z.strictObject({
    kind: z.literal("codex-input"), jobId: identifier, jobVersion: z.number().int().positive(),
    cursor: z.string(), changed: z.boolean(), active: z.boolean(),
    questions: z.array(z.strictObject({ questionRef: z.string(), isBlocking: z.boolean(), questions: z.array(questionField) })),
    approvals: z.array(z.strictObject({ kind: z.string(), isBlocking: z.boolean(), reason: z.string() })),
    messages: z.array(z.strictObject({ id: z.string(), text: z.string(), createdAt: z.number() })),
    historyLimited: z.boolean(), hasMoreQuestions: z.boolean(), nextActions: z.array(modelNextActionOutputSchema),
    waitedMs: z.number(), timedOut: z.boolean()
  }),
  codex_answer: z.strictObject({
    kind: z.literal("codex-answer"), jobId: identifier, questionRef: z.string(),
    delivery: z.enum(["delivered", "uncertain"]), answersPersisted: z.literal(false),
    nextActions: z.array(modelNextActionOutputSchema)
  })
};

const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const inFlight = new WeakMap<CodexJobRegistry, Map<string, { hash: string; promise: Promise<Record<string, unknown>> }>>();

export function registerCodexInputTools(server: McpServer, jobs: CodexJobRegistry, scopeResolver: ScopeResolver) {
  const store = jobs.admissionStateStore.questions;
  const scope = (meta: unknown) => scopeResolver.require(meta as ToolCallMetadata, undefined, "Codex input orchestration").scopeId;
  const ownedJob = (scopeId: string, id: string) => {
    const job = jobs.get(id);
    const activity = job && jobs.getActivity(job.activityId);
    const agent = job?.agentId && jobs.getAgent(job.agentId);
    if (!job || job.scopeId !== scopeId || activity?.scopeId !== scopeId || !agent || agent.scopeId !== scopeId) {
      throw new Error("INPUT_JOB_UNAVAILABLE: The Job is unavailable in this conversation.");
    }
    return job;
  };

  const questionInputSchema = z.strictObject({
    jobId: identifier,
    afterCursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    waitMs: z.number().int().min(0).max(60_000).optional()
  });
  const readInput: ToolCallback<typeof questionInputSchema> = async (args, extra) => {
    const scopeId = scope(extra.mcpReq._meta);
    ownedJob(scopeId, args.jobId);
    const result = await jobs.waitForInput(args.jobId, args.afterCursor, args.waitMs, extra.mcpReq.signal);
    ownedJob(scopeId, args.jobId);
    return resultOf({ kind: "codex-input", ...result });
  };

  server.registerTool("codex_answer", {
    title: "Answer a Codex Question",
    description: "Answer a current ordinary Codex question in this conversation. Refresh codex_status kind=input after any intervening user deliberation and use only the exact questionRef that remains current. This cannot grant approvals, supply authentication secrets, or start another turn.",
    inputSchema: z.strictObject({
      requestId: z.string().uuid().describe("Idempotency UUID for this exact answer. Uncertain delivery must never be automatically resent."),
      jobId: identifier,
      questionRef: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact current ordinary question reference. Unrelated Job progress does not invalidate it."),
      answers: answersSchema.describe("Answers keyed by the exact question IDs; preserve allowed option labels.")
    }),
    outputSchema: CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.codex_answer,
    annotations: { ...writeAnnotations, destructiveHint: true }
  }, async (args, extra) => {
    const scopeId = scope(extra.mcpReq._meta);
    ownedJob(scopeId, args.jobId);
    const hash = questionHash(args);
    const key = `${scopeId}:${args.requestId}`;
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

  return { readInput, questionInputSchema };
}

export function validateAnswers(questions: Array<{ id: string; isOther?: boolean; options?: Array<{ label: string }> }>, answers: Record<string, string[]>): void {
  if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(questions.map(q => q.id).sort())) {
    throw new Error("ANSWER_IDS_INVALID: Answer the exact question IDs.");
  }
  for (const question of questions) {
    if (question.options?.length && question.isOther === false && answers[question.id].some(answer => !question.options!.some(option => option.label === answer))) {
      throw new Error("ANSWER_OPTION_INVALID: Choose one of the available answers.");
    }
  }
}

function resultOf(value: Record<string, unknown>) {
  const selected = value.kind === "codex-input"
    ? { toolName: "codex_status", schema: CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.status_input }
    : value.kind === "codex-answer"
      ? { toolName: "codex_answer", schema: CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.codex_answer }
      : undefined;
  if (!selected) throw new Error("Unknown Codex input output contract.");
  const contract = defineToolResultContract({
    toolName: selected.toolName,
    channel: "model-orchestrator-semantic",
    outputSchema: selected.schema,
    structured: { maxBytes: 128 * 1024 },
    compatibility: { channel: "text-protocol-compatibility", format: "compact-json", maxBytes: 128 * 1024, completeness: "primary-payload" }
  });
  return projectToolResult(contract, {
    canonical: value,
    authoritative: { channel: contract.channel, value: selected.schema.parse(value) },
    compatibility: { channel: "text-protocol-compatibility", text: JSON.stringify(value) }
  });
}

function answerResult(jobId: string, questionRef: string, delivery: "delivered" | "uncertain") {
  return {
    kind: "codex-answer" as const,
    jobId,
    questionRef,
    delivery,
    answersPersisted: false as const,
    nextActions: delivery === "delivered"
      ? [guidance("Read Codex input or its terminal result.")]
      : [guidance("Delivery is uncertain. Inspect the exact Job; do not resend automatically or under a new request ID.")]
  };
}
