# Issue #48 progressive card hydration audit

Date: 2026-09-03 (Asia/Seoul)

Initial live bridge build: `dee8ea1f465869e1fec2b5d22c6f4de721e7a295`.
The compatibility correction below was subsequently covered by the complete
automated suite and focused page-ordering regressions.

Scope: Dashboard, Activity, Settings, and the native macOS Dashboard path.
Conversation, project, Agent, Job, thread, request, and local-path identifiers
are intentionally omitted.

## Implementation boundary

Dashboard and Activity now return an authoritative structural snapshot before
starting optional runtime and weekly-usage enrichment. Current cards explicitly
request `enrich: false`, paint that result, and then request `enrich: true`.
Omitting the field preserves the enriched behavior expected by immutable older
cards.

The enrichment path has these hard bounds:

- at most 200 non-archived App Server Agents, selected independently of the
  current page; visible/active candidates receive liveness inspection and the
  remainder receive loaded-thread-only background-process inspection;
- eight workers, a 1,500 ms per-probe timeout, and a 6,000 ms total runtime
  budget;
- an independent 1,500 ms weekly-usage timeout;
- no new follow-up request from a worker after its upstream probe has timed out;
- a 5-second fresh cache plus a 15-minute last-known retention window for up to
  512 stable runtime observations, invalidated by the bridge-owned
  background-process mutation path;
- a one-minute fresh cache plus a 30-minute last-known retention window for
  weekly usage; and
- `listLoadedBackgroundTerminals`, which returns `null` instead of resuming an
  unloaded historical App Server thread.

Matching last-known evidence is projected into later structural snapshots
without an upstream call. Timeouts and unsupported safe inspection remain
reported in enrichment counters, but no longer replace a prior successful
usage or runtime value with a transient absence. A loaded-thread inventory miss
is a confirmed zero because that App Server connection cannot own a running
terminal for an unloaded thread.

The native macOS menu-bar app follows the same two-stage Dashboard contract:
its first refresh requests structure only, while optional enrichment is applied
as a later update. Settings remains a single bounded structural read.

## Automated acceptance evidence

The 200-Agent/400-Job fixture passed all issue thresholds:

- Dashboard structural snapshot completed below 500 ms with zero runtime or
  usage calls.
- Activity full-history structural snapshot completed below 500 ms and retained
  all 200 Agents in pagination metadata.
- Settings snapshot completed below 500 ms.
- Hanging Activity and Dashboard enrichment returned below 2 seconds, reported
  timeout/unknown state, and did not block the structural result.
- Runtime enrichment remained within the 200-Agent ceiling. A dedicated
  40-Agent regression placed the only background process outside the first
  30 rows and verified that enrichment promoted it into the current section,
  after which a zero-call structural refresh retained the usage, process count,
  and row order.
- Dashboard and Activity private hydration envelopes remained inside their
  closed output caps.

The real-browser regression injected a 20 ms structural response and a 650 ms
enrichment response. First structural paint was 19.1 ms for Activity, 24.0 ms
for Dashboard, and 29.0 ms for Settings. Dashboard re-entry succeeded, both
progressive cards requested enrichment after paint, and no browser error or
unhandled rejection was recorded. The separate Activity regression passed all
nine retained/current/superseded and interaction states.

Current source HTML payloads and enforced budgets are:

| Card | HTML bytes | Budget bytes | Headroom |
| --- | ---: | ---: | ---: |
| Dashboard | 102,948 | 114,688 | 11,740 |
| Activity | 133,353 | 147,456 | 14,103 |
| Settings | 180,804 | 196,608 | 15,804 |

The complete live MCP resource responses, including protocol envelopes, were
105,751, 134,067, and 181,909 bytes respectively. The diagnostics response
exposes current HTML sizes, budgets, and bounded stage statistics.

Validation completed on the build under test:

- `npm run check`: 42 files, 558 tests passed.
- `npm run macos:check`: 27 tests passed; one opt-in live companion test was
  skipped.
- progressive-card browser regression: passed.
- Activity-card browser regression: nine states passed.
- App Server compatibility: Codex CLI 0.145.0 schema lock matched.
- skills, release manifest, package dry-run, and production dependency audit:
  passed; zero production vulnerabilities were reported.

## Live bridge measurements (initial implementation baseline)

The committed build was rebuilt and restarted only after the bridge reported no
active Jobs. The default stateless HTTP profile and Secure MCP Tunnel remained
in use.

Sanitized live observations were:

| Path | Structural observation | Enriched observation |
| --- | --- | --- |
| Dashboard | 211.6 ms MCP round trip after the final restart; five earlier warm samples had p50 237.7 ms and p95/max 297.5 ms | 1,247.5 ms; eight runtime requests, eight timeouts, usage timed out |
| Activity, 31-Agent retained scope | 199.1 ms | 881.2 ms; 30 runtime requests, zero runtime timeouts, usage timed out |
| Settings | first post-restart read 597.6 ms; five warm samples had p50 77.5 ms and p95/max 93.5 ms | not applicable |

The first Settings read includes process and cache warm-up; subsequent reads are
the relevant steady-state comparison. Structural Dashboard and Activity stayed
below 500 ms despite the retained population, while optional work stayed inside
the two-second acceptance limit.

During this probe, `codex_diagnostics.performance.stages` initially appeared
empty across stateless HTTP requests. The tracker had been scoped to each
short-lived MCP server binding. A shared tracker was moved to the HTTP runtime
boundary and covered by a stateless cross-request regression. A final live
Dashboard request then persisted one structural DB-projection sample at 139 ms
and one serialization sample at 1 ms into the next diagnostics request.

## ChatGPT cold mount and re-entry

ChatGPT's developer-mode connection was refreshed once for the static resource
and schema change. Discovery exposed `enrich` on both private snapshot tools and
the following current resources:

- Dashboard generation 16:
  `ui://codex-mcp-bridge/dashboard/b8fbb46e2d91.html`
- Activity generation 20:
  `ui://codex-mcp-bridge/activity/e9f8ea22821c.html`
- Settings generation 15:
  `ui://codex-mcp-bridge/settings/0b12d97d007f.html`

In a new authenticated ChatGPT Work conversation, a read-only prompt requested
only the bridge-wide Dashboard. ChatGPT reported 30 seconds of total host work,
including model deliberation, tool discovery, and tool invocation. The current
generation-16 Dashboard then mounted with structural counts and rows instead of
a blank frame; no Codex Job was started or changed. This host-level duration is
not attributed to card rendering—the controlled browser measurement above puts
the Dashboard's structural paint at 24 ms once the structural result is
available.

The conversation was left and opened again by its exact route. The same
generation-16 resource remounted with the Dashboard body and refreshed
structural data within an observed six-second upper bound that includes ChatGPT
page navigation and iframe creation. The similarly titled historical
conversation was excluded from the result after its distinct route was
identified.

## Result

- Structural first paint independent of runtime enrichment: **PASS**
- 200-Agent/400-Job Dashboard threshold: **PASS**
- 30+-Agent Activity threshold: **PASS**
- Hanging/slow enrichment fallback below two seconds: **PASS**
- Page-independent bounded probing and no historical resume: **PASS**
- Last-known usage/runtime preservation across structural refreshes: **PASS**
- Historical one-shot enrichment without ownership or controls: **PASS**
- Pagination, lease, mounted-card proof, scope, and mutation controls: **PASS**
- Dashboard, Activity, Settings, and native macOS regression coverage: **PASS**
- Explicit HTML and hydration byte budgets: **PASS**
- Live ChatGPT cold mount and exact-conversation re-entry: **PASS**
- Stateless HTTP performance telemetry persistence: **PASS**

Issue #48's completion gates are satisfied. No fallback branch is claimed from
the real ChatGPT run when that branch was not selected; the injected hanging
upstream and compatibility/fallback paths remain deterministic automated
coverage.
