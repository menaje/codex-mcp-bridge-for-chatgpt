import { CodexService } from "./codexService.js";
import type { CodexUpstream } from "./upstream.js";
import type { CodexBackendKind } from "./config.js";
import type { BridgeConfig } from "./config.js";
import { CodexRuntimeManager } from "./codexRuntime.js";
import { CodexAppServerUpstreamPool, type CodexAppServerProtocolOptions } from "./appServerUpstream.js";
import { CodexBackendRouter } from "./upstreamRouter.js";
import { LazyCodexUpstream } from "./lazyUpstream.js";
import { UNVERIFIED_APP_SERVER_CAPABILITIES } from "./cliProtocol.js";

export function createExecutionRuntime(config: BridgeConfig, options: CodexAppServerProtocolOptions = {}, environment: NodeJS.ProcessEnv = process.env): CodexBackendRouter {
  const manager = new CodexRuntimeManager({ environment, explicitCommand: environment.CODEX_MCP_BRIDGE_CODEX || environment.CODEX_GPT_BRIDGE_CODEX ||
    (config.codexCommand !== "codex" ? config.codexCommand : undefined) });
  const service = config.codexService = new CodexService(environment, manager);
  let selected: Promise<string> | undefined;
  let release: (() => Promise<void>) | undefined;
  const resolveCli = (): Promise<string> => {
    if (!selected) selected = manager.acquire()
      .then(acquired => { release = acquired.release; return acquired.selection.command; })
      .catch(error => { selected = undefined; throw error; });
    return selected;
  };
  config.codexCommandResolver = resolveCli;
  config.runtimeStatusResolver = async () => {
    const cli = await manager.snapshot();
    const compact = (state: typeof cli) => `installed=${state.installedVersion ?? "none"}; running=${state.runningVersions.join(",") || "none"}; active=${state.managedVersions.find(item => item.active)?.version ?? "none"}; staged=${state.stagedVersion ?? "none"}; rollback=${state.recoveryVersion ?? "none"}`;
    return [`CLI: source=${cli.selection?.source ?? "unselected"}; compatible=${cli.selection?.compatible ?? "unknown"}; ${compact(cli)}`];
  };
  const app = new LazyCodexUpstream("app-server", UNVERIFIED_APP_SERVER_CAPABILITIES,
    async () => new CodexAppServerUpstreamPool(await resolveCli(), config.upstreamPoolSize, { ...options, environment }), undefined, service.admissionGuard());
  const router = new CodexBackendRouter("app-server", new Map<CodexBackendKind, CodexUpstream>([["app-server", app]]));
  router.accountRevision = () => service.cacheRevision();
  router.readAccountSnapshot = () => service.readAccount(config.defaultBackend);
  router.readAccountRateLimits = async () => {
    const account = await service.readAccount(config.defaultBackend);
    const window = account?.windows.find(window => window.limitId === "codex" && window.windowDurationMins === 10080);
    return account && window ? { ...window, observedAt: account.observedAt } : null;
  };
  const close = router.close.bind(router);
  router.close = async () => { try { await close(); } finally { await release?.(); } };
  return router;
}
