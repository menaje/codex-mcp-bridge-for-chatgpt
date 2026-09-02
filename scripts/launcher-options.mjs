const VALUE_OPTIONS = new Map([
  ["--mode", "mode"],
  ["--transport", "transport"],
  ["--port", "port"],
  ["--env-file", "envFile"],
  ["--tunnel-id", "tunnelId"],
  ["--profile", "profile"],
  ["--tunnel-client", "tunnelClient"],
  ["--profile-metadata-file", "profileMetadataFile"],
  ["--runtime-status-file", "runtimeStatusFile"],
  ["--tunnel-health-url-file", "tunnelHealthUrlFile"],
  ["--tunnel-pid-file", "tunnelPidFile"]
]);

export function parseLauncherArgs(rawArgs) {
  if (!Array.isArray(rawArgs)) {
    throw new Error("Launcher arguments must be an array.");
  }
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (typeof arg !== "string") {
      throw new Error("Launcher arguments must be strings.");
    }
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--no-build") parsed.noBuild = true;
    else if (arg === "--require-built") parsed.requireBuilt = true;
    else if (arg === "--reuse-profile") parsed.reuseProfile = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--allow-full-access") parsed.allowFullAccess = true;
    else if (arg === "--allow-write") parsed.allowWrite = true;
    else if (VALUE_OPTIONS.has(arg)) {
      parsed[VALUE_OPTIONS.get(arg)] = readOptionValue(rawArgs, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export function requiredBuildOutputs(transport) {
  if (transport === "http") return ["dist/cli.js", "dist/build-info.json"];
  if (transport === "stdio") {
    return ["dist/stdio.js", "dist/stdioServer.js", "dist/build-info.json"];
  }
  throw new Error(`Unknown transport: ${transport}. Use http or stdio.`);
}

function readOptionValue(rawArgs, index, option) {
  const value = rawArgs[index];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}
