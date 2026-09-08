import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { BRIDGE_MCP_INSTRUCTIONS, createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";
import { modelCatalogFingerprint, type CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import type { CodexUpstream } from "../src/upstream.js";

// Offline audit: isolated memory database and temporary fixture projects.
// No installed service, user configuration, credentials or real Codex is used.
const output = path.resolve("output/tool-guidance-audit");
const root = await mkdtemp(path.join(tmpdir(), "bridge-tool-guidance-"));
const state = new BridgeStateStore({ file: ":memory:" });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
const settings = new UserSettingsStore(config, { stateStore: state });
const jobs = new CodexJobRegistry({ stateStore: state, allowedRoots: [root] });
let upstreamCalls = 0;
const upstream: CodexUpstream = {
  async listTools() { return { tools: [] }; },
  async callTool() { upstreamCalls++; throw new Error("Audit must never dispatch Codex work."); },
  async close() {}
};
const now = new Date().toISOString();
const models: CodexModelCatalogSnapshot["models"] = [{
  id: "gpt-5.6-sol", displayName: "Audit fixture model", description: "Offline fixture",
  defaultReasoningEffort: "max", supportedReasoningEfforts: [{ effort: "max", description: "Fixture effort" }],
  isDefault: true, serviceTiers: [], inputModalities: ["text"], supportedInApi: true
}];
const catalog: CodexModelCatalogSnapshot = { source: "app-server", fetchedAt: now,
  validatedAt: now, fingerprint: modelCatalogFingerprint(models), cached: true,
  stale: false, validation: "valid", models };
const server = createBridgeMcpServer(config, upstream, new SessionRegistry({ stateStore: state }), jobs,
  { getCachedCatalog: () => catalog, getCatalog: async () => catalog }, settings);
const client = new Client({ name: "offline-tool-guidance-audit", version: "1" });
const source: Record<string, { file: string; line: number; descriptionLine?: number }> = {};
for (const file of ["src/tools.ts", "src/questionTools.ts"]) {
  const body = await readFile(file, "utf8");
  const tree = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "registerTool" && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])) {
      const options = node.arguments[1];
      const description = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === "description") : undefined;
      source[node.arguments[0].text] = { file, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        ...(description ? { descriptionLine: tree.getLineAndCharacterOfPosition(description.getStart()).line + 1 } : {}) };
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

function schemaFacts(schema: any) {
  const descriptions: Array<{ pointer: string; text: string }> = [];
  const variants: Array<{ pointer: string; branches: number }> = [];
  const openObjects: string[] = [];
  const mapObjects: string[] = [];
  let closedObjects = 0;
  const walk = (value: any, pointer: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${pointer}/${i}`)); return; }
    if (typeof value.description === "string") descriptions.push({ pointer, text: value.description });
    for (const key of ["oneOf", "anyOf"]) if (Array.isArray(value[key])) variants.push({ pointer: `${pointer}/${key}`, branches: value[key].length });
    if (value.type === "object") {
      if (value.additionalProperties === false) closedObjects++;
      else if (value.additionalProperties && typeof value.additionalProperties === "object") mapObjects.push(pointer);
      else openObjects.push(pointer);
    }
    for (const [key, item] of Object.entries(value)) walk(item, `${pointer}/${key}`);
  };
  walk(schema, "");
  return { bytes: Buffer.byteLength(JSON.stringify(schema || {})),
    required: schema?.required || [], fields: Object.keys(schema?.properties || {}),
    closedObjects, mapObjects, openObjects, variants, descriptions };
}

try {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const inventory = (await client.listTools()).tools;
  assert.equal(inventory.length, 30);
  const summaries = inventory.map(tool => {
    const metadata = tool._meta as any;
    const visibility = metadata?.ui?.visibility;
    const publicTool = metadata?.["openai/visibility"] !== "private" && (!visibility || visibility.includes("model"));
    const description = tool.description || "";
    return { name: tool.name, title: tool.title, source: source[tool.name], public: publicTool,
      description, descriptionWords: description.split(/\s+/).filter(Boolean).length,
      mentionedTools: [...new Set(description.match(/\bcodex_[a-z_]+\b/g) || [])],
      mentionedErrors: [...new Set(description.match(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g) || [])],
      uiResource: metadata?.ui?.resourceUri || metadata?.["openai/outputTemplate"] || null,
      annotations: tool.annotations, input: schemaFacts(tool.inputSchema), output: schemaFacts(tool.outputSchema) };
  });
  const task = inventory.find(t => t.name === "codex_task")!;
  const properties = task.inputSchema.properties as Record<string, any>;
  const probes: Array<Record<string, unknown>> = [];
  const meta = { "openai/session": "offline-tool-guidance-audit" };
  const baseTask = () => ({ requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt: "Offline admission probe; never execute." });
  const probe = async (label: string, name: string, args: Record<string, unknown>) => {
    try {
      const result = await client.callTool({ name, arguments: args, _meta: meta });
      const structured = result.structuredContent as any;
      probes.push({ label, name, isError: result.isError === true, structured: structured || null,
        content: result.content, resultMetadataKeys: Object.keys(result._meta || {}) });
    } catch (error) { probes.push({ label, name, thrown: String(error) }); }
  };
  const withSelection = () => ({ ...baseTask(), selection: { model: "gpt-5.6-sol", reasoningEffort: "max" } });
  await probe("model-and-project-both-unspecified", "codex_task", baseTask());
  await probe("no-registered-project", "codex_task", withSelection());
  for (const name of ["Alpha", "Beta"]) {
    const cwd = path.join(root, name); await mkdir(cwd);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name, cwd } }], undefined, settings.current.registryRevision);
  }
  await probe("project-not-selected", "codex_task", withSelection());
  await probe("lookup-without-execution-prompt", "codex_task", {
    requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, projectLookup: { name: "Alpha" }
  });
  await probe("lookup-existing-project", "codex_task", { ...baseTask(), projectLookup: { name: "Alpha" } });
  await probe("lookup-unknown-project", "codex_task", { ...baseTask(), projectLookup: { name: "Missing" } });
  await probe("models-information", "codex_models", {});
  await probe("unknown-job-status", "codex_status", { query: { kind: "job", id: "not-an-audit-job" } });
  await probe("status-wait-without-mode", "codex_status", { query: { kind: "job", id: "not-an-audit-job", waitMs: 1 } });
  await probe("unknown-job-input", "codex_input", { jobId: "not-an-audit-job" });
  await probe("unknown-user-answer", "codex_user_answer", { responseRef: randomUUID() });
  await probe("duplicate-question-ids", "codex_ask_user", { requestId: randomUUID(), title: "Offline audit",
    questions: [1, 2].map(() => ({ id: "duplicate", header: "Audit", question: "Offline fixture?" })) });
  await probe("empty-activity-policy", "codex_activity_update", { activityId: randomUUID(), expectedVersion: 1,
    operation: { kind: "set-policy", policy: {} } });
  await probe("compact-card-without-presentation-id", "codex_activity", { mode: "compact-monitor" });
  const alpha = settings.current.projects.find(p => p.name === "Alpha")!;
  await rm(path.join(root, "Alpha"), { recursive: true });
  await probe("requested-folder-unavailable-with-another-project", "codex_task", { ...baseTask(), projectLookup: { name: alpha.name } });
  await rm(path.join(root, "Beta"), { recursive: true });
  await probe("registered-but-all-folders-unavailable", "codex_task", withSelection());
  settings.updateWithProjectOperations({}, settings.current.projects.map(project => ({
    kind: "archive" as const, projectId: project.id
  })), undefined, settings.current.registryRevision);
  await probe("registered-but-all-archived", "codex_task", withSelection());
  assert.equal(upstreamCalls, 0);
  const report = { date: "2026-09-08", method: "actual tools/list on isolated in-memory production MCP plus no-execution contract probes",
    realChatGptModelRun: false, installedServiceChanged: false, upstreamCalls,
    totals: { all: summaries.length, public: summaries.filter(t => t.public).length,
      private: summaries.filter(t => !t.public).length,
      publicDescriptionWords: summaries.filter(t => t.public).reduce((n, t) => n + t.descriptionWords, 0),
      sharedInstructionWords: BRIDGE_MCP_INSTRUCTIONS.split(/\s+/).length }, tools: summaries, probes };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  await writeFile(path.join(output, "audit.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report.totals, upstreamCalls, probes: probes.length, output }));
} finally {
  await client.close(); await server.close(); state.close();
  await rm(root, { recursive: true, force: true });
}
