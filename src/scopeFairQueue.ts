export type ScopeFairQueueStatus = {
  queued: number;
  scopes: number;
  capacity: number;
  perScopeCapacity: number;
  processed: number;
  dropped: number;
};

export type ScopeFairQueueOptions<T> = {
  capacity: number;
  perScopeCapacity: number;
  run(value: T): void;
  onError?(error: unknown): void;
};

/**
 * Bounded round-robin work for non-authoritative background projections.
 *
 * A noisy scope can occupy at most `perScopeCapacity` entries. When the global
 * queue is full, a scope with multiple queued entries gives up its oldest item
 * before a new scope is rejected. One item is run per event-loop turn so
 * cancellation, input, terminal, and delivery callbacks can interleave.
 */
export class ScopeFairQueue<T> {
  private readonly queues = new Map<string, T[]>();
  private readonly order: string[] = [];
  private queued = 0;
  private processed = 0;
  private dropped = 0;
  private scheduled?: NodeJS.Immediate;
  private closed = false;

  constructor(private readonly options: ScopeFairQueueOptions<T>) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Fair queue capacity must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(options.perScopeCapacity) ||
      options.perScopeCapacity < 1 ||
      options.perScopeCapacity > options.capacity
    ) {
      throw new Error("Fair queue per-scope capacity must fit within total capacity.");
    }
  }

  enqueue(scopeId: string, value: T): boolean {
    if (this.closed) return false;
    let queue = this.queues.get(scopeId);
    if (!queue) {
      queue = [];
      this.queues.set(scopeId, queue);
      this.order.push(scopeId);
    }
    if (queue.length >= this.options.perScopeCapacity) {
      queue.shift();
      this.queued -= 1;
      this.dropped += 1;
    } else if (this.queued >= this.options.capacity && !this.evictFromNoisiestScope()) {
      this.dropped += 1;
      if (queue.length === 0) this.removeEmptyScope(scopeId);
      return false;
    }
    queue.push(value);
    this.queued += 1;
    this.schedule();
    return true;
  }

  remove(predicate: (value: T) => boolean): number {
    let removed = 0;
    for (const [scopeId, queue] of this.queues) {
      const kept = queue.filter(value => {
        if (!predicate(value)) return true;
        removed += 1;
        return false;
      });
      this.queued -= queue.length - kept.length;
      if (kept.length > 0) this.queues.set(scopeId, kept);
      else this.removeEmptyScope(scopeId);
    }
    this.dropped += removed;
    return removed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.dropped += this.queued;
    this.queued = 0;
    this.queues.clear();
    this.order.length = 0;
  }

  status(): ScopeFairQueueStatus {
    return {
      queued: this.queued,
      scopes: this.queues.size,
      capacity: this.options.capacity,
      perScopeCapacity: this.options.perScopeCapacity,
      processed: this.processed,
      dropped: this.dropped
    };
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.queued === 0) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.runOne();
      this.schedule();
    });
    this.scheduled.unref();
  }

  private runOne(): void {
    const scopeId = this.order.shift();
    if (!scopeId) return;
    const queue = this.queues.get(scopeId);
    const value = queue?.shift();
    if (!queue || value === undefined) {
      this.queues.delete(scopeId);
      return;
    }
    this.queued -= 1;
    if (queue.length > 0) this.order.push(scopeId);
    else this.queues.delete(scopeId);
    try {
      this.options.run(value);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.processed += 1;
    }
  }

  private evictFromNoisiestScope(): boolean {
    let selected: { scopeId: string; queue: T[] } | undefined;
    for (const [scopeId, queue] of this.queues) {
      if (queue.length <= 1) continue;
      if (!selected || queue.length > selected.queue.length) selected = { scopeId, queue };
    }
    if (!selected) return false;
    selected.queue.shift();
    this.queued -= 1;
    this.dropped += 1;
    return true;
  }

  private removeEmptyScope(scopeId: string): void {
    this.queues.delete(scopeId);
    let index = this.order.indexOf(scopeId);
    while (index >= 0) {
      this.order.splice(index, 1);
      index = this.order.indexOf(scopeId);
    }
  }
}
