/** Synthetic tokens contain no credential and are only for local identity tests. */
export function syntheticIdToken(userId: string, workspaceId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_user_id: userId, chatgpt_account_id: workspaceId }
  })).toString("base64url");
  return `fixture.${payload}.fixture`;
}
