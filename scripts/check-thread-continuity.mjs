import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "codex-continuity-smoke-"));
const stages = [
  { name: "MCP discovery and transport reconnection", files: ["test/server.test.ts", "test/stdioServer.test.ts"],
    pattern: "stable task descriptor|stateless HTTP task descriptor|keeps async Codex jobs|host-derived scope stable" },
  { name: "Public task, exact Agent continuation, and backend binding", files: ["test/tools.test.ts"],
    pattern: "starts a sanitized read-only session|reuses one Agent across linked Activities|preserves (mcp-server|codex-sdk) history and requires an explicit summary-only handoff|admitted App Server thread resumable" },
  { name: "Codex process restart, thread resume, fork, and invalid identity", files: ["test/appServerUpstream.test.ts"],
    pattern: "exact turn-level continuation|recovers a durable thread|forks, archives, restores|classifies exact thread/read" }
];
const report = { kind: "thread-continuity-smoke", startedAt: new Date().toISOString(),
  execution: "isolated fixtures; no model requests or API billing", stages: [] };
try {
  for (const [index, stage] of stages.entries()) {
    console.log(`Checking ${index + 1}/${stages.length}: ${stage.name}`);
    const outputFile = path.join(temporary, `stage-${index}.json`);
    const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...stage.files,
      "--maxWorkers=2", "-t", stage.pattern, "--reporter=json", `--outputFile=${outputFile}`], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined,
        CODEX_HOME: path.join(temporary, "codex"), CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(temporary, "runtimes") }
    });
    let summary;
    try { summary = JSON.parse(readFileSync(outputFile, "utf8")); } catch { /* Report the exact failed stage below. */ }
    const passed = result.status === 0 && (summary?.numPassedTests ?? 0) > 0;
    report.stages.push({ name: stage.name, passed, testsPassed: summary?.numPassedTests ?? 0,
      testsFailed: summary?.numFailedTests ?? 0, files: stage.files });
    if (!passed) {
      console.error(`Continuity smoke failed at stage: ${stage.name}. Rerun the listed test files for detailed diagnostics.`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
