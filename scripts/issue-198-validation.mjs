#!/usr/bin/env node
/** Repeatable #198 validation. All fault tests use their own synthetic fixtures. */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { computeSourceHash, hasTrackedSourceChanges } from "./build-fingerprint.mjs";

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
const output = path.resolve(option("--output-dir") || path.join(
  root, "output", "issue-198", `${stage}-${new Date().toISOString().replaceAll(":", "-")}`
));
mkdirSync(output, { recursive: true });
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
  "test/stateReadProcess.test.ts", "test/telemetryService.test.ts"
];
const scenarios = stage === "quick" ? [
  npm("contract-and-release", "validate:fast"),
  vitest("affected-product-paths", fastFiles),
  npm("wal-and-storage", "test:issue-197-storage")
] : stage === "integrated" ? [
  npm("full-node-build-and-tests", "check"),
  npm("app-server-compatibility", "app-server:compat:check"),
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
  const log = createWriteStream(logFile, { flags: "wx", mode: 0o600 });
  const command = [spec.command, ...spec.args];
  process.stdout.write(`[#198 ${stage}] ${spec.id}: ${command.join(" ")}\n`);
  let standardOutput = "";
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  const child = spawn(spec.command, spec.args, {
    cwd: root,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const timer = setTimeout(() => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { /* already exited */ }
  }, spec.timeoutMs || 15 * 60_000);
  child.stdout.on("data", chunk => {
    log.write(chunk);
    standardOutput = (standardOutput + chunk.toString("utf8")).slice(-1024 * 1024);
  });
  child.stderr.on("data", chunk => log.write(chunk));
  try {
    [exitCode, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, terminationSignal) => resolve([code, terminationSignal]));
    });
  } catch (error) {
    spawnError = String(error);
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => log.end(resolve));
  }
  const entry = {
    id: spec.id, command, startedAt, durationMs: Math.round(performance.now() - started),
    exitCode, signal, status: exitCode === 0 ? "passed" : "failed",
    ...(spawnError ? { spawnError } : {}),
    log: logName, logSha256: digest(logFile),
    ...(parseSummary(standardOutput) ? { observed: parseSummary(standardOutput) } : {})
  };
  result.scenarios.push(entry);
  save();
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
  writeFileSync(path.join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  const rows = result.scenarios.map(entry =>
    `| ${entry.id} | ${entry.status} | ${entry.durationMs} | ${entry.log} |`
  ).join("\n");
  writeFileSync(path.join(output, "report.md"), [
    `# #198 ${stage} validation`, "",
    `- Verdict: **${result.verdict}**`,
    `- Source: \`${sourceSha}\`, hash \`${sourceHash}\`, dirty: ${dirty}`,
    `- Fixture: ${result.fixture}`,
    result.bundle ? `- Candidate bundle identity: **${result.bundle.valid ? "matched" : "mismatch"}**; build \`${result.bundle.build.id}\`` : "- Candidate bundle: not tested in this stage",
    "", "| Scenario | Status | Duration (ms) | Local log |", "| --- | --- | ---: | --- |",
    rows || "| none | not run | 0 | |", "",
    "## Unrun boundaries", "",
    ...result.unrun.map(entry => `- ${entry.id}: ${entry.reason}`), "",
    "A passing script proves its declared fixture and assertions only. Failed and skipped items remain visible in results.json."
  ].join("\n"));
}

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
      await run(tsx(id, script, { env: { CODEX_TEST_BUNDLE_DIST: identity.runtimeDist } }));
    }
  } else {
    for (const scenario of scenarios) await run(scenario);
  }
} catch (error) {
  result.unrun.push({ id: "runner-interrupted", reason: String(error) });
} finally {
  result.finishedAt = new Date().toISOString();
  result.verdict = result.scenarios.length > 0 &&
    result.scenarios.every(scenario => scenario.status === "passed") &&
    !result.unrun.some(entry => entry.id === "runner-interrupted") &&
    (stage !== "installed" || result.bundle?.valid === true)
    ? "passed-with-declared-limits" : "failed-or-incomplete";
  save();
  process.stdout.write(`[#198 ${stage}] ${result.verdict}; report: ${path.join(output, "report.md")}\n`);
  if (result.verdict !== "passed-with-declared-limits") process.exitCode = 1;
}
