import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import { executionAccessRequest, verifyExecutionAccess } from "../src/executionAccess.js";

const fixture = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const access = { cwd: process.cwd(), sandbox: "read-only" as const, approvalPolicy: "on-request" as const, approvalsReviewer: "user" as const };
const start = { ...access, backendKind: "app-server" as const, prompt: "hello", selection: { model: "gpt-5.6-sol", reasoningEffort: "max" } };

describe("actual CLI execution policy", () => {
  it.each(["thread/start", "thread/resume", "thread/fork"].flatMap(method =>
    ["sandbox", "approvalPolicy", "approvalsReviewer", "cwd", "missing"].map(field => ({ method, field }))
  ))("never starts a turn after $method returns a mismatched $field", async ({ method, field }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "policy-turn-test-")), log = path.join(directory, "turns");
    writeFileSync(log, "");
    const pool = new CodexAppServerUpstreamPool(fixture, 1, { environment: {
      ...process.env, CODEX_TEST_POLICY_MISMATCH: `${method}:${field}`, CODEX_TEST_TURN_LOG: log
    } });
    try {
      if (method === "thread/start") {
        await expect(pool.startThread(start)).rejects.toThrow("EXECUTION_ACCESS_MISMATCH");
        expect(readFileSync(log, "utf8")).toBe("");
      } else {
        const result = await pool.startThread(start);
        const threadId = result.structuredContent!.threadId as string;
        if (method === "thread/resume") {
          await pool.archiveThread(threadId);
          await pool.restoreThread(threadId);
        }
        const before = readFileSync(log, "utf8");
        const request = { ...start, threadId };
        await expect(method === "thread/fork" ? pool.forkThread(request) : pool.continueThread(request))
          .rejects.toThrow("EXECUTION_ACCESS_MISMATCH");
        expect(readFileSync(log, "utf8")).toBe(before);
      }
    } finally { await pool.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves a named profile instead of reconstructing its legacy sandbox projection", async () => {
    const pool = new CodexAppServerUpstreamPool(fixture, 1, { environment: { ...process.env, CODEX_TEST_NAMED_PROFILE: ":read-only" } });
    try {
      const result = await pool.startThread(start);
      expect(result.structuredContent).toMatchObject({ executionAccess: {
        sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user",
        activePermissionProfile: { id: ":read-only" }, networkAccess: false
      } });
    } finally { await pool.close(); }
  });

  it("does not infer an unknown thread's policy from CLI defaults", () => {
    expect(() => executionAccessRequest({ threadId: "untracked", prompt: "continue" })).toThrow("EXECUTION_ACCESS_REQUIRED");
  });

  it("does not claim a changed connector default was applied to a loaded thread", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loaded-policy-test-")), log = path.join(directory, "turns");
    writeFileSync(log, "");
    const pool = new CodexAppServerUpstreamPool(fixture, 1, { environment: { ...process.env, CODEX_TEST_TURN_LOG: log } });
    try {
      const result = await pool.startThread({ ...start, appToolApprovalMode: "auto" });
      const before = readFileSync(log, "utf8");
      await expect(pool.continueThread({ ...start, threadId: result.structuredContent!.threadId as string, appToolApprovalMode: "approve" }))
        .rejects.toThrow("appToolApprovalMode");
      expect(readFileSync(log, "utf8")).toBe(before);
    } finally { await pool.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects missing reviewer evidence and different cwd even with a matching sandbox", () => {
    expect(() => verifyExecutionAccess({ sandbox: { type: "readOnly" }, approvalPolicy: "on-request", cwd: access.cwd }, access, "thread/start"))
      .toThrow("approvalsReviewer");
  });
});
