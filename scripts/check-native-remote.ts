import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteCompanionManager } from "../src/remoteCompanionServer.js";
import type { BridgeApplicationService } from "../src/tools.js";

// Exercise the production Swift client against the production TLS server.
// Only the application data service is a fixture; no existing server is touched.
if (process.platform !== "darwin") throw new Error("This check requires macOS.");
const directory = await mkdtemp(path.join(tmpdir(), "codex-native-remote-check-"));
const port = await new Promise<number>((resolve, reject) => {
  const reservation = createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    if (!address || typeof address === "string") return reject(new Error("No loopback port."));
    reservation.close(error => error ? reject(error) : resolve(address.port));
  });
});
const service = {
  runtimeSnapshot: async () => ({ acceptingNewJobs: true, activeJobs: 0, pendingAdmissions: 0,
    backgroundProcessState: "confirmed", backgroundProcesses: 0, backgroundProcessAgents: 0,
    backgroundProcessUnknownAgents: 0 }),
  dashboardSnapshot: async () => { throw new Error("Not part of this transport check."); },
  settingsSnapshot: async () => { throw new Error("Not part of this transport check."); },
  updateSettings: async () => { throw new Error("Not part of this transport check."); },
  beginDrain: async () => { throw new Error("Forbidden remote control."); },
  cancelDrain: async () => { throw new Error("Forbidden remote control."); }
} as BridgeApplicationService;
const manager = new RemoteCompanionManager({ stateFile: path.join(directory, "remote.json"), applicationService: service });
try {
  await manager.configure({ enabled: true, endpoint: `https://127.0.0.1:${port}`, displayName: "Acceptance fixture" });
  const invitation = await manager.beginPairing(300);
  const exit = await new Promise<number>((resolve, reject) => {
    const child = spawn("swift", ["test", "--package-path", "macos", "-Xswiftc", "-strict-concurrency=complete",
      "-Xswiftc", "-warnings-as-errors", "--filter", "RemoteConnectionTests/testLivePinnedPairingWhenRequested"], {
      env: { ...process.env, CODEX_MCP_BRIDGE_LIVE_REMOTE_INVITATION: invitation.invitation }, stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
  if (exit !== 0) throw new Error(`Native remote acceptance failed (${exit}).`);
  if (manager.status().devices.length !== 1) throw new Error("Unexpected pairing count.");
  console.log("PASS: native TLS pairing, authenticated runtime reads, replay rejection and credential/certificate rejection.");
} finally {
  await manager.close();
  await rm(directory, { recursive: true, force: true });
}
