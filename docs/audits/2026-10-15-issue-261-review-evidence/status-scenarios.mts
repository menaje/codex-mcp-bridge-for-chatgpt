import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/config.ts';
import { createHttpServer } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/server.ts';
import { BridgeStateStore } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/stateStore.ts';
import { UserSettingsStore } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/userSettings.ts';
import { CodexJobRegistry } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/tools.ts';
const require = createRequire('/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/package.json');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const expectedSha = 'd290d9bb3e8117d2352f13361a52b2deb42eb539';
const actualSha = execFileSync('git', ['-C', '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(actualSha, expectedSha);
const scenario = process.argv[2] || 'relay';
assert.ok(['enabled', 'relay', 'followups', 'ended', 'paused', 'unregistered'].includes(scenario));
const dir = mkdtempSync(path.join(tmpdir(), 'independent-relay-status-'));
const file = path.join(dir, 'state.sqlite'), state = new BridgeStateStore({ file });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: '1', CODEX_MCP_BRIDGE_ROOTS: dir, CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file, CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(dir, 'models.json') });
const selection = { model: 'gpt-5.6-sol', reasoningEffort: 'medium' }, settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ modelPolicy: { mode: 'fixed', selection, constraints: { allowDelegation: false } } }, settings.current.revision);
settings.updateWithProjectOperations({}, [{ kind: 'add', project: { name: 'Fixture', cwd: dir } }], undefined, settings.current.registryRevision);
let release: (value: any) => void, started: () => void, registry: any;
const terminal = new Promise(resolve => { release = resolve; }), assignment = new Promise<void>(resolve => { started = resolve; });
const threadId = randomUUID(), upstream: any = {
  async listTools() { return { tools: [{ name: 'codex' }, { name: 'codex-reply' }] }; },
  async callTool(_name: string, _args: any, _progress: any, assigned: any) {
    assigned?.({ backendKind: 'app-server', workerId: 'disposable-fixture-worker', workerGeneration: 1, threadId, upstreamRequestId: 'fixture-turn' }); started(); return terminal;
  }, async close() {}
};
const catalog: any = { async getCatalog() { return this.getCachedCatalog(); }, getCachedCatalog() { return { source: 'codex-cli', fetchedAt: '2026-10-13T00:00:00Z', validatedAt: '2026-10-13T00:00:00Z', fingerprint: 'f'.repeat(64), cached: true, stale: false, validation: 'valid', models: [{ id: selection.model, displayName: 'Fixture Sol', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium' }], serviceTiers: [], inputModalities: ['text'] }] }; } };
const originalStart = CodexJobRegistry.prototype.start;
CodexJobRegistry.prototype.start = function(...args: any[]) { registry = this; return originalStart.apply(this, args as any); };
const server = createHttpServer(config, upstream, catalog, { stateStore: state });
const client = new Client({ name: 'independent-review-fixture', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp`)));
  const metadata = { 'openai/session': 'disposable-independent-status' }, call = (name: string, args: any) => client.callTool({ name, arguments: args, _meta: metadata });
  const task = (await client.listTools()).tools.find((tool: any) => tool.name === 'codex_task'), properties = task.inputSchema.properties, project = settings.current.projects[0];
  const admission = await call('codex_task', { taskContractVersion: properties.taskContractVersion.const, executionEnvelopeRef: properties.executionEnvelopeRef.const, requestId: randomUUID(), prompt: 'Synthetic independent status check', project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision } });
  assert.ok(!admission.isError, JSON.stringify(admission)); const job = admission.structuredContent;
  await assignment;
  if (scenario === 'relay' || scenario === 'followups') {
    const stopped = await call('codex_relay_control', { activityId: job.activityId, stop: scenario }); assert.ok(!stopped.isError);
  } else if (scenario === 'ended') {
    state.transaction(() => state.relay.endActivity(job.activityId));
  } else if (scenario === 'paused') {
    const source = registry.get(job.jobId); source.trackingState = 'worker-lost';
    source.pendingInteractions = [{ interactionId: 'fixture-question', kind: 'user-input', origin: 'codex-question', questions: [{ id: 'choice', header: 'Choice', question: 'Synthetic fixture input' }] }];
    source.version += 1; state.upsertJob(source);
  } else if (scenario === 'unregistered') state.transaction(() => state.relay.forgetJob(job.jobId));
  const status = await call('codex_status', { query: { kind: 'job', id: job.jobId } }); assert.ok(!status.isError);
  const item = status.structuredContent.items[0];
  const guidance = JSON.stringify(item.nextActions);
  assert.equal(item.state, 'running'); assert.equal(item.completionDeliveryPolicy, 'relay-card');
  assert.ok(!item.message.includes('direct result delivery'));
  const expected = scenario === 'relay' ? 'Automatic relay is stopped' : scenario === 'ended' ? 'automatic relay is closed' :
    scenario === 'paused' ? 'Automatic relay of the current input is paused' : scenario === 'unregistered' ? 'no active relay registration' : 'Automatic relay is enabled';
  assert.ok(item.message.includes(expected), item.message); assert.ok(guidance.includes(expected), guidance);
  if (scenario === 'followups') { assert.ok(item.message.includes('Future followup admission is stopped')); assert.ok(guidance.includes('Future followup admission is stopped')); }
  if (scenario === 'relay' || scenario === 'ended') { assert.ok(!item.message.includes('relay is enabled')); assert.ok(!guidance.includes('remains connected')); }
  if (scenario === 'enabled' || scenario === 'followups') { assert.ok(item.message.includes('while its host connection is available')); assert.ok(guidance.includes('while its host connection is available')); }
  process.stdout.write(JSON.stringify({ reviewedSha: actualSha, scenario, goal: state.relay.goal(job.activityId), message: item.message, nextActions: item.nextActions }, null, 2) + '\n');
  const done = new Promise<void>(resolve => { const unsubscribe = registry.subscribeChanges(() => { if (state.listJobs().find((value: any) => value.jobId === job.jobId)?.status === 'completed') { unsubscribe(); resolve(); } }); });
  release!({ structuredContent: { threadId, content: 'Synthetic result' }, content: [{ type: 'text', text: 'Synthetic result' }] }); await done;
  assert.equal(state.relay.pending(job.activityId).length, scenario === 'relay' || scenario === 'ended' ? 0 : 1);
  process.stdout.write(`PASS: ${scenario} status, next actions and terminal notice eligibility.\n`);
} finally {
  release!({ content: [{ type: 'text', text: 'Synthetic result' }] }); await client.close(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  state.close(); CodexJobRegistry.prototype.start = originalStart; rmSync(dir, { recursive: true, force: true });
}
