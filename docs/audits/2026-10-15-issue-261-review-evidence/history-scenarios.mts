import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeStateStore } from '/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix/src/stateStore.ts';

let cases = 0;
function setup(file = ':memory:') {
  const state = new BridgeStateStore({ file });
  const scopeId = randomUUID(), activity = state.createActivity({ scopeId, completionTrigger: 'manual' });
  const owner = { scopeId, mcpPrincipal: 'independent-review-owner' }, card = randomUUID();
  const input = { interactionId: randomUUID(), kind: 'user-input', origin: 'codex-question', questions: [{ id: 'a', question: 'Private fixture question' }] };
  const job: any = { jobId: randomUUID(), requestId: randomUUID(), scopeId, mcpPrincipal: owner.mcpPrincipal, activityId: activity.activityId,
    cwd: '/tmp', sandbox: 'read-only', completionDeliveryPolicy: 'relay-card', status: 'running', trackingState: 'connected',
    workerId: 'same-worker', workerGeneration: 8, threadId: randomUUID(), version: 1, createdAt: Date.now(), updatedAt: Date.now(), pendingInteractions: [input] };
  state.upsertJob(job); state.relay.connect(activity.activityId, owner, card);
  return { state, owner, activity, card, job, input };
}
function enter(f: ReturnType<typeof setup>, outcome: 'accepted'|'unknown'|'rejected'|'sending') {
  const event = f.state.relay.registration(f.job.jobId)!.event!, attempt = randomUUID();
  assert.equal(f.state.relay.claim(f.activity.activityId, f.owner, f.card, event.eventId, attempt)?.state, 'leased');
  assert.equal(f.state.relay.enter(f.activity.activityId, f.owner, f.card, event.eventId, attempt), true);
  if (outcome !== 'sending') f.state.relay.acknowledge(f.activity.activityId, f.owner, f.card, event.eventId, attempt, outcome);
  return structuredClone(f.state.relay.registration(f.job.jobId)!.event!);
}
for (const outcome of ['accepted', 'unknown', 'sending', 'rejected'] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), 'independent-relay-history-')), file = path.join(dir, 'state.sqlite');
  const f = setup(file); let state = f.state;
  try {
    const before = enter(f, outcome), historyKey = `relay_event_history_v1/${f.job.jobId}/${before.eventId}`;
    state.upsertJob({ ...f.job, version: 2, pendingInteractions: [] });
    assert.deepEqual(JSON.parse(state.getMeta(historyKey)!), before);
    state.upsertJob({ ...f.job, version: 3, pendingInteractions: [{ ...f.input, interactionId: 'replacement' }] });
    state.close(); state = new BridgeStateStore({ file });
    state.upsertJob({ ...f.job, version: 4 });
    assert.deepEqual(state.relay.registration(f.job.jobId)!.event, before);
    assert.equal(state.getMeta(historyKey), undefined);
    const newCard = randomUUID(), newAttempt = randomUUID(); state.relay.connect(f.activity.activityId, f.owner, newCard);
    assert.deepEqual(state.relay.pending(f.activity.activityId), []);
    assert.equal(state.relay.claim(f.activity.activityId, f.owner, newCard, before.eventId, newAttempt), undefined);
    assert.equal(state.relay.enter(f.activity.activityId, f.owner, newCard, before.eventId, newAttempt), false);
    assert.throws(() => state.relay.claim(f.activity.activityId, { ...f.owner, mcpPrincipal: 'foreign' }, newCard, before.eventId, newAttempt), /OWNER_REQUIRED/);
    state.relay.stop(f.activity.activityId, f.owner, 'relay');
    state.upsertJob({ ...f.job, version: 5, pendingInteractions: [] }); state.upsertJob({ ...f.job, version: 6 });
    assert.deepEqual(state.relay.pending(f.activity.activityId), []);
    assert.equal(state.relay.connect(f.activity.activityId, f.owner, randomUUID()).monitoringStopped, true);
    cases++;
  } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
}
for (const trackingState of ['liveness-unknown', 'worker-lost', 'orphaned']) {
  for (const outcome of ['accepted', 'unknown', 'sending'] as const) {
    const f = setup();
    try {
      const before = enter(f, outcome);
      f.state.upsertJob({ ...f.job, version: 2, trackingState });
      assert.deepEqual(f.state.relay.registration(f.job.jobId)!.event, before);
      assert.equal(f.state.relay.registration(f.job.jobId)!.paused, true);
      assert.deepEqual(f.state.listMeta(`relay_ready_v1/${f.activity.activityId}/`, 64), []);
      assert.throws(() => f.state.relay.enter(f.activity.activityId, f.owner, f.card, before.eventId, before.attemptId!), /PAUSED/);
      f.state.upsertJob({ ...f.job, version: 3 });
      assert.deepEqual(f.state.relay.registration(f.job.jobId)!.event, before);
      assert.deepEqual(f.state.relay.pending(f.activity.activityId), []);
      cases++;
    } finally { f.state.close(); }
  }
}
{
  const f = setup();
  try {
    const before = enter(f, 'accepted'), historyKey = `relay_event_history_v1/${f.job.jobId}/${before.eventId}`;
    const replacement = { ...f.job, version: 2, pendingInteractions: [{ ...f.input, interactionId: 'other' }] };
    assert.throws(() => f.state.transaction(() => { f.state.upsertJob(replacement); throw new Error('archive-rollback'); }), /archive-rollback/);
    assert.deepEqual(f.state.relay.registration(f.job.jobId)!.event, before); assert.equal(f.state.getMeta(historyKey), undefined);
    f.state.upsertJob(replacement); const other = f.state.relay.registration(f.job.jobId)!.event;
    assert.throws(() => f.state.transaction(() => { f.state.upsertJob({ ...f.job, version: 3 }); throw new Error('restore-rollback'); }), /restore-rollback/);
    assert.deepEqual(f.state.relay.registration(f.job.jobId)!.event, other); assert.deepEqual(JSON.parse(f.state.getMeta(historyKey)!), before);
    f.state.upsertJob({ ...f.job, version: 3 }); assert.deepEqual(f.state.relay.registration(f.job.jobId)!.event, before); cases++;
  } finally { f.state.close(); }
}
{
  const f = setup();
  try {
    for (let n = 1; n < 65; n++) f.state.upsertJob({ ...f.job, jobId: randomUUID(), requestId: randomUUID() });
    let reads = 0, transactions = 0;
    const snapshot = f.state.getRelayJobSnapshot.bind(f.state), transaction = f.state.transaction.bind(f.state);
    f.state.getRelayJobSnapshot = (id: string) => { reads++; return snapshot(id); };
    f.state.transaction = ((operation: any) => { transactions++; return transaction(operation); }) as any;
    const cursor = f.state.relay.recover(f.activity.activityId);
    assert.equal(reads, 32); assert.equal(transactions, 0); assert.ok(cursor);
    reads = 0; const second = f.state.relay.recover(f.activity.activityId, cursor!); assert.equal(reads, 32); assert.ok(second);
    reads = 0; assert.equal(f.state.relay.recover(f.activity.activityId, second!), null); assert.equal(reads, 1); assert.equal(transactions, 0);
    reads = 0; assert.equal(f.state.relay.pending(f.activity.activityId).length, 64); assert.equal(reads, 64); assert.equal(transactions, 0); cases++;
  } finally { f.state.close(); }
}
process.stdout.write(`PASS: ${cases} independent disposable functional scenarios (no time manipulation or external execution).\n`);
