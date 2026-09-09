import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveExecutionPolicy, resolveTaskSandbox } from "../src/executionPolicy.js";
import { executionAccessArguments, threadAccessParams } from "../src/executionAccess.js";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import { CodexBackendRouter } from "../src/upstreamRouter.js";
import { UserSettingsStore } from "../src/userSettings.js";

const cwd = process.cwd();
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
  CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" });
const full = resolveExecutionPolicy(config, { accessStrategy: "always-full" }, cwd);

describe("central execution policy", () => {
  it("resolves full access from the saved setting, including connector defaults, without changing environment defaults", () => {
    expect(config.defaultApprovalPolicy).toBe("on-request");
    expect(full).toEqual({ cwd, sandbox: "danger-full-access", approvalPolicy: "never",
      approvalsReviewer: "user", appToolApprovalMode: "approve" });
    expect(config.defaultApprovalPolicy).toBe("on-request");
    expect(threadAccessParams(full, { model_reasoning_effort: "high" })).toMatchObject({
      approvalPolicy: "never", approvalsReviewer: "user",
      config: { model_reasoning_effort: "high", "apps._default.default_tools_approval_mode": "approve" }
    });
  });

  it.each(["read-only", "adaptive"] as const)("uses the configured approval policy and reviewer for %s", accessStrategy => {
    const settings = { ...config, defaultApprovalPolicy: "untrusted" as const, defaultApprovalsReviewer: "auto_review" as const };
    expect(resolveExecutionPolicy(settings, { accessStrategy }, cwd)).toMatchObject({
      sandbox: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "auto_review", appToolApprovalMode: "auto"
    });
  });

  it("does not grant approval-free access when the operator disables full access", () => {
    const restricted = { ...config, allowDangerFullAccess: false };
    expect(resolveExecutionPolicy(restricted, { accessStrategy: "always-full" }, cwd)).toMatchObject({
      sandbox: "read-only", approvalPolicy: "on-request", appToolApprovalMode: "auto"
    });
    for (const operation of [resolveTaskSandbox, (c: typeof config, s: { accessStrategy: "always-full" }, sandbox: "danger-full-access") => resolveExecutionPolicy(c, s, cwd, sandbox)]) {
      expect(() => operation(restricted, { accessStrategy: "always-full" }, "danger-full-access")).toThrow("ALLOW_DANGER_FULL_ACCESS");
    }
  });

  it("uses the same sandbox decision for settings and execution and preserves context conflicts", () => {
    const settings = new UserSettingsStore(config);
    settings.update({ accessStrategy: "always-full" }, settings.current.revision);
    expect(settings.resolveSandbox()).toBe(resolveExecutionPolicy(config, settings.current, cwd).sandbox);
    expect(() => resolveExecutionPolicy(config, settings.current, cwd, "read-only")).toThrow("SANDBOX_CONTEXT_CONFLICT");
    expect(() => resolveExecutionPolicy(config, { accessStrategy: "read-only" }, cwd, "danger-full-access")).toThrow("SANDBOX_CONTEXT_CONFLICT");
  });

  it.each(["typed", "compatibility"] as const)("carries the same policy through %s start, resume, and fork", async route => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-central-policy-"));
    const log = path.join(directory, "requests.jsonl");
    const pool = new CodexAppServerUpstreamPool(path.resolve("test/fixtures/fake-codex-app-server.mjs"), 1,
      { environment: { ...process.env, CODEX_TEST_POLICY_LOG: log } });
    const upstream = new CodexBackendRouter("app-server", pool);
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" };
    const request = { ...full, backendKind: "app-server" as const, prompt: "hello", selection };
    try {
      const result = route === "typed" ? await upstream.startThread(request)
        : await upstream.callTool("codex", { ...executionAccessArguments(full), prompt: "hello", model: selection.model });
      const threadId = result.structuredContent!.threadId as string;
      // Force a real resume negotiation instead of reusing the worker cache.
      await upstream.archiveThread(threadId);
      await upstream.restoreThread(threadId);
      const resumed = route === "typed" ? await upstream.continueThread({ ...request, threadId })
        : await upstream.callTool("codex-reply", { ...executionAccessArguments(full), threadId, prompt: "hello" });
      const forked = await upstream.forkThread({ ...request, threadId });
      for (const value of [result, resumed, forked]) {
        expect(value.structuredContent).toMatchObject({ executionAccess: {
          sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
          appToolApprovalMode: "approve", appToolApprovalEvidence: "thread-config-override-sent"
        } });
      }
      const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(requests.map(entry => entry.method)).toEqual(["thread/start", "thread/resume", "thread/fork"]);
      for (const { params } of requests) expect(params).toMatchObject({
        cwd, sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
        config: { "apps._default.default_tools_approval_mode": "approve" }
      });
      if (route === "typed") expect(requests[0].params.config.model_reasoning_effort).toBe("high");
    } finally { await upstream.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
