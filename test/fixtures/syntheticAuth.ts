import { codexChatgptOwnerKey, codexChatgptPrincipalKey, projectCodexAccount } from "../../src/codexAccount.js";

/** Synthetic tokens contain no credential and are only for local identity tests. */
export function syntheticIdToken(userId: string, workspaceId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_user_id: userId, chatgpt_account_id: workspaceId }
  })).toString("base64url");
  return `fixture.${payload}.fixture`;
}

/** Injects a hypothetical verified user observation; no current CLI RPC supplies one. */
export function syntheticVerifiedAccount(accountResponse: unknown, limitsResponse: unknown,
  userId: string, workspaceId: string) {
  const snapshot = projectCodexAccount(accountResponse, limitsResponse);
  if (snapshot.workspaceKey !== codexChatgptOwnerKey(workspaceId)) {
    throw new Error("Synthetic account workspace does not match account/read routing.");
  }
  return { ...snapshot, ownershipKey: codexChatgptPrincipalKey(userId, workspaceId) };
}
