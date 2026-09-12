import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { validateModelPolicy, type ModelChoice } from "./modelPolicy.js";
import { PRODUCT_INFO } from "./productInfo.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ApprovalsReviewer = "user" | "auto_review";
export type AccessStrategy = "read-only" | "adaptive" | "always-full";
/** Includes retired values only to preserve historical records; new execution uses App Server. */
export type CodexBackendKind = "mcp-server" | "app-server" | "codex-sdk";
export function isCodexBackendKind(value: unknown): value is CodexBackendKind {
  return value === "mcp-server" || value === "app-server" || value === "codex-sdk";
}
export type McpTransportMode = "stateless" | "stateful";
export type StateProfile = "stable" | "candidate" | "development";

export const HARD_MAX_CONCURRENT_JOBS = 100;
export const DEFAULT_USER_MAX_CONCURRENT_JOBS = 30;

export type BridgeConfig = {
  host: string;
  port: number;
  token?: string;
  noAuth: boolean;
  allowedHosts?: string[];
  mcpTransportMode: McpTransportMode;
  mcpSessionIdleTtlMs: number;
  maxMcpSessions: number;
  codexCommand: string;
  codexService?: import("./codexService.js").CodexService;
  codexCommandResolver?: () => Promise<string>;
  runtimeStatusResolver?: () => Promise<string[]>;
  defaultBackend: "app-server";
  allowedRoots: string[];
  defaultSandbox: SandboxMode;
  defaultAccessStrategy: AccessStrategy;
  allowWorkspaceWrite: boolean;
  allowDangerFullAccess: boolean;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultApprovalsReviewer: ApprovalsReviewer;
  operatorModelCeiling?: ModelChoice[];
  modelCatalogCacheTtlMs: number;
  modelCatalogTimeoutMs: number;
  modelCatalogStateFile: string;
  stateDatabaseFile: string;
  stateProfile: StateProfile | "explicit";
  upstreamPoolSize: number;
  secretScan: boolean;
  enableRecoveryTools: boolean;
  maxConcurrentJobs: number;
  maxPromptChars: number;
  jobTtlMs: number;
  threadIdleMs?: number;
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
  const mcpTransportMode = parseMcpTransportMode(read("MCP_TRANSPORT_MODE") || "stateless");
  const mcpSessionIdleTtlMs = parsePositiveInt(
    read("MCP_SESSION_IDLE_TTL_MS") || String(30 * 60 * 1000)
  );
  const maxMcpSessions = parsePositiveInt(read("MAX_MCP_SESSIONS") || "64");
  const defaultBackend = parseBackendKind(read("DEFAULT_BACKEND") || "app-server");
  // Project folders are registered in user settings. ROOTS remains only as a
  // backwards-compatible operator ceiling for existing deployments that set
  // it explicitly; a normal installation has no second root registry.
  const configuredRoots = normalizeOptional(read("ROOTS"));
  const allowedRoots = parseAllowedRoots(configuredRoots);
  const defaultSandbox = parseSandbox(read("DEFAULT_SANDBOX") || "read-only");
  const defaultAccessStrategy = parseAccessStrategy(read("DEFAULT_ACCESS_STRATEGY") || "adaptive");
  const allowWorkspaceWrite = parseBool(read("ALLOW_WRITE"));
  const allowDangerFullAccess = parseBool(read("ALLOW_DANGER_FULL_ACCESS"));
  const defaultApprovalPolicy = parseApprovalPolicy(read("APPROVAL_POLICY") || "on-request");
  const defaultApprovalsReviewer = parseApprovalsReviewer(read("APPROVALS_REVIEWER") || "user");
  const operatorModelCeiling = parseModelSelectionCeiling(read("MODEL_SELECTION_CEILING"));
  const modelCatalogCacheTtlMs = parsePositiveInt(read("MODEL_CATALOG_CACHE_TTL_MS") || "600000");
  const modelCatalogTimeoutMs = parsePositiveInt(read("MODEL_CATALOG_TIMEOUT_MS") || "30000");
  const modelCatalogStateFile = parseAbsoluteFilePath(
    read("MODEL_CATALOG_STATE_FILE") || path.join(homedir(), ".codex-mcp-bridge", "models.json"),
    "model catalog state file"
  );
  const explicitStateDatabaseFile = normalizeOptional(read("STATE_DATABASE_FILE"));
  const selectedStateProfile = parseStateProfile(
    normalizeOptional(read("STATE_PROFILE")) || defaultStateProfile()
  );
  const stateDatabaseFile = parseAbsoluteFilePath(
    explicitStateDatabaseFile || stateDatabaseFileForProfile(selectedStateProfile),
    "state database file"
  );
  const stateProfile: StateProfile | "explicit" = explicitStateDatabaseFile
    ? "explicit"
    : selectedStateProfile;
  const secretScan = !parseBool(read("DISABLE_SECRET_SCAN"));
  const enableRecoveryTools = parseBool(read("ENABLE_RECOVERY_TOOLS"));
  const maxConcurrentJobs = parsePositiveInt(
    read("MAX_CONCURRENT_JOBS") || String(HARD_MAX_CONCURRENT_JOBS)
  );
  const upstreamPoolSize = parsePositiveInt(read("UPSTREAM_POOL_SIZE") || String(Math.min(4, maxConcurrentJobs)));
  const maxPromptChars = parsePositiveInt(read("MAX_PROMPT_CHARS") || "50000");
  const jobTtlMs = parsePositiveInt(read("JOB_TTL_MS") || String(6 * 60 * 60 * 1000));
  const threadIdleRaw = read("THREAD_IDLE_MS") ?? String(6 * 60 * 60 * 1000);
  const threadIdleMs = threadIdleRaw === "0" ? 0 : parsePositiveInt(threadIdleRaw);
  const jobStaleAfterMs = parsePositiveInt(read("JOB_STALE_AFTER_MS") || String(10 * 60 * 1000));
  const maxRetainedJobs = parsePositiveInt(read("MAX_RETAINED_JOBS") || "100");
  const maxJobResultBytes = parsePositiveInt(read("MAX_JOB_RESULT_BYTES") || String(1024 * 1024));
  const startupWarnings: string[] = [];
  if (
    PRODUCT_INFO.releaseStage !== "stable" &&
    (stateProfile === "stable" ||
      (stateProfile === "explicit" && stateDatabaseFile === stateDatabaseFileForProfile("stable")))
  ) {
    startupWarnings.push(
      `This ${PRODUCT_INFO.releaseStage} build explicitly targets the stable state profile. ` +
      "Stop the stable runtime and complete the database preflight before continuing."
    );
  }
  if (read("DEFAULT_BACKEND") && read("DEFAULT_BACKEND") !== "app-server") {
    startupWarnings.push("The saved execution backend has been retired. New work uses Codex App Server. Existing history is preserved; use a fresh context with an explicit summary to continue retired sessions.");
  }
  if (configuredRoots) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_ROOTS is a legacy compatibility restriction. Remove it to manage all project folders only from Codex settings."
    );
  }
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
  if (
    normalizeOptional(read("DEFAULT_MODEL")) ||
    normalizeOptional(read("DEFAULT_REASONING_EFFORT"))
  ) {
    startupWarnings.push(
      "CODEX_MCP_BRIDGE_DEFAULT_MODEL and CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT are retired and ignored. Automatic policy requires the caller to select an exact model and reasoning effort for new work."
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
  if (maxConcurrentJobs > HARD_MAX_CONCURRENT_JOBS) {
    throw new Error(
      `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS cannot exceed ${HARD_MAX_CONCURRENT_JOBS}.`
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
    mcpTransportMode,
    mcpSessionIdleTtlMs,
    maxMcpSessions,
    codexCommand: read("CODEX") || "codex",
    defaultBackend,
    allowedRoots,
    defaultSandbox,
    defaultAccessStrategy,
    allowWorkspaceWrite,
    allowDangerFullAccess,
    defaultApprovalPolicy,
    defaultApprovalsReviewer,
    operatorModelCeiling,
    modelCatalogCacheTtlMs,
    modelCatalogTimeoutMs,
    modelCatalogStateFile,
    stateDatabaseFile,
    stateProfile,
    upstreamPoolSize,
    secretScan,
    enableRecoveryTools,
    maxConcurrentJobs,
    maxPromptChars,
    jobTtlMs,
    threadIdleMs,
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
    throw new Error("cwd must be an absolute folder path.");
  }

  const cwd = realpathSync(input);
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`cwd must be a folder: ${cwd}`);
  }
  if (allowedRoots.length === 0) return cwd;
  const match = allowedRoots.some((root) => isPathWithinRoot(cwd, root));
  if (!match) {
    throw new Error(`cwd is outside the legacy operator restriction: ${cwd}`);
  }
  return cwd;
}

export function isPathWithinRoot(
  candidate: string,
  root: string,
  pathApi: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path
): boolean {
  const relative = pathApi.relative(root, candidate);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`))
  );
}

export function resolveAllowedCwd(input: string | undefined, allowedRoots: string[]): string {
  if (input) {
    return requireAllowedCwd(input, allowedRoots);
  }
  if (allowedRoots.length === 1) {
    return allowedRoots[0];
  }
  throw new Error("A registered project folder is required.");
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

function parseAllowedRoots(raw: string | undefined): string[] {
  if (!raw) return [];
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

function parseApprovalsReviewer(raw: string): ApprovalsReviewer {
  if (raw === "user" || raw === "auto_review") return raw;
  throw new Error(`Invalid approvals reviewer: ${raw}`);
}

function parseAccessStrategy(raw: string): AccessStrategy {
  if (raw === "read-only" || raw === "adaptive" || raw === "always-full") {
    return raw;
  }
  throw new Error(`Invalid default access strategy: ${raw}`);
}

function parseBackendKind(raw: string): "app-server" {
  if (raw === "mcp-server" || raw === "app-server" || raw === "codex-sdk") return "app-server";
  throw new Error(`Invalid default Codex backend: ${raw}`);
}

function parseMcpTransportMode(raw: string): McpTransportMode {
  if (raw === "stateless" || raw === "stateful") return raw;
  throw new Error(`Invalid MCP transport mode: ${raw}`);
}

export function defaultStateProfile(): StateProfile {
  return PRODUCT_INFO.releaseStage === "stable"
    ? "stable"
    : PRODUCT_INFO.releaseStage === "candidate"
      ? "candidate"
      : "development";
}

export function stateDatabaseFileForProfile(
  profile: StateProfile,
  homeDirectory = homedir()
): string {
  const base = path.join(homeDirectory, ".codex-mcp-bridge");
  return profile === "stable"
    ? path.join(base, "state.sqlite")
    : path.join(base, "profiles", profile, "state.sqlite");
}

export function parseStateProfile(raw: string): StateProfile {
  if (raw === "stable" || raw === "candidate" || raw === "development") return raw;
  throw new Error(
    "Invalid state profile; CODEX_MCP_BRIDGE_STATE_PROFILE must be stable, candidate, or development."
  );
}

function normalizeOptional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseAbsoluteFilePath(raw: string, label: string): string {
  if (!path.isAbsolute(raw) || /[\r\n]/.test(raw)) {
    throw new Error(`Invalid ${label}; expected an absolute path.`);
  }
  return path.normalize(raw);
}
