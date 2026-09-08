import * as z from "zod/v4";

const identifier = z.string().trim().min(1).max(200);
const safeReadArguments = {
  codex_settings: z.strictObject({ refreshModels: z.boolean().optional() }),
  codex_models: z.strictObject({ refresh: z.boolean().optional(), contractVersion: z.literal("2").optional() }),
  codex_status: z.strictObject({ query: z.union([
    z.strictObject({ kind: z.literal("job"), id: identifier }),
    z.strictObject({ kind: z.literal("activity"), id: identifier }),
    z.strictObject({ kind: z.literal("thread"), id: identifier }),
    z.strictObject({ kind: z.literal("input"), jobId: identifier, waitMs: z.number().int().min(0).max(60_000).optional() })
  ]).optional() })
};

export function modelActionGuidance(value: unknown): string {
  const action = record(value) ? value : {};
  const args = record(action.arguments) ? action.arguments : {};
  const prompt = typeof action.userPrompt === "string" ? action.userPrompt.slice(0, 1_000) : "";
  const tool = action.tool;
  if (typeof tool === "string" && Object.hasOwn(safeReadArguments, tool)) {
    const parsed = safeReadArguments[tool as keyof typeof safeReadArguments].safeParse(args);
    if (parsed.success) return `${tool}(${JSON.stringify(parsed.data)})${prompt ? `. ${prompt}` : ""}`;
  }
  // Retained AGENT_BUSY records can contain incomplete destructive actions.
  // Recovery may inspect the original target; it never supplies cancellation intent.
  if (tool === "codex_cancel") {
    const jobId = identifier.safeParse(args.jobId);
    const query = jobId.success ? { query: { kind: "job", id: jobId.data } } : {};
    return `Inspect codex_status(${JSON.stringify(query)}). Cancelling requires explicit stop intent, a current target version, and a factual reason.`;
  }
  return "Inspect codex_status({}) to recover the current target before deciding the next action.";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
