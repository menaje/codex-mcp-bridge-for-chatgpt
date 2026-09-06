import type { CodexUpstream, UpstreamWorkerAssignment } from "./upstream.js";
import { CodexService, type CodexExecutionContext } from "./codexService.js";
import { CodexAppServerUpstreamPool, APP_SERVER_CAPABILITIES, type CodexAppServerProtocolOptions } from "./appServerUpstream.js";
import { LazyCodexUpstream } from "./lazyUpstream.js";
import { withRuntimeLock } from "./codexRuntime.js";
import { inspectSdkBundle, readSdkAuthPolicy, readSdkAuthStatus, sdkAuthArguments, sdkEnvironment, sdkWorkerArguments } from "./sdkRuntime.js";

export const SDK_CAPABILITIES = { ...APP_SERVER_CAPABILITIES, supportsBackgroundTerminals: false, supportsEphemeralThreads: false };

/** The protocol reducer is shared; the SDK is the only transport for this adapter. */
class SdkProfileUpstream extends LazyCodexUpstream {
  constructor(poolSize: number, options: CodexAppServerProtocolOptions, environment: NodeJS.ProcessEnv, context: CodexExecutionContext, service: CodexService) {
    let release: (() => Promise<void>) | undefined;
    super("codex-sdk", SDK_CAPABILITIES, async () => {
      const manager = service.sdk;
      const { selection: selected, policy } = await withRuntimeLock(manager.root, "auth", async () => {
        const acquired = await manager.acquire();
        release = acquired.release;
        try { return { selection: acquired.selection, policy: { ...await readSdkAuthPolicy(environment), requestedAuthMode: context.authMode } }; }
        catch (error) { await release(); release = undefined; throw error; }
      });
      try {
        const info = await inspectSdkBundle(selected.command, environment);
        const auth = await readSdkAuthStatus(selected.command, environment, context.home, context.authMode);
        if (!auth.authenticated || !auth.resolvedAuthMode) throw new Error("SDK_AUTH_REQUIRED: Configure the selected authentication source in local settings. No fallback was attempted.");
        return new CodexAppServerUpstreamPool(selected.command, poolSize, {
          ...options,
          transport: {
            backendKind: "codex-sdk", workerPrefix: `sdk-${context.id}`, args: [...sdkWorkerArguments(selected.command), ...sdkAuthArguments(policy, environment, context.home)],
            env: sdkEnvironment(environment), runtime: { sdk: info.sdk, python: info.python, codex: info.runtime,
              channel: "stable", requestedAuthMode: policy.requestedAuthMode, resolvedAuthMode: auth.resolvedAuthMode },
            verify: async () => (await inspectSdkBundle(selected.command, environment)).sdk
          }
        });
      } catch (error) { await release?.(); release = undefined; throw error; }
    }, async () => { await release?.(); release = undefined; }, service.admissionGuard(context.home));
  }
}


type Args<K extends keyof CodexUpstream> = Parameters<NonNullable<CodexUpstream[K]>>;

/** Each persisted thread retains its original profile across settings changes and restarts. */
export class CodexSdkUpstream implements CodexUpstream {
  private profiles = new Map<string, LazyCodexUpstream>();
  private workers = new Map<string, string>();
  private closed = false;
  constructor(private readonly poolSize = 4, private readonly options: CodexAppServerProtocolOptions = {},
    private readonly environment: NodeJS.ProcessEnv = process.env, readonly service = new CodexService(environment), private readonly createProfile?: (context: CodexExecutionContext) => LazyCodexUpstream) {}
  capabilities() { return SDK_CAPABILITIES; }
  async listTools() {
    const entries = [...this.profiles];
    const results = await Promise.allSettled(entries.map(([, profile]) => profile.listTools()));
    return { backendKind: "codex-sdk", capabilities: SDK_CAPABILITIES,
      profiles: Object.fromEntries(entries.map(([id], index) => [id, results[index].status === "fulfilled" ? results[index].value : { available: false }])) };
  }
  async listModels() { return this.profile(await this.service.sdkContext()).listModels(); }
  async readAccountSnapshot() { return this.profile(await this.service.sdkContext()).readAccountSnapshot(); }
  async readAccountRateLimits() { return this.profile(await this.service.sdkContext()).readAccountRateLimits(); }
  async callTool(...args: Args<"callTool">) {
    const [name, input, progress, assigned] = args;
    const context = name === "codex-reply" && typeof input.threadId === "string" ? this.service.threadContext(input.threadId)
      : typeof input._bridgeCodexContext === "string" ? this.service.context(input._bridgeCodexContext) : await this.service.sdkContext();
    const forwarded = { ...input }; delete forwarded._bridgeCodexContext;
    return this.profile(context).callTool(name, forwarded, progress, this.assigned(context, assigned));
  }
  async startThread(...args: Args<"startThread">) {
    const [input, progress, assigned] = args;
    const context = input.contextId ? this.service.context(input.contextId) : await this.service.sdkContext();
    return this.profile(context).startThread(input, progress, this.assigned(context, assigned));
  }
  async continueThread(...args: Args<"continueThread">) {
    const [input, progress, assigned] = args, context = this.service.threadContext(input.threadId);
    return this.profile(context).continueThread(input, progress, this.assigned(context, assigned));
  }
  async forkThread(...args: Args<"forkThread">) {
    const [input, progress, assigned] = args, context = this.service.threadContext(input.threadId);
    if (input.contextId && input.contextId !== context.id) throw new Error("SDK_FORK_STORAGE_CHANGE");
    return this.profile(context).forkThread(input, progress, this.assigned(context, assigned));
  }
  async archiveThread(...args: Args<"archiveThread">) { return this.forThread(args[0]).archiveThread(...args); }
  async restoreThread(...args: Args<"restoreThread">) { return this.forThread(args[0]).restoreThread(...args); }
  async probeThread(...args: Args<"probeThread">) { return this.forThread(args[0]).probeThread(...args); }
  async steerThread(...args: Args<"steerThread">) { return this.forThread(args[0]).steerThread(...args); }
  canResumeThread(threadId: string) { try { return this.forThread(threadId).canResumeThread(threadId); } catch { return false; } }
  canSteerThread(threadId: string) { try { return this.forThread(threadId).canSteerThread(threadId); } catch { return false; } }
  async listBackgroundTerminals(): Promise<never> { throw new Error("SDK_BACKGROUND_TERMINALS_UNSUPPORTED"); }
  async listLoadedBackgroundTerminals() { return null; }
  async terminateBackgroundTerminal(): Promise<never> { throw new Error("SDK_BACKGROUND_TERMINALS_UNSUPPORTED"); }
  async respondToInteraction(...args: Args<"respondToInteraction">) {
    const profile = this.profiles.get(this.workers.get(args[0].split(":")[0]) || "");
    if (!profile) throw new Error("SDK_WORKER_UNAVAILABLE");
    return profile.respondToInteraction(...args);
  }
  async forceTerminateWorker(...args: Args<"forceTerminateWorker">) {
    const profile = this.profiles.get(this.workers.get(args[0].workerId) || "");
    if (!profile) throw new Error("SDK_WORKER_UNAVAILABLE");
    return profile.forceTerminateWorker(...args);
  }
  async close() { this.closed = true; await Promise.all([...this.profiles.values()].map(profile => profile.close())); }
  private forThread(threadId: string) { return this.profile(this.service.threadContext(threadId)); }
  private profile(context: CodexExecutionContext) {
    if (this.closed) throw new Error("Codex SDK is closed.");
    let profile = this.profiles.get(context.id);
    if (!profile) { profile = this.createProfile?.(context) || new SdkProfileUpstream(this.poolSize, this.options, this.environment, context, this.service); this.profiles.set(context.id, profile); }
    return profile;
  }
  private assigned(context: CodexExecutionContext, callback?: (value: UpstreamWorkerAssignment) => void) {
    return (value: UpstreamWorkerAssignment) => {
      if (value.threadId) this.service.bindThread(value.threadId, context);
      this.workers.set(value.workerId, context.id); callback?.(value);
    };
  }
}
