import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { CodexPendingInteraction } from "../src/upstream.js";

// Opt-in feasibility probe: actual CLI/model, programmatic synthetic answer,
// no ChatGPT widget or parent-model integration is claimed by this script.
const commands = process.argv.slice(2).filter(argument => argument !== "--run-authenticated");
assert.ok(process.argv.includes("--run-authenticated") && commands.length && commands.every(path.isAbsolute),
  "Pass --run-authenticated followed by absolute CLI paths.");
const loginFile = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
const auth = JSON.parse(await readFile(loginFile, "utf8"));
assert.ok(auth.auth_mode === "chatgpt" && typeof auth.tokens?.access_token === "string",
  "An existing file-based ChatGPT login is required.");
const reports: Record<string, unknown>[] = [];

for (const command of commands) {
  const directory = await mkdtemp(path.join(tmpdir(), "bridge-question-feasibility-"));
  await chmod(directory, 0o700);
  const isolatedHome = path.join(directory, "home");
  const project = path.join(directory, "synthetic-project");
  const report: Record<string, unknown> = {
    version: execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(),
    model: "gpt-6-astra", defaultModeInputFlagOverridden: false,
    questionObserved: false, nonblocking: false, answerSent: false,
    progressBeforeAnswer: false, finalContainsAnswer: false, passed: false
  };
  reports.push(report);
  let pool: CodexAppServerUpstreamPool | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let fallbackAnswer: NodeJS.Timeout | undefined;
  let replyPromise: Promise<void> | undefined;
  let pending: CodexPendingInteraction | undefined;
  let observedProgress = false;
  let failure: unknown;
  const started = Date.now();
  const progressText: string[] = [];
  const eventCounts: Record<string, number> = {};
  const stages: Array<{ name: string; elapsedMs: number }> = [];
  const stage = (name: string) => {
    stages.push({ name, elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ stage: name, version: report.version }));
  };
  try {
    await mkdir(isolatedHome, { mode: 0o700 });
    await mkdir(project);
    await copyFile(loginFile, path.join(isolatedHome, "auth.json"));
    await chmod(path.join(isolatedHome, "auth.json"), 0o600);
    await writeFile(path.join(isolatedHome, "config.toml"),
      'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n');
    pool = new CodexAppServerUpstreamPool(command, 1, { environment: {
      ...process.env, CODEX_HOME: isolatedHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined
    } });
    deadline = setTimeout(() => {
      failure = new Error("Synthetic asynchronous-input probe exceeded 150 seconds.");
      void pool?.close().catch(() => undefined);
    }, 150_000);
    stage("connecting");
    const account = await pool.readAccountSnapshot();
    report.authenticated = account?.authenticated === true;
    assert.equal(report.authenticated, true, "Isolated CLI account was not authenticated.");
    stage("account-confirmed");
    const models = await pool.listModels();
    report.requestedModelListed = JSON.stringify(models).includes("gpt-6-astra");
    stage("models-read");
    const answer = () => {
      if (!pending || replyPromise) return;
      if (fallbackAnswer) clearTimeout(fallbackAnswer);
      const interaction = pending;
      report.progressBeforeAnswer = observedProgress;
      replyPromise = (async () => {
        assert.equal(interaction.kind, "user-input", "Unexpected interaction kind");
        assert.equal(interaction.questions?.length, 1, "Expected one synthetic question");
        const question = interaction.questions![0];
        assert.equal(question.isSecret, false);
        assert.ok(question.options?.some(option => option.label === "Blue"));
        await pool!.respondToInteraction(interaction.interactionId, { answers: { [question.id]: ["Blue"] } });
        report.answerSent = true;
      })();
      void replyPromise.catch(error => { failure = error; return pool?.close().catch(() => undefined); });
    };
    const result = await pool.callTool("codex", {
      cwd: project, sandbox: "read-only", "approval-policy": "on-request", ephemeral: true,
      model: "gpt-6-astra", config: { model_reasoning_effort: "low" },
      prompt: "This is a read-only protocol integration probe in an empty test folder. Do not use file, shell, network, browser, MCP, or permission tools. Call request_user_input_async exactly once with one question titled 'Which probe color should be used?' and options 'Blue' and 'Red'. After the asynchronous call returns, emit the commentary marker PROBE_ASYNC_CONTINUES. The test client will answer Blue shortly. Use that answer when it arrives and finish with PROBE_ASYNC_ANSWER_Blue. If the asynchronous input tool is unavailable, finish with PROBE_ASYNC_UNAVAILABLE and do not substitute another input tool."
    }, progress => {
      const event = progress.event;
      if (event) {
        eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
        if (eventCounts[event.type] === 1) stage(`event-${event.type}`);
      }
      if (event?.type === "agent-message") {
        progressText.push(event.summary);
        observedProgress ||= progressText.join("").includes("PROBE_ASYNC_CONTINUES");
        if (observedProgress) answer();
      }
      const interaction = event?.details?.interaction as CodexPendingInteraction | undefined;
      if (!interaction || pending) return;
      pending = interaction;
      report.questionObserved = true;
      report.nonblocking = interaction.isBlocking === false;
      report.questionIds = interaction.questions?.map(question => question.id);
      report.expiresAtPresent = interaction.expiresAt !== undefined;
      report.eventPhase = event?.phase;
      console.log(JSON.stringify({ stage: "question-observed", version: report.version, nonblocking: report.nonblocking }));
      if (observedProgress) answer();
      else fallbackAnswer = setTimeout(answer, 2_000);
    }, assignment => {
      if (assignment.threadId && !report.threadAssigned) {
        report.threadAssigned = true;
        stage("thread-assigned");
      }
    }).catch(error => { throw failure || error; });
    if (replyPromise) await replyPromise;
    const finalText = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
    report.turnStatus = result.structuredContent?.turnStatus;
    report.finalContainsAnswer = finalText.includes("PROBE_ASYNC_ANSWER_Blue");
    report.toolUnavailable = finalText.includes("PROBE_ASYNC_UNAVAILABLE");
    assert.equal(report.questionObserved, true, "The CLI did not emit a structured input request.");
    assert.equal(report.nonblocking, true, "The observed question was blocking.");
    assert.equal(report.answerSent, true, "No programmatic answer was sent before the turn ended.");
    assert.equal(report.finalContainsAnswer, true, "The final answer did not confirm the synthetic selection.");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Synthetic probe failed";
    process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (fallbackAnswer) clearTimeout(fallbackAnswer);
    try { await pool?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    report.elapsedMs = Date.now() - started;
    report.stages = stages;
    report.eventCounts = eventCounts;
    report.temporaryHomeRemoved = true;
  }
  console.log(JSON.stringify({ stage: "finished", ...report }));
}
await mkdir("output/question-feasibility", { recursive: true });
await writeFile("output/question-feasibility/live-cli.json", JSON.stringify({
  observedAt: new Date().toISOString(),
  scope: "Actual authenticated Codex CLI/model with a synthetic programmatic answer; no parent GPT or ChatGPT card execution.",
  reports
}, null, 2) + "\n");
