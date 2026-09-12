import { realpathSync } from "node:fs";
import path from "node:path";
import type { ApprovalPolicy, ApprovalsReviewer, SandboxMode } from "./config.js";

export type AppToolApprovalMode = "auto" | "approve";

export type ExecutionAccessRequest = {
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  appToolApprovalMode?: AppToolApprovalMode;
};

/** Private worker evidence. Keep complete policy details out of public logs. */
export type VerifiedExecutionAccess = Omit<ExecutionAccessRequest, "approvalsReviewer"> & {
  sandboxPolicy: Record<string, unknown>;
  approvalsReviewer: string;
  activePermissionProfile: { id: string; extends?: string | null } | null;
};

export function executionAccessRequest(args: Record<string, unknown>): ExecutionAccessRequest {
  const { cwd, sandbox } = args;
  const approvalPolicy = args["approval-policy"];
  const approvalsReviewer = args["approvals-reviewer"];
  const appToolApprovalMode = args["app-tool-approval-mode"];
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) ||
      typeof sandbox !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(sandbox) ||
      typeof approvalPolicy !== "string" || !["untrusted", "on-request", "never"].includes(approvalPolicy) ||
      (approvalsReviewer !== undefined && approvalsReviewer !== "user" && approvalsReviewer !== "auto_review") ||
      (appToolApprovalMode !== undefined && appToolApprovalMode !== "auto" && appToolApprovalMode !== "approve")) {
    throw new Error("EXECUTION_ACCESS_REQUIRED: A known cwd, sandbox, and approval policy are required before executing a Codex turn.");
  }
  return { cwd, sandbox: sandbox as SandboxMode, approvalPolicy: approvalPolicy as ApprovalPolicy,
    ...(approvalsReviewer !== undefined ? { approvalsReviewer } : {}),
    ...(appToolApprovalMode !== undefined ? { appToolApprovalMode } : {}) };
}

export function executionAccessArguments(access: ExecutionAccessRequest): Record<string, unknown> {
  return { cwd: access.cwd, sandbox: access.sandbox, "approval-policy": access.approvalPolicy,
    ...(access.approvalsReviewer !== undefined ? { "approvals-reviewer": access.approvalsReviewer } : {}),
    ...(access.appToolApprovalMode !== undefined ? { "app-tool-approval-mode": access.appToolApprovalMode } : {}) };
}

export function threadAccessParams(access: ExecutionAccessRequest, config?: Record<string, unknown>): Record<string, unknown> {
  return { cwd: access.cwd, sandbox: access.sandbox, approvalPolicy: access.approvalPolicy,
    ...(access.approvalsReviewer !== undefined ? { approvalsReviewer: access.approvalsReviewer } : {}),
    ...(config || access.appToolApprovalMode !== undefined ? { config: {
      ...config,
      ...(access.appToolApprovalMode !== undefined
        ? { "apps._default.default_tools_approval_mode": access.appToolApprovalMode } : {})
    } } : {}) };
}

export function verifyExecutionAccess(
  response: Record<string, unknown>, expected: ExecutionAccessRequest, method: string
): VerifiedExecutionAccess {
  const sandbox = response.sandbox;
  const type = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[expected.sandbox];
  const mismatches: string[] = [];
  if (!record(sandbox) || sandbox.type !== type) mismatches.push("sandbox");
  if (record(sandbox) && (expected.sandbox === "read-only" || expected.sandbox === "workspace-write")) {
    if (sandbox.networkAccess !== undefined && typeof sandbox.networkAccess !== "boolean") mismatches.push("sandbox.networkAccess");
    if (sandbox.writableRoots !== undefined && (!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some(root => typeof root !== "string" || !path.isAbsolute(root)))) mismatches.push("sandbox.writableRoots");
    for (const field of ["excludeSlashTmp", "excludeTmpdirEnvVar"]) {
      if (sandbox[field] !== undefined && typeof sandbox[field] !== "boolean") mismatches.push(`sandbox.${field}`);
    }
  }
  if (response.approvalPolicy !== expected.approvalPolicy) mismatches.push("approvalPolicy");
  if (typeof response.cwd !== "string" || !path.isAbsolute(response.cwd) ||
      canonicalPath(response.cwd) !== canonicalPath(expected.cwd)) mismatches.push("cwd");
  if (typeof response.approvalsReviewer !== "string" || !["user", "auto_review", "guardian_subagent"].includes(response.approvalsReviewer)) {
    mismatches.push("approvalsReviewer");
  }
  if (expected.approvalsReviewer !== undefined && response.approvalsReviewer !== expected.approvalsReviewer) {
    mismatches.push("approvalsReviewer");
  }
  // Loaded threads retain their original connector configuration. Do not
  // claim a newly requested default has been applied to an already loaded one.
  if (method === "loaded thread" && response.appToolApprovalMode !== expected.appToolApprovalMode) {
    mismatches.push("appToolApprovalMode (start a fresh context to change connector defaults)");
  }
  const profile = response.activePermissionProfile;
  if (profile != null && (!record(profile) || typeof profile.id !== "string" || !profile.id ||
      (profile.extends != null && typeof profile.extends !== "string"))) mismatches.push("activePermissionProfile");
  if (mismatches.length) {
    throw new Error(`EXECUTION_ACCESS_MISMATCH: ${method} did not confirm the requested execution policy (${mismatches.join(", ")}). No Codex turn was started.`);
  }
  return {
    ...expected,
    sandboxPolicy: structuredClone(sandbox as Record<string, unknown>),
    approvalsReviewer: response.approvalsReviewer as string,
    activePermissionProfile: record(profile)
      ? { id: profile.id as string, ...(profile.extends !== undefined ? { extends: profile.extends as string | null } : {}) }
      : null
  };
}

export function turnAccessParams(access: VerifiedExecutionAccess): Record<string, unknown> {
  return {
    cwd: access.cwd,
    approvalPolicy: access.approvalPolicy,
    approvalsReviewer: access.approvalsReviewer,
    // Named profiles can contain restrictions absent from the legacy sandbox
    // projection. Preserve their identity instead of reconstructing permissions.
    ...(access.activePermissionProfile
      ? { permissions: access.activePermissionProfile.id }
      : { sandboxPolicy: access.sandboxPolicy })
  };
}

export function executionAccessEvidence(access: VerifiedExecutionAccess): Record<string, unknown> {
  const policy = access.sandboxPolicy;
  return {
    sandbox: access.sandbox, approvalPolicy: access.approvalPolicy,
    approvalsReviewer: access.approvalsReviewer,
    ...(access.appToolApprovalMode !== undefined ? {
      appToolApprovalMode: access.appToolApprovalMode,
      appToolApprovalEvidence: "thread-config-override-sent"
    } : {}),
    activePermissionProfile: structuredClone(access.activePermissionProfile),
    networkAccess: policy.networkAccess ?? (access.sandbox === "danger-full-access"),
    writableRootCount: Array.isArray(policy.writableRoots) ? policy.writableRoots.length : 0,
    excludeSlashTmp: policy.excludeSlashTmp ?? null,
    excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar ?? null,
    evidence: "thread-policy-confirmed-and-turn-policy-sent"
  };
}

function canonicalPath(value: string): string {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
