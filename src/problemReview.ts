import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";

export const PROBLEM_KINDS = ["all", "failed", "unknown", "termination-failed", "orphaned"] as const;
export const problemQuerySchema = z.strictObject({
  view: z.enum(["actionable", "history", "automatic"]).optional(),
  review: z.enum(["pending", "acknowledged"]).default("pending"),
  kind: z.enum(PROBLEM_KINDS).default("all"),
  offset: z.number().int().min(0).max(1_000_000_000).default(0)
});
export type ProblemQuery = z.infer<typeof problemQuerySchema>;
export const problemTargetSchema = z.strictObject({
  problemKey: z.string().regex(/^[a-f0-9]{32}$/),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
});
export const problemOperationSchema = z.strictObject({
  action: z.enum(["acknowledge", "unacknowledge", "recheck", "retry-stop"]),
  targets: z.array(problemTargetSchema).min(1).max(100),
  acknowledgeAffectedJobIds: z.array(z.string().max(200)).max(100).optional()
}).superRefine((value, context) => {
  if (new Set(value.targets.map(target => target.problemKey)).size !== value.targets.length) {
    context.addIssue({ code: "custom", message: "Choose each problem only once." });
  }
  if (["recheck", "retry-stop"].includes(value.action) && value.targets.length !== 1) {
    context.addIssue({ code: "custom", message: "Inspect or retry one live problem at a time." });
  }
  if (value.acknowledgeAffectedJobIds !== undefined && value.action !== "retry-stop") {
    context.addIssue({ code: "custom", message: "Termination acknowledgement belongs to a stop retry." });
  }
});
export const problemActionSchema = problemOperationSchema.safeExtend({ requestId: z.string().uuid() });
export type ProblemOperation = z.infer<typeof problemOperationSchema>;
export type ProblemAction = z.infer<typeof problemActionSchema>;
export const problemActionResultSchema = z.strictObject({ ok: z.literal(true), changed: z.number().int().min(0) });
export type ProblemActionResult = z.infer<typeof problemActionResultSchema>;

export function problemKey(kind: "execution" | "runtime" | "automatic", id: string): string {
  return createHash("sha256").update(JSON.stringify(["dashboard-problem", kind, id])).digest("hex").slice(0, 32);
}

export function problemRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function problemOperationDigest(operation: ProblemOperation): string {
  return problemRevision({ action: operation.action,
    targets: [...operation.targets].sort((a, b) => a.problemKey.localeCompare(b.problemKey)),
    acknowledgeAffectedJobIds: operation.acknowledgeAffectedJobIds?.slice().sort() });
}

const claimsSchema = z.strictObject({
  version: z.literal(1), expiresAt: z.number().int().positive(), widgetInstanceId: z.string().uuid(),
  hostScopeId: z.string().uuid().nullable(), selectedScopeId: z.string().uuid().nullable(),
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/)
});

/** A review proof never grants work-control authority. It binds the complete
 * visible selection, action, host, widget, and conversation/all-work scope. */
export class ProblemReviewProofs {
  private readonly secret = randomBytes(32);
  constructor(private readonly now: () => number = Date.now) {}
  issue(input: Omit<z.infer<typeof claimsSchema>, "version" | "expiresAt">): string {
    const claims = claimsSchema.parse({ ...input, version: 1, expiresAt: this.now() + 5 * 60_000 });
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }
  require(token: string, widgetInstanceId: string, hostScopeId: string | undefined, operation: ProblemOperation) {
    const fail = () => new Error("PROBLEM_REVIEW_STALE: Refresh the selected problems.");
    const [payload, signature, extra] = token.split(".");
    if (token.length > 32768 || !payload || !signature || extra !== undefined) throw fail();
    const received = Buffer.from(signature, "base64url"), expected = this.sign(payload);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw fail();
    let claims: z.infer<typeof claimsSchema>;
    try { claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); }
    catch { throw fail(); }
    if (claims.expiresAt <= this.now() || claims.widgetInstanceId !== widgetInstanceId ||
      claims.hostScopeId !== (hostScopeId || null) || claims.operationDigest !== problemOperationDigest(operation)) throw fail();
    return claims;
  }
  private sign(value: string): Buffer { return createHmac("sha256", this.secret).update(value).digest(); }
}

const proofStores = new WeakMap<object, ProblemReviewProofs>();
export function problemReviewProofs(registry: object): ProblemReviewProofs {
  let proofs = proofStores.get(registry);
  if (!proofs) { proofs = new ProblemReviewProofs(); proofStores.set(registry, proofs); }
  return proofs;
}
