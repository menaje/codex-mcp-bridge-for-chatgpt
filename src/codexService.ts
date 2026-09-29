import { CodexBilling } from "./codexBilling.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CodexRuntimeManager, type CliSelection } from "./codexRuntime.js";
import type { CodexBackendKind } from "./config.js";
import { JsonRpcProcess } from "./jsonRpcProcess.js";
import { codexChatgptOwnerKey, projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
import { assertEffectiveCodexAuthPolicy, effectiveCodexAuthPolicyIdentity,
  effectiveCodexCredentialStore, parseCodexLocalAuthPolicy,
  type CodexEffectiveAuthPolicy, type CodexLocalAuthPolicy } from "./codexAuthPolicy.js";
import { validateInitializeResponse } from "./runtimeCompatibility.js";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./textIntegrity.js";
import { codexProcessEnvironment } from "../scripts/runtime-env.mjs";

export type CodexSessionPolicy = { contextId?: string; visibleInCodexApp: boolean; persistent: boolean; persistence: "persistent" | "ephemeral"; constraint?: "hidden-persistent-unsupported" };
export type ResolvedCodexContext = {
  selection: CliSelection;
  environment: NodeJS.ProcessEnv;
  runtimeHome: string;
  managementCwd: string;
  fingerprint: string;
  authenticationIdentity: string | null;
  release: () => Promise<void>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function localAuthPolicy(directory: string): CodexLocalAuthPolicy {
  try { return parseCodexLocalAuthPolicy(readFileSync(path.join(directory, "config.toml"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { credentialStore: null, forcedMethod: null, workspaceId: null };
    }
    throw error;
  }
}

type CredentialEvidence = { identity: string; ownerKey: string; authMode: "chatgpt" | "api-key" };
function credentialEvidence(directory: string, environment: NodeJS.ProcessEnv,
  policy: CodexLocalAuthPolicy): CredentialEvidence | null {
  // In auto mode the keyring can win while an older auth.json remains on
  // disk. A file in that mode is not evidence of the active credential.
  if (["keyring", "ephemeral", "auto"].includes(policy.credentialStore || "")) return null;
  try {
    const auth = parseJsonUtf8Strict<Record<string, any>>(
      readFileSync(path.join(directory, "auth.json")), "Codex authentication state"
    );
    // A token subject may name a person while the selected account_id names a
    // workspace. Do not silently substitute one for the other.
    const subject = typeof auth.tokens?.account_id === "string" && auth.tokens.account_id || null;
    const restrictions = [policy.forcedMethod, policy.workspaceId];
    if (auth.auth_mode === "chatgpt" && subject) return {
      identity: digest(JSON.stringify(["chatgpt", subject, restrictions])),
      ownerKey: digest(JSON.stringify(["chatgpt", subject])), authMode: "chatgpt"
    };
    if (auth.auth_mode === "apiKey") {
      const key = auth.OPENAI_API_KEY || environment.OPENAI_API_KEY || environment.CODEX_API_KEY;
      if (typeof key === "string" && key) return {
        identity: digest(JSON.stringify(["apiKey", key, restrictions])),
        ownerKey: digest(JSON.stringify(["api-key", key])), authMode: "api-key"
      };
    }
  } catch { /* Keyring, absent, or unreadable; seek an account observation. */ }
  return null;
}

/** A non-secret stable correlation for a file-backed Codex credential and local policy. */
export function codexCredentialIdentity(directory: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  try { return credentialEvidence(directory, environment, localAuthPolicy(directory))?.identity || null; }
  catch { return null; }
}

export function codexCredentialOwnerKey(directory: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  try { return credentialEvidence(directory, environment, localAuthPolicy(directory))?.ownerKey || null; }
  catch { return null; }
}

/**
 * Child processes must not inherit the helper's cwd. A packaged helper can
 * outlive an app-bundle replacement, leaving its inherited cwd attached to an
 * unlinked Runtime directory even though the same path exists again.
 */
export function stableCodexWorkingDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const candidates = [environment.HOME, homedir()];
  for (const candidate of candidates) {
    if (!candidate?.trim() || !path.isAbsolute(candidate)) continue;
    const resolved = path.normalize(candidate);
    try {
      if (statSync(resolved).isDirectory()) return resolved;
    } catch { /* Try the system home directory next. */ }
  }
  throw new Error("CODEX_WORKING_DIRECTORY_UNAVAILABLE: A stable home directory is required to start Codex.");
}

/** Shared policy and installation entrypoint for both execution and local management. */
export class CodexService {
  readonly billing: CodexBilling;
  readonly cli: CodexRuntimeManager;
  private visibility?: () => boolean;
  private accountIdentities = new Map<CodexBackendKind, string>();
  private accounts = new Map<CodexBackendKind, { revision: string; expires: number; request: Promise<CodexAccountSnapshot | null> }>();
  private displayedAccounts = new Map<CodexBackendKind, { revision: string; context: string | null; value: CodexAccountSnapshot }>();
  private accountFailures = new Map<CodexBackendKind, { revision: string; error: unknown }>();
  private accountReader?: () => Promise<CodexAccountSnapshot | null>;
  private authPolicyReader?: () => Promise<CodexEffectiveAuthPolicy>;
  private executionAdmissionGuard?: () => Promise<void>;
  private confirmedSessionOwnerKey: string | null = null;
  private confirmedEffectiveCredentialStore: string | null = null;
  private effectivePolicyConfirmed = false;
  private readonly unknownSessionIdentity = randomUUID();
  constructor(readonly environment: NodeJS.ProcessEnv = process.env, cli?: CodexRuntimeManager) {
    this.cli = cli || new CodexRuntimeManager({ environment: codexProcessEnvironment(environment) });
    this.billing = new CodexBilling(this.cli.root);
  }
  async acquireContext(): Promise<ResolvedCodexContext> {
    const { selection, fingerprint, release } = await this.cli.acquire();
    try {
      return {
        selection,
        environment: codexProcessEnvironment(this.environment),
        runtimeHome: this.cli.root,
        managementCwd: stableCodexWorkingDirectory(this.environment),
        fingerprint,
        authenticationIdentity: this.authenticationIdentity(),
        release
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  setVisibilityProvider(provider: () => boolean): void { this.visibility = provider; this.setAppVisibility(provider()); }
  /**
   * Production can place App Server account I/O in the isolated execution
   * process while retaining this class as the cache and policy authority.
   */
  setAccountReader(reader: () => Promise<CodexAccountSnapshot | null>): void {
    this.accountReader = reader;
    this.accounts.clear();
    this.accountFailures.clear();
  }
  setAuthPolicyReader(reader: () => Promise<CodexEffectiveAuthPolicy>): void {
    this.authPolicyReader = reader;
    this.effectivePolicyConfirmed = false;
    this.confirmedEffectiveCredentialStore = null;
    this.confirmedSessionOwnerKey = null;
  }
  setAppVisibility(visible: boolean): void {
    const saved = this.readRecord("policy", "visibility");
    if (saved?.visible !== visible) this.writeRecord("policy", "visibility", { visible });
  }
  private appVisibility(): boolean { return this.visibility?.() ?? this.readRecord("policy", "visibility")?.visible === true; }
  modelRevision(contextFingerprint?: string): string {
    return digest(this.cacheRevision(contextFingerprint) + JSON.stringify([...this.accountIdentities]));
  }
  authenticationIdentity(home?: string): string | null {
    const directory = home || this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    return codexCredentialIdentity(directory, this.environment);
  }
  /** Stable display boundary, independent of token/config refresh inputs. */
  accountDisplayContext(): string | null {
    const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    const fileMayBeActive = (!this.authPolicyReader || this.effectivePolicyConfirmed) &&
      !["keyring", "auto", "ephemeral"].includes(this.confirmedEffectiveCredentialStore || "");
    const identity = fileMayBeActive ? this.authenticationIdentity(home) : null;
    return identity ? digest(JSON.stringify([home, this.cli.appliedContextFingerprint(), identity])) : null;
  }
  /** Persisted thread ownership follows a proven owner, regardless of how it was observed. */
  sessionAuthBoundary(): { key: string; allowLegacyShared: boolean } {
    const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    const source = this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE || "shared";
    const generation = this.environment.CODEX_MCP_BRIDGE_AUTH_GENERATION || "0";
    let policyKey: string | null = null;
    let observedOwner: string | null = null;
    try {
      const policy = localAuthPolicy(home);
      policyKey = digest(JSON.stringify([policy.credentialStore, policy.forcedMethod, policy.workspaceId]));
      observedOwner = (!this.authPolicyReader || this.effectivePolicyConfirmed) &&
        !["keyring", "auto", "ephemeral"].includes(this.confirmedEffectiveCredentialStore || "")
        ? credentialEvidence(home, this.environment, policy)?.ownerKey || null : null;
    } catch { /* An unknown policy cannot authorize a stored conversation. */ }
    if (observedOwner) this.confirmedSessionOwnerKey = observedOwner;
    const owner = observedOwner || this.confirmedSessionOwnerKey;
    return {
      key: digest(JSON.stringify([source, path.resolve(home),
        this.cli.appliedContextFingerprint(), policyKey,
        owner ? ["owner", owner] : ["unverified", generation, this.unknownSessionIdentity]])),
      allowLegacyShared: false
    };
  }
  /** Confirm the owner before resolving any saved Agent or persisting a new Job. */
  assertCurrentAdmission(): Promise<void> {
    return this.admissionGuard()();
  }
  admissionGuard(home?: string): () => Promise<void> {
    if (!home && this.executionAdmissionGuard) return this.executionAdmissionGuard;
    let identity: string | undefined;
    let source: "file" | "account" | undefined;
    let ownerKey: string | undefined;
    let policyKey: string | undefined;
    let managedPolicyKey: string | undefined;
    let cliFingerprint: string | undefined;
    let pending: Promise<void> = Promise.resolve();
    const check = async () => {
      if (this.environment.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED === "1") {
        throw new Error("CODEX_AUTH_DISCONNECTED: Connect a Codex authentication source before starting new work.");
      }
      const directory = home || this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
      let policy: CodexLocalAuthPolicy;
      try { policy = localAuthPolicy(directory); }
      catch { throw new Error("CODEX_AUTH_UNAVAILABLE: The current authentication policy cannot be verified."); }
      const currentPolicyKey = digest(JSON.stringify([policy.credentialStore, policy.forcedMethod, policy.workspaceId]));
      const currentCliFingerprint = this.cli.appliedContextFingerprint();
      let effectivePolicy: CodexEffectiveAuthPolicy | null = null;
      let managedStore: unknown = null;
      if (this.authPolicyReader) {
        try {
          effectivePolicy = await this.authPolicyReader();
          managedStore = effectiveCodexCredentialStore(effectivePolicy);
          if (managedStore != null && !["file", "keyring", "auto", "ephemeral"].includes(String(managedStore))) {
            throw new Error("Unknown managed credential storage.");
          }
        } catch {
          throw new Error("CODEX_AUTH_POLICY_UNAVAILABLE: Effective Codex authentication policy cannot currently be verified.");
        }
      }
      const fileEvidence = ["keyring", "auto", "ephemeral"].includes(String(managedStore))
        ? null : credentialEvidence(directory, this.environment, policy);
      let current: string;
      let currentOwnerKey: string;
      let currentSource: "file" | "account";
      let currentMode: "chatgpt" | "api-key";
      if (fileEvidence) {
        current = fileEvidence.identity;
        currentOwnerKey = fileEvidence.ownerKey;
        currentSource = "file";
        currentMode = fileEvidence.authMode;
      } else {
        // Never pin an unavailable observation as an account. A successful
        // account/read can identify a keyring profile without reading tokens.
        let account: CodexAccountSnapshot | null;
        try { account = await this.readCliAccount(); }
        catch { throw new Error("CODEX_AUTH_UNAVAILABLE: Codex account status cannot currently be verified. Retry after the account check recovers."); }
        if (!account?.authenticated) throw new Error("CODEX_AUTH_REQUIRED: Sign in to Codex before starting new work.");
        // An ambient key cannot identify a credential that managed storage
        // selected independently (including auto/keyring fallback).
        const environmentApiKey = ["keyring", "auto", "ephemeral"].includes(String(managedStore))
          ? undefined : this.environment.OPENAI_API_KEY || this.environment.CODEX_API_KEY;
        if (account.authMode === "unknown" ||
            !account.ownershipKey && !(account.authMode === "api-key" && environmentApiKey)) {
          throw new Error("CODEX_AUTH_IDENTITY_UNAVAILABLE: Codex did not provide enough account identity to protect a new execution.");
        }
        currentOwnerKey = account.authMode === "api-key" && environmentApiKey
          ? digest(JSON.stringify(["api-key", environmentApiKey])) : account.ownershipKey!;
        current = digest(JSON.stringify([account.authMode, currentOwnerKey, currentPolicyKey, currentCliFingerprint]));
        currentSource = "account";
        currentMode = account.authMode;
      }
      if (policy.forcedMethod && policy.forcedMethod !== (currentMode === "api-key" ? "api" : "chatgpt") ||
          policy.workspaceId && (currentMode !== "chatgpt" ||
            codexChatgptOwnerKey(policy.workspaceId) !== currentOwnerKey)) {
        throw new Error("CODEX_AUTH_POLICY_MISMATCH: The current login conflicts with local Codex restrictions.");
      }
      if (effectivePolicy) assertEffectiveCodexAuthPolicy(effectivePolicy, currentMode, currentOwnerKey,
        this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE === "bridge-chatgpt" ||
        this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE === "bridge-api");
      const currentManagedPolicyKey = effectivePolicy
        ? digest(effectiveCodexAuthPolicyIdentity(effectivePolicy)) : "none";
      if (identity !== undefined && (ownerKey !== currentOwnerKey || policyKey !== currentPolicyKey ||
          managedPolicyKey !== currentManagedPolicyKey || cliFingerprint !== currentCliFingerprint)) {
        throw new Error("CODEX_AUTH_CHANGED: Codex authentication or policy changed. Review the current account before starting another turn.");
      }
      if (identity !== undefined && source === currentSource && current !== identity) {
        throw new Error("CODEX_AUTH_CHANGED: Codex authentication changed. Review the current account before starting another turn.");
      }
      identity = current;
      source = currentSource;
      ownerKey = currentOwnerKey;
      policyKey = currentPolicyKey;
      managedPolicyKey = currentManagedPolicyKey;
      cliFingerprint = currentCliFingerprint;
      this.confirmedSessionOwnerKey = currentOwnerKey;
      this.confirmedEffectiveCredentialStore = typeof managedStore === "string" ? managedStore : null;
      this.effectivePolicyConfirmed = true;
    };
    const guard = () => {
      pending = pending.then(check, check);
      return pending;
    };
    if (!home) this.executionAdmissionGuard = guard;
    return guard;
  }
  cacheRevision(contextFingerprint?: string): string {
    const shared = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    const files = ["auth.json", "config.toml"].map(name => path.join(shared, name));
    const values = files.map(file => {
      try { return decodeUtf8Strict(readFileSync(file), `runtime input ${path.basename(file)}`); }
      catch { return "unavailable"; }
    });
    // Cache inputs follow the manager's effective command and native binary,
    // including explicit aliases, npm launchers and symlink replacement.
    return digest(JSON.stringify([
      contextFingerprint ?? this.cli.appliedContextFingerprint(), shared, this.appVisibility(), ...values,
      this.environment.OPENAI_API_KEY, this.environment.CODEX_API_KEY,
      ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        "CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "SSL_CERT_DIR", "SSL_CERT_FILE"].map(name => this.environment[name])
    ]));
  }
  async sessionPolicy(kind: CodexBackendKind, visible: boolean, _parent?: string, persistence: "persistent" | "ephemeral" = visible ? "persistent" : "ephemeral"): Promise<CodexSessionPolicy> {
    if (kind !== "app-server") throw new Error("CODEX_BACKEND_RETIRED: Start a fresh App Server context with an explicit handoff summary. Existing history is preserved.");
    if (persistence === "persistent" && !visible) throw new Error("HIDDEN_PERSISTENT_UNSUPPORTED: This Codex version has no verified durable-but-hidden creation option. Enable Codex app visibility for resumable conversations, or explicitly use a memory-only conversation.");
    if (persistence === "ephemeral" && visible) throw new Error("EPHEMERAL_NOT_VISIBLE: Memory-only conversations cannot be shown in the Codex app.");
    return { visibleInCodexApp: visible, persistent: persistence === "persistent", persistence,
      ...(!visible ? { constraint: "hidden-persistent-unsupported" as const } : {}) };
  }
  async readAccount(kind: CodexBackendKind, includeBilling = false): Promise<CodexAccountSnapshot | null> {
    // Observe and permanently evict a confirmed display-boundary change before
    // a failed request could later resurrect the old account.
    this.cachedAccount(kind);
    const revision = this.cacheRevision(), cached = this.accounts.get(kind);
    const request = cached?.revision === revision && cached.expires > Date.now() ? cached.request : (async () => {
      if (kind !== "app-server") return null;
      return this.readCliAccount();
    })().catch(error => {
      this.accountFailures.set(kind, { revision, error });
      return null;
    }).then(value => {
      if (revision !== this.cacheRevision()) {
        if (this.accountFailures.get(kind)?.revision === revision) this.accountFailures.delete(kind);
        return null;
      }
      if (value) {
        this.accountIdentities.set(kind, `${value.authMode}:${value.accountKey}:${value.planType}`);
        if (this.accountFailures.get(kind)?.revision === revision) this.accountFailures.delete(kind);
      }
      return value;
    });
    if (request !== cached?.request) this.accounts.set(kind, { revision, expires: Date.now() + 15_000, request });
    const value = includeBilling ? await this.withBilling(await request) : await request;
    if (revision !== this.cacheRevision()) return null;
    if (!value) return null;
    const context = this.accountDisplayContext();
    if (revision !== this.cacheRevision()) return null;
    const previous = this.displayedAccounts.get(kind);
    const sharesDisplayContext = previous && (context !== null && previous.context === context ||
      context === null && previous.context === null && previous.revision === revision);
    const sameAccount = sharesDisplayContext &&
      (context !== null || value.ownershipKey !== null && value.ownershipKey === previous.value.ownershipKey) &&
      value.authMode === previous.value.authMode && value.planType === previous.value.planType;
    let displayed = value;
    if (sameAccount && value.authMode === "chatgpt" && value.usageStatus === "unavailable" &&
        previous.value.usageObservedAt !== null) {
      displayed = { ...value, windows: previous.value.windows, credits: previous.value.credits,
        resetCredits: previous.value.resetCredits, usageObservedAt: previous.value.usageObservedAt };
    }
    if (!includeBilling && value.authMode === "api-key" && previous?.revision === revision && previous.value.billing.actualCosts) {
      displayed = { ...displayed, billing: previous.value.billing };
    }
    if (revision !== this.cacheRevision() || context !== this.accountDisplayContext()) return null;
    this.displayedAccounts.set(kind, { revision, context, value: displayed });
    return displayed;
  }
  /** Exact in-memory failure for local diagnostics; never projected to clients. */
  accountReadFailure(kind: CodexBackendKind): unknown | null {
    const failure = this.accountFailures.get(kind);
    return failure?.revision === this.cacheRevision() ? failure.error : null;
  }
  /**
   * Fast structural refreshes retain the last displayed value while a fresh
   * account read is in flight. A token/config revision requests fresh data;
   * only a proven account and applied CLI identity permits display reuse.
   * Unknown identity requires a fresh read before displaying numeric usage.
   */
  cachedAccount(kind: CodexBackendKind): CodexAccountSnapshot | null {
    const cached = this.displayedAccounts.get(kind);
    if (!cached) return null;
    const context = this.accountDisplayContext();
    if (context !== null && context === cached.context) {
      return cached.value;
    }
    // Keep an unknown-context value only as a private merge candidate for a
    // fresh, same-account result. Never project it onto a structural response.
    if (context === null && cached.context === null && cached.revision === this.cacheRevision()) return null;
    this.displayedAccounts.delete(kind);
    return null;
  }
  private async withBilling(account: CodexAccountSnapshot | null): Promise<CodexAccountSnapshot | null> {
    if (!account || account.authMode !== "api-key") return account;
    const costs = await this.billing.snapshot();
    return { ...account, billing: { ...account.billing, costsAvailable: costs.status === "available", actualCosts: costs } };
  }
  async readCliAccount(): Promise<CodexAccountSnapshot> {
    if (this.accountReader) {
      const account = await this.accountReader();
      if (!account) throw new Error("CODEX_ACCOUNT_UNAVAILABLE: Codex account information is unavailable.");
      return account;
    }
    const context = await this.acquireContext();
    const rpc = new JsonRpcProcess({ command: context.selection.command, args: ["app-server", "--listen", "stdio://"],
      env: context.environment, cwd: context.managementCwd,
      debugLabel: "Codex account", omitJsonRpcHeader: true });
    try {
      const initialized = await rpc.request("initialize", { clientInfo: { name: "codex_bridge_account", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 15_000 });
      validateInitializeResponse(initialized);
      await rpc.notify("initialized", {});
      const account = await rpc.request("account/read", { refreshToken: false }, { timeoutMs: 15_000 });
      const mode = projectCodexAccount(account, null).authMode;
      const limits = mode === "chatgpt" ? await rpc.request("account/rateLimits/read", undefined, { timeoutMs: 15_000 }).catch(() => null) : null;
      return projectCodexAccount(account, limits);
    } finally { try { await rpc.close(); } finally { await context.release(); } }
  }
  private readRecord(group: string, id: string): Record<string, unknown> | null {
    try {
      return parseJsonUtf8Strict<Record<string, unknown>>(
        readFileSync(path.join(path.join(this.cli.root, "service"), group, `${id}.json`)),
        "Codex service record"
      );
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("CODEX_CONTEXT_INVALID"); }
  }
  private writeRecord(group: string, id: string, value: unknown): void {
    const directory = path.join(path.join(this.cli.root, "service"), group);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temporary, file);
  }
}
