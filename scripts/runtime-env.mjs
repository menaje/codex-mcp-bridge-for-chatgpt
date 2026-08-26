import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";

const RUNTIME_CONFIG_DIRECTORY = "codex-mcp-bridge";
const RUNTIME_ENV_FILENAME = ".env";

export function defaultRuntimeEnvFile({ environment = process.env, homeDirectory = homedir() } = {}) {
  const configHome = environment.XDG_CONFIG_HOME || resolve(homeDirectory, ".config");
  return resolve(configHome, RUNTIME_CONFIG_DIRECTORY, RUNTIME_ENV_FILENAME);
}

export function resolveRuntimeEnvFile({
  explicitPath,
  environment = process.env,
  homeDirectory = homedir(),
  repoRoot = process.cwd(),
  fileExists = existsSync
} = {}) {
  const requestedPath = explicitPath || environment.CODEX_MCP_BRIDGE_ENV_FILE;
  if (requestedPath) return resolveFromRepo(requestedPath, repoRoot);

  const operatorFile = defaultRuntimeEnvFile({ environment, homeDirectory });
  if (fileExists(operatorFile)) return operatorFile;

  const repositoryFile = resolve(repoRoot, RUNTIME_ENV_FILENAME);
  return fileExists(repositoryFile) ? repositoryFile : operatorFile;
}

export function loadRuntimeEnvFile(
  filePath,
  {
    required = false,
    apply = loadEnvFile,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  if (!existsSync(filePath)) {
    if (required) throw new Error(`Runtime environment file not found: ${filePath}`);
    return false;
  }

  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment must be owned by the current user: ${filePath}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Runtime environment permissions are too broad; run chmod 600 ${filePath}`);
    }
  }

  apply(filePath);
  return true;
}

export function validateSecureTunnelEnvironment(environment = process.env, filePath) {
  const sourceHint = filePath ? `; configure ${filePath} or export it explicitly` : "";
  const apiKey = environment.CONTROL_PLANE_API_KEY;
  const tunnelId = environment.CONTROL_PLANE_TUNNEL_ID;

  if (!apiKey) {
    throw new Error(`Secure mode needs CONTROL_PLANE_API_KEY${sourceHint}.`);
  }
  if (!/^sk-[^\s]{16,}$/.test(apiKey) || isPlaceholder(apiKey)) {
    throw new Error(`CONTROL_PLANE_API_KEY is malformed or still a placeholder${sourceHint}.`);
  }
  if (!tunnelId) {
    throw new Error(`Secure mode needs CONTROL_PLANE_TUNNEL_ID${sourceHint}.`);
  }
  if (!/^tunnel_[A-Za-z0-9_-]{8,}$/.test(tunnelId) || isPlaceholder(tunnelId)) {
    throw new Error(`CONTROL_PLANE_TUNNEL_ID is malformed or still a placeholder${sourceHint}.`);
  }

  return { apiKey, tunnelId };
}

function resolveFromRepo(filePath, repoRoot) {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
}

function isPlaceholder(value) {
  return /^(?:<.*>|replace[-_]|your[-_]|sk-\.\.\.|tunnel_\.\.\.)/i.test(value);
}
