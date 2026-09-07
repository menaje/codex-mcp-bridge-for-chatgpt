import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "../src/jsonRpcProcess.js";
import { threadAccessParams, turnAccessParams, verifyExecutionAccess } from "../src/executionAccess.js";

assert.equal(process.argv[2], "--run-authenticated");
const command = process.argv[3];
assert.ok(command && path.isAbsolute(command));
const replyToMessage = process.argv.includes("--reply-to-message");
const source = process.argv.find(argument => argument.startsWith("--source="))?.slice("--source=".length) || "app";
assert.match(source, /^[a-z][a-z0-9-]{0,30}$/);
const root = await mkdtemp(path.join(tmpdir(), "bridge-question-wire-"));
await chmod(root, 0o700);
const isolatedHome = path.join(root, "home"), project = path.join(root, "synthetic-project");
const notifications: Record<string, number> = {};
const requests: Array<Record<string, unknown>> = [];
const messages: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = { version: execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim(),
  model: "gpt-6-astra", source, requests, notifications, messages, adapterUsed: false, replyToMessage };
let rootThreadId: string | undefined, rootTurnId: string | undefined;
let steering: Promise<unknown> | undefined;
let resolveDone!: () => void;
const done = new Promise<void>(resolve => { resolveDone = resolve; });
const timers: NodeJS.Timeout[] = [];
const started = Date.now();
const rpc = new JsonRpcProcess({ command, args: ["app-server", "--listen", "stdio://"], cwd: project,
  omitJsonRpcHeader: true, debugLabel: "question-wire-probe",
  env: { ...process.env, CODEX_HOME: isolatedHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
  onRequest: async (method, raw) => {
    const params = raw as Record<string, any>;
    requests.push({ method, elapsedMs: Date.now() - started, keys: Object.keys(params), isBlocking: params.isBlocking,
      threadIdPresent: Boolean(params.threadId), turnIdPresent: Boolean(params.turnId), itemIdPresent: Boolean(params.itemId),
      questions: params.questions });
    console.log(JSON.stringify({ stage: "server-request", method, isBlocking: params.isBlocking, keys: Object.keys(params) }));
    if (method === "item/tool/requestUserInput" && params.questions?.length === 1 &&
        params.questions[0].options?.some((option: { label: string }) => option.label === "Blue")) {
      await new Promise(resolve => { timers.push(setTimeout(resolve, 350)); });
      report.answerReturned = true;
      return { answers: { [params.questions[0].id]: { answers: ["Blue"] } } };
    }
    if (method.endsWith("requestApproval")) return { decision: "cancel" };
    throw new Error("Unexpected synthetic probe request");
  },
  onNotification: (method, raw) => {
    notifications[method] = (notifications[method] || 0) + 1;
    const params = raw as Record<string, any>;
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const message = { phase: params.item.phase, text: String(params.item.text).slice(0, 2000), elapsedMs: Date.now() - started };
      messages.push(message); console.log(JSON.stringify({ stage: "agent-message", ...message }));
      if (replyToMessage && !steering && requests.length === 0 && rootThreadId && rootTurnId &&
          params.threadId === rootThreadId && params.turnId === rootTurnId &&
          /Which probe color/i.test(message.text) && message.text.includes("Blue") && message.text.includes("Red")) {
        report.replyMethod = "turn/steer";
        steering = rpc.request("turn/steer", { threadId: rootThreadId, expectedTurnId: rootTurnId,
          input: [{ type: "text", text: "For the probe color question, my answer is Blue. Finish with PROBE_ANSWER_Blue. Do not ask again.", text_elements: [] }]
        }, { timeoutMs: 10000 });
        void steering.then(() => { report.steerAccepted = true; }, error => {
          report.steerError = error instanceof Error ? error.message : "Steering failed"; resolveDone();
        });
      }
    }
    if (method === "error") messages.push({ type: "error", message: params.error?.message });
    if (method === "turn/completed") { report.turnStatus = params.turn?.status; resolveDone(); }
  }
});
try {
  await mkdir(isolatedHome, { mode: 0o700 }); await mkdir(project);
  await copyFile(path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json"), path.join(isolatedHome, "auth.json"));
  await chmod(path.join(isolatedHome, "auth.json"), 0o600);
  await writeFile(path.join(isolatedHome, "config.toml"), 'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n');
  await rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "question_wire_probe", title: "Question feasibility", version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false,
      optOutNotificationMethods: ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded"] }
  }, { timeoutMs: 15000 });
  await rpc.notify("initialized");
  const expected = { cwd: project, sandbox: "read-only" as const, approvalPolicy: "on-request" as const };
  const thread = await rpc.request<Record<string, any>>("thread/start", { ...threadAccessParams(expected), model: "gpt-6-astra",
    ephemeral: true, experimentalRawEvents: false }, { timeoutMs: 15000 });
  const access = verifyExecutionAccess(thread, expected, "thread/start");
  rootThreadId = thread.thread.id;
  const turn = await rpc.request<Record<string, any>>("turn/start", { threadId: rootThreadId, ...turnAccessParams(access), model: "gpt-6-astra", effort: "low",
    input: [{ type: "text", text: "Protocol probe only. Use request_user_input_async exactly once to ask 'Which probe color?' with options Blue and Red. Do no file, shell, browser, network, MCP or permission work. After submitting the question say PROBE_CONTINUES in commentary. The client will answer Blue. Finish with PROBE_ANSWER_Blue after receiving it. If request_user_input_async is unavailable, finish immediately with PROBE_UNAVAILABLE. Do not loop or wait indefinitely.", text_elements: [] }]
  }, { timeoutMs: 15000 });
  rootTurnId = turn.turn.id;
  timers.push(setTimeout(() => { report.timedOut = true; resolveDone(); }, 45_000));
  await done;
  if (steering) await steering;
  report.finalContainsAnswer = messages.some(message => String(message.text).includes("PROBE_ANSWER_Blue"));
} catch (error) {
  report.error = error instanceof Error ? error.message : "Wire probe failed";
} finally {
  for (const timer of timers) clearTimeout(timer);
  await rpc.close();
  try {
    const cache = JSON.parse(await readFile(path.join(isolatedHome, "models_cache.json"), "utf8"));
    report.modelToolFlags = (cache.models || []).filter((model: { slug: string }) => model.slug === "gpt-6-astra")
      .map((model: { slug: string; experimental_supported_tools: unknown }) => ({ slug: model.slug, tools: model.experimental_supported_tools }));
  } catch { report.modelToolFlags = "unavailable"; }
  await rm(root, { recursive: true, force: true });
  report.elapsedMs = Date.now() - started;
  report.temporaryHomeRemoved = true;
}
await mkdir("output/question-feasibility", { recursive: true });
await writeFile(`output/question-feasibility/cli-wire${replyToMessage ? "-steer" : ""}-${source}.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
