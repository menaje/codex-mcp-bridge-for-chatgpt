import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { readPrivateFile, writePrivateFileAtomic } from "./managed-file.mjs";
import { parseJsonUtf8Strict } from "./text-integrity.mjs";
import { CODEX_APPLIED_ENV_KEYS, codexChildEnvironmentFingerprint } from "./runtime-env.mjs";

export const MANAGED_RUNTIME_STATUS_PROTOCOL = "codex-mcp-bridge-launcher-status";
export const MANAGED_RUNTIME_STATUS_VERSION = 1;

// Scoped to the helper's initial-start attempt. Legacy startup and recovery
// deadlines stay unchanged when this private context is absent.
export function initialStartupContext(environment = process.env) {
  const requestId = environment.CODEX_MCP_BRIDGE_INITIAL_START_REQUEST;
  const token = environment.CODEX_MCP_BRIDGE_INITIAL_START_TOKEN;
  const attempt = Number(environment.CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT);
  const deadlineAt = Number(environment.CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!requestId && !token) return null;
  if (!uuid.test(requestId || "") || !uuid.test(token || "") ||
      !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3 ||
      !Number.isSafeInteger(deadlineAt)) throw new Error("STARTUP_CONTEXT_INVALID");
  return { requestId, token, attempt, deadlineAt };
}
export function initialStartupStageTimeout(initialLimit, legacyLimit, environment = process.env, now = Date.now()) {
  const context = initialStartupContext(environment);
  return context ? Math.max(0, Math.min(initialLimit, context.deadlineAt - now)) : legacyLimit;
}

/** Opt-in process timing only. Callers use fixed role and stage names. */
export function createStartupDiagnostics(role, {
  environment = process.env,
  emit = line => process.stderr.write(line)
} = {}) {
  if (environment.CODEX_MCP_BRIDGE_STARTUP_DIAGNOSTICS !== "1") return () => {};
  let previous = 0;
  return stage => {
    const elapsed = performance.now();
    const cpu = process.cpuUsage();
    emit(`[bridge-startup] ${JSON.stringify({
      role,
      stage,
      pid: process.pid,
      elapsedMs: Math.round(elapsed * 10) / 10,
      stepMs: Math.round((elapsed - previous) * 10) / 10,
      cpuUserMs: Math.round(cpu.user / 100) / 10,
      cpuSystemMs: Math.round(cpu.system / 100) / 10
    })}\n`);
    previous = elapsed;
  };
}

// The supported tunnel client uses a 30-second long poll plus a 5-second
// guardrail. Allow two such windows and one monitor interval, but never accept
// its "one poll has succeeded" flag as indefinite connectivity evidence.
export const MAX_TUNNEL_CONTROL_PLANE_AGE_MS = 75_000;
export function hasRecentTunnelControlPlanePoll(report, now = Date.now()) {
  const poll = report?.control_plane_poll;
  if (poll?.ok !== true || !Number.isFinite(poll.value) || poll.value <= 0) return false;
  const age = now - poll.value * 1000;
  return age >= -5_000 && age <= MAX_TUNNEL_CONTROL_PLANE_AGE_MS;
}

export function writeManagedRuntimeStatus(filePath, status) {
  if (!filePath) return;
  const payload = {
    ...status,
    protocol: MANAGED_RUNTIME_STATUS_PROTOCOL,
    version: MANAGED_RUNTIME_STATUS_VERSION,
    generatedAt: new Date().toISOString(),
    launcherPid: process.pid
  };
  writePrivateFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8"
  });
}

export function readManagedRuntimeStatus(filePath, { maximumAgeMs = 20_000 } = {}) {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) return null;
  try {
    const parsed = parseJsonUtf8Strict(readPrivateFile(resolved), "Managed runtime status");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.protocol !== MANAGED_RUNTIME_STATUS_PROTOCOL ||
      parsed.version !== MANAGED_RUNTIME_STATUS_VERSION ||
      typeof parsed.generatedAt !== "string" ||
      !Number.isSafeInteger(parsed.launcherPid) ||
      parsed.launcherPid <= 0 ||
      typeof parsed.phase !== "string" ||
      typeof parsed.runtimeBuildId !== "string" ||
      !(parsed.codexEnvironmentFingerprint === undefined ||
        (typeof parsed.codexEnvironmentFingerprint === "string" && /^[a-f0-9]{64}$/.test(parsed.codexEnvironmentFingerprint))) ||
      !validCodexEnvironment(parsed.codexEnvironment) ||
      (parsed.codexEnvironment !== undefined &&
        parsed.codexEnvironmentFingerprint !== codexChildEnvironmentFingerprint(parsed.codexEnvironment)) ||
      !parsed.tunnel ||
      typeof parsed.tunnel !== "object" ||
      typeof parsed.tunnel.phase !== "string" ||
      !(typeof parsed.tunnel.profile === "string" || parsed.tunnel.profile === null) ||
      !(typeof parsed.tunnel.transport === "string" || parsed.tunnel.transport === null) ||
      typeof parsed.tunnel.doctorPassed !== "boolean" ||
      typeof parsed.tunnel.processRunning !== "boolean" ||
      typeof parsed.tunnel.connected !== "boolean" ||
      !(
        typeof parsed.tunnel.lastCheckedAt === "string" ||
        parsed.tunnel.lastCheckedAt === null
      ) ||
      !(typeof parsed.tunnel.lastError === "string" || parsed.tunnel.lastError === null) ||
      !validStatusProblem(parsed.tunnel.lastProblem) ||
      !validTunnelObservation(parsed.tunnel.observation) ||
      (parsed.startup !== undefined && !validInitialStartupStatus(parsed.startup))
    ) {
      return null;
    }
    const generatedAt = Date.parse(parsed.generatedAt);
    if (!Number.isFinite(generatedAt)) return null;
    const ageMs = Date.now() - generatedAt;
    if (ageMs < -5_000) return null;
    return {
      ...parsed,
      tunnel: {
        ...parsed.tunnel,
        lastProblem: parsed.tunnel.lastProblem ?? null
      },
      stale: ageMs > maximumAgeMs
    };
  } catch {
    return null;
  }
}

function validCodexEnvironment(value) {
  if (value === undefined) return true; // Older launchers do not publish it.
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(CODEX_APPLIED_ENV_KEYS);
  return Object.entries(value).every(([name, entry]) =>
    allowed.has(name) && typeof entry === "string" && entry.length <= 32_768
  ) && JSON.stringify(value).length <= 128 * 1024;
}

function validStatusProblem(value) {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.code !== "string" || !/^[a-z0-9-]{1,80}$/.test(value.code)) return false;
  if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) {
    return false;
  }
  return Object.entries(value.arguments).every(([key, entry]) =>
    /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) &&
    typeof entry === "string" &&
    entry.length <= 500
  );
}

function validTunnelObservation(value) {
  if (value === undefined) return true; // Version 1 launchers without diagnostics.
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const validFailure = failure => failure === null ||
    (typeof failure === "string" && /^[a-z-]{1,80}$/.test(failure));
  const endpoint = entry => entry && typeof entry === "object" &&
    (entry.status === null || (Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599)) &&
    validFailure(entry.failure);
  const poll = value.controlPlanePoll;
  return endpoint(value.healthz) && endpoint(value.readyz) && validFailure(value.failure) &&
    poll && typeof poll === "object" && typeof poll.fresh === "boolean" && validFailure(poll.failure) &&
    (poll.lastSuccessfulAt === null || (typeof poll.lastSuccessfulAt === "string" &&
      Number.isFinite(Date.parse(poll.lastSuccessfulAt))));
}

function validInitialStartupStatus(value) {
  if (!value || typeof value !== "object") return false;
  try {
    const context = initialStartupContext({
      CODEX_MCP_BRIDGE_INITIAL_START_REQUEST: value.requestId,
      CODEX_MCP_BRIDGE_INITIAL_START_TOKEN: value.token,
      CODEX_MCP_BRIDGE_INITIAL_START_ATTEMPT: String(value.attempt),
      CODEX_MCP_BRIDGE_INITIAL_START_DEADLINE: String(value.deadlineAt)
    });
    return (value.readyAt === undefined || value.readyAt === null || Number.isSafeInteger(value.readyAt)) &&
      (value.causeCode === undefined || value.causeCode === null ||
      /^(STATE_STORAGE_(BUSY|FULL|IO|CORRUPT|READ_ONLY)|RUNTIME_REQUEST_FAILED)$/.test(value.causeCode)) &&
      context !== null && ["launching", "state-owner", "http", "tunnel", "ready"].includes(value.stage) &&
      (value.failureCode === null || (typeof value.failureCode === "string" && /^STARTUP_[A-Z_]{2,70}$/.test(value.failureCode)));
  } catch { return false; }
}
