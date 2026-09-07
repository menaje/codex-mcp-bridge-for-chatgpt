import { describe, expect, it, vi } from "vitest";
import { ChangeSignal, changeWaitParamsSchema } from "../src/changeSignal.js";

describe("native change notices", () => {
  it("waits without polling and preserves changes between reads and reconnects", async () => {
    const changes = new ChangeSignal(["dashboard", "settings"]);
    const initial = await changes.wait();
    const resolved = vi.fn();
    const pending = changes.wait(initial.revision).then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    changes.notify("dashboard");
    await pending;
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ topics: ["dashboard"] }));
    changes.notify("settings");
    expect((await changes.wait(initial.revision)).topics).toEqual(["dashboard", "settings"]);
    const restarted = new ChangeSignal(["dashboard", "settings"]);
    expect((await restarted.wait(initial.revision)).topics).toEqual(["dashboard", "settings"]);
    changes.close(); restarted.close();
  });

  it("bounds waits and immediately releases watcher slots on cancellation", async () => {
    const changes = new ChangeSignal(["runtime"]);
    const { revision } = await changes.wait();
    const cancellation = new AbortController();
    const pending = Array.from({ length: 4 }, () => changes.wait(revision, 25_000, cancellation.signal).catch(error => error.message));
    await expect(changes.wait(revision)).rejects.toThrow("CHANGE_WATCH_LIMIT");
    cancellation.abort();
    expect(await Promise.all(pending)).toEqual(Array(4).fill("CHANGE_WAIT_CANCELLED"));
    expect((await changes.wait(revision, 1)).topics).toEqual([]);
    const closed = changes.wait(revision).catch(error => error.message);
    changes.close();
    expect(await closed).toBe("CHANGE_WAIT_CANCELLED");
    await expect(changes.wait()).rejects.toThrow("CHANGE_WAIT_CANCELLED");
    expect(changeWaitParamsSchema.safeParse({ waitMs: 25_001 }).success).toBe(false);
  });
});
