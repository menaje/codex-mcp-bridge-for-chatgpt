import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { parseJsonUtf8Strict } from "./textIntegrity.js";

const claimsSchema = z.strictObject({
  purpose: z.enum(["work", "history"]).optional(), historyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  version: z.literal(1), expiresAt: z.number().int().positive(), widgetInstanceId: z.string().uuid(),
  hostScopeId: z.string().uuid().nullable(), scopeId: z.string().uuid(),
  activityId: z.string().uuid(), generation: z.number().int().positive(),
  agentId: z.string().uuid(), agentVersion: z.number().int().positive(),
  jobId: z.string().nullable(), jobVersion: z.number().int().positive().nullable()
});
export type UiControlClaims = z.infer<typeof claimsSchema>;
/** Shared by MCP sessions that operate on the same registry. Restart invalidates
 * transient proofs; a fresh detail read recovers without migrating task state. */
export class UiControlProofs {
  private readonly secret = randomBytes(32);
  constructor(private readonly now: () => number = Date.now) {}
  issue(input: Omit<UiControlClaims, "version" | "expiresAt">): string {
    const value = claimsSchema.parse({ ...input, version: 1, expiresAt: this.now() + 5 * 60_000 });
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }
  require(token: string, widgetInstanceId: string, hostScopeId?: string): UiControlClaims {
    if (token.length > 32_768) throw new Error("UI_CONTROL_STALE: Refresh the selected work details.");
    const [payload, signature, extra] = token.split(".");
    const fail = () => new Error("UI_CONTROL_STALE: Refresh the selected work details.");
    if (!payload || !signature || extra !== undefined) throw fail();
    const received = Buffer.from(signature, "base64url"), expected = this.sign(payload);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw fail();
    let claims: UiControlClaims;
    try {
      const parsed = parseJsonUtf8Strict(Buffer.from(payload, "base64url"), "UI control proof");
      claims = claimsSchema.parse(parsed);
    } catch { throw fail(); }
    if (claims.expiresAt <= this.now() || claims.widgetInstanceId !== widgetInstanceId ||
      (hostScopeId !== undefined && claims.hostScopeId !== hostScopeId)) throw fail();
    return claims;
  }
  private sign(value: string): Buffer { return createHmac("sha256", this.secret).update(value).digest(); }
}
const registries = new WeakMap<object, UiControlProofs>();
export function uiControlProofs(registry: object): UiControlProofs {
  let value = registries.get(registry);
  if (!value) { value = new UiControlProofs(); registries.set(registry, value); }
  return value;
}
