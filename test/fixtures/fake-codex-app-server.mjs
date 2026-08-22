#!/usr/bin/env node
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const activeTurns = new Map();
const pendingServerRequests = new Map();
let initialized = false;
let threadSequence = 0;
let turnSequence = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sendBatch = (messages) => process.stdout.write(`${messages.map(JSON.stringify).join("\n")}\n`);
const response = (id, result) => send({ id, result });
const notification = (method, params = {}) => send({ method, params });
const serverRequest = (id, method, params, accept) => {
  pendingServerRequests.set(String(id), accept);
  send({ id, method, params });
};

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== undefined) process.exit(71);

  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities || {};
    const optedOut = new Set(capabilities.optOutNotificationMethods || []);
    const required = [
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta",
      "rawResponseItem/completed",
      "rawResponse/completed"
    ];
    if (!required.every((method) => optedOut.has(method)) || capabilities.requestAttestation !== false) {
      send({ id: message.id, error: { code: -32602, message: "missing safe initialization capabilities" } });
      return;
    }
    initialized = true;
    response(message.id, { userAgent: "fake", platformFamily: "unix", platformOs: "test" });
    return;
  }
  if (message.method === "initialized") return;
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
    return;
  }

  if (message.method === "thread/start") {
    if (message.params.experimentalRawEvents !== false) {
      send({ id: message.id, error: { code: -32602, message: "raw events must be disabled" } });
      return;
    }
    const id = `fake-thread-${++threadSequence}`;
    response(message.id, { thread: { id } });
    return;
  }
  if (message.method === "thread/resume") {
    response(message.id, { thread: { id: message.params.threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `fake-turn-${++turnSequence}`;
    const prompt = message.params.input?.[0]?.text || "";
    const context = { threadId: message.params.threadId, turnId, prompt };
    activeTurns.set(turnId, context);
    const startResult = {
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
    };
    if (prompt.includes("batched completion")) {
      activeTurns.delete(turnId);
      sendBatch([
        { id: message.id, result: startResult },
        { method: "turn/started", params: { threadId: context.threadId, turn: { id: turnId } } },
        {
          method: "item/completed",
          params: {
            threadId: context.threadId,
            turnId,
            item: {
              type: "agentMessage",
              id: "agent-batched",
              text: "BATCHED COMPLETE",
              phase: "final_answer",
              memoryCitation: null
            }
          }
        },
        {
          method: "turn/completed",
          params: {
            threadId: context.threadId,
            turn: {
              id: turnId,
              items: [{
                type: "agentMessage",
                id: "agent-batched",
                text: "BATCHED COMPLETE",
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
          }
        }
      ]);
      return;
    }
    response(message.id, startResult);
    queueMicrotask(() => beginTurn(context));
    return;
  }
  if (message.method === "turn/steer") {
    const context = activeTurns.get(message.params.expectedTurnId);
    if (!context || context.threadId !== message.params.threadId) {
      send({ id: message.id, error: { code: -32000, message: "turn precondition failed" } });
      return;
    }
    response(message.id, { turnId: context.turnId });
    finishTurn(context, "completed", `STEERED:${message.params.input?.[0]?.text || ""}`);
    return;
  }
  if (message.method === "turn/interrupt") {
    const context = activeTurns.get(message.params.turnId);
    response(message.id, {});
    if (context) finishTurn(context, "interrupted", "INTERRUPTED");
    return;
  }

  if (message.id !== undefined && message.method === undefined) {
    const accept = pendingServerRequests.get(String(message.id));
    if (accept) {
      pendingServerRequests.delete(String(message.id));
      accept(message.result);
    }
  }
});

function beginTurn(context) {
  const { threadId, turnId, prompt } = context;
  notification("turn/started", { threadId, turn: { id: turnId } });
  notification("item/reasoning/textDelta", {
    threadId,
    turnId,
    itemId: "reasoning-1",
    delta: "PRIVATE_REASONING_MUST_NEVER_APPEAR"
  });
  notification("turn/plan/updated", {
    threadId,
    turnId,
    plan: [{ step: "Public plan", status: "inProgress" }]
  });
  notification("item/started", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: "agent-1", text: "", phase: "commentary", memoryCitation: null }
  });
  notification("item/agentMessage/delta", { threadId, turnId, itemId: "agent-1", delta: "APP " });
  notification("item/agentMessage/delta", { threadId, turnId, itemId: "agent-1", delta: "SERVER" });

  if (prompt.includes("rich")) {
    notification("item/started", {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf ok",
        cwd: process.cwd(),
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    });
    notification("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: "command-1",
      delta: "output-tail\n"
    });
    notification("item/completed", {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf ok",
        cwd: process.cwd(),
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "output-tail\n",
        exitCode: 0,
        durationMs: 4
      }
    });
    notification("item/completed", {
      threadId,
      turnId,
      item: {
        type: "fileChange",
        id: "file-1",
        changes: [{ path: `${process.cwd()}/changed.ts`, kind: "update" }],
        status: "completed"
      }
    });
  }

  if (prompt.includes("interactions")) {
    requestCommand(context);
    return;
  }
  if (prompt.includes("hold")) return;
  finishTurn(context, "completed", "APP SERVER");
}

function requestCommand(context) {
  serverRequest(
    "request-command-17",
    "item/commandExecution/requestApproval",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: "command-approval-1",
      startedAtMs: Date.now(),
      environmentId: null,
      command: "echo approved",
      cwd: process.cwd()
    },
    (result) => {
      if (result?.decision !== "accept") process.exit(72);
      serverRequest(
        902,
        "item/fileChange/requestApproval",
        {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: "file-approval-1",
          startedAtMs: Date.now(),
          reason: "write fixture"
        },
        (fileResult) => {
          if (fileResult?.decision !== "decline") process.exit(73);
          requestInput(context);
        }
      );
    }
  );
}

function requestInput(context) {
  serverRequest(
    "request-input-33",
    "item/tool/requestUserInput",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: "input-1",
      autoResolutionMs: null,
      questions: [{
        id: "color",
        header: "Color",
        question: "Choose a color",
        isOther: false,
        isSecret: false,
        options: [{ label: "blue", description: "Blue" }]
      }]
    },
    (result) => {
      if (result?.answers?.color?.answers?.[0] !== "blue") process.exit(74);
      requestPermission(context);
    }
  );
}

function requestPermission(context) {
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: [process.cwd()], write: [process.cwd()] }
  };
  serverRequest(
    "request-permission-44",
    "item/permissions/requestApproval",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: "permission-1",
      environmentId: null,
      startedAtMs: Date.now(),
      cwd: process.cwd(),
      reason: "Need fixture access",
      permissions
    },
    (result) => {
      if (result?.scope !== "turn" || result?.permissions?.network?.enabled !== true) process.exit(75);
      finishTurn(context, "completed", "INTERACTIONS COMPLETE");
    }
  );
}

function finishTurn(context, status, text) {
  if (!activeTurns.delete(context.turnId)) return;
  notification("item/completed", {
    threadId: context.threadId,
    turnId: context.turnId,
    item: { type: "agentMessage", id: "agent-1", text, phase: "final_answer", memoryCitation: null }
  });
  notification("turn/completed", {
    threadId: context.threadId,
    turn: {
      id: context.turnId,
      items: [{ type: "agentMessage", id: "agent-1", text, phase: "final_answer", memoryCitation: null }],
      itemsView: "full",
      status,
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1
    }
  });
}
