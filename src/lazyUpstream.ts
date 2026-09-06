import type { CodexBackendKind } from "./config.js";
import type { BackendCapabilities } from "./modelPolicy.js";
import type { CodexUpstream } from "./upstream.js";

type Args<K extends keyof CodexUpstream> = Parameters<NonNullable<CodexUpstream[K]>>;

/** Defers environment admission until this backend is actually used. */
export class LazyCodexUpstream implements CodexUpstream {
  private instance?: CodexUpstream;
  private starting?: Promise<CodexUpstream>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly kind: CodexBackendKind, private readonly features: BackendCapabilities,
    private readonly factory: () => Promise<CodexUpstream>, private readonly dispose?: () => Promise<void>, private readonly guard?: () => void) {}

  capabilities(): BackendCapabilities { return this.features; }
  listTools() { return this.instance?.listTools() || Promise.resolve({ backendKind: this.kind, initialized: false, capabilities: this.features }); }
  async callTool(...args: Args<"callTool">) { const instance = await this.get(); this.guard?.(); return instance.callTool(...args); }
  async listModels(...args: Args<"listModels">) { return (await this.method("listModels"))(...args); }
  async readAccountSnapshot() { return (await this.method("readAccountSnapshot"))(); }
  async readAccountRateLimits() { return (await this.method("readAccountRateLimits"))(); }
  async startThread(...args: Args<"startThread">) { return (await this.method("startThread"))(...args); }
  async continueThread(...args: Args<"continueThread">) { return (await this.method("continueThread"))(...args); }
  async forkThread(...args: Args<"forkThread">) { return (await this.method("forkThread"))(...args); }
  async archiveThread(...args: Args<"archiveThread">) { return (await this.method("archiveThread"))(...args); }
  async restoreThread(...args: Args<"restoreThread">) { return (await this.method("restoreThread"))(...args); }
  async probeThread(...args: Args<"probeThread">) { return (await this.method("probeThread"))(...args); }
  async listBackgroundTerminals(...args: Args<"listBackgroundTerminals">) { return (await this.method("listBackgroundTerminals"))(...args); }
  async listLoadedBackgroundTerminals(...args: Args<"listLoadedBackgroundTerminals">) { return this.instance?.listLoadedBackgroundTerminals?.(...args) ?? null; }
  async terminateBackgroundTerminal(...args: Args<"terminateBackgroundTerminal">) { return (await this.method("terminateBackgroundTerminal"))(...args); }
  async forceTerminateWorker(...args: Args<"forceTerminateWorker">) { return (await this.method("forceTerminateWorker"))(...args); }
  async respondToInteraction(...args: Args<"respondToInteraction">) { return (await this.method("respondToInteraction"))(...args); }
  async steerThread(...args: Args<"steerThread">) { return (await this.method("steerThread"))(...args); }
  canResumeThread(...args: Args<"canResumeThread">) { return this.instance?.canResumeThread?.(...args); }
  canSteerThread(...args: Args<"canSteerThread">) { return this.instance?.canSteerThread?.(...args) === true; }

  async close(): Promise<void> {
    this.closed = true;
    return this.closing ||= (async () => {
      try { await this.starting?.catch(() => undefined); await this.instance?.close(); }
      finally { await this.dispose?.(); }
    })();
  }
  private async get(): Promise<CodexUpstream> {
    if (this.closed) throw new Error("Codex backend is closed.");
    if (this.instance) return this.instance;
    if (!this.starting) this.starting = this.factory().then(instance => { this.instance = instance; return instance; })
      .finally(() => { this.starting = undefined; });
    const instance = await this.starting;
    if (this.closed) throw new Error("Codex backend is closed.");
    return instance;
  }
  private async method<K extends keyof CodexUpstream>(name: K): Promise<NonNullable<CodexUpstream[K]>> {
    const instance = await this.get();
    if (["listModels", "startThread", "continueThread", "forkThread"].includes(name)) this.guard?.();
    const method = instance[name];
    if (typeof method !== "function") throw new Error(`Codex backend ${this.kind} does not support ${name}.`);
    return method.bind(instance) as NonNullable<CodexUpstream[K]>;
  }
}
