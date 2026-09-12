import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicRuntimeJson, withRuntimeLock } from "./codexRuntime.js";

const connectionSchema = z.object({ adminKey: z.string().trim().min(1).max(32768).regex(/^[^\s]+$/),
  organizationId: z.string().regex(/^org[-_][a-zA-Z0-9_-]{1,160}$/), projectId: z.string().regex(/^proj_[a-zA-Z0-9_-]{1,160}$/).nullable() });
export type CodexBillingInput = z.infer<typeof connectionSchema>;
export type CodexBillingSnapshot = {
  configured: boolean; organizationId: string | null; projectId: string | null;
  source: "organization-costs"; status: "not-configured" | "available" | "unavailable";
  usd: number | null; startTime: number | null; endTime: number | null; observedAt: number;
};
const pageSchema = z.object({ has_more: z.boolean(), next_page: z.string().nullable().optional(), data: z.array(z.object({
  start_time: z.number(), end_time: z.number(), results: z.array(z.object({ amount: z.object({ value: z.number().finite().nullable(), currency: z.string().nullable() }) }))
})) });

/** Optional local billing connection, entirely separate from Codex inference credentials. */
export class CodexBilling {
  readonly file: string;
  private cached?: { key: string; expires: number; request: Promise<CodexBillingSnapshot> };
  constructor(private readonly root: string, private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.file = path.join(root, "billing", "connection.json");
  }
  async configure(input: CodexBillingInput): Promise<void> {
    // Never expose validation inputs containing secrets through the helper error channel.
    const parsed = connectionSchema.safeParse(input);
    if (!parsed.success) throw new Error("CODEX_BILLING_SETTINGS_INVALID");
    await withRuntimeLock(path.dirname(this.file), "settings", () => atomicRuntimeJson(this.file, parsed.data));
    this.cached = undefined;
  }
  async remove(): Promise<void> {
    await withRuntimeLock(path.dirname(this.file), "settings", () => rm(this.file, { force: true })); this.cached = undefined;
  }
  async configuration(): Promise<CodexBillingSnapshot> {
    try {
      const connection = await this.connection();
      return connection ? { ...this.empty("unavailable"), configured: true, organizationId: connection.organizationId, projectId: connection.projectId }
        : this.empty("not-configured");
    } catch { return this.empty("unavailable"); }
  }
  async snapshot(): Promise<CodexBillingSnapshot> {
    let connection: CodexBillingInput | null;
    try { connection = await this.connection(); } catch { return this.empty("unavailable"); }
    if (!connection) return this.empty("not-configured");
    const key = this.key(connection);
    if (this.cached?.key === key && this.cached.expires > this.now()) return this.cached.request;
    const request = this.fetchCosts(connection).catch(() => ({ ...this.empty("unavailable"), configured: true,
      organizationId: connection.organizationId, projectId: connection.projectId })).then(async value => {
      const current = await this.connection().catch(() => null);
      return current && this.key(current) === key ? value : this.empty("not-configured");
    });
    this.cached = { key, request, expires: this.now() + 5 * 60_000 };
    return request;
  }
  private async connection(): Promise<CodexBillingInput | null> {
    try { return connectionSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("CODEX_BILLING_SETTINGS_INVALID"); }
  }
  private key(connection: CodexBillingInput): string { return createHash("sha256").update(JSON.stringify(connection)).digest("hex"); }
  private empty(status: CodexBillingSnapshot["status"]): CodexBillingSnapshot {
    return { configured: status !== "not-configured", organizationId: null, projectId: null, source: "organization-costs", status,
      usd: null, startTime: null, endTime: null, observedAt: this.now() };
  }
  private async fetchCosts(connection: CodexBillingInput): Promise<CodexBillingSnapshot> {
    const endTime = Math.floor(this.now() / 1000), date = new Date(this.now());
    const startTime = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
    const query = new URLSearchParams({ start_time: String(startTime), end_time: String(endTime), bucket_width: "1d", limit: "31" });
    if (connection.projectId) query.set("project_ids[]", connection.projectId);
    let usd = 0, page: string | undefined;
    const seen = new Set<string>();
    for (let count = 0; count < 12; count++) {
      if (page) query.set("page", page);
      const response = await this.request(`https://api.openai.com/v1/organization/costs?${query}`, {
        headers: { Authorization: `Bearer ${connection.adminKey}`, "OpenAI-Organization": connection.organizationId },
        redirect: "error", signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error("CODEX_BILLING_UNAVAILABLE");
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) throw new Error("CODEX_BILLING_RESPONSE_INVALID");
      const result = pageSchema.parse(JSON.parse(body));
      for (const bucket of result.data) {
        if (bucket.start_time < startTime || bucket.start_time >= endTime || bucket.end_time <= bucket.start_time) throw new Error("CODEX_BILLING_RESPONSE_INVALID");
        for (const row of bucket.results) {
          if (row.amount.value === null || row.amount.currency?.toLowerCase() !== "usd") throw new Error("CODEX_BILLING_AMOUNT_UNKNOWN");
          usd += row.amount.value;
          if (!Number.isFinite(usd)) throw new Error("CODEX_BILLING_AMOUNT_UNKNOWN");
        }
      }
      if (!result.has_more) return { configured: true, organizationId: connection.organizationId, projectId: connection.projectId,
        source: "organization-costs", status: "available", usd, startTime, endTime, observedAt: this.now() };
      if (!result.next_page || seen.has(result.next_page)) throw new Error("CODEX_BILLING_PAGE_INVALID");
      page = result.next_page; seen.add(page);
    }
    throw new Error("CODEX_BILLING_PAGE_LIMIT");
  }
}
