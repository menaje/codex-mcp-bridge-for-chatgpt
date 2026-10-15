import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const stopped = await call('codex_relay_control', { activityId: job.activityId, stop: 'relay' }); assert.ok(!stopped.isError);
  const status = await call('codex_status', { query: { kind: 'job', id: job.jobId } }); assert.ok(!status.isError);
  const item = status.structuredContent.items[0];
  assert.equal(state.relay.goal(job.activityId)?.monitoringStopped, true);
  process.stdout.write(JSON.stringify({ monitoringStopped: state.relay.goal(job.activityId)?.monitoringStopped, message: item.message, nextActions: item.nextActions }, null, 2) + '\n');
  const done = new Promise<void>(resolve => { const unsubscribe = registry.subscribeChanges(() => { if (state.listJobs().find((value: any) => value.jobId === job.jobId)?.status === 'completed') { unsubscribe(); resolve(); } }); });
  release!({ structuredContent: { threadId, content: 'Synthetic result' }, content: [{ type: 'text', text: 'Synthetic result' }] }); await done;
  assert.deepEqual(state.relay.pending(job.activityId), []);
} finally {
  release!({ content: [{ type: 'text', text: 'Synthetic result' }] }); await client.close(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  state.close(); CodexJobRegistry.prototype.start = originalStart; rmSync(dir, { recursive: true, force: true });
}
