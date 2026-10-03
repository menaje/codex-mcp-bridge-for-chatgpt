import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { ModelSelection } from "../src/modelPolicy.js";
import type { CodexPublicEvent } from "../src/upstream.js";
import { parseAppServerModelCatalog } from "../src/modelCatalog.js";
import { speedTierForModel } from "../src/processingSpeed.js";
import { computeSourceHash } from "./build-fingerprint.mjs";

// Real CLI/Bridge lifecycle, synthetic loopback Responses only. No installed
// configuration, account, auth file or commercial inference is used.
const configurationOnly = process.argv.includes("--configuration-only");
const commands = process.argv.slice(2).filter(arg => arg !== "--configuration-only");
assert(commands.length, "Pass explicit CLI paths; this script never installs/selects a CLI.");
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const samples: unknown[] = [];

for (const selected of commands) {
  const command = await realpath(selected);
  const executableSha256 = sha256(await readFile(command));
  for (const configuredTier of ["fast", "unset"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-215-lifecycle-"));
    const codexHome = path.join(root, ".codex"), cwd = path.join(root, "project");
    await mkdir(codexHome); await mkdir(cwd);
    const requests: Record<string, unknown>[] = [], blocked: string[] = [];
    const fixture = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404); response.end("Local fixture route unavailable"); return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ model: body.model, reasoningEffort: body.reasoning?.effort,
          ...(Object.hasOwn(body, "service_tier") ? { serviceTier: body.service_tier } : {}) });
        const id = `fixture-response-${requests.length}`;
        const events = [
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `${id}-message`, content: [{ type: "output_text", text: "Local fixture complete." }] } },
          { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }
        ];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      } catch { response.writeHead(400); response.end("Invalid local fixture request"); }
    });
    const guard = createServer((request, response) => {
      blocked.push(request.url?.split("?")[0] || "unknown"); response.writeHead(503); response.end("External network disabled for this fixture");
    });
    guard.on("connect", (request, socket) => { blocked.push(request.url || "unknown"); socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); });
    const fixturePort = await listen(fixture), guardPort = await listen(guard);
    const providerUrl = `http://127.0.0.1:${fixturePort}/v1`;
    const providerId = "bridge_issue_215_fixture";
    await writeFile(path.join(codexHome, "config.toml"), [
      'model = "gpt-5.6-sol"', `model_provider = "${providerId}"`, 'model_reasoning_effort = "medium"',
      'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'cli_auth_credentials_store = "file"',
      ...(configuredTier === "fast" ? ['service_tier = "fast"'] : []),
      '[analytics]', 'enabled = false', '[feedback]', 'enabled = false',
      '[features]', 'apps = false', 'plugins = false', 'web_search_request = false',
      `[model_providers.${providerId}]`, 'name = "Issue 215 loopback fixture"', `base_url = "${providerUrl}"`,
      'wire_api = "responses"', 'env_key = "BRIDGE_215_LOCAL_FIXTURE_KEY"', 'requires_openai_auth = false',
      'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 10000', ''
    ].join("\n"));
    const environment = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
    environment.HOME = root; environment.CODEX_HOME = codexHome;
    environment.BRIDGE_215_LOCAL_FIXTURE_KEY = "synthetic-loopback-only";
    environment.HTTP_PROXY = environment.HTTPS_PROXY = `http://127.0.0.1:${guardPort}`;
    environment.NO_PROXY = "127.0.0.1,localhost";
    const pool = new CodexAppServerUpstreamPool(command, 1, { environment, requestTimeoutMs: 15000, initializeTimeoutMs: 15000 });
    try {
      const version = execFileSync(command, ["--version"], { env: environment, encoding: "utf8", timeout: 15000 }).trim();
      const policy = await pool.readAuthenticationPolicy();
      const config = record(record(policy.config).config);
      assert.equal(config.model_provider, providerId, `Abort before any turn: unexpected resolved provider. Config keys: ${Object.keys(config).join(", ")}`);
      const provider = record(record(config.model_providers)[providerId]);
      assert.equal(provider.base_url, providerUrl, "Abort before any turn: provider is not the isolated loopback fixture.");
      assert.notEqual(provider.requires_openai_auth, true);
      if (configurationOnly) {
        samples.push({ version, executableSha256, configuredTier, configVerified: true, inference: "not-run" }); continue;
      }
      const selection: ModelSelection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
      const base = { backendKind: "app-server" as const, prompt: "Return the local fixture response.", cwd, sandbox: "read-only" as const, approvalPolicy: "on-request" as const };
      const turns: Record<string, unknown>[] = [];
      let threadId: string | undefined;
      const run = async (scenario: string, chosen: ModelSelection, fresh = false, fork = false) => {
        const events: CodexPublicEvent[] = [], before = requests.length;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Local fixture turn timed out: ${scenario}`)), 20000); });
        try {
          const progress = (p: { event?: CodexPublicEvent }) => { if (p.event) events.push(p.event); };
          const result = await Promise.race([fresh || !threadId ? pool.startThread({ ...base, selection: chosen }, progress)
            : fork ? pool.forkThread({ ...base, threadId, selection: chosen }, progress)
            : pool.continueThread({ ...base, threadId, selection: chosen }, progress), deadline]);
          assert.notEqual(result.isError, true, JSON.stringify(result));
          const returned = record(result.structuredContent);
          assert.equal(result.content?.find(item => item.type === "text")?.text, "Local fixture complete.");
          if (!fork) threadId = returned.threadId;
          const receipt = events.find(event => event.details?.evidence === "turn/start-accepted");
          assert(receipt && receipt.details?.threadId === returned.threadId && receipt.details?.turnId, "Missing correlated adapter acceptance.");
          assert(events.some(event => event.type === "turn" && event.phase === "completed"), "Missing terminal event.");
          assert.equal(requests.length, before + 1, "Unexpected retry or additional provider request.");
          turns.push({ scenario, threadId: returned.threadId, turnId: receipt.details.turnId, sent: receipt.details.sent,
            request: requests.at(-1), response: "local-fixture-complete", terminal: "completed", appliedProcessingTier: "unconfirmed" });
        } finally { if (timer) clearTimeout(timer); }
      };
      await run("new-inherit", { ...selection, serviceTierScope: "turn" }, true);
      await run("persistent-fast", { ...selection, serviceTier: "priority" });
      await run("turn-standard", { ...selection, serviceTier: "default", serviceTierScope: "turn" });
      await run("continue-inherit", { ...selection, serviceTierScope: "turn" });
      await run("legacy-false", selection);
      await run("new-legacy-false", selection, true);
      await run("fork-turn-standard", { ...selection, serviceTier: "default", serviceTierScope: "turn" }, false, true);
      const tier = (index: number) => record(turns[index]?.request).serviceTier ?? null;
      assert(configuredTier === "unset" ? tier(0) === null : tier(0) !== null, "New inheritance must preserve CLI configuration.");
      assert.equal(tier(1), "priority"); assert.equal(tier(2), null); assert.equal(tier(3), tier(1));
      assert.equal(tier(4), null); assert.equal(tier(5), null); assert.equal(tier(6), null);
      assert(turns.every(turn => record(turn.request).model === selection.model && record(turn.request).reasoningEffort === selection.reasoningEffort));
      let newModelSample: Record<string, unknown> | undefined;
      if (version === "codex-cli 0.160.0") {
        const models = parseAppServerModelCatalog(await pool.listModels());
        const advertised = models.find(model => model.id === "gpt-6.1-sol" && !model.hidden);
        newModelSample = { model: "gpt-6.1-sol", catalogAdvertised: Boolean(advertised), entitlement: "unverified" };
        if (advertised) {
          const chosen = { model: advertised.id, reasoningEffort: advertised.defaultReasoningEffort, serviceTierScope: "turn" as const };
          await run("new-sol-standard", { ...chosen, serviceTier: "default" }, true);
          const catalog = { models } as Parameters<typeof speedTierForModel>[0];
          const fastTier = speedTierForModel(catalog, advertised.id, "fast");
          if (fastTier) await run("new-sol-fast", { ...chosen, serviceTier: fastTier }, true);
          newModelSample.fastTier = fastTier || null;
          assert(turns.slice(7).every(turn => record(turn.request).model === chosen.model && record(turn.request).reasoningEffort === chosen.reasoningEffort));
          assert.equal(tier(7), null);
        }
      }
      samples.push({ version, executableSha256, configuredTier, provider: "synthetic-loopback-responses", configVerified: true,
        commercialInference: "not-run", accountEntitlement: "not-queried", networkGuard: "external proxy requests denied",
        blockedExternalAttempts: blocked, ...(newModelSample ? { newModelSample } : {}), turns });
    } finally { await pool.close(); await close(fixture); await close(guard); await rm(root, { recursive: true, force: true }); }
  }
}
const output = path.resolve("output/issue-215-cli-lifecycle.json");
await mkdir(path.dirname(output), { recursive: true });
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceHash = computeSourceHash(path.resolve("."));
await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), sourceCommit, sourceHash, node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch, samples }, null, 2) + "\n");
console.log(JSON.stringify({ output, samples: samples.map(sample => ({ ...record(sample), turns: record(sample).turns?.length })) }, null, 2));
