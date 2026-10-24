# Issue #141 — Decision Card retirement

## Scope and decision

The former Decision Card was a complete implementation, verified in #127,
#131, and #132. Issue #129 had no independent study participants and was closed
without a user-effect conclusion. Issue #141 retires the feature because its
restricted embedded UI and continued runtime, security, and storage work did
not justify maintaining it. GPT may instead give the user a standalone,
self-contained HTML file; the user sends any chosen summary back to the same
conversation. The file has no Bridge authority.

The retirement removes `codex_decision`, `codex_decision_result`, and
`codex_ui_decision` from tool registration; the Decision v1 resource and
generated UI inventory; the renderer, sanitizer, delivery runtime, and
Decision-specific tests/scripts; and the four unused production sanitizer
dependencies plus their one type dependency. The existing Dashboard and
Settings resources remain registered. MCP instructions and the `codex_answer`
description require a fresh `codex_status` input read after user deliberation,
with the current exact `questionRef`.

## Before and after inventory

Measurements use `tsx scripts/audit-tool-guidance.ts` against isolated
current-protocol bridge servers, before at the `dev` parent and after at the
issue branch. The before report is an ephemeral local audit output; the values
below are the retained comparison.

| Measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| All registered tools | 20 | 17 | -3 |
| Model-visible tools | 14 | 12 | -2 |
| App-private tools | 6 | 5 | -1 |
| Model-visible input schema bytes | 29,812 | 25,598 | -4,214 |
| Model-visible output schema bytes | 58,674 | 53,227 | -5,447 |
| Public tool description words | 907 | 640 | -267 |
| Shared MCP instruction words | 669 | 615 | -54 |
| Active UI resources | 3 | 2 | -1 |
| Direct production dependencies | 10 | 6 | -4 |

Removed production dependencies: `parse5`, `postcss`,
`postcss-value-parser`, and `sanitize-html`. Removed development dependency:
`@types/sanitize-html`. The audit made zero upstream Codex calls both before
and after. `npm audit --omit=dev --audit-level=high` found zero vulnerabilities.

The normal maintenance slice list no longer contains `decisions` and
`BridgeStateStore` no longer constructs `DecisionCardStore` or performs its
startup, periodic, or general retention work. The storage audit reports
historical Decision rows as dormant legacy rows rather than current
maintenance cardinality.

## Stale host and migration boundary

The MCP SDK dispatches calls only to tools in its registered tool map, which is
also the source of `tools/list`. A hidden runtime-only `codex_decision` route
would require a separate protocol dispatcher. The retired names therefore
return the standard `Tool ... not found` protocol error. The HTTP integration
test sends the historical create, submit, and result call shapes and checks
that no Decision row, Job, Activity, or upstream call is created. The migration
guidance tells users to Refresh the
ChatGPT connection after installing the changed server. Cached cards cannot
submit or read receipts against the new server.

Schema 24's source declaration, 23-to-24 migration step, and provenance remain
unchanged. The four Decision tables are dormant for existing databases and are
not an answer or execution authority. The test inserts a row in each table in
an authentic schema-24 database, upgrades to schema 26, runs general
maintenance, restarts, and verifies all rows, SQLite integrity, and foreign
keys. It also reopens the pre-upgrade backup through the forward migration and
checks the legacy submission survives. Physical table deletion is deferred to
the separately reviewed forward schema migration decision in
[#177](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/177). The former 30-day Decision
retention sweep no longer runs; this retention change is explicit in the
database and retirement documentation.

## Verification

- `npm run check`: 101 test files, 892 tests passed.
- `npm run macos:check`: 212 tests executed, 2 skipped, 0 failed.
- `npm pack --dry-run --json`: 282 files; only Dashboard and Settings UI HTML
  included under `dist/ui`.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `npm run release:check`: passed within `npm run check`; generated UI and
  release metadata synchronized.
- `npm run mcp:conformance`: 29/29 checks passed, 0 failed.
- `npm run test:issue-143-card-stale`: Dashboard and Settings kept their last
  confirmed view after a read timeout and made no duplicate compatibility
  call. This existing shared browser regression now covers only active cards.

## ChatGPT connector acceptance

The macOS app installed from integrated `dev` commit
`bb0257155a5cddae8e8e2456eccad899e87fe943` was shut down through its
graceful lifecycle protocol, replaced with the signed build, and restarted.
The helper reported a running bridge and connected tunnel. The installed
bundle contains only Dashboard and Settings UI files.

Before Refresh, ChatGPT's developer-mode plugin screen still showed the old
`codex_decision`, `codex_decision_result`, and Decision v1 template metadata.
A create call using that cached descriptor returned the protocol error
`Tool codex_decision not found`. The existing Decision row counts and total
Job count were unchanged after the call. No card or execution was created.

After Refresh, the same ChatGPT screen listed neither retired public tool nor
the Decision v1 template. Dashboard v2 and Settings v3 remained. In a new
ChatGPT conversation, the model called `codex_dashboard`, `codex_settings`,
and `codex_status` successfully; both cards rendered and status reported no
running Jobs. A short read-only Codex Job in a temporary, dedicated project
completed through the connector, and ChatGPT read its terminal result with
`codex_status`.

The default Codex CLI configuration on this host did not expose an ordinary
question tool to a new Job. The test therefore used a temporary, trusted
project with `default_mode_request_user_input` enabled in that project's
Codex configuration. ChatGPT observed a live Blue/Red question through
`codex_status` kind `input`, then refreshed the question in a separate user
turn and called `codex_answer` once with Blue. The delivery was reported as
`delivered`. That first Job was subsequently interrupted because the runtime
process supervisor lost its independent process-table observation and killed
the worker (`worker-observation-failed`); this is recorded as a host execution
limitation, not a successful terminal question run. A single retry created
another ordinary question. ChatGPT read its current `questionRef` and sent
Blue with `codex_answer` once. The Job then completed. The Codex agent did
not include the requested probe marker in its final prose, so the result
proves question transport, answer delivery, and terminal status, not exact
prompt adherence. The temporary project registration and scoped Codex
configuration were removed after the test.
