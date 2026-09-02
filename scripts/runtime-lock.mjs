import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { defaultRuntimeEnvFile } from "./runtime-env.mjs";

export function defaultRuntimeLockDirectory(options = {}) {
  return resolve(dirname(defaultRuntimeEnvFile(options)), "run", "launcher.lock");
}

export function readRuntimeLockOwner(
  lockDirectory = defaultRuntimeLockDirectory(),
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolved = resolve(lockDirectory);
  if (!existsSync(resolved)) return null;
  assertPrivateDirectory(resolved, { platform, uid });
  const entries = readdirSync(resolved);
  if (entries.length !== 1 || entries[0] !== "owner.json") {
    throw new Error("Runtime lock directory is not in the expected private format.");
  }
  const ownerFile = resolve(resolved, "owner.json");
  const ownerStats = lstatSync(ownerFile);
  if (ownerStats.isSymbolicLink() || !ownerStats.isFile()) {
    throw new Error("Runtime lock owner must be a regular, non-symlink file.");
  }
  if (ownerStats.size <= 0 || ownerStats.size > 4_096) {
    throw new Error("Runtime lock owner metadata size is invalid.");
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && ownerStats.uid !== uid) {
      throw new Error("Runtime lock owner file belongs to another user.");
    }
    if ((ownerStats.mode & 0o077) !== 0) {
      throw new Error("Runtime lock owner file permissions are too broad.");
    }
  }
  return readOwner(ownerFile);
}

export function acquireRuntimeLock(
  lockDirectory = defaultRuntimeLockDirectory(),
  {
    pid = process.pid,
    startedAt = new Date().toISOString(),
    processAlive = defaultProcessAlive,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolved = resolve(lockDirectory);
  ensurePrivateParent(dirname(resolved), { platform, uid });
  try {
    mkdirSync(resolved, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    reclaimStaleRuntimeLock(resolved, { processAlive, platform, uid });
    mkdirSync(resolved, { mode: 0o700 });
  }
  assertPrivateDirectory(resolved, { platform, uid });
  const token = randomUUID();
  const ownerFile = resolve(resolved, "owner.json");
  writeFileSync(ownerFile, `${JSON.stringify({ pid, token, startedAt })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  chmodSync(ownerFile, 0o600);

  let released = false;
  return {
    directory: resolved,
    release() {
      if (released) return;
      released = true;
      let owner;
      try {
        owner = readOwner(ownerFile);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (owner.token !== token || owner.pid !== pid) return;
      const entries = readdirSync(resolved);
      if (entries.length !== 1 || entries[0] !== "owner.json") {
        throw new Error("Runtime lock directory contains unexpected files; refusing cleanup.");
      }
      unlinkSync(ownerFile);
      rmdirSync(resolved);
    }
  };
}

function reclaimStaleRuntimeLock(lockDirectory, options) {
  assertPrivateDirectory(lockDirectory, options);
  const entries = readdirSync(lockDirectory);
  if (entries.length !== 1 || entries[0] !== "owner.json") {
    throw new Error("Runtime lock directory is not in the expected private format.");
  }
  const ownerFile = resolve(lockDirectory, "owner.json");
  const ownerStats = lstatSync(ownerFile);
  if (ownerStats.isSymbolicLink() || !ownerStats.isFile()) {
    throw new Error("Runtime lock owner must be a regular, non-symlink file.");
  }
  if (ownerStats.size <= 0 || ownerStats.size > 4_096) {
    throw new Error("Runtime lock owner metadata size is invalid.");
  }
  if (options.platform !== "win32") {
    if (typeof options.uid === "number" && ownerStats.uid !== options.uid) {
      throw new Error("Runtime lock owner file belongs to another user.");
    }
    if ((ownerStats.mode & 0o077) !== 0) {
      throw new Error("Runtime lock owner file permissions are too broad.");
    }
  }
  const owner = readOwner(ownerFile);
  if (options.processAlive(owner.pid)) {
    throw new Error(
      `Another Codex MCP Bridge runtime is already running (pid ${owner.pid}).`
    );
  }
  unlinkSync(ownerFile);
  rmdirSync(lockDirectory);
}

function ensurePrivateParent(directory, options) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(directory, options);
}

function assertPrivateDirectory(directory, { platform, uid }) {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Runtime lock path must be a regular directory: ${directory}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime lock directory must be owned by the current user: ${directory}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Runtime lock directory permissions are too broad: ${directory}`);
    }
  }
}

function readOwner(ownerFile) {
  const parsed = JSON.parse(readFileSync(ownerFile, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.token) ||
    typeof parsed.startedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.startedAt))
  ) {
    throw new Error("Runtime lock owner metadata is invalid.");
  }
  return parsed;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
