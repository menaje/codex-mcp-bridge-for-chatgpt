import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { McpEventsController } from "../src/mcpEvents.js";
import { JOB_LIFECYCLE_EVENT, JOB_TERMINAL_EVENT, lifecycleEvent, MAX_EVENT_SUBSCRIPTIONS } from "../src/mcpEventStore.js";
import { mcpOAuthPrincipal } from "../src/mcpOAuth.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexJobRegistry } from "../src/tools.js";
import type { WebhookSender } from "../src/mcpWebhook.js";
import { UserSettingsStore } from "../src/userSettings.js";

// Direct module integration uses the production schemas and handlers, a
// verified-auth context fixture, disposable state and explicit Promise barriers.
// Sender completion, not time passage, determines every race in these tests.
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.controller.close(); fixture.state.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function start(sender?: WebhookSender) {
  // Disable scheduling only in the fixture; tests drive the real delivery pass.
  vi.spyOn(McpEventsController.prototype, "wake").mockImplementation(() => {});
  const root = await mkdtemp(path.join(tmpdir(), "issue247-lifecycle-"));
  const state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
  const config = loadConfig({ CODEX_MCP_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
    CODEX_MCP_BRIDGE_EXPERIMENTAL_PROFILE: "events", CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1",
    CODEX_MCP_BRIDGE_ROOTS: root, CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_OAUTH_ISSUER: "https://id.fixture.example/tenant/",
    CODEX_MCP_BRIDGE_OAUTH_RESOURCE: "https://bridge.fixture.example/mcp",
    CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: "https://bridge.fixture.example/.well-known/oauth-protected-resource/mcp",
    CODEX_MCP_BRIDGE_OAUTH_JWKS_URI: "https://id.fixture.example/tenant/keys",
    CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT: "fixture-operator" });
  const scopes = new ScopeResolver({ stateStore: state });
  const metadata = { "openai/session": "issue247-lifecycle-origin" };
  const scopeId = scopes.resolve(metadata)!.scopeId;
  const principal = mcpOAuthPrincipal(config.oauth!);
  const settings = new UserSettingsStore(config, { stateStore: state });
  settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }],
    undefined, settings.current.registryRevision);
  const project = settings.current.projects[0]!;
  const activity = state.createActivity({ scopeId, projectId: project.id, projectName: project.name, projectCwd: root,
    handoffPolicy: "none", completionTrigger: "manual" });
  const agent = state.createAgent({ scopeId, agentName: "Fixture Agent" });
  const registry = {
    admissionStateStore: state, configureEventDelivery() {},
    activityTransaction: <T>(operation: () => T) => state.transaction(operation),
    get: (id: string) => state.getEventJobSnapshot(id),
    getActivity: (id: string) => state.getActivity(id), getAgent: (id: string) => state.getAgent(id)
  } as unknown as CodexJobRegistry;
  const packets: Array<{ body: any; headers: Record<string, string> }> = [];
  const webhook: WebhookSender = sender || (async (_url, body, headers) => {
    const packet = JSON.parse(body); packets.push({ body: packet, headers });
    return { status: 200, body: JSON.stringify(packet.type === "verification" ? { challenge: packet.challenge } : {}) };
  });
  const controller = new McpEventsController(config, registry, scopes, webhook);
  const handlers = new Map<string, { schema: any; callback: any }>();
  const tools = new Map<string, { schema: any; callback: any }>();
  controller.install({ registerTool(name: string, descriptor: any, callback: any) {
    tools.set(name, { schema: descriptor.inputSchema, callback });
  }, server: { registerCapabilities() {}, setRequestHandler(name: string, descriptor: any, callback: any) {
    handlers.set(name, { schema: descriptor.params, callback });
  } } } as unknown as McpServer);
  const context = (meta: Record<string, unknown> = metadata, identity = principal) => ({
    mcpReq: { _meta: meta, signal: new AbortController().signal, id: randomUUID() },
    http: { authInfo: { token: "synthetic-verified-context", scopes: ["bridge"], clientId: "fixture-client",
      expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { bridgeMcpPrincipal: identity } } }
  }) as unknown as ServerContext;
  const seed = (extra: Record<string, unknown> = {}) => {
    const job = { jobId: randomUUID(), requestId: randomUUID(), scopeId, activityId: activity.activityId,
      agentId: agent.agentId, projectId: project.id, projectName: project.name, cwd: root,
      mcpPrincipal: principal, completionDeliveryPolicy: "events" as const,
      createdAt: Date.now(), updatedAt: Date.now(), version: 1, status: "running", pendingInteractions: [], ...extra };
    state.upsertJob(job);
    return state.getEventJobSnapshot(job.jobId)!;
  };
  const rpc = async (name: string, args: Record<string, unknown>, ctx = context()) => {
    const handler = handlers.get(name)!;
    return handler.callback(handler.schema.parse(args), ctx);
  };
  const access = async (jobId: string, event = JOB_LIFECYCLE_EVENT, action = "issue", ctx = context()) => {
    const tool = tools.get("codex_event_access")!;
    return (await tool.callback(tool.schema.parse({ jobId, event, action }), ctx)).structuredContent;
  };
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const subscribe = async (grant: any, extra: Record<string, unknown> = {}) => rpc("events/subscribe", {
    name: grant.event, arguments: grant.arguments,
    delivery: { mode: "webhook", url: "https://receiver.fixture.example/events", secret }, ...extra
  }, context({}));
  const finish = (jobId: string) => {
    const job = state.getEventJobSnapshot(jobId)!;
    state.upsertJob({ ...job, requestId: state.listJobs().find(row => row.jobId === jobId)!.requestId,
      projectName: project.name, status: "completed", version: job.version! + 1, updatedAt: Date.now(), pendingInteractions: [] });
  };
  const deliver = () => (controller as unknown as { deliver(): Promise<void> }).deliver();
  const fixture = { root, state, config, controller, scopes, context, registry, scopeId, principal,
    activity, agent, project, packets, seed, rpc, access, subscribe, secret, finish, deliver };
  fixtures.push(fixture);
  return fixture;
}

describe("#247 lifecycle receiver contracts", () => {
  it("declares explicit lifecycle consent without changing the exact terminal reference", async () => {
    const f = await start(); const a = f.seed();
    const terminal = await f.access(a.jobId, JOB_TERMINAL_EVENT);
    const lifecycle = await f.access(a.jobId);
    expect(lifecycle.arguments.subscriptionRef).not.toBe(terminal.arguments.subscriptionRef);
    expect((await f.rpc("events/list", {})).events.map((event: any) => event.name)).toEqual([JOB_TERMINAL_EVENT, JOB_LIFECYCLE_EVENT]);
    await expect(f.subscribe({ ...terminal, event: JOB_LIFECYCLE_EVENT })).rejects.toMatchObject({ code: -32001 });
    await expect(f.access(a.jobId, JOB_LIFECYCLE_EVENT, "issue", f.context({ "openai/session": "foreign" }))).rejects.toMatchObject({ code: -32001 });
    await f.subscribe(lifecycle);
    expect(f.state.mcpEvents.lifecycleRoots()).toHaveLength(1);
  });

  it("commits B and its inherited delivery together without minting a B grant", async () => {
    const f = await start(); const a = f.seed(); const grant = await f.access(a.jobId); await f.subscribe(grant);
    f.finish(a.jobId); await f.deliver();
    expect(f.state.getActivity(a.activityId!)!.lifecycle).toBe("open");
    const b = f.seed();
    expect(f.state.mcpEvents.list(b.jobId)[0]).toMatchObject({ delivery: "waiting", lifecycleRoot: { jobId: a.jobId } });
    f.finish(b.jobId);
    expect(f.state.mcpEventAccess.list(b.jobId)).toHaveLength(0);
    const record = f.state.mcpEvents.list(b.jobId)[0]!;
    expect(record.lifecycleRoot?.jobId).toBe(a.jobId);
    expect(record.event).toMatchObject({ name: JOB_LIFECYCLE_EVENT, data: { rootJobId: a.jobId, jobId: b.jobId, kind: "terminal" } });
    await f.deliver();
    expect(f.state.mcpEvents.list(b.jobId)[0]!.delivery).toBe("acknowledged");
    expect(f.state.getJobCompletionDelivery(b.jobId)?.directResultOfferedAt).toBeUndefined();
    const before = f.state.mcpEvents.list(b.jobId)[0]!.attempts;
    f.state.mcpEvents.reconcileLifecycle(f.state.mcpEvents.lifecycleRoots()[0]!); await f.deliver();
    expect(f.state.mcpEvents.list(b.jobId)[0]!.attempts).toBe(before);
  });

  it("backfills a completed B when root registration happens after B admission", async () => {
    const f = await start(); const a = f.seed(); f.finish(a.jobId);
    const b = f.seed(); f.finish(b.jobId);
    const grant = await f.access(a.jobId); await f.subscribe(grant);
    await f.deliver();
    const delivered = f.packets.filter(packet => packet.body.name === JOB_LIFECYCLE_EVENT);
    expect(new Set(delivered.map(packet => packet.body.data.jobId))).toEqual(new Set([a.jobId, b.jobId]));
    expect(f.state.mcpEventAccess.list()).toHaveLength(1);
  });

  it("keeps scopes, Activities, Agents, projects and ordinary Jobs outside root consent", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const root = f.state.mcpEvents.lifecycleRoots()[0]!;
    for (const changed of [{ scopeId: randomUUID() }, { activityId: randomUUID() }, { agentId: randomUUID() },
      { projectId: randomUUID() }, { mcpPrincipal: "foreign" }, { completionDeliveryPolicy: "direct-wait" as const }]) {
      expect(f.state.mcpEvents.matchesLifecycle(root, { ...a, ...changed })).toBe(false);
    }
    const b = f.seed();
    await expect(f.subscribe({ ...await f.access(a.jobId), arguments: { jobId: b.jobId, subscriptionRef: (await f.access(a.jobId)).arguments.subscriptionRef } }))
      .rejects.toMatchObject({ code: -32001 });
  });

  it("persists private-input-free intent and signals readiness only after its source commit", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const notices = vi.fn(); f.state.subscribeMcpEventReady(notices);
    const question = { interactionId: "fixture-input", kind: "user-input", origin: "codex-question", isBlocking: true,
      summary: "Private question", questions: [{ id: "choice", question: "Private question text", isSecret: false }] };
    f.state.recordJobTelemetryEvent(a.jobId, "app-input-required-waiting", { details: { interaction: question } }, Date.now(), "user",
      { updatedAt: Date.now(), version: 2, lastProgressAt: Date.now(), pendingInteractions: [question] });
    expect(notices).toHaveBeenCalledTimes(1);
    const record = f.state.mcpEvents.list(a.jobId)[0]!;
    const eventId = record.event!.eventId;
    expect(record.event).toMatchObject({ data: { kind: "input-required", result: { query: { kind: "input", jobId: a.jobId } } } });
    expect(JSON.stringify(record.event)).not.toMatch(/Private question|fixture-input|subscriptionRef|whsec_/);
    f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 3, lastProgressAt: Date.now(), pendingInteractions: [question] });
    expect(f.state.mcpEvents.list(a.jobId)[0]!.event!.eventId).toBe(eventId);
    expect(notices).toHaveBeenCalledTimes(1);
    await f.deliver();
    f.state.recordJobTelemetryEvent(a.jobId, "app-input-required-completed", { details: { resolvedInteractionId: question.interactionId } }, Date.now(), "codex",
      { updatedAt: Date.now(), version: 4, lastProgressAt: Date.now(), pendingInteractions: [] });
    expect(f.state.mcpEvents.list(a.jobId)[0]!.event).toBeUndefined();
  });

  it("rolls back the source and event intent without publishing readiness", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const notices = vi.fn(); f.state.subscribeMcpEventReady(notices);
    expect(() => f.state.transaction(() => { const b = f.seed(); f.finish(b.jobId); throw new Error("fixture rollback"); })).toThrow("fixture rollback");
    expect(f.state.listJobs()).toHaveLength(1);
    expect(f.state.mcpEvents.lifecycleChildren(f.state.mcpEvents.lifecycleRoots()[0]!)).toHaveLength(0);
    expect(notices).not.toHaveBeenCalled();
  });

  it("does not emit a ready notice for input resolved within the same source transaction", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const notices = vi.fn(); f.state.subscribeMcpEventReady(notices);
    const input = { interactionId: "brief-input", kind: "user-input", origin: "codex-question", questions: [] };
    f.state.transaction(() => {
      f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 2, lastProgressAt: Date.now(), pendingInteractions: [input] });
      f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 3, lastProgressAt: Date.now(), pendingInteractions: [] });
    });
    expect(f.state.mcpEvents.list(a.jobId)[0]!.event).toBeUndefined();
    expect(notices).not.toHaveBeenCalled();
  });

  it("never publishes an input intent from an observation ahead of the durable source", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const input = { interactionId: "committed-question", kind: "user-input", origin: "codex-question", questions: [] };
    f.state.updateJobProgressState(a.jobId, { updatedAt: Date.now(), version: 2, lastProgressAt: Date.now(), pendingInteractions: [input] });
    const committed = f.state.mcpEvents.list(a.jobId)[0]!.event!;
    const get = f.registry.get.bind(f.registry);
    vi.spyOn(f.registry, "get").mockImplementation(id => {
      const job = get(id);
      return id === a.jobId && job ? { ...job, pendingInteractions: [{ ...input, interactionId: "uncommitted-question" }] } : job;
    });
    await f.deliver();
    expect(f.state.mcpEvents.list(a.jobId)[0]!.event!.eventId).toBe(committed.eventId);
    expect(f.packets.find(packet => packet.body.name === JOB_LIFECYCLE_EVENT)!.body.eventId).toBe(committed.eventId);
  });

  it("fences a late ACK at explicit goal completion and rejects a later receiver", async () => {
    const started = barrier(); const release = barrier();
    const f = await start(async (_url, body) => {
      const packet = JSON.parse(body);
      if (packet.type === "verification") return { status: 200, body: JSON.stringify({ challenge: packet.challenge }) };
      started.resolve(); await release.promise; return { status: 200, body: "{}" };
    });
    const a = f.seed(); const grant = await f.access(a.jobId); await f.subscribe(grant); f.finish(a.jobId);
    const sending = f.deliver(); await started.promise;
    f.state.completeActivity(f.activity.activityId, "Fixture final review complete");
    release.resolve(); await sending;
    expect(f.state.mcpEvents.list(a.jobId)[0]).toMatchObject({ disabled: "goal-ended", delivery: "pending" });
    await expect(f.access(a.jobId)).rejects.toMatchObject({ code: -32001 });
    await expect(f.subscribe(grant)).rejects.toMatchObject({ code: -32001 });
    expect(f.state.mcpEventAccess.subscriptionState(f.state.getEventJobSnapshot(a.jobId)!)).toMatchObject({ state: "unavailable", reason: "goal_ended" });
  });

  it("propagates unsubscribe to derived records without resuming them", async () => {
    const f = await start(); const a = f.seed(); const grant = await f.access(a.jobId); await f.subscribe(grant);
    const b = f.seed(); f.finish(b.jobId);
    await f.rpc("events/unsubscribe", { name: grant.event, arguments: grant.arguments,
      delivery: { mode: "webhook", url: "https://receiver.fixture.example/events" } }, f.context({}));
    expect(f.state.mcpEvents.list(b.jobId)[0]!.disabled).toBe("unsubscribed");
    const count = f.state.mcpEvents.list().length;
    const c = f.seed(); f.finish(c.jobId); await f.deliver();
    expect(f.state.mcpEvents.list()).toHaveLength(count);
    expect(f.state.mcpEvents.list(c.jobId)).toHaveLength(0);
  });

  it("preserves an exact child revoke before the original root first registers", async () => {
    const f = await start(); const a = f.seed(); const grant = await f.access(a.jobId);
    const b = f.seed();
    expect(f.state.mcpEvents.list(b.jobId)).toHaveLength(0);
    await f.access(b.jobId, JOB_LIFECYCLE_EVENT, "revoke");
    expect(f.state.mcpEventAccess.monitoringStopped(f.state.getEventJobSnapshot(b.jobId)!, JOB_LIFECYCLE_EVENT)).toBe("revoked");
    f.finish(b.jobId);
    await f.subscribe(grant);
    await f.deliver();
    f.state.mcpEvents.reconcileLifecycle(f.state.mcpEvents.lifecycleRoots()[0]!);
    await f.deliver();
    expect(f.packets.filter(packet => packet.body.name === JOB_LIFECYCLE_EVENT && packet.body.data.jobId === b.jobId)).toHaveLength(0);
    expect(f.state.mcpEvents.list(b.jobId)).toHaveLength(0);
    expect(f.state.getEventJobSnapshot(b.jobId)!.status).toBe("completed");
    expect(f.state.mcpEventAccess.monitoringStopped(f.state.getEventJobSnapshot(b.jobId)!, JOB_LIFECYCLE_EVENT)).toBe("revoked");
  });

  it("fences an exact child revoke and then a root revoke without affecting unrelated consent", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const otherActivity = f.state.createActivity({ scopeId: f.scopeId, projectId: f.project.id,
      projectName: f.project.name, projectCwd: f.root, handoffPolicy: "none", completionTrigger: "manual" });
    const otherAgent = f.state.createAgent({ scopeId: f.scopeId, agentName: "Other fixture Agent" });
    const other = f.seed({ activityId: otherActivity.activityId, agentId: otherAgent.agentId });
    await f.subscribe(await f.access(other.jobId));
    const b = f.seed(); await f.access(b.jobId, JOB_LIFECYCLE_EVENT, "revoke"); f.finish(b.jobId);
    expect(f.state.mcpEvents.list(b.jobId)[0]!.disabled).toBe("revoked");
    const c = f.seed(); f.finish(c.jobId);
    expect(f.state.mcpEvents.list(c.jobId)[0]!.disabled).toBeUndefined();
    await f.access(a.jobId, JOB_LIFECYCLE_EVENT, "revoke");
    expect(f.state.mcpEvents.list(c.jobId)[0]!.disabled).toBe("revoked");
    expect(f.state.mcpEventAccess.subscriptionState(f.state.getEventJobSnapshot(c.jobId)!)).toMatchObject({ state: "unavailable", reason: "revoked" });
    expect(f.state.getEventJobSnapshot(c.jobId)!.status).toBe("completed");
    expect(f.state.mcpEvents.list(other.jobId)[0]!.disabled).toBeUndefined();
    expect(f.state.mcpEventAccess.subscriptionState(f.state.getEventJobSnapshot(other.jobId)!)).toMatchObject({ state: "active", rootJobId: other.jobId });
  });

  it("preserves pending delivery and fences an old ACK across verified key renewal", async () => {
    const started = barrier(); const release = barrier(); let held = true;
    const f = await start(async (_url, body) => {
      const packet = JSON.parse(body);
      if (packet.type === "verification") return { status: 200, body: JSON.stringify({ challenge: packet.challenge }) };
      if (held) { held = false; started.resolve(); await release.promise; }
      return { status: 200, body: "{}" };
    });
    const a = f.seed(); const grant = await f.access(a.jobId); await f.subscribe(grant);
    const b = f.seed(); f.finish(b.jobId);
    const eventId = f.state.mcpEvents.list(b.jobId)[0]!.event!.eventId;
    const sending = f.deliver(); await started.promise;
    const nextSecret = "whsec_" + randomBytes(32).toString("base64");
    await f.subscribe(grant, { delivery: { mode: "webhook", url: "https://receiver.fixture.example/events", secret: nextSecret } });
    release.resolve(); await sending;
    expect(f.state.mcpEvents.list(b.jobId)[0]).toMatchObject({ delivery: "pending", event: { eventId } });
    await f.deliver();
    expect(f.state.mcpEvents.list(b.jobId)[0]).toMatchObject({ delivery: "acknowledged", event: { eventId } });
    expect(f.state.mcpEventAccess.list()).toHaveLength(1);
  });

  it("retains Job truth when bounded receiver capacity prevents a child intent", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId));
    const original = f.state.mcpEvents.list.bind(f.state.mcpEvents);
    const storePrototype = Object.getPrototypeOf(f.state.mcpEvents);
    const listing = vi.spyOn(storePrototype, "list").mockImplementation(function(jobId?: string) {
      const rows = original(jobId);
      return jobId ? rows : Array.from({ length: MAX_EVENT_SUBSCRIPTIONS }, (_, index) => rows[0] || { id: String(index) });
    });
    const b = f.seed(); f.finish(b.jobId);
    listing.mockRestore();
    expect(f.state.getEventJobSnapshot(b.jobId)!.status).toBe("completed");
    expect(f.state.mcpEvents.lifecycleRoots()[0]!.recoveryPending).toBe(true);
    f.state.mcpEvents.reconcileLifecycle(f.state.mcpEvents.lifecycleRoots()[0]!);
    expect(f.state.mcpEvents.list(b.jobId)[0]!.event).toMatchObject({ data: { jobId: b.jobId, kind: "terminal" } });
  });

  it("recovers the same event identity from persisted source and receiver records", async () => {
    const f = await start(); const a = f.seed(); await f.subscribe(await f.access(a.jobId)); const b = f.seed(); f.finish(b.jobId);
    const before = f.state.mcpEvents.list(b.jobId)[0]!;
    const root = f.state.mcpEvents.lifecycleRoots()[0]!;
    // Stop the disposable owner before restarting; do not bypass the normal
    // state upgrade/owner lease guard. No clock or expiry change is involved.
    await f.controller.close(); f.state.close();
    const recovered = new BridgeStateStore({ file: path.join(f.root, "state.sqlite") });
    const registry = { ...f.registry, admissionStateStore: recovered,
      activityTransaction: <T>(operation: () => T) => recovered.transaction(operation),
      get: (id: string) => recovered.getEventJobSnapshot(id),
      getActivity: (id: string) => recovered.getActivity(id), getAgent: (id: string) => recovered.getAgent(id) } as unknown as CodexJobRegistry;
    const controller = new McpEventsController(f.config, registry, new ScopeResolver({ stateStore: recovered }), async () => ({ status: 200, body: "{}" }));
    f.state = recovered; f.controller = controller;
    try {
      expect(recovered.mcpEvents.list(b.jobId)[0]!.event).toEqual(before.event);
      expect(lifecycleEvent(recovered.getEventJobSnapshot(b.jobId)!, root.lifecycleRoot!)!.eventId).toBe(before.event!.eventId);
      recovered.mcpEvents.reconcileLifecycle(recovered.mcpEvents.lifecycleRoots()[0]!);
      expect(recovered.mcpEvents.list(b.jobId)[0]!.event!.eventId).toBe(before.event!.eventId);
    } finally { /* The fixture cleanup closes the restarted owner. */ }
  });
});
