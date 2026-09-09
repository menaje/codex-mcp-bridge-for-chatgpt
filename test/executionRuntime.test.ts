import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { createExecutionRuntime } from "../src/executionRuntime.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { DEFAULT_THREAD_IDLE_MS, ThreadConnectionController } from "../src/threadConnections.js";
import type { UpstreamWorkerAssignment } from "../src/upstream.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "execution-lifecycle-"));
  roots.push(root);
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const acquire = vi.spyOn(CodexRuntimeManager.prototype, "acquire").mockResolvedValue({
    selection: { id: "fixture", source: "terminal", command, physicalPath: command, version: "0.153.3" },
    release: async () => {}
  });
  const environment = {
    PATH: process.env.PATH || "", HOME: root, CODEX_HOME: path.join(root, ".codex"),
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime")
  };
  const config = loadConfig({ ...environment, CODEX_MCP_BRIDGE_NO_AUTH: "1" });
  config.upstreamPoolSize = 1;
  return { acquire, runtime: createExecutionRuntime(config, {}, environment) };
}

describe("production execution runtime connection lifecycle", () => {
  it.each(["idle", "handoff"] as const)("releases through the runtime factory for %s and keeps reads detached", async mode => {
    const { runtime } = fixture();
    const store = new BridgeStateStore({ file: ":memory:" });
    const controller = new ThreadConnectionController(store.threadConnections, runtime,
      { now: () => mode === "idle" ? 2000 + DEFAULT_THREAD_IDLE_MS : 2000 });
    try {
      let assignment!: UpstreamWorkerAssignment;
      await runtime.startThread({ backendKind: "app-server", cwd: "/tmp", sandbox: "read-only",
        approvalPolicy: "never", ephemeral: false, prompt: "production release fixture",
        selection: { model: "gpt-5.6-sol", reasoningEffort: "low" } }, undefined,
      value => { assignment = value; });
      const job = { jobId: "job", requestId: "request", scopeId, backendKind: "app-server",
        ...assignment, status: "running", updatedAt: 1000 };
      store.upsertJob(job);
      store.upsertJob({ ...job, status: "completed", updatedAt: 2000 });
      if (mode === "handoff") controller.request(assignment.threadId!);
      await controller.sweep();
      expect(store.threadConnections.get(assignment.threadId!)).toMatchObject({
        phase: "released", evidence: "worker-exited"
      });
      expect(await runtime.listLoadedBackgroundTerminals(assignment.threadId!, "app-server")).toBeNull();
      await runtime.probeThread(assignment.threadId!, "app-server");
      await expect(runtime.listBackgroundTerminals(assignment.threadId!, "app-server")).rejects.toThrow("THREAD_RELEASED");
    } finally {
      await controller.close();
      await runtime.close();
      store.close();
    }
  });

  it("applies restart protection before lazy initialization without starting a worker to record it", async () => {
    const { runtime, acquire } = fixture();
    try {
      runtime.protectThreadFromImplicitResume("saved-thread");
      expect(acquire).not.toHaveBeenCalled();
      await runtime.prepareExecution({ backendKind: "app-server", contextMode: "fresh" });
      expect(acquire).toHaveBeenCalledTimes(1);
      await expect(runtime.listBackgroundTerminals("saved-thread", "app-server")).rejects.toThrow("THREAD_RELEASED");
    } finally { await runtime.close(); }
  });
});
