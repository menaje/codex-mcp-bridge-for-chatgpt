import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeLifecycleCoordinator, type LifecycleDriver, type LifecycleInspection, type LifecycleRequest } from "../src/runtimeLifecycle.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "lifecycle-"));
  const file = path.join(root, "intent.json");
  let now = Date.now();
  let inspection: LifecycleInspection = { run: "pid:owner-token", reasons: [{ code: "active-jobs", count: 1 }] };
  let notify: (() => void) | undefined;
  const driver: LifecycleDriver = {
    prepare: vi.fn(async request => ({ request, target: { revision: 2 }, description: "app · test" })),
    inspect: vi.fn(async () => inspection),
    execute: vi.fn(async () => "completed" as const),
    reconcile: vi.fn(async () => "retry" as const),
    changed: vi.fn(), error: error => String(error),
    watch: async (changed, signal) => {
      notify = changed;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
  const options = { intervalMs: 100_000, now: () => now };
  const coordinator = new RuntimeLifecycleCoordinator(file, driver, options);
  cleanups.push(async () => { await coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  return { coordinator, driver, file, options, advance: (ms: number) => { now += ms; },
    inspect: (value: LifecycleInspection) => { inspection = value; }, event: () => notify?.() };
}

const request = (kind: LifecycleRequest["kind"] = "restart"): LifecycleRequest => ({ requestId: randomUUID(), kind, force: false });

describe("durable event-driven runtime lifecycle", () => {
  it("falls back to periodic reconciliation when an event is missed", async () => {
    const f = fixture(); await f.coordinator.close();
    const coordinator = new RuntimeLifecycleCoordinator(f.file, { ...f.driver, watch: undefined }, { intervalMs: 20 });
    try {
      await coordinator.submit(request()); await coordinator.settled();
      f.inspect({ run: "pid:owner-token", reasons: [] });
      await vi.waitFor(() => expect(coordinator.latest?.phase).toBe("completed"));
      expect(f.driver.execute).toHaveBeenCalledTimes(1);
    } finally { await coordinator.close(); }
  });
  it("keeps a reservation beyond 60 seconds and runs exactly once after a completion event", async () => {
    const f = fixture(), intent = request();
    expect(await f.coordinator.submit(intent)).toMatchObject({ requestId: intent.requestId, phase: "waiting", cancellable: true });
    await f.coordinator.settled();
    f.advance(3600_000);
    f.event();
    await f.coordinator.settled();
    expect(f.coordinator.active?.phase).toBe("waiting");
    expect(f.driver.execute).not.toHaveBeenCalled();
    f.inspect({ run: "pid:owner-token", reasons: [] });
    f.event(); f.event(); f.event();
    await f.coordinator.settled();
    expect(f.coordinator.latest?.phase).toBe("completed");
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
  });

  it("survives a lost caller and helper re-entry without preparing the target again", async () => {
    const f = fixture(), intent = request("configure");
    intent.configuration = { maximumAccess: "workspace-write" };
    await f.coordinator.submit(intent);
    await f.coordinator.settled();
    await f.coordinator.close();
    const recovered = new RuntimeLifecycleCoordinator(f.file, f.driver, f.options);
    try {
      expect(await recovered.submit(intent)).toMatchObject({ requestId: intent.requestId });
      f.inspect({ run: "pid:owner-token", reasons: [] });
      recovered.resume();
      await recovered.settled();
      expect(recovered.latest?.phase).toBe("completed");
      expect(f.driver.prepare).toHaveBeenCalledTimes(1);
      expect(f.driver.execute).toHaveBeenCalledTimes(1);
    } finally { await recovered.close(); }
  });

  it("deduplicates retries, rejects conflicting IDs, and requires an explicit replacement", async () => {
    const f = fixture(), first = request();
    await f.coordinator.submit(first);
    await f.coordinator.submit(first);
    expect(f.driver.prepare).toHaveBeenCalledTimes(1);
    await expect(f.coordinator.submit({ ...first, kind: "stop" })).rejects.toThrow("LIFECYCLE_ID_CONFLICT");
    await expect(f.coordinator.submit(request("stop"))).rejects.toThrow("LIFECYCLE_BUSY");
    const replacement = { ...request("stop"), replacesRequestId: first.requestId };
    await f.coordinator.submit(replacement);
    expect(f.coordinator.snapshot(first.requestId)?.phase).toBe("cancelled");
    expect(f.coordinator.active?.requestId).toBe(replacement.requestId);
  });

  it("does not run after cancellation races with an in-flight observation", async () => {
    const f = fixture(), intent = request();
    let finish: (value: LifecycleInspection) => void = () => undefined;
    vi.mocked(f.driver.inspect).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.coordinator.submit(intent);
    f.coordinator.cancel(intent.requestId);
    finish({ run: "pid:owner-token", reasons: [] });
    await f.coordinator.settled();
    expect(f.driver.execute).not.toHaveBeenCalled();
    expect(f.coordinator.latest?.phase).toBe("cancelled");
  });

  it.each(["memory-only-threads", "pending-interactions", "background-processes", "background-state-unknown", "runtime-unreachable"])(
    "keeps %s protection until a fresh inspection clears it", async code => {
      const f = fixture(); f.inspect({ run: "pid:owner-token", reasons: [{ code, count: 1 }] });
      await f.coordinator.submit(request("stop")); await f.coordinator.settled();
      expect(f.coordinator.active).toMatchObject({ phase: "blocked", reasons: [{ code, count: 1 }] });
      expect(f.driver.execute).not.toHaveBeenCalled();
      f.inspect({ run: "pid:owner-token", reasons: [] }); f.event(); await f.coordinator.settled();
      expect(f.coordinator.latest?.phase).toBe("completed");
    });

  it("keeps intent when the final admission fence finds new protected work", async () => {
    const f = fixture(); f.inspect({ run: "pid:owner-token", reasons: [] });
    vi.mocked(f.driver.execute).mockRejectedValueOnce(new Error("CODEX_APPLY_PENDING: a late memory-only thread"));
    await f.coordinator.submit(request()); await f.coordinator.settled();
    expect(f.coordinator.latest?.phase).toBe("blocked");
    f.event(); await f.coordinator.settled();
    expect(f.coordinator.latest?.phase).toBe("completed");
    expect(f.driver.execute).toHaveBeenCalledTimes(2);
  });

  it("does not implicitly force and rejects cancellation after execution starts", async () => {
    const f = fixture(), intent = { ...request(), force: true };
    let finish: (value: "completed") => void = () => undefined;
    vi.mocked(f.driver.execute).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.coordinator.submit(intent);
    await vi.waitFor(() => expect(f.coordinator.latest?.phase).toBe("executing"));
    expect(() => f.coordinator.cancel(intent.requestId)).toThrow("LIFECYCLE_NOT_CANCELLABLE");
    finish("completed"); await f.coordinator.settled();
    expect(f.coordinator.latest?.force).toBe(true);
  });

  it("reports a failed admission restore instead of retrying a half-closed runtime", async () => {
    const f = fixture(); f.inspect({ run: "pid:owner-token", reasons: [] });
    vi.mocked(f.driver.execute).mockRejectedValue(new Error("DRAIN_TIMEOUT: late work. DRAIN_CANCEL_FAILED: connection lost."));
    await f.coordinator.submit(request()); await f.coordinator.settled();
    expect(f.coordinator.latest).toMatchObject({ phase: "failed", cancellable: false, error: expect.stringContaining("DRAIN_CANCEL_FAILED") });
    f.event(); await f.coordinator.settled();
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
  });

  it("reconciles a crash after execution rather than replaying a completed restart", async () => {
    const f = fixture(); await f.coordinator.submit(request()); await f.coordinator.settled(); await f.coordinator.close();
    const saved = JSON.parse(readFileSync(f.file, "utf8")); saved.records[0].phase = "reconnecting";
    writeFileSync(f.file, JSON.stringify(saved), { mode: 0o600 });
    vi.mocked(f.driver.reconcile).mockResolvedValue("completed");
    const recovered = new RuntimeLifecycleCoordinator(f.file, f.driver, f.options);
    try {
      recovered.resume(); await recovered.settled();
      expect(recovered.latest?.phase).toBe("completed");
      expect(f.driver.execute).not.toHaveBeenCalled();
    } finally { await recovered.close(); }
  });

  it("distinguishes handoff acceptance from verified external completion", async () => {
    const f = fixture(), intent = request("shutdown"); f.inspect({ run: null, reasons: [] });
    vi.mocked(f.driver.execute).mockResolvedValue("handoff-ready");
    await f.coordinator.submit(intent); await f.coordinator.settled();
    expect(f.coordinator.acknowledge(intent.requestId).phase).toBe("handing-off");
    await f.coordinator.settled(); expect(f.coordinator.latest?.phase).toBe("handing-off");
    vi.mocked(f.driver.reconcile).mockResolvedValue("completed");
    f.event(); await f.coordinator.settled(); expect(f.coordinator.latest?.phase).toBe("completed");
  });

  it("fails a changed target without running and never exposes credentials", async () => {
    const f = fixture(), intent = request("configure"); intent.configuration = { apiKey: "private-secret", tunnelId: "reserved-id" };
    vi.mocked(f.driver.inspect).mockRejectedValue(new Error("LIFECYCLE_TARGET_CHANGED"));
    const receipt = await f.coordinator.submit(intent);
    expect(JSON.stringify(receipt)).not.toContain("private-secret");
    await f.coordinator.settled();
    expect(f.coordinator.latest?.phase).toBe("failed"); expect(f.driver.execute).not.toHaveBeenCalled();
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.file, "utf8")).not.toContain("private-secret");
  });

  it("retains only the explicitly bounded legacy attempt contract", async () => {
    const f = fixture(); await f.coordinator.submit(request(), 0); await f.coordinator.settled();
    expect(f.coordinator.latest).toMatchObject({ phase: "failed", error: expect.stringContaining("DRAIN_TIMEOUT") });
  });
});
