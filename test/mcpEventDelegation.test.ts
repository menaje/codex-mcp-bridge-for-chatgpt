import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SUBSCRIPTION_REF_PATTERN, EVENT_ACCESS_LIFETIME_MS } from "../src/mcpEventAccess.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { McpOAuthVerifier, mcpOAuthPrincipal } from "../src/mcpOAuth.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import type { WebhookSender } from "../src/mcpWebhook.js";

const oauthEnv = {
  CODEX_MCP_BRIDGE_OAUTH_ISSUER: "https://id.fixture.example/tenant/",
  CODEX_MCP_BRIDGE_OAUTH_RESOURCE: "https://bridge.fixture.example/mcp",
  CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: "https://bridge.fixture.example/.well-known/oauth-protected-resource/mcp",
  CODEX_MCP_BRIDGE_OAUTH_JWKS_URI: "https://id.fixture.example/tenant/keys",
  CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT: "operator-issued-subject"
};
const sealingKey = randomBytes(32).toString("hex");
const webhookSecret = "whsec_" + randomBytes(32).toString("base64");
const meta = { "openai/session": "oauth-original-conversation", "openai/subject": "host-correlation-only" };
const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const catalog: CodexModelCatalogProvider = { getCatalog: async () => ({ source: "codex-cli", cached: false,
  fetchedAt: new Date().toISOString(), fingerprint: "b".repeat(64), stale: false, validation: "valid",
  models: [{ id: selection.model, displayName: "Fixture", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [], inputModalities: ["text"] }] }) };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let replacement: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKeys: Awaited<ReturnType<typeof exportJWK>>[];
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  replacement = await generateKeyPair("RS256");
  publicKeys = [{ ...await exportJWK(keys.publicKey), kid: "first", alg: "RS256" },
    { ...await exportJWK(replacement.publicKey), kid: "second", alg: "RS256" }];
});

async function accessToken(claims: Record<string, unknown> = {}, alternateKey = false, header: Record<string, unknown> = {}) {
  return new SignJWT({ iss: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_ISSUER,
    aud: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_RESOURCE, sub: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT,
    scope: "bridge", client_id: "chatgpt-client-one", exp: Math.floor(Date.now() / 1_000) + 3_600, jti: randomUUID(), ...claims
  }).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: alternateKey ? "second" : "first", ...header })
    .sign(alternateKey ? replacement.privateKey : keys.privateKey);
}

class Upstream implements CodexUpstream {
  calls = 0;
  private held?: Promise<void>;
  hold() { let release!: () => void; this.held = new Promise<void>(r => { release = r; }); return release; }
  async listTools() { return { tools: [{ name: "codex" }] }; }
  async callTool(_name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    if (this.held) { const wait = this.held; this.held = undefined; await wait; }
    return { content: [{ type: "text", text: "Original OAuth fixture result." }],
      structuredContent: { threadId: args.threadId || randomUUID(), content: "Original OAuth fixture result." } };
  }
  async close() {}
}

type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await close(f.server); await close(f.provider); f.state.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function close(server: Server) { await new Promise<void>(r => server.close(() => r())); }

async function start(options: { root?: string; sender?: WebhookSender; bearer?: boolean; localMetadata?: boolean; eventsEnabled?: boolean; operator?: string } = {}) {
  const root = options.root || await mkdtemp(path.join(tmpdir(), "bridge-oauth-"));
  const state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
  let metadataPort = 0;
  if (options.localMetadata) {
    const reservation = createServer();
    await new Promise<void>(r => reservation.listen(0, "127.0.0.1", r));
    metadataPort = (reservation.address() as { port: number }).port;
    await close(reservation);
  }
  const config = loadConfig({ ...(options.bearer ? {} : oauthEnv),
    ...(options.localMetadata ? { CODEX_MCP_BRIDGE_PORT: String(metadataPort),
      CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: `http://127.0.0.1:${metadataPort}/.well-known/oauth-protected-resource/mcp` } : {}),
    ...(options.operator ? { CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT: options.operator } : {}),
    CODEX_MCP_BRIDGE_TOKEN: sealingKey, CODEX_MCP_BRIDGE_EXPERIMENTAL_PROFILE: "events", CODEX_MCP_BRIDGE_EVENTS_ENABLED: options.eventsEnabled === false ? "0" : "1",
    CODEX_MCP_BRIDGE_ROOTS: root, CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite") });
  const settings = new UserSettingsStore(config, { stateStore: state });
  if (!options.root) {
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false },
      allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }], undefined, settings.current.registryRevision);
  }
  const upstream = new Upstream();
  const deliveries: any[] = [];
  let keyRequests = 0;
  let published = [publicKeys[0]];
  let providerUnavailable: false | "http" | "network" = false;
  const provider = createServer((req, res) => {
    keyRequests++;
    res.setHeader("content-type", "application/json");
    if (providerUnavailable === "network") { req.socket.destroy(); return; }
    if (providerUnavailable === "http") { res.statusCode = 503; res.end("private provider diagnostics"); return; }
    res.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/keys`;
  const jwksFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(config.oauth!.jwksUri);
    return fetch(providerUrl, init);
  };
  const sender: WebhookSender = options.sender || (async (_url, body) => {
    const parsed = JSON.parse(body); deliveries.push(parsed);
    return { status: 200, body: JSON.stringify(parsed.type === "verification" ? { challenge: parsed.challenge } : {}) };
  });
  const server = createHttpServer(config, upstream, catalog, { stateStore: state, eventWebhookSender: sender, oauthJwksFetch: jwksFetch });
  await new Promise<void>(r => server.listen(metadataPort, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const f = { root, state, config, settings, upstream, server, provider, baseUrl, deliveries, jwksFetch, requests: [] as Array<{ method: string; name: unknown }>,
    keyRequests: () => keyRequests, publish: (value: typeof published) => { published = value; },
    providerUnavailable: (value: typeof providerUnavailable) => { providerUnavailable = value; } };
  fixtures.push(f); return f;
}

async function rpc(f: Fixture, method: string, params: Record<string, unknown> = {}, token?: string, metadata: Record<string, unknown> = meta) {
  f.requests.push({ method, name: params.name });
  const response = await fetch(`${f.baseUrl}/mcp`, { method: "POST", headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json",
    "mcp-protocol-version": "2026-07-28", "mcp-method": method,
    ...(method === "tools/call" && typeof params.name === "string" ? { "mcp-name": params.name } : {})
  }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: { ...metadata,
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "oauth-fixture", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

async function task(f: Fixture, token: string, extra: Record<string, unknown> = {}, metadata = meta) {
  const list = await rpc(f, "tools/list", {}, token);
  const properties = list.body.result.tools.find((t: any) => t.name === "codex_task").inputSchema.properties;
  const project = f.settings.current.projects[0];
  const result = await rpc(f, "tools/call", { name: "codex_task", arguments: {
    requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt: "Read fixture A", completionDelivery: "events", selection,
    project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision }, ...extra
  } }, token, metadata);
  expect(result.body.error).toBeUndefined();
  expect(result.body.result?.isError).not.toBe(true);
  return result.body.result.structuredContent as any;
}
function subscribe(jobId: string) { return { name: "codex.job.terminal", arguments: { jobId },
  delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: webhookSecret } }; }
async function completed(f: Fixture, jobId: string, token: string) {
  await vi.waitFor(() => expect((f.state.listJobs().find((j: any) => j.jobId === jobId) as any)?.status).toBe("completed"));
  return (await rpc(f, "tools/call", { name: "codex_status", arguments: { query: { kind: "job", id: jobId } } }, token)).body.result.structuredContent;
}

async function call(f: Fixture, name: string, args: Record<string, unknown>, token: string, metadata: Record<string, unknown> = meta) {
  return (await rpc(f, "tools/call", { name, arguments: args }, token, metadata)).body;
}
async function issue(f: Fixture, jobId: string, token: string) {
  const response = await call(f, "codex_event_access", { action: "issue", jobId }, token);
  expect(response.error).toBeUndefined(); expect(response.result.isError).not.toBe(true);
  return response.result.structuredContent;
}
function delegated(grant: any, extra: Record<string, unknown> = {}) {
  return { ...subscribe(grant.jobId), arguments: grant.arguments, ...extra };
}
function unsubscribe(grant: any) {
  return { name: grant.event, arguments: grant.arguments, delivery: { mode: "webhook", url: "https://receiver.example.com/events" } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function presentation(f: Fixture, jobId: string) {
  const job: any = f.state.listJobs().find((j: any) => j.jobId === jobId);
  return createHash("sha256").update("codex-dashboard-presentation-v1").update("\0")
    .update(job.scopeId).update("\0").update(jobId).digest("hex");
}

describe("card-free OAuth Events delegation", () => {
  it("replays the original OAuth B with its legacy selector after Events is disabled", async () => {
    const f = await start(); const token = await accessToken();
    const a = await task(f, token, { approvedFollowups: [{ prompt: "Approved historical B" }] });
    const parent = (await completed(f, a.jobId, token)).items[0];
    const reference = parent.approvedFollowups[0];
    const step = { requestId: reference.requestId, prompt: "Approved historical B", project: undefined, selection: undefined,
      followup: { followupId: reference.followupId, reviewedVersion: parent.versions.job } };
    const b = await task(f, token, { ...step, completionDelivery: undefined });
    await completed(f, b.jobId, token);
    const receipts = f.state.listMeta("task_followup_v1/", 100);
    await close(f.server); await close(f.provider); f.state.close();
    const ordinary = await start({ root: f.root, eventsEnabled: false });
    const input = { ...(await taskInput(ordinary, token)), ...step, completionDelivery: "events" };
    const replay = await call(ordinary, "codex_task", input, await accessToken());
    expect(replay.result.structuredContent).toMatchObject({ jobId: b.jobId, replay: true, completionDeliveryPolicy: "events" });
    expect(replay.result.structuredContent).not.toHaveProperty("eventSubscription");
    const foreign = await call(ordinary, "codex_task", input, await accessToken(), { "openai/session": "foreign-conversation" });
    expect(foreign.error || foreign.result.isError).toBeTruthy();
    expect(ordinary.upstream.calls).toBe(0);
    expect(ordinary.state.listMeta("task_followup_v1/", 100)).toEqual(receipts);
    expect(ordinary.state.listJobs()).toHaveLength(2);
  });

  it.each([413, 410, 503])("exposes terminal callback failure through exact status and task replay (%s)", async statusCode => {
    const received: any[] = [];
    const callback = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      if (body.type === "verification") { res.end(JSON.stringify({ challenge: body.challenge })); return; }
      received.push(body); res.statusCode = statusCode; res.end("private callback diagnostics");
    });
    await new Promise<void>(r => callback.listen(0, "127.0.0.1", r));
    const callbackUrl = `http://127.0.0.1:${(callback.address() as { port: number }).port}/events`;
    try {
      // The test-only sender routes the host's public callback to this isolated
      // HTTP fixture. Production SSRF/DNS checks are unchanged.
      const f = await start({ sender: async (_url, raw, headers, signal) => {
        const response = await fetch(callbackUrl, { method: "POST", body: raw, headers, signal });
        return { status: response.status, body: await response.text() };
      } });
      const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
      const grant = await issue(f, a.jobId, token);
      const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
      const attempts = statusCode === 503 ? 8 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await vi.waitFor(() => {
          const current = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
          expect(current.attempts).toBe(attempt); expect(current.lastStatus).toBe(statusCode);
          expect(current.nextAttemptAt).toBeGreaterThan(Date.now());
          expect(current.delivery).toBe(attempt === attempts ? "failed" : "pending");
        });
        if (attempt < attempts) {
          const current = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
          expect(f.state.mcpEvents.save({ ...current, nextAttemptAt: 0 }, current.revision)).toBe(true);
          expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error).toBeUndefined();
        }
      }
      const failure = { state: "failed", attempts, lastHttpStatus: statusCode,
        failureReason: statusCode === 503 ? "retry_exhausted" : "callback_rejected" };
      const status = await completed(f, a.jobId, token); const exact = status.items[0];
      expect(exact.eventSubscription).toMatchObject({ state: statusCode === 410 ? "unavailable" : "active", delivery: failure });
      if (statusCode === 410) expect(exact.eventSubscription.reason).toBe("callback_gone");
      expect(exact.answer).toContain("Original OAuth fixture result");
      expect(status.warnings.join(" ")).toContain("Automatic webhook retries have stopped");
      expect(exact.nextActions || []).toHaveLength(0);
      const replay = await task(f, token, { requestId: a.requestId });
      expect(replay.eventSubscription.delivery).toEqual(failure); expect(replay.state).toBe("completed");
      expect(replay.error).toBeNull(); expect(replay.nextActions).toHaveLength(0);
      expect(replay.warnings.join(" ")).toContain(failure.failureReason);
      const exposed = JSON.stringify({ exact, replay });
      for (const privateValue of ["private callback diagnostics", "receiver.example.com", webhookSecret, grant.arguments.subscriptionRef]) {
        expect(exposed).not.toContain(privateValue);
      }
      expect(new Set(received.map(body => body.eventId)).size).toBe(1); expect(received).toHaveLength(attempts);
      expect(f.state.retentionProtection(a.jobId)).toContain("mcp-event-result-recovery");
      expect(f.upstream.calls).toBe(1); expect(f.state.listJobs()).toHaveLength(1);
      expect(f.requests.filter(request => request.name === "codex_dashboard" || request.method === "ui/message")).toHaveLength(0);
    } finally { await close(callback); }
  });

  it("reports waiting, in-flight and acknowledged delivery independently of active subscription authority", async () => {
    const sending = deferred(); const releaseSend = deferred();
    const f = await start({ sender: async (_url, raw) => {
      const body = JSON.parse(raw);
      if (body.type !== "verification") { sending.resolve(); await releaseSend.promise; }
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    } });
    const token = await accessToken(); const releaseJob = f.upstream.hold();
    try {
      const a = await task(f, token); const grant = await issue(f, a.jobId, token);
      const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
      const query = { query: { kind: "job", id: a.jobId } };
      const waiting = (await call(f, "codex_status", query, token)).result.structuredContent.items[0];
      expect(waiting.eventSubscription).toEqual({ state: "active", delivery: { state: "waiting", attempts: 0, lastHttpStatus: null, failureReason: null } });
      releaseJob(); await sending.promise;
      const pending = (await call(f, "codex_status", query, token)).result.structuredContent.items[0];
      expect(pending.eventSubscription).toEqual({ state: "active", delivery: { state: "pending", attempts: 1, lastHttpStatus: null, failureReason: null } });
      releaseSend.resolve();
      await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.delivery).toBe("acknowledged"));
      const ack = (await call(f, "codex_status", query, token)).result.structuredContent.items[0];
      expect(ack.eventSubscription).toEqual({ state: "active", delivery: { state: "acknowledged", attempts: 1, lastHttpStatus: 200, failureReason: null } });
    } finally { releaseJob(); releaseSend.resolve(); }
  });

  it.each(["revoke", "unsubscribe"] as const)("omits automatic issue after %s and resumes only with a new original-scope issuance", async action => {
    const f = await start(); const token = await accessToken(); const release = f.upstream.hold();
    try {
      const a = await task(f, token);
      expect(a.nextActions.some((next: any) => next.tool === "codex_event_access" && next.arguments.action === "issue")).toBe(true);
      const grant = await issue(f, a.jobId, token);
      expect((await issue(f, a.jobId, token)).arguments).toEqual(grant.arguments);
      const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
      if (action === "revoke") await call(f, "codex_event_access", { action, jobId: a.jobId }, token);
      else expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeUndefined();
      const stoppedStatus = (await call(f, "codex_status", { query: { kind: "job", id: a.jobId } }, token)).result.structuredContent;
      const stopped = stoppedStatus.items[0];
      expect(stopped.eventSubscription).toMatchObject({ state: "unavailable", reason: action === "revoke" ? "revoked" : "unsubscribed" });
      expect(stopped.nextActions || []).toHaveLength(0);
      expect(stoppedStatus.warnings.join(" ")).toContain("Resume it only when the user asks");
      const replay = await task(f, token, { requestId: a.requestId });
      expect(replay.nextActions.some((next: any) => next.tool === "codex_event_access")).toBe(false);
      expect(JSON.stringify(replay.nextActions)).not.toContain("Complete its exact Events subscription");
      expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
      // Represents a new, explicit user request to resume monitoring. No such
      // action is supplied by status or task replay after the user's stop.
      const resumed = await issue(f, a.jobId, token);
      expect(resumed.arguments.subscriptionRef).not.toBe(grant.arguments.subscriptionRef);
      expect(resumed.state).toBe("pending");
      expect((await rpc(f, "events/subscribe", delegated(resumed), token, {})).body.error).toBeUndefined();
      expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
      expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeUndefined();
      const current = (await call(f, "codex_status", { query: { kind: "job", id: a.jobId } }, token)).result.structuredContent.items[0];
      expect(current.eventSubscription.state).toBe("active"); expect(current.eventSubscription.reason).toBeUndefined();
      expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.disabled).toBe("unsubscribed");
      expect(f.upstream.calls).toBe(1);
      expect(f.requests.filter(request => request.name === "codex_dashboard" || request.method === "ui/message")).toHaveLength(0);
    } finally { release(); }
  });

  it.each(["revoke", "unsubscribe"] as const)("preserves %s intent across legacy receipt cleanup and restart, without retaining credentials", async action => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.delivery).toBe("acknowledged"));
    if (action === "revoke") await call(f, "codex_event_access", { action, jobId: a.jobId }, token);
    else await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {});
    // Emulate 53c91d6 receipts: no durable stop marker or unsubscribedAt field.
    const key = "mcp_event_monitoring_stop_v1/" + a.jobId;
    f.state.deleteMeta(key);
    const old = f.state.mcpEventAccess.list(a.jobId)[0];
    expect(f.state.mcpEventAccess.save({ ...old, unsubscribedAt: undefined, revision: old.revision + 1 }, old.revision)).toBe(true);
    const future = Date.now() + 3 * EVENT_ACCESS_LIFETIME_MS;
    f.state.mcpEventAccess.maintain(future); f.state.mcpEvents.maintain(future);
    expect(f.state.mcpEventAccess.list()).toHaveLength(0); expect(f.state.mcpEvents.list()).toHaveLength(0);
    expect(f.state.getMeta(key)).toBeDefined(); expect(f.state.getMeta(key)).not.toContain(grant.arguments.subscriptionRef);
    await close(f.server); await close(f.provider); f.state.close();
    const restarted = await start({ root: f.root });
    const exact = (await completed(restarted, a.jobId, token)).items[0];
    expect(exact.eventSubscription).toEqual({ state: "unavailable", reason: action === "revoke" ? "revoked" : "unsubscribed" });
    expect(exact.nextActions || []).toHaveLength(0); expect(exact.answer).toContain("Original OAuth fixture result");
    expect((await rpc(restarted, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
    expect(restarted.upstream.calls).toBe(0);
    expect(restarted.state.deleteJob(a.jobId, future)).toBe(true);
    expect(restarted.state.getMeta(key)).toBeUndefined();
    const archived = (await call(restarted, "codex_status", { query: { kind: "job", id: a.jobId } }, token)).result.structuredContent;
    expect(archived.items[0].eventSubscription).toEqual({ state: "unavailable", reason: "job_unavailable" });
    expect(archived.items[0].nextActions || []).toHaveLength(0);
    expect((await call(restarted, "codex_event_access", { action: "issue", jobId: a.jobId }, token)).result.isError).toBe(true);
  });

  it("honors revocation before first issuance and rolls failed resume admission back with its stop intent", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    await call(f, "codex_event_access", { action: "revoke", jobId: a.jobId }, token);
    expect(f.state.mcpEventAccess.list()).toHaveLength(0);
    const key = "mcp_event_monitoring_stop_v1/" + a.jobId; const stopped = f.state.getMeta(key);
    expect((await completed(f, a.jobId, token)).items[0].nextActions || []).toHaveLength(0);
    const remove = f.state.deleteMeta.bind(f.state);
    const failure = vi.spyOn(f.state, "deleteMeta").mockImplementation(candidate => {
      if (candidate === key) throw new Error("isolated resume storage failure"); remove(candidate);
    });
    expect((await call(f, "codex_event_access", { action: "issue", jobId: a.jobId }, token)).result.isError).toBe(true);
    expect(f.state.mcpEventAccess.list()).toHaveLength(0); expect(f.state.getMeta(key)).toBe(stopped);
    failure.mockRestore();
    expect((await issue(f, a.jobId, token)).state).toBe("pending"); expect(f.state.getMeta(key)).toBeUndefined();
    expect(f.upstream.calls).toBe(1);
  });

  it("delivers exact A then exactly one preapproved B without Dashboard or ui/message", async () => {
    const f = await start(); const token = await accessToken();
    const releaseA = f.upstream.hold();
    try {
      const a = await task(f, token, { approvedFollowups: [{ prompt: "Read fixture B" }] });
      expect(a).toMatchObject({ completionDeliveryPolicy: "events", eventSubscription: { state: "pending" } });
      expect(a.nextActions.some((action: any) => action.tool === "codex_dashboard")).toBe(false);
      const grantA = await issue(f, a.jobId, token);
      expect(grantA.arguments.subscriptionRef).toMatch(SUBSCRIPTION_REF_PATTERN);
      expect((await rpc(f, "events/list", {}, token, {})).body.result.events[0].inputSchema.required).toEqual(["jobId", "subscriptionRef"]);
      const subA = await rpc(f, "events/subscribe", delegated(grantA), token, {});
      expect(subA.body.error).toBeUndefined();
      const pending = await call(f, "codex_status", { query: { kind: "job", id: a.jobId } }, token);
      expect(pending.result.structuredContent.items[0].eventSubscription.state).toBe("active");
      releaseA();
      await vi.waitFor(() => expect(f.deliveries.some(event => event.name === "codex.job.terminal" && event.data.jobId === a.jobId)).toBe(true));
      // ACK alone never supplies review evidence or followup authority.
      expect(f.state.getJobCompletionDelivery(a.jobId, f.state.mcpEventAccess.list(a.jobId)[0].scopeId)?.directResultOfferedAt).toBeUndefined();
      const version = (f.state.listJobs().find((j: any) => j.jobId === a.jobId) as any).version;
      const args = { prompt: "Read fixture B", project: undefined, selection: undefined,
        followup: { followupId: a.approvedFollowups[0].followupId, reviewedVersion: version } };
      const premature = await call(f, "codex_task", { ...(await taskInput(f, token)), ...args }, token);
      expect(premature.result.structuredContent.error.code).toBe("FOLLOWUP_REVIEW_REQUIRED");
      const status = await completed(f, a.jobId, token);
      expect(status.items[0].answer).toContain("Original OAuth fixture result");
      f.settings.update({ experimentalDirectResultDelivery: true }, f.settings.current.revision);
      const releaseB = f.upstream.hold();
      try {
        const [b, duplicate] = await Promise.all([task(f, token, { ...args, completionDelivery: undefined }),
          task(f, token, { ...args, completionDelivery: undefined })]);
        expect(b.jobId).toBe(duplicate.jobId);
        expect(b.completionDeliveryPolicy).toBe("events");
        expect(b.nextActions.some((action: any) => action.tool === "codex_dashboard")).toBe(false);
        const grantB = await issue(f, b.jobId, token);
        expect(grantB.arguments.subscriptionRef).not.toBe(grantA.arguments.subscriptionRef);
        expect((await rpc(f, "events/subscribe", { ...delegated(grantA), arguments: { ...grantA.arguments, jobId: b.jobId } }, token, {})).body.error.code).toBe(-32001);
        expect((await rpc(f, "events/subscribe", delegated(grantB), token, {})).body.error).toBeUndefined();
        releaseB();
        await vi.waitFor(() => expect(f.deliveries.some(event => event.name === "codex.job.terminal" && event.data.jobId === b.jobId)).toBe(true));
        expect((await completed(f, b.jobId, token)).items[0].completionDeliveryPolicy).toBe("events");
        expect(f.upstream.calls).toBe(2); expect(f.state.listJobs()).toHaveLength(2);
        expect(f.requests.filter(request => request.name === "codex_dashboard" || request.method === "ui/message")).toHaveLength(0);
        expect(f.state.mcpEventAccess.list()).toHaveLength(2);
        for (const event of f.deliveries.filter(event => event.name)) expect(JSON.stringify(event)).not.toContain("subscriptionRef");
      } finally { releaseB(); }
    } finally { releaseA(); }
  });

  it("recovers the same opaque grant and exact subscription after response loss, token refresh and restart", async () => {
    const f = await start(); const token = await accessToken();
    const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    const snapshot = f.state.mcpEventAccess.list(a.jobId)[0];
    expect(JSON.stringify(snapshot)).not.toContain(grant.arguments.subscriptionRef);
    expect((await issue(f, a.jobId, await accessToken())).arguments).toEqual(grant.arguments);
    const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.delivery).toBe("acknowledged"));
    await close(f.server); await close(f.provider); f.state.close();
    const restarted = await start({ root: f.root });
    const recovered = await issue(restarted, a.jobId, await accessToken());
    expect(recovered.arguments).toEqual(grant.arguments);
    const refresh = await rpc(restarted, "events/subscribe", delegated(recovered), await accessToken(), {});
    expect(refresh.body.result.id).toBe(sub.body.result.id);
    expect(restarted.upstream.calls).toBe(0);
    expect((await rpc(restarted, "events/unsubscribe", unsubscribe(recovered), await accessToken(), {})).body.error).toBeUndefined();
    expect(restarted.state.mcpEvents.get(a.jobId, sub.body.result.id)?.disabled).toBe("unsubscribed");
  });

  it.each([{}, { "openai/session": "" }, { "openai/session": null }, { "openai/session": 42 },
    { "openai/session": "different", "openai/subject": "host-correlation-only" }])(
    "requires original host scope for issuance (%j)", async metadata => {
      const f = await start(); const token = await accessToken(); const a = await task(f, token);
      const result = await call(f, "codex_event_access", { action: "issue", jobId: a.jobId }, token, metadata);
      expect(result.error || result.result.isError).toBeTruthy(); expect(f.state.mcpEventAccess.list()).toHaveLength(0);
    });

  it.each([{ "openai/session": "" }, { "openai/session": null }, { "openai/session": 42 },
    { "openai/session": "different", "openai/subject": "host-correlation-only" }])(
    "never uses a reference to bypass present invalid/different session (%j)", async metadata => {
      const f = await start(); const token = await accessToken(); const a = await task(f, token);
      const grant = await issue(f, a.jobId, token);
      const result = await rpc(f, "events/subscribe", delegated(grant), token, metadata);
      expect(result.body.error.code).toBe(-32001); expect(f.deliveries).toHaveLength(0);
      expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, metadata)).body.error.code).toBe(-32001);
      expect(f.state.mcpEvents.list()).toHaveLength(0);
    });

  it("allows a valid original session while preserving the exact delegation and rejects unknown/ref-swapped Jobs", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const grant = await issue(f, a.jobId, token);
    expect((await rpc(f, "events/subscribe", delegated(grant), token)).body.error).toBeUndefined();
    const invalid = await rpc(f, "events/subscribe", { ...delegated(grant), arguments: { jobId: a.jobId, subscriptionRef: "esr_" + "a".repeat(43) } }, token, {});
    expect(invalid.body.error.code).toBe(-32001);
    expect((await rpc(f, "events/subscribe", subscribe(a.jobId), token, {})).body.error.code).toBe(-32001);
    expect((await rpc(f, "events/subscribe", { ...delegated(grant), name: "codex.job.progress" }, token, {})).body.error.code).toBe(-32602);
  });

  it("rejects the same reference under another authenticated OAuth principal", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const grant = await issue(f, a.jobId, token);
    await close(f.server); await close(f.provider); f.state.close();
    const different = await start({ root: f.root, operator: "different-operator" });
    const otherToken = await accessToken({ sub: "different-operator" });
    expect((await rpc(different, "events/subscribe", delegated(grant), otherToken, {})).body.error.code).toBe(-32001);
    expect((await call(different, "codex_event_access", { action: "issue", jobId: a.jobId }, otherToken)).result.isError).toBe(true);
    expect(different.deliveries).toHaveLength(0);
  });

  it("cannot authorize ordinary result reads, tasks or configuration through a subscriptionRef", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    for (const metadata of [{}, { "openai/session": "different" }]) {
      const status = await call(f, "codex_status", { query: { kind: "job", id: a.jobId } }, token, metadata);
      expect(status.error || status.result.isError).toBeTruthy();
      const withRef = await call(f, "codex_status", { query: { kind: "job", id: a.jobId }, subscriptionRef: grant.arguments.subscriptionRef }, token, metadata);
      expect(withRef.error || withRef.result.isError).toBeTruthy();
      const admission = await call(f, "codex_task", { ...(await taskInput(f, token)), subscriptionRef: grant.arguments.subscriptionRef }, token, metadata);
      expect(admission.error || admission.result.isError).toBeTruthy();
      const settings = await call(f, "codex_update_settings", { subscriptionRef: grant.arguments.subscriptionRef }, token, metadata);
      expect(settings.error || settings.result.isError).toBeTruthy();
    }
    expect(f.state.listJobs()).toHaveLength(1); expect(f.upstream.calls).toBe(1);
    expect((await completed(f, a.jobId, token)).items[0].answer).toContain("Original OAuth fixture result");
  });

  it("rejects caller-generated reference/scope inputs on the grant tool", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    for (const extra of [{ subscriptionRef: "esr_" + "a".repeat(43) }, { scopeId: randomUUID() }, { id: randomUUID() }]) {
      const result = await call(f, "codex_event_access", { action: "issue", jobId: a.jobId, ...extra }, token);
      expect(result.error || result.result.isError).toBeTruthy();
    }
    expect(f.state.mcpEventAccess.list()).toHaveLength(0);
  });

  it("rejects Events admission before execution on bearer-only, disabled or explicit-scope-only hosts", async () => {
    for (const options of [{ bearer: true }, { eventsEnabled: false }, {}]) {
      const f = await start(options); const token = options.bearer ? sealingKey : await accessToken();
      const result = await call(f, "codex_task", { ...(await taskInput(f, token)), scopeId: randomUUID() }, token,
        Object.keys(options).length ? meta : {});
      expect(result.result.structuredContent.error.code).toBe("EVENTS_DELIVERY_UNAVAILABLE");
      expect(f.state.listJobs()).toHaveLength(0); expect(f.upstream.calls).toBe(0);
    }
  });

  it("keeps ordinary direct-wait Jobs outside delegated Events admission", async () => {
    const f = await start(); const token = await accessToken();
    const release = f.upstream.hold();
    try {
      const a = await task(f, token, { completionDelivery: undefined });
      expect(a.completionDeliveryPolicy).toBe("direct-wait"); expect(a).not.toHaveProperty("eventSubscription");
      expect(a.nextActions.some((action: any) => action.tool === "codex_dashboard")).toBe(false);
      expect((await call(f, "codex_event_access", { action: "issue", jobId: a.jobId }, token)).result.isError).toBe(true);
      expect((await rpc(f, "events/subscribe", subscribe(a.jobId), token)).body.error).toBeUndefined();
      expect(f.state.mcpEventAccess.list()).toHaveLength(0);
    } finally { release(); }
  });

  it("denies old-card wait/claim and automatic mount while retaining manual Dashboard and exact results", async () => {
    const f = await start(); const token = await accessToken(); const release = f.upstream.hold();
    try {
      const a = await task(f, token);
      const identity = { jobId: a.jobId, presentationRef: presentation(f, a.jobId), widgetInstanceId: randomUUID() };
      const card = await call(f, "codex_ui_completion", { ...identity, operation: "wait", waitMs: 10 }, token);
      expect(card.result.isError).toBe(true);
      expect(JSON.stringify(card)).toContain("CARD_DELIVERY_RETIRED");
      expect((await call(f, "codex_dashboard", { scope: "conversation", jobId: a.jobId, presentationRef: identity.presentationRef }, token)).result.isError).toBe(true);
      expect((await call(f, "codex_dashboard", { scope: "conversation" }, token)).result.isError).not.toBe(true);
      release(); await completed(f, a.jobId, token);
      const scopeId = (f.state.listJobs()[0] as any).scopeId;
      expect(f.state).not.toHaveProperty("claimJobCompletionDelivery");
      const later = await call(f, "codex_ui_completion", { ...identity, operation: "wait" }, token);
      expect(later.result.isError).toBe(true);
      expect(JSON.stringify(later)).toContain("CARD_DELIVERY_RETIRED");
      expect(f.state.getJobCompletionDelivery(a.jobId, scopeId)?.attemptCount).toBe(0);
      expect(f.state.getJobCompletionDelivery(a.jobId, scopeId)?.directResultOfferedAt).toBeDefined();
    } finally { release(); }
  });

  it("expires at the grant and token boundaries and allows authenticated disabling after expiry", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const grant = await issue(f, a.jobId, token);
    const record = f.state.mcpEventAccess.list(a.jobId)[0];
    expect(record.expiresAt - record.issuedAt).toBe(EVENT_ACCESS_LIFETIME_MS);
    const shortToken = await accessToken({ exp: Math.floor(Date.now() / 1000) + 60 });
    const sub = await rpc(f, "events/subscribe", delegated(grant, { ttlMs: null }), shortToken, {});
    const subscription = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
    expect(subscription.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    const current = f.state.mcpEventAccess.list(a.jobId)[0];
    f.state.mcpEventAccess.save({ ...current, expiresAt: Date.now() - 1, revision: current.revision + 1 }, current.revision);
    expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
    expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeUndefined();
    expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.disabled).toBe("unsubscribed");
  });

  it("atomically binds at most one callback under simultaneous first challenges", async () => {
    const began = deferred(); const release = deferred(); let count = 0;
    const f = await start({ sender: async (_url, raw) => {
      const event = JSON.parse(raw);
      if (event.type === "verification") { if (++count === 2) began.resolve(); await release.promise; }
      return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
    } });
    const token = await accessToken(); const a = await task(f, token); const grant = await issue(f, a.jobId, token);
    const attempts = ["one", "two"].map(path => rpc(f, "events/subscribe", delegated(grant, {
      delivery: { mode: "webhook", url: "https://receiver.example.com/" + path, secret: webhookSecret }
    }), token, {}));
    await began.promise; release.resolve(); const results = await Promise.all(attempts);
    expect(results.filter(result => result.body.result)).toHaveLength(1);
    expect(results.filter(result => result.body.error)).toHaveLength(1);
    expect(f.state.mcpEvents.list()).toHaveLength(1);
    const bound = f.state.mcpEventAccess.list()[0];
    expect(bound.subscriptionId).toBe(f.state.mcpEvents.list()[0].id); expect(bound.revision).toBe(2);
    const winning = results.findIndex(result => result.body.result);
    const other = await rpc(f, "events/subscribe", delegated(grant, {
      delivery: { mode: "webhook", url: "https://receiver.example.com/" + (winning ? "one" : "two"), secret: webhookSecret }
    }), token, {});
    expect(other.body.error.code).toBe(-32001); expect(count).toBe(2);
  });

  it.each(["revoke", "unsubscribe", "project-unavailable"])("does not revive a grant changed during callback verification (%s)", async action => {
    const began = deferred(); const release = deferred();
    const f = await start({ sender: async (_url, raw) => {
      const body = JSON.parse(raw); if (body.type === "verification") { began.resolve(); await release.promise; }
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    } });
    const token = await accessToken(); const a = await task(f, token); const grant = await issue(f, a.jobId, token);
    const pending = rpc(f, "events/subscribe", delegated(grant), token, {});
    try {
      await began.promise;
      if (action === "revoke") await call(f, "codex_event_access", { action: "revoke", jobId: a.jobId }, token);
      else if (action === "unsubscribe") expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeUndefined();
      else vi.spyOn(f.state, "isEventProjectAvailable").mockReturnValue(false);
      release.resolve(); expect((await pending).body.error).toBeDefined();
      expect(f.state.mcpEvents.list()).toHaveLength(0);
      expect(f.state.mcpEventAccess.list()[0].callbackHash).toBeUndefined();
      if (action !== "project-unavailable") {
        const stopped = (await call(f, "codex_status", { query: { kind: "job", id: a.jobId } }, token)).result.structuredContent;
        expect(stopped.items[0].eventSubscription.reason).toBe(action === "revoke" ? "revoked" : "unsubscribed");
        expect(stopped.items[0].nextActions || []).toHaveLength(0);
        expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
      }
      expect(f.upstream.calls).toBe(1);
    } finally { release.resolve(); await pending; }
  });

  it("atomically revokes a bound grant, rejects refresh and discards a late delivery ACK", async () => {
    const sending = deferred(); const release = deferred();
    const f = await start({ sender: async (_url, raw) => {
      const body = JSON.parse(raw);
      if (body.type !== "verification") { sending.resolve(); await release.promise; }
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    } });
    const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
    try {
      await sending.promise;
      const before = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
      await call(f, "codex_event_access", { action: "revoke", jobId: a.jobId }, token);
      const revoked = f.state.mcpEvents.get(a.jobId, before.id)!;
      expect(revoked).toMatchObject({ disabled: "revoked", revision: before.revision + 1 });
      expect(f.state.mcpEventAccess.list()[0].revokedAt).toBeDefined();
      expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
      release.resolve();
      await new Promise(r => setTimeout(r, 30));
      expect(f.state.mcpEvents.get(a.jobId, before.id)).toEqual(revoked);
      const status = await completed(f, a.jobId, token);
      expect(status.items[0].eventSubscription.state).toBe("unavailable");
      expect(f.state.mcpEvents.protectsResult(a.jobId, Date.now())).toBe(true);
    } finally { release.resolve(); }
  });

  it("rolls callback binding back when subscription storage fails", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const grant = await issue(f, a.jobId, token); const before = f.state.mcpEventAccess.list()[0];
    const save = f.state.setMeta.bind(f.state);
    vi.spyOn(f.state, "setMeta").mockImplementation((key, value) => {
      if (key.startsWith("mcp_events_v1/")) throw new Error("isolated subscription storage failure"); save(key, value);
    });
    expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error).toBeDefined();
    expect(f.state.mcpEventAccess.list()[0]).toEqual(before); expect(f.state.mcpEvents.list()).toHaveLength(0);
    expect(f.state.listJobs()).toHaveLength(1); expect(f.upstream.calls).toBe(1);
  });

  it("rolls issuance back on storage failure without retrying or cancelling its original Job", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const save = f.state.setMeta.bind(f.state);
    vi.spyOn(f.state, "setMeta").mockImplementation((key, value) => {
      if (key.startsWith("mcp_event_access_v1/")) throw new Error("isolated access storage failure"); save(key, value);
    });
    const response = await call(f, "codex_event_access", { action: "issue", jobId: a.jobId }, token);
    expect(response.error || response.result.isError).toBeTruthy();
    expect(f.state.mcpEventAccess.list()).toHaveLength(0); expect(f.state.listJobs()).toHaveLength(1);
    expect(f.upstream.calls).toBe(1);
  });

  it("bounds receipt capacity and requires a new system reference after explicit revocation", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token);
    const refs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const grant = await issue(f, a.jobId, token); refs.add(grant.arguments.subscriptionRef);
      await call(f, "codex_event_access", { action: "revoke", jobId: a.jobId }, token);
      expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32001);
    }
    expect(refs.size).toBe(8);
    expect((await call(f, "codex_event_access", { action: "issue", jobId: a.jobId }, token)).result.isError).toBe(true);
    expect(f.state.mcpEventAccess.list()).toHaveLength(8); expect(f.upstream.calls).toBe(1);
  });

  it("never treats fixture canProceed output as a followup approval", async () => {
    const f = await start(); const token = await accessToken();
    const original = f.upstream.callTool.bind(f.upstream);
    vi.spyOn(f.upstream, "callTool").mockImplementation(async (name, args) => {
      const result = await original(name, args);
      const answer = JSON.stringify({ canProceed: true, result: "Original OAuth fixture result." });
      return { ...result, content: [{ type: "text", text: answer }],
        structuredContent: { ...result.structuredContent, content: answer } };
    });
    const a = await task(f, token);
    expect((await completed(f, a.jobId, token)).items[0].answer).toContain('"canProceed":true');
    expect(a.approvedFollowups).toBeNull();
    const attempt = await call(f, "codex_task", { ...(await taskInput(f, token)), prompt: "Read fixture B",
      followup: { followupId: "fup_" + a.jobId.replaceAll("-", "") + "a".repeat(64), reviewedVersion: 1 } }, token);
    expect(attempt.result.structuredContent.error.code).toBe("FOLLOWUP_NOT_APPROVED");
    expect(f.upstream.calls).toBe(1);
  });

  it("preserves original results for a finite window even when no callback subscription is admitted", async () => {
    const f = await start({ sender: async () => ({ status: 500, body: "{}" }) });
    const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error.code).toBe(-32015);
    expect(f.state.mcpEvents.list()).toHaveLength(0);
    const job = f.state.listJobs()[0] as any;
    const terminal = f.state.getJobCompletionDelivery(a.jobId, job.scopeId)!;
    expect(f.state.retentionProtection(a.jobId, terminal.createdAt + EVENT_ACCESS_LIFETIME_MS - 1)).toContain("mcp-event-result-recovery");
    expect(f.state.retentionProtection(a.jobId, terminal.createdAt + EVENT_ACCESS_LIFETIME_MS + 1)).not.toContain("mcp-event-result-recovery");
    expect((await completed(f, a.jobId, token)).items[0].answer).toContain("Original OAuth fixture result");
    expect(f.requests.some(request => request.name === "codex_dashboard" || request.method === "ui/message")).toBe(false);
    expect(f.upstream.calls).toBe(1);
  });

  it("keeps an Events Job immutable and unavailable after restart with Events disabled", async () => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token);
    expect((await rpc(f, "events/subscribe", delegated(grant), token, {})).body.error).toBeUndefined();
    await close(f.server); await close(f.provider); f.state.close();
    const restarted = await start({ root: f.root, eventsEnabled: false });
    const status = await completed(restarted, a.jobId, await accessToken());
    expect(status.items[0]).toMatchObject({ completionDeliveryPolicy: "events" });
    expect(status.items[0]).not.toHaveProperty("eventSubscription");
    expect(status.items[0].nextActions || []).toEqual([]);
    expect(restarted.requests.some(request => request.name === "codex_dashboard")).toBe(false);
    expect(restarted.upstream.calls).toBe(0);
  });

  it("rejects delegation expiry during callback verification", async () => {
    const began = deferred(); const release = deferred();
    const f = await start({ sender: async (_url, raw) => {
      const body = JSON.parse(raw); began.resolve(); await release.promise;
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    } });
    const token = await accessToken(); const a = await task(f, token); const grant = await issue(f, a.jobId, token);
    const pending = rpc(f, "events/subscribe", delegated(grant), token, {});
    try {
      await began.promise;
      const current = f.state.mcpEventAccess.list()[0];
      f.state.mcpEventAccess.save({ ...current, expiresAt: Date.now() - 1, revision: current.revision + 1 }, current.revision);
      release.resolve();
      expect((await pending).body.error.code).toBe(-32001);
      expect(f.state.mcpEventAccess.list()[0].callbackHash).toBeUndefined(); expect(f.state.mcpEvents.list()).toHaveLength(0);
    } finally { release.resolve(); await pending; }
  });

  it("preserves ACK and the exact binding while a signing-key refresh challenge awaits", async () => {
    const sendBegan = deferred(); const verifyBegan = deferred();
    const releaseSend = deferred(); const releaseVerify = deferred();
    let verified = 0; let delivered = 0;
    const f = await start({ sender: async (_url, raw) => {
      const body = JSON.parse(raw);
      if (body.type === "verification") {
        if (++verified === 2) { verifyBegan.resolve(); await releaseVerify.promise; }
      } else { delivered++; sendBegan.resolve(); await releaseSend.promise; }
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    } });
    const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token); const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
    try {
      await sendBegan.promise; const binding = f.state.mcpEventAccess.list()[0];
      const refresh = rpc(f, "events/subscribe", delegated(grant, { delivery: {
        mode: "webhook", url: "https://receiver.example.com/events", secret: "whsec_" + randomBytes(32).toString("base64")
      }, ttlMs: 120_000 }), await accessToken(), {});
      await verifyBegan.promise; releaseSend.resolve();
      await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.delivery).toBe("acknowledged"));
      const ack = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
      releaseVerify.resolve(); expect((await refresh).body.result.id).toBe(sub.body.result.id);
      const renewed = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
      expect(renewed).toMatchObject({ delivery: "acknowledged", attempts: ack.attempts, acknowledgedAt: ack.acknowledgedAt,
        recoverUntil: ack.recoverUntil, nextAttemptAt: ack.nextAttemptAt, revision: ack.revision + 1 });
      expect(f.state.mcpEventAccess.list()[0]).toEqual(binding); expect(delivered).toBe(1);
      expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeUndefined();
      expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.disabled).toBe("unsubscribed");
    } finally { releaseSend.resolve(); releaseVerify.resolve(); }
  });

  it.each(["revoke", "unsubscribe"] as const)("rolls %s, stop intent and linked-subscription disabling back together on a write failure", async action => {
    const f = await start(); const token = await accessToken(); const a = await task(f, token); await completed(f, a.jobId, token);
    const grant = await issue(f, a.jobId, token); const sub = await rpc(f, "events/subscribe", delegated(grant), token, {});
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.delivery).toBe("acknowledged"));
    const access = f.state.mcpEventAccess.list()[0]; const subscription = f.state.mcpEvents.get(a.jobId, sub.body.result.id);
    const save = f.state.setMeta.bind(f.state);
    vi.spyOn(f.state, "setMeta").mockImplementation((key, value) => {
      if (key.startsWith("mcp_events_v1/") && JSON.parse(value).disabled === (action === "revoke" ? "revoked" : "unsubscribed")) throw new Error("isolated stop failure");
      save(key, value);
    });
    if (action === "revoke") expect((await call(f, "codex_event_access", { action, jobId: a.jobId }, token)).result.isError).toBe(true);
    else expect((await rpc(f, "events/unsubscribe", unsubscribe(grant), token, {})).body.error).toBeDefined();
    expect(f.state.mcpEventAccess.list()[0]).toEqual(access);
    expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)).toEqual(subscription);
    expect(f.state.getMeta("mcp_event_monitoring_stop_v1/" + a.jobId)).toBeUndefined();
    expect(f.upstream.calls).toBe(1);
  });
});

async function taskInput(f: Fixture, token: string) {
  const list = await rpc(f, "tools/list", {}, token);
  const properties = list.body.result.tools.find((tool: any) => tool.name === "codex_task").inputSchema.properties;
  const project = f.settings.current.projects[0];
  return { requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt: "Read fixture A", completionDelivery: "events", selection,
    project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision } };
}
