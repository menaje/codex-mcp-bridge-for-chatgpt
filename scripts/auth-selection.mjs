import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
    (["bridge-chatgpt", "bridge-api"].includes(value.kind) && typeof value.profileId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.profileId))
  );
  if (state?.schemaVersion !== 1 ||
      (state.generation !== undefined && (!Number.isSafeInteger(state.generation) || state.generation < 0)) ||
      !valid(state.applied) ||
      (state.pending !== null && !valid(state.pending))) {
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
  return { connection: state?.applied || { kind: "shared" },
    generation: state?.generation || 0 };
}
