import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { CodexJobRegistry } from "../src/tools.js";
import type { CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import type { CodexPendingInteraction, CodexProgress, CodexUpstream, ToolResult, UpstreamWorkerAssignment } from "../src/upstream.js";

// In-memory technical proof only. probe_answer is registered on this isolated
// test server, never on the production bridge. No model or real CLI is used.
const scopeId = "11111111-1111-4111-8111-111111111111";
const otherScopeId = "22222222-2222-4222-8222-222222222222";
const root = await mkdtemp(path.join(tmpdir(), "bridge-question-contract-"));
const store = new BridgeStateStore({ file: ":memory:" });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
const settings = new UserSettingsStore(config, { stateStore: store });
settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Synthetic question probe", cwd: root } }], undefined, 0);
const project = settings.current.projects[0];
const jobs = new CodexJobRegistry({ maxConcurrentJobs: config.maxConcurrentJobs, ttlMs: config.jobTtlMs,
  maxJobs: config.maxRetainedJobs, maxResultBytes: config.maxJobResultBytes, staleAfterMs: config.jobStaleAfterMs,
  allowedRoots: config.allowedRoots, stateStore: store });
const sessions = new SessionRegistry({ allowedRoots: config.allowedRoots, stateStore: store });
let emit: ((progress: CodexProgress) => void) | undefined;
let finish: ((result: ToolResult) => void) | undefined;
const delivered: Array<{ id: string; answers: unknown }> = [];
const upstream: CodexUpstream = {
  async listTools() { return { tools: [{ name: "codex" }] }; },
  async callTool(_name, _args, onProgress, onAssigned) {
    emit = onProgress;
    onAssigned?.({ backendKind: "app-server", workerId: "synthetic", workerGeneration: 1,
      workerPid: 999_901, processGroupId: 999_901, threadId: "synthetic-thread", upstreamRequestId: "synthetic-turn"
    } satisfies UpstreamWorkerAssignment);
    return new Promise<ToolResult>(resolve => { finish = resolve; });
  },
  async respondToInteraction(id, response) { delivered.push({ id, answers: response.answers }); },
  async close() {}
};
const catalog: CodexModelCatalogSnapshot = { source: "codex-cli", fetchedAt: new Date().toISOString(),
  validatedAt: new Date().toISOString(), fingerprint: "f".repeat(64), cached: true, stale: false, validation: "valid",
  models: [{ id: "gpt-5.6-sol", displayName: "Synthetic model", description: "Fixture", defaultReasoningEffort: "max",
    supportedReasoningEfforts: [{ effort: "max", description: "Fixture" }], isDefault: true,
    serviceTiers: [], inputModalities: ["text"], supportedInApi: true }] };
const server = createBridgeMcpServer(config, upstream, sessions, jobs,
  { getCachedCatalog: () => catalog, getCatalog: async () => catalog }, settings);
const client = new Client({ name: "question-feasibility", version: "0.0.0" });
const checks: Record<string, boolean> = {};
const measurements: Record<string, unknown> = {};
const token = (jobId: string, question: CodexPendingInteraction) => createHash("sha256")
  .update(JSON.stringify({ scopeId, jobId, worker: jobs.get(jobId)?.workerGeneration, question })).digest("hex");
const replies = new Map<string, { hash: string; result: { delivered: boolean } }>();

server.registerTool("probe_answer", {
  description: "Research-only model-callable answer to a known synthetic ordinary question.",
  inputSchema: z.strictObject({ scopeId: z.string().uuid(), jobId: z.string(), interactionId: z.literal("synthetic-question"),
    questionToken: z.string(), requestId: z.string().uuid(), answers: z.record(z.string(), z.array(z.string())) }),
  _meta: { ui: { visibility: ["model"] } }
}, async args => {
  const job = jobs.get(args.jobId);
  assert.ok(job && job.scopeId === args.scopeId, "Question scope mismatch");
  const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const previous = replies.get(args.requestId);
  if (previous) {
    assert.equal(previous.hash, hash, "Reply replay payload conflict");
    return { structuredContent: previous.result, content: [] };
  }
  const question = job.pendingInteractions.find(item => item.interactionId === args.interactionId);
  assert.ok(job.status === "running" && question?.kind === "user-input", "Question unavailable");
  assert.equal(args.questionToken, token(job.jobId, question), "Question revision changed");
  assert.deepEqual(args.answers, { color: ["Blue"] }, "Only the synthetic answer is allowed");
  await jobs.respondToInteraction(job.jobId, question.interactionId, { answers: args.answers });
  const result = { delivered: true };
  replies.set(args.requestId, { hash, result });
  return { structuredContent: result, content: [] };
});

try {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tool = (await client.listTools()).tools.find(item => item.name === "codex_interaction_respond")!;
  checks.currentResponderIsAppOnly = JSON.stringify(tool._meta).includes('"visibility":["app"]');
  const started = await client.callTool({ name: "codex_task", arguments: {
    scopeId, requestId: randomUUID(), taskContractVersion: "2", executionEnvelopeRef: settings.taskExecutionEnvelopeRef(),
    prompt: "Synthetic question feasibility", executionMode: "background", selection: { model: "gpt-5.6-sol", reasoningEffort: "max" },
    project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision }
  } });
  assert.notEqual(started.isError, true, JSON.stringify(started));
  const jobId = started.structuredContent!.jobId as string;
  const question: CodexPendingInteraction = { interactionId: "synthetic-question", kind: "user-input", isBlocking: false,
    threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "synthetic-item", summary: "Synthetic color question",
    questions: [{ id: "color", header: "Color", question: "Choose the synthetic color", isSecret: false, isOther: false,
      options: [{ label: "Blue", description: "Fixture option" }] }] };
  const pendingWait = client.callTool({ name: "codex_status", arguments: {
    scopeId, query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 160 }
  } });
  const timer = setTimeout(() => emit?.({ progress: 1, event: { eventId: "synthetic-question", type: "input-required",
    phase: "updated", createdAt: Date.now(), summary: question.summary, details: { interaction: question } } }), 15);
  const waited = await pendingWait;
  clearTimeout(timer);
  assert.notEqual(waited.isError, true, JSON.stringify(waited));
  const detail = (waited.structuredContent?.items as Array<Record<string, any>>)[0];
  checks.terminalWaitDoesNotReturnForPendingQuestion = detail.wait?.timedOut === true && detail.wait?.changed === true;
  checks.pendingQuestionRetainedInternally = jobs.get(jobId)!.pendingInteractions.length === 1;
  checks.publicStatusOmitsPendingQuestion = !JSON.stringify(waited.structuredContent).includes("synthetic-question") &&
    !JSON.stringify(waited.structuredContent).includes("Choose the synthetic color");
  const current = jobs.get(jobId)!;
  const versionBeforeProgress = current.version;
  const questionToken = token(jobId, current.pendingInteractions[0]);
  const changedWait = client.callTool({ name: "codex_status", arguments: {
    scopeId, query: { kind: "job", id: jobId, waitFor: "change", waitMs: 160 }
  } });
  const progressTimer = setTimeout(() => emit?.({ progress: 2, event: { eventId: "independent-progress", type: "agent-message",
    phase: "updated", createdAt: Date.now(), summary: "Synthetic independent work continues" } }), 15);
  const changed = await changedWait;
  clearTimeout(progressTimer);
  checks.changeWaitReturnsForProgress = (changed.structuredContent?.items as Array<Record<string, any>>)[0].wait?.timedOut === false;
  checks.progressChangesJobButNotQuestion = jobs.get(jobId)!.version > versionBeforeProgress &&
    token(jobId, jobs.get(jobId)!.pendingInteractions[0]) === questionToken;
  measurements.jobVersions = [versionBeforeProgress, jobs.get(jobId)!.version];
  const args = { scopeId, jobId, interactionId: "synthetic-question", questionToken, requestId: randomUUID(), answers: { color: ["Blue"] } };
  const wrongScope = await client.callTool({ name: "probe_answer", arguments: { ...args, scopeId: otherScopeId } });
  checks.prototypeRejectsOtherScope = wrongScope.isError === true && delivered.length === 0;
  const stale = await client.callTool({ name: "probe_answer", arguments: { ...args, questionToken: "stale" } });
  checks.prototypeRejectsChangedQuestion = stale.isError === true && delivered.length === 0;
  const answered = await client.callTool({ name: "probe_answer", arguments: args });
  checks.prototypeModelToolDeliversWithoutCardAfterProgress = answered.isError !== true && delivered.length === 1;
  const replay = await client.callTool({ name: "probe_answer", arguments: args });
  checks.prototypeReplayDeliversOnce = replay.isError !== true && delivered.length === 1;
  const duplicate = await client.callTool({ name: "probe_answer", arguments: { ...args, requestId: randomUUID() } });
  checks.prototypeRejectsResolvedQuestion = duplicate.isError === true && delivered.length === 1;
  finish?.({ content: [{ type: "text", text: "Synthetic completed" }], structuredContent: { threadId: "synthetic-thread" } });
  await jobs.get(jobId)!.promise;
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
} finally {
  finish?.({ content: [{ type: "text", text: "Synthetic cleanup" }], structuredContent: { threadId: "synthetic-thread" } });
  await client.close();
  await server.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
await mkdir("output/question-feasibility", { recursive: true });
const report = { observedAt: new Date().toISOString(), scope: "Real bridge MCP/registry with synthetic upstream and research-only prototype answer tool; no ChatGPT model execution.", checks, measurements };
await writeFile("output/question-feasibility/bridge-contract.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
