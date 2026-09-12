import { enforceSandbox, type AccessStrategy, type BridgeConfig, type SandboxMode } from "./config.js";
import type { ExecutionAccessRequest } from "./executionAccess.js";

/** Included in admission references: changing policy semantics invalidates old admission snapshots. */
export const EXECUTION_POLICY_VERSION = 1;

type AccessSettings = { accessStrategy: AccessStrategy };

/** The same owner policy applies to every CLI installation and context mode. */
export function resolveTaskSandbox(
  config: BridgeConfig,
  settings: AccessSettings,
  existing?: SandboxMode
): SandboxMode {
  const forced = settings.accessStrategy === "read-only" ? "read-only"
    : settings.accessStrategy === "always-full"
      ? config.allowDangerFullAccess ? "danger-full-access" : "read-only"
      : undefined;
  // Retained history is not authority to exceed the current operator limits.
  if (existing) enforceSandbox(config, existing);
  const sandbox = enforceSandbox(config, forced ?? existing);
  if (existing && sandbox !== existing) {
    throw new Error(
      `SANDBOX_CONTEXT_CONFLICT: This existing thread uses '${existing}', but the saved bridge setting requires '${sandbox}'. Start a fresh context under the saved setting; task calls cannot change permissions.`
    );
  }
  return sandbox;
}

export function resolveExecutionPolicy(
  config: BridgeConfig,
  settings: AccessSettings,
  cwd: string,
  existing?: SandboxMode
): ExecutionAccessRequest {
  const sandbox = resolveTaskSandbox(config, settings, existing);
  const fullAccess = settings.accessStrategy === "always-full" && sandbox === "danger-full-access";
  return {
    cwd,
    sandbox,
    approvalPolicy: fullAccess ? "never" : config.defaultApprovalPolicy,
    approvalsReviewer: config.defaultApprovalsReviewer,
    // A never policy alone can reject connector approval prompts. Configure
    // their default before starting the thread, preserving explicit app/tool
    // exceptions and server-owned authentication or input requests.
    appToolApprovalMode: fullAccess ? "approve" : "auto"
  };
}
