// Compiled-product boundary check. Synthetic temporary state only; no Job execution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../../../dist/config.js';
import { BridgeStateStore } from '../../../dist/stateStore.js';
import { createIsolatedHttpServer } from '../../../dist/runtimeProcess.js';
const root = await mkdtemp(path.join(tmpdir(), 'bridge-w3-compiled-'));
const file = path.join(root, 'state.sqlite'), scopeId = randomUUID();
const seed = new BridgeStateStore({ file });
const activity = seed.createActivity({ scopeId, handoffPolicy: 'notify', completionTrigger: 'manual' });
seed.close();
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_') && !key.startsWith('OPENAI_') && key !== 'HOME'));
const environment = { ...inherited, HOME: root, CODEX_HOME: path.join(root, 'codex'),
  CODEX_MCP_BRIDGE_NO_AUTH: '1', CODEX_MCP_BRIDGE_HOST: '127.0.0.1', CODEX_MCP_BRIDGE_CODEX: '/usr/bin/false',
  CODEX_MCP_BRIDGE_ROOTS: root, CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, 'runtime'),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file, CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, 'telemetry.sqlite'),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, 'models.json'), CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, 'skills') };
let server;
const client = new Client({ name: 'W3-compiled', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
let off;
try {
  server = await createIsolatedHttpServer(loadConfig(environment), { childEnvironment: environment });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const service = server.applicationService;
  assert.deepEqual(await service.nativeCompletionAvailability(), { available: false });
  const topics = [];
  off = service.subscribeChanges(topic => topics.push(topic));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'codex_activity_update', arguments: {
    scopeId, activityId: activity.activityId, expectedVersion: activity.version, operation: { kind: 'complete' } } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  for (let i = 0; i < 100 && !topics.includes('completion-outbox-ready'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(topics.filter(topic => topic === 'completion-outbox-ready').length, 1);
  assert.equal((await service.nativeCompletionAvailability()).available, true);
  const owner = randomUUID(), events = await service.claimNativeCompletionNotifications({ limit: 10, leaseOwner: owner });
  assert.equal(events.length, 1);
  await service.releaseNativeCompletionNotifications({ outboxIds: events.map(event => event.outboxId), leaseOwner: owner });
  const availability = await service.nativeCompletionAvailability();
  assert.equal(availability.available, false);
  assert.ok(availability.nextAvailableAt > Date.now());
  assert.equal(topics.filter(topic => topic === 'completion-outbox-ready').length, 1);
  console.log(JSON.stringify({ sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    assertions: 7, readinessNotices: 1, claims: 1, releases: 1, retryDeferred: true, jobExecutions: 0,
    path: 'compiled server -> state owner child -> application change IPC -> supervisor', result: 'passed' }, null, 2));
} finally {
  off?.(); await client.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
