import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CodexAppServerUpstreamPool } from "./appServerUpstream.js";
import { codexCredentialIdentity, codexCredentialOwnerKey } from "./codexService.js";
import { assertEffectiveCodexAuthPolicy, effectiveCodexCredentialStore,
  parseCodexLocalAuthPolicy, type CodexLocalAuthPolicy } from "./codexAuthPolicy.js";
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
  reused: z.boolean().default(false),
  status: z.enum(["prepared", "login-started", "login-completed", "login-failed", "verified"]),
  accountKey: z.string().nullable(),
  accountEmail: z.string().max(320).nullable().default(null),
  credentialKey: z.string().nullable(),
  verifiedCli: z.string().nullable(),
  verifiedCliFingerprint: z.string().nullable(),
  verifiedAt: z.string().nullable()
});
const verificationSchema = z.strictObject({
  command: z.string(), cliFingerprint: z.string(),
  accountKey: z.string().nullable(), accountEmail: z.string().max(320).nullable().default(null),
  credentialKey: z.string().nullable()
});
const activationSchema = z.strictObject({
  id: z.string().uuid(), from: connectionSchema, to: connectionSchema,
  generation: z.number().int().nonnegative(), status: z.enum(["starting", "uncertain"]),
  startedAt: z.string().datetime().optional()
});
const activationResolutionSchema = z.strictObject({
  id: z.string().uuid(), from: connectionSchema, to: connectionSchema,
  generation: z.number().int().nonnegative(),
  outcome: z.literal("stopped-unconfirmed"), resolvedAt: z.string().datetime()
});
const ownedProfileSchema = z.strictObject({
  id: z.string().uuid(), kind: z.enum(["bridge-chatgpt", "bridge-api"]),
  status: z.enum(["available", "removed", "logout-unconfirmed"])
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative().default(0),
  applied: connectionSchema,
  appliedAccountEmail: z.string().max(320).nullable().default(null),
  pending: connectionSchema.nullable(),
  pendingAccountEmail: z.string().max(320).nullable().default(null),
  candidate: candidateSchema.nullable(),
  pendingVerification: verificationSchema.nullable().default(null),
  activation: activationSchema.nullable().default(null),
  lastActivationResolution: activationResolutionSchema.nullable().default(null),
  profiles: z.array(ownedProfileSchema).default([])
});
type AuthSelectionState = z.infer<typeof stateSchema>;
export type AuthSelectionSnapshot = Omit<AuthSelectionState, "candidate" | "pendingVerification"> & {
  candidate: (Omit<NonNullable<AuthSelectionState["candidate"]>, "status"> & {
    status: NonNullable<AuthSelectionState["candidate"]>["status"] | "login-unconfirmed";
  }) | null;
  overrideActive: boolean;
  effective: AuthConnection;
};
const initialState = (): AuthSelectionState => ({ schemaVersion: 1, revision: 0, generation: 0,
  applied: { kind: "shared" }, appliedAccountEmail: null,
  pending: null, pendingAccountEmail: null, candidate: null,
  pendingVerification: null, activation: null, lastActivationResolution: null, profiles: [] });
const candidateLoginProcesses = new Map<string, ChildProcess>();
type LocalAuthPolicy = Pick<CodexLocalAuthPolicy, "forcedMethod" | "workspaceId">;

/** Stores choices, a local account label, and opaque owner correlations; Codex owns credentials. */
export class CodexAuthSelectionManager {
  private readonly file: string;
  constructor(readonly root: string) { this.file = path.join(root, "auth-selection.json"); }

  async snapshot(environment: NodeJS.ProcessEnv): Promise<AuthSelectionSnapshot> {
    const state = await this.readState();
    const overrideActive = Boolean(environment.CODEX_HOME);
    const candidate = state.candidate?.status === "login-started" &&
      !candidateLoginProcesses.has(state.candidate.id)
      ? { ...state.candidate, status: "login-unconfirmed" as const } : state.candidate;
    const { pendingVerification: _privateVerification, ...publicState } = state;
    return { ...publicState, candidate, overrideActive,
      effective: overrideActive ? { kind: "shared" } : state.applied };
  }

  async prepare(kind: "bridge-chatgpt" | "bridge-api", expectedRevision: number,
    environment: NodeJS.ProcessEnv = {}): Promise<AuthSelectionSnapshot> {
    const policy = await this.readLocalPolicy(environment);
    this.assertAllowedByPolicy(kind, policy);
    await this.update(expectedRevision, async state => {
      this.assertNoActivation(state);
      if (state.pending) throw new Error("CODEX_AUTH_PENDING_CHANGE: Cancel the pending connection before preparing another candidate.");
      if (state.candidate) throw new Error("CODEX_AUTH_CANDIDATE_PENDING: Cancel the existing candidate before preparing another.");
      const id = randomUUID();
      const home = authProfileHome(this.root, id);
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(path.join(home, "config.toml"), this.profileConfig(policy), { mode: 0o600, flag: "wx" });
      state.candidate = { id, connection: { kind, profileId: id }, status: "prepared",
        reused: false,
        accountKey: null, accountEmail: null, credentialKey: null, verifiedCli: null,
        verifiedCliFingerprint: null, verifiedAt: null };
      state.profiles.push({ id, kind, status: "available" });
      state.revision++;
    });
    return this.snapshot({});
  }

  /** Select one of the bridge's previously saved profiles without mutating its credential. */
  async selectOwnedProfile(profileId: string, expectedRevision: number): Promise<AuthSelectionSnapshot> {
    await this.update(expectedRevision, state => {
      this.assertNoActivation(state);
      if (state.pending || state.candidate) throw new Error("CODEX_AUTH_CANDIDATE_PENDING");
      const profile = state.profiles.find(item => item.id === profileId && item.status === "available");
      if (!profile) throw new Error("CODEX_AUTH_PROFILE_UNAVAILABLE");
      if (candidateLoginProcesses.has(profileId)) throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS");
      if ("profileId" in state.applied && state.applied.profileId === profileId) {
        throw new Error("CODEX_AUTH_PROFILE_IN_USE");
      }
      state.candidate = { id: profileId, connection: { kind: profile.kind, profileId }, reused: true,
        status: "prepared", accountKey: null, accountEmail: null, credentialKey: null,
        verifiedCli: null, verifiedCliFingerprint: null, verifiedAt: null };
      state.revision++;
    });
    return this.snapshot({});
  }

  async startChatGptLogin(candidateId: string, command: string, environment: NodeJS.ProcessEnv): Promise<void> {
    await withRuntimeLock(this.root, "auth-selection", async () => {
      const state = await this.readState();
      this.assertNoActivation(state);
      if (state.candidate?.id !== candidateId || state.candidate.connection.kind !== "bridge-chatgpt") {
        throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      }
      if (state.candidate.reused) throw new Error("CODEX_AUTH_PROFILE_READ_ONLY: Verify the saved profile without replacing its login.");
      if (this.pendingCandidate(state, candidateId)) throw new Error("CODEX_AUTH_CANDIDATE_STAGED: Cancel the pending connection first.");
      if (state.candidate.status !== "prepared" && state.candidate.status !== "login-failed") {
        throw new Error("CODEX_AUTH_LOGIN_ALREADY_ATTEMPTED: Prepare another candidate to change this login.");
      }
      if (candidateLoginProcesses.has(candidateId)) throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS");
      const profileId = state.candidate.connection.profileId;
      state.candidate.status = "login-started";
      this.clearVerification(state.candidate);
      state.revision++;
      await atomicRuntimeJson(this.file, state);
      let child: ChildProcess;
      try {
        child = spawn(command, ["login"], {
          env: this.profileEnvironment(environment, profileId),
          cwd: environment.HOME || process.cwd(), detached: true, stdio: "ignore"
        });
      } catch {
        state.candidate.status = "login-failed";
        state.revision++;
        await atomicRuntimeJson(this.file, state);
        throw new Error("CODEX_AUTH_LOGIN_START_FAILED: The selected Codex login could not start.");
      }
      candidateLoginProcesses.set(candidateId, child);
      child.once("exit", code => {
        if (candidateLoginProcesses.get(candidateId) === child) candidateLoginProcesses.delete(candidateId);
        void this.update(undefined, current => {
          if (current.candidate?.id !== candidateId || current.candidate.status !== "login-started") return;
          current.candidate.status = code === 0 ? "login-completed" : "login-failed";
          current.revision++;
        }).catch(() => { /* A later status read will report an unconfirmed result. */ });
      });
      try { await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { child.unref(); resolve(); });
        child.once("error", () => {
          if (candidateLoginProcesses.get(candidateId) === child) candidateLoginProcesses.delete(candidateId);
          reject(new Error("CODEX_AUTH_LOGIN_START_FAILED: The selected Codex login could not start."));
        });
      }); } catch (error) {
        if (state.candidate?.id === candidateId) {
          state.candidate.status = "login-failed";
          state.revision++;
          await atomicRuntimeJson(this.file, state);
        }
        throw error;
      }
    });
  }

  async setApiKey(candidateId: string, command: string, environment: NodeJS.ProcessEnv, apiKey: string): Promise<void> {
    if (!apiKey.trim() || apiKey.length > 32768 || apiKey.includes("\n")) {
      throw new Error("CODEX_AUTH_API_KEY_INVALID: Enter a valid API key.");
    }
    let completion: Promise<boolean> | undefined;
    await withRuntimeLock(this.root, "auth-selection", async () => {
      const state = await this.readState();
      this.assertNoActivation(state);
      if (state.candidate?.id !== candidateId || state.candidate.connection.kind !== "bridge-api") {
        throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      }
      if (state.candidate.reused) throw new Error("CODEX_AUTH_PROFILE_READ_ONLY: Verify the saved profile without replacing its key.");
      if (this.pendingCandidate(state, candidateId)) throw new Error("CODEX_AUTH_CANDIDATE_STAGED: Cancel the pending connection first.");
      if (state.candidate.status !== "prepared" && state.candidate.status !== "login-failed") {
        throw new Error("CODEX_AUTH_LOGIN_ALREADY_ATTEMPTED: Prepare another candidate to change this key.");
      }
      if (candidateLoginProcesses.has(candidateId)) throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS");
      const profileId = state.candidate.connection.profileId;
      state.candidate.status = "login-started";
      this.clearVerification(state.candidate);
      state.revision++;
      await atomicRuntimeJson(this.file, state);
      let child: ChildProcess;
      try {
        child = spawn(command, ["login", "--with-api-key"], {
          env: this.profileEnvironment(environment, profileId),
          cwd: environment.HOME || process.cwd(), stdio: ["pipe", "ignore", "ignore"]
        });
      } catch {
        state.candidate.status = "login-failed";
        state.revision++;
        await atomicRuntimeJson(this.file, state);
        throw new Error("CODEX_AUTH_API_LOGIN_FAILED: Codex could not start the key login.");
      }
      const stdin = child.stdin;
      if (!stdin) {
        child.kill();
        state.candidate.status = "login-failed";
        state.revision++;
        await atomicRuntimeJson(this.file, state);
        throw new Error("CODEX_AUTH_API_LOGIN_FAILED: Codex did not open a key input channel.");
      }
      candidateLoginProcesses.set(candidateId, child);
      completion = new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => { child.kill(); resolve(false); }, 30_000);
        child.once("error", () => { clearTimeout(timeout); resolve(false); });
        child.once("exit", code => { clearTimeout(timeout); resolve(code === 0); });
        stdin.on("error", () => { /* A failed child has its own sanitized result. */ });
      }).finally(() => {
        if (candidateLoginProcesses.get(candidateId) === child) candidateLoginProcesses.delete(candidateId);
      });
      stdin.end(`${apiKey}\n`);
    });
    const succeeded = await completion!;
    if (!succeeded) {
      await this.update(undefined, state => {
        if (state.candidate?.id !== candidateId) return;
        state.candidate.status = "login-failed";
        this.clearVerification(state.candidate);
        state.revision++;
      });
      throw new Error("CODEX_AUTH_API_LOGIN_FAILED: Codex did not accept the API key in the candidate profile.");
    }
    await this.update(undefined, state => {
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      state.candidate.status = "login-completed";
      this.clearVerification(state.candidate);
      state.revision++;
    });
  }

  async verify(candidateId: string, command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv): Promise<AuthSelectionSnapshot> {
    const before = await this.readState();
    this.assertNoActivation(before);
    const candidate = before.candidate;
    if (!candidate || candidate.id !== candidateId) {
      throw new Error("CODEX_AUTH_CANDIDATE_CHANGED: Refresh the authentication settings.");
    }
    if (this.pendingCandidate(before, candidateId)) {
      throw new Error("CODEX_AUTH_CANDIDATE_STAGED: Cancel the pending connection first.");
    }
    if (candidate.status === "login-started" && candidateLoginProcesses.has(candidateId)) {
      throw new Error("CODEX_AUTH_LOGIN_IN_PROGRESS: Wait for the selected Codex login to finish before verifying.");
    }
    const observed = await this.probeCandidate(candidate, command, environment);
    await this.update(before.revision, state => {
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      state.candidate.status = "verified";
      state.candidate.accountKey = observed.accountKey;
      state.candidate.accountEmail = observed.accountEmail;
      state.candidate.credentialKey = observed.credentialKey;
      state.candidate.verifiedCli = command;
      state.candidate.verifiedCliFingerprint = cliFingerprint;
      state.candidate.verifiedAt = new Date().toISOString();
      state.revision++;
    });
    return this.snapshot(environment);
  }

  private async probeCandidate(candidate: NonNullable<AuthSelectionState["candidate"]>, command: string,
    environment: NodeJS.ProcessEnv): Promise<{ accountKey: string | null; accountEmail: string | null; credentialKey: string }> {
    await this.assertProfilePolicy(candidate.connection, environment);
    const profileEnvironment = this.profileEnvironment(environment, candidate.connection.profileId);
    const pool = new CodexAppServerUpstreamPool(command, 1, {
      environment: profileEnvironment
    });
    try {
      const policy = await pool.readAuthenticationPolicy();
      const { snapshot: account, email: accountEmail } = await pool.readAccountDetails();
      if (account.ownershipConflict) throw new Error("CODEX_AUTH_IDENTITY_CONFLICT: Codex account and usage replies identify different workspaces.");
      const expected = candidate.connection.kind === "bridge-api" ? "api-key" : "chatgpt";
      if (!account?.authenticated || account.authMode !== expected) {
        throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: The candidate is not signed in with the selected method.");
      }
      const ownerKey = codexCredentialOwnerKey(profileEnvironment.CODEX_HOME!, profileEnvironment);
      assertEffectiveCodexAuthPolicy(policy, expected, ownerKey || account.ownershipKey, true);
      if (ownerKey && account.ownershipKey && ownerKey !== account.ownershipKey) {
        throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: Codex reported a different account from the profile credential.");
      }
      const models = await pool.listModels() as { data?: unknown[] };
      if (!Array.isArray(models.data) || models.data.length === 0) {
        throw new Error("CODEX_AUTH_MODELS_UNAVAILABLE: The candidate model catalog could not be verified.");
      }
      const credentialKey = codexCredentialIdentity(profileEnvironment.CODEX_HOME!, profileEnvironment);
      if (!credentialKey) {
        throw new Error("CODEX_AUTH_IDENTITY_UNAVAILABLE: The candidate's file-backed identity could not be confirmed.");
      }
      return { accountKey: ownerKey || account.ownershipKey, accountEmail, credentialKey };
    } finally { await pool.close(); }
  }

  async stage(connection: AuthConnection, expectedRevision: number, command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv, billingConfirmed: boolean): Promise<AuthSelectionSnapshot> {
    if (environment.CODEX_HOME) throw new Error("CODEX_AUTH_OVERRIDE_ACTIVE: The explicit CODEX_HOME controls this runtime.");
    const before = await this.readState();
    this.assertNoActivation(before);
    if (before.revision !== expectedRevision) {
      throw new Error("CODEX_AUTH_REVISION_CHANGED: Refresh the authentication settings before applying a change.");
    }
    if (before.pending) {
      if (JSON.stringify(before.pending) === JSON.stringify(connection)) return this.snapshot(environment);
      throw new Error("CODEX_AUTH_PENDING_CHANGE: Cancel the pending connection before choosing another.");
    }
    if (!before.pending && JSON.stringify(before.applied) === JSON.stringify(connection)) return this.snapshot(environment);
    if (connection.kind === "bridge-api" && !billingConfirmed) {
      throw new Error("CODEX_AUTH_API_BILLING_CONFIRMATION_REQUIRED");
    }
    let observed: { accountKey: string | null; accountEmail: string | null; credentialKey: string | null } | null = null;
    if (connection.kind === "shared") observed = await this.probeShared(command, environment, billingConfirmed);
    if (connection.kind === "bridge-chatgpt" || connection.kind === "bridge-api") {
      const candidate = await this.requireCandidate(connection.profileId, connection.kind);
      observed = await this.probeCandidate(candidate, command, environment);
    }
    await this.update(expectedRevision, state => {
      this.assertNoActivation(state);
      if (connection.kind === "bridge-chatgpt" || connection.kind === "bridge-api") {
        const candidate = state.candidate;
        if (candidate?.status !== "verified" || candidate.connection.kind !== connection.kind ||
            candidate.connection.profileId !== connection.profileId || candidate.verifiedCli !== command ||
            candidate.verifiedCliFingerprint !== cliFingerprint ||
            candidate.credentialKey !== observed?.credentialKey || candidate.accountKey !== observed?.accountKey ||
            candidate.accountEmail !== observed?.accountEmail) {
          throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: Verify the selected account and model catalog again.");
        }
      }
      state.pending = connection;
      state.pendingAccountEmail = observed?.accountEmail || null;
      state.pendingVerification = { command, cliFingerprint,
        accountKey: observed?.accountKey || null, accountEmail: observed?.accountEmail || null,
        credentialKey: observed?.credentialKey || null };
      state.revision++;
    });
    return this.snapshot(environment);
  }

  async cancelCandidate(candidateId: string, expectedRevision: number): Promise<void> {
    await this.update(expectedRevision, state => {
      this.assertNoActivation(state);
      if (state.candidate?.id !== candidateId) throw new Error("CODEX_AUTH_CANDIDATE_CHANGED");
      if (this.pendingCandidate(state, candidateId)) throw new Error("CODEX_AUTH_CANDIDATE_STAGED: Cancel the pending connection first.");
      state.candidate = null;
      state.revision++;
      // Candidate credentials are retained; no token rollback or logout.
    });
    const login = candidateLoginProcesses.get(candidateId);
    // Keep the process visible until its exit handler runs. The saved profile
    // cannot be selected as a new candidate while a cancelled login may write.
    if (login?.pid && login.exitCode === null) login.kill("SIGTERM");
  }

  async cancelPending(expectedRevision: number): Promise<void> {
    await this.update(expectedRevision, state => {
      this.assertNoActivation(state);
      if (!state.pending) return;
      state.pending = null;
      state.pendingAccountEmail = null;
      state.pendingVerification = null;
      state.revision++;
      // A prepared candidate may still hold independently refreshed credentials.
    });
  }

  private async probeShared(command: string, environment: NodeJS.ProcessEnv,
    billingConfirmed: boolean): Promise<{ accountKey: string | null; accountEmail: string | null; credentialKey: string | null }> {
    await this.assertSharedLocalPolicy(environment);
    const pool = new CodexAppServerUpstreamPool(command, 1, { environment });
    try {
      const effectivePolicy = await pool.readAuthenticationPolicy();
      const { snapshot: account, email: accountEmail } = await pool.readAccountDetails();
      if (account.ownershipConflict) throw new Error("CODEX_AUTH_IDENTITY_CONFLICT: Codex account and usage replies identify different workspaces.");
      if (!account?.authenticated) throw new Error("CODEX_AUTH_SHARED_UNAVAILABLE: The existing Codex login is not verified.");
      if (account.authMode === "api-key" && !billingConfirmed) throw new Error("CODEX_AUTH_API_BILLING_CONFIRMATION_REQUIRED");
      const models = await pool.listModels() as { data?: unknown[] };
      if (!Array.isArray(models.data) || models.data.length === 0) throw new Error("CODEX_AUTH_MODELS_UNAVAILABLE");
      const home = environment.CODEX_HOME || path.join(environment.HOME || homedir(), ".codex");
      const managedStore = effectiveCodexCredentialStore(effectivePolicy);
      const fileMayBeActive = !["keyring", "auto", "ephemeral"].includes(String(managedStore));
      const credentialKey = fileMayBeActive ? codexCredentialIdentity(home, environment) : null;
      const ownerKey = fileMayBeActive ? codexCredentialOwnerKey(home, environment) : null;
      assertEffectiveCodexAuthPolicy(effectivePolicy, account.authMode, ownerKey || account.ownershipKey, false);
      if (ownerKey && account.ownershipKey && ownerKey !== account.ownershipKey) {
        throw new Error("CODEX_AUTH_SHARED_UNAVAILABLE: Codex reported a different account from the shared credential.");
      }
      if (!credentialKey && !account.ownershipKey) {
        throw new Error("CODEX_AUTH_IDENTITY_UNAVAILABLE: The shared account has no verified ownership identity.");
      }
      return { accountKey: ownerKey || account.ownershipKey, accountEmail, credentialKey };
    } finally { await pool.close(); }
  }

  async revalidatePending(command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv): Promise<void> {
    const before = await this.readState();
    this.assertNoActivation(before);
    const pending = before.pending, proof = before.pendingVerification;
    if (!pending || !proof || pending.kind !== "disconnected" &&
        (proof.command !== command || proof.cliFingerprint !== cliFingerprint)) {
      throw new Error("CODEX_AUTH_REVALIDATION_REQUIRED: The staged CLI or authentication choice changed.");
    }
    let observed: { accountKey: string | null; accountEmail: string | null; credentialKey: string | null } =
      { accountKey: null, accountEmail: null, credentialKey: null };
    if (pending.kind === "shared") observed = await this.probeShared(command, environment, true);
    if (pending.kind === "bridge-chatgpt" || pending.kind === "bridge-api") {
      const candidate = before.candidate;
      if (!candidate || candidate.status !== "verified" || candidate.id !== pending.profileId ||
          candidate.verifiedCli !== command || candidate.verifiedCliFingerprint !== cliFingerprint) {
        throw new Error("CODEX_AUTH_CANDIDATE_UNVERIFIED: Verify the selected account again.");
      }
      observed = await this.probeCandidate(candidate, command, environment);
    }
    if (observed.accountKey !== proof.accountKey || observed.accountEmail !== proof.accountEmail ||
        observed.credentialKey !== proof.credentialKey) {
      throw new Error("CODEX_AUTH_CANDIDATE_CHANGED: The verified authentication identity changed before activation.");
    }
    const after = await this.readState();
    if (after.revision !== before.revision || JSON.stringify(after.pending) !== JSON.stringify(pending)) {
      throw new Error("CODEX_AUTH_REVISION_CHANGED: Refresh the authentication settings before activation.");
    }
  }

  async beginActivation(command: string, cliFingerprint: string,
    environment: NodeJS.ProcessEnv): Promise<string | null> {
    const before = await this.readState();
    if (!before.pending) return null;
    await this.revalidatePending(command, cliFingerprint, environment);
    const id = randomUUID();
    await this.update(before.revision, state => {
      this.assertNoActivation(state);
      if (!state.pending || JSON.stringify(state.pending) !== JSON.stringify(before.pending)) {
        throw new Error("CODEX_AUTH_REVISION_CHANGED");
      }
      state.activation = { id, from: state.applied, to: state.pending,
        generation: state.generation + 1, status: "starting", startedAt: new Date().toISOString() };
      state.revision++;
    });
    return id;
  }

  async completeActivation(id: string, source: string, generation: string, observedHome?: string): Promise<void> {
    await this.update(undefined, state => {
      const activation = state.activation;
      if (!activation || activation.id !== id || source !== activation.to.kind ||
          generation !== String(activation.generation)) {
        throw new Error("CODEX_AUTH_ACTIVATION_UNCONFIRMED: The ready runtime did not prove the staged connection.");
      }
      if ("profileId" in activation.to && (!observedHome ||
          path.resolve(observedHome) !== authProfileHome(this.root, activation.to.profileId))) {
        throw new Error("CODEX_AUTH_ACTIVATION_UNCONFIRMED: The ready runtime used another authentication profile.");
      }
      state.applied = activation.to;
      state.appliedAccountEmail = state.pendingAccountEmail;
      state.generation = activation.generation;
      state.pending = null;
      state.pendingAccountEmail = null;
      state.pendingVerification = null;
      state.candidate = null;
      state.activation = null;
      state.revision++;
    });
  }

  async failActivation(id: string, definitelyNotStarted: boolean): Promise<void> {
    await this.update(undefined, state => {
      const activation = state.activation;
      if (!activation || activation.id !== id) throw new Error("CODEX_AUTH_ACTIVATION_CHANGED");
      if (definitelyNotStarted) state.activation = null;
      else state.activation = { ...activation, status: "uncertain" };
      state.revision++;
    });
  }

  /** Called only after the helper holds the runtime lock and confirms the launched runtime is stopped. */
  async resolveStoppedActivation(id: string, expectedRevision: number): Promise<void> {
    await this.update(expectedRevision, state => {
      const activation = state.activation;
      if (!activation || activation.id !== id) throw new Error("CODEX_AUTH_ACTIVATION_CHANGED");
      state.lastActivationResolution = { id, from: activation.from, to: activation.to,
        generation: activation.generation, outcome: "stopped-unconfirmed", resolvedAt: new Date().toISOString() };
      state.activation = null;
      state.revision++;
    });
  }

  private assertNoActivation(state: AuthSelectionState): void {
    if (state.activation) throw new Error("CODEX_AUTH_ACTIVATION_UNCERTAIN: Resolve the current authentication activation before changing it.");
  }

  private inactiveProfile(state: AuthSelectionState, profileId: string,
    kind: "bridge-chatgpt" | "bridge-api") {
    this.assertNoActivation(state);
    const profile = state.profiles.find(item => item.id === profileId && item.kind === kind);
    if (!profile || profile.status !== "available") throw new Error("CODEX_AUTH_PROFILE_UNAVAILABLE");
    if (state.applied.kind === kind && state.applied.profileId === profileId ||
        state.pending?.kind === kind && state.pending.profileId === profileId ||
        state.candidate?.id === profileId) {
      throw new Error("CODEX_AUTH_PROFILE_IN_USE: Disconnect or cancel this profile before removing its credential.");
    }
    return profile;
  }

  /** Remove only an inactive bridge-owned file credential; never revoke the Platform key. */
  async removeApiKey(profileId: string, expectedRevision: number, command: string,
    environment: NodeJS.ProcessEnv): Promise<void> {
    const before = await this.readState();
    if (before.revision !== expectedRevision) throw new Error("CODEX_AUTH_REVISION_CHANGED");
    this.inactiveProfile(before, profileId, "bridge-api");
    const connection = { kind: "bridge-api" as const, profileId };
    await this.assertProfilePolicy(connection, environment);
    const pool = new CodexAppServerUpstreamPool(command, 1, {
      environment: this.profileEnvironment(environment, profileId)
    });
    try { assertEffectiveCodexAuthPolicy(await pool.readAuthenticationPolicy(), "api-key", null, true); }
    finally { try { await pool.close(); } catch { /* No credential mutation is retried. */ } }
    await this.update(expectedRevision, async state => {
      const profile = this.inactiveProfile(state, profileId, "bridge-api");
      const home = authProfileHome(this.root, profileId);
      const config = parseCodexLocalAuthPolicy(await readFile(path.join(home, "config.toml"), "utf8"));
      if (config.credentialStore !== "file") throw new Error("CODEX_AUTH_PROFILE_UNVERIFIED");
      const file = path.join(home, "auth.json");
      let info;
      try { info = await lstat(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (info) {
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("CODEX_AUTH_PROFILE_UNVERIFIED");
        const auth = parseJsonUtf8Strict<Record<string, unknown>>(await readFile(file), "Codex authentication state");
        if (auth.auth_mode !== "apiKey") throw new Error("CODEX_AUTH_PROFILE_UNVERIFIED");
        await unlink(file);
      }
      profile.status = "removed";
      state.revision++;
    });
  }

  /** Official logout is confined to a previously disconnected bridge-owned file profile. */
  async logoutOwnedChatGpt(profileId: string, expectedRevision: number, command: string,
    environment: NodeJS.ProcessEnv): Promise<void> {
    const before = await this.readState();
    if (before.revision !== expectedRevision) throw new Error("CODEX_AUTH_REVISION_CHANGED");
    this.inactiveProfile(before, profileId, "bridge-chatgpt");
    const connection = { kind: "bridge-chatgpt" as const, profileId };
    await this.assertProfilePolicy(connection, environment);
    const pool = new CodexAppServerUpstreamPool(command, 1, {
      environment: this.profileEnvironment(environment, profileId)
    });
    let intentRecorded = false;
    try {
      const policy = await pool.readAuthenticationPolicy();
      const requirements = (policy.requirements as { requirements?: Record<string, unknown> } | null)?.requirements || {};
      const effective = (policy.config as { config?: Record<string, unknown> } | null)?.config || {};
      const stores = [requirements.cliAuthCredentialsStore ?? requirements.cli_auth_credentials_store,
        effective.cliAuthCredentialsStore ?? effective.cli_auth_credentials_store];
      if (stores.some(store => store !== undefined && store !== null && store !== "file")) {
        throw new Error("CODEX_AUTH_POLICY_MISMATCH: Managed storage does not isolate this profile's logout.");
      }
      // The durable intent precedes the RPC. A lost reply or Helper crash must
      // never cause an automatic second logout against this profile.
      await this.update(expectedRevision, state => {
        const profile = this.inactiveProfile(state, profileId, "bridge-chatgpt");
        profile.status = "logout-unconfirmed";
        state.revision++;
      });
      intentRecorded = true;
      await pool.logoutAccount();
      await this.update(undefined, state => {
        const profile = state.profiles.find(item => item.id === profileId && item.kind === "bridge-chatgpt");
        if (!profile || profile.status !== "logout-unconfirmed") throw new Error("CODEX_AUTH_PROFILE_UNAVAILABLE");
        profile.status = "removed";
        state.revision++;
      });
    } catch (error) {
      if (intentRecorded) {
        throw new Error("CODEX_AUTH_LOGOUT_UNCONFIRMED: The profile logout result is unknown. Inspect it before retrying.", { cause: error });
      }
      throw error;
    } finally {
      // A successful logout RPC is authoritative even if transport cleanup fails.
      try { await pool.close(); } catch { /* No credential is retried here. */ }
    }
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
    candidate.accountEmail = null;
    candidate.credentialKey = null;
    candidate.verifiedCli = null;
    candidate.verifiedCliFingerprint = null;
    candidate.verifiedAt = null;
  }

  private pendingCandidate(state: AuthSelectionState, candidateId: string): boolean {
    return Boolean(state.pending && "profileId" in state.pending && state.pending.profileId === candidateId);
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
    const { forcedMethod, workspaceId } = parseCodexLocalAuthPolicy(config);
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
    try {
      const state = stateSchema.parse(parseJsonUtf8Strict(await readFile(this.file), "Codex authentication selection"));
      for (const connection of [state.applied, state.pending, state.candidate?.connection]) {
        if (!connection || !("profileId" in connection) || state.profiles.some(item => item.id === connection.profileId)) continue;
        state.profiles.push({ id: connection.profileId, kind: connection.kind, status: "available" });
      }
      return state;
    }
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
