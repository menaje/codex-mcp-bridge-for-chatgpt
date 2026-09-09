export type DisplayRead<T> = {
  promise: Promise<T>;
  deferred: boolean;
  invalidated: boolean;
};

/** The display budget does not cancel work or release its physical concurrency slot.
 * Readers must keep their transport's final deadline. Invalidated reads retain
 * their slot until settlement, but cannot publish stale results or start follow-ups.
 */
export class DisplayReadPool<T> {
  private readonly reads = new Map<string, DisplayRead<T>>();
  private waitingForCapacity = false;

  constructor(private readonly concurrency: number, private readonly capacityAvailable?: () => void) {}

  start(
    key: string,
    read: (isCurrent: () => boolean) => Promise<T>,
    settled: (value: T, deferred: boolean) => void
  ): DisplayRead<T> | undefined {
    const existing = this.reads.get(key);
    if (existing && !existing.invalidated) return existing;
    if (existing || this.reads.size >= this.concurrency) {
      this.waitingForCapacity = true;
      return undefined;
    }
    const entry: DisplayRead<T> = {
      deferred: false,
      invalidated: false,
      promise: Promise.resolve().then(() => read(() => !entry.invalidated)).then(value => {
        if (!entry.invalidated) settled(value, entry.deferred);
        return value;
      }).finally(() => {
        this.reads.delete(key);
        if (this.waitingForCapacity) {
          this.waitingForCapacity = false;
          this.capacityAvailable?.();
        }
      })
    };
    this.reads.set(key, entry);
    return entry;
  }

  invalidate(matches: (key: string) => boolean): void {
    for (const [key, entry] of this.reads) {
      if (matches(key)) entry.invalidated = true;
    }
  }

  /** A cached display that reports pending work needs its completion notice,
   * even when the original caller's short wait has not expired yet. */
  observePending(matches: (key: string) => boolean = () => true): number {
    let count = 0;
    for (const [key, entry] of this.reads) {
      if (!entry.invalidated && matches(key)) {
        entry.deferred = true;
        count += 1;
      }
    }
    return count;
  }
}

export async function waitForDisplay<T>(
  read: DisplayRead<T>,
  budgetMs: number
): Promise<{ pending: false; value: T } | { pending: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read.promise.then(value => ({ pending: false as const, value })),
      new Promise<{ pending: true }>(resolve => {
        timer = setTimeout(() => {
          read.deferred = true;
          resolve({ pending: true });
        }, budgetMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
