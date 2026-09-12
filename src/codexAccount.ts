import { createHash } from "node:crypto";

export type CodexAccountSnapshot = {
  authMode: "chatgpt" | "api-key" | "unknown";
  authenticated: boolean;
  accountKey: string | null;
  planType: string | null;
  windows: { limitId: string; limitName: string | null; usedPercent: number; remainingPercent: number; windowDurationMins: number; resetsAt: number | null }[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  resetCredits: { availableCount: number } | null;
  billing: { kind: "chatgpt-plan" | "api" | "unknown"; costsAvailable: boolean; actualCosts?: import("./codexBilling.js").CodexBillingSnapshot; url: string | null };
  observedAt: number;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** No credentials, email, or raw account payload leave this projection. Unknown is never zero. */
export function projectCodexAccount(accountResponse: unknown, limitsResponse: unknown, observedAt = Date.now()): CodexAccountSnapshot {
  const account = record(record(accountResponse).account);
  const authMode = account.type === "chatgpt" ? "chatgpt" : account.type === "apiKey" ? "api-key" : "unknown";
  const limits = record(limitsResponse), byId = record(limits.rateLimitsByLimitId);
  const buckets = Object.keys(byId).length ? Object.entries(byId) : limits.rateLimits ? [["codex", limits.rateLimits] as const] : [];
  const windows: CodexAccountSnapshot["windows"] = [];
  let credits: CodexAccountSnapshot["credits"] = null;
  if (authMode === "chatgpt") for (const [id, raw] of buckets) {
    const bucket = record(raw), limitId = typeof bucket.limitId === "string" ? bucket.limitId : id;
    for (const name of ["primary", "secondary"]) {
      const window = record(bucket[name]);
      if (!finite(window.usedPercent) || !finite(window.windowDurationMins) || window.windowDurationMins <= 0) continue;
      const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
      if (!windows.some(item => item.limitId === limitId && item.windowDurationMins === window.windowDurationMins)) {
        windows.push({ limitId, limitName: limitId === "codex_bengalfox" ? "GPT-5.3-Codex-Spark" : typeof bucket.limitName === "string" ? bucket.limitName : null,
          usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: window.windowDurationMins,
          resetsAt: finite(window.resetsAt) && window.resetsAt >= 0 ? window.resetsAt : null });
      }
    }
    const credit = record(bucket.credits);
    if ((!credits || limitId === "codex") && typeof credit.hasCredits === "boolean" && typeof credit.unlimited === "boolean") {
      credits = { hasCredits: credit.hasCredits, unlimited: credit.unlimited,
        balance: typeof credit.balance === "string" && /^\d+(?:\.\d+)?$/.test(credit.balance) ? credit.balance : null };
    }
  }
  const reset = record(limits.rateLimitResetCredits);
  const identity = typeof limits.accountId === "string" ? limits.accountId : typeof account.email === "string" ? account.email : null;
  return { authMode, authenticated: authMode !== "unknown",
    accountKey: identity ? createHash("sha256").update(`${authMode}:${identity}`).digest("hex") : null,
    planType: typeof account.planType === "string" ? account.planType : null, windows, credits,
    resetCredits: authMode === "chatgpt" && finite(reset.availableCount) && reset.availableCount >= 0 ? { availableCount: Math.floor(reset.availableCount) } : null,
    billing: { kind: authMode === "chatgpt" ? "chatgpt-plan" : authMode === "api-key" ? "api" : "unknown", costsAvailable: false,
      url: authMode === "api-key" ? "https://platform.openai.com/usage" : null }, observedAt };
}

/** A task estimate is separate from account billing. Require explicit, dated prices. */
export function estimateCodexCost(tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  prices: { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number; asOf: string } | null): { usd: number; kind: "estimate"; asOf: string } | null {
  if (!prices || !Object.values(tokens).every(value => finite(value) && value >= 0) || tokens.cachedInputTokens > tokens.inputTokens ||
      ![prices.inputPerMillion, prices.cachedInputPerMillion, prices.outputPerMillion].every(value => finite(value) && value >= 0) || !Number.isFinite(Date.parse(prices.asOf))) return null;
  return { kind: "estimate", asOf: prices.asOf, usd: ((tokens.inputTokens - tokens.cachedInputTokens) * prices.inputPerMillion +
    tokens.cachedInputTokens * prices.cachedInputPerMillion + tokens.outputTokens * prices.outputPerMillion) / 1_000_000 };
}
