import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { independentProfileStorage } from "./execution-storage.mjs";

export function authSelectionRoot(environment = process.env) {
  return path.resolve(environment.CODEX_MCP_BRIDGE_RUNTIME_HOME ||
    path.join(homedir(), ".codex-mcp-bridge", "runtimes"));
}

export function authProfileHome(root, profileId) {
  if (typeof profileId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profileId)) {
    throw new Error("CODEX_AUTH_PROFILE_INVALID: The saved authentication profile is invalid.");
  }
  return path.join(root, "auth-profiles", profileId);
}

export function authProfileEnvironment(root, profileId, environment = {}) {
  const home = authProfileHome(root, profileId);
  const state = readAuthSelection({ CODEX_MCP_BRIDGE_RUNTIME_HOME: root });
  const storageId = state?.profiles?.find(profile => profile.id === profileId)?.storageId;
  if (!storageId && existsSync(path.join(home, "bridge-profile-storage.json"))) {
    throw new Error("CODEX_STORAGE_UNAVAILABLE: The original profile storage binding is missing from Bridge state.");
  }
  const storage = storageId ? independentProfileStorage(root, home, storageId) : null;
  if (storage) {
    const topLevel = readFileSync(path.join(home, "config.toml"), "utf8").split(/^\s*\[/m, 1)[0] || "";
    const entries = [...topLevel.matchAll(/^\s*sqlite_home\s*=\s*(.+)$/gm)];
    if (entries.length !== 1 || entries[0][1].trim() !== JSON.stringify(storage.sqliteHome)) {
      throw new Error("CODEX_STORAGE_UNAVAILABLE: The native profile SQLite location changed. Restore the original binding before retrying.");
    }
  }
  return { ...environment, CODEX_HOME: home, ...(storage ? { CODEX_SQLITE_HOME: storage.sqliteHome } : {}) };
}

/** Validate this process's original profile, even while a different profile is pending. */
export function assertAuthProfileStorageEnvironment(environment) {
  if (!["bridge-chatgpt", "bridge-api"].includes(environment.CODEX_MCP_BRIDGE_AUTH_SOURCE) || !environment.CODEX_HOME) return;
  const root = authSelectionRoot(environment);
  const profileId = path.basename(environment.CODEX_HOME);
  if (path.resolve(environment.CODEX_HOME) !== authProfileHome(root, profileId)) {
    throw new Error("CODEX_STORAGE_UNAVAILABLE: The Bridge login profile location changed.");
  }
  const projected = authProfileEnvironment(root, profileId);
  if (projected.CODEX_SQLITE_HOME && environment.CODEX_SQLITE_HOME !== projected.CODEX_SQLITE_HOME) {
    throw new Error("CODEX_STORAGE_UNAVAILABLE: The running Bridge SQLite binding changed. Restart with the original storage before retrying.");
  }
}

export function knownExternalHome(state, homeId) {
  const entry = state?.knownHomes?.find(item => item.id === homeId);
  if (!entry || !path.isAbsolute(entry.home) || !path.isAbsolute(entry.canonicalHome)) {
    throw new Error("CODEX_AUTH_HOME_UNAVAILABLE: The previously used Codex location is unavailable.");
  }
  try {
    if (realpathSync(entry.home) !== entry.canonicalHome || !statSync(entry.home).isDirectory()) {
      throw new Error("CODEX_AUTH_HOME_CHANGED");
    }
  } catch {
    throw new Error("CODEX_AUTH_HOME_UNAVAILABLE: The previously used Codex location changed or is unavailable.");
  }
  return entry.home;
}

export function readAuthSelection(environment = process.env) {
  const root = authSelectionRoot(environment);
  let state;
  try { state = JSON.parse(readFileSync(path.join(root, "auth-selection.json"), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("CODEX_AUTH_SELECTION_INVALID: The saved authentication selection could not be read.");
  }
  const valid = value => value && typeof value === "object" && (
    value.kind === "shared" || value.kind === "disconnected" ||
    (value.kind === "external" && typeof value.homeId === "string" &&
      state.knownHomes?.some(item => item.id === value.homeId)) ||
    (["bridge-chatgpt", "bridge-api"].includes(value.kind) && typeof value.profileId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.profileId))
  );
  if (state?.schemaVersion !== 1 ||
      (state.profiles !== undefined && (!Array.isArray(state.profiles) || !state.profiles.every(profile =>
        profile && typeof profile.id === "string" && (profile.storageId === undefined ||
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profile.storageId))))) ||
      (state.knownHomes !== undefined && (!Array.isArray(state.knownHomes) ||
        !state.knownHomes.every(item => item && typeof item.id === "string" &&
          /^[a-f0-9-]{36}$/.test(item.id) && typeof item.home === "string" && path.isAbsolute(item.home) &&
          typeof item.canonicalHome === "string" && path.isAbsolute(item.canonicalHome)))) ||
      (state.generation !== undefined && (!Number.isSafeInteger(state.generation) || state.generation < 0)) ||
      !valid(state.applied) ||
      (state.pending !== null && !valid(state.pending)) ||
      (state.activation !== undefined && state.activation !== null &&
        (typeof state.activation !== "object" ||
          !/^[a-f0-9-]{36}$/.test(state.activation.id || "") ||
          !valid(state.activation.from) || !valid(state.activation.to) ||
          !Number.isSafeInteger(state.activation.generation) || state.activation.generation < 0 ||
          !["starting", "uncertain"].includes(state.activation.status)))) {
    throw new Error("CODEX_AUTH_SELECTION_INVALID: The saved authentication selection is invalid.");
  }
  return state;
}

/** Only an explicitly applied selection can be used by a new process. */
export function desiredAuthConnection(environment = process.env) {
  return desiredAuthSelection(environment).connection;
}

export function desiredAuthSelection(environment = process.env) {
  const state = readAuthSelection(environment);
  if (state?.activation) {
    if (environment.CODEX_MCP_BRIDGE_AUTH_ACTIVATION_ID === state.activation.id &&
        state.activation.status === "starting") {
      return { connection: state.activation.to, generation: state.activation.generation };
    }
    if (state.activation.status === "uncertain" || environment.CODEX_MCP_BRIDGE_AUTH_ACTIVATION_ID) {
      throw new Error("CODEX_AUTH_ACTIVATION_UNCERTAIN: The authentication activation result requires reconciliation.");
    }
  }
  return { connection: state?.applied || { kind: "shared" },
    generation: state?.generation || 0 };
}
