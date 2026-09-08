import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { BackendCapabilities } from "./modelPolicy.js";

export type CliProtocolSupport = {
  compatible: boolean;
  missingCore: string[];
  capabilities: BackendCapabilities;
  unsupported: Record<string, string[]>;
};

export const UNVERIFIED_APP_SERVER_CAPABILITIES: BackendCapabilities = Object.freeze({
  selectionScope: "turn", supportsModelOverrideOnContinue: false,
  supportsEffortOverrideOnContinue: false, supportsServiceTierOverrideOnContinue: false,
  supportsFork: false, supportsSteering: false, supportsPreciseCancellation: false,
  supportsEphemeralThreads: false, supportsThreadInspection: false, supportsBackgroundTerminals: false
});

type Schema = Record<string, any>;

/** Inspect only the public contracts the adapter uses. Additions and new CLI
 * versions are allowed; no whole-schema hash or version allowlist is involved. */
export async function inspectCliProtocol(command: string, environment: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<CliProtocolSupport> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) throw new Error("Invalid CLI protocol inspection timeout.");
  const directory = await mkdtemp(path.join(tmpdir(), "codex-protocol-"));
  try {
    await generateSchema(command, directory, environment, timeoutMs);
    const schema = JSON.parse(await readFile(path.join(directory, "ClientRequest.json"), "utf8"));
    return inspectClientRequestContract(schema);
  } catch {
    throw new Error("CODEX_PROTOCOL_UNVERIFIED: Could not inspect the selected CLI's App Server request contract. Choose or repair an installation with a working schema generator.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function generateSchema(command: string, directory: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["app-server", "generate-json-schema", "--experimental", "--out", directory], {
      stdio: "ignore", detached: process.platform !== "win32", windowsHide: true,
      env: { ...environment, CODEX_HOME: path.join(directory, "home") }
    });
    // No model execution or user interaction is allowed in this probe. Ignore
    // raw output and terminate its own process group if generation stalls.
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* exit/error below is authoritative */ }
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("CLI schema generation failed.")); });
  });
}

export function inspectClientRequestContract(schema: Schema): CliProtocolSupport {
  // Rust integer formats are annotations; minimum/maximum/type retain their
  // validation meaning. Avoid treating those nonstandard formats as warnings.
  schema = JSON.parse(JSON.stringify(schema, (key, value) => key === "format" && /^(?:u?int)(?:32|64)?$/.test(value) ? undefined : value));
  const validator = new AjvJsonSchemaValidator();
  const methods = new Map<string, Schema>();
  for (const variant of schema.oneOf || []) {
    for (const method of variant.properties?.method?.enum || []) methods.set(method, variant.properties?.params || {});
  }
  const checks = new Map<string, string[]>();
  const check = (method: string, samples: Record<string, unknown>[]): string[] => {
    const params = methods.get(method);
    if (!params) return [`${method} (method)`];
    const resolved = params.$ref?.startsWith("#/definitions/")
      ? schema.definitions?.[params.$ref.slice("#/definitions/".length)] : params;
    const missing = [...new Set(samples.flatMap(sample => Object.keys(sample)))]
      .filter(field => !Object.hasOwn(resolved?.properties || {}, field)).map(field => `${method}.${field}`);
    if (missing.length) return missing;
    try {
      const validate = validator.getValidator({ ...params, definitions: schema.definitions });
      if (samples.some(sample => !validate(sample).valid)) return [`${method} (input contract)`];
    } catch { return [`${method} (invalid schema)`]; }
    return [];
  };
  const cwd = path.resolve(tmpdir());
  const policies = ["read-only", "workspace-write", "danger-full-access"].flatMap(sandbox =>
    ["untrusted", "on-request", "never"].map(approvalPolicy => ({ cwd, sandbox, approvalPolicy })));
  checks.set("start", check("thread/start", policies.map(policy => ({
    ...policy, model: "bridge-contract-check", serviceTier: null, config: null, experimentalRawEvents: false, ephemeral: false
  }))));
  checks.set("continue", check("thread/resume", policies.map(policy => ({ ...policy, threadId: "bridge-contract-check" }))));
  const turn = { threadId: "bridge-contract-check", input: [{ type: "text", text: "contract check", text_elements: [] }],
    cwd, approvalPolicy: "on-request", approvalsReviewer: "user", model: "bridge-contract-check", effort: "high", serviceTier: null };
  checks.set("turn", check("turn/start", [
    { ...turn, sandboxPolicy: { type: "readOnly", networkAccess: false } },
    { ...turn, permissions: ":read-only" }
  ]));
  checks.set("models", check("model/list", [{ cursor: null, limit: 100, includeHidden: false }]));
  checks.set("archive", check("thread/archive", [{ threadId: "bridge-contract-check" }]));
  checks.set("restore", check("thread/unarchive", [{ threadId: "bridge-contract-check" }]));
  const unsupported: Record<string, string[]> = {};
  const supports = (name: string, errors: string[]): boolean => {
    if (errors.length) unsupported[name] = errors;
    return errors.length === 0;
  };
  const capabilities: BackendCapabilities = {
    selectionScope: "turn",
    supportsModelOverrideOnContinue: supports("supportsModelOverrideOnContinue", checks.get("turn")!),
    supportsEffortOverrideOnContinue: supports("supportsEffortOverrideOnContinue", checks.get("turn")!),
    supportsServiceTierOverrideOnContinue: supports("supportsServiceTierOverrideOnContinue", checks.get("turn")!),
    supportsFork: supports("supportsFork", check("thread/fork", policies.map(policy => ({ ...policy, threadId: "bridge-contract-check", ephemeral: false })))),
    supportsSteering: supports("supportsSteering", check("turn/steer", [{ threadId: "bridge-contract-check", expectedTurnId: "turn", input: turn.input }])),
    supportsPreciseCancellation: supports("supportsPreciseCancellation", check("turn/interrupt", [{ threadId: "bridge-contract-check", turnId: "turn" }])),
    supportsEphemeralThreads: supports("supportsEphemeralThreads", check("thread/start", [{ ...policies[0], ephemeral: true }])),
    supportsThreadInspection: supports("supportsThreadInspection", check("thread/read", [{ threadId: "bridge-contract-check", includeTurns: false }])),
    supportsBackgroundTerminals: supports("supportsBackgroundTerminals", [
      ...check("thread/backgroundTerminals/list", [{ threadId: "bridge-contract-check", cursor: null, limit: 100 }]),
      ...check("thread/backgroundTerminals/terminate", [{ threadId: "bridge-contract-check", processId: "process" }])
    ])
  };
  const missingCore = [...checks.values()].flat();
  return { compatible: missingCore.length === 0, missingCore, capabilities, unsupported };
}

export function requireCliProtocol(support: CliProtocolSupport, contextMode: "fresh" | "continue" | "fork"): void {
  const missing = [...support.missingCore,
    ...(contextMode === "fork" ? support.unsupported.supportsFork || [] : [])];
  if (missing.length) throw new Error(`CODEX_PROTOCOL_UNSUPPORTED: The selected CLI cannot execute ${contextMode}: ${[...new Set(missing)].join(", ")}. Choose a compatible installation. No Codex task was started.`);
}
