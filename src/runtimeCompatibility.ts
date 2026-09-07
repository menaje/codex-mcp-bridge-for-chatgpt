import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "./jsonRpcProcess.js";

/** Diagnostic evidence of the installation check, never a version or schema allowlist. */
export const CLI_INSTALL_VALIDATION_ID = "app-server-initialize-v1";

export function normalizeProtocolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProtocolSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["description", "title", "$schema"].includes(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, normalizeProtocolSchema(entry)]));
  return value;
}

/** Check the public connection contract without authentication, model execution, or schema hashes. */
export async function verifyCliConnection(command: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "codex-connection-"));
  const rpc = new JsonRpcProcess({ command, args: ["app-server", "--listen", "stdio://"],
    env: { ...environment, CODEX_HOME: home }, omitJsonRpcHeader: true, debugLabel: "Codex connection check" });
  try {
    const result = await rpc.request("initialize", {
      clientInfo: { name: "codex_bridge_check", version: "1" }, capabilities: { experimentalApi: true }
    }, { timeoutMs: 15_000 });
    validateInitializeResponse(result);
    await rpc.notify("initialized");
  } finally {
    try { await rpc.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
}

export function validateInitializeResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CODEX_PROTOCOL_INCOMPATIBLE: App Server initialize must return an object.");
  }
  const fields = ["userAgent", "platformFamily", "platformOs"].filter(field =>
    typeof (value as Record<string, unknown>)[field] !== "string");
  if (fields.length) throw new Error(`CODEX_PROTOCOL_INCOMPATIBLE: App Server initialize is missing string field(s): ${fields.join(", ")}.`);
}
