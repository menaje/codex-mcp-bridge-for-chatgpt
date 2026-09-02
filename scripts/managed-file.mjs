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
import { dirname, resolve } from "node:path";

export function readPrivateFile(filePath, options = {}) {
  const resolved = resolve(filePath);
  assertPrivateFile(resolved, options);
  return readFileSync(resolved, options.encoding || null);
}

export function writePrivateFileAtomic(filePath, contents, options = {}) {
  const resolved = resolve(filePath);
  const directory = dirname(resolved);
  ensurePrivateDirectory(directory, options);
  if (pathEntryExists(resolved)) assertPrivateFile(resolved, options);
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, options.encoding ? { encoding: options.encoding } : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    assertPrivateFile(temporary, options);
    renameSync(temporary, resolved);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (pathEntryExists(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
  return resolved;
}

export function assertPrivateFile(
  filePath,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Managed file must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Managed file must be owned by the current user: ${filePath}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Managed file permissions are too broad: ${filePath}`);
    }
  }
}

export function ensurePrivateDirectory(
  directory,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed directory must be a regular directory: ${directory}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Managed directory must be owned by the current user: ${directory}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Managed directory permissions are too broad: ${directory}`);
    }
  }
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // The file itself was fsynced before rename; not every filesystem allows
    // directory fsync.
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
