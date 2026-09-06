import { projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
import { createHash } from "node:crypto";
import { projectSdkResolution } from "./sdkBundleResolution.js";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicRuntimeJson, CodexRuntimeManager, withRuntimeLock, type RuntimeInstaller } from "./codexRuntime.js";
import { downloadVerified, extractVerifiedArchive } from "./runtimeDownloads.js";

const executeFile = promisify(execFile);
export const SDK_DIRECTORY = fileURLToPath(new URL("../sdk/", import.meta.url));
export const SDK_WORKER = path.join(SDK_DIRECTORY, "worker.py");
export function sdkWorkerPath(python: string): string {
  return path.join(path.dirname(path.dirname(path.dirname(python))), "sdk", "worker.py");
}
export function sdkWorkerArguments(python: string): string[] {
  return ["-s", SDK_WORKER, "--bundle-lock", path.join(path.dirname(sdkWorkerPath(python)), "runtime-lock.json")];
}

const lockSchema = z.object({
  schemaVersion: z.literal(1), sdk: z.string(), codexRuntime: z.string(), python: z.string(), pythonBuild: z.string(),
  channel: z.literal("stable"), defaultAuthMode: z.literal("chatgpt"),
  platforms: z.record(z.string(), z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  packages: z.record(z.string(), z.string())
});
export type SdkRuntimeLock = z.infer<typeof lockSchema>;
export const sdkRuntimeLock: SdkRuntimeLock = lockSchema.parse(JSON.parse(await readFile(path.join(SDK_DIRECTORY, "runtime-lock.json"), "utf8")));
const sdkValidationId = createHash("sha256").update(JSON.stringify(JSON.parse(await readFile(path.join(SDK_DIRECTORY, "sdk-contract.json"), "utf8")).responses)).digest("hex");
export type CodexAuthMode = "chatgpt" | "api-key";
const authPolicySchema = z.object({ schemaVersion: z.literal(1), requestedAuthMode: z.enum(["chatgpt", "api-key"]),
  apiBillingConfirmedAt: z.string().nullable() });
export type SdkAuthPolicy = z.infer<typeof authPolicySchema>;
export type SdkAuthStatus = { requestedAuthMode: CodexAuthMode; resolvedAuthMode: CodexAuthMode | null; authenticated: boolean };

export function sdkRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(environment.CODEX_MCP_BRIDGE_RUNTIME_HOME || path.join(homedir(), ".codex-mcp-bridge", "runtimes"), "sdk");
}

export function sdkEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  return { ...Object.fromEntries(keys.flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]])),
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

export function createSdkRuntimeManager(environment: NodeJS.ProcessEnv = process.env): CodexRuntimeManager {
  return new CodexRuntimeManager({
    root: sdkRoot(environment), environment: sdkEnvironment(environment), discoverExternal: false,
    supportedVersions: [sdkRuntimeLock.sdk], allowLatest: true, validationId: sdkValidationId,
    installer: installSdkBundle,
    probe: async command => {
      try { const result = await inspectSdkBundle(command, environment); return result.sdk; } catch { return null; }
    },
    latestVersion: async () => {
      const response = await fetch("https://pypi.org/pypi/openai-codex/json", { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("SDK_UPDATE_CHECK_FAILED");
      return (await response.json() as { info: { version: string } }).info.version;
    }
  });
}

export async function inspectSdkBundle(python: string, environment: NodeJS.ProcessEnv = process.env): Promise<{
  sdk: string; runtime: string; python: string; channel: string
}> {
  const result = await executeFile(python, [...sdkWorkerArguments(python), "--check"], { env: sdkEnvironment(environment), timeout: 20_000, maxBuffer: 4096 });
  const lock = await readInstalledSdkLock(python);
  const info = z.object({ sdk: z.literal(lock.sdk), runtime: z.literal(lock.codexRuntime), python: z.literal(lock.python), channel: z.literal("stable") })
    .parse(JSON.parse(result.stdout));
  return info;
}

export async function readInstalledSdkLock(python: string): Promise<SdkRuntimeLock> {
  return lockSchema.parse(JSON.parse(await readFile(path.join(path.dirname(sdkWorkerPath(python)), "runtime-lock.json"), "utf8")));
}

const installSdkBundle: RuntimeInstaller = async ({ directory, version, previousCommand, onProgress }) => {
  const base = previousCommand ? await readInstalledSdkLock(previousCommand) : sdkRuntimeLock;
  const asset = base.platforms[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("SDK_PLATFORM_UNSUPPORTED");
  const archive = path.join(directory, "python.tgz");
  await downloadVerified(asset.url, archive, "sha256", asset.sha256, "hex", (bytes, total) => onProgress("downloading", bytes, total));
  await onProgress("installing");
  await extractVerifiedArchive(archive, directory, true);
  await rm(archive);
  const python = path.join(directory, "python", "bin", "python3.12");
  await chmod(python, 0o700);
  await mkdir(path.join(directory, "sdk"), { mode: 0o700 });
  await copyFile(SDK_WORKER, path.join(directory, "sdk", "worker.py"));
  await copyFile(path.join(SDK_DIRECTORY, "sdk-contract.json"), path.join(directory, "sdk", "sdk-contract.json"));
  const requirements = path.join(directory, "sdk", "requirements.lock");
  if (previousCommand) {
    if (base.sdk !== version) throw new Error("SDK_BUNDLE_VERSION_MISMATCH");
    await copyFile(path.join(path.dirname(sdkWorkerPath(previousCommand)), "requirements.lock"), requirements);
    await atomicRuntimeJson(path.join(directory, "sdk", "runtime-lock.json"), base);
  } else {
    const report = path.join(directory, "resolution.json");
    await executeFile(python, ["-s", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-cache-dir", "--dry-run", "--ignore-installed",
      "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "--report", report, `openai-codex==${version}`],
      { env: sdkEnvironment(), timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
    const resolved = projectSdkResolution(JSON.parse(await readFile(report, "utf8")), version);
    await writeFile(requirements, resolved.requirements, { mode: 0o600 });
    await atomicRuntimeJson(path.join(directory, "sdk", "runtime-lock.json"), { ...base, sdk: version, codexRuntime: resolved.codexRuntime, packages: resolved.packages });
    await rm(report);
  }
  await executeFile(python, ["-s", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-cache-dir",
    "--require-hashes", "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "-r", requirements],
    { env: sdkEnvironment(), timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
  await onProgress("verifying");
  const info = await inspectSdkBundle(python);
  if (info.python !== base.python) throw new Error("SDK_PYTHON_VERSION_MISMATCH");
  await executeFile(python, [...sdkWorkerArguments(python), "--health-check"], { env: sdkEnvironment(), timeout: 30_000, maxBuffer: 4096 });
  return python;
};

export async function readSdkAuthPolicy(environment: NodeJS.ProcessEnv = process.env): Promise<SdkAuthPolicy> {
  try {
    const policy = authPolicySchema.parse(JSON.parse(await readFile(path.join(sdkRoot(environment), "auth-policy.json"), "utf8")));
    if (policy.requestedAuthMode === "api-key" && !policy.apiBillingConfirmedAt) throw new Error("SDK_API_CONFIRMATION_REQUIRED");
    return policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, requestedAuthMode: "chatgpt", apiBillingConfirmedAt: null };
    throw new Error("SDK_AUTH_POLICY_INVALID: Restore your local authentication choice before using the SDK.");
  }
}

export function sdkAuthArguments(policy: SdkAuthPolicy, environment: NodeJS.ProcessEnv = process.env, profile?: string): string[] {
  if (profile) return ["--auth-mode", policy.requestedAuthMode, "--profile", profile];
  return ["--auth-mode", policy.requestedAuthMode, ...(policy.requestedAuthMode === "api-key"
    ? ["--profile", path.join(sdkRoot(environment), "profiles", "api-key")] : [])];
}

export async function readSdkAuthStatus(python: string, environment: NodeJS.ProcessEnv = process.env, profile?: string, mode?: CodexAuthMode): Promise<SdkAuthStatus> {
  const policy = { ...await readSdkAuthPolicy(environment), ...(mode ? { requestedAuthMode: mode } : {}) };
  try {
    const result = await executeFile(python, [...sdkWorkerArguments(python), "--auth-status", ...sdkAuthArguments(policy, environment, profile)],
      { env: sdkEnvironment(environment), timeout: 25_000, maxBuffer: 4096 });
    return authStatusSchema.parse(JSON.parse(result.stdout));
  } catch { return { requestedAuthMode: policy.requestedAuthMode, resolvedAuthMode: null, authenticated: false }; }
}
const authStatusSchema = z.object({ requestedAuthMode: z.enum(["chatgpt", "api-key"]), resolvedAuthMode: z.enum(["chatgpt", "api-key"]).nullable(), authenticated: z.boolean() });

/** This is exposed only on the current-user helper socket, never through MCP. */
export async function configureSdkAuth(
  input: { authMode: CodexAuthMode; confirmApiBilling?: boolean; apiKey?: string },
  environment: NodeJS.ProcessEnv = process.env
): Promise<SdkAuthStatus> {
  const root = sdkRoot(environment);
  return withRuntimeLock(root, "auth", async () => {
    const manager = createSdkRuntimeManager(environment);
    const snapshot = await manager.snapshot();
    if (snapshot.runningVersions.length) throw new Error("SDK_AUTH_IN_USE: Stop the bridge safely before changing authentication.");
    if (input.authMode === "api-key" && input.confirmApiBilling !== true) throw new Error("SDK_API_CONFIRMATION_REQUIRED: API usage follows OpenAI Platform billing.");
    const { selection: selected, release } = await manager.acquire();
    try {
      const policy: SdkAuthPolicy = { schemaVersion: 1, requestedAuthMode: input.authMode,
        apiBillingConfirmedAt: input.authMode === "api-key" ? new Date().toISOString() : null };
      if (input.authMode === "api-key") {
        if (!input.apiKey?.trim() || input.apiKey.length > 32768 || /[\r\n]/.test(input.apiKey)) throw new Error("SDK_API_KEY_REQUIRED");
        const profile = path.join(root, "profiles", "api-key");
        await mkdir(profile, { recursive: true, mode: 0o700 });
        await chmod(profile, 0o700);
        await loginSdkApiKey(selected.command, input.apiKey, policy, environment);
        await chmod(path.join(profile, "auth.json"), 0o600).catch(() => undefined);
      }
      await atomicRuntimeJson(path.join(root, "auth-policy.json"), policy);
      return await readSdkAuthStatus(selected.command, environment);
    } finally { await release(); }
  });
}

async function loginSdkApiKey(python: string, apiKey: string, policy: SdkAuthPolicy, environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [...sdkWorkerArguments(python), "--login-api-key", ...sdkAuthArguments(policy, environment)], {
      env: sdkEnvironment(environment), stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32"
    });
    const timer = setTimeout(() => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
      reject(new Error("SDK_API_LOGIN_FAILED"));
    }, 30_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("SDK_API_LOGIN_FAILED")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("SDK_API_LOGIN_FAILED")); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(apiKey + "\n");
  });
}

export async function sdkLoginCommand(python: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const result = await executeFile(python, [...sdkWorkerArguments(python), "--runtime-path"], { env: sdkEnvironment(environment), timeout: 20_000, maxBuffer: 4096 });
  const command = result.stdout.trim();
  if (!path.isAbsolute(command)) throw new Error("SDK_RUNTIME_UNAVAILABLE");
  return command;
}

export async function readSdkAccountSnapshot(python: string, environment: NodeJS.ProcessEnv, profile: string, mode: CodexAuthMode): Promise<CodexAccountSnapshot> {
  const result = await executeFile(python, [...sdkWorkerArguments(python), "--account-status", "--auth-mode", mode, "--profile", profile],
    { env: sdkEnvironment(environment), timeout: 25_000, maxBuffer: 64 * 1024 });
  const response = JSON.parse(result.stdout);
  return projectCodexAccount(response.account, response.limits);
}
