# MCP 2026-07-28 hardening validation

Date: 2026-09-14 (Asia/Seoul)

> Superseded as the candidate acceptance record by
> [`mcp-2026-07-28-verification-2026-09-14.md`](mcp-2026-07-28-verification-2026-09-14.md),
> which covers the later integration with the cardless `dev` UI-resource
> surface. The observations below are retained as the pre-integration
> checkpoint and must not be used to assess the current candidate.

## Scope

This record covers the remaining hardening work after the current-only MCP
replacement in issues #105 and #106. It does not prepare, tag, publish, or
promote a release. The package version remains `0.4.1`.

The changes add a fail-closed boundary between MCP protocol `_meta` and
bridge-private UI hydration, reject lossy non-JSON structured results, make
resource registration deterministic, and make missing and foreign Job,
Activity, Agent, and thread handles indistinguishable to a caller outside the
owning conversation scope. A disconnected foreground HTTP request is recorded
as detached and does not request Job cancellation.

## Current-protocol checks

An isolated development server from the current source was checked with:

```sh
npx -y @modelcontextprotocol/conformance@0.2.0-alpha.11 server \
  --url http://127.0.0.1:18878/mcp \
  --spec-version 2026-07-28 \
  --scenario server-stateless \
  --output-dir /tmp/codex-mcp-conformance-current-20260914
```

The scenario passed 24 of 28 checks. The four reported failures are explicitly
`Not testable`: the suite requires its own advertised diagnostic tools
`test_missing_capability`, `test_streaming_elicitation`, and
`test_logging_tool`. The bridge intentionally does not advertise those tools
or the optional capabilities they exercise. Adding production-visible test
tools solely to change this fixture result would alter the product contract.

The passed checks include per-request `_meta`, `server/discover`, optional
client identity, server identity metadata, header/body consistency, protocol
version rejection, removed-method rejection, subscription acknowledgement and
filtering, and JSON-RPC error IDs.

## Local regression evidence

These commands passed against the current source:

```sh
npx tsc -p tsconfig.json --noEmit
npm run app-server:compat:check
npx vitest run --maxWorkers=1 test/server.test.ts test/tools.test.ts
npm test -- --run test/outputContracts.test.ts \
  -t 'allows every JSON root|keeps MCP metadata'
git diff --check
```

The serial HTTP and tool-contract run completed 14 tests. It includes two
scope-isolation comparisons for every public handle kind and mutation path,
and a detached HTTP task call that reaches terminal completion after the client
has aborted its response.

The isolated clean hardening commit `a692158` also passed `npm run build`, the
complete 81-file/687-test suite, the tool-guidance audit, and App Server schema
compatibility before it was applied to the shared working tree.

## Shared working-tree boundary

The shared working tree contains a separate in-progress removal of Activity and
question card behavior. Its generated UI inventory and old tests have not yet
been reconciled. Consequently, its full `npm test` currently reports 16
failures in Activity-card, UI-resource, launcher, and release-manifest tests;
`npm run build` stops at `release:check` with Activity-card UI resource drift.
These failures predate and are outside the MCP hardening boundary. The changes
above were validated separately and were not used to restore retired cards or
legacy MCP behavior.

## Live-host acceptance

The installed local bridge still rejects `2026-07-28` and advertises only older
protocol revisions. It therefore cannot serve as evidence for the current
source. This validation did not interrupt that installed bridge or redirect its
Secure MCP Tunnel. A real ChatGPT discovery, tool call, and card-open run
remains a deployment acceptance gate for a build that contains these changes;
it does not justify reintroducing a legacy wire fallback.
