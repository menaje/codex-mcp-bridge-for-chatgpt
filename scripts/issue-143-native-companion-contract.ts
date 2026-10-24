import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";
import { startRuntimeCompanions } from "../src/runtimeCompanions.js";

// Cross-language production contract using only disposable state. This starts
// the current isolated runtime and real companion server, then lets the
// production Swift client decode Dashboard and Settings from that exact build.
// It never discovers, replaces, stops, or connects to the installed service.
if (process.platform !== "darwin") {
  throw new Error("The issue #143 native companion contract requires macOS.");
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join("/tmp", "i143-swift-"));
const socketPath = path.join(root, "bridge.sock");
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  CODEX_MCP_BRIDGE_NO_AUTH: "1",
  CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
};
const config = loadConfig(environment);
const server = await createIsolatedHttpServer(config, {
  childEnvironment: environment
});
let companions: Awaited<ReturnType<typeof startRuntimeCompanions>> | undefined;
const previousSocket = process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET = socketPath;
  companions = await startRuntimeCompanions(config, server.applicationService);
  if (previousSocket === undefined) delete process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
  else process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET = previousSocket;

  const execute = promisify(execFile);
  const { stdout, stderr } = await execute(
    "/usr/bin/swift",
    ["test", "--package-path", "macos", "--filter", "LiveCompanionTests"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET: socketPath
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    scope: "current isolated runtime + real companion socket + production Swift client",
    installedServiceModified: false,
    stateDatabase: "disposable",
    socketPathRemovedAfterTest: true
  }, null, 2)}\n`);
} finally {
  if (previousSocket === undefined) delete process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET;
  else process.env.CODEX_MCP_BRIDGE_COMPANION_SOCKET = previousSocket;
  await companions?.close().catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
