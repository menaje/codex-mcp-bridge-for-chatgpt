#!/usr/bin/env node
import { readFileSync } from "node:fs";
import readline from "node:readline";

const manifest = JSON.parse(readFileSync(new URL("../../release-manifest.json", import.meta.url), "utf8"));

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${manifest.toolchain.codexCli}\n`);
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
const activeTurns = new Map();
const pendingServerRequests = new Map();
const archivedThreads = new Set();
const knownThreads = new Set();
const threadLineages = new Map();
const loadedThreads = new Set();
const systemErrorThreads = new Set();
const backgroundTerminals = new Map();
const interruptedTurnCounts = new Map();
let initialized = false;
let threadSequence = 0;
let turnSequence = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sendBatch = (messages) => process.stdout.write(`${messages.map(JSON.stringify).join("\n")}\n`);
const response = (id, result) => send({ id, result });
const notification = (method, params = {}) => send({ method, params });
const serverRequest = (id, method, params, accept) => {
  pendingServerRequests.set(String(id), { requestId: id, threadId: params.threadId, accept });
  send({ id, method, params });
};

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== undefined) process.exit(71);

  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities || {};
    const clientInfo = message.params?.clientInfo || {};
    const optedOut = new Set(capabilities.optOutNotificationMethods || []);
    const required = [
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta",
      "rawResponseItem/completed",
      "rawResponse/completed"
    ];
    if (
      !required.every((method) => optedOut.has(method)) ||
      capabilities.requestAttestation !== false ||
      clientInfo.name !== manifest.product.runtimeName ||
      clientInfo.title !== manifest.product.displayName ||
      clientInfo.version !== manifest.release.version
    ) {
      send({ id: message.id, error: { code: -32602, message: "missing safe initialization capabilities" } });
      return;
    }
    initialized = true;
    response(message.id, { userAgent: "fake", platformFamily: "unix", platformOs: "test" });
    return;
  }
  if (message.method === "initialized") {
    notification("mcpServer/startupStatus/updated", {
      threadId: null,
      name: "fixture-server",
      status: "ready",
      error: null,
      failureReason: null
    });
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
    return;
  }

  if (message.method === "model/list") {
    response(message.id, {
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Fixture default",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "max" }
          ],
          hidden: false,
          isDefault: true,
          defaultServiceTier: "priority",
          serviceTiers: [{ id: "priority", name: "Priority" }],
          inputModalities: ["text", "image"]
        },
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Fixture continuation model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" }
          ],
          hidden: false,
          isDefault: false,
          defaultServiceTier: null,
          serviceTiers: [],
          inputModalities: ["text"]
        }
      ],
      nextCursor: null
    });
    return;
  }

  if (message.method === "thread/start") {
    if (message.params.experimentalRawEvents !== false) {
      send({ id: message.id, error: { code: -32602, message: "raw events must be disabled" } });
      return;
    }
    const id = `fake-thread-${++threadSequence}`;
    knownThreads.add(id);
    threadLineages.set(id, { sessionId: `fake-session-${threadSequence}`, forkedFromId: null });
    loadedThreads.add(id);
    response(message.id, { thread: { id, ...threadLineages.get(id) } });
    return;
  }
  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    if (!knownThreads.has(threadId) || archivedThreads.has(threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    loadedThreads.add(threadId);
    response(message.id, { thread: { id: threadId, ...threadLineages.get(threadId) } });
    return;
  }
  if (message.method === "thread/read") {
    const threadId = message.params.threadId;
    if (!knownThreads.has(threadId) || archivedThreads.has(threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    const active = [...activeTurns.values()].some((turn) => turn.threadId === threadId);
    const status = systemErrorThreads.has(threadId)
      ? { type: "systemError" }
      : active
        ? { type: "active", activeFlags: [] }
        : loadedThreads.has(threadId)
          ? { type: "idle" }
          : { type: "notLoaded" };
    response(message.id, {
      thread: {
        id: threadId,
        ...threadLineages.get(threadId),
        status,
        turns: []
      }
    });
    return;
  }
  if (message.method === "thread/fork") {
    const id = `fake-thread-${++threadSequence}`;
    knownThreads.add(id);
    threadLineages.set(id, {
      sessionId: threadLineages.get(message.params.threadId)?.sessionId || `fake-session-${threadSequence}`,
      forkedFromId: message.params.threadId
    });
    loadedThreads.add(id);
    response(message.id, { thread: { id, ...threadLineages.get(id) } });
    return;
  }
  if (message.method === "thread/archive") {
    const threadId = message.params.threadId;
    if (!knownThreads.has(threadId) || archivedThreads.has(threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    archivedThreads.add(threadId);
    loadedThreads.delete(threadId);
    response(message.id, {});
    return;
  }
  if (message.method === "thread/unarchive") {
    const threadId = message.params.threadId;
    if (!archivedThreads.has(threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    archivedThreads.delete(threadId);
    response(message.id, { thread: { id: threadId } });
    return;
  }
  if (message.method === "thread/backgroundTerminals/list") {
    if (!loadedThreads.has(message.params.threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    response(message.id, {
      data: backgroundTerminals.get(message.params.threadId) || [],
      nextCursor: null
    });
    return;
  }
  if (message.method === "thread/backgroundTerminals/terminate") {
    if (!loadedThreads.has(message.params.threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    const terminals = backgroundTerminals.get(message.params.threadId) || [];
    const remaining = terminals.filter((terminal) => terminal.processId !== message.params.processId);
    const terminated = remaining.length !== terminals.length;
    backgroundTerminals.set(message.params.threadId, remaining);
    response(message.id, { terminated });
    return;
  }
  if (message.method === "turn/start") {
    if (!loadedThreads.has(message.params.threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    const turnId = `fake-turn-${++turnSequence}`;
    const prompt = message.params.input?.[0]?.text || "";
    const context = {
      threadId: message.params.threadId,
      turnId,
      prompt,
      selection: {
        model: message.params.model,
        effort: message.params.effort,
        serviceTier: message.params.serviceTier
      }
    };
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
    if (context) {
      interruptedTurnCounts.set(context.threadId, (interruptedTurnCounts.get(context.threadId) || 0) + 1);
      if (context.prompt.includes("delayed interrupt")) {
        setTimeout(() => finishTurn(context, "interrupted", "INTERRUPTED"), 150);
      } else {
        finishTurn(context, "interrupted", "INTERRUPTED");
      }
    }
    return;
  }

  if (message.id !== undefined && message.method === undefined) {
    const pending = pendingServerRequests.get(String(message.id));
    if (pending) {
      pendingServerRequests.delete(String(message.id));
      notification("serverRequest/resolved", {
        threadId: pending.threadId,
        requestId: pending.requestId
      });
      pending.accept(message.result);
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
    notification("warning", {
      threadId,
      message: "Fixture warning"
    });
    notification("configWarning", {
      summary: "Fixture config warning",
      details: "Review the fixture configuration",
      path: `${process.cwd()}/config.toml`
    });
    notification("model/rerouted", {
      threadId,
      turnId,
      fromModel: "gpt-fixture-a",
      toModel: "gpt-fixture-b",
      reason: "highRiskCyberActivity"
    });
    notification("model/verification", {
      threadId,
      turnId,
      verifications: ["trustedAccessForCyber"]
    });
    notification("model/safetyBuffering/updated", {
      threadId,
      turnId,
      model: "gpt-fixture-b",
      useCases: ["fixture"],
      reasons: ["fixture safety"],
      showBufferingUi: true,
      fasterModel: "gpt-fixture-fast"
    });
    notification("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        total: {
          totalTokens: 12,
          inputTokens: 7,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 1
        },
        last: {
          totalTokens: 4,
          inputTokens: 2,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 1
        },
        modelContextWindow: 128000
      }
    });
    notification("thread/compacted", { threadId, turnId });
    notification("item/mcpToolCall/progress", {
      threadId,
      turnId,
      itemId: "mcp-1",
      message: "Fixture MCP progress"
    });
    notification("item/completed", {
      threadId,
      turnId,
      item: {
        type: "mcpToolCall",
        id: "mcp-1",
        server: "fixture-server",
        tool: "fixture-tool",
        status: "completed",
        arguments: { prompt: "PRIVATE_MCP_ARGUMENT_MUST_NEVER_APPEAR" },
        appContext: null,
        pluginId: null,
        result: { content: ["PRIVATE_MCP_RESULT_MUST_NEVER_APPEAR"], structuredContent: null, _meta: null },
        error: null,
        durationMs: 3
      }
    });
    notification("item/completed", {
      threadId,
      turnId,
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: threadId,
        receiverThreadIds: ["fixture-subagent-thread"],
        prompt: "PRIVATE_COLLAB_PROMPT_MUST_NEVER_APPEAR",
        model: "gpt-fixture-b",
        reasoningEffort: "high",
        agentsStates: {}
      }
    });
  }

  if (prompt.includes("interactions")) {
    requestCommand(context);
    return;
  }
  if (prompt.includes("auto resolve input")) {
    requestAutoResolvedInput(context);
    return;
  }
  if (prompt.includes("expire input locally")) {
    requestLocallyExpiredInput(context);
    return;
  }
  if (prompt.includes("leave background terminal")) {
    backgroundTerminals.set(threadId, [{
      processId: "background-process-1",
      itemId: "background-item-1",
      command: "fixture background command",
      cwd: process.cwd(),
      osPid: 43210,
      cpuPercent: 1.5,
      rssKb: 2048
    }]);
  }
  if (prompt.includes("hold")) return;
  if (prompt.includes("report interrupt count")) {
    finishTurn(context, "completed", `INTERRUPTS:${interruptedTurnCounts.get(threadId) || 0}`);
    return;
  }
  if (prompt.includes("report selection")) {
    finishTurn(context, "completed", `SELECTION:${JSON.stringify(context.selection)}`);
    return;
  }
  if (prompt.includes("context window exceeded")) {
    finishTurn(context, "failed", "CONTEXT WINDOW EXCEEDED", {
      message: "Fixture context window exceeded.",
      codexErrorInfo: "contextWindowExceeded",
      additionalDetails: null
    });
    return;
  }
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
      reason: "Fixture network approval",
      networkApprovalContext: { host: "example.test", protocol: "https" },
      command: "echo approved",
      cwd: process.cwd(),
      commandActions: [{
        type: "read",
        command: "cat fixture.txt",
        name: "fixture.txt",
        path: `${process.cwd()}/fixture.txt`
      }],
      proposedExecpolicyAmendment: ["echo", "approved"],
      proposedNetworkPolicyAmendments: [{ host: "example.test", action: "allow" }],
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
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
          reason: "write fixture",
          grantRoot: process.cwd()
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
      if (result?.scope !== "session" || result?.permissions?.network?.enabled !== true) process.exit(75);
      finishTurn(context, "completed", "INTERACTIONS COMPLETE");
    }
  );
}

function requestAutoResolvedInput(context) {
  const requestId = "request-auto-input-55";
  serverRequest(
    requestId,
    "item/tool/requestUserInput",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: "auto-input-1",
      autoResolutionMs: 100,
      questions: [{
        id: "auto",
        header: "Automatic",
        question: "This request resolves automatically",
        isOther: false,
        isSecret: false,
        options: []
      }]
    },
    () => process.exit(76)
  );
  setTimeout(() => {
    pendingServerRequests.delete(String(requestId));
    notification("serverRequest/resolved", {
      threadId: context.threadId,
      requestId
    });
    finishTurn(context, "completed", "AUTO INPUT RESOLVED");
  }, 25);
}

function requestLocallyExpiredInput(context) {
  const requestId = "request-expiring-input-66";
  serverRequest(
    requestId,
    "item/tool/requestUserInput",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: "expiring-input-1",
      autoResolutionMs: 20,
      questions: [{
        id: "expiring",
        header: "Expiring",
        question: "This request expires locally",
        isOther: false,
        isSecret: false,
        options: []
      }]
    },
    () => process.exit(77)
  );
  setTimeout(() => {
    pendingServerRequests.delete(String(requestId));
    finishTurn(context, "completed", "LOCAL INPUT EXPIRED");
  }, 75);
}

function finishTurn(context, status, text, error = null) {
  if (!activeTurns.delete(context.turnId)) return;
  if (context.prompt.includes("mark thread system error")) {
    systemErrorThreads.add(context.threadId);
  }
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
      error,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1
    }
  });
}
