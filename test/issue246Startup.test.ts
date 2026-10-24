import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_START_BUDGET_MS, InitialStartupFailure, RuntimeLifecycleCoordinator,
  type LifecycleDriver, type LifecycleRequest
} from "../src/runtimeLifecycle.js";
import { acquireRuntimeLock, releaseStoppedRuntimeLock } from "../scripts/runtime-lock.mjs";
import { initialStartupContext, initialStartupStageTimeout } from "../scripts/runtime-status.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "initial-start-"));
  const file = path.join(root, "lifecycle.json");
  let now = Date.now();
  const driver: LifecycleDriver = {
    prepare: vi.fn(async request => ({ request, target: {} })),
    inspect: vi.fn(async () => ({ run: null, reasons: [] })),
    execute: vi.fn(async () => "completed" as const),
    reconcile: vi.fn(async () => "retry" as const), changed: vi.fn(), error: error => String(error)
  };
  const options = { now: () => now, intervalMs: 100_000 };
  const coordinator = new RuntimeLifecycleCoordinator(file, driver, options);
  const recovered: RuntimeLifecycleCoordinator[] = [];
  cleanups.push(async () => { await coordinator.close(); for (const c of recovered) await c.close(); rmSync(root, { recursive: true, force: true }); });
  return { file, driver, coordinator, advance: (ms: number) => { now += ms; },
    launch: (): LifecycleRequest => ({ requestId: randomUUID(), kind: "start", force: false, applicationLaunchAt: new Date(now).toISOString() }),
    recover: () => { const c = new RuntimeLifecycleCoordinator(file, driver, options); recovered.push(c); return c; },
    tick: async (ms: number, c = coordinator) => { now += ms; c.signal(); await c.settled(); } };
}

describe("initial startup intent only", () => {
  it("persists attempt consumption and ownership before the first effect; replay never renews it", async () => {
    const f = fixture(), launch = f.launch();
    vi.mocked(f.driver.execute).mockImplementation(async record => {
      const persisted = JSON.parse(readFileSync(f.file, "utf8")).records[0];
      expect(persisted).toMatchObject({ phase: "executing", startup: { attempts: 1, cleanup: "pending" } });
      expect(persisted.startup.owner.token).toBe(record.startup!.owner!.token);
      throw new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true);
    });
    await f.coordinator.submit(launch); await f.coordinator.settled();
    const before = f.coordinator.latest!;
    await f.coordinator.submit(launch); await f.tick(500);
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
    expect(f.coordinator.latest!.startup).toEqual(before.startup);
    expect(before).toMatchObject({ phase: "waiting", cancellable: true, startup: { attempts: 1, stage: "backoff" } });
    expect(JSON.stringify(before)).not.toContain("token");
  });

  it("succeeds on attempt two in the same request, with fresh inspection and one absolute deadline", async () => {
    const f = fixture(), launch = f.launch();
    const tokens: string[] = [];
    vi.mocked(f.driver.execute).mockImplementation(async record => {
      tokens.push(record.startup!.owner!.token);
      if (tokens.length === 1) throw new InitialStartupFailure("STARTUP_STATE_TIMEOUT", true);
      return "completed";
    });
    await f.coordinator.submit(launch); await f.coordinator.settled();
    const deadline = f.coordinator.latest!.startup!.deadlineAt;
    await f.tick(1000);
    expect(f.coordinator.latest).toMatchObject({ requestId: launch.requestId, phase: "completed", startup: { attempts: 2, deadlineAt: deadline } });
    expect(f.driver.inspect).toHaveBeenCalledTimes(2);
    expect(f.driver.prepare).toHaveBeenCalledTimes(1);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("spends at most three total attempts, then retains the terminal receipt", async () => {
    const f = fixture(), launch = f.launch();
    vi.mocked(f.driver.execute).mockRejectedValue(new InitialStartupFailure("STARTUP_TUNNEL_TIMEOUT", true));
    await f.coordinator.submit(launch); await f.coordinator.settled();
    await f.tick(1000); await f.tick(2000); await f.tick(60_000);
    expect(f.driver.execute).toHaveBeenCalledTimes(3);
    expect(f.coordinator.latest).toMatchObject({ phase: "failed", startup: { attempts: 3, nextAttemptAt: null } });
    await f.coordinator.submit(launch); await f.tick(1000);
    expect(f.driver.execute).toHaveBeenCalledTimes(3);
  });

  it("does not spend a new attempt after the absolute deadline, even across helper re-entry", async () => {
    const f = fixture(), launch = f.launch();
    vi.mocked(f.driver.execute).mockRejectedValue(new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true));
    await f.coordinator.submit(launch); await f.coordinator.settled(); await f.coordinator.close();
    f.advance(INITIAL_START_BUDGET_MS);
    const recovered = f.recover(); recovered.resume(); await recovered.settled();
    expect(recovered.latest).toMatchObject({ phase: "failed", startup: { attempts: 1, failureCode: "STARTUP_BUDGET_EXHAUSTED" } });
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves backoff and remaining attempts across re-entry and late application join", async () => {
    const f = fixture();
    vi.mocked(f.driver.execute).mockRejectedValueOnce(new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true));
    const request: LifecycleRequest = { requestId: randomUUID(), kind: "start", force: false };
    await f.coordinator.submit(request, undefined, "helper-launch"); await f.coordinator.settled();
    const initial = f.coordinator.latest!; await f.coordinator.close();
    f.advance(500); const recovered = f.recover(); recovered.resume(); await recovered.settled();
    expect(recovered.latest!.startup).toEqual(initial.startup);
    const joined = await recovered.submit({ ...f.launch(), applicationLaunchAt: new Date(initial.startup!.startedAt - 1000).toISOString() });
    expect(joined.requestId).toBe(initial.requestId);
    expect(joined.startup!.deadlineAt).toBe(initial.startup!.deadlineAt - 1000);
    await f.tick(500, recovered);
    expect(recovered.latest).toMatchObject({ phase: "completed", startup: { attempts: 2 } });
  });

  it.each(["cancel", "stop"] as const)("%s during retry backoff wins over replay and recovered startup", async action => {
    const f = fixture(), launch = f.launch();
    vi.mocked(f.driver.execute).mockRejectedValueOnce(new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true));
    await f.coordinator.submit(launch); await f.coordinator.settled();
    f.advance(100);
    if (action === "cancel") f.coordinator.cancel(launch.requestId);
    else await f.coordinator.submit({ requestId: randomUUID(), kind: "stop", force: false, replacesRequestId: launch.requestId });
    await f.coordinator.settled(); const latest = f.coordinator.latest!;
    await f.coordinator.submit(launch);
    expect((await f.coordinator.submit({ ...launch, requestId: randomUUID() })).requestId).toBe(latest.requestId);
    await f.coordinator.close(); const recovered = f.recover(); await f.tick(5000, recovered);
    expect(recovered.active).toBeNull();
    expect(f.driver.execute).toHaveBeenCalledTimes(action === "cancel" ? 1 : 2);
  });

  it.each([
    new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", false),
    new InitialStartupFailure("STARTUP_STATE_FAILED", true, "STATE_STORAGE_CORRUPT"),
    new InitialStartupFailure("STARTUP_PROTOCOL_MISMATCH", true),
    new InitialStartupFailure("STARTUP_OWNERSHIP_CONFLICT", false),
    new Error("STARTUP_HTTP_TIMEOUT: text alone is not retry authority"),
    new Error("CODEX_AUTH_ACTIVATION_UNCERTAIN: retain reconciliation"),
    new Error("CONFIG_ROLLBACK_FAILED: retain cause")
  ])("fails closed for permanent, untyped or unconfirmed failures: %s", async error => {
    const f = fixture(); vi.mocked(f.driver.execute).mockRejectedValue(error);
    await f.coordinator.submit(f.launch()); await f.coordinator.settled(); await f.tick(10_000);
    expect(f.coordinator.latest?.phase).toBe("failed");
    expect(f.coordinator.latest?.error).toContain(error.message);
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
  });

  it("observes an in-flight owned attempt after re-entry without a second spawn", async () => {
    const f = fixture();
    vi.mocked(f.driver.execute).mockRejectedValueOnce(new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true));
    await f.coordinator.submit(f.launch()); await f.coordinator.settled(); await f.coordinator.close();
    const saved = JSON.parse(readFileSync(f.file, "utf8")); saved.records[0].phase = "reconnecting";
    saved.records[0].startup.nextAttemptAt = null; saved.records[0].startup.cleanup = "pending";
    writeFileSync(f.file, JSON.stringify(saved), { mode: 0o600 });
    vi.mocked(f.driver.reconcile).mockResolvedValueOnce("startup-pending").mockResolvedValueOnce("completed");
    const recovered = f.recover(); recovered.resume(); await recovered.settled();
    expect(recovered.latest?.phase).toBe("reconnecting");
    await f.tick(1000, recovered);
    expect(recovered.latest).toMatchObject({ phase: "completed", startup: { attempts: 1, stage: "ready" } });
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "cancel"] as const)("a %s during the non-cancellable initial attempt durably disables later automatic attempts", async action => {
    const f = fixture(), launch = f.launch();
    let rejectAttempt!: (error: unknown) => void;
    vi.mocked(f.driver.execute).mockImplementation(() => new Promise((_, reject) => { rejectAttempt = reject; }));
    await f.coordinator.submit(launch);
    await vi.waitFor(() => expect(f.coordinator.latest?.phase).toBe("executing"));
    if (action === "stop") await expect(f.coordinator.submit({ requestId: randomUUID(), kind: "stop", force: false })).rejects.toThrow("INITIAL_START_RETRY_SUPPRESSED");
    else expect(() => f.coordinator.cancel(launch.requestId)).toThrow("INITIAL_START_RETRY_SUPPRESSED");
    expect(JSON.parse(readFileSync(f.file, "utf8")).records[0].startup.retrySuppressed).toBe(true);
    rejectAttempt(new InitialStartupFailure("STARTUP_HTTP_TIMEOUT", true));
    await f.coordinator.settled(); await f.tick(10_000);
    expect(f.coordinator.latest).toMatchObject({ phase: "cancelled", startup: { attempts: 1, retrySuppressed: true } });
    expect(f.driver.execute).toHaveBeenCalledTimes(1);
    await f.coordinator.close(); const recovered = f.recover(); recovered.resume(); await recovered.settled();
    expect(recovered.active).toBeNull();
    expect((await recovered.submit(launch)).phase).toBe("cancelled");
  });

  it("ordinary starts, legacy bounded attempts and protected migrations keep their original contracts", async () => {
    for (const mode of ["ordinary", "legacy", "migration", "existing"] as const) {
      const f = fixture();
      if (mode === "migration" || mode === "existing") vi.mocked(f.driver.prepare).mockImplementation(async request => ({ request,
        target: mode === "migration" ? { startupRecoveryProtected: true } : { existingRun: "pid:token" } }));
      await f.coordinator.submit(mode === "ordinary" ? { ...f.launch(), applicationLaunchAt: undefined } : f.launch(), mode === "legacy" ? 90_000 : undefined);
      await f.coordinator.settled();
      expect(f.coordinator.latest?.startup).toBeUndefined();
    }
  });

  it("rejects a corrupted persisted budget rather than granting more time", async () => {
    const f = fixture(); await f.coordinator.submit(f.launch()); await f.coordinator.settled(); await f.coordinator.close();
    const saved = JSON.parse(readFileSync(f.file, "utf8")); saved.records[0].startup.deadlineAt += 1;
    writeFileSync(f.file, JSON.stringify(saved), { mode: 0o600 });
    expect(() => f.recover()).toThrow("Invalid persisted initial startup budget");
  });
});

it("caps initial stages by remaining time and leaves legacy/recovery limits alone", () => {
  const environment = { CODEX_MCP_BRIDGE_INITIAL_START_REQUEST: randomUUID(), CODEX_MCP_BRIDGE_INITIAL_START_TOKEN: randomUUID(),
    CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT: "2", CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE: "100000" };
  expect(initialStartupContext(environment)?.attempt).toBe(2);
  expect(initialStartupStageTimeout(75_000, 20_000, environment, 50_000)).toBe(50_000);
  expect(initialStartupStageTimeout(90_000, 30_000, environment, 100_001)).toBe(0);
  expect(initialStartupStageTimeout(75_000, 20_000, {}, 50_000)).toBe(20_000);
  expect(() => initialStartupContext({ ...environment, CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT: "4" })).toThrow("STARTUP_CONTEXT_INVALID");
});

it("releases only the exact stopped lock token and never a different or live owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "initial-lock-")); const directory = path.join(root, "lock");
  const token = randomUUID();
  try {
    const lock = acquireRuntimeLock(directory, { pid: process.pid, token });
    expect(() => releaseStoppedRuntimeLock(directory, { pid: process.pid, token })).toThrow("ownership");
    expect(() => releaseStoppedRuntimeLock(directory, { pid: process.pid, token: randomUUID() }, { processAlive: () => false })).toThrow("ownership");
    expect(JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")).token).toBe(token);
    releaseStoppedRuntimeLock(directory, { pid: process.pid, token }, { processAlive: () => false });
    lock.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
