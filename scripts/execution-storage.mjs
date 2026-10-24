import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKER = "bridge-storage.json";
const PROFILE_MARKER = "bridge-profile-storage.json";

export function executionStorageRoot(runtimeHome) {
  return path.join(runtimeHome, "execution-storage");
}

function storageMarker(root) {
  const value = JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() ||
      lstatSync(path.join(root, MARKER)).isSymbolicLink() || value?.schemaVersion !== 1 ||
      value.kind !== "bridge-execution-storage" || !UUID.test(value.id || "")) {
    throw new Error("Invalid Bridge storage ownership.");
  }
  return value;
}

/** Only new empty native-login profiles join this instance's persistent store. */
export async function createIndependentProfileStorage(runtimeHome, profileHome) {
  const profile = await lstat(profileHome);
  if (!profile.isDirectory() || profile.isSymbolicLink() || (await readdir(profileHome)).length !== 0) {
    throw new Error("CODEX_STORAGE_PROFILE_NOT_EMPTY: Only a new empty Bridge login profile can join the independent store.");
  }
  const root = executionStorageRoot(runtimeHome);
  let created = false;
  try { await mkdir(root, { mode: 0o700 }); created = true; }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (created) await writeFile(path.join(root, MARKER), JSON.stringify({ schemaVersion: 1,
    kind: "bridge-execution-storage", id: randomUUID() }) + "\n", { mode: 0o600, flag: "wx" });
  let marker;
  try { marker = storageMarker(root); }
  catch { throw new Error("CODEX_STORAGE_UNOWNED: The execution storage is not a verified Bridge-owned directory."); }
  for (const name of ["sessions", "archived_sessions", "sqlite"]) {
    const directory = path.join(root, name);
    // Only this call's first initialization may create storage directories.
    // Reusing an existing root must not turn missing history into an empty store.
    if (created) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    let metadata;
    try { metadata = await lstat(directory); }
    catch {
      throw new Error("CODEX_STORAGE_UNAVAILABLE: The original Bridge execution storage directory is unavailable. Restore its location before preparing another profile.");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("CODEX_STORAGE_CHANGED: The execution storage directory was replaced.");
    }
  }
  for (const name of ["sessions", "archived_sessions"]) {
    // Never replace, copy, merge or adopt an existing profile's history.
    await symlink(path.join(root, name), path.join(profileHome, name), process.platform === "win32" ? "junction" : "dir");
  }
  await writeFile(path.join(profileHome, PROFILE_MARKER), JSON.stringify({ schemaVersion: 1,
    storageId: marker.id }) + "\n", { mode: 0o600, flag: "wx" });
  return { storageId: marker.id, root, sqliteHome: path.join(root, "sqlite") };
}

/** No migration or repair on reads: a changed binding blocks new execution. */
export function independentProfileStorage(runtimeHome, profileHome, storageId) {
  const root = executionStorageRoot(runtimeHome);
  try {
    const marker = storageMarker(root);
    const profile = JSON.parse(readFileSync(path.join(profileHome, PROFILE_MARKER), "utf8"));
    if (!UUID.test(storageId || "") || marker.id !== storageId || profile.schemaVersion !== 1 ||
        profile.storageId !== storageId || lstatSync(profileHome).isSymbolicLink() ||
        lstatSync(path.join(profileHome, PROFILE_MARKER)).isSymbolicLink()) throw new Error("Changed storage ownership.");
    for (const name of ["sessions", "archived_sessions"]) {
      if (!lstatSync(path.join(profileHome, name)).isSymbolicLink() ||
          lstatSync(path.join(root, name)).isSymbolicLink() ||
          realpathSync(path.join(profileHome, name)) !== realpathSync(path.join(root, name))) {
        throw new Error("Changed rollout directory.");
      }
    }
    const sqliteHome = path.join(root, "sqlite");
    if (!lstatSync(sqliteHome).isDirectory() || lstatSync(sqliteHome).isSymbolicLink()) throw new Error("Changed SQLite directory.");
    return { storageId, root, sqliteHome };
  } catch {
    throw new Error("CODEX_STORAGE_UNAVAILABLE: The original Bridge execution storage binding is unavailable. Restore its location before retrying; no history or credentials were moved.");
  }
}
