import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import contract from "../sdk/cli-contract.json" with { type: "json" };

const execute = promisify(execFile);
export const CLI_CONTRACT_ID = createHash("sha256").update(JSON.stringify(contract.files)).digest("hex");

export function normalizeProtocolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProtocolSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["description", "title", "$schema"].includes(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, normalizeProtocolSchema(entry)]));
  return value;
}

/** Conservative offline contract admission. New schema files are allowed; existing contracts must match. */
export async function verifyManagedCliContract(command: string, version: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), "codex-contract-"));
  try {
    await execute(command, ["app-server", "generate-json-schema", "--experimental", "--out", temporary],
      { env: { ...environment, CODEX_HOME: temporary }, timeout: 60_000, maxBuffer: 1024 * 1024 });
    for (const [name, expected] of Object.entries(contract.files)) {
      const value = JSON.parse(await readFile(path.join(temporary, name), "utf8"));
      const actual = createHash("sha256").update(JSON.stringify(normalizeProtocolSchema(value))).digest("hex");
      if (actual !== expected) throw new Error("CODEX_PROTOCOL_INCOMPATIBLE");
    }
    const sha256 = createHash("sha256").update(await readFile(command)).digest("hex");
    await writeFile(`${command}.bridge-compatibility.json`, JSON.stringify({ contract: CLI_CONTRACT_ID, version, sha256 }), { mode: 0o600 });
  } catch { throw new Error("CODEX_PROTOCOL_INCOMPATIBLE: The latest version did not pass the bridge protocol checks. Choose a known compatible version explicitly or keep your current installation."); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function hasManagedCliVerification(command: string, version: string): Promise<boolean> {
  try {
    const verified = JSON.parse(await readFile(`${command}.bridge-compatibility.json`, "utf8"));
    return verified.contract === CLI_CONTRACT_ID && verified.version === version &&
      verified.sha256 === createHash("sha256").update(await readFile(command)).digest("hex");
  } catch { return false; }
}
