import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { loadConfig } from "../src/config.js";
import { CodexJobRegistry, MODEL_VISIBLE_OUTPUT_SCHEMAS } from "../src/tools.js";
import { modelCatalogFingerprint, type CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import type { CodexUpstream } from "../src/upstream.js";

// Deliberately isolated compatibility experiments, never an installed bridge or CLI.
const output = path.resolve("output/tool-guidance-code-paths");
const root = await mkdtemp(path.join(tmpdir(), "bridge-guidance-paths-"));
const observations: Array<{ id: string; layer: string; result: unknown }> = [];
const validator = new AjvJsonSchemaValidator();
function record(id: string, layer: string, result: unknown) { observations.push({ id, layer, result }); }
async function connect(server: McpServer) {
  const client = new Client({ name: "offline-guidance-code-paths", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}
async function attempt(client: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return { isError: result.isError === true, structured: result.structuredContent || null, content: result.content };
  } catch (error) { return { clientRejected: String(error) }; }
}

try {
  const sdk = new McpServer({ name: "scratch-sdk-contracts", version: "1" });
  const union = z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("compact-monitor"), presentationId: z.string().uuid() }),
    z.strictObject({ mode: z.literal("full-history") })
  ]);
  const okSchema = z.strictObject({ ok: z.boolean() });
  const ok = () => ({ content: [], structuredContent: { ok: true } });
  sdk.registerTool("root_union_input", { inputSchema: union, outputSchema: okSchema }, ok);
  sdk.registerTool("root_union_output", {
    inputSchema: z.strictObject({}),
    outputSchema: z.union([z.strictObject({ kind: z.literal("ok") }), z.strictObject({ kind: z.literal("error") })])
  }, async () => ({ content: [], structuredContent: { kind: "ok" } }));
  sdk.registerTool("foreign_structured_error", { inputSchema: z.strictObject({}), outputSchema: okSchema },
    async () => ({ isError: true, content: [], structuredContent: { error: { code: "FIXTURE" } } }));

  const rootObject = z.strictObject({
    mode: z.enum(["compact-monitor", "full-history"]).optional(),
    presentationId: z.string().uuid().optional()
  });
  const projected = {
    type: "object", additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["compact-monitor", "full-history"] },
      presentationId: { type: "string", format: "uuid" }
    },
    oneOf: [
      { properties: { mode: { type: "string", const: "compact-monitor" } }, required: ["mode", "presentationId"] },
      { properties: { mode: { type: "string", const: "full-history" } }, not: { required: ["presentationId"] } }
    ]
  };
  const projectionTarget = rootObject._zod.parent || rootObject;
  (projectionTarget._zod as typeof projectionTarget._zod & { toJSONSchema: () => unknown }).toJSONSchema = () => structuredClone(projected);
  sdk.registerTool("root_object_conditions", { inputSchema: rootObject, outputSchema: okSchema }, async (value) => {
    if (value.mode === "compact-monitor" && !value.presentationId) throw new Error("presentationId required");
    if ((value.mode || "full-history") === "full-history" && value.presentationId) throw new Error("presentationId forbidden");
    return ok();
  });

  const evolving = sdk.registerTool("cached_actions", {
    inputSchema: z.strictObject({}), outputSchema: z.strictObject({ nextActions: z.array(z.string()) })
  }, async () => ({ content: [], structuredContent: { nextActions: [{ tool: "codex_settings", arguments: {} }] } }));
  const additive = sdk.registerTool("cached_additive", {
    inputSchema: z.strictObject({}), outputSchema: okSchema
  }, async () => ({ content: [], structuredContent: { ok: true, policyMode: "fixed" } }));
  const client = await connect(sdk);
  try {
    const tools = (await client.listTools()).tools;
    const inputTool = tools.find(t => t.name === "root_union_input")!;
    assert.deepEqual(inputTool.inputSchema, { type: "object", properties: {} });
    record("sdk-root-union-input-erased", "actual SDK tools/list", inputTool.inputSchema);
    const outputTool = tools.find(t => t.name === "root_union_output")!;
    assert.equal(outputTool.outputSchema, undefined);
    record("sdk-root-union-output-unpublished", "actual SDK tools/list and call", {
      outputSchemaPresent: false, call: await attempt(client, "root_union_output")
    });
    const foreign = await attempt(client, "foreign_structured_error");
    assert.ok("clientRejected" in foreign);
    record("sdk-error-structured-content-still-validated", "actual SDK client", foreign);
    // Scratch server only: simulate a new server generation and an old cached client.
    evolving.outputSchema = z.strictObject({ nextActions: z.array(z.strictObject({ tool: z.string(), arguments: z.strictObject({}) })) });
    additive.outputSchema = z.strictObject({ ok: z.boolean(), policyMode: z.string().optional() });
    for (const name of ["cached_actions", "cached_additive"]) {
      const result = await attempt(client, name);
      assert.ok("clientRejected" in result);
      record("sdk-old-client-rejects-" + name, "actual SDK cached output validator", result);
    }
    const published = tools.find(t => t.name === "root_object_conditions")!.inputSchema;
    const check = validator.getValidator(published);
    const cases = [
      { input: {}, valid: true },
      { input: { mode: "full-history" }, valid: true },
      { input: { mode: "compact-monitor", presentationId: randomUUID() }, valid: true },
      { input: { mode: "compact-monitor" }, valid: false },
      { input: { mode: "full-history", presentationId: randomUUID() }, valid: false }
    ];
    const results = [];
    for (const item of cases) {
      assert.equal(check(item.input).valid, item.valid, JSON.stringify({ input: item.input, published }));
      const result = await attempt(client, "root_object_conditions", item.input);
      assert.ok(!("clientRejected" in result));
      assert.equal(result.isError, !item.valid, JSON.stringify({ input: item.input, result }));
      results.push({ input: item.input, valid: item.valid, runtimeIsError: result.isError });
    }
    record("sdk-object-root-condition-alternative", "actual SDK plus published JSON Schema validation", { schema: published, cases: results });
  } finally { await client.close(); await sdk.close(); }

  const state = new BridgeStateStore({ file: ":memory:" });
  const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
  const settings = new UserSettingsStore(config, { stateStore: state });
  const jobs = new CodexJobRegistry({ stateStore: state, allowedRoots: [root] });
  let upstreamCalls = 0;
  const upstream: CodexUpstream = {
    async listTools() { return { tools: [] }; },
    async callTool() { upstreamCalls++; throw new Error("No upstream execution is allowed in this audit."); },
    async close() {}
  };
  const models: CodexModelCatalogSnapshot["models"] = [{
    id: "gpt-5.6-sol", displayName: "Fixture", description: "Offline fixture",
    defaultReasoningEffort: "max", supportedReasoningEfforts: [{ effort: "max", description: "Fixture" }],
    isDefault: true, serviceTiers: [], inputModalities: ["text"], supportedInApi: true
  }];
  const now = new Date().toISOString();
  const catalog: CodexModelCatalogSnapshot = { source: "app-server", fetchedAt: now, validatedAt: now,
    fingerprint: modelCatalogFingerprint(models), cached: true, stale: false, validation: "valid", models };
  const server = createBridgeMcpServer(config, upstream, new SessionRegistry({ stateStore: state }), jobs,
    { getCachedCatalog: () => catalog, getCatalog: async () => catalog }, settings);
  const bridge = await connect(server);
  try {
    const inventory = (await bridge.listTools()).tools;
    const task = inventory.find(t => t.name === "codex_task")!;
    const taskFields = task.inputSchema.properties as Record<string, any>;
    const meta = { "openai/session": "offline-guidance-code-paths" };
    const base = () => ({ requestId: randomUUID(), taskContractVersion: taskFields.taskContractVersion.const,
      executionEnvelopeRef: taskFields.executionEnvelopeRef.const, prompt: "Offline admission only." });
    const pair = { model: "gpt-5.6-sol", reasoningEffort: "max" };
    const call = (name: string, args: Record<string, unknown> = {}) => attempt(bridge, name, args, meta);
    for (const name of ["Alpha", "Beta"]) {
      const cwd = path.join(root, name); await mkdir(cwd);
      settings.updateWithProjectOperations({}, [{ kind: "add", project: { name, cwd } }], undefined, settings.current.registryRevision);
    }
    const alpha = settings.current.projects.find(p => p.name === "Alpha")!;
    await rm(path.join(root, "Alpha"), { recursive: true });
    record("direct-project-admission-unavailable", "production MCP handler and project resolver", await call("codex_task", {
      ...base(), selection: pair, project: { name: alpha.name, projectRef: alpha.projectRef, projectRevision: alpha.projectRevision }
    }));
    record("lookup-project-unavailable", "production MCP lookup recovery", await call("codex_task", { ...base(), projectLookup: { name: "Alpha" } }));
    record("lookup-existing-is-preflight-error", "production MCP lookup success representation", await call("codex_task", { ...base(), projectLookup: { name: "Beta" } }));
    record("cancel-missing-job-also-suggests-new-work", "production MCP cancellation admission", await call("codex_cancel", {
      requestId: randomUUID(), jobId: "no-job", expectedVersion: 1, reason: "Offline fixture cancellation probe"
    }));
    record("input-syntax-error", "SDK before handler", await call("codex_input", { jobId: "" }));
    record("input-domain-error", "production handler after parser", await call("codex_input", { jobId: "no-job" }));

    const beforeModels = await call("codex_models");
    settings.updateWithProjectOperations({ modelPolicy: { mode: "fixed", selection: pair, constraints: settings.current.modelPolicy.constraints }, activityCardVisibility: "never" },
      [], settings.current.settingsRevision, undefined);
    const afterModels = await call("codex_models");
    assert.deepEqual(beforeModels, afterModels);
    const afterTask = (await bridge.listTools()).tools.find(t => t.name === "codex_task")!;
    assert.deepEqual(afterTask, task);
    record("policy-mode-changes-with-identical-model-query-and-task-descriptor", "production policy projection", {
      beforeMode: "automatic", afterMode: settings.current.modelPolicy.mode, models: afterModels, taskDescriptorUnchanged: true
    });
    record("fixed-policy-selection-rejected", "production runtime policy validation", await call("codex_task", { ...base(), selection: pair }));
    record("compact-card-never-policy-rejected", "production card presentation", await call("codex_activity", { mode: "compact-monitor", presentationId: randomUUID() }));
    record("explicit-history-survives-never-policy", "production card presentation", await call("codex_activity", { mode: "full-history" }));

    const cancellationSchema = inventory.find(t => t.name === "codex_cancel")!.inputSchema;
    // These keys are the actual AGENT_BUSY forceStop producer's shape in src/tools.ts.
    const internalActionArgs = { requestId: randomUUID(), jobId: "fixture-active-job", expectedVersion: 1 };
    const actionValidation = validator.getValidator(cancellationSchema)(internalActionArgs);
    assert.equal(actionValidation.valid, false);
    record("internal-forceStop-is-not-a-complete-call", "current producer shape versus published target schema", {
      producer: "src/tools.ts AGENT_BUSY forceStop", arguments: internalActionArgs, validation: actionValidation
    });
    const settingsSchema = inventory.find(t => t.name === "codex_update_settings")!.inputSchema;
    const overlyStrictRevisions = structuredClone(settingsSchema);
    overlyStrictRevisions.required = ["operation", "expectedSettingsRevision", "expectedRegistryRevision"];
    const beta = settings.current.projects.find(p => p.name === "Beta")!;
    const projectOnly = {
      expectedRegistryRevision: settings.current.registryRevision,
      operation: { kind: "patch", settings: { projectOperations: [{ kind: "rename", projectId: beta.id, name: "Beta renamed" }] } }
    };
    const projectSave = await call("codex_update_settings", projectOnly);
    assert.ok(!("clientRejected" in projectSave) && !projectSave.isError);
    assert.equal(validator.getValidator(overlyStrictRevisions)(projectOnly).valid, false);
    record("project-only-settings-save-needs-only-registry-revision", "production settings service and alternative schema", {
      suppliedRevision: "expectedRegistryRevision", success: true, alternativeRequiringBothValid: false
    });
    const resetOnly = { expectedSettingsRevision: settings.current.settingsRevision, operation: { kind: "reset" } };
    const reset = await call("codex_update_settings", resetOnly);
    assert.ok(!("clientRejected" in reset) && !reset.isError);
    assert.equal(validator.getValidator(overlyStrictRevisions)(resetOnly).valid, false);
    assert.equal(settings.current.projects.length, 2);
    record("settings-reset-needs-only-settings-revision", "production settings service and alternative schema", {
      suppliedRevision: "expectedSettingsRevision", success: true, alternativeRequiringBothValid: false, retainedProjects: 2
    });
    assert.equal(upstreamCalls, 0);
    assert.equal(jobs.list(100).length, 0);
    record("production-probes-have-no-admitted-jobs", "isolated state and upstream boundary", { upstreamCalls, jobs: jobs.list(100).length });
  } finally { await bridge.close(); await server.close(); state.close(); }

  const capacity = new BridgeStateStore({ file: ":memory:" });
  try {
    const records = [];
    for (let i = 0; i < 100; i++) {
      const item = capacity.questions.create("capacity", { requestId: randomUUID(), title: "Fixture " + i,
        questions: [{ id: "choice", header: "Fixture", question: "Offline capacity fixture" }] });
      records.push(capacity.questions.submit(item, { choice: ["Fixture " + i] }));
    }
    assert.throws(() => capacity.questions.create("capacity", { requestId: randomUUID(), title: "101st",
      questions: [{ id: "choice", header: "Fixture", question: "Over limit" }] }), /QUESTION_LIMIT/);
    const firstPage = capacity.questions.readResponses("capacity");
    assert.equal(firstPage.length, 20);
    assert.deepEqual(capacity.questions.readResponses("capacity"), firstPage);
    assert.ok(firstPage.every(item => !item.consumedAt));
    record("question-discovery-does-not-consume", "actual QuestionStore", { pageLength: 20, stableRepeatedRead: true, consumed: false });
    const consumed = new Set<string>();
    for (let page = 0; page < 5; page++) {
      for (const item of capacity.questions.readResponses("capacity")) {
        const read = capacity.questions.readResponses("capacity", item.responseRef)[0];
        assert.ok(read.consumedAt);
        consumed.add(read.questionId);
      }
    }
    assert.equal(consumed.size, 100);
    assert.ok(consumed.has(records[0].questionId));
    assert.equal(capacity.questions.readResponses("capacity").length, 0);
    assert.equal(capacity.questions.claimNotification(capacity.questions.get("capacity", records[0].questionId)).send, false);
    record("question-cap-prevents-older-live-row-loss", "actual QuestionStore admission and recovery", {
      admitted: 100, admission101: "QUESTION_LIMIT", pagesDrained: 5, recovered: consumed.size, oldestRecovered: true,
      unreadRemaining: 0, notificationAfterConsumption: false
    });
  } finally { capacity.close(); }

  const publishedOutputs = Object.values(MODEL_VISIBLE_OUTPUT_SCHEMAS).map(schema => z.toJSONSchema(schema));
  const outputBytes = publishedOutputs.reduce((total, schema) => total + Buffer.byteLength(JSON.stringify(schema)), 0);
  const minimalAction = {
    type: "object", additionalProperties: false,
    properties: { tool: { type: "string", enum: ["codex_settings", "codex_models"] }, arguments: { type: "object", properties: {}, additionalProperties: false } },
    required: ["tool", "arguments"]
  };
  let replacedActions = 0;
  const experiment = structuredClone(publishedOutputs) as any;
  const expand = (node: any): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node) as Array<[string, any]>) {
      if (key === "nextActions" && value?.type === "array" && value.items?.type === "string") {
        value.items = structuredClone(minimalAction); replacedActions++;
      } else expand(value);
    }
  };
  expand(experiment);
  record("inline-action-object-schema-budget", "schema copies only; deliberately incomplete two-tool size experiment", {
    currentOutputBytes: outputBytes, regressionLimitBytes: 19500, replacedActions,
    minimalExpandedBytes: experiment.reduce((total: number, schema: unknown) => total + Buffer.byteLength(JSON.stringify(schema)), 0),
    note: "Not a proposed complete action schema. Real typed actions need more branches and validation."
  });

  const traceFiles = ["src/tools.ts", "src/questionTools.ts"];
  const traces: Array<{ tool: string; file: string; line: number; sourceSha256: string; handlerCalls: string[]; literalErrors: string[] }> = [];
  for (const file of traceFiles) {
    const body = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "registerTool" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const handler = node.arguments[2];
        const calls = new Set<string>();
        const errors = new Set<string>();
        const visit = (part: ts.Node): void => {
          if (ts.isCallExpression(part)) calls.add(part.expression.getText(tree).replace(/\s+/g, " ").slice(0, 160));
          if (ts.isNewExpression(part) && part.expression.getText(tree) === "Error"
            && part.arguments?.[0] && ts.isStringLiteral(part.arguments[0])) errors.add(part.arguments[0].text);
          ts.forEachChild(part, visit);
        };
        if (handler) visit(handler);
        traces.push({ tool: node.arguments[0].text, file,
          line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          sourceSha256: createHash("sha256").update(body).digest("hex"),
          handlerCalls: [...calls], literalErrors: [...errors] });
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  assert.equal(traces.length, 30);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "evidence.json"), JSON.stringify({ date: "2026-09-08",
    installedServiceChanged: false, realCliStarted: false, observations, traces }, null, 2) + "\n");
  console.log(JSON.stringify({ observations: observations.length, toolHandlersTraced: traces.length, output }));
} finally { await rm(root, { recursive: true, force: true }); }
