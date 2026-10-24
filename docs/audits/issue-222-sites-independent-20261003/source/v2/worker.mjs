// Owner-private #222 fixture; Sites dispatch owns access enforcement.
// Service-token access is only for this fixed non-user payload, never for
// visitor identity, connected-app consent, or local execution authority.
const fixture = Object.freeze({ probe: 'issue-222', phase: 'A', value: 222 });
const key = 'issue-222-independent-20261003';
const payloadJson = JSON.stringify(fixture);
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
    persisted: Boolean(row), storage: 'D1', localChannel: false, workerVersion: '2' };
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
    if (q.method === 'initialize') return result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'issue-222-harmless-fixture', version: '2' } });
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
