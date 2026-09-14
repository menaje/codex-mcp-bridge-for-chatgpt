// Audit snapshot for 2026-09-14. Uses temporary state and a mock upstream; does not call a real model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.ts';
import { createHttpServer } from '../../src/server.ts';
import { BridgeStateStore } from '../../src/stateStore.ts';
import { UserSettingsStore } from '../../src/userSettings.ts';

const report: any = {
  date: new Date().toISOString(), protocol: '2026-07-28', upstream: 'manually resolved mock; no Codex/model calls',
  sourceSnapshot: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).trim() },
  cardsOpened: 0, realChatGptTested: false, checks: []
};
const selection = { model: 'gpt-5.6-sol', reasoningEffort: 'medium' };
const snapshot = {
  source: 'codex-cli', fetchedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
  fingerprint: 'f'.repeat(64), cached: true, stale: false, validation: 'valid',
  models: [{ id: selection.model, displayName: 'Mock', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ effort: 'medium' }], isDefault: true, serviceTiers: [], inputModalities: ['text'] }]
};
const gates: any[] = [];
const upstream = {
  listTools: async () => ({ tools: [{ name: 'codex' }] }),
  callTool: async (name: string, args: any) => {
    const index = gates.length + 1;
    let release!: () => void;
    const waiting = new Promise<void>(r => { release = r; });
    gates.push({ name, release, index, prompt: args.prompt });
    await waiting;
    return { structuredContent: { threadId: args.threadId || args['thread-id'] || `mock-thread-${index}`, content: `mock_result_${index}` },
      content: [{ type: 'text', text: `mock_result_${index}` }] };
  },
  close: async () => {}
};
async function until(predicate: () => boolean, title: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${title}`); await delay(10); }
}
const root = await mkdtemp(path.join(tmpdir(), 'cardless-delivery-runtime-'));
const state = new BridgeStateStore({ file: path.join(root, 'state.sqlite') });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: '1', CODEX_MCP_BRIDGE_ROOTS: root,
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, 'state.sqlite'),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, 'models.json') });
const settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ activityCardVisibility: 'never', completionHandoff: 'off', modelPolicy: {
  mode: 'automatic', constraints: { allowDelegation: false }, allowedSelections: { kind: 'explicit', selections: [selection] }
} }, settings.current.revision);
settings.updateWithProjectOperations({}, [{ kind: 'add', project: { name: 'Mock', cwd: root } }], undefined, settings.current.registryRevision);
const bridge = createHttpServer(config, upstream as any, { getCatalog: async () => snapshot, getCachedCatalog: () => snapshot } as any, { stateStore: state });
const client = new Client({ name: 'cardless-delivery-probe', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
const calls: string[] = [];
try {
  await new Promise<void>(r => bridge.listen(0, '127.0.0.1', r));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(bridge.address() as any).port}/mcp`)));
  const descriptor = (await client.listTools()).tools.find(x => x.name === 'codex_task')!;
  const properties = descriptor.inputSchema.properties as any;
  const project = settings.current.projects[0]!;
  const metadata = { 'openai/session': 'cardless-delivery-probe' };
  const call = async (name: string, args: any) => { calls.push(name); return await client.callTool({ name, arguments: args, _meta: metadata }); };
  const taskArgs = (executionMode: string) => ({ requestId: randomUUID(),
    taskContractVersion: properties.taskContractVersion.const, executionEnvelopeRef: properties.executionEnvelopeRef.const,
    prompt: 'Return the isolated mock result.', project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
    selection, executionMode });

  let foregroundSettled = false;
  const foreground = call('codex_task', taskArgs('foreground')).then(x => { foregroundSettled = true; return x; });
  await until(() => gates.length === 1 || foregroundSettled, 'foreground admitted');
  assert.equal(foregroundSettled, false);
  gates[0].release();
  const fg = await foreground;
  assert.notEqual(fg.isError, true, JSON.stringify(fg));
  assert.equal((fg.structuredContent as any).state, 'completed');
  assert.equal((fg.structuredContent as any).answer, 'mock_result_1');
  assert.equal((fg._meta as any)?.['openai/outputTemplate'], undefined);
  report.checks.push({ name: 'foreground_without_cards', passed: true, remainedPendingUntilMockFinished: true,
    output: { state: (fg.structuredContent as any).state, answer: (fg.structuredContent as any).answer } });

  const freshBackground = await call('codex_task', taskArgs('background'));
  assert.equal(freshBackground.isError, true);
  assert(JSON.stringify(freshBackground).includes('An admitted Job result requires its current identity and execution fields.'));
  await until(() => gates.length === 2, 'background admitted');
  gates[1].release();
  await delay(100);
  report.observedProblems = [{ name: 'fresh_background_before_thread_assignment',
    outputValidationRejected: true, executionStillAdmitted: true, error: freshBackground.content,
    note: 'Mock delays upstream assignment; code creates a running Job with no threadId and immediately projects it. Must fix startup contract before relying on new background Jobs.' }];
  const continuedBackgroundArgs = () => ({ ...taskArgs('background'),
    agent: { mode: 'existing', id: (fg.structuredContent as any).agentId, context: 'continue' } });
  const bg = await call('codex_task', continuedBackgroundArgs());
  assert.notEqual(bg.isError, true, JSON.stringify(bg));
  assert.equal((bg.structuredContent as any).state, 'running');
  const jobId = (bg.structuredContent as any).jobId;
  await until(() => gates.length === 3, 'known-thread background admitted');
  let waitedSettled = false;
  const waited = call('codex_status', { query: { kind: 'job', id: jobId, waitFor: 'terminal', waitMs: 3000 } }).then(x => { waitedSettled = true; return x; });
  await delay(60);
  assert.equal(waitedSettled, false);
  gates[2].release();
  const result = await waited;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert(JSON.stringify(result).includes('mock_result_3'), JSON.stringify(result));
  report.checks.push({ name: 'background_and_bounded_status_without_cards', passed: true,
    returnedBeforeCompletion: true, statusWaitReturnedFinalResult: true, output: result.structuredContent });

  const late = await call('codex_task', continuedBackgroundArgs());
  assert.notEqual(late.isError, true, JSON.stringify(late));
  await until(() => gates.length === 4, 'detached background admitted');
  gates[3].release();
  await delay(100);
  const laterRead = await call('codex_status', { query: { kind: 'job', id: (late.structuredContent as any).jobId } });
  assert(JSON.stringify(laterRead).includes('mock_result_4'), JSON.stringify(laterRead));
  assert.equal(state.listCompletionOutbox().length, 0);
  report.checks.push({ name: 'background_result_retained_after_task_return', passed: true,
    retrievedByLaterExactJobRead: true, automaticHandoffEventsForDefaultActivity: 0 });

  const subscription = await client.listen({ resourceSubscriptions: ['codex-result://mock/complete'] }, { timeout: 2000 });
  report.currentBridge = { capabilities: client.getServerCapabilities(), honoredCompletionResourceFilter: subscription.honoredFilter };
  await subscription.close();
  report.bridgeToolCalls = calls;
} finally {
  for (const gate of gates) gate.release();
  await client.close().catch(() => {});
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  state.close();
  await rm(root, { recursive: true, force: true });
}

const uri = 'codex-result://mock/complete';
let latest = { completed: false };
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'cardless-subscription-fixture', version: '1' },
    { capabilities: { resources: { subscribe: true } }, supportedProtocolVersions: ['2026-07-28'] });
  server.registerResource('mock-completion', uri, { mimeType: 'application/json' }, async () => ({
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(latest) }]
  }));
  return server;
}, { legacy: 'reject' });
const subscriber = new Client({ name: 'isolated-subscription-consumer', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
const notifications: any[] = [];
try {
  subscriber.setNotificationHandler('notifications/resources/updated', n => { notifications.push(n); });
  await subscriber.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: async (input, init) => handler.fetch(new Request(input, init))
  }));
  const sub = await subscriber.listen({ resourceSubscriptions: [uri] }, { timeout: 2000 });
  assert.deepEqual(sub.honoredFilter.resourceSubscriptions, [uri]);
  latest = { completed: true };
  handler.notify.resourceUpdated('codex-result://different-scope/complete');
  handler.notify.resourceUpdated(uri);
  await until(() => notifications.length === 1, 'matching resource notification');
  const resource = await subscriber.readResource({ uri });
  assert.equal(JSON.parse((resource.contents[0] as any).text).completed, true);
  report.checks.push({ name: 'sdk_cardless_subscription_transport', passed: true,
    matchingResourceNotifications: notifications.length, unrelatedUriFiltered: true, resultReadSucceeded: true,
    chatGptWakeTested: false, note: 'SDK client received a resource update; this does not prove ChatGPT resumes a conversation.' });
  await sub.close();
} finally { await subscriber.close().catch(() => {}); await handler.close(); }
report.probeAssertionsPassed = true;
await writeFile(new URL('./cardless-delivery-probe-2026-09-14.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
