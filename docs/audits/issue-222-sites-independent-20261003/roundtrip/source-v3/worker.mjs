// Owner-private #222 fixture; Sites dispatch owns access enforcement.
// Service-token access is only for this fixed non-user payload, never for
// visitor identity, connected-app consent, or local execution authority.
const fixture = Object.freeze({ probe: 'issue-222', phase: 'A', value: 222 });
const key = 'issue-222-independent-20261003';
const payloadJson = JSON.stringify(fixture);
const trialKey = 'issue-222-pull-roundtrip-20261003';
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const tools = [{
  name: 'read_fixture', description: 'Read the fixed harmless D1 fixture and its stored digest',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
async function readFixture(env) {
  if (!env.DB) throw new Error('D1 unavailable');
  const row = await env.DB.prepare('SELECT payload_json, payload_sha256, created_at FROM issue_222_fixtures WHERE fixture_key = ?').bind(key).first();
  const count = await env.DB.prepare('SELECT COUNT(*) AS key_count FROM issue_222_fixtures WHERE fixture_key = ?').bind(key).first();
  return { key, count: count.key_count, fixture: row ? JSON.parse(row.payload_json) : null,
    payloadSha256: row?.payload_sha256 ?? null, createdAt: row?.created_at ?? null,
    persisted: Boolean(row), storage: 'D1', localChannel: false, workerVersion: '3',
    roundtrip: await readRoundtripSummary(env) };
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function readRoundtripSummary(env) {
  // SELECT only. Reading never enqueues, claims, dispatches, or acknowledges.
  const row = await env.DB.prepare('SELECT state, command_sha256, response_sha256, response_json FROM issue_222_roundtrips WHERE trial_key = ?').bind(trialKey).first();
  const response = row?.response_json ? JSON.parse(row.response_json) : null;
  return { mode: 'explicit-one-shot-pull', status: row?.state ?? 'not-started',
    commandId: row ? trialKey : null, requestDigest: row?.command_sha256 ?? null,
    responseDigest: row?.response_sha256 ?? null, executionCount: response?.localExecutionCount ?? null,
    executionCountBasis: 'local-handler report validated and persisted in the ACK; independent local log is separate evidence',
    resultMatchesFixture: response ? JSON.stringify(response.fixture) === payloadJson && response.payloadSha256 === await digest(payloadJson) : null,
    cloudToLocalPush: false, persistentPolling: false };
}
async function fixedCommand(env) {
  const stored = await readFixture(env);
  if (!stored.persisted || stored.count !== 1 || JSON.stringify(stored.fixture) !== payloadJson || stored.payloadSha256 !== await digest(payloadJson)) throw new Error('Original fixture mismatch');
  return { trialKey, operation: 'read_fixture', fixtureKey: key, payloadSha256: stored.payloadSha256 };
}
async function roundtripState(env) {
  const row = await env.DB.prepare('SELECT * FROM issue_222_roundtrips WHERE trial_key = ?').bind(trialKey).first();
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM issue_222_roundtrips WHERE trial_key = ?').bind(trialKey).first();
  return { trialKey, count: count.count, transport: 'explicit-one-shot-pull', cloudToLocalPush: false,
    state: row?.state ?? 'absent', command: row ? JSON.parse(row.command_json) : null,
    commandSha256: row?.command_sha256 ?? null, response: row?.response_json ? JSON.parse(row.response_json) : null,
    responseSha256: row?.response_sha256 ?? null, createdAt: row?.created_at ?? null,
    claimedAt: row?.claimed_at ?? null, ackedAt: row?.acked_at ?? null };
}
async function roundtripRequest(request, env, path) {
  if (path === '/roundtrip/status' && request.method === 'GET') return json(await roundtripState(env));
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid-json' }, 400); }
  if (path === '/roundtrip/enqueue' || path === '/roundtrip/claim') {
    if (JSON.stringify(body) !== '{}') return json({ error: 'no-arguments-allowed' }, 400);
    if (path === '/roundtrip/enqueue') {
      const commandJson = JSON.stringify(await fixedCommand(env));
      const result = await env.DB.prepare('INSERT OR IGNORE INTO issue_222_roundtrips (trial_key, state, command_json, command_sha256, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(trialKey, 'queued', commandJson, await digest(commandJson), new Date().toISOString()).run();
      return json({ inserted: result.meta.changes === 1, ...await roundtripState(env) });
    }
    const result = await env.DB.prepare('UPDATE issue_222_roundtrips SET state = ?, claimed_at = ? WHERE trial_key = ? AND state = ?')
      .bind('claimed', new Date().toISOString(), trialKey, 'queued').run();
    return json({ claimed: result.meta.changes === 1, ...await roundtripState(env) }, result.meta.changes === 1 ? 200 : 409);
  }
  if (path === '/roundtrip/ack') {
    const state = await roundtripState(env);
    if (!state.command || Object.keys(body ?? {}).length !== 1) return json({ error: 'invalid-response' }, 400);
    const expected = { trialKey, operation: 'read_fixture', fixtureKey: key, fixture,
      payloadSha256: await digest(payloadJson), commandSha256: state.commandSha256, localExecutionCount: 1 };
    const responseJson = JSON.stringify(body.response);
    if (responseJson !== JSON.stringify(expected)) return json({ error: 'response-mismatch' }, 400);
    if (state.state === 'acked') return json({ accepted: true, duplicate: true, ...state });
    const result = await env.DB.prepare('UPDATE issue_222_roundtrips SET state = ?, response_json = ?, response_sha256 = ?, acked_at = ? WHERE trial_key = ? AND state = ?')
      .bind('acked', responseJson, await digest(responseJson), new Date().toISOString(), trialKey, 'claimed').run();
    return json({ accepted: result.meta.changes === 1, duplicate: false, ...await roundtripState(env) }, result.meta.changes === 1 ? 200 : 409);
  }
  return json({ error: 'not-found' }, 404);
}
async function writeFixture(env) {
  if (!env.DB) throw new Error('D1 unavailable');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadJson));
  const sha256 = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  const result = await env.DB.prepare('INSERT OR IGNORE INTO issue_222_fixtures (fixture_key, payload_json, payload_sha256, created_at) VALUES (?, ?, ?, ?)')
    .bind(key, payloadJson, sha256, new Date().toISOString()).run();
  const stored = await readFixture(env);
  return { accepted: true, persisted: stored.persisted, inserted: result.meta.changes === 1, ...stored };
}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('Owner-private, harmless #222 persistent fixture.');
  try {
    if (['/roundtrip/enqueue', '/roundtrip/claim', '/roundtrip/ack', '/roundtrip/status'].includes(path)) return await roundtripRequest(request, env, path);
    if ((path === '/metadata' || path === '/fixture') && request.method === 'GET') return json(await readFixture(env));
    if (path === '/ingest' && request.method === 'POST') {
      let value;
      try { value = await request.json(); } catch { return json({ accepted: false }, 400); }
      if (JSON.stringify(value) !== payloadJson) return json({ accepted: false }, 400);
      return json(await writeFixture(env));
    }
    if (path !== '/mcp') return json({ error: 'not-found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    let q;
    try { q = await request.json(); } catch { return json({ error: 'invalid-json' }, 400); }
    const result = value => json({ jsonrpc: '2.0', id: q.id, result: value });
    if (q.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (q.method === 'initialize') return result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'issue-222-harmless-fixture', version: '3' } });
    if (q.method === 'tools/list') return result({ tools });
    if (q.method === 'tools/call' && q.params?.name === 'read_fixture') {
      if (Object.keys(q.params.arguments ?? {}).length) return json({ jsonrpc: '2.0', id: q.id, error: { code: -32602, message: 'No arguments allowed' } });
      const stored = await readFixture(env);
      return result({ content: [{ type: 'text', text: JSON.stringify(stored) }], structuredContent: stored });
    }
    return json({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'Method not found' } });
  } catch {
    return json({ error: 'fixture-storage-unavailable' }, 503);
  }
} };
