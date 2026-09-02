import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readPrivateFile, writePrivateFileAtomic } from "./managed-file.mjs";

export const MANAGED_RUNTIME_STATUS_PROTOCOL = "codex-mcp-bridge-launcher-status";
export const MANAGED_RUNTIME_STATUS_VERSION = 1;

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
    const parsed = JSON.parse(readPrivateFile(resolved, { encoding: "utf8" }));
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
      !(typeof parsed.tunnel.lastError === "string" || parsed.tunnel.lastError === null)
    ) {
      return null;
    }
    const generatedAt = Date.parse(parsed.generatedAt);
    if (!Number.isFinite(generatedAt)) return null;
    const ageMs = Date.now() - generatedAt;
    if (ageMs < -5_000) return null;
    return {
      ...parsed,
      stale: ageMs > maximumAgeMs
    };
  } catch {
    return null;
  }
}
