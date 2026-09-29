import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import { CodexAuthSelectionManager } from "../src/codexAuthSelection.js";
import { codexChatgptOwnerKey } from "../src/codexAccount.js";
import { codexChildEnvironment, codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "auth-selection-test-")); roots.push(root);
  return { root, manager: new CodexAuthSelectionManager(root), environment: {
    CODEX_MCP_BRIDGE_RUNTIME_HOME: root, HOME: root, PATH: process.env.PATH
  } };
}

it("keeps existing users on shared auth until they explicitly stage a different choice", async () => {
  const f = await fixture();
  expect(await f.manager.snapshot(f.environment)).toMatchObject({ revision: 0, applied: { kind: "shared" }, pending: null });
  const prepared = await f.manager.prepare("bridge-chatgpt", 0, f.environment);
  const candidate = prepared.candidate!;
  expect(candidate.status).toBe("prepared");
  expect(await readFile(path.join(f.root, "auth-profiles", candidate.id, "config.toml"), "utf8"))
    .toBe('cli_auth_credentials_store = "file"\n');
  expect(codexChildEnvironment(undefined, f.environment).CODEX_HOME).toBeUndefined();
  await expect(f.manager.prepare("bridge-api", 0, f.environment)).rejects.toThrow("CODEX_AUTH_REVISION_CHANGED");
  await f.manager.cancelCandidate(candidate.id, (await f.manager.snapshot(f.environment)).revision);
  expect((await f.manager.snapshot(f.environment)).candidate).toBeNull();
  // Cancellation does not delete a profile that could contain newly refreshed credentials.
  expect(await readFile(path.join(f.root, "auth-profiles", candidate.id, "config.toml"), "utf8")).toContain("file");
});

it("selects one of several saved bridge profiles without replacing its credential", async () => {
  const f = await fixture();
  const first = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const firstFile = path.join(f.root, "auth-profiles", first.id, "auth.json");
  await writeFile(firstFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "saved-first", id_token: syntheticIdToken("fixture-user", "saved-first") } }));
  await f.manager.cancelCandidate(first.id, 1);
  const second = (await f.manager.prepare("bridge-chatgpt", 2, f.environment)).candidate!;
  await writeFile(path.join(f.root, "auth-profiles", second.id, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "saved-second", id_token: syntheticIdToken("fixture-user", "saved-second") } }));
  await f.manager.cancelCandidate(second.id, 3);
  const selected = await f.manager.selectOwnedProfile(first.id, 4);
  expect(selected.candidate).toMatchObject({ id: first.id, reused: true, status: "prepared" });
  expect(selected.profiles).toHaveLength(2);
  await expect(f.manager.startChatGptLogin(first.id, "/no/such/codex", f.environment))
    .rejects.toThrow("CODEX_AUTH_PROFILE_READ_ONLY");
  expect(await readFile(firstFile, "utf8")).toContain("saved-first");
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const verified = await f.manager.verify(first.id, command, "cli-a", f.environment);
  expect(verified.candidate).toMatchObject({ status: "verified", reused: true });
  const workspaceKey = codexChatgptOwnerKey("saved-first");
  expect(verified.candidate?.workspaceKey).toBe(workspaceKey);
  expect(verified.candidate?.billingTarget).toBe("chatgpt-plan");
  const staged = await f.manager.stage(first.connection, verified.revision, command, "cli-a", f.environment, false);
  expect(staged.pending).toEqual(first.connection);
  expect(staged.pendingWorkspaceKey).toBe(workspaceKey);
  expect(staged.pendingBillingTarget).toBe("chatgpt-plan");
  const activation = await f.manager.beginActivation(command, "cli-a", f.environment);
  await f.manager.completeActivation(activation!, "bridge-chatgpt", "1", path.join(f.root, "auth-profiles", first.id));
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    appliedWorkspaceKey: workspaceKey, appliedBillingTarget: "chatgpt-plan",
    pendingWorkspaceKey: null, pendingBillingTarget: null
  });
});

it("stages a disconnect without changing a running environment and applies it at the next safe launch", async () => {
  const f = await fixture();
  await f.manager.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", f.environment, false);
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, pending: { kind: "disconnected" }, effective: { kind: "shared" }
  });
  const requested = codexChildEnvironment(undefined, f.environment);
  expect(requested.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED).toBeUndefined();
  expect(requested.CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("shared");
  expect(requested.CODEX_MCP_BRIDGE_AUTH_GENERATION).toBe("0");
  const activation = await f.manager.beginActivation("", "", f.environment);
  await f.manager.completeActivation(activation!, "disconnected", "1");
  expect(await f.manager.snapshot(f.environment)).toMatchObject({ applied: { kind: "disconnected" }, pending: null, generation: 1 });
  expect(codexChildEnvironment(undefined, f.environment).CODEX_MCP_BRIDGE_AUTH_DISCONNECTED).toBe("1");
});

it("cancels a pending change without advancing the applied authentication generation", async () => {
  const f = await fixture();
  await f.manager.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", f.environment, false);
  await f.manager.cancelPending(1);
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, pending: null, generation: 0
  });
  expect(codexChildEnvironment(undefined, f.environment).CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("shared");
});

it("rejects a visible shared login policy mismatch before starting a Codex probe", async () => {
  const f = await fixture();
  const home = path.join(f.root, ".codex"); await mkdir(home);
  await writeFile(path.join(home, "config.toml"), 'forced_login_method = "chatgpt"\n');
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "synthetic" }));
  await f.manager.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", f.environment, false);
  const activation = await f.manager.beginActivation("", "", f.environment);
  await f.manager.completeActivation(activation!, "disconnected", "1");
  const current = await f.manager.snapshot(f.environment);
  await expect(f.manager.stage({ kind: "shared" }, current.revision, "/no/such/codex", "fixture-cli",
    { ...f.environment, HOME: f.root }, false)).rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
});

it("carries local login restrictions into a separate profile and rejects policy drift", async () => {
  const f = await fixture();
  const home = path.join(f.root, ".codex"); await mkdir(home);
  await writeFile(path.join(home, "config.toml"),
    'forced_login_method = "chatgpt"\nforced_chatgpt_workspace_id = "11111111-1111-4111-8111-111111111111"\n');
  await expect(f.manager.prepare("bridge-api", 0, f.environment)).rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const profileConfig = path.join(f.root, "auth-profiles", candidate.id, "config.toml");
  expect(await readFile(profileConfig, "utf8")).toContain('forced_chatgpt_workspace_id = "11111111-1111-4111-8111-111111111111"');
  await writeFile(path.join(home, "config.toml"), 'forced_login_method = "api"\n');
  await expect(f.manager.verify(candidate.id, "/no/such/codex", "fixture-cli", f.environment))
    .rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  await writeFile(path.join(home, "config.toml"),
    'forced_login_method = "chatgpt"\nforced_chatgpt_workspace_id = "11111111-1111-4111-8111-111111111111"\n');
  await writeFile(path.join(f.root, "auth-profiles", candidate.id, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "synthetic-policy-account", id_token: syntheticIdToken("fixture-user", "synthetic-policy-account") } }));
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const verified = await f.manager.verify(candidate.id, command, "fixture-cli", f.environment);
  await f.manager.stage(candidate.connection, verified.revision, command, "fixture-cli", f.environment, false);
  await writeFile(path.join(home, "config.toml"), 'forced_login_method = "api"\n');
  await expect(f.manager.assertPendingLocalPolicy(f.environment)).rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
});

it("checks effective managed login, store, and workspace restrictions for a candidate", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const home = path.join(f.root, "auth-profiles", candidate.id);
  const workspace = "11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: workspace, id_token: syntheticIdToken("fixture-user", workspace) } }));
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const restricted = (requirements: object) => ({ ...f.environment,
    CODEX_TEST_AUTH_REQUIREMENTS: JSON.stringify(requirements) });
  await expect(f.manager.verify(candidate.id, command, "cli", restricted({ allowedLoginMethods: ["api"] })))
    .rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  await expect(f.manager.verify(candidate.id, command, "cli", restricted({ cliAuthCredentialsStore: "keyring" })))
    .rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  await expect(f.manager.verify(candidate.id, command, "cli", restricted({ allowedChatgptWorkspaces: [
    "22222222-2222-4222-8222-222222222222"] })))
    .rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  const verified = await f.manager.verify(candidate.id, command, "cli",
    restricted({ allowedChatgptWorkspaces: [workspace], cliAuthCredentialsStore: "file" }));
  expect(verified.candidate?.status).toBe("verified");
  expect(verified.candidate?.accountKey).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects a candidate when the selected CLI routes to a different workspace from its profile", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  await writeFile(path.join(f.root, "auth-profiles", candidate.id, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "workspace-a",
      id_token: syntheticIdToken("fixture-user", "workspace-a") } }));
  await expect(f.manager.verify(candidate.id, path.resolve("test/fixtures/fake-codex-app-server.mjs"),
    "cli", { ...f.environment, CODEX_TEST_ACCOUNT_ID: "workspace-b" }))
    .rejects.toThrow("CODEX_AUTH_CANDIDATE_UNVERIFIED");
});

it("ignores a stale shared auth file when effective managed storage selects a different keyring account", async () => {
  const f = await fixture();
  const home = path.join(f.root, ".codex"); await mkdir(home);
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
    tokens: { account_id: "stale-file-a", id_token: syntheticIdToken("fixture-user", "stale-file-a") } }));
  await writeFile(path.join(f.root, "auth-selection.json"), JSON.stringify({
    schemaVersion: 1, revision: 0, applied: { kind: "disconnected" }, pending: null, candidate: null
  }));
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const environment = { ...f.environment,
    CODEX_TEST_AUTH_CONFIG: JSON.stringify({ cliAuthCredentialsStore: "keyring" }),
    CODEX_TEST_ACCOUNT_ID: "live-keyring-b" };
  await expect(f.manager.stage({ kind: "shared" }, 0, command, "fixture-cli", environment, false))
    .rejects.toThrow("CODEX_AUTH_IDENTITY_UNAVAILABLE");
  const state = JSON.parse(await readFile(path.join(f.root, "auth-selection.json"), "utf8"));
  expect(state.pending).toBeNull();
  expect(await readFile(path.join(home, "auth.json"), "utf8")).toContain("stale-file-a");
});

it("keeps explicit CODEX_HOME authoritative and never forwards ambient API keys to a bridge profile", async () => {
  const f = await fixture();
  const profileId = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
  await writeFile(path.join(f.root, "auth-selection.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, applied: { kind: "bridge-chatgpt", profileId }, pending: null, candidate: null
  }));
  const selected = codexChildEnvironment(undefined, f.environment);
  expect(selected.CODEX_HOME).toBe(path.join(f.root, "auth-profiles", profileId));
  expect(selected.CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("bridge-chatgpt");
  expect(codexProcessEnvironment({ ...selected, OPENAI_API_KEY: "ambient-secret", CODEX_API_KEY: "ambient-secret" }))
    .not.toHaveProperty("OPENAI_API_KEY");
  const explicit = codexChildEnvironment(undefined, { ...f.environment, CODEX_HOME: path.join(f.root, "existing") });
  expect(explicit.CODEX_HOME).toBe(path.join(f.root, "existing"));
  expect(explicit.CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("shared");
  expect(explicit.CODEX_MCP_BRIDGE_AUTH_GENERATION).toBe("0");
});

it("refuses malformed saved auth choices instead of silently falling back to another account", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "auth-profiles"));
  await writeFile(path.join(f.root, "auth-selection.json"), '{"schemaVersion":1,"applied":{"kind":"bridge-api","profileId":"../other"},"pending":null}');
  expect(() => codexChildEnvironment(undefined, f.environment)).toThrow("CODEX_AUTH_SELECTION_INVALID");
  expect(codexChildEnvironment(undefined, { ...f.environment, CODEX_HOME: path.join(f.root, "explicit") }))
    .toMatchObject({ CODEX_MCP_BRIDGE_AUTH_SOURCE: "shared" });
  expect(codexProcessEnvironment({ ...f.environment, CODEX_HOME: path.join(f.root, "explicit") }))
    .toMatchObject({ CODEX_MCP_BRIDGE_AUTH_SOURCE: "shared" });
});

it("passes a synthetic API key through stdin without storing it in selection state or process arguments", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-api", 0, f.environment)).candidate!;
  const command = path.join(f.root, "fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(path.join(process.env.CODEX_HOME, "api-login-observation.json"),
    JSON.stringify({ args: process.argv.slice(2), input }));
});
`, { mode: 0o700 });
  await f.manager.setApiKey(candidate.id, command,
    { ...f.environment, HOME: f.root, PATH: process.env.PATH }, "sk-synthetic-fixture");
  const home = path.join(f.root, "auth-profiles", candidate.id);
  expect(JSON.parse(await readFile(path.join(home, "api-login-observation.json"), "utf8")))
    .toEqual({ args: ["login", "--with-api-key"], input: "sk-synthetic-fixture\n" });
  expect(await readFile(path.join(f.root, "auth-selection.json"), "utf8")).not.toContain("sk-synthetic-fixture");
  expect((await f.manager.snapshot(f.environment)).candidate?.status).toBe("login-completed");
  await expect(f.manager.setApiKey(candidate.id, command, f.environment, "sk-second-synthetic-key"))
    .rejects.toThrow("CODEX_AUTH_LOGIN_ALREADY_ATTEMPTED");
});

it.each([[0, "login-completed"], [1, "login-failed"]] as const)(
  "records a browser-login process exit %i as %s until candidate verification", async (exitCode, status) => {
    const f = await fixture();
    const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
    const command = path.join(f.root, `fake-login-${exitCode}.mjs`);
    await writeFile(command, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`, { mode: 0o700 });
    await f.manager.startChatGptLogin(candidate.id, command, f.environment);
    await vi.waitFor(async () => expect((await f.manager.snapshot(f.environment)).candidate?.status).toBe(status),
      { timeout: 5_000 });
    if (exitCode === 0) {
      await expect(f.manager.startChatGptLogin(candidate.id, command, f.environment))
        .rejects.toThrow("CODEX_AUTH_LOGIN_ALREADY_ATTEMPTED");
    }
  }
);

it("records a failed login launch and API key check without changing the applied authentication", async () => {
  const f = await fixture();
  const chat = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  await expect(f.manager.startChatGptLogin(chat.id, path.join(f.root, "missing-codex"), f.environment))
    .rejects.toThrow("CODEX_AUTH_LOGIN_START_FAILED");
  expect((await f.manager.snapshot(f.environment)).candidate?.status).toBe("login-failed");
  const revision = (await f.manager.snapshot(f.environment)).revision;
  await f.manager.cancelCandidate(chat.id, revision);
  const api = (await f.manager.prepare("bridge-api", revision + 1, f.environment)).candidate!;
  const command = path.join(f.root, "reject-key.mjs");
  await writeFile(command, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(1));\n", { mode: 0o700 });
  await expect(f.manager.setApiKey(api.id, command, f.environment, "sk-synthetic-rejected"))
    .rejects.toThrow("CODEX_AUTH_API_LOGIN_FAILED");
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, candidate: { status: "login-failed" }
  });
});

it("reports an interrupted helper's unresolved browser login without claiming completion", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const stateFile = path.join(f.root, "auth-selection.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.candidate.status = "login-started";
  await writeFile(stateFile, JSON.stringify(state));
  expect((await f.manager.snapshot(f.environment)).candidate?.status).toBe("login-unconfirmed");
  expect((await f.manager.snapshot(f.environment)).candidate?.id).toBe(candidate.id);
});

it("rejects a verification result that arrives after the same candidate starts another login", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  await writeFile(path.join(f.root, "auth-profiles", candidate.id, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "synthetic-account", id_token: syntheticIdToken("fixture-user", "synthetic-account") } }));
  let entered!: () => void;
  let release!: () => void;
  const probeEntered = new Promise<void>(resolve => { entered = resolve; });
  const probeRelease = new Promise<void>(resolve => { release = resolve; });
  const original = CodexAppServerUpstreamPool.prototype.listModels;
  const spy = vi.spyOn(CodexAppServerUpstreamPool.prototype, "listModels")
    .mockImplementation(async function (this: CodexAppServerUpstreamPool) {
      entered();
      await probeRelease;
      return original.call(this);
    });
  try {
    const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
    const verification = f.manager.verify(candidate.id, command, "fixture-cli", f.environment);
    await probeEntered;
    const loginCommand = path.join(f.root, "new-login.mjs");
    await writeFile(loginCommand, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    await f.manager.startChatGptLogin(candidate.id, loginCommand, f.environment);
    release();
    await expect(verification).rejects.toThrow("CODEX_AUTH_REVISION_CHANGED");
    expect((await f.manager.snapshot(f.environment)).candidate?.status).not.toBe("verified");
  } finally {
    release();
    spy.mockRestore();
  }
});

it("cancels an in-flight candidate key login without changing the applied connection", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-api", 0, f.environment)).candidate!;
  const command = path.join(f.root, "slow-fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(path.join(process.env.CODEX_HOME, "started"), "started");
process.stdin.resume();
setTimeout(() => {}, 10000);
`, { mode: 0o700 });
  const run = f.manager.setApiKey(candidate.id, command,
    { ...f.environment, HOME: f.root, PATH: process.env.PATH }, "sk-synthetic-fixture");
  await vi.waitFor(async () => expect(await readFile(path.join(f.root, "auth-profiles", candidate.id, "started"), "utf8"))
    .toBe("started"));
  await f.manager.cancelCandidate(candidate.id, (await f.manager.snapshot(f.environment)).revision);
  await expect(run).rejects.toThrow("CODEX_AUTH_API_LOGIN_FAILED");
  expect(await f.manager.snapshot(f.environment)).toMatchObject({ applied: { kind: "shared" }, candidate: null });
});

it("rejects a candidate that changed account or CLI after verification, even when display email is unchanged", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const home = path.join(f.root, "auth-profiles", candidate.id);
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const environment = { ...f.environment, PATH: process.env.PATH };
  const writeAccount = (accountId: string) => writeFile(path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: accountId, id_token: syntheticIdToken("fixture-user", accountId) } }));
  await writeAccount("synthetic-account-a");
  const verified = await f.manager.verify(candidate.id, command, "cli-fingerprint-a", environment);
  expect(verified.candidate?.status).toBe("verified");
  expect(verified.candidate?.accountEmail).toBe("private-fixture@example.com");
  await writeAccount("synthetic-account-b");
  await expect(f.manager.stage(candidate.connection, verified.revision, command,
    "cli-fingerprint-a", environment, false)).rejects.toThrow("CODEX_AUTH_CANDIDATE_UNVERIFIED");
  await writeAccount("synthetic-account-a");
  await expect(f.manager.stage(candidate.connection, verified.revision, command,
    "cli-fingerprint-b", environment, false)).rejects.toThrow("CODEX_AUTH_CANDIDATE_UNVERIFIED");
  const staged = await f.manager.stage(candidate.connection, verified.revision, command,
    "cli-fingerprint-a", environment, false);
  expect(staged.pending).toEqual(candidate.connection);
  await expect(f.manager.startChatGptLogin(candidate.id, command, environment))
    .rejects.toThrow("CODEX_AUTH_CANDIDATE_STAGED");
  await expect(f.manager.verify(candidate.id, command, "cli-fingerprint-a", environment))
    .rejects.toThrow("CODEX_AUTH_CANDIDATE_STAGED");
  await expect(f.manager.cancelCandidate(candidate.id, staged.revision))
    .rejects.toThrow("CODEX_AUTH_CANDIDATE_STAGED");
  await expect(f.manager.prepare("bridge-api", staged.revision, environment))
    .rejects.toThrow("CODEX_AUTH_PENDING_CHANGE");
  await expect(f.manager.stage({ kind: "disconnected" }, staged.revision, command,
    "cli-fingerprint-a", environment, false)).rejects.toThrow("CODEX_AUTH_PENDING_CHANGE");
});

it("revalidates a staged candidate at activation and preserves the pending choice after drift", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const home = path.join(f.root, "auth-profiles", candidate.id);
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const credential = (id: string) => writeFile(path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: id, id_token: syntheticIdToken("fixture-user", id) } }));
  await credential("account-a");
  const verified = await f.manager.verify(candidate.id, command, "cli-a", f.environment);
  await f.manager.stage(candidate.connection, verified.revision, command, "cli-a", f.environment, false);
  await expect(f.manager.beginActivation(command, "cli-b", f.environment)).rejects.toThrow("CODEX_AUTH_REVALIDATION_REQUIRED");
  await credential("account-b");
  await expect(f.manager.beginActivation(command, "cli-a", f.environment)).rejects.toThrow("CODEX_AUTH_CANDIDATE_CHANGED");
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, pending: candidate.connection, activation: null
  });
});

it("uses a launch-specific activation and separates a proven no-start from an uncertain result", async () => {
  const f = await fixture();
  await f.manager.stage({ kind: "disconnected" }, 0, "/fixture/codex", "cli-a", f.environment, false);
  const first = await f.manager.beginActivation("", "", f.environment);
  expect(first).toBeTruthy();
  expect(codexChildEnvironment(undefined, f.environment).CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("shared");
  expect(codexChildEnvironment(undefined, { ...f.environment, CODEX_MCP_BRIDGE_AUTH_ACTIVATION_ID: first! }))
    .toMatchObject({ CODEX_MCP_BRIDGE_AUTH_SOURCE: "disconnected", CODEX_MCP_BRIDGE_AUTH_GENERATION: "1" });
  await f.manager.failActivation(first!, true);
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, pending: { kind: "disconnected" }, activation: null, generation: 0
  });
  const second = await f.manager.beginActivation("", "", f.environment);
  await f.manager.failActivation(second!, false);
  expect((await f.manager.snapshot(f.environment)).activation?.status).toBe("uncertain");
  expect(() => codexChildEnvironment(undefined, f.environment)).toThrow("CODEX_AUTH_ACTIVATION_UNCERTAIN");
  await expect(f.manager.beginActivation("", "", f.environment)).rejects.toThrow("CODEX_AUTH_ACTIVATION_UNCERTAIN");
  await expect(f.manager.resolveStoppedActivation(second!, 2)).rejects.toThrow("CODEX_AUTH_REVISION_CHANGED");
  await f.manager.completeActivation(second!, "disconnected", "1");
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "disconnected" }, pending: null, activation: null, generation: 1
  });
});

it("records a stopped unconfirmed launch without pretending that it never ran", async () => {
  const f = await fixture();
  await f.manager.stage({ kind: "disconnected" }, 0, "/fixture/codex", "cli-a", f.environment, false);
  const activation = await f.manager.beginActivation("", "", f.environment);
  await f.manager.failActivation(activation!, false);
  const uncertain = await f.manager.snapshot(f.environment);
  await expect(f.manager.resolveStoppedActivation(randomUUID(), uncertain.revision))
    .rejects.toThrow("CODEX_AUTH_ACTIVATION_CHANGED");
  await f.manager.resolveStoppedActivation(activation!, uncertain.revision);
  expect(await f.manager.snapshot(f.environment)).toMatchObject({
    applied: { kind: "shared" }, pending: { kind: "disconnected" },
    generation: 0, activation: null,
    lastActivationResolution: { id: activation, outcome: "stopped-unconfirmed" }
  });
  expect(codexChildEnvironment(undefined, f.environment).CODEX_MCP_BRIDGE_AUTH_SOURCE).toBe("shared");
});

it("commits an owned profile only when the ready runtime reports its exact home", async () => {
  const f = await fixture();
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const home = path.join(f.root, "auth-profiles", candidate.id);
  await writeFile(path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "profile-owner", id_token: syntheticIdToken("fixture-user", "profile-owner") } }));
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  const verified = await f.manager.verify(candidate.id, command, "cli-a", f.environment);
  await f.manager.stage(candidate.connection, verified.revision, command, "cli-a", f.environment, false);
  const activation = await f.manager.beginActivation(command, "cli-a", f.environment);
  await expect(f.manager.completeActivation(activation!, "bridge-chatgpt", "1", path.join(f.root, "wrong-home")))
    .rejects.toThrow("CODEX_AUTH_ACTIVATION_UNCONFIRMED");
  expect((await f.manager.snapshot(f.environment)).applied.kind).toBe("shared");
  await f.manager.completeActivation(activation!, "bridge-chatgpt", "1", home);
  expect((await f.manager.snapshot(f.environment)).applied).toEqual(candidate.connection);
});

it("removes only an inactive bridge API credential without touching shared authentication", async () => {
  const f = await fixture();
  const shared = path.join(f.root, ".codex"); await mkdir(shared);
  const sharedFile = path.join(shared, "auth.json");
  await writeFile(sharedFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "shared", id_token: syntheticIdToken("fixture-user", "shared") } }));
  const candidate = (await f.manager.prepare("bridge-api", 0, f.environment)).candidate!;
  const file = path.join(f.root, "auth-profiles", candidate.id, "auth.json");
  await writeFile(file, JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-synthetic-profile" }));
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  await expect(f.manager.removeApiKey(candidate.id, 1, command, f.environment))
    .rejects.toThrow("CODEX_AUTH_PROFILE_IN_USE");
  await f.manager.cancelCandidate(candidate.id, 1);
  await expect(f.manager.removeApiKey(candidate.id, 2, command, {
    ...f.environment, CODEX_TEST_AUTH_REQUIREMENTS: JSON.stringify({ cliAuthCredentialsStore: "keyring" })
  })).rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  await f.manager.removeApiKey(candidate.id, 2, command, f.environment);
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sharedFile, "utf8")).toContain("shared");
  expect((await f.manager.snapshot(f.environment)).profiles).toContainEqual({
    id: candidate.id, kind: "bridge-api", status: "removed"
  });
});

it("logs out only an inactive bridge ChatGPT profile and records an uncertain reply", async () => {
  const f = await fixture();
  const shared = path.join(f.root, ".codex"); await mkdir(shared);
  const sharedFile = path.join(shared, "auth.json");
  await writeFile(sharedFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "shared", id_token: syntheticIdToken("fixture-user", "shared") } }));
  const candidate = (await f.manager.prepare("bridge-chatgpt", 0, f.environment)).candidate!;
  const file = path.join(f.root, "auth-profiles", candidate.id, "auth.json");
  await writeFile(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "owned", id_token: syntheticIdToken("fixture-user", "owned") } }));
  await f.manager.cancelCandidate(candidate.id, 1);
  const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
  await expect(f.manager.logoutOwnedChatGpt(candidate.id, 2, command, {
    ...f.environment, CODEX_TEST_AUTH_REQUIREMENTS: JSON.stringify({ cliAuthCredentialsStore: "keyring" })
  })).rejects.toThrow("CODEX_AUTH_POLICY_MISMATCH");
  expect(await readFile(file, "utf8")).toContain("owned");
  await expect(f.manager.logoutOwnedChatGpt(candidate.id, 2, command, {
    ...f.environment, CODEX_TEST_AUTH_LOGOUT_LOST_RESPONSE: "1"
  })).rejects.toThrow("CODEX_AUTH_LOGOUT_UNCONFIRMED");
  expect((await f.manager.snapshot(f.environment)).profiles).toContainEqual({
    id: candidate.id, kind: "bridge-chatgpt", status: "logout-unconfirmed"
  });
  await expect(f.manager.logoutOwnedChatGpt(candidate.id, 3, command, f.environment))
    .rejects.toThrow("CODEX_AUTH_PROFILE_UNAVAILABLE");
  expect(await readFile(sharedFile, "utf8")).toContain("shared");
  const second = (await f.manager.prepare("bridge-chatgpt", 3, f.environment)).candidate!;
  const secondFile = path.join(f.root, "auth-profiles", second.id, "auth.json");
  await writeFile(secondFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "owned-two", id_token: syntheticIdToken("fixture-user", "owned-two") } }));
  await f.manager.cancelCandidate(second.id, 4);
  await f.manager.logoutOwnedChatGpt(second.id, 5, command, f.environment);
  await expect(readFile(secondFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sharedFile, "utf8")).toContain("shared");
});
