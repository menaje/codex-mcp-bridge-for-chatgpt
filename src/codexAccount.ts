import { createHash } from "node:crypto";

export type CodexAccountSnapshot = {
  authMode: "chatgpt" | "api-key" | "unknown";
  authenticated: boolean;
  accountKey: string | null;
  /** Hash of the selected workspace, used for policy checks, never for execution ownership. */
  workspaceKey: string | null;
  /** Retained for response compatibility; the public account API supplies no login-user proof. */
  ownershipKey: string | null;
  /** Official account and usage replies disagreed about the selected workspace. */
  ownershipConflict: boolean;
  planType: string | null;
  windows: { limitId: string; limitName: string | null; usedPercent: number; remainingPercent: number; windowDurationMins: number; resetsAt: number | null }[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  resetCredits: { availableCount: number } | null;
  billing: { kind: "chatgpt-plan" | "api" | "unknown"; costsAvailable: boolean; actualCosts?: import("./codexBilling.js").CodexBillingSnapshot; url: string | null };
  observedAt: number;
  /** A successful account read does not imply that the separate limits read succeeded. */
  usageStatus: "available" | "unavailable" | "none";
  usageObservedAt: number | null;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Human-readable metadata for local authentication settings only. It is never ownership proof. */
export function localCodexAccountLabels(accountResponse: unknown): { email: string | null; workspaceName: null } {
  const account = record(record(accountResponse).account);
  const email = typeof account.email === "string" && account.email.length <= 320 &&
    account.email.includes("@") ? account.email : null;
  return { email, workspaceName: null };
}

export function codexChatgptOwnerKey(accountId: string): string {
  return createHash("sha256").update(JSON.stringify(["chatgpt", accountId])).digest("hex");
}

export function codexChatgptPrincipalKey(userId: string, workspaceId: string): string {
  return createHash("sha256").update(JSON.stringify(["chatgpt-owner-v3", userId, workspaceId])).digest("hex");
}

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
        windows.push({ limitId, limitName: typeof bucket.limitName === "string" ? bucket.limitName : null,
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
  // The selected workspace is reported by account/read independently of the
  // optional usage request. Never use an email or a backend default workspace
  // as execution ownership, and reject contradictory account observations.
  const routing = record(record(accountResponse).workspaceRouting);
  const routedId = authMode === "chatgpt" && typeof routing.chatgptAccountId === "string" && routing.chatgptAccountId.trim()
    ? routing.chatgptAccountId : null;
  const usageId = authMode === "chatgpt" && typeof limits.accountId === "string" && limits.accountId.trim()
    ? limits.accountId : null;
  const ownershipConflict = Boolean(routedId && usageId && routedId !== usageId);
  const workspaceKey = !ownershipConflict && routedId ? codexChatgptOwnerKey(routedId) : null;
  // Email and usage are display correlations only.
  const displayIdentity = workspaceKey || (usageId ? codexChatgptOwnerKey(usageId) : null) ||
    (typeof account.email === "string" && account.email.trim()
    ? createHash("sha256").update(`display:${authMode}:${account.email}`).digest("hex") : null);
  const usageStatus = authMode !== "chatgpt" ? "none"
    : limitsResponse === null || limitsResponse === undefined ? "unavailable"
    : windows.length ? "available"
    : buckets.length ? "unavailable" : "none";
  return { authMode, authenticated: authMode !== "unknown",
    accountKey: displayIdentity, workspaceKey, ownershipKey: null, ownershipConflict,
    planType: typeof account.planType === "string" ? account.planType : null, windows, credits,
    resetCredits: authMode === "chatgpt" && finite(reset.availableCount) && reset.availableCount >= 0 ? { availableCount: Math.floor(reset.availableCount) } : null,
    billing: { kind: authMode === "chatgpt" ? "chatgpt-plan" : authMode === "api-key" ? "api" : "unknown", costsAvailable: false,
      url: authMode === "api-key" ? "https://platform.openai.com/usage" : null }, observedAt,
    usageStatus, usageObservedAt: usageStatus === "available" ? observedAt : null };
}

/** A task estimate is separate from account billing. Require explicit, dated prices. */
export function estimateCodexCost(tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  prices: { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number; asOf: string } | null): { usd: number; kind: "estimate"; asOf: string } | null {
  if (!prices || !Object.values(tokens).every(value => finite(value) && value >= 0) || tokens.cachedInputTokens > tokens.inputTokens ||
      ![prices.inputPerMillion, prices.cachedInputPerMillion, prices.outputPerMillion].every(value => finite(value) && value >= 0) || !Number.isFinite(Date.parse(prices.asOf))) return null;
  return { kind: "estimate", asOf: prices.asOf, usd: ((tokens.inputTokens - tokens.cachedInputTokens) * prices.inputPerMillion +
    tokens.cachedInputTokens * prices.cachedInputPerMillion + tokens.outputTokens * prices.outputPerMillion) / 1_000_000 };
}
