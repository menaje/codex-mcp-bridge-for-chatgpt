import { CodexBilling } from "./codexBilling.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CodexRuntimeManager } from "./codexRuntime.js";
import type { CodexBackendKind } from "./config.js";
import { JsonRpcProcess } from "./jsonRpcProcess.js";
import { projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
import { validateInitializeResponse } from "./runtimeCompatibility.js";
import { decodeUtf8Strict, parseJsonTextStrict, parseJsonUtf8Strict } from "./textIntegrity.js";

export type CodexSessionPolicy = { contextId?: string; visibleInCodexApp: boolean; persistent: boolean; persistence: "persistent" | "ephemeral"; constraint?: "hidden-persistent-unsupported" };
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
  private displayedAccounts = new Map<CodexBackendKind, { revision: string; value: CodexAccountSnapshot }>();
  private accountFailures = new Map<CodexBackendKind, { revision: string; error: unknown }>();
  constructor(readonly environment: NodeJS.ProcessEnv = process.env, cli?: CodexRuntimeManager) {
    this.cli = cli || new CodexRuntimeManager({ environment });
    this.billing = new CodexBilling(this.cli.root);
  }
  setVisibilityProvider(provider: () => boolean): void { this.visibility = provider; this.setAppVisibility(provider()); }
  setAppVisibility(visible: boolean): void {
    const saved = this.readRecord("policy", "visibility");
    if (saved?.visible !== visible) this.writeRecord("policy", "visibility", { visible });
  }
  private appVisibility(): boolean { return this.visibility?.() ?? this.readRecord("policy", "visibility")?.visible === true; }
  modelRevision(): string { return digest(this.cacheRevision() + JSON.stringify([...this.accountIdentities])); }
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
  admissionGuard(home?: string): () => void {
    let identity: string | undefined;
    return () => {
      const current = this.authenticationIdentity(home);
      if (identity !== undefined && current !== identity) throw new Error("CODEX_AUTH_CHANGED: Authentication changed after this worker was started. Finish active work and restart the bridge before starting another turn.");
      identity = current;
    };
  }
  cacheRevision(): string {
    const shared = this.environment.CODEX_HOME || path.join(this.environment.HOME || homedir(), ".codex");
    const files = [path.join(this.cli.root, "cli-state.json"), ...["auth.json", "config.toml"].map(name => path.join(shared, name))];
    const values = files.map(file => {
      try { return decodeUtf8Strict(readFileSync(file), `runtime input ${path.basename(file)}`); }
      catch { return "unavailable"; }
    });
    const state = (() => { try { return parseJsonTextStrict<any>(values[0], "runtime state"); } catch { return {}; } })();
    // Installation progress and update-check timestamps do not change the account.
    for (const index of [0]) {
      try { const runtime = parseJsonTextStrict<any>(values[index], "runtime state"); values[index] = JSON.stringify(runtime.selection ?? null); } catch { /* Preserve the unavailable marker. */ }
    }
    let binary = "";
    try { const info = statSync(this.environment.CODEX_MCP_BRIDGE_CODEX || state.selection?.command || ""); binary = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`; } catch { /* Missing selection invalidates the next admission. */ }
    return digest(JSON.stringify([this.appVisibility(), ...values, binary, this.environment.OPENAI_API_KEY, this.environment.CODEX_API_KEY]));
  }
  async sessionPolicy(kind: CodexBackendKind, visible: boolean, _parent?: string, persistence: "persistent" | "ephemeral" = visible ? "persistent" : "ephemeral"): Promise<CodexSessionPolicy> {
    if (kind !== "app-server") throw new Error("CODEX_BACKEND_RETIRED: Start a fresh App Server context with an explicit handoff summary. Existing history is preserved.");
    if (persistence === "persistent" && !visible) throw new Error("HIDDEN_PERSISTENT_UNSUPPORTED: This Codex version has no verified durable-but-hidden creation option. Enable Codex app visibility for resumable conversations, or explicitly use a memory-only conversation.");
    if (persistence === "ephemeral" && visible) throw new Error("EPHEMERAL_NOT_VISIBLE: Memory-only conversations cannot be shown in the Codex app.");
    return { visibleInCodexApp: visible, persistent: persistence === "persistent", persistence,
      ...(!visible ? { constraint: "hidden-persistent-unsupported" as const } : {}) };
  }
  async readAccount(kind: CodexBackendKind, includeBilling = false): Promise<CodexAccountSnapshot | null> {
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
    if (value) {
      const previous = this.displayedAccounts.get(kind);
      const displayed = !includeBilling && value.authMode === "api-key" && previous?.revision === revision && previous.value.billing.actualCosts
        ? { ...value, billing: previous.value.billing } : value;
      this.displayedAccounts.set(kind, { revision, value: displayed });
    }
    return value;
  }
  /** Exact in-memory failure for local diagnostics; never projected to clients. */
  accountReadFailure(kind: CodexBackendKind): unknown | null {
    const failure = this.accountFailures.get(kind);
    return failure?.revision === this.cacheRevision() ? failure.error : null;
  }
  /**
   * Fast structural refreshes retain the last displayed value while a fresh
   * account read is in flight. The revision check is the invalidation boundary:
   * authentication, configuration, or runtime selection changes must never
   * reuse a value from the previous context. `observedAt` communicates age to
   * the UI, so elapsed time alone must not create a blank refresh interval.
   */
  cachedAccount(kind: CodexBackendKind): CodexAccountSnapshot | null {
    const cached = this.displayedAccounts.get(kind);
    return cached?.revision === this.cacheRevision() ? cached.value : null;
  }
  private async withBilling(account: CodexAccountSnapshot | null): Promise<CodexAccountSnapshot | null> {
    if (!account || account.authMode !== "api-key") return account;
    const costs = await this.billing.snapshot();
    return { ...account, billing: { ...account.billing, costsAvailable: costs.status === "available", actualCosts: costs } };
  }
  async readCliAccount(): Promise<CodexAccountSnapshot> {
    const { selection, release } = await this.cli.acquire();
    const rpc = new JsonRpcProcess({ command: selection.command, args: ["app-server", "--listen", "stdio://"],
      env: this.environment, cwd: stableCodexWorkingDirectory(this.environment),
      debugLabel: "Codex account", omitJsonRpcHeader: true });
    try {
      const initialized = await rpc.request("initialize", { clientInfo: { name: "codex_bridge_account", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 15_000 });
      validateInitializeResponse(initialized);
      await rpc.notify("initialized", {});
      const account = await rpc.request("account/read", { refreshToken: false }, { timeoutMs: 15_000 });
      const mode = projectCodexAccount(account, null).authMode;
      const limits = mode === "chatgpt" ? await rpc.request("account/rateLimits/read", undefined, { timeoutMs: 15_000 }).catch(() => null) : null;
      return projectCodexAccount(account, limits);
    } finally { try { await rpc.close(); } finally { await release(); } }
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
