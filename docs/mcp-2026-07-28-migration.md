# MCP 2026-07-28 migration

This release is a breaking change. The bridge accepts only MCP
**2026-07-28** on HTTP and stdio. It does not negotiate, translate, or retain
an earlier MCP wire contract.

## What changed

- The runtime uses the MCP TypeScript SDK v2 packages and JSON Schema
  2020-12 descriptors.
- HTTP and stdio use the SDK's current handlers with legacy handling explicitly
  rejected.
- `server/discover` advertises only `2026-07-28`. Valid current requests do
  not need an `initialize` round trip.
- The former MCP session registry, `Mcp-Session-Id`, HTTP `GET` notification
  stream, `DELETE` session close, `Last-Event-ID`, and replay path are gone.
- Request metadata and protocol headers are validated by the v2 handler. Tool
  and resource listings use private zero-TTL cache hints so one user's
  installation data is not shared with another caller.
- An absent `Origin` is accepted for the Secure MCP Tunnel and native clients.
  A supplied browser `Origin` must match
  `CODEX_MCP_BRIDGE_ALLOWED_ORIGINS` (or the allowed-host default).

The browser-side MCP Apps `ui/initialize` handshake is a separate UI protocol.
It remains inside the cards and is not an external MCP compatibility path.

## Client action

Reconnect the ChatGPT connector after deploying this release, then use
**Refresh** in its details page so it fetches the current descriptors and
versioned resource URIs. Reopen any card that was mounted from a previous
build. Old tool definitions and retired card URIs are intentionally unavailable.

For an HTTP client, send the 2026-07-28 protocol version and the current
per-request metadata and headers. Do not send a legacy initialization request
or preserve an old session identifier. For stdio, use a current v2 client and
the same protocol version.

## Tool-contract changes

The tool contract is also current-only:

- `codex_models` accepts only `{ "refresh": true }` when a refresh is wanted;
  it always returns the selection policy and permitted model catalog from one
  snapshot.
- `codex_task` requires `taskContractVersion: "3"` and the exact
  `executionEnvelopeRef` advertised by `tools/list`. The task output contract
  is version 2.
- Task, status, and mutation results use a closed structured `nextActions`
  union. A suggested action is either an allow-listed read/opener with validated
  arguments or a non-executable guidance message.
- Obsolete task selectors, model-catalog version switches, cancellation forms,
  tool aliases, and card-only presenters are rejected before they can cause a
  mutation.

`requestId`, project revision checks, selected execution envelope, access
policy, and persisted Activity/Agent/Job data remain part of the bridge's
authorization and idempotency model. An MCP JSON-RPC request ID is not a
replacement for a logical `requestId`.

## Cards

The release catalog contains exactly two active resources, each backed by one
current HTML file:

| Card | Current resource |
| --- | --- |
| Settings | `ui://codex-mcp-bridge/settings/v1.html` |
| Dashboard | `ui://codex-mcp-bridge/dashboard/v1.html` |

`ui-release-catalog.json` has no published-baseline or temporary compatibility
entries. The package selector emits only these resources. Earlier files may
remain in Git history, but the working tree and package contain only
`settings.html` and `dashboard.html`. Compatible changes preserve these URIs;
cache-incompatible changes increment the affected card's explicit URI version.

## Verification and deployment evidence

Run these checks before packaging:

```sh
npm ci --dry-run --ignore-scripts
npm run build
npm test
npm run macos:check
npm run release:check
npx tsx scripts/audit-tool-guidance.ts
npm run mcp:conformance
```

The isolated audit uses a temporary project root, in-memory state, and an
upstream that rejects every execution. It verifies current-protocol discovery,
tool descriptors, and no-execution validation probes without reading operator
credentials or changing an installed bridge.

`npm run mcp:conformance` builds an isolated loopback server, pins
`@modelcontextprotocol/conformance@0.2.0-alpha.11`, and runs its
`2026-07-28` `server-stateless` scenario. It prints a retained temporary
artifact directory; set `MCP_CONFORMANCE_OUTPUT_DIR` to retain it elsewhere.

The command passes an internal fixture flag only to that temporary process.
It enables diagnostic fixture tools there and nowhere in normal bridge startup.
They exercise the suite's required-client-capability, response-stream, logging,
and list-change probes through the same HTTP handler. Normal bridge startup
never enables them, so they cannot appear in a deployed `tools/list` response.
The fixture capability is not part of the bridge's product surface and normal
startup must never advertise it. Ordinary HTTP and stdio integration tests
cover the actual advertised tools and resources, headers, error codes, cache
hints, metadata, and detached-request behavior.

Before publishing, run the connector through a real ChatGPT conversation and
Secure MCP Tunnel, record the current protocol discovery, a tool call, and a
card open. If that host does not accept the new protocol or schema, record it
as a deployment blocker; do not restore a legacy wire or tool contract.
