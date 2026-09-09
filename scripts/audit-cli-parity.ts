import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import { JsonRpcProcess } from "../src/jsonRpcProcess.js";
import { normalizeProtocolSchema, validateInitializeResponse } from "../src/runtimeCompatibility.js";
import { loadConfig } from "../src/config.js";
import { resolveExecutionPolicy } from "../src/executionPolicy.js";
import { threadAccessParams, verifyExecutionAccess } from "../src/executionAccess.js";

// Offline audit: no credentials, model turns, user projects, runtime selection,
// installation, or running service changes. All execution targets are fixtures.
// Usage: npx tsx scripts/audit-cli-parity.ts label=/absolute/codex [...]
const commands = process.argv.slice(2).map(argument => {
  const separator = argument.indexOf("=");
  const label = argument.slice(0, separator), command = argument.slice(separator + 1);
  assert.ok(separator > 0 && /^[a-z][a-z0-9-]*$/.test(label) && path.isAbsolute(command),
    "Use label=/absolute/path/to/codex for each installation.");
  return { label, command };
});
assert.ok(commands.length > 0 && new Set(commands.map(entry => entry.label)).size === commands.length,
  "Provide at least one installation, with unique labels.");

const directory = await realpath(await mkdtemp(path.join(tmpdir(), "bridge-cli-parity-")));
const reports: Array<Record<string, any>> = [];
const schemaHashes: Array<Record<string, string>> = [];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let failed = false;

async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(path.join(root, entry.name), `${prefix}${entry.name}/`));
    else result.push(`${prefix}${entry.name}`);
  }
  return result.sort();
}

try {
  for (const { label, command } of commands) {
    const root = path.join(directory, label), home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(project);
    // Deliberately different defaults prove that explicit thread policies win.
    await writeFile(path.join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\napprovals_reviewer = "user"\n');
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const rpc = new JsonRpcProcess({ command, args: ["app-server", "--listen", "stdio://"],
      cwd: project, env: environment, debugLabel: `CLI audit ${label}`, omitJsonRpcHeader: true });
    const request = (method: string, params: unknown) => rpc.request<Record<string, any>>(method, params, { timeoutMs: 15_000 });
    const report: Record<string, any> = { source: label, policies: [], filesystem: [], operations: [] };
    let hashes: Record<string, string> = {};
    try {
      report.version = execFileSync(command, ["--version"], { encoding: "utf8", env: environment, timeout: 5_000 }).trim();
      const schemas = path.join(root, "schemas");
      execFileSync(command, ["app-server", "generate-json-schema", "--experimental", "--out", schemas],
        { env: environment, timeout: 30_000, stdio: "pipe" });
      for (const file of await files(schemas)) hashes[file] = hash(normalizeProtocolSchema(JSON.parse(await readFile(path.join(schemas, file), "utf8"))));
      report.bridgeProtocol = inspectClientRequestContract(
        JSON.parse(await readFile(path.join(schemas, "ClientRequest.json"), "utf8")),
        JSON.parse(await readFile(path.join(schemas, "v2", "ConfigReadResponse.json"), "utf8"))
      );
      failed ||= !report.bridgeProtocol.compatible || Object.keys(report.bridgeProtocol.unsupported).length > 0;
      report.schemaFiles = Object.keys(hashes).length;
      report.schemaDigest = hash(hashes);
      const initialized = await request("initialize", {
        clientInfo: { name: "bridge_parity_audit", version: "1" }, capabilities: { experimentalApi: true }
      });
      validateInitializeResponse(initialized);
      await rpc.notify("initialized");
      report.initialize = "passed";
      const config = await request("config/read", { includeLayers: false, cwd: project });
      report.fixtureDefaults = { sandbox: config.config?.sandbox_mode, approvalPolicy: config.config?.approval_policy };
      let threadId: string | undefined;
      report.bridgePolicies = [];
      const bridgeConfig = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1", CODEX_MCP_BRIDGE_APPROVALS_REVIEWER: "auto_review" });
      for (const accessStrategy of ["read-only", "adaptive", "always-full"] as const) {
        const expected = resolveExecutionPolicy(bridgeConfig, { accessStrategy }, project);
        const response = await request("thread/start", { ...threadAccessParams(expected), ephemeral: true, experimentalRawEvents: false });
        const verified = verifyExecutionAccess(response, expected, "thread/start");
        report.bridgePolicies.push({ accessStrategy, sandbox: verified.sandbox, approvalPolicy: verified.approvalPolicy,
          approvalsReviewer: verified.approvalsReviewer, requestedAppToolApprovalMode: expected.appToolApprovalMode,
          passed: true });
      }
      for (const [sandbox, type] of [["read-only", "readOnly"], ["workspace-write", "workspaceWrite"], ["danger-full-access", "dangerFullAccess"]]) {
        for (const approvalPolicy of ["untrusted", "on-request", "never"]) {
          const response = await request("thread/start", { cwd: project, sandbox, approvalPolicy, ephemeral: true, experimentalRawEvents: false });
          threadId = response.thread?.id;
          const passed = typeof threadId === "string" && response.sandbox?.type === type && response.approvalPolicy === approvalPolicy;
          failed ||= !passed;
          report.policies.push({ sandbox, approvalPolicy, passed, effective: {
            sandbox: { type: response.sandbox?.type, networkAccess: response.sandbox?.networkAccess },
            approvalPolicy: response.approvalPolicy, reviewer: response.approvalsReviewer
          } });
        }
      }
      const workspace = { type: "workspaceWrite", writableRoots: [project], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
      for (const fixture of [
        { name: "read-only-denies-write", policy: { type: "readOnly" }, target: path.join(project, "read-denied.txt"), allowed: false },
        { name: "workspace-allows-project-write", policy: workspace, target: path.join(project, "write-allowed.txt"), allowed: true },
        { name: "workspace-denies-sibling-write", policy: workspace, target: path.join(root, "write-denied.txt"), allowed: false },
        { name: "full-allows-sibling-write", policy: { type: "dangerFullAccess" }, target: path.join(root, "full-allowed.txt"), allowed: true }
      ]) {
        const response = await request("command/exec", {
          command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'AUDIT')", fixture.target],
          cwd: project, sandboxPolicy: fixture.policy, timeoutMs: 5_000
        });
        const created = await stat(fixture.target).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        const passed = created === fixture.allowed && (response.exitCode === 0) === fixture.allowed;
        failed ||= !passed;
        report.filesystem.push({ name: fixture.name, exitCode: response.exitCode, created, passed });
      }
      for (const [method, params] of [
        ["model/list", {}], ["skills/list", { cwds: [project] }], ["mcpServerStatus/list", {}],
        ["thread/read", { threadId, includeTurns: false }], ["thread/backgroundTerminals/list", { threadId }],
        ["permissionProfile/list", { cwd: project }], ["collaborationMode/list", {}], ["experimentalFeature/list", {}]
      ] as const) {
        try {
          const response = await request(method, params);
          report.operations.push({ method, accepted: true });
          if (method === "model/list") {
            report.models = response.data.map((model: Record<string, any>) => ({
              model: model.model, isDefault: model.isDefault, inputModalities: model.inputModalities,
              efforts: model.supportedReasoningEfforts?.map((effort: Record<string, unknown>) => effort.reasoningEffort)
            }));
            report.modelsComplete = response.nextCursor == null;
          }
          if (method === "experimentalFeature/list") {
            const features = response.data.map((feature: Record<string, any>) => ({ name: feature.name, enabled: feature.enabled, stage: feature.stage }))
              .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
            report.featureCount = features.length;
            report.featureDigest = hash(features);
            report.featuresComplete = response.nextCursor == null;
          }
        } catch (error) {
          failed = true;
          report.operations.push({ method, accepted: false, error: String(error).replaceAll(directory, "<audit>") });
        }
      }
    } catch (error) {
      failed = true;
      report.error = String(error).replaceAll(directory, "<audit>").replaceAll(command, "<cli>");
    } finally {
      await rpc.close();
    }
    reports.push(report);
    schemaHashes.push(hashes);
    process.stderr.write(`Audited ${label}: ${report.version ?? "unavailable"}\n`);
  }
  const comparisons = reports.slice(1).map((report, index) => ({
    source: report.source, reference: reports[0]!.source,
    changedSchemas: [...new Set([...Object.keys(schemaHashes[0]!), ...Object.keys(schemaHashes[index + 1]!)])]
      .filter(file => schemaHashes[0]![file] !== schemaHashes[index + 1]![file]),
    sameFeatures: report.featuresComplete && reports[0]!.featuresComplete && report.featureDigest === reports[0]!.featureDigest,
    sameModels: report.modelsComplete && reports[0]!.modelsComplete && hash(report.models) === hash(reports[0]!.models)
  }));
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    scope: "Offline schema, policy negotiation, fixture filesystem, and catalog probes; no model turn or authenticated entitlement check.",
    checksPassed: !failed, reports, comparisons }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
