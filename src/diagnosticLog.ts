/** In-memory diagnostics only: no raw subprocess output is persisted to disk. */
export class DiagnosticLog<T extends { at: string }> {
  private rows: Array<{ value: T; bytes: number; at: number }> = [];
  private bytes = 0;

  constructor(private readonly options: {
    maxEntries: number;
    maxBytes: number;
    retentionMs: number;
    now?: () => number;
  }) {
    for (const value of [options.maxEntries, options.maxBytes, options.retentionMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid diagnostic log limit.");
    }
  }

  append(value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    this.prune();
    if (bytes > this.options.maxBytes) return;
    this.rows.push({ value, bytes, at: this.now() });
    this.bytes += bytes;
    this.prune();
  }

  recent(limit: number): T[] {
    this.prune();
    if (!Number.isFinite(limit) || limit <= 0) return [];
    return this.rows.slice(-Math.min(Math.floor(limit), this.options.maxEntries)).map(row => ({ ...row.value }));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private prune(): void {
    const oldest = this.now() - this.options.retentionMs;
    while (this.rows.length && (this.rows[0].at <= oldest || this.rows.length > this.options.maxEntries || this.bytes > this.options.maxBytes)) {
      this.bytes -= this.rows.shift()!.bytes;
    }
  }
}
