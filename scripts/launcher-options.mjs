import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_LAUNCHER_ROOTS = 100;

const VALUE_OPTIONS = new Map([
  ["--mode", "mode"],
  ["--port", "port"],
  ["--tunnel-id", "tunnelId"],
  ["--profile", "profile"],
  ["--tunnel-client", "tunnelClient"]
]);

/**
 * Parse launcher-only options. Roots are deliberately retained as a list so
 * repeating --root cannot silently replace an earlier operator ceiling.
 */
export function parseLauncherArgs(rawArgs) {
  if (!Array.isArray(rawArgs)) {
    throw new Error("Launcher arguments must be an array.");
  }
  const parsed = { roots: [] };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (typeof arg !== "string") {
      throw new Error("Launcher arguments must be strings.");
    }
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--no-build") parsed.noBuild = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--allow-full-access") parsed.allowFullAccess = true;
    else if (arg === "--allow-write") parsed.allowWrite = true;
    else if (arg === "--root") {
      if (parsed.roots.length >= MAX_LAUNCHER_ROOTS) {
        throw new Error(`At most ${MAX_LAUNCHER_ROOTS} --root options are allowed.`);
      }
      parsed.roots.push(readOptionValue(rawArgs, ++index, "--root"));
    } else if (VALUE_OPTIONS.has(arg)) {
      parsed[VALUE_OPTIONS.get(arg)] = readOptionValue(rawArgs, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * Resolve every requested root once before startup. The server independently
 * validates the resulting allowlist when it loads BridgeConfig.
 */
export function resolveLauncherRoots(rootInputs, cwd = process.cwd()) {
  if (!Array.isArray(rootInputs)) {
    throw new Error("Launcher roots must be an array.");
  }
  if (rootInputs.length > MAX_LAUNCHER_ROOTS) {
    throw new Error(`At most ${MAX_LAUNCHER_ROOTS} --root options are allowed.`);
  }
  const requested = rootInputs.length > 0 ? rootInputs : [cwd];
  const roots = [];
  const seen = new Set();
  for (const input of requested) {
    if (typeof input !== "string" || input.length === 0 || /[\0\r\n]/u.test(input)) {
      throw new Error("--root requires a non-empty filesystem path without control characters.");
    }

    const absolute = path.resolve(cwd, input);
    let canonical;
    try {
      canonical = realpathSync(absolute);
      if (!statSync(canonical).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(`Invalid --root path (must be an existing directory): ${absolute}`);
    }

    // BridgeConfig retains a comma-separated environment compatibility format.
    // Refuse names that cannot round-trip exactly instead of broadening or
    // changing the operator's requested filesystem ceiling.
    if (canonical.includes(",") || canonical.trim() !== canonical || /[\0\r\n]/u.test(canonical)) {
      throw new Error(
        `Invalid --root path (cannot be represented safely in CODEX_MCP_BRIDGE_ROOTS): ${canonical}`
      );
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      roots.push(canonical);
    }
  }
  return roots;
}

export function serializeLauncherRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error("At least one validated launcher root is required.");
  }
  for (const root of roots) {
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      root.length === 0 ||
      root.includes(",") ||
      root.trim() !== root ||
      /[\0\r\n]/u.test(root)
    ) {
      throw new Error("Launcher roots must be validated absolute paths.");
    }
  }
  return roots.join(",");
}

function readOptionValue(rawArgs, index, option) {
  const value = rawArgs[index];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}
