import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Optional first argument is an isolated checkout of the recorded baseline.
// Never uses the user's live state, server, catalog, or Codex process.
const baseline = Boolean(process.argv[2]);
const source = path.resolve(process.argv[2] || ".", "src");
const moduleAt = (name: string) => import(pathToFileURL(path.join(source, name + ".ts")).href);
const { loadConfig } = await moduleAt("config");
const { createBridgeMcpServer } = await moduleAt("server");
const { BridgeStateStore } = await moduleAt("stateStore");
const { CodexJobRegistry } = await moduleAt("tools");
const { UserSettingsStore } = await moduleAt("userSettings");
const { SessionRegistry } = await moduleAt("sessionRegistry");
const root = await mkdtemp(path.join(tmpdir(), "card-open-audit-"));
const state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
const counts = { settingsSnapshots: 0, dashboardSnapshots: 0, catalogCalls: 0, codexCalls: 0 };
const catalog = { source: "codex-cli", fetchedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
  fingerprint: "a".repeat(64), cached: true, stale: false, validation: "valid", models: [{ id: "gpt-5.6-sol", displayName: "Fixture",
    defaultReasoningEffort: "max", supportedReasoningEfforts: [{ effort: "max" }], serviceTiers: [], inputModalities: ["text"] }] };
const server = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; }, async callTool() { counts.codexCalls++; throw new Error("Execution forbidden in audit"); }, async close() {}
}, new SessionRegistry({ stateStore: state }), new CodexJobRegistry({ stateStore: state }), {
  async getCatalog() { counts.catalogCalls++; return catalog; }, getCachedCatalog() { return catalog; }
}, new UserSettingsStore(config, { stateStore: state }));
for (const [name, count] of [["settingsSnapshot", "settingsSnapshots"], ["dashboardSnapshot", "dashboardSnapshots"]] as const) {
  const original = server.applicationService[name].bind(server.applicationService);
  server.applicationService[name] = (...args: unknown[]) => { counts[count]++; return original(...args); };
}
const client = new Client({ name: "card-open-audit", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
const call = async (name: string, args: object = {}) => {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown>, _meta: { "openai/session": "isolated-card-open-audit" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
};
const observations: Record<string, typeof counts> = {};
try {
  await Promise.all([client.connect(a), server.connect(b)]);
  await call("codex_settings"); observations.settingsOpen = { ...counts };
  await call(baseline ? "codex_settings_snapshot" : "codex_ui_read", baseline ? {} : { view: "settings" });
  observations.settingsMount = { ...counts };
  await call("codex_dashboard"); observations.dashboardOpen = { ...counts };
  const widgetInstanceId = randomUUID();
  await call(baseline ? "codex_dashboard_snapshot" : "codex_ui_read", { ...(baseline ? {} : { view: "dashboard" }), widgetInstanceId, enrich: false });
  observations.dashboardStructure = { ...counts };
  await call(baseline ? "codex_dashboard_snapshot" : "codex_ui_read", { ...(baseline ? {} : { view: "dashboard" }), widgetInstanceId, enrich: true });
  observations.dashboardEnriched = { ...counts };
  assert.equal(counts.codexCalls, 0);
  const report = { source: baseline ? "isolated baseline checkout 6d84d4d" : "issue-69 working tree", observations };
  await writeFile(`docs/audits/issue-69-card-opens-${baseline ? "before" : "after"}.json`, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await client.close(); await server.close(); state.close(); await rm(root, { recursive: true, force: true }); }
