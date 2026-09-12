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
    const [requests, config] = await Promise.all([
      readFile(path.join(directory, "ClientRequest.json"), "utf8"),
      readFile(path.join(directory, "v2", "ConfigReadResponse.json"), "utf8")
    ]);
    return inspectClientRequestContract(JSON.parse(requests), JSON.parse(config));
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

export function inspectClientRequestContract(schema: Schema, configSchema?: Schema): CliProtocolSupport {
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
    ["untrusted", "on-request", "never"].flatMap(approvalPolicy =>
      ["user", "auto_review"].map(approvalsReviewer => ({ cwd, sandbox, approvalPolicy, approvalsReviewer,
        config: { "apps._default.default_tools_approval_mode": approvalPolicy === "never" ? "approve" : "auto" }
      }))));
  checks.set("start", check("thread/start", policies.map(policy => ({
    ...policy, model: "bridge-contract-check", serviceTier: null, experimentalRawEvents: false, ephemeral: false
  }))));
  checks.set("continue", check("thread/resume", policies.map(policy => ({ ...policy, threadId: "bridge-contract-check" }))));
  const turn = { threadId: "bridge-contract-check", input: [{ type: "text", text: "contract check", text_elements: [] }],
    cwd, approvalPolicy: "on-request", approvalsReviewer: "user", model: "bridge-contract-check", effort: "high", serviceTier: null };
  checks.set("turn", check("turn/start", policies.flatMap(({ approvalPolicy, approvalsReviewer }) => [
    { ...turn, approvalPolicy, approvalsReviewer, sandboxPolicy: { type: "readOnly", networkAccess: false } },
    { ...turn, approvalPolicy, approvalsReviewer, permissions: ":read-only" }
  ])));
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
    supportsThreadUnsubscribe: supports("supportsThreadUnsubscribe", [
      ...check("thread/unsubscribe", [{ threadId: "bridge-contract-check" }]),
      ...check("thread/loaded/list", [{ cursor: null, limit: 100 }])
    ]),
    supportsBackgroundTerminals: supports("supportsBackgroundTerminals", [
      ...check("thread/backgroundTerminals/list", [{ threadId: "bridge-contract-check", cursor: null, limit: 100 }]),
      ...check("thread/backgroundTerminals/terminate", [{ threadId: "bridge-contract-check", processId: "process" }])
    ])
  };
  const missingCore = [...checks.values()].flat().concat(configSchema ? inspectConnectorApprovalConfig(configSchema) : []);
  return { compatible: missingCore.length === 0, missingCore, capabilities, unsupported };
}

/** `config` accepts arbitrary keys on the wire. Its presence alone does not
 * prove that a CLI understands the connector approval setting we send. */
function inspectConnectorApprovalConfig(schema: Schema): string[] {
  const failure = ["config.apps._default.default_tools_approval_mode"];
  const resolve = (input: Schema | undefined): Schema | undefined => {
    let node = input;
    for (let depth = 0; node && depth < 12; depth += 1) {
      if (node.$ref?.startsWith("#/definitions/")) node = schema.definitions?.[node.$ref.slice("#/definitions/".length)];
      else if (node.anyOf) node = node.anyOf.find((entry: Schema) => entry.type !== "null");
      else if (node.allOf?.length === 1) node = node.allOf[0];
      else return node;
    }
    return undefined;
  };
  let node: Schema | undefined = schema;
  for (const field of ["config", "apps", "_default", "default_tools_approval_mode"]) {
    node = resolve(node)?.properties?.[field];
    if (!node) return failure;
  }
  try {
    const validate = new AjvJsonSchemaValidator().getValidator({ ...node, definitions: schema.definitions });
    return ["auto", "approve"].every(mode => validate(mode).valid) ? [] : failure;
  } catch { return failure; }
}

export function requireCliProtocol(support: CliProtocolSupport, contextMode: "fresh" | "continue" | "fork"): void {
  const missing = [...support.missingCore,
    ...(contextMode === "fork" ? support.unsupported.supportsFork || [] : [])];
  if (missing.length) throw new Error(`CODEX_PROTOCOL_UNSUPPORTED: The selected CLI cannot execute ${contextMode}: ${[...new Set(missing)].join(", ")}. Choose a compatible installation. No Codex task was started.`);
}
