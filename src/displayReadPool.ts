export type DisplayRead<T> = {
  promise: Promise<T>;
  deferred: boolean;
  invalidated: boolean;
  waiters: number;
  settled: boolean;
};

/** The display budget does not cancel work or release its physical concurrency slot.
 * Readers must keep their transport's final deadline. Invalidated reads retain
 * their slot until settlement, but cannot publish stale results or start follow-ups.
 */
export class DisplayReadPool<T> {
  private readonly reads = new Map<string, DisplayRead<T>>();
  private waitingForCapacity = false;

  constructor(private readonly concurrency: number, private readonly capacityAvailable?: () => void) {}

  get inFlight(): number { return this.reads.size; }

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
      waiters: 0,
      settled: false,
      promise: Promise.resolve().then(() => read(() => !entry.invalidated)).then(value => {
        if (!entry.invalidated) settled(value, entry.deferred);
        return value;
      }).finally(() => {
        entry.settled = true;
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

/** Local observation budget, never serialized as execution authority. */
export type ReadObservationContext = { signal?: AbortSignal; deadlineAt?: number };

/** Each observer can leave independently. The shared promise owns capacity. */
export function observeDisplayRead<T>(
  read: DisplayRead<T>,
  context: ReadObservationContext,
  noWaiters: () => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    read.waiters += 1;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
      read.waiters -= 1;
      if (error) reject(error); else resolve(value as T);
      if (!read.waiters && !read.settled) noWaiters();
    };
    const cancel = () => finish(new Error("STATE_READ_CANCELLED: Observation cancelled."));
    const expire = () => finish(new Error("STATE_READ_STALE: Observation deadline expired; retain the last confirmed view."));
    read.promise.then(value => finish(undefined, value), error => finish(error));
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) cancel();
    else if (context.deadlineAt !== undefined) {
      const remaining = context.deadlineAt - Date.now();
      if (remaining <= 0) expire();
      else { timer = setTimeout(expire, remaining); timer.unref(); }
    }
  });
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
