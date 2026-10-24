import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopeFairQueue } from "../src/scopeFairQueue.js";

afterEach(() => vi.useRealTimers());

describe("ScopeFairQueue", () => {
  it("runs one item per scope in round-robin order", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 8,
      perScopeCapacity: 4,
      run: value => observed.push(value)
    });
    queue.enqueue("a", "a1");
    queue.enqueue("a", "a2");
    queue.enqueue("a", "a3");
    queue.enqueue("b", "b1");
    queue.enqueue("b", "b2");

    await vi.runAllTimersAsync();

    expect(observed).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(queue.status()).toMatchObject({ queued: 0, scopes: 0, processed: 5, dropped: 0 });
  });

  it("bounds one scope and admits another scope under saturation", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 4,
      perScopeCapacity: 3,
      run: value => observed.push(value)
    });
    for (const value of ["a1", "a2", "a3", "a4", "a5"]) queue.enqueue("a", value);
    expect(queue.enqueue("b", "b1")).toBe(true);
    expect(queue.status()).toMatchObject({ queued: 4, scopes: 2, dropped: 2 });

    await vi.runAllTimersAsync();

    expect(observed).toEqual(["a3", "b1", "a4", "a5"]);
  });

  it("removes stale work and drops remaining work on close", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 6,
      perScopeCapacity: 3,
      run: value => observed.push(value)
    });
    queue.enqueue("a", "remove");
    queue.enqueue("a", "keep");
    queue.enqueue("b", "drop-on-close");
    expect(queue.remove(value => value === "remove")).toBe(1);
    queue.close();

    await vi.runAllTimersAsync();

    expect(observed).toEqual([]);
    expect(queue.status()).toMatchObject({ queued: 0, scopes: 0, processed: 0, dropped: 3 });
  });
});
