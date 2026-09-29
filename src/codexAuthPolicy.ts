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
