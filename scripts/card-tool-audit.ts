import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";
const operator = process.argv.includes("--operator");
const prefix = "../src/";
const { loadConfig } = await import(prefix + "config.js");
const { createBridgeMcpServer } = await import(prefix + "server.js");
const { BridgeStateStore } = await import(prefix + "stateStore.js");
const { UserSettingsStore } = await import(prefix + "userSettings.js");
const { SessionRegistry } = await import(prefix + "sessionRegistry.js");
const { CodexJobRegistry } = await import(prefix + "tools.js");
const root = await mkdtemp(path.join(tmpdir(), "card-tool-audit-"));
const stateStore = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ENABLE_RECOVERY_TOOLS: operator ? "1" : "0" });
const jobs = new CodexJobRegistry({ stateStore });
const server = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; }, async callTool() { throw new Error("Audit must not execute Codex"); }, async close() {}
}, new SessionRegistry({ stateStore }), jobs, { async getCatalog() { throw new Error("Discovery must not query the model catalog"); } }, new UserSettingsStore(config, { stateStore }));
const connection = await connectCurrentMcpServer(server, { name: "card-tool-audit", version: "1" });
const { client } = connection;
try {
  const { tools } = await client.listTools();
  const inventory = tools.map(tool => {
    const meta = tool._meta as { ui?: { visibility?: string[] } } | undefined;
    return { name: tool.name, audience: meta?.ui?.visibility?.every(value => value === "app") ? "app" : "model",
      tier: ["codex_diagnostics", "codex_agent_recovery_detach"].includes(tool.name) ? "operator" : "current",
      descriptorBytes: Buffer.byteLength(JSON.stringify(tool)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const report = { issue: 69, source: "issue-69 working tree", operator,
    registered: inventory.length, model: inventory.filter(tool => tool.audience === "model").length,
    app: inventory.filter(tool => tool.audience === "app").length,
    descriptorBytes: inventory.reduce((sum, tool) => sum + tool.descriptorBytes, 0),
    current: { registered: inventory.filter(tool => tool.tier === "current").length,
      model: inventory.filter(tool => tool.tier === "current" && tool.audience === "model").length,
      app: inventory.filter(tool => tool.tier === "current" && tool.audience === "app").length,
      descriptorBytes: inventory.filter(tool => tool.tier === "current").reduce((sum, tool) => sum + tool.descriptorBytes, 0) },
    compatibilityDescriptors: 0,
    acceptedNames: inventory.length, inventory };
  const output = path.resolve(`docs/audits/issue-69-card-tools-${operator ? "operator" : "after"}.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ...report, inventory: undefined, output }) + "\n");
} finally { await connection.close(); await server.close(); stateStore.close(); await rm(root, { recursive: true, force: true }); }
