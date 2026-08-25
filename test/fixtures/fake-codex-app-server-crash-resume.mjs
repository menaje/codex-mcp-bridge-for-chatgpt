#!/usr/bin/env node
import { readFileSync } from "node:fs";
import readline from "node:readline";

const manifest = JSON.parse(
  readFileSync(new URL("../../release-manifest.json", import.meta.url), "utf8")
);

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${manifest.toolchain.codexCli}\n`);
  process.exit(0);
}

const THREAD_ID = "durable-crash-thread";
const SESSION_ID = "durable-crash-session";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const response = (id, result) => send({ id, result });
const notification = (method, params) => send({ method, params });
let initialized = false;
let turnSequence = 0;
let terminalPresent = true;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initialized = true;
    response(message.id, { userAgent: "crash-fixture", platformFamily: "unix", platformOs: "test" });
    return;
  }
  if (message.method === "initialized") {
    notification("mcpServer/startupStatus/updated", {
      threadId: null,
      name: "durable-fixture",
      status: "ready",
      error: null,
      failureReason: null
    });
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "not initialized" } });
    return;
  }
  if (message.method === "model/list") {
    response(message.id, { data: [], nextCursor: null });
    return;
  }
  if (message.method === "thread/start") {
    response(message.id, {
      thread: { id: THREAD_ID, sessionId: SESSION_ID, forkedFromId: null }
    });
    return;
  }
  if (message.method === "thread/resume") {
    response(message.id, {
      thread: { id: message.params.threadId, sessionId: SESSION_ID, forkedFromId: null }
    });
    return;
  }
  if (message.method === "thread/read") {
    response(message.id, {
      thread: {
        id: message.params.threadId,
        sessionId: SESSION_ID,
        forkedFromId: null,
        status: { type: "idle" },
        turns: []
      }
    });
    return;
  }
  if (message.method === "thread/backgroundTerminals/list") {
    response(message.id, {
      data: terminalPresent
        ? [{
            processId: "durable-background-1",
            itemId: "durable-item-1",
            command: "fixture daemon",
            cwd: process.cwd(),
            osPid: 43211,
            rssKb: 1024
          }]
        : [],
      nextCursor: null
    });
    return;
  }
  if (message.method === "thread/backgroundTerminals/terminate") {
    const terminated = terminalPresent && message.params.processId === "durable-background-1";
    terminalPresent = false;
    response(message.id, { terminated });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `durable-turn-${++turnSequence}`;
    const prompt = message.params.input?.[0]?.text || "";
    response(message.id, {
      turn: {
        id: turnId,
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null
      }
    });
    if (prompt.includes("crash worker")) {
      setTimeout(() => process.exit(86), 25);
      return;
    }
    setTimeout(() => {
      notification("turn/completed", {
        threadId: message.params.threadId,
        turn: {
          id: turnId,
          items: [{
            type: "agentMessage",
            id: `agent-${turnId}`,
            text: "RESUMED AFTER CRASH",
            phase: "final_answer",
            memoryCitation: null
          }],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1
        }
      });
    }, 5);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unsupported fixture method" } });
});
