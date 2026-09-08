import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import { loadConfig } from "../src/config.js";
import { parseAppServerModelCatalog, modelCatalogFingerprint } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { questionReference } from "../src/codexInputs.js";
import { existsSync } from "node:fs";

// Opt-in: real authenticated CLI/model, production MCP tools, synthetic answer.
// This is not evidence of a parent ChatGPT model or live ChatGPT card wake.
assert.equal(process.argv[2], "--run-authenticated");
const nativeInput = process.argv.includes("--native-input");
const approvalProbe = process.argv.includes("--approval-probe");
assert.ok(!(nativeInput && approvalProbe), "Choose one probe mode.");
const reports: Record<string, unknown>[] = [];
for (const arg of process.argv.slice(3).filter(value => !["--native-input", "--approval-probe"].includes(value))) {
  const split = arg.indexOf("="), source = arg.slice(0, split), command = arg.slice(split + 1);
  assert.ok(/^[a-z-]+$/.test(source) && path.isAbsolute(command), "Use source=/absolute/path/to/codex");
  const root = await mkdtemp(path.join(tmpdir(), "live-gpt-question-")); await chmod(root, 0o700);
  const isolatedHome = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(isolatedHome, { mode: 0o700 }); await mkdir(project);
  await copyFile(path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json"), path.join(isolatedHome, "auth.json"));
  await chmod(path.join(isolatedHome, "auth.json"), 0o600);
  const ledger = path.join(root, "invocations.txt");
  await writeFile(path.join(isolatedHome, "config.toml"), 'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n' +
    (nativeInput ? '[features]\ndefault_mode_request_user_input = true\n' : "") +
    (approvalProbe ? '\n[mcp_servers.question_approval_probe]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' + JSON.stringify(path.resolve("scripts/fixtures/question-approval-mcp.mjs")) + ']\nenv = { QUESTION_PROBE_LEDGER = ' + JSON.stringify(ledger) + ' }\n' : ""));
  const pool = new CodexAppServerUpstreamPool(command, 1, { environment: { ...process.env, CODEX_HOME: isolatedHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } });
  const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: project });
  const store = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
  const jobs = new CodexJobRegistry({ stateStore: store, allowedRoots: [project] });
  const settings = new UserSettingsStore(config, { stateStore: store });
  settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Question canary", cwd: project } }], undefined, 0);
  const client = new Client({ name: "question-canary", version: "1" });
  let server: ReturnType<typeof createBridgeMcpServer> | undefined;
  const report: Record<string, unknown> = { source, cli: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(), model: "gpt-6-astra", nativeInput, approvalProbe, productionMcp: true, parentChatGpt: false };
  reports.push(report);
  const started = Date.now();
  const deadline = setTimeout(() => { report.timedOut = true; void pool.close().catch(() => {}); }, 60_000);
  try {
    assert.equal((await pool.readAccountSnapshot())?.authenticated, true);
    const models = parseAppServerModelCatalog(await pool.listModels()), now = new Date().toISOString();
    const catalog = { source: "app-server" as const, fetchedAt: now, validatedAt: now, fingerprint: modelCatalogFingerprint(models), cached: false, stale: false, validation: "valid" as const, models };
    assert.ok(models.some(model => model.id === "gpt-6-astra"));
    server = createBridgeMcpServer(config, pool, new SessionRegistry({ stateStore: store }), jobs,
      { getCatalog: async () => catalog, getCachedCatalog: () => catalog }, settings);
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), server.connect(b)]);
    const meta = { "openai/session": "isolated-live-question-" + randomUUID() };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }) as any;
      assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent;
    };
    const selected = settings.current.projects[0];
    const task = await call("codex_task", { requestId: randomUUID(), taskContractVersion: "2", executionEnvelopeRef: settings.taskExecutionEnvelopeRef(),
      project: { name: selected.name, projectRef: selected.projectRef, projectRevision: selected.projectRevision },
      selection: { model: "gpt-6-astra", reasoningEffort: "low" }, executionMode: "background",
      prompt: approvalProbe
        ? "This is an isolated approval-boundary test. Call the MCP question_approval_probe.approval_probe tool exactly once. Its destructive annotation should request user approval. The client will DECLINE the approval. After that denial finish with PROBE_APPROVAL_DECLINED. Do no file, shell, browser, network or other tool work. Do not retry the action or try another route. If the tool is unavailable, finish immediately with PROBE_UNAVAILABLE."
        : nativeInput
        ? "Protocol probe only. Call the request_user_input tool exactly once (the server-request tool, not request_user_input_async) with one question id color, header Color, question Which probe color?, and options Blue and Red. It is enabled in default mode for this isolated test. Do no file, shell, browser, network, MCP or permission work. The client will answer Blue. Finish with PROBE_ANSWER_Blue after receiving it. If request_user_input is unavailable, finish immediately with PROBE_UNAVAILABLE. Do not loop."
        : "Protocol probe only. Use request_user_input_async exactly once to ask 'Which probe color?' with options Blue and Red. Do no file, shell, browser, network, MCP or permission work. After submitting the question say PROBE_CONTINUES in commentary. The client will answer Blue. Finish with PROBE_ANSWER_Blue after receiving it. If request_user_input_async is unavailable, finish immediately with PROBE_UNAVAILABLE. Do not loop or wait indefinitely." });
    const jobId = task.jobId;
    let cursor: string | undefined;
    while (Date.now() - started < 50_000) {
      const input = await call("codex_input", { jobId, ...(cursor ? { afterCursor: cursor } : {}), waitMs: 5000 });
      cursor = input.cursor;
      if (approvalProbe && input.approvals.length) {
        assert.equal(input.questions.length, 0);
        const job = jobs.get(jobId)!, pending = job.pendingInteractions[0];
        assert.equal(pending.kind, "mcp-elicitation");
        report.approvalRoute = pending.kind;
        const forbidden = await client.callTool({ name: "codex_answer", arguments: { requestId: randomUUID(), jobId,
          questionRef: questionReference(job, pending), answers: {} }, _meta: meta });
        assert.equal(forbidden.isError, true);
        assert.match(JSON.stringify(forbidden.content), /QUESTION_UNAVAILABLE: This is not a current ordinary question/);
        report.publicAnswerRejected = true;
        report.publicAnswerRejection = "not-an-ordinary-question";
        await jobs.respondToInteraction(jobId, pending.interactionId, { elicitation: { action: "decline", content: null } });
        report.answerRoute = "app-only-decline";
        break;
      }
      if (input.questions.length) {
        const q = input.questions[0];
        assert.equal(q.questions.length, 1); assert.ok(q.questions[0].options?.some((o: any) => o.label === "Blue"));
        const answered = await call("codex_answer", { requestId: randomUUID(), jobId, questionRef: q.questionRef, answers: { [q.questions[0].id]: ["Blue"] } });
        assert.equal(answered.delivery, "delivered"); report.answerRoute = "codex_answer"; break;
      }
      if (!nativeInput && !approvalProbe && input.messages.some((m: any) => /Which probe color/i.test(m.text) && m.text.includes("Blue") && m.text.includes("Red"))) {
        assert.equal(input.approvals.length, 0);
        const steered = await call("codex_steer", { requestId: randomUUID(), jobId, expectedJobVersion: input.jobVersion,
          prompt: "For the probe color question, my answer is Blue. Finish with PROBE_ANSWER_Blue. Do not ask again." });
        assert.equal(steered.delivery.status, "delivered"); report.answerRoute = "codex_steer"; break;
      }
      if (!input.active) break;
    }
    const completed = await call("codex_status", { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 10000 } });
    report.questionObserved = Boolean(report.answerRoute);
    report.terminalStatus = completed.items[0].state;
    report.answerReflected = String(completed.items[0].answer).includes(approvalProbe ? "PROBE_APPROVAL_DECLINED" : "PROBE_ANSWER_Blue");
    if (approvalProbe) { report.toolInvoked = existsSync(ledger); assert.equal(report.toolInvoked, false); }
    report.passed = report.questionObserved && report.terminalStatus === "completed" && report.answerReflected;
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 1000) : "Canary failed";
    report.passed = false;
  } finally {
    clearTimeout(deadline); await pool.close();
    await Promise.all(jobs.list(100).map(job => job.promise));
    await client.close().catch(() => {}); await server?.close(); store.close();
    await rm(root, { recursive: true, force: true }); report.temporaryHomeRemoved = true; report.elapsedMs = Date.now() - started;
  }
  console.log(JSON.stringify(report));
}
await mkdir("output/question-feasibility", { recursive: true });
await writeFile("output/question-feasibility/issue-68-live-mcp" + (nativeInput ? "-native" : approvalProbe ? "-approval" : "") + ".json", JSON.stringify({ reports }, null, 2));
assert.ok(reports.length && reports.every(report => report.passed === true), "Live question canary did not pass every CLI");
