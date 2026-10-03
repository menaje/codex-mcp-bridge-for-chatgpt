import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Identity evidence for the fake App Server only, inside disposable fixtures.
 * No real credential or account is read, copied, or sent. */
export function installLocalFixtureAuth(root: string): void {
  const directory = path.join(root, ".codex");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload = Buffer.from(JSON.stringify({ sub: "local-fixture-user",
    "https://api.openai.com/auth": { chatgpt_account_id: "local-fixture-workspace", chatgpt_user_id: "local-fixture-user" } })).toString("base64url");
  writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
    tokens: { account_id: "local-fixture-workspace", id_token: `fixture.${payload}.fixture` } }), { mode: 0o600 });
}
