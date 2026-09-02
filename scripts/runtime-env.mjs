import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";

const RUNTIME_CONFIG_DIRECTORY = "codex-mcp-bridge";
const RUNTIME_ENV_FILENAME = ".env";
export const RUNTIME_ENV_MANAGED_KEYS = [
  "CONTROL_PLANE_API_KEY",
  "CONTROL_PLANE_TUNNEL_ID"
];

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

export function inspectRuntimeEnvFile(
  filePath,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      exists: false,
      valid: false,
      hasApiKey: false,
      hasTunnelId: false,
      tunnelId: null,
      issue: "Runtime environment file is not configured."
    };
  }
  try {
    assertPrivateRuntimeEnvFile(resolvedPath, { platform, uid });
    const values = readManagedRuntimeEnvValues(readFileSync(resolvedPath, "utf8"));
    validateSecureTunnelEnvironment(values, resolvedPath);
    return {
      path: resolvedPath,
      exists: true,
      valid: true,
      hasApiKey: Boolean(values.CONTROL_PLANE_API_KEY),
      hasTunnelId: Boolean(values.CONTROL_PLANE_TUNNEL_ID),
      tunnelId: values.CONTROL_PLANE_TUNNEL_ID || null,
      issue: null
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: true,
      valid: false,
      hasApiKey: false,
      hasTunnelId: false,
      tunnelId: null,
      issue: safeRuntimeEnvIssue(error)
    };
  }
}

/**
 * Atomically update only app-owned tunnel values while retaining every other
 * dotenv line byte-for-byte. Empty inputs intentionally preserve existing
 * values so the native app never has to reveal a saved key again.
 */
export function updateRuntimeEnvFile(
  filePath,
  { apiKey, tunnelId },
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined,
    renameFile = renameSync
  } = {}
) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  ensurePrivateRuntimeDirectory(directory, { platform, uid });

  const existing = existsSync(resolvedPath);
  if (existing) assertPrivateRuntimeEnvFile(resolvedPath, { platform, uid });
  const original = existing ? readFileSync(resolvedPath, "utf8") : "";
  const updates = {
    ...(typeof apiKey === "string" && apiKey.trim() ? { CONTROL_PLANE_API_KEY: apiKey.trim() } : {}),
    ...(typeof tunnelId === "string" && tunnelId.trim()
      ? { CONTROL_PLANE_TUNNEL_ID: tunnelId.trim() }
      : {})
  };
  const next = mergeManagedRuntimeEnv(original, updates);
  const values = readManagedRuntimeEnvValues(next);
  validateSecureTunnelEnvironment(values, resolvedPath);

  const temporaryPath = resolve(directory, `.${RUNTIME_ENV_FILENAME}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, next, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    assertPrivateRuntimeEnvFile(temporaryPath, { platform, uid });
    validateSecureTunnelEnvironment(
      readManagedRuntimeEnvValues(readFileSync(temporaryPath, "utf8")),
      resolvedPath
    );
    renameFile(temporaryPath, resolvedPath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error; a same-directory private temp file is safe
      // to remove on the next setup attempt.
    }
    throw error;
  }
  return inspectRuntimeEnvFile(resolvedPath, { platform, uid });
}

function ensurePrivateRuntimeDirectory(directory, { platform, uid }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Runtime environment directory must be a regular directory: ${directory}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment directory must be owned by the current user: ${directory}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Runtime environment directory permissions are too broad: ${directory}`);
    }
  }
}

function assertPrivateRuntimeEnvFile(filePath, { platform, uid }) {
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
}

function mergeManagedRuntimeEnv(source, updates) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const seen = new Set();
  const parts = source.length === 0 ? [] : source.split(/(\r\n|\n)/);
  let merged = "";
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] || "";
    const separator = parts[index + 1] || "";
    const key = dotenvAssignmentKey(line);
    let nextLine = line;
    if (key && RUNTIME_ENV_MANAGED_KEYS.includes(key)) {
      if (seen.has(key)) {
        throw new Error(`Runtime environment contains duplicate ${key} entries.`);
      }
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        nextLine = `${key}=${updates[key]}`;
      }
    }
    merged += `${nextLine}${separator}`;
  }
  const additions = [];
  for (const key of RUNTIME_ENV_MANAGED_KEYS) {
    if (!seen.has(key) && Object.prototype.hasOwnProperty.call(updates, key)) {
      additions.push(`${key}=${updates[key]}`);
    }
  }
  if (additions.length === 0) return merged;

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const retainedTrailingNewline = source.length === 0 || source.endsWith("\n");
  if (merged && !merged.endsWith("\n")) merged += newline;
  merged += additions.join(newline);
  if (retainedTrailingNewline) merged += newline;
  return merged;
}

function readManagedRuntimeEnvValues(source) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const values = {};
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const key = dotenvAssignmentKey(line);
    if (!key || !RUNTIME_ENV_MANAGED_KEYS.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Runtime environment contains duplicate ${key} entries.`);
    }
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    values[key] = parseDotenvValue(assignment?.[1] || "");
  }
  return values;
}

function dotenvAssignmentKey(line) {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

function parseDotenvValue(raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function safeRuntimeEnvIssue(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "Runtime environment is invalid.";
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support fsync on directories. The file itself
    // was already fsynced before the atomic rename.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveFromRepo(filePath, repoRoot) {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
}

function isPlaceholder(value) {
  return /^(?:<.*>|replace[-_]|your[-_]|sk-\.\.\.|tunnel_\.\.\.)/i.test(value);
}
