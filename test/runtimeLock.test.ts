import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRuntimeLock } from "../scripts/runtime-lock.mjs";

describe("runtime ownership lock", () => {
  it("allows one owner and removes only its own private lock", () => {
    const root = temporaryDirectory();
    const lockPath = path.join(root, "run", "launcher.lock");
    const first = acquireRuntimeLock(lockPath, { pid: 101, processAlive: () => true });
    expect(existsSync(path.join(lockPath, "owner.json"))).toBe(true);
    expect(() => acquireRuntimeLock(lockPath, { pid: 202, processAlive: () => true }))
      .toThrow("already running");
    first.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a verified stale lock without recursive deletion", () => {
    const root = temporaryDirectory();
    const lockPath = path.join(root, "run", "launcher.lock");
    const stale = acquireRuntimeLock(lockPath, { pid: 101, processAlive: () => true });
    const replacement = acquireRuntimeLock(lockPath, { pid: 202, processAlive: () => false });
    replacement.release();
    stale.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses to clean a malformed lock directory", () => {
    const root = temporaryDirectory();
    const lockPath = path.join(root, "run", "launcher.lock");
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(lockPath, "unexpected"), "keep", { mode: 0o600 });
    expect(() => acquireRuntimeLock(lockPath, { pid: 202, processAlive: () => false }))
      .toThrow("expected private format");
    expect(existsSync(path.join(lockPath, "unexpected"))).toBe(true);
  });
});

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-runtime-lock-"));
}
