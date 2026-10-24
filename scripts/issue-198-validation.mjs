#!/usr/bin/env node
/** Repeatable #198 validation. All fault tests use their own synthetic fixtures. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { computeSourceHash, hasTrackedSourceChanges } from "./build-fingerprint.mjs";
import {
  reserveValidationOutput, scenarioPassed, scenarioRuntimeEvidence, validationChildEnvironment
} from "./issue-198-validation-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [stage, ...options] = process.argv.slice(2);
if (!["quick", "integrated", "installed"].includes(stage)) {
  throw new Error("Usage: node scripts/issue-198-validation.mjs <quick|integrated|installed> [--bundle <app>] [--output-dir <directory>]");
}
function option(name) {
  const index = options.indexOf(name);
  if (index < 0) return undefined;
  if (!options[index + 1]) throw new Error(`${name} requires a value.`);
  return options[index + 1];
}
const output = reserveValidationOutput(root, stage, option("--output-dir"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceSha = git("rev-parse", "HEAD");
const dirty = hasTrackedSourceChanges(root);
const sourceHash = computeSourceHash(root);
const sqlite = new Database(":memory:");
const sqliteVersion = sqlite.prepare("SELECT sqlite_version() AS version").get().version;
sqlite.close();
const packageInfo = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
let codexCliVersion = "unavailable";
try {
  codexCliVersion = execFileSync(process.env.CODEX_MCP_BRIDGE_CODEX || "codex", ["--version"], {
    cwd: root, encoding: "utf8", timeout: 10_000
  }).trim();
} catch { /* the compatibility scenario records the actionable failure */ }
const result = {
  contract: "issue-198-validation-v1",
  stage,
  startedAt: new Date().toISOString(),
  source: { sha: sourceSha, hash: sourceHash, dirty },
  environment: {
    os: os.platform(), arch: os.arch(), release: os.release(),
    cpu: os.cpus()[0]?.model || "unknown", node: process.version,
    sqlite: sqliteVersion, driver: packageInfo.dependencies["better-sqlite3"], codexCliVersion,
    schema: readFileSync(path.join(root, "src", "stateSchema.ts"), "utf8")
      .match(/CURRENT_STATE_SCHEMA_VERSION = "(\d+)"/)?.[1] || "unknown"
  },
  fixture: "Synthetic temporary state/telemetry DB and fake App Server; no operating DB or Job fault injection",
  scenarios: [],
  bundle: null,
  unrun: [
    { id: "real-codex-and-chatgpt", reason: "External account/host acceptance is a separate authorized deployment test." },
    { id: "operating-app-cutover", reason: "This runner does not replace or restart the operating app." },
    { id: "physical-fsync-and-sqlite-page-visits", reason: "Not exposed by the supported application measurements." }
  ],
  finishedAt: null,
  verdict: "running"
};
const npm = (id, script, extra = {}) => ({ id, command: "npm", args: ["run", script], ...extra });
const tsx = (id, script, extra = {}) => ({ id, command: "npx", args: ["tsx", script], ...extra });
const vitest = (id, files) => ({
  id, command: "npx", args: ["vitest", "run", ...files, "--maxWorkers=4"]
});
const fastFiles = [
  "test/automaticRecovery.test.ts", "test/threadConnections.test.ts",
  "test/runtimeProcess.test.ts", "test/tools.test.ts",
  "test/stateReadProcess.test.ts", "test/telemetryService.test.ts",
  "test/issue198ValidationRunner.test.ts"
];
const scenarios = stage === "quick" ? [
  npm("contract-and-release", "validate:fast", { usePinnedCodexCli: true }),
  vitest("affected-product-paths", fastFiles),
  npm("wal-and-storage", "test:issue-197-storage")
] : stage === "integrated" ? [
  npm("full-node-build-and-tests", "check"),
  npm("app-server-compatibility", "app-server:compat:check", { usePinnedCodexCli: true }),
  npm("macos-native-tests", "macos:check"),
  npm("mcp-conformance", "mcp:conformance"),
  tsx("background-work-scale-noop", "scripts/issue-193-work-budget-benchmark.ts"),
  tsx("ingress-saturation", "scripts/issue-196-ingress-measurement.ts"),
  npm("state-execution-isolation", "test:issue-142-state-execution-isolation"),
  npm("connection-stall", "test:issue-143-connection-reliability:characterization"),
  npm("execution-recovery", "test:issue-185-execution-recovery"),
  npm("observation-faults", "test:issue-186-observation"),
  npm("retention-and-ack", "test:issue-189-retention"),
  npm("wal-and-storage", "test:issue-197-storage"),
  npm("status-wait", "test:issue-137-status-wait"),
  npm("state-access", "test:issue-138-state-access")
] : [];

async function run(spec) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const logName = `${String(result.scenarios.length + 1).padStart(2, "0")}-${spec.id}.log`;
  const logFile = path.join(output, logName);
  let logDescriptor;
  try {
    logDescriptor = openSync(logFile, "wx", 0o600);
  } catch (error) {
    throw new Error(`VALIDATION_LOG_OPEN_FAILED: ${logName}: ${String(error)}`);
  }
  const command = [spec.command, ...spec.args];
  process.stdout.write(`[#198 ${stage}] ${spec.id}: ${command.join(" ")}\n`);
  let standardOutput = "";
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  let logError = null;
  let timedOut = false;
  const timeoutMs = spec.timeoutMs || 15 * 60_000;
  let child;
  try {
    // The pinned CLI belongs to schema checks only; the bundle selector belongs
    // to regressions against the already verified installed candidate only.
    const childEnvironment = validationChildEnvironment({
      stage, parent: process.env, extra: spec.env,
      usePinnedCodexCli: spec.usePinnedCodexCli,
      bundleDist: spec.bundleDist,
      verifiedBundleDist: result.bundle?.valid ? result.bundle.runtimeDist : undefined
    });
    child = spawn(spec.command, spec.args, {
      cwd: root,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
  } catch (error) {
    closeSync(logDescriptor);
    throw error;
  }
  let forceTimer;
  const terminate = terminationSignal => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, terminationSignal);
      else child.kill(terminationSignal);
    } catch { /* already exited */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    forceTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
  }, timeoutMs);
  const appendLog = chunk => {
    if (logError) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(logDescriptor, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error("Log write made no progress.");
        offset += written;
      }
    } catch (error) {
      logError = `VALIDATION_LOG_WRITE_FAILED: ${logName}: ${String(error)}`;
      terminate("SIGTERM");
      if (!forceTimer) forceTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
    }
  };
  child.stdout.on("data", chunk => {
    appendLog(chunk);
    standardOutput = (standardOutput + chunk.toString("utf8")).slice(-1024 * 1024);
  });
  child.stderr.on("data", appendLog);
  try {
    [exitCode, signal] = await new Promise(resolve => {
      child.once("error", error => { spawnError = String(error); });
      // `exit` can precede the final stdout/stderr chunks. `close` means both
      // pipes have drained, so the report and its log hash cover all output.
      child.once("close", (code, terminationSignal) => resolve([code, terminationSignal]));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    try { closeSync(logDescriptor); }
    catch (error) { logError ||= `VALIDATION_LOG_CLOSE_FAILED: ${logName}: ${String(error)}`; }
  }
  let logSha256 = null;
  try { logSha256 = digest(logFile); }
  catch (error) { logError ||= `VALIDATION_LOG_READ_FAILED: ${logName}: ${String(error)}`; }
  const observed = parseSummary(standardOutput);
  const executionTarget = scenarioRuntimeEvidence(
    stage, spec.id, observed, result.bundle?.valid ? result.bundle.runtimeDist : undefined
  );
  const entry = {
    id: spec.id, command, startedAt, durationMs: Math.round(performance.now() - started),
    timeoutMs, timedOut, exitCode, signal,
    status: scenarioPassed({ exitCode, timedOut, spawnError, logError, executionTarget })
      ? "passed" : "failed",
    ...(spawnError ? { spawnError } : {}),
    ...(logError ? { logError } : {}),
    ...(executionTarget ? { executionTarget } : {}),
    log: logName, logSha256,
    ...(observed ? { observed } : {})
  };
  result.scenarios.push(entry);
  save();
  if (logError) throw new Error(logError);
  return entry;
}

function parseSummary(outputText) {
  const lines = outputText.trim();
  const candidates = [lines, ...[...lines.matchAll(/(?:^|\n)\{/g)].map(match => lines.slice(match.index + (lines[match.index] === "\n" ? 1 : 0)))];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* text log or partial JSON */ }
  }
  const tests = lines.match(/Tests\s+(\d+) passed \((\d+)\)/);
  return tests ? { passedTests: Number(tests[1]), totalTests: Number(tests[2]) } : undefined;
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inspectBundle(bundlePath) {
  const app = path.resolve(bundlePath);
  const runtime = path.join(app, "Contents", "Resources", "Runtime");
  const build = JSON.parse(readFileSync(path.join(runtime, "dist", "build-info.json"), "utf8"));
  const files = ["package.json", "package-lock.json", "state-migrations.json", "release-manifest.json"];
  const fileMatches = Object.fromEntries(files.map(file => [
    file, digest(path.join(root, file)) === digest(path.join(runtime, file))
  ]));
  const identity = {
    app,
    runtimeDist: path.join(runtime, "dist"),
    build,
    bundledSchema: readFileSync(path.join(runtime, "dist", "stateSchema.js"), "utf8")
      .match(/CURRENT_STATE_SCHEMA_VERSION = "(\d+)"/)?.[1] || "unknown",
    sourceShaMatches: build.commit === sourceSha,
    sourceHashMatches: build.sourceHash === sourceHash,
    builtFromCleanSource: build.dirty === false,
    fileMatches,
    valid: build.commit === sourceSha && build.sourceHash === sourceHash &&
      readFileSync(path.join(runtime, "dist", "stateSchema.js"), "utf8")
        .includes(`CURRENT_STATE_SCHEMA_VERSION = "${result.environment.schema}"`) &&
      build.dirty === false && Object.values(fileMatches).every(Boolean)
  };
  result.bundle = identity;
  save();
  return identity;
}

function save() {
  writeAtomically("results.json", `${JSON.stringify(result, null, 2)}\n`);
  const rows = result.scenarios.map(entry =>
    `| ${entry.id} | ${entry.status} | ${entry.executionTarget
      ? entry.executionTarget.matches ? "matched" : "MISMATCH" : "n/a"} | ${entry.durationMs} | ${entry.log} |`
  ).join("\n");
  writeAtomically("report.md", [
    `# #198 ${stage} validation`, "",
    `- Verdict: **${result.verdict}**`,
    `- Source: \`${sourceSha}\`, hash \`${sourceHash}\`, dirty: ${dirty}`,
    `- Fixture: ${result.fixture}`,
    result.bundle ? `- Candidate bundle identity: **${result.bundle.valid ? "matched" : "mismatch"}**; build \`${result.bundle.build.id}\`` : "- Candidate bundle: not tested in this stage",
    "", "| Scenario | Status | Execution target | Duration (ms) | Local log |", "| --- | --- | --- | ---: | --- |",
    rows || "| none | not run | n/a | 0 | |", "",
    "## Unrun boundaries", "",
    ...result.unrun.map(entry => `- ${entry.id}: ${entry.reason}`), "",
    "A passing script proves its declared fixture and assertions only. Failed and skipped items remain visible in results.json."
  ].join("\n"));
}

function writeAtomically(name, contents) {
  const target = path.join(output, name);
  const temporary = path.join(output, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the previous report remains intact */ }
    throw error;
  }
}

// Preserve source identity even if the first scenario fails before finishing.
save();
try {
  if (stage === "installed") {
    if (dirty) throw new Error("Installed candidate validation requires a clean tracked source checkout.");
    let bundle = option("--bundle");
    if (!bundle) {
      const built = await run(npm("build-signed-app", "macos:bundle", { timeoutMs: 20 * 60_000 }));
      if (built.status !== "passed") throw new Error("The candidate app bundle did not build.");
      bundle = path.join(root, "macos", "build", "Codex MCP Bridge for ChatGPT.app");
    }
    if (!existsSync(bundle)) throw new Error("Candidate app bundle does not exist.");
    const identity = inspectBundle(bundle);
    if (!identity.valid) throw new Error("Candidate bundle source/build identity does not match the tested checkout.");
    const signature = await run({ id: "strict-app-signature", command: "codesign", args: ["--verify", "--deep", "--strict", bundle] });
    if (signature.status !== "passed") throw new Error("Candidate app signature failed verification.");
    for (const [id, script] of [
      ["bundled-execution-recovery", "scripts/issue-185-execution-recovery-regression.ts"],
      ["bundled-observation-faults", "scripts/issue-186-observation-regression.ts"],
      ["bundled-retention-and-ack", "scripts/issue-189-retention-regression.ts"]
    ]) {
      await run(tsx(id, script, { bundleDist: identity.runtimeDist }));
    }
  } else {
    for (const scenario of scenarios) await run(scenario);
  }
} catch (error) {
  const failure = { stage, at: new Date().toISOString(), reason: String(error) };
  result.unrun.push({ id: "runner-interrupted", reason: failure.reason });
  try {
    writeFileSync(path.join(output, "runner-error.json"), `${JSON.stringify(failure, null, 2)}\n`, {
      flag: "wx", mode: 0o600
    });
  } catch (recordError) {
    process.stderr.write(`Could not record runner-error.json: ${String(recordError)}\n`);
  }
} finally {
  result.finishedAt = new Date().toISOString();
  result.verdict = result.scenarios.length > 0 &&
    result.scenarios.every(scenario => scenario.status === "passed") &&
    !result.unrun.some(entry => entry.id === "runner-interrupted") &&
    (stage !== "installed" || result.bundle?.valid === true)
    ? "passed-with-declared-limits" : "failed-or-incomplete";
  try { save(); }
  catch (error) {
    process.stderr.write(`VALIDATION_REPORT_WRITE_FAILED: ${String(error)}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(`[#198 ${stage}] ${result.verdict}; report: ${path.join(output, "report.md")}\n`);
  if (result.verdict !== "passed-with-declared-limits") process.exitCode = 1;
}
