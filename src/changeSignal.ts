import { randomUUID } from "node:crypto";
import * as z from "zod/v4";

export const changeWaitParamsSchema = z.strictObject({
  after: z.string().max(100).optional(),
  waitMs: z.number().int().min(0).max(25_000).default(25_000)
});

export type ChangeNotice = { revision: string; topics: string[] };

/** Bounded invalidation notices, never snapshots or credentials. A new epoch resyncs clients after restart. */
export class ChangeSignal {
  private readonly epoch = randomUUID();
  private version = 0;
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly topics: readonly string[]) {}

  notify(topic: string): void {
    if (this.closed || !this.topics.includes(topic)) return;
    this.versions.set(topic, ++this.version);
    for (const listener of [...this.listeners]) listener();
  }

  private notice(after?: string): ChangeNotice {
    const [epoch, raw] = (after || "").split(":");
    const version = Number(raw);
    const valid = epoch === this.epoch && Number.isSafeInteger(version) && version >= 0 && version <= this.version;
    return {
      revision: `${this.epoch}:${this.version}`,
      topics: valid ? this.topics.filter(topic => (this.versions.get(topic) || 0) > version) : [...this.topics]
    };
  }

  async wait(after?: string, waitMs = 25_000, signal?: AbortSignal): Promise<ChangeNotice> {
    if (this.closed || signal?.aborted) throw new Error("CHANGE_WAIT_CANCELLED");
    const current = this.notice(after);
    if (current.topics.length || waitMs === 0) return current;
    if (this.listeners.size >= 4) throw new Error("CHANGE_WATCH_LIMIT");
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", finish);
        if (this.closed || signal?.aborted) reject(new Error("CHANGE_WAIT_CANCELLED"));
        else resolve(this.notice(after));
      };
      const timer = setTimeout(finish, Math.min(25_000, Math.max(0, waitMs)));
      this.listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    for (const listener of [...this.listeners]) listener();
  }
}
