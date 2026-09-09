import { describe, expect, it, vi } from "vitest";
import { DisplayReadPool, waitForDisplay } from "../src/displayReadPool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("display read budgets", () => {
  it("wakes a skipped display when capacity frees even if the occupying read was invalidated", async () => {
    const wake = vi.fn(), publish = vi.fn();
    const pool = new DisplayReadPool<number>(1, wake);
    const response = deferred<number>();
    const old = pool.start("old", () => response.promise, publish)!;
    pool.invalidate(() => true);
    expect(pool.start("new", () => Promise.resolve(2), publish)).toBeUndefined();
    response.resolve(1);
    await old.promise;
    expect(publish).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("shares pending work across refreshes and keeps real concurrency bounded after display timeouts", async () => {
    const pool = new DisplayReadPool<number>(2);
    const first = deferred<number>(), second = deferred<number>();
    const late = vi.fn();
    const read = pool.start("a", () => first.promise, late)!;
    const other = pool.start("b", () => second.promise, late)!;
    expect(await waitForDisplay(read, 5)).toEqual({ pending: true });
    expect(await waitForDisplay(other, 5)).toEqual({ pending: true });
    expect(pool.start("a", () => Promise.resolve(99), late)).toBe(read);
    expect(pool.start("c", () => Promise.resolve(3), late)).toBeUndefined();
    first.resolve(1);
    await read.promise;
    expect(late).toHaveBeenCalledExactlyOnceWith(1, true);
    const next = pool.start("c", () => Promise.resolve(3), late)!;
    expect(await waitForDisplay(next, 50)).toEqual({ pending: false, value: 3 });
    second.resolve(2);
    await other.promise;
  });

  it("does not publish invalidated results or free their slots prematurely", async () => {
    const pool = new DisplayReadPool<number>(1);
    const response = deferred<number>();
    const publish = vi.fn(), followUp = vi.fn();
    const old = pool.start("old", async isCurrent => {
      const value = await response.promise;
      if (isCurrent()) followUp();
      return value;
    }, publish)!;
    await waitForDisplay(old, 5);
    pool.invalidate(key => key === "old");
    expect(pool.start("old", () => Promise.resolve(3), publish)).toBeUndefined();
    expect(pool.start("new", () => Promise.resolve(3), publish)).toBeUndefined();
    response.resolve(1);
    await old.promise;
    expect(publish).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(pool.start("new", () => Promise.resolve(3), publish)).toBeDefined();
  });

  it("allows a retry after the actual transport deadline rejects", async () => {
    const pool = new DisplayReadPool<number>(1);
    const response = deferred<number>();
    const publish = vi.fn();
    const read = pool.start("a", () => response.promise, publish)!;
    await waitForDisplay(read, 5);
    response.reject(new Error("RPC deadline exceeded"));
    await expect(read.promise).rejects.toThrow("RPC deadline exceeded");
    expect(publish).not.toHaveBeenCalled();
    expect(await waitForDisplay(pool.start("a", () => Promise.resolve(2), publish)!, 50))
      .toEqual({ pending: false, value: 2 });
  });
});
