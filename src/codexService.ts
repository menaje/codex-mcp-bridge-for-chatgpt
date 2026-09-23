import { CodexBilling } from "./codexBilling.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CodexRuntimeManager, type CliSelection } from "./codexRuntime.js";
import type { CodexBackendKind } from "./config.js";
import { JsonRpcProcess } from "./jsonRpcProcess.js";
import { projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
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
  authenticationIdentity: string;
  release: () => Promise<void>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

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
  setAppVisibility(visible: boolean): void {
    const saved = this.readRecord("policy", "visibility");
    if (saved?.visible !== visible) this.writeRecord("policy", "visibility", { visible });
  }
  private appVisibility(): boolean { return this.visibility?.() ?? this.readRecord("policy", "visibility")?.visible === true; }
  modelRevision(contextFingerprint?: string): string {
    return digest(this.cacheRevision(contextFingerprint) + JSON.stringify([...this.accountIdentities]));
  }
  authenticationIdentity(home?: string): string {
    const directory = home || this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    try {
      const auth = parseJsonUtf8Strict<Record<string, any>>(
        readFileSync(path.join(directory, "auth.json")),
        "Codex authentication state"
      );
      let subject = auth.tokens?.account_id || null;
      if (!subject && typeof auth.tokens?.id_token === "string") {
        try {
          const encodedPayload = auth.tokens.id_token.split(".")[1];
          if (!encodedPayload || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)) throw new Error("invalid token payload");
          const claims = parseJsonUtf8Strict<Record<string, unknown>>(
            Buffer.from(encodedPayload, "base64url"),
            "Codex identity token"
          );
          const candidate = claims.sub ?? claims.email;
          subject = typeof candidate === "string" ? candidate : null;
        } catch { /* Unknown identity; never expose token content. */ }
      }
      return digest(JSON.stringify([auth.auth_mode, auth.OPENAI_API_KEY, subject]));
    } catch { return "keyring-or-unavailable"; }
  }
  /** Stable display boundary, independent of token/config refresh inputs. */
  accountDisplayContext(): string | null {
    const home = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    try {
      const auth = parseJsonUtf8Strict<Record<string, any>>(
        readFileSync(path.join(home, "auth.json")), "Codex authentication state"
      );
      let subject: string | null = null;
      if (auth.auth_mode === "chatgpt") {
        subject = typeof auth.tokens?.account_id === "string" && auth.tokens.account_id
          ? auth.tokens.account_id : null;
        if (!subject && typeof auth.tokens?.id_token === "string") {
          try {
            const payload = auth.tokens.id_token.split(".")[1];
            if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
            const claims = parseJsonUtf8Strict<Record<string, unknown>>(
              Buffer.from(payload, "base64url"), "Codex identity token"
            );
            const claim = claims.sub ?? claims.email;
            subject = typeof claim === "string" && claim ? claim : null;
          } catch { return null; }
        }
      } else if (auth.auth_mode === "apiKey") {
        const key = auth.OPENAI_API_KEY || this.environment.OPENAI_API_KEY || this.environment.CODEX_API_KEY;
        subject = typeof key === "string" && key ? key : null;
      }
      if (!subject) return null;
      return digest(JSON.stringify([home, this.cli.appliedContextFingerprint(), auth.auth_mode, subject]));
    } catch { return null; }
  }
  admissionGuard(home?: string): () => void {
    let identity: string | undefined;
    return () => {
      const current = this.authenticationIdentity(home);
      if (identity !== undefined && current !== identity) throw new Error("CODEX_AUTH_CHANGED: Authentication changed after this worker was started. Finish active work and restart the bridge before starting another turn.");
      identity = current;
    };
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
    const sameAccount = sharesDisplayContext && value.accountKey !== null && previous.value.accountKey === value.accountKey &&
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
