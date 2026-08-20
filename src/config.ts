import path from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";

export type SandboxMode = "read-only" | "workspace-write";
export type ApprovalPolicy = "untrusted" | "on-request";

export type BridgeConfig = {
  host: string;
  port: number;
  token?: string;
  noAuth: boolean;
  allowedHosts?: string[];
  codexCommand: string;
  allowedRoots: string[];
  defaultSandbox: SandboxMode;
  allowWorkspaceWrite: boolean;
  defaultApprovalPolicy: ApprovalPolicy;
  upstreamTimeoutMs: number;
  fastReturnMs: number;
  secretScan: boolean;
  maxConcurrentJobs: number;
  maxPromptChars: number;
  jobTtlMs: number;
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
  const allowedRoots = parseAllowedRoots(read("ROOTS") || process.cwd());
  const defaultSandbox = parseSandbox(read("DEFAULT_SANDBOX") || "read-only");
  const allowWorkspaceWrite = parseBool(read("ALLOW_WRITE"));
  const defaultApprovalPolicy = parseApprovalPolicy(read("APPROVAL_POLICY") || "on-request");
  const upstreamTimeoutMs = parsePositiveInt(read("UPSTREAM_TIMEOUT_MS") || "180000");
  const fastReturnMs = parsePositiveInt(read("FAST_RETURN_MS") || "25000");
  const secretScan = !parseBool(read("DISABLE_SECRET_SCAN"));
  const maxConcurrentJobs = parsePositiveInt(read("MAX_CONCURRENT_JOBS") || "2");
  const maxPromptChars = parsePositiveInt(read("MAX_PROMPT_CHARS") || "50000");
  const jobTtlMs = parsePositiveInt(read("JOB_TTL_MS") || String(6 * 60 * 60 * 1000));

  if (!token && !noAuth) {
    throw new Error("Set CODEX_MCP_BRIDGE_TOKEN, or set CODEX_MCP_BRIDGE_NO_AUTH=1 for local-only development.");
  }
  if (noAuth && !LOCAL_HOSTS.has(host)) {
    throw new Error("CODEX_MCP_BRIDGE_NO_AUTH=1 is allowed only for local host bindings.");
  }

  if (defaultSandbox === "workspace-write" && !allowWorkspaceWrite) {
    throw new Error("Default sandbox workspace-write requires CODEX_MCP_BRIDGE_ALLOW_WRITE=1.");
  }

  return {
    host,
    port,
    token,
    noAuth,
    allowedHosts,
    codexCommand: read("CODEX") || "codex",
    allowedRoots,
    defaultSandbox,
    allowWorkspaceWrite,
    defaultApprovalPolicy,
    upstreamTimeoutMs,
    fastReturnMs,
    secretScan,
    maxConcurrentJobs,
    maxPromptChars,
    jobTtlMs
  };
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
  return sandbox;
}

export function findSensitiveFiles(root: string, maxFindings = 20): string[] {
  const findings: string[] = [];
  const skipDirs = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);
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

  function walk(dir: string): void {
    if (findings.length >= maxFindings) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (findings.length >= maxFindings) {
        return;
      }
      const fullPath = path.join(dir, entry.name);
      const basename = entry.name;
      const lower = basename.toLowerCase();
      if (
        deniedBasenames.has(lower) ||
        (lower.startsWith(".env.") && lower !== ".env.example") ||
        deniedExtensions.some((ext) => lower.endsWith(ext))
      ) {
        findings.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
    }
  }

  if (existsSync(root) && statSync(root).isDirectory()) {
    walk(root);
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

function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseSandbox(raw: string): SandboxMode {
  if (raw === "read-only" || raw === "workspace-write") {
    return raw;
  }
  throw new Error(`Invalid sandbox: ${raw}`);
}

function parseApprovalPolicy(raw: string): ApprovalPolicy {
  if (raw === "untrusted" || raw === "on-request") {
    return raw;
  }
  throw new Error(`Invalid approval policy: ${raw}`);
}

function normalizeOptional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
