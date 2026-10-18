import { randomUUID, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { RELAY_CARD_HTML } from "../src/relayCard.js";
import { relayPresentationRef } from "../src/relayDelivery.js";
import { registerRelayTools } from "../src/relayTools.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { BridgeStateStore } from "../src/stateStore.js";

// Execute the shipped script against real durable relay handlers. Host replies
// and request-timeout callbacks are controlled explicitly for ordering/failure
// fixtures; this is not a clock, elapsed-duration or continuous-operation test.
const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
function fixture(input = false) {
  const state = new BridgeStateStore({ file: ":memory:" }); resources.push(() => state.close());
  const scopes = new ScopeResolver({ stateStore: state });
  const metadata = { "openai/session": "relay-card-owner" }, scopeId = scopes.resolve(metadata)!.scopeId;
  const activity = state.createActivity({ scopeId, handoffPolicy: "none", completionTrigger: "manual" });
  const agent = state.createAgent({ scopeId, agentName: "Worker" });
  const job = { jobId: randomUUID(), requestId: randomUUID(), scopeId, activityId: activity.activityId, agentId: agent.agentId,
    cwd: "/private/project/path", sandbox: "read-only", completionDeliveryPolicy: "relay-card" as const,
    status: "running", version: 1, createdAt: Date.now(), updatedAt: Date.now(),
    ...(input ? { trackingState: "connected", pendingInteractions: [{ interactionId: "original-question" }] } : {}) };
  state.upsertJob(job);
  if (!input) state.upsertJob({ ...job, status: "completed", version: 2, result: { content: [{ type: "text", text: "PRIVATE ORIGINAL SECRET" }] } });
  const opening = { contractGeneration: 1, jobId: job.jobId, activityId: job.activityId,
    inputRequestId: job.requestId, presentationRef: relayPresentationRef(job.requestId) };
  const handlers = new Map<string, any>();
  registerRelayTools({ registerTool(name: string, _descriptor: any, callback: any) { handlers.set(name, callback); } } as unknown as McpServer, state, scopes);
  return { state, job, opening, handlers, metadata, event: () => state.relay.registration(job.jobId)!.event! };
}
type Fixture = ReturnType<typeof fixture>;
type Message = { id?: number; method?: string; params?: any; result?: unknown; error?: unknown; jsonrpc?: string };
type HostOptions = {
  compatibility?: boolean; initialGlobals?: Record<string, unknown>; deferredInitialize?: boolean;
  initializeError?: boolean; messageCapability?: boolean; ackResponseLoss?: boolean;
  toolResponse?: (name: string, args: any) => "hold" | { error: any } | { result: any } | undefined;
  send?: (message: Message) => "hold" | { error: any } | { result: any };
};
function mount(f: Fixture, options: HostOptions = {}) {
  const listeners = new Map<string, Array<(event: any) => void>>(), messages: Message[] = [], calls: any[] = [], compatibilitySends: any[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 1, lostAck = false;
  const document = { visibilityState: "hidden", documentElement: { dataset: {} as Record<string, string> } };
  const emit = (type: string, value: any) => { for (const listener of listeners.get(type) || []) listener(value); };
  const receive = (message: Message, source: unknown = parent) => emit("message", { source, data: { jsonrpc: "2.0", ...message } });
  const reply = (message: Message, result: unknown) => receive({ id: message.id, result });
  const tool = async (name: string, args: any) => {
    calls.push({ name, arguments: structuredClone(args) });
    const response = options.toolResponse?.(name, args);
    if (response === "hold") return new Promise(() => {});
    if (response && "error" in response) throw response.error;
    if (response && "result" in response) return response.result;
    return f.handlers.get(name)({ ...args, ...(name === "codex_relay_wait" ? { waitMs: 0 } : {}) }, { mcpReq: { _meta: f.metadata } });
  };
  const parent = { postMessage(message: Message) {
    messages.push(structuredClone(message));
    if (message.id === undefined) return;
    if (message.method === "ui/initialize") {
      expect(listeners.get("message")?.length).toBeGreaterThan(0);
      if (!options.deferredInitialize) queueMicrotask(() => initializeReply(message));
    } else if (message.method === "tools/call") {
      void tool(message.params.name, message.params.arguments).then(result => {
        if (options.ackResponseLoss && !lostAck && message.params.arguments.action === "ack") {
          lostAck = true;
        } else reply(message, result);
      }, error => receive({ id: message.id, error: typeof error?.code === "number" ? error : { code: -32000 } }));
    } else if (message.method === "ui/message") {
      const response = options.send?.(message) || { result: {} };
      if (response !== "hold") queueMicrotask(() => receive({ id: message.id, ...response }));
    }
  } };
  function initializeReply(message = messages.find(value => value.method === "ui/initialize")!) {
    receive(options.initializeError ? { id: message.id, error: { code: -32601 } } :
      { id: message.id, result: { protocolVersion: "2026-01-26", hostCapabilities: { message: options.messageCapability ?? true } } });
  }
  const window = { parent, addEventListener(type: string, listener: (event: any) => void) {
    listeners.set(type, [...(listeners.get(type) || []), listener]);
  }, openai: { ...options.initialGlobals,
    ...(options.compatibility ? { callTool: tool, sendFollowUpMessage: async (value: any) => { compatibilitySends.push(value); return {}; } } : {}) } };
  const context = createContext({ window, document, crypto: webcrypto, TextEncoder, Uint8Array,
    setTimeout(callback: () => void, delay: number) { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); } });
  const script = RELAY_CARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInContext(script, context);
  const run = (code: string) => runInContext(code, context);
  const drain = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
  const until = async (condition: () => boolean) => {
    for (let turn = 0; turn < 30 && !condition(); turn++) await drain();
    expect(condition(), "expected protocol barrier").toBe(true);
  };
  const input = (value: unknown = { requestId: f.job.requestId }) => receive({ method: "ui/notifications/tool-input", params: { arguments: value } });
  const result = (value: unknown = f.opening) => receive({ method: "ui/notifications/tool-result", params: { _meta: { "codex/relayOpen@1": value } } });
  const globals = (value: unknown) => emit("openai:set_globals", { detail: { globals: value } });
  const link = async () => { input(); result(); await run("correlate()"); await until(() => document.documentElement.dataset.relay === "linked"); };
  const fire = (delay: number) => { const entry = [...timers].find(([, timer]) => timer.delay === delay); expect(entry).toBeDefined(); timers.delete(entry![0]); entry![1].callback(); };
  const teardown = () => receive({ id: 99_999, method: "ui/resource-teardown" }); resources.push(teardown);
  return { run, until, drain, input, result, globals, link, fire, teardown, initializeReply, document, timers, messages, calls, compatibilitySends, receive, emit,
    watch: () => run("watch()") as Promise<void>, sends: () => messages.filter(value => value.method === "ui/message") };
}

describe("#261 blank relay host protocol", () => {
  it("ships a blank body with no Dashboard runtime, close request or visibility gate", () => {
    expect(RELAY_CARD_HTML).toMatch(/<body><script>/);
    expect(RELAY_CARD_HTML).toContain("height:0;min-height:0;max-height:0");
    for (const forbidden of ["visibilityState", "requestClose", "codex_dashboard", "codex_ui_completion", "completionCanRun", "<button", "<main"]) expect(RELAY_CARD_HTML).not.toContain(forbidden);
  });

  it("installs receivers before handshake and handles result-first, null and mismatch without losing the valid connection", async () => {
    const f = fixture(), h = mount(f, { deferredInitialize: true, initialGlobals: { toolInput: null, toolResponseMetadata: null } });
    h.result(); h.input({ requestId: randomUUID() }); await h.run("correlate()");
    expect(h.document.documentElement.dataset.relay).toBeUndefined();
    h.input(); await h.run("correlate()"); await h.until(() => h.document.documentElement.dataset.relay === "linked");
    h.globals({ toolInput: null, toolResponseMetadata: null }); h.result({ ...f.opening, jobId: randomUUID() });
    h.initializeReply(); await h.watch();
    expect(h.sends()).toHaveLength(1); expect(f.event().state).toBe("accepted");
    expect(h.calls.find(call => call.arguments.action === "connect").arguments.activityId).toBe(f.job.activityId);
  });

  it("connects late compatibility globals and sends while the document is backgrounded", async () => {
    const f = fixture(), h = mount(f, { compatibility: true, initializeError: true });
    h.globals({ toolResponseMetadata: { "codex/relayOpen@1": f.opening } });
    h.globals({ toolInput: { requestId: f.job.requestId } }); await h.run("correlate()");
    await h.until(() => h.document.documentElement.dataset.relay === "linked"); await h.watch();
    expect(h.document.visibilityState).toBe("hidden"); expect(h.sends()).toHaveLength(0); expect(h.compatibilitySends).toHaveLength(1);
    expect(h.compatibilitySends[0].scrollToBottom).toBe(false); expect(f.event().state).toBe("accepted");
  });

  it("suppresses overlapping watch calls and two-card replay, and relays references without source text or paths", async () => {
    const f = fixture(), h = mount(f, { compatibility: true }); await h.link();
    await Promise.all([h.watch(), h.watch(), h.watch()]);
    expect(h.sends()).toHaveLength(1); expect(h.compatibilitySends).toHaveLength(0);
    const text = h.sends()[0]!.params.content[0].text;
    expect(text).toContain(f.event().eventId); expect(text).toContain(f.job.jobId); expect(text).toContain("codex_status");
    expect(JSON.parse(text.split("\n").at(-1)!)).toMatchObject({ eventId: f.event().eventId, result: { tool: "codex_status" } });
    for (const secret of ["PRIVATE ORIGINAL SECRET", "/private/project/path", f.job.scopeId]) expect(text).not.toContain(secret);
    const replacement = mount(f); await replacement.link(); await replacement.watch(); await h.watch();
    expect(replacement.sends()).toHaveLength(0); expect(h.sends()).toHaveLength(1);
    expect(f.state.getActivity(f.job.activityId)?.lifecycle).toBe("open");
  });

  it("retries an ACK response loss with the same attempt and no extra host send", async () => {
    const f = fixture(), h = mount(f, { ackResponseLoss: true }); await h.link();
    const watching = h.watch();
    await h.until(() => h.calls.filter(call => call.arguments.action === "ack").length === 1);
    expect(f.event().state).toBe("accepted"); h.fire(35000);
    await h.until(() => [...h.timers.values()].some(timer => timer.delay === 1000)); h.fire(1000); await watching;
    const acknowledgements = h.calls.filter(call => call.arguments.action === "ack");
    expect(acknowledgements).toHaveLength(2); expect(acknowledgements[0]).toEqual(acknowledgements[1]); expect(h.sends()).toHaveLength(1);
    await h.watch(); expect(h.sends()).toHaveLength(1);
  });

  it.each(["connect", "claim", "enter", "ack", "wait"])("stops the mounted relay after permanent %s rejection", async action => {
    const f = fixture(), h = mount(f, { toolResponse: (name, args) =>
      (action === "wait" ? name === "codex_relay_wait" : args.action === action)
        ? { error: { code: -32001, message: "timeout retry temporary", data: { retryable: false } } } : undefined });
    await h.link();
    const watching = h.watch();
    await h.until(() => h.document.documentElement.dataset.relay === "blocked"); await watching;
    const before = h.calls.length;
    expect(h.calls.filter(call => action === "wait" ? call.name === "codex_relay_wait" : call.arguments.action === action)).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.globals({}); h.emit("online", {}); h.emit("pageshow", {});
    await h.watch(); await h.drain();
    expect(h.calls).toHaveLength(before);
    expect(h.sends()).toHaveLength(action === "ack" ? 1 : 0);
    expect(f.state.getActivity(f.job.activityId)?.lifecycle).toBe("open");
    expect(f.state.getRelayJobSnapshot(f.job.jobId)?.status).toBe("completed");
  });

  it.each([false, true])("stops on tool error results with compatibility=%s", async compatibility => {
    const f = fixture(), h = mount(f, { compatibility, initializeError: compatibility,
      toolResponse: () => ({ result: { isError: true, content: [{ type: "text", text: "Approval declined; retry later" }] } }) });
    await h.link(); const watching = h.watch();
    await h.until(() => h.document.documentElement.dataset.relay === "blocked"); await watching;
    expect(h.calls).toHaveLength(1); expect(h.timers.size).toBe(0);
    await h.watch(); expect(h.calls).toHaveLength(1);
    expect(h.sends()).toHaveLength(0); expect(h.compatibilitySends).toHaveLength(0);
  });

  it.each([new Error("Approval declined"), "timeout retry temporary", { code: -32001, data: { retryable: false } }])(
    "does not retry an unclassified compatibility rejection: %s", async error => {
      const f = fixture(), h = mount(f, { compatibility: true, initializeError: true, toolResponse: () => ({ error }) });
      await h.link(); const watching = h.watch();
      await h.until(() => h.document.documentElement.dataset.relay === "blocked"); await watching;
      expect(h.calls).toHaveLength(1); expect(h.timers.size).toBe(0);
      await h.watch(); expect(h.calls).toHaveLength(1);
    });

  it.each([false, true])("recovers explicitly retryable tool rejections with compatibility=%s", async compatibility => {
    let rejected = false;
    const f = fixture(), h = mount(f, { compatibility, initializeError: compatibility, toolResponse: (_name, args) => {
      if (args.action !== "connect" || rejected) return;
      rejected = true;
      return { error: { code: -32000, data: { delivery: "not-sent", retryable: true } } };
    } });
    await h.link(); const watching = h.watch();
    await h.until(() => [...h.timers.values()].some(timer => timer.delay === 1000)); h.fire(1000); await watching;
    expect(h.calls.filter(call => call.arguments.action === "connect")).toHaveLength(2);
    expect(h.document.documentElement.dataset.relay).toBe("waiting");
    expect(f.event().state).toBe("accepted");
    expect(h.sends().length + h.compatibilitySends.length).toBe(1);
  });

  it.each([false, true])("recovers a tool response timeout with compatibility=%s", async compatibility => {
    let held = false;
    const f = fixture(), h = mount(f, { compatibility, initializeError: compatibility, toolResponse: (_name, args) => {
      if (args.action !== "connect" || held) return;
      held = true; return "hold";
    } });
    await h.link(); const watching = h.watch();
    await h.until(() => h.calls.length === 1); h.fire(35000);
    await h.until(() => [...h.timers.values()].some(timer => timer.delay === 1000)); h.fire(1000); await watching;
    expect(h.calls.filter(call => call.arguments.action === "connect")).toHaveLength(2);
    expect(h.document.documentElement.dataset.relay).toBe("waiting");
    expect(f.event().state).toBe("accepted");
    expect(h.sends().length + h.compatibilitySends.length).toBe(1);
  });

  it.each([false, true])("recovers a real input-owner pause during claim with compatibility=%s", async compatibility => {
    let paused = false;
    const f = fixture(true), h = mount(f, { compatibility, initializeError: compatibility, toolResponse: (_name, args) => {
      if (args.action !== "claim" || paused) return;
      paused = true; f.state.upsertJob({ ...f.job, version: 2, trackingState: "liveness-unknown" });
    } });
    await h.link(); const watching = h.watch();
    await h.until(() => [...h.timers.values()].some(timer => timer.delay === 1000));
    expect(f.event().state).toBe("pending");
    f.state.upsertJob({ ...f.job, version: 3, trackingState: "connected" }); h.fire(1000); await watching;
    const claims = h.calls.filter(call => call.arguments.action === "claim");
    expect(claims).toHaveLength(2); expect(claims[0]).toEqual(claims[1]);
    expect(h.document.documentElement.dataset.relay).toBe("waiting");
    expect(f.event().state).toBe("accepted"); expect(h.sends().length + h.compatibilitySends.length).toBe(1);
  });

  it("resumes after a pagehide cancellation without treating detachment as a rejection", async () => {
    let held = false;
    const f = fixture(), h = mount(f, { toolResponse: (_name, args) => {
      if (args.action !== "connect" || held) return;
      held = true; return "hold";
    } });
    await h.link(); const watching = h.watch();
    await h.until(() => h.calls.length === 1); h.emit("pagehide", {}); await watching;
    expect(h.timers.size).toBe(0);
    h.emit("pageshow", {}); await h.watch();
    expect(h.document.documentElement.dataset.relay).toBe("waiting");
    expect(f.event().state).toBe("accepted"); expect(h.sends()).toHaveLength(1);
  });

  it("waits for an unavailable host bridge and connects when it becomes ready", async () => {
    const options = { initializeError: true }, f = fixture(), h = mount(f, options);
    await h.link(); await h.watch();
    expect(h.document.documentElement.dataset.relay).toBe("recovering"); expect(h.calls).toHaveLength(0);
    options.initializeError = false; await h.watch();
    expect(h.document.documentElement.dataset.relay).toBe("waiting");
    expect(f.event().state).toBe("accepted"); expect(h.sends()).toHaveLength(1);
  });

  it("keeps post-send timeout unknown and never switches to compatibility sending", async () => {
    const f = fixture(), h = mount(f, { compatibility: true, send: () => "hold" }); await h.link();
    const watching = h.watch(); await h.until(() => h.sends().length === 1); h.fire(12000); await watching;
    expect(f.event().state).toBe("unknown"); expect(h.compatibilitySends).toHaveLength(0);
    const replacement = mount(f); await replacement.link(); await replacement.watch(); expect(replacement.sends()).toHaveLength(0);
  });

  it("preserves the entered attempt after teardown, even when the host reply arrives late", async () => {
    const f = fixture(), h = mount(f, { send: () => "hold" }); await h.link();
    const watching = h.watch(); await h.until(() => h.sends().length === 1); const sent = h.sends()[0]!;
    h.teardown(); await watching; h.receive({ id: sent.id, result: {} });
    expect(f.event().state).toBe("sending"); expect(h.timers.size).toBe(0);
    const replacement = mount(f); await replacement.link(); await replacement.watch(); expect(replacement.sends()).toHaveLength(0);
  });

  it("treats an actual permanent RPC rejection as terminal, without inferring retryability from its message", async () => {
    const f = fixture(), h = mount(f, { compatibility: true, send: () => ({ error: { code: -32001, message: "timeout retry temporary" } }) });
    await h.link(); await h.watch(); expect(f.event().state).toBe("rejected"); await h.watch();
    expect(h.sends()).toHaveLength(1); expect(h.compatibilitySends).toHaveLength(0);
  });
});
