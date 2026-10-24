import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";

// Isolated current-protocol audit. It never reaches a real Codex process,
// catalog service, user state, or historical tool name.
const root = await mkdtemp(path.join(tmpdir(), "card-open-audit-"));
const state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
const counts = { settingsViews: 0, dashboardViews: 0, catalogCalls: 0, codexCalls: 0 };
const catalog = {
  source: "codex-cli" as const,
  fetchedAt: new Date().toISOString(),
  validatedAt: new Date().toISOString(),
  fingerprint: "a".repeat(64),
  cached: true,
  stale: false,
  validation: "valid" as const,
  models: [{
    id: "gpt-5.6-sol",
    displayName: "Fixture",
    defaultReasoningEffort: "max" as const,
    supportedReasoningEfforts: [{ effort: "max" as const }],
    serviceTiers: [],
    inputModalities: ["text" as const]
  }]
};
const server = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; },
  async callTool() { counts.codexCalls += 1; throw new Error("Execution forbidden in audit"); },
  async close() {}
}, new SessionRegistry({ stateStore: state }), new CodexJobRegistry({ stateStore: state }), {
  async getCatalog() { counts.catalogCalls += 1; return catalog; },
  getCachedCatalog() { return catalog; }
}, new UserSettingsStore(config, { stateStore: state }));
const originalSettingsSnapshot = server.applicationService.settingsSnapshot.bind(server.applicationService);
server.applicationService.settingsSnapshot = async (options) => {
  counts.settingsViews += 1;
  return originalSettingsSnapshot(options);
};
const originalDashboardSnapshot = server.applicationService.dashboardSnapshot.bind(server.applicationService);
server.applicationService.dashboardSnapshot = async (options) => {
  counts.dashboardViews += 1;
  return originalDashboardSnapshot(options);
};
const connection = await connectCurrentMcpServer(server, { name: "card-open-audit", version: "1" });
const { client } = connection;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({
    name,
    arguments: args,
    _meta: { "openai/session": "isolated-card-open-audit" }
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
};
const observations: Record<string, typeof counts> = {};
try {
  await call("codex_settings");
  observations.settingsOpen = { ...counts };
  await call("codex_ui_read", { view: "settings" });
  observations.settingsMount = { ...counts };
  await call("codex_dashboard");
  observations.dashboardOpen = { ...counts };
  const widgetInstanceId = randomUUID();
  await call("codex_ui_read", { view: "dashboard", widgetInstanceId, enrich: false });
  observations.dashboardStructure = { ...counts };
  await call("codex_ui_read", { view: "dashboard", widgetInstanceId, enrich: true });
  observations.dashboardEnriched = { ...counts };
  assert.equal(counts.codexCalls, 0);
  const report = { protocolVersion: "2026-07-28", source: "current working tree", observations };
  await writeFile("docs/audits/issue-69-card-opens-current.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await connection.close();
  await server.close();
  state.close();
  await rm(root, { recursive: true, force: true });
}
