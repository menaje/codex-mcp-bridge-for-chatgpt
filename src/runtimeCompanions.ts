import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { startBridgeCompanionServer } from "./companionServer.js";
import { RemoteCompanionManager } from "./remoteCompanionServer.js";
import type { BridgeApplicationService } from "./tools.js";

/** Native and remote app connections use the same live runtime on either transport. */
export async function startRuntimeCompanions(
  config: BridgeConfig,
  applicationService: BridgeApplicationService
): Promise<{ close(): Promise<void> }> {
  const socketPath = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET?.trim();
  if (!socketPath) return { async close() {} };
  let remote: RemoteCompanionManager | undefined;
  try {
    remote = new RemoteCompanionManager({
      stateFile: process.env.CODEX_MCP_BRIDGE_REMOTE_STATE_FILE?.trim() ||
        path.join(path.dirname(config.stateDatabaseFile), "remote-management.json"),
      applicationService
    });
    const status = await remote.start();
    if (status.enabled) {
      console.error(status.listening
        ? `remote companion ready at ${status.endpoint}`
        : `remote companion unavailable: ${status.lastError || "unknown error"}`);
    }
  } catch (error) {
    await remote?.close().catch(() => undefined);
    remote = undefined;
    console.error(`remote companion unavailable: ${errorMessage(error)}`);
  }
  try {
    const native = await startBridgeCompanionServer({ socketPath, applicationService, remoteManagement: remote });
    console.error(`native companion ready at ${native.socketPath}`);
    return {
      async close() {
        const results = await Promise.allSettled([native.close(), remote?.close()]);
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    };
  } catch (error) {
    await remote?.close().catch(() => undefined);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
