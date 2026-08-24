import path from "node:path";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { validateModelPolicy, type ModelChoice } from "./modelPolicy.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type AccessStrategy = "read-only" | "adaptive" | "always-full";
export type CodexBackendKind = "mcp-server" | "app-server";

export type BridgeConfig = {
  host: string;
  port: number;
  token?: string;
  noAuth: boolean;
  allowedHosts?: string[];
  codexCommand: string;
  defaultBackend: CodexBackendKind;
  allowedRoots: string[];
  defaultSandbox: SandboxMode;
  defaultAccessStrategy: AccessStrategy;
  allowWorkspaceWrite: boolean;
  allowDangerFullAccess: boolean;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  operatorModelCeiling?: ModelChoice[];
  modelCatalogCacheTtlMs: number;
  modelCatalogTimeoutMs: number;
  modelCatalogStateFile: string;
  stateDatabaseFile: string;
  settingsStateFile: string;
  sessionStateFile: string;
  jobStateFile: string;
  upstreamPoolSize: number;
  secretScan: boolean;
  maxConcurrentJobs: number;
  maxPromptChars: number;
  jobTtlMs: number;
  jobStaleAfterMs: number;
  maxRetainedJobs: number;
  maxJobResultBytes: number;
  startupWarnings: string[];
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const read = (name: string): string | undefined =>
    env[`CODEX_MCP_BRIDGE_${name}`] ?? env[`CODEX_GPT_BRIDGE_${name}`];
  const host = read("HOST") || "127.0.0.1";
  const port = parsePort(read("PORT") || "8765");
  const token = normalizeOptional(read("TOKEN"));
  const noAuth = parseBool(read("NO_AUTH"));
  const allowedHosts = parseAllowedHosts(read("ALLOWED_HOSTS"));
  const defaultBackend = parseBackendKind(read("DEFAULT_BACKEND") || "mcp-server");
  const allowedRoots = parseAllowedRoots(read("ROOTS") || process.cwd());
  const defaultSandbox = parseSandbox(read("DEFAULT_SANDBOX") || "read-only");
  const defaultAccessStrategy = parseAccessStrategy(read("DEFAULT_ACCESS_STRATEGY") || "adaptive");
  const allowWorkspaceWrite = parseBool(read("ALLOW_WRITE"));
  const allowDangerFullAccess = parseBool(read("ALLOW_DANGER_FULL_ACCESS"));
  const defaultApprovalPolicy = parseApprovalPolicy(read("APPROVAL_POLICY") || "on-request");
  const defaultModel = parseOptionalIdentifier(read("DEFAULT_MODEL"), "default model id", 200);
  const defaultReasoningEffort = parseOptionalIdentifier(
    read("DEFAULT_REASONING_EFFORT"),
    "default reasoning effort",
    100
  );
  const operatorModelCeiling = parseModelSelectionCeiling(read("MODEL_SELECTION_CEILING"));
  const modelCatalogCacheTtlMs = parsePositiveInt(read("MODEL_CATALOG_CACHE_TTL_MS") || "600000");
  const modelCatalogTimeoutMs = parsePositiveInt(read("MODEL_CATALOG_TIMEOUT_MS") || "30000");
  const modelCatalogStateFile = parseAbsoluteFilePath(
    read("MODEL_CATALOG_STATE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "models.json"),
    "model catalog state file"
  );
  const stateDatabaseFile = parseAbsoluteFilePath(
    read("STATE_DATABASE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "state.sqlite"),
    "state database file"
  );
  const settingsStateFile = parseAbsoluteFilePath(
    read("SETTINGS_STATE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "settings.json"),
    "settings state file"
  );
  const sessionStateFile = parseAbsoluteFilePath(
    read("SESSION_STATE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "sessions.json"),
    "session state file"
  );
  const jobStateFile = parseAbsoluteFilePath(
    read("JOB_STATE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "jobs.json"),
    "job state file"
  );
  const secretScan = !parseBool(read("DISABLE_SECRET_SCAN"));
  const maxConcurrentJobs = parsePositiveInt(read("MAX_CONCURRENT_JOBS") || "30");
  const upstreamPoolSize = parsePositiveInt(read("UPSTREAM_POOL_SIZE") || String(Math.min(4, maxConcurrentJobs)));
  const maxPromptChars = parsePositiveInt(read("MAX_PROMPT_CHARS") || "50000");
  const jobTtlMs = parsePositiveInt(read("JOB_TTL_MS") || String(6 * 60 * 60 * 1000));
  const jobStaleAfterMs = parsePositiveInt(read("JOB_STALE_AFTER_MS") || String(10 * 60 * 1000));
  const maxRetainedJobs = parsePositiveInt(read("MAX_RETAINED_JOBS") || "100");
  const maxJobResultBytes = parsePositiveInt(read("MAX_JOB_RESULT_BYTES") || String(1024 * 1024));
  const startupWarnings: string[] = [];
  if (normalizeOptional(read("FAST_RETURN_MS"))) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_FAST_RETURN_MS is retired and ignored. Choose foreground or background explicitly; background returns immediately."
    );
  }
  if (normalizeOptional(read("UPSTREAM_TIMEOUT_MS"))) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS is retired and ignored. Codex execution is unlimited-only; use supervised force-stop when needed."
    );
  }
  if (normalizeOptional(read("DEFAULT_SESSION_MODE"))) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_DEFAULT_SESSION_MODE is retired and ignored. Session selection is managed by each Activity."
    );
  }
  if (normalizeOptional(read("AUTO_RESUME_TTL_MS"))) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_AUTO_RESUME_TTL_MS is retired and ignored. Exact Activity thread continuation has no age limit."
    );
  }

  if (!token && !noAuth) {
    throw new Error("Set CODEX_MCP_BRIDGE_TOKEN, or set CODEX_MCP_BRIDGE_NO_AUTH=1 for local-only development.");
  }
  if (noAuth && !LOCAL_HOSTS.has(host)) {
    throw new Error("CODEX_MCP_BRIDGE_NO_AUTH=1 is allowed only for local host bindings.");
  }

  if (defaultSandbox === "workspace-write" && !allowWorkspaceWrite) {
    throw new Error("Default sandbox workspace-write requires CODEX_MCP_BRIDGE_ALLOW_WRITE=1.");
  }
  if (defaultSandbox === "danger-full-access" && !allowDangerFullAccess) {
    throw new Error(
      "Default sandbox danger-full-access requires CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=1."
    );
  }
  if (defaultAccessStrategy === "always-full" && !allowDangerFullAccess) {
    throw new Error(
      "Default access strategy always-full requires CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=1."
    );
  }
  if (defaultReasoningEffort && !defaultModel) {
    throw new Error("CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT requires CODEX_MCP_BRIDGE_DEFAULT_MODEL.");
  }
  if (defaultModel && !defaultReasoningEffort) {
    throw new Error(
      "CODEX_MCP_BRIDGE_DEFAULT_MODEL requires CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT because model policy selections are exact pairs."
    );
  }
  if (upstreamPoolSize > maxConcurrentJobs) {
    throw new Error("CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE cannot exceed CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS.");
  }
  if (maxRetainedJobs < maxConcurrentJobs) {
    throw new Error("CODEX_MCP_BRIDGE_MAX_RETAINED_JOBS cannot be lower than CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS.");
  }

  return {
    host,
    port,
    token,
    noAuth,
    allowedHosts,
    codexCommand: read("CODEX") || "codex",
    defaultBackend,
    allowedRoots,
    defaultSandbox,
    defaultAccessStrategy,
    allowWorkspaceWrite,
    allowDangerFullAccess,
    defaultApprovalPolicy,
    defaultModel,
    defaultReasoningEffort,
    operatorModelCeiling,
    modelCatalogCacheTtlMs,
    modelCatalogTimeoutMs,
    modelCatalogStateFile,
    stateDatabaseFile,
    settingsStateFile,
    sessionStateFile,
    jobStateFile,
    upstreamPoolSize,
    secretScan,
    maxConcurrentJobs,
    maxPromptChars,
    jobTtlMs,
    jobStaleAfterMs,
    maxRetainedJobs,
    maxJobResultBytes,
    startupWarnings
  };
}

function parseModelSelectionCeiling(value: string | undefined): ModelChoice[] | undefined {
  const normalized = normalizeOptional(value);
  if (!normalized) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(
      "CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING must be a JSON array of model/reasoningEffort choices."
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 500) {
    throw new Error(
      "CODEX_MCP_BRIDGE_MODEL_SELECTION_CEILING must contain between 1 and 500 model/reasoningEffort choices."
    );
  }
  const normalizedSelections = parsed.map((selection) => {
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) return selection;
    const choice = { ...(selection as Record<string, unknown>) };
    delete choice.serviceTier;
    return choice;
  });
  const unique = [...new Map(normalizedSelections.map((selection) => {
    const choice = selection as Record<string, unknown>;
    return [JSON.stringify([choice?.model, choice?.reasoningEffort]), selection];
  })).values()];
  const policy = validateModelPolicy({
    mode: "automatic",
    allowedSelections: { kind: "explicit", selections: unique },
    constraints: { allowDelegation: true }
  });
  if (policy.mode !== "automatic" || policy.allowedSelections.kind !== "explicit") {
    throw new Error("Invalid operator model selection ceiling.");
  }
  return policy.allowedSelections.selections;
}

export function requireAllowedCwd(input: string, allowedRoots: string[]): string {
  if (!input || !path.isAbsolute(input)) {
    throw new Error("cwd must be an absolute path inside CODEX_MCP_BRIDGE_ROOTS.");
  }

  const cwd = realpathSync(input);
  const match = allowedRoots.some((root) => cwd === root || cwd.startsWith(root + path.sep));
  if (!match) {
    throw new Error(`cwd is outside allowed roots: ${cwd}`);
  }
  return cwd;
}

export function resolveAllowedCwd(input: string | undefined, allowedRoots: string[]): string {
  if (input) {
    return requireAllowedCwd(input, allowedRoots);
  }
  if (allowedRoots.length === 1) {
    return allowedRoots[0];
  }
  throw new Error("cwd is required when multiple CODEX_MCP_BRIDGE_ROOTS are configured.");
}

export function enforceSandbox(config: BridgeConfig, requested?: SandboxMode): SandboxMode {
  const sandbox = requested || config.defaultSandbox;
  if (sandbox === "workspace-write" && !config.allowWorkspaceWrite) {
    throw new Error("workspace-write is disabled. Set CODEX_MCP_BRIDGE_ALLOW_WRITE=1 to allow it.");
  }
  if (sandbox === "danger-full-access" && !config.allowDangerFullAccess) {
    throw new Error(
      "danger-full-access is disabled. Set CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=1 to allow it."
    );
  }
  return sandbox;
}

const sensitiveFileScans = new Map<string, Promise<string[]>>();

export function findSensitiveFiles(root: string, maxFindings = 20): Promise<string[]> {
  const key = `${root}\0${maxFindings}`;
  const existing = sensitiveFileScans.get(key);
  if (existing) return existing;
  const scan = scanSensitiveFiles(root, maxFindings).finally(() => {
    if (sensitiveFileScans.get(key) === scan) sensitiveFileScans.delete(key);
  });
  sensitiveFileScans.set(key, scan);
  return scan;
}

async function scanSensitiveFiles(root: string, maxFindings: number): Promise<string[]> {
  const findings: string[] = [];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".next",
    ".turbo",
    ".vscode-test",
    ".build",
    "target"
  ]);
  const deniedBasenames = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "id_dsa",
    "id_ecdsa"
  ]);
  const deniedExtensions = [".pem", ".key", ".p12", ".pfx"];

  let directories = [root];
  while (directories.length > 0 && findings.length < maxFindings) {
    const batch = directories.splice(0, 32);
    const results = await Promise.all(
      batch.map(async (directory) => {
        try {
          return { directory, entries: await readdir(directory, { withFileTypes: true }), error: undefined };
        } catch (error) {
          return { directory, entries: [], error };
        }
      })
    );

    for (const { directory, entries, error } of results) {
      if (directory === root && error) {
        throw new Error(
          `Could not scan the Codex working directory for sensitive files: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      for (const entry of entries) {
        if (findings.length >= maxFindings) break;
        const fullPath = path.join(directory, entry.name);
        const lower = entry.name.toLowerCase();
        if (
          deniedBasenames.has(lower) ||
          (lower.startsWith(".env.") && lower !== ".env.example") ||
          deniedExtensions.some((ext) => lower.endsWith(ext))
        ) {
          findings.push(fullPath);
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !skipDirs.has(entry.name)) directories.push(fullPath);
      }
    }
  }
  return findings.sort();
}

function parseAllowedRoots(raw: string): string[] {
  const roots = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!path.isAbsolute(part)) {
        throw new Error(`Allowed root must be absolute: ${part}`);
      }
      return realpathSync(part);
    });
  if (roots.length === 0) {
    throw new Error("At least one allowed root is required.");
  }
  return Array.from(new Set(roots));
}

function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  const hosts = raw
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return hosts && hosts.length > 0 ? Array.from(new Set(hosts)) : undefined;
}

function parsePort(raw: string): number {
  const port = parsePositiveInt(raw);
  if (port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

function parsePositiveInt(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return value;
}

function parsePositiveIntAtMost(raw: string, maximum: number, label: string): number {
  const value = parsePositiveInt(raw);
  if (value > maximum) {
    throw new Error(`${label} cannot exceed ${maximum} milliseconds.`);
  }
  return value;
}

function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseSandbox(raw: string): SandboxMode {
  if (raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access") {
    return raw;
  }
  throw new Error(`Invalid sandbox: ${raw}`);
}

function parseApprovalPolicy(raw: string): ApprovalPolicy {
  if (raw === "untrusted" || raw === "on-request" || raw === "never") {
    return raw;
  }
  throw new Error(`Invalid approval policy: ${raw}`);
}

function parseAccessStrategy(raw: string): AccessStrategy {
  if (raw === "read-only" || raw === "adaptive" || raw === "always-full") {
    return raw;
  }
  throw new Error(`Invalid default access strategy: ${raw}`);
}

function parseBackendKind(raw: string): CodexBackendKind {
  if (raw === "mcp-server" || raw === "app-server") return raw;
  throw new Error(`Invalid default Codex backend: ${raw}`);
}

function normalizeOptional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseOptionalIdentifier(raw: string | undefined, label: string, maxLength: number): string | undefined {
  const value = normalizeOptional(raw);
  if (!value) return undefined;
  if (value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function parseAbsoluteFilePath(raw: string, label: string): string {
  if (!path.isAbsolute(raw) || /[\r\n]/.test(raw)) {
    throw new Error(`Invalid ${label}; expected an absolute path.`);
  }
  return path.normalize(raw);
}
