export const TOKEN_KEYS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
export type TokenCounts = Partial<Record<typeof TOKEN_KEYS[number], number>>;
export type JobUsage = { basis: "cumulative-difference" | "unknown"; tokens?: TokenCounts; reason?: string };

export function tokenCounts(value: unknown): TokenCounts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entries = TOKEN_KEYS.flatMap(key => typeof record[key] === "number" && Number.isSafeInteger(record[key]) && record[key] >= 0 ? [[key, record[key]]] : []);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A last-request sample is never substituted for a whole turn's usage. */
export class TurnUsageMeter {
  private previous?: TokenCounts;
  private invalid?: string;
  constructor(private readonly baseline?: TokenCounts) { this.previous = baseline; }
  observe(total: TokenCounts | undefined): JobUsage {
    if (!total) this.invalid = "missing-counter";
    if (!this.baseline) this.invalid ||= "missing-start-counter";
    if (total && this.previous && TOKEN_KEYS.some(key => this.previous?.[key] !== undefined && total[key] !== undefined && total[key]! < this.previous[key]!)) this.invalid = "counter-reset";
    this.previous = total;
    if (this.invalid || !total || !this.baseline) return { basis: "unknown", reason: this.invalid };
    const tokens: TokenCounts = {};
    for (const key of TOKEN_KEYS) if (this.baseline[key] !== undefined && total[key] !== undefined) tokens[key] = total[key]! - this.baseline[key]!;
    if (!["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"].every(key => key in tokens)) return { basis: "unknown", reason: "incomplete-counter" };
    return { basis: "cumulative-difference", tokens };
  }
}
