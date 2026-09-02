import {
  chmodSync,
  closeSync,
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
import { parseEnv } from "node:util";

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
  fileExists = pathEntryExists
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
    allowedKey,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  if (!pathEntryExists(filePath)) {
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

  if (allowedKey) {
    const values = parseEnv(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (allowedKey(key) && process.env[key] === undefined) process.env[key] = value;
    }
  } else {
    apply(filePath);
  }
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
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId) || isPlaceholder(tunnelId)) {
    throw new Error(
      `CONTROL_PLANE_TUNNEL_ID must be tunnel_ followed by 32 lowercase letters or digits${sourceHint}.`
    );
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
  if (!pathEntryExists(resolvedPath)) {
    const directory = dirname(resolvedPath);
    try {
      if (pathEntryExists(directory)) {
        assertRuntimeEnvDirectory(directory, { platform, uid });
      }
    } catch (error) {
      return {
        path: resolvedPath,
        exists: false,
        valid: false,
        hasApiKey: false,
        hasTunnelId: false,
        tunnelId: null,
        issue: safeRuntimeEnvIssue(error)
      };
    }
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
    assertRuntimeEnvDirectory(dirname(resolvedPath), { platform, uid });
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

export function repairRuntimeEnvPermissions(
  filePath,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  if (!pathEntryExists(directory)) {
    throw new Error(`Runtime environment directory not found: ${directory}`);
  }
  const directoryStats = lstatSync(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`Runtime environment directory must be a regular directory: ${directory}`);
  }
  const fileExists = pathEntryExists(resolvedPath);
  const fileStats = fileExists ? lstatSync(resolvedPath) : undefined;
  if (fileStats && (fileStats.isSymbolicLink() || !fileStats.isFile())) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${resolvedPath}`);
  }
  if (platform !== "win32") {
    if (
      typeof uid === "number" &&
      (directoryStats.uid !== uid || (fileStats && fileStats.uid !== uid))
    ) {
      throw new Error("Runtime environment file and directory must be owned by the current user.");
    }
    if (
      (directoryStats.mode & 0o022) !== 0 ||
      (fileStats !== undefined && (fileStats.mode & 0o022) !== 0)
    ) {
      throw new Error(
        "Runtime environment permissions cannot be repaired automatically while group or world writable."
      );
    }
    chmodSync(directory, 0o700);
    if (fileExists) chmodSync(resolvedPath, 0o600);
  }
  return inspectRuntimeEnvFile(resolvedPath, { platform, uid });
}

/**
 * Read only explicitly requested values from a verified dotenv file. Normal
 * callers require private permissions. Permission-repair preflight may opt in
 * to an owned, regular, over-readable path, but never a group/world-writable
 * one. The native helper uses this without loading tunnel credentials into its
 * process environment.
 */
export function readRuntimeEnvSubset(
  filePath,
  keys,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined,
    allowBroadReadOnlyPermissions = false
  } = {}
) {
  const resolvedPath = resolve(filePath);
  if (!pathEntryExists(resolvedPath)) return {};
  const verification = { platform, uid, allowBroadReadOnlyPermissions };
  assertRuntimeEnvDirectory(dirname(resolvedPath), verification);
  assertPrivateRuntimeEnvFile(resolvedPath, verification);
  if (!Array.isArray(keys) || keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new Error("Runtime environment subset keys must be valid environment names.");
  }
  return readSelectedRuntimeEnvValues(readFileSync(resolvedPath, "utf8"), new Set(keys));
}

/**
 * Prepare and validate a dotenv replacement without changing the file. The
 * returned value is intentionally opaque to callers outside the helper and
 * must never be logged or serialized because it retains the prior and next
 * file contents for rollback.
 */
export function prepareRuntimeEnvUpdate(
  filePath,
  { apiKey, tunnelId },
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  ensurePrivateRuntimeDirectory(directory, { platform, uid });

  const existed = pathEntryExists(resolvedPath);
  if (existed) assertPrivateRuntimeEnvFile(resolvedPath, { platform, uid });
  const original = existed ? readFileSync(resolvedPath, "utf8") : "";
  const previousValues = readManagedRuntimeEnvValues(original);
  const updates = {
    ...(typeof apiKey === "string" && apiKey.trim() ? { CONTROL_PLANE_API_KEY: apiKey.trim() } : {}),
    ...(typeof tunnelId === "string" && tunnelId.trim()
      ? { CONTROL_PLANE_TUNNEL_ID: tunnelId.trim() }
      : {})
  };
  const next = mergeManagedRuntimeEnv(original, updates);
  const nextValues = readManagedRuntimeEnvValues(next);
  validateSecureTunnelEnvironment(nextValues, resolvedPath);

  return Object.freeze({
    path: resolvedPath,
    directory,
    existed,
    original,
    next,
    changed: next !== original,
    tunnelIdChanged:
      previousValues.CONTROL_PLANE_TUNNEL_ID !== nextValues.CONTROL_PLANE_TUNNEL_ID,
    platform,
    uid
  });
}

export function commitRuntimeEnvUpdate(
  prepared,
  { renameFile = renameSync } = {}
) {
  assertPreparedRuntimeEnvUpdate(prepared);
  assertRuntimeEnvUnchanged(prepared, prepared.original, prepared.existed);
  if (!prepared.changed) {
    return inspectRuntimeEnvFile(prepared.path, prepared);
  }
  writeAtomicPrivateRuntimeEnv(prepared.path, prepared.next, {
    ...prepared,
    renameFile,
    validate: true
  });
  return inspectRuntimeEnvFile(prepared.path, prepared);
}

export function rollbackRuntimeEnvUpdate(prepared) {
  assertPreparedRuntimeEnvUpdate(prepared);
  if (!prepared.changed) return inspectRuntimeEnvFile(prepared.path, prepared);
  assertRuntimeEnvUnchanged(prepared, prepared.next, true);
  if (!prepared.existed) {
    unlinkSync(prepared.path);
    syncDirectory(prepared.directory);
    return inspectRuntimeEnvFile(prepared.path, prepared);
  }
  writeAtomicPrivateRuntimeEnv(prepared.path, prepared.original, {
    ...prepared,
    renameFile: renameSync,
    validate: false
  });
  return inspectRuntimeEnvFile(prepared.path, prepared);
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
  const prepared = prepareRuntimeEnvUpdate(filePath, { apiKey, tunnelId }, { platform, uid });
  return commitRuntimeEnvUpdate(prepared, { renameFile });
}

function writeAtomicPrivateRuntimeEnv(filePath, contents, options) {
  const temporaryPath = resolve(
    options.directory,
    `.${RUNTIME_ENV_FILENAME}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    assertPrivateRuntimeEnvFile(temporaryPath, options);
    if (options.validate) {
      validateSecureTunnelEnvironment(
        readManagedRuntimeEnvValues(readFileSync(temporaryPath, "utf8")),
        filePath
      );
    }
    options.renameFile(temporaryPath, filePath);
    syncDirectory(options.directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (pathEntryExists(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error; a same-directory private temp file is safe
      // to remove on the next setup attempt.
    }
    throw error;
  }
}

function assertPreparedRuntimeEnvUpdate(prepared) {
  if (
    !prepared ||
    typeof prepared !== "object" ||
    typeof prepared.path !== "string" ||
    typeof prepared.directory !== "string" ||
    typeof prepared.original !== "string" ||
    typeof prepared.next !== "string" ||
    typeof prepared.existed !== "boolean"
  ) {
    throw new Error("Invalid prepared runtime environment update.");
  }
}

function assertRuntimeEnvUnchanged(prepared, expectedContents, expectedExists) {
  const exists = pathEntryExists(prepared.path);
  if (exists !== expectedExists) {
    throw new Error("RUNTIME_ENV_CHANGED: Runtime environment changed during the operation.");
  }
  if (!exists) return;
  assertPrivateRuntimeEnvFile(prepared.path, prepared);
  if (readFileSync(prepared.path, "utf8") !== expectedContents) {
    throw new Error("RUNTIME_ENV_CHANGED: Runtime environment changed during the operation.");
  }
}

function ensurePrivateRuntimeDirectory(directory, { platform, uid }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRuntimeEnvDirectory(directory, { platform, uid });
}

function assertRuntimeEnvDirectory(
  directory,
  { platform, uid, allowBroadReadOnlyPermissions = false }
) {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Runtime environment directory must be a regular directory: ${directory}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment directory must be owned by the current user: ${directory}`);
    }
    if (
      (stats.mode & 0o077) !== 0 &&
      !(allowBroadReadOnlyPermissions && (stats.mode & 0o022) === 0)
    ) {
      throw new Error(`Runtime environment directory permissions are too broad: ${directory}`);
    }
  }
}

function assertPrivateRuntimeEnvFile(
  filePath,
  { platform, uid, allowBroadReadOnlyPermissions = false }
) {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment must be owned by the current user: ${filePath}`);
    }
    if (
      (stats.mode & 0o077) !== 0 &&
      !(allowBroadReadOnlyPermissions && (stats.mode & 0o022) === 0)
    ) {
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
    const assignment = dotenvAssignment(line);
    const key = assignment?.key;
    let nextLine = line;
    if (key && RUNTIME_ENV_MANAGED_KEYS.includes(key)) {
      if (seen.has(key)) {
        throw new Error(`Runtime environment contains duplicate ${key} entries.`);
      }
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        nextLine = `${assignment.prefix}${updates[key]}${assignment.commentSuffix}`;
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

function readSelectedRuntimeEnvValues(source, selectedKeys) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const values = {};
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const key = dotenvAssignmentKey(line);
    if (!key || !selectedKeys.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Runtime environment contains duplicate ${key} entries.`);
    }
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    values[key] = parseDotenvValue(assignment?.[1] || "");
  }
  return values;
}

function dotenvAssignmentKey(line) {
  return dotenvAssignment(line)?.key;
}

function parseDotenvValue(raw) {
  return parseEnv(`RUNTIME_VALUE=${raw}\n`).RUNTIME_VALUE || "";
}

function dotenvAssignment(line) {
  const match = line.match(/^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/);
  if (!match) return undefined;
  const raw = match[3];
  const commentIndex = dotenvCommentIndex(raw);
  let suffixStart = commentIndex;
  while (suffixStart > 0 && /\s/.test(raw[suffixStart - 1])) suffixStart -= 1;
  return {
    key: match[2],
    prefix: match[1],
    commentSuffix: commentIndex < raw.length ? raw.slice(suffixStart) : ""
  };
}

function dotenvCommentIndex(raw) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = "";
      escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return index;
    }
  }
  return raw.length;
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

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveFromRepo(filePath, repoRoot) {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
}

function isPlaceholder(value) {
  return /^(?:<.*>|replace[-_]|your[-_]|sk-\.\.\.|tunnel_\.\.\.)/i.test(value);
}
