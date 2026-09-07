import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

const policies = new Map();
export function threadPolicyResponse(method, params, threadId) {
  const previous = policies.get(params.threadId) || {};
  const response = {
    cwd: params.cwd ?? previous.cwd ?? process.cwd(),
    approvalPolicy: params.approvalPolicy ?? previous.approvalPolicy ?? "on-request",
    approvalsReviewer: "user",
    sandbox: params.sandbox ? { type: {
      "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess"
    }[params.sandbox], ...(params.sandbox === "danger-full-access" ? {} : { networkAccess: false }) }
      : previous.sandbox || { type: "readOnly", networkAccess: false },
    activePermissionProfile: null
  };
  if (process.env.CODEX_TEST_NAMED_PROFILE) response.activePermissionProfile = { id: process.env.CODEX_TEST_NAMED_PROFILE };
  policies.set(threadId, response);
  const [mismatchMethod, field] = (process.env.CODEX_TEST_POLICY_MISMATCH || "").split(":");
  if (method === mismatchMethod) {
    if (field === "sandbox") response.sandbox = { type: "dangerFullAccess" };
    if (field === "approvalPolicy") response.approvalPolicy = "never";
    if (field === "cwd") response.cwd = "/unrequested-workspace";
    if (field === "missing") delete response.sandbox;
  }
  return response;
}

export function assertTurnPolicy(params) {
  if (process.env.CODEX_TEST_TURN_LOG) appendFileSync(process.env.CODEX_TEST_TURN_LOG, "turn/start\n");
  const expected = policies.get(params.threadId);
  assert.ok(expected, "turn must have a verified thread policy");
  assert.equal(params.cwd, expected.cwd);
  assert.equal(params.approvalPolicy, expected.approvalPolicy);
  assert.equal(params.approvalsReviewer, expected.approvalsReviewer);
  if (expected.activePermissionProfile) {
    assert.equal(params.permissions, expected.activePermissionProfile.id);
    assert.equal(params.sandboxPolicy, undefined);
  } else assert.deepEqual(params.sandboxPolicy, expected.sandbox);
}
