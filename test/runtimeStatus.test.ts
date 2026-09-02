import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_STATUS_PROTOCOL,
  readManagedRuntimeStatus,
  writeManagedRuntimeStatus
} from "../scripts/runtime-status.mjs";

describe("managed runtime status", () => {
  it("round-trips a private versioned tunnel status", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-runtime-status-"));
    const file = path.join(root, "run", "status.json");
    writeManagedRuntimeStatus(file, {
      phase: "running",
      runtimeBuildId: "build-one",
      tunnel: {
        phase: "connected",
        profile: "managed",
        transport: "stdio",
        doctorPassed: true,
        processRunning: true,
        connected: true,
        lastCheckedAt: new Date().toISOString(),
        lastError: null
      }
    });
    expect(readManagedRuntimeStatus(file)).toMatchObject({
      protocol: MANAGED_RUNTIME_STATUS_PROTOCOL,
      phase: "running",
      stale: false,
      tunnel: { connected: true, doctorPassed: true }
    });
  });

  it("does not let a caller override authoritative envelope fields", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-runtime-status-"));
    const file = path.join(root, "run", "status.json");
    writeManagedRuntimeStatus(file, {
      protocol: "untrusted",
      version: 999,
      launcherPid: -1,
      generatedAt: "2000-01-01T00:00:00.000Z",
      phase: "running",
      runtimeBuildId: "build-one",
      tunnel: connectedTunnel()
    });
    expect(readManagedRuntimeStatus(file)).toMatchObject({
      protocol: MANAGED_RUNTIME_STATUS_PROTOCOL,
      version: 1,
      launcherPid: process.pid,
      stale: false
    });
  });

  it("rejects status timestamps implausibly far in the future", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-runtime-status-"));
    const file = path.join(root, "run", "status.json");
    writeManagedRuntimeStatus(file, {
      phase: "running",
      runtimeBuildId: "build-one",
      tunnel: connectedTunnel()
    });
    const status = JSON.parse(readFileSync(file, "utf8"));
    status.generatedAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(file, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    expect(readManagedRuntimeStatus(file)).toBeNull();
  });
});

function connectedTunnel() {
  return {
    phase: "connected",
    profile: "managed",
    transport: "stdio",
    doctorPassed: true,
    processRunning: true,
    connected: true,
    lastCheckedAt: new Date().toISOString(),
    lastError: null
  };
}
