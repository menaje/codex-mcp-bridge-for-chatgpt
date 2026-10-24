import { codexChatgptOwnerKey } from "./codexAccount.js";

export type CodexLocalAuthPolicy = {
  credentialStore: string | null;
  forcedMethod: "chatgpt" | "api" | null;
  workspaceId: string | null;
};

/** Read the top-level authentication settings once for both policy and identity checks. */
export function parseCodexLocalAuthPolicy(config: string): CodexLocalAuthPolicy {
  const topLevel = config.split(/^\s*\[/m, 1)[0] || "";
  const read = (name: string): string | null => {
    const entries = [...topLevel.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "gm"))];
    if (entries.length === 0) return null;
    if (entries.length !== 1) throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: Duplicate local authentication settings.");
    const raw = entries[0]![1]!.trim();
    const quoted = raw.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!quoted) throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: A local authentication setting could not be parsed.");
    try {
      return quoted[1]![0] === '"' ? JSON.parse(quoted[1]!) as string : quoted[1]!.slice(1, -1);
    } catch {
      throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: A local authentication setting could not be parsed.");
    }
  };
  const credentialStore = read("cli_auth_credentials_store");
  const forcedMethod = read("forced_login_method");
  if (forcedMethod !== null && forcedMethod !== "chatgpt" && forcedMethod !== "api") {
    throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: An unsupported local login method is configured.");
  }
  const workspaceId = read("forced_chatgpt_workspace_id");
  if (workspaceId && !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(workspaceId)) {
    throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: The local workspace restriction is invalid.");
  }
  return { credentialStore, forcedMethod, workspaceId };
}

export type CodexEffectiveAuthPolicy = { config: unknown; requirements: unknown };

function effectiveAuthValues(snapshot: CodexEffectiveAuthPolicy) {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const configResponse = record(snapshot.config);
  const requirementsResponse = record(snapshot.requirements);
  if (!("config" in configResponse) || !configResponse.config ||
      typeof configResponse.config !== "object" || Array.isArray(configResponse.config) ||
      !("requirements" in requirementsResponse) ||
      requirementsResponse.requirements !== null &&
        (typeof requirementsResponse.requirements !== "object" ||
          Array.isArray(requirementsResponse.requirements))) {
    throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: Codex returned an unknown effective policy shape.");
  }
  const config = record(configResponse.config);
  const requirements = record(requirementsResponse.requirements);
  const value = (object: Record<string, unknown>, camel: string, snake: string) => object[camel] ?? object[snake];
  return {
    forcedMethod: value(config, "forcedLoginMethod", "forced_login_method"),
    allowedMethods: value(requirements, "allowedLoginMethods", "allowed_login_methods"),
    effectiveStore: value(config, "cliAuthCredentialsStore", "cli_auth_credentials_store"),
    requiredStore: value(requirements, "cliAuthCredentialsStore", "cli_auth_credentials_store"),
    forcedWorkspaces: value(config, "forcedChatgptWorkspaceId", "forced_chatgpt_workspace_id"),
    allowedWorkspaces: value(requirements, "allowedChatgptWorkspaces", "allowed_chatgpt_workspaces")
  };
}

/** Only authentication-relevant effective fields participate in the policy boundary. */
export function effectiveCodexAuthPolicyIdentity(snapshot: CodexEffectiveAuthPolicy): string {
  return JSON.stringify(effectiveAuthValues(snapshot));
}

export function effectiveCodexCredentialStore(snapshot: CodexEffectiveAuthPolicy): unknown {
  const { effectiveStore, requiredStore } = effectiveAuthValues(snapshot);
  if (effectiveStore != null && requiredStore != null && effectiveStore !== requiredStore) {
    throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: Effective and required credential storage disagree.");
  }
  return effectiveStore ?? requiredStore;
}

export function assertEffectiveCodexAuthPolicy(snapshot: CodexEffectiveAuthPolicy,
  mode: "chatgpt" | "api-key" | "unknown", ownerKey: string | null, bridgeProfile: boolean): void {
  const { forcedMethod, allowedMethods, effectiveStore, requiredStore,
    forcedWorkspaces, allowedWorkspaces } = effectiveAuthValues(snapshot);
  effectiveCodexCredentialStore(snapshot);
  const selectedMethod = mode === "api-key" ? "api" : mode;
  if (forcedMethod !== undefined && forcedMethod !== null && forcedMethod !== selectedMethod ||
      allowedMethods !== undefined && allowedMethods !== null &&
        (!Array.isArray(allowedMethods) || !allowedMethods.includes(selectedMethod))) {
    throw new Error("CODEX_AUTH_POLICY_MISMATCH: The selected login method conflicts with effective Codex policy.");
  }
  if (bridgeProfile && [effectiveStore, requiredStore].some(store =>
      store !== undefined && store !== null && store !== "file")) {
    throw new Error("CODEX_AUTH_POLICY_MISMATCH: Managed credential storage overrides the isolated file profile.");
  }
  const workspaceList = (entry: unknown): string[] | null => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry) && entry.every(item => typeof item === "string")) return entry;
    throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: Codex returned an unknown workspace restriction.");
  };
  const restrictions = [workspaceList(forcedWorkspaces), workspaceList(allowedWorkspaces)].filter(
    (entry): entry is string[] => entry !== null);
  if (restrictions.length > 0) {
    if (mode !== "chatgpt" || !ownerKey || restrictions.some(list =>
        !list.some(id => codexChatgptOwnerKey(id) === ownerKey))) {
      throw new Error("CODEX_AUTH_POLICY_MISMATCH: The selected workspace cannot be verified against effective Codex policy.");
    }
  }
}
