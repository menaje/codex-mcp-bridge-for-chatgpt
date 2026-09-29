import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CodexAppServerUpstreamPool } from "./appServerUpstream.js";
import { codexCredentialIdentity } from "./codexService.js";
import { atomicRuntimeJson, withRuntimeLock } from "./codexRuntime.js";
import { parseJsonUtf8Strict } from "./textIntegrity.js";
import { authProfileHome } from "../scripts/auth-selection.mjs";

const connectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shared") }),
  z.strictObject({ kind: z.literal("disconnected") }),
  z.strictObject({ kind: z.literal("bridge-chatgpt"), profileId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("bridge-api"), profileId: z.string().uuid() })
]);
export type AuthConnection = z.infer<typeof connectionSchema>;
const candidateSchema = z.strictObject({
  id: z.string().uuid(),
  connection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("bridge-chatgpt"), profileId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("bridge-api"), profileId: z.string().uuid() })
  ]),
  status: z.enum(["prepared", "login-started", "verified"]),
  accountKey: z.string().nullable(),
  credentialKey: z.string().nullable(),
  verifiedCli: z.string().nullable(),
  verifiedCliFingerprint: z.string().nullable(),
  verifiedAt: z.string().nullable()
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative().default(0),
  applied: connectionSchema,
  pending: connectionSchema.nullable(),
  candidate: candidateSchema.nullable()
});
export type AuthSelectionSnapshot = z.infer<typeof stateSchema> & {
  overrideActive: boolean;
  effective: AuthConnection;
};
type AuthSelectionState = z.infer<typeof stateSchema>;
const initialState = (): AuthSelectionState => ({ schemaVersion: 1, revision: 0, generation: 0,
  applied: { kind: "shared" }, pending: null, candidate: null });
const candidateLoginProcesses = new Map<string, ChildProcess>();
type LocalAuthPolicy = { forcedMethod: "chatgpt" | "api" | null; workspaceId: string | null };

/** Stores only choices and opaque account correlations; Codex owns credentials. */
export class CodexAuthSelectionManager {
  private readonly file: string;
  constructor(readonly root: string) { this.file = path.join(root, "auth-selection.json"); }

  async snapshot(environment: NodeJS.ProcessEnv): Promise<AuthSelectionSnapshot> {
    const state = await this.readState();
    const overrideActive = Boolean(environment.CODEX_HOME);
    return { ...state, overrideActive,
      effective: overrideActive ? { kind: "shared" } : state.applied };
  }

  async prepare(kind: "bridge-chatgpt" | "bridge-api", expectedRevision: number,
    environment: NodeJS.ProcessEnv = {}): Promise<AuthSelectionSnapshot> {
    const policy = await this.readLocalPolicy(environment);
    this.assertAllowedByPolicy(kind, policy);
    await this.update(expectedRevision, async state => {
      if (state.candidate) throw new Error("CODEX_AUTH_CANDIDATE_PENDING: Cancel the existing candidate before preparing another.");
      const id = randomUUID();
      const home = authProfileHome(this.root, id);
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(path.join(home, "config.toml"), this.profileConfig(policy), { mode: 0o600, flag: "wx" });
      state.candidate = { id, connection: { kind, profileId: id }, status: "prepared",
        accountKey: null, credentialKey: null, verifiedCli: null,
        verifiedCliFingerprint: null, verifiedAt: null };
      state.revision++;
    });
    return this.snapshot({});
  }

  async startChatGptLogin(candidateId: string, command: string, environment: NodeJS.ProcessEnv): Promise<void> {
    await this.update(undefined, async state => {
      if (state.candidate?.id !== candidateId || state.candidate.connection.kind !== "bridge-chatgpt") {
        throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      }
      if (candidateLoginProcesses.has(candidateId)) throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS");
      const child = spawn(command, ["login"], {
        env: this.profileEnvironment(environment, state.candidate.connection.profileId),
        cwd: environment.HOME || process.cwd(), detached: true, stdio: "ignore"
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { child.unref(); resolve(); });
        child.once("error", () => reject(new Error("CODEX_AUTH_LOGIN_START_FAILED: The selected Codex login could not start.")));
      });
      candidateLoginProcesses.set(candidateId, child);
      child.once("exit", () => {
        if (candidateLoginProcesses.get(candidateId) === child) candidateLoginProcesses.delete(candidateId);
      });
      state.candidate.status = "login-started";
      this.clearVerification(state.candidate);
      state.revision++;
    });
  }

  async setApiKey(candidateId: string, command: string, environment: NodeJS.ProcessEnv, apiKey: string): Promise<void> {
    if (!apiKey.trim() || apiKey.length > 32768 || apiKey.includes("\n")) {
      throw new Error("CODEX_AUTH_API_KEY_INVALID: Enter a valid API key.");
    }
    let completion: Promise<boolean> | undefined;
    await this.update(undefined, state => {
      if (state.candidate?.id !== candidateId || state.candidate.connection.kind !== "bridge-api") {
        throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      }
      if (candidateLoginProcesses.has(candidateId)) throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS");
      const child = spawn(command, ["login", "--with-api-key"], {
        env: this.profileEnvironment(environment, state.candidate.connection.profileId),
        cwd: environment.HOME || process.cwd(), stdio: ["pipe", "ignore", "ignore"]
      });
      candidateLoginProcesses.set(candidateId, child);
      completion = new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => { child.kill(); resolve(false); }, 30_000);
        child.once("error", () => { clearTimeout(timeout); resolve(false); });
        child.once("exit", code => { clearTimeout(timeout); resolve(code === 0); });
        child.stdin.on("error", () => { /* A failed child has its own sanitized result. */ });
      }).finally(() => {
        if (candidateLoginProcesses.get(candidateId) === child) candidateLoginProcesses.delete(candidateId);
      });
      child.stdin.end(`${apiKey}\n`);
    });
    const succeeded = await completion!;
    if (!succeeded) throw new Error("CODEX_AUTH_API_LOGIN_FAILED: Codex did not accept the API key in the candidate profile.");
    await this.update(undefined, state => {
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      state.candidate.status = "login-started";
      this.clearVerification(state.candidate);
      state.revision++;
    });
  }

  async verify(candidateId: string, command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv): Promise<AuthSelectionSnapshot> {
    const candidate = await this.requireCandidate(candidateId);
    const observed = await this.probeCandidate(candidate, command, environment);
    await this.update(undefined, state => {
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      state.candidate.status = "verified";
      state.candidate.accountKey = observed.accountKey;
      state.candidate.credentialKey = observed.credentialKey;
      state.candidate.verifiedCli = command;
      state.candidate.verifiedCliFingerprint = cliFingerprint;
      state.candidate.verifiedAt = new Date().toISOString();
      state.revision++;
    });
    return this.snapshot(environment);
  }

  private async probeCandidate(candidate: NonNullable<AuthSelectionState["candidate"]>, command: string,
    environment: NodeJS.ProcessEnv): Promise<{ accountKey: string | null; credentialKey: string }> {
    await this.assertProfilePolicy(candidate.connection, environment);
    const profileEnvironment = this.profileEnvironment(environment, candidate.connection.profileId);
    const pool = new CodexAppServerUpstreamPool(command, 1, {
      environment: profileEnvironment
    });
    try {
      const account = await pool.readAccountSnapshot();
      const expected = candidate.connection.kind === "bridge-api" ? "api-key" : "chatgpt";
      if (!account?.authenticated || account.authMode !== expected) {
        throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: The candidate is not signed in with the selected method.");
      }
      const models = await pool.listModels() as { data?: unknown[] };
      if (!Array.isArray(models.data) || models.data.length === 0) {
        throw new Error("CODEX_AUTH_MODELS_UNAVAILABLE: The candidate model catalog could not be verified.");
      }
      const credentialKey = codexCredentialIdentity(profileEnvironment.CODEX_HOME!, profileEnvironment);
      if (!credentialKey) {
        throw new Error("CODEX_AUTH_IDENTITY_UNAVAILABLE: The candidate's file-backed identity could not be confirmed.");
      }
      return { accountKey: account.accountKey, credentialKey };
    } finally { await pool.close(); }
  }

  async stage(connection: AuthConnection, expectedRevision: number, command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv, billingConfirmed: boolean): Promise<AuthSelectionSnapshot> {
    if (environment.CODEX_HOME) throw new Error("CODEX_AUTH_OVERRIDE_ACTIVE: The explicit CODEX_HOME controls this runtime.");
    const before = await this.readState();
    if (before.revision !== expectedRevision) {
      throw new Error("CODEX_AUTH_REVISION_CHANGED: Refresh the authentication settings before applying a change.");
    }
    if (!before.pending && JSON.stringify(before.applied) === JSON.stringify(connection)) return this.snapshot(environment);
    if (connection.kind === "shared") {
      // Verify the selected CLI's existing source before accepting it as the
      // new default. This is an account and model probe, never a login.
      await this.assertSharedLocalPolicy(environment);
      const pool = new CodexAppServerUpstreamPool(command, 1, { environment });
      try {
        const account = await pool.readAccountSnapshot();
        if (!account?.authenticated) throw new Error("CODEX_AUTH_SHARED_UNAVAILABLE: The existing Codex login is not verified.");
        if (account.authMode === "api-key" && !billingConfirmed) throw new Error("CODEX_AUTH_API_BILLING_CONFIRMATION_REQUIRED");
        const models = await pool.listModels() as { data?: unknown[] };
        if (!Array.isArray(models.data) || models.data.length === 0) throw new Error("CODEX_AUTH_MODELS_UNAVAILABLE");
      } finally { await pool.close(); }
    } else if (connection.kind === "bridge-api" && !billingConfirmed) {
      throw new Error("CODEX_AUTH_API_BILLING_CONFIRMATION_REQUIRED");
    }
    let observed: { accountKey: string | null; credentialKey: string } | null = null;
    if (connection.kind === "bridge-chatgpt" || connection.kind === "bridge-api") {
      const candidate = await this.requireCandidate(connection.profileId, connection.kind);
      observed = await this.probeCandidate(candidate, command, environment);
    }
    await this.update(expectedRevision, state => {
      if (connection.kind === "bridge-chatgpt" || connection.kind === "bridge-api") {
        const candidate = state.candidate;
        if (candidate?.status !== "verified" || candidate.connection.kind !== connection.kind ||
            candidate.connection.profileId !== connection.profileId || candidate.verifiedCli !== command ||
            candidate.verifiedCliFingerprint !== cliFingerprint ||
            candidate.credentialKey !== observed?.credentialKey || candidate.accountKey !== observed?.accountKey) {
          throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: Verify the selected account and model catalog again.");
        }
      }
      state.pending = connection;
      state.revision++;
    });
    return this.snapshot(environment);
  }

  async cancelCandidate(candidateId: string, expectedRevision: number): Promise<void> {
    await this.update(expectedRevision, state => {
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      state.candidate = null;
      state.revision++;
      // Candidate credentials are retained; no token rollback or logout.
    });
    const login = candidateLoginProcesses.get(candidateId);
    candidateLoginProcesses.delete(candidateId);
    if (login?.pid && login.exitCode === null) login.kill("SIGTERM");
  }

  async cancelPending(expectedRevision: number): Promise<void> {
    await this.update(expectedRevision, state => {
      if (!state.pending) return;
      state.pending = null;
      state.revision++;
      // A prepared candidate may still hold independently refreshed credentials.
    });
  }

  async applyPending(): Promise<void> {
    await this.update(undefined, state => {
      if (!state.pending) return;
      state.applied = state.pending;
      state.pending = null;
      state.candidate = null;
      state.generation++;
      state.revision++;
    });
  }

  async assertPendingLocalPolicy(environment: NodeJS.ProcessEnv): Promise<void> {
    const pending = (await this.readState()).pending;
    if (pending?.kind === "bridge-chatgpt" || pending?.kind === "bridge-api") {
      await this.assertProfilePolicy(pending, environment);
    } else if (pending?.kind === "shared") {
      await this.assertSharedLocalPolicy(environment);
    }
  }

  private profileEnvironment(environment: NodeJS.ProcessEnv, profileId: string): NodeJS.ProcessEnv {
    return { ...environment, CODEX_HOME: authProfileHome(this.root, profileId),
      OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_MCP_BRIDGE_AUTH_DISCONNECTED: undefined };
  }

  private clearVerification(candidate: NonNullable<AuthSelectionState["candidate"]>): void {
    candidate.accountKey = null;
    candidate.credentialKey = null;
    candidate.verifiedCli = null;
    candidate.verifiedCliFingerprint = null;
    candidate.verifiedAt = null;
  }

  private async assertSharedLocalPolicy(environment: NodeJS.ProcessEnv): Promise<void> {
    const home = environment.CODEX_HOME || path.join(environment.HOME || homedir(), ".codex");
    let config: string;
    let auth: { auth_mode?: unknown };
    try {
      config = await readFile(path.join(home, "config.toml"), "utf8");
      auth = parseJsonUtf8Strict(await readFile(path.join(home, "auth.json")), "Codex authentication state");
    } catch { return; } // A missing/unreadable store is reported by Codex's account probe.
    const policy = this.parseLocalPolicy(config);
    const forcedMethod = policy.forcedMethod;
    if (forcedMethod === "chatgpt" && auth.auth_mode !== "chatgpt" ||
        forcedMethod === "api" && auth.auth_mode !== "apiKey" ||
        policy.workspaceId && auth.auth_mode !== "chatgpt") {
      throw new Error("CODEX_AUTH_POLICY_MISMATCH: The local forced login method conflicts with the existing credential. Review Codex policy before starting another authentication probe.");
    }
  }

  private async assertProfilePolicy(connection: Extract<AuthConnection, { profileId: string }>,
    environment: NodeJS.ProcessEnv): Promise<void> {
    const policy = await this.readLocalPolicy(environment);
    this.assertAllowedByPolicy(connection.kind, policy);
    let saved: string;
    try { saved = await readFile(path.join(authProfileHome(this.root, connection.profileId), "config.toml"), "utf8"); }
    catch { throw new Error("CODEX_AUTH_POLICY_MISMATCH: The candidate profile configuration is unavailable."); }
    if (saved !== this.profileConfig(policy)) {
      throw new Error("CODEX_AUTH_POLICY_MISMATCH: The candidate profile no longer has the current local login restrictions.");
    }
  }

  private async readLocalPolicy(environment: NodeJS.ProcessEnv): Promise<LocalAuthPolicy> {
    const home = environment.CODEX_HOME || path.join(environment.HOME || homedir(), ".codex");
    try { return this.parseLocalPolicy(await readFile(path.join(home, "config.toml"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { forcedMethod: null, workspaceId: null };
      throw error;
    }
  }

  private parseLocalPolicy(config: string): LocalAuthPolicy {
    const topLevel = config.split(/^\s*\[/m, 1)[0];
    const read = (name: string): string | null => {
      const entries = [...topLevel.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "gm"))];
      if (entries.length === 0) return null;
      if (entries.length !== 1) throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: Duplicate local login restrictions.");
      const value = entries[0]![1]!.match(/^["']([^"']+)["']\s*(?:#.*)?$/)?.[1];
      if (!value) throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: A local login restriction could not be parsed.");
      return value;
    };
    const forcedMethod = read("forced_login_method");
    if (forcedMethod !== null && forcedMethod !== "chatgpt" && forcedMethod !== "api") {
      throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: An unsupported local login method is configured.");
    }
    const workspaceId = read("forced_chatgpt_workspace_id");
    if (workspaceId && !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(workspaceId)) {
      throw new Error("CODEX_AUTH_POLICY_UNVERIFIED: The local workspace restriction is invalid.");
    }
    return { forcedMethod, workspaceId };
  }

  private assertAllowedByPolicy(kind: "bridge-chatgpt" | "bridge-api", policy: LocalAuthPolicy): void {
    if (kind === "bridge-api" && (policy.forcedMethod === "chatgpt" || policy.workspaceId) ||
        kind === "bridge-chatgpt" && policy.forcedMethod === "api") {
      throw new Error("CODEX_AUTH_POLICY_MISMATCH: The requested bridge login conflicts with local Codex restrictions.");
    }
  }

  private profileConfig(policy: LocalAuthPolicy): string {
    return 'cli_auth_credentials_store = "file"\n' +
      (policy.forcedMethod ? `forced_login_method = ${JSON.stringify(policy.forcedMethod)}\n` : "") +
      (policy.workspaceId ? `forced_chatgpt_workspace_id = ${JSON.stringify(policy.workspaceId)}\n` : "");
  }

  private async requireCandidate(candidateId: string,
    kind?: "bridge-chatgpt" | "bridge-api"): Promise<NonNullable<AuthSelectionState["candidate"]>> {
    const candidate = (await this.readState()).candidate;
    if (!candidate || candidate.id !== candidateId || kind && candidate.connection.kind !== kind) {
      throw new Error("CODEX_AUTH_CANDIDATE_CHANGED: Refresh the authentication settings.");
    }
    return candidate;
  }

  private async readState(): Promise<AuthSelectionState> {
    try { return stateSchema.parse(parseJsonUtf8Strict(await readFile(this.file), "Codex authentication selection")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
      throw new Error("CODEX_AUTH_SELECTION_INVALID: The saved authentication choice is invalid.");
    }
  }

  private async update(expectedRevision: number | undefined,
    change: (state: AuthSelectionState) => void | Promise<void>): Promise<void> {
    await withRuntimeLock(this.root, "auth-selection", async () => {
      const state = await this.readState();
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        throw new Error("CODEX_AUTH_REVISION_CHANGED: Refresh the authentication settings before applying a change.");
      }
      await change(state);
      await atomicRuntimeJson(this.file, state);
    });
  }
}
