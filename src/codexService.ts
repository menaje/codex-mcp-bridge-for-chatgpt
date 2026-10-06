import { CodexBilling } from "./codexBilling.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CodexRuntimeManager, type CliSelection } from "./codexRuntime.js";
import type { CliProtocolSupport } from "./cliProtocol.js";
import type { BackendCapabilities } from "./modelPolicy.js";
import type { CodexBackendKind } from "./config.js";
import { JsonRpcProcess } from "./jsonRpcProcess.js";
import { codexChatgptOwnerKey, codexChatgptPrincipalKey, projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
import { assertEffectiveCodexAuthPolicy, effectiveCodexAuthPolicyIdentity,
  effectiveCodexCredentialStore, parseCodexLocalAuthPolicy,
  type CodexEffectiveAuthPolicy, type CodexLocalAuthPolicy } from "./codexAuthPolicy.js";
import { validateInitializeResponse } from "./runtimeCompatibility.js";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./textIntegrity.js";
import { codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import { assertAuthProfileStorageEnvironment } from "../scripts/auth-selection.mjs";

export type CodexSessionPolicy = { contextId?: string; visibleInCodexApp: boolean; persistent: boolean; persistence: "persistent" | "ephemeral"; constraint?: "app-visibility-unverified" };
/** Non-secret ownership evidence for read-only projections; never grants execution. */
export type CodexSessionAuthBoundaryEvidence = {
  key: string;
  allowLegacyShared: false;
  ownerStatus: "observed" | "last-confirmed" | "unverified";
  ownerConfirmedAt: number | null;
  snapshotAt: number;
};
export type ResolvedCodexContext = {
  selection: CliSelection;
  environment: NodeJS.ProcessEnv;
  runtimeHome: string;
  managementCwd: string;
  fingerprint: string;
  protocol?: CliProtocolSupport;
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

type CredentialEvidence = { identity: string; ownerKey: string; workspaceKey: string | null;
  authMode: "chatgpt" | "api-key" };

function fileTokenUserId(token: unknown, workspaceId: string): string | null {
  if (typeof token !== "string" || token.length > 32_768) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return null;
  try {
    const claims = parseJsonUtf8Strict<Record<string, unknown>>(
      Buffer.from(parts[1]!, "base64url"), "Codex ID token claims");
    const auth = claims["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
    const fields = auth as Record<string, unknown>;
    if (typeof fields.chatgpt_account_id === "string" && fields.chatgpt_account_id !== workspaceId) return null;
    const userId = fields.chatgpt_user_id || fields.user_id;
    return typeof userId === "string" && userId.trim() === userId && userId.length > 0 ? userId : null;
  } catch { return null; }
}
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
    const workspaceId = typeof auth.tokens?.account_id === "string" && auth.tokens.account_id || null;
    const restrictions = [policy.forcedMethod, policy.workspaceId];
    const userId = workspaceId ? fileTokenUserId(auth.tokens?.id_token, workspaceId) : null;
    if (auth.auth_mode === "chatgpt" && workspaceId && userId) return {
      identity: digest(JSON.stringify(["chatgpt", userId, workspaceId, restrictions])),
      ownerKey: codexChatgptPrincipalKey(userId, workspaceId),
      workspaceKey: codexChatgptOwnerKey(workspaceId), authMode: "chatgpt"
    };
    if (auth.auth_mode === "apiKey") {
      const key = auth.OPENAI_API_KEY || environment.OPENAI_API_KEY || environment.CODEX_API_KEY;
      if (typeof key === "string" && key) return {
        identity: digest(JSON.stringify(["apiKey", key, restrictions])),
        ownerKey: digest(JSON.stringify(["api-key", key])), workspaceKey: null, authMode: "api-key"
      };
    }
  } catch { /* An absent or unreadable file does not prove credential ownership. */ }
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

export function codexCredentialWorkspaceKey(directory: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  try { return credentialEvidence(directory, environment, localAuthPolicy(directory))?.workspaceKey || null; }
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
  private accounts = new Map<CodexBackendKind, { revision: string; expires: number; pending: boolean; request: Promise<CodexAccountSnapshot | null> }>();
  private displayedAccounts = new Map<CodexBackendKind, { revision: string; context: string | null; value: CodexAccountSnapshot }>();
  private accountFailures = new Map<CodexBackendKind, { revision: string; error: unknown }>();
  private accountReader?: () => Promise<CodexAccountSnapshot | null>;
  private authPolicyReader?: () => Promise<CodexEffectiveAuthPolicy>;
  /** Read-only evidence for reusing a displayed file-backed account. */
  private displayPolicy: { localKey: string; effectiveKey: string; store: string | null } | null = null;
  private displayPolicyReadGeneration = 0;
  private executionAdmissionGuard?: () => Promise<void>;
  private confirmedSessionOwnerKey: string | null = null;
  private confirmedSessionOwnerAt: number | null = null;
  private confirmedSessionLocalPolicyKey: string | null = null;
  private confirmedSessionSource: "file" | "environment" | "codex" | null = null;
  private confirmedEffectiveCredentialStore: string | null = null;
  private effectivePolicyConfirmed = false;
  private currentOwnerConfirmed = false;
  private currentExecutionBoundaryKey: string | null = null;
  private currentExecutionPolicyKey: string | null = null;
  private currentExecutionCliFingerprint: string | null = null;
  private readonly unknownSessionIdentity = randomUUID();
  constructor(readonly environment: NodeJS.ProcessEnv = process.env, cli?: CodexRuntimeManager) {
    this.cli = cli || new CodexRuntimeManager({ environment: codexProcessEnvironment(environment) });
    this.billing = new CodexBilling(this.cli.root);
  }
  async acquireContext(): Promise<ResolvedCodexContext> {
    const { selection, fingerprint, protocol, release } = await this.cli.acquire();
    try {
      return {
        selection,
        environment: codexProcessEnvironment(this.environment),
        runtimeHome: this.cli.root,
        managementCwd: stableCodexWorkingDirectory(this.environment),
        fingerprint,
        protocol,
        authenticationIdentity: this.authenticationIdentity(),
        release
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  /** Reuse the selected installation's schema check, including before the first Job.
   * Settings projections have no execution upstream and must not invent its capabilities. */
  async readCapabilities(): Promise<BackendCapabilities | undefined> {
    const context = await this.acquireContext();
    try { return context.protocol?.capabilities; }
    finally { await context.release(); }
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
    this.displayPolicy = null;
    this.displayPolicyReadGeneration += 1;
    this.effectivePolicyConfirmed = false;
    this.confirmedEffectiveCredentialStore = null;
    this.confirmedSessionOwnerKey = null;
    this.confirmedSessionOwnerAt = null;
    this.confirmedSessionLocalPolicyKey = null;
    this.confirmedSessionSource = null;
    this.currentOwnerConfirmed = false;
    this.currentExecutionBoundaryKey = null;
    this.currentExecutionPolicyKey = null;
    this.currentExecutionCliFingerprint = null;
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
    let effectiveKey: string | null = null;
    if (this.authPolicyReader) {
      let localKey: string;
      try { localKey = digest(JSON.stringify(localAuthPolicy(home))); }
      catch { return null; }
      if (!this.displayPolicy || this.displayPolicy.localKey !== localKey) return null;
      effectiveKey = this.displayPolicy.effectiveKey;
    }
    const fileMayBeActive = !["keyring", "auto", "ephemeral"].includes(this.displayPolicy?.store || "");
    const identity = fileMayBeActive ? this.authenticationIdentity(home) : null;
    return identity ? digest(JSON.stringify([home, this.cli.appliedContextFingerprint(), identity, effectiveKey])) : null;
  }
  /** Persisted work follows its proven owner; CLI compatibility stays in admission. */
  sessionAuthBoundary(): CodexSessionAuthBoundaryEvidence {
    const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    // An explicitly reused external home has the same owner boundary as that
    // home under a CODEX_HOME override; the selection mechanism is not an owner.
    const configuredSource = this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE || "shared";
    const source = configuredSource === "external" ? "shared" : configuredSource;
    const generation = this.environment.CODEX_MCP_BRIDGE_AUTH_GENERATION || "0";
    let policyKey: string | null = null;
    let observedOwner: string | null = null;
    try {
      assertAuthProfileStorageEnvironment(this.environment);
      const policy = localAuthPolicy(home);
      policyKey = digest(JSON.stringify([policy.credentialStore, policy.forcedMethod, policy.workspaceId]));
      observedOwner = (!this.authPolicyReader || this.effectivePolicyConfirmed) &&
        !["keyring", "auto", "ephemeral"].includes(this.confirmedEffectiveCredentialStore || "")
        ? credentialEvidence(home, this.environment, policy)?.ownerKey || null : null;
    } catch { /* An unknown policy cannot authorize a stored conversation. */ }
    const snapshotAt = Date.now();
    if (observedOwner) {
      this.confirmedSessionOwnerKey = observedOwner;
      this.confirmedSessionOwnerAt = snapshotAt;
      this.confirmedSessionLocalPolicyKey = policyKey;
    }
    const retainedOwner = policyKey !== null && policyKey === this.confirmedSessionLocalPolicyKey
      ? this.confirmedSessionOwnerKey : null;
    const owner = observedOwner || retainedOwner;
    return {
      key: digest(JSON.stringify(["auth-owner-v2", source, path.resolve(home),
        owner ? ["owner", owner] : ["unverified", generation, this.unknownSessionIdentity]])),
      allowLegacyShared: false,
      ownerStatus: observedOwner ? "observed" : owner ? "last-confirmed" : "unverified",
      ownerConfirmedAt: owner ? this.confirmedSessionOwnerAt : null,
      snapshotAt
    };
  }
  /** A successful current admission check, unlike read-only last-confirmed history. */
  currentExecutionAuthBoundary(): string | null {
    if (!this.currentOwnerConfirmed) return null;
    const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    try {
      const policy = localAuthPolicy(home);
      const policyKey = digest(JSON.stringify([policy.credentialStore, policy.forcedMethod, policy.workspaceId]));
      const evidence = this.sessionAuthBoundary();
      if (policyKey === this.currentExecutionPolicyKey &&
          this.cli.appliedContextFingerprint() === this.currentExecutionCliFingerprint &&
          evidence.key === this.currentExecutionBoundaryKey) {
        return evidence.key;
      }
    } catch { /* A changed or unreadable local policy cannot authorize new execution. */ }
    this.currentOwnerConfirmed = false;
    return null;
  }
  /** Validate current execution conditions; stored work access is independent. */
  assertCurrentAdmission(): Promise<void> {
    return this.admissionGuard()();
  }
  admissionGuard(home?: string): () => Promise<void> {
    if (!home && this.executionAdmissionGuard) return this.executionAdmissionGuard;
    let cliFingerprint: string | undefined;
    let previousCredentialContext: string | undefined;
    let pending: Promise<void> = Promise.resolve();
    const check = async () => {
      this.currentOwnerConfirmed = false;
      assertAuthProfileStorageEnvironment(this.environment);
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
      let currentOwnerKey: string | null;
      let currentWorkspaceKey: string | null;
      let currentSource: "file" | "environment" | "codex";
      let currentMode: "chatgpt" | "api-key";
      if (fileEvidence) {
        current = fileEvidence.identity;
        currentOwnerKey = fileEvidence.ownerKey;
        currentWorkspaceKey = fileEvidence.workspaceKey;
        currentSource = "file";
        currentMode = fileEvidence.authMode;
      } else {
        // The selected Codex authenticates execution. Optional user claims are
        // not another Bridge principal or a permanent local-work ACL.
        let account: CodexAccountSnapshot | null;
        try { account = await this.readCliAccount(); }
        catch { throw new Error("CODEX_AUTH_UNAVAILABLE: Codex account status cannot currently be verified. Retry after the account check recovers."); }
        if (!account?.authenticated) throw new Error("CODEX_AUTH_REQUIRED: Sign in to Codex before starting new work.");
        if (account.authMode !== "chatgpt" && account.authMode !== "api-key") {
          throw new Error("CODEX_AUTH_UNAVAILABLE: The current Codex authentication method cannot be verified.");
        }
        const environmentApiKey = ["keyring", "auto", "ephemeral"].includes(String(managedStore ?? policy.credentialStore))
          ? undefined : this.environment.OPENAI_API_KEY || this.environment.CODEX_API_KEY;
        currentOwnerKey = account.authMode === "api-key" && environmentApiKey
          ? digest(JSON.stringify(["api-key", environmentApiKey])) : null;
        // A conflicting optional usage reply is not workspace authorization.
        currentWorkspaceKey = account.ownershipConflict ? null : account.workspaceKey;
        current = digest(JSON.stringify([account.authMode, currentOwnerKey, currentWorkspaceKey, currentPolicyKey]));
        currentSource = currentOwnerKey ? "environment" : "codex";
        currentMode = account.authMode;
      }
      if (policy.forcedMethod && policy.forcedMethod !== (currentMode === "api-key" ? "api" : "chatgpt") ||
          policy.workspaceId && (currentMode !== "chatgpt" ||
            codexChatgptOwnerKey(policy.workspaceId) !== currentWorkspaceKey)) {
        throw new Error("CODEX_AUTH_POLICY_MISMATCH: The current login conflicts with local Codex restrictions.");
      }
      if (effectivePolicy) assertEffectiveCodexAuthPolicy(effectivePolicy, currentMode, currentWorkspaceKey,
        this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE === "bridge-chatgpt" ||
        this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE === "bridge-api");
      const currentManagedPolicyKey = effectivePolicy
        ? digest(effectiveCodexAuthPolicyIdentity(effectivePolicy)) : "none";
      if (cliFingerprint !== undefined && cliFingerprint !== currentCliFingerprint) {
        throw new Error("CODEX_CLI_CHANGED: The selected Codex CLI changed. Restart the Bridge to verify the new runtime before starting another turn.");
      }
      const credentialContext = digest(JSON.stringify([current, currentSource, currentPolicyKey, currentManagedPolicyKey]));
      if (previousCredentialContext !== undefined && previousCredentialContext !== credentialContext) {
        this.accounts.clear();
        this.accountFailures.clear();
        this.displayedAccounts.clear();
        this.accountIdentities.clear();
      }
      previousCredentialContext = credentialContext;
      cliFingerprint = currentCliFingerprint;
      this.confirmedSessionOwnerKey = currentOwnerKey;
      this.confirmedSessionOwnerAt = Date.now();
      this.confirmedSessionLocalPolicyKey = currentPolicyKey;
      this.confirmedSessionSource = currentSource;
      this.confirmedEffectiveCredentialStore = typeof managedStore === "string" ? managedStore : null;
      this.effectivePolicyConfirmed = true;
      this.currentExecutionBoundaryKey = this.sessionAuthBoundary().key;
      this.currentExecutionPolicyKey = currentPolicyKey;
      this.currentExecutionCliFingerprint = currentCliFingerprint;
      this.currentOwnerConfirmed = true;
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
  async sessionPolicy(kind: CodexBackendKind, visible: boolean, _parent?: string, persistence: "persistent" | "ephemeral" = "persistent"): Promise<CodexSessionPolicy> {
    if (kind !== "app-server") throw new Error("CODEX_BACKEND_RETIRED: Start a fresh App Server context with an explicit handoff summary. Existing history is preserved.");
    if (persistence === "ephemeral" && visible) throw new Error("EPHEMERAL_NOT_VISIBLE: Memory-only conversations cannot be shown in the Codex app.");
    const appHome = path.join(this.environment.HOME || homedir(), ".codex");
    const executionHome = this.environment.CODEX_HOME || appHome;
    let sharesAppStorage = path.resolve(executionHome) === path.resolve(appHome);
    try { sharesAppStorage = realpathSync(executionHome) === realpathSync(appHome); } catch { /* Not yet materialized. */ }
    const sqliteHome = this.environment.CODEX_SQLITE_HOME;
    if (sqliteHome && path.resolve(sqliteHome) !== path.resolve(appHome)) sharesAppStorage = false;
    const visibleInCodexApp = visible && sharesAppStorage && persistence === "persistent";
    return { visibleInCodexApp, persistent: persistence === "persistent", persistence,
      ...(!visibleInCodexApp && persistence === "persistent" ? { constraint: "app-visibility-unverified" as const } : {}) };
  }
  async readAccount(kind: CodexBackendKind, includeBilling = false, requireFresh = false): Promise<CodexAccountSnapshot | null> {
    // Observe and permanently evict a confirmed display-boundary change before
    // a failed request could later resurrect the old account.
    this.cachedAccount(kind);
    const revision = this.cacheRevision(), cached = this.accounts.get(kind);
    const policyReader = this.authPolicyReader;
    const policyGeneration = policyReader ? ++this.displayPolicyReadGeneration : 0;
    // Observe display policy alongside the account request. This is not an
    // execution admission check and cannot mark an owner as authorized.
    const displayPolicyRequest = policyReader && this.authenticationIdentity()
      ? Promise.resolve().then(policyReader).catch(() => null) : null;
    // A display with no stable file identity (Keyring/auto) must confirm the
    // account on each refresh. Share an in-flight request, but never treat its
    // completed 15-second cache entry as a new account observation.
    const request = cached?.revision === revision &&
      (cached.pending || !requireFresh && cached.expires > Date.now()) ? cached.request : (async () => {
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
    if (request !== cached?.request) {
      const entry = { revision, expires: Date.now() + 15_000, pending: true, request };
      this.accounts.set(kind, entry);
      void request.then(() => { entry.pending = false; });
    }
    const value = includeBilling ? await this.withBilling(await request) : await request;
    if (revision !== this.cacheRevision()) return null;
    if (!value) return null;
    if (displayPolicyRequest) {
      const policy = await displayPolicyRequest;
      if (revision !== this.cacheRevision()) return null;
      if (policy && policyReader === this.authPolicyReader &&
          policyGeneration === this.displayPolicyReadGeneration) {
        try {
          const store = effectiveCodexCredentialStore(policy);
          if (store != null && !["file", "keyring", "auto", "ephemeral"].includes(String(store))) {
            throw new Error("Unknown credential storage.");
          }
          const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
          const local = localAuthPolicy(home);
          const file = credentialEvidence(home, this.environment, local);
          if (!file || !value.authenticated || value.authMode !== file.authMode || value.ownershipConflict ||
              value.workspaceKey && value.workspaceKey !== file.workspaceKey) {
            throw new Error("The current account does not match the file-backed display identity.");
          }
          assertEffectiveCodexAuthPolicy(policy, value.authMode, value.workspaceKey || file.workspaceKey,
            ["bridge-chatgpt", "bridge-api"].includes(this.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE || ""));
          this.displayPolicy = {
            localKey: digest(JSON.stringify(local)),
            effectiveKey: digest(effectiveCodexAuthPolicyIdentity(policy)),
            store: typeof store === "string" ? store : null
          };
        } catch { this.displayPolicy = null; }
      }
    }
    const context = this.accountDisplayContext();
    if (revision !== this.cacheRevision()) return null;
    const previous = this.displayedAccounts.get(kind);
    const sharesDisplayContext = previous && (context !== null && previous.context === context ||
      context === null && previous.context === null && previous.revision === revision);
    const sameAccount = sharesDisplayContext &&
      context !== null &&
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
    // An unknown-context value needs a fresh read before presentation. It
    // cannot establish same-user continuity or a structural cached response.
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
      try {
        const account = await this.accountReader();
        if (!account) throw new Error("CODEX_ACCOUNT_UNAVAILABLE: Codex account information is unavailable.");
        this.observeAccountOwner(account);
        return account;
      } catch (error) {
        if (this.confirmedSessionSource === "environment" || this.confirmedSessionSource === "codex") this.currentOwnerConfirmed = false;
        throw error;
      }
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
      const snapshot = projectCodexAccount(account, limits);
      this.observeAccountOwner(snapshot);
      return snapshot;
    } catch (error) {
      if (this.confirmedSessionSource === "environment" || this.confirmedSessionSource === "codex") this.currentOwnerConfirmed = false;
      throw error;
    } finally { try { await rpc.close(); } finally { await context.release(); } }
  }
  private observeAccountOwner(account: CodexAccountSnapshot): void {
    if ((this.confirmedSessionSource === "environment" || this.confirmedSessionSource === "codex") &&
        (!account.authenticated || account.authMode === "unknown" ||
          this.confirmedSessionSource === "environment" && account.authMode !== "api-key")) {
      this.currentOwnerConfirmed = false;
    }
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
