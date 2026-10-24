# Issue 138 state access audit

The initial source and storage audit was tested 2026-09-20 against schema 24.
During that initial audit the running bridge was not restarted and its database
was not modified. The separately authorized operating deployment acceptance
below supersedes only that deployment deferral; it does not change the scope of
the earlier read-only storage measurements.

## Operating deployment acceptance — 2026-09-20

The staged macOS bundle was built from `f7f5056f9cf3bf453e912ff36cbe2d41030867d7`
with build ID `f7f5056f9cf3:8d672a3d96bd`. Its Swift suite passed 202 tests with
the two opt-in live tests skipped during the build. Before replacement, the
helper reported no active Jobs, admissions, interactions, protected memory-only
threads, or background processes. A normal non-forced lifecycle shutdown
completed, and the app, helper, launcher, Bridge, Tunnel, sockets, and LaunchAgent
were confirmed stopped before the bundle was replaced.

The replacement bundle then launched from the established operating path. The
helper reported Bridge connected and accepting, Tunnel connected, and startup
lifecycle completion. Tunnel doctor, `/healthz`, and `/readyz` all passed. The
one opt-in `LiveCompanionTests` test passed against the restarted app's real
private companion socket in 1.828 seconds.

The ChatGPT plugin detail initially still advertised the cached
`codex_status.waitMs` default as 55,000 ms. A developer connector Refresh
completed after restart, re-enabled its Refresh control without an error alert,
removed the 55,000 ms description, and advertised the deployed 20,000 ms
default. Fresh Tunnel metrics after restart also recorded one successful
`resources/read` request and five successful `tools/call` requests, all HTTP
200. Those counters establish post-restart control-plane traffic but are not
attributed to the local status probes below.

### Exact status wait

A real read-only Codex Job emitted progress for about 30 seconds through the
deployed local Streamable HTTP endpoint.

| Observation | Result |
| --- | --- |
| aborted terminal wait | host abort returned after 1.508 s; the Job remained running |
| immediate exact read | `running`, non-terminal, with no cancellation intent |
| default terminal wait | server wait 20.002 s; total 21.229 s; timed out while progress continued |
| following terminal wait | completed after 24.546 s with `LIVE_STATUS_WAIT_OK` |
| durable terminal provenance | `normal-completion`, no cancellation intent, Job version 14 |
| abort observation | exactly one `status-wait-aborted / host-aborted-read-wait` row |

Thus ordinary progress did not release the terminal wait, the deployed default
was bounded at 20 seconds, and aborting the read did not cancel the Job. This
validates the previously deferred #137 runtime boundary on the stacked #140
build; it does not claim that 20 seconds is an optimal value for every network
condition.

### Dashboard read model

A second Job continued the same Agent and remained active for about 15 seconds.
The deployed Dashboard read returned its running representative with one history
entry. After completion, summary and deferred detail selected the same completed
representative and returned the same history revision
`bec3290011722181d531464a205d2de20393cd89c9804ee714ffb081ee8e11d5`.
The detail contained the one expected historical row. This live check complements
the deterministic fourteen-Job boundary fixture below; it does not replace that
fixture's coverage of the bounded thirteenth/fourteenth-row ordering case.

The status and Dashboard calls above used the deployed local MCP endpoint rather
than a model-issued call in the ChatGPT page. The connector Refresh separately
establishes that ChatGPT adopted the new static tool descriptor. No `VACUUM` or
database replacement was performed; ordinary operating Job, event, and transport
observation writes were created by these probes. The prior app bundle remains at
`macos/build/Codex MCP Bridge for ChatGPT.app.previous-2e5c357` as a rollback
artifact.

## Runtime and scale results

The disposable scale fixture is recorded in
[`issue-138-state-access.json`](issue-138-state-access.json).

| Fixture | Overview rows loaded | Overview SQL | Overview time | Agent history rows |
| --- | ---: | ---: | ---: | ---: |
| 100 Jobs / 100 Agents | 100 | 1 | 2.118 ms | 1 |
| 1,000 Jobs / 500 Agents | 500 | 1 | 5.788 ms | 2 |
| 10,000 Jobs / 1,000 Agents | 1,000 | 1 | 46.327 ms | 10 |

Ordinary overview materializes only one representative archived Job per Agent.
The targeted mixed-order fixture has thirteen older failed Jobs whose update
times all follow the newest created run. The newest run is therefore fourteenth
by update time. Created-time overview and deferred detail both selected that
newest completed Job, while update-time overview selected `old-13`. Deferred
detail returned `old-13` first and exactly twelve historical rows, so the
representative did not consume or fall outside the bounded history window. An
exact-ID lookup also recovered `old-13`'s full timestamps and execution summary
with zero writes. The Agent history statement reports the complete total while
materializing at most one representative plus twelve history rows. Summary
projection is one bulk query, not one query per row.

These timings cover `listDashboardArchivedJobsByAgent()`, not complete
`dashboardSnapshot()` construction or an MCP round trip. The fixture measures
returned materialization and read-model SQL; it does not claim that SQLite only
examines the returned rows.

SQL tracing observed four explicit writes for an ordinary public progress event
and two for a state-only progress tick. Trigger-internal `event_budget` writes
are excluded consistently with the issue-95 baseline. `StatusReadModel` used two
SELECTs and no writes for exact Job plus scope overview.

## Operating database storage audit

The full machine-readable report is
[`issue-138-database-storage.json`](issue-138-database-storage.json). It opened
the live source read-only, made a consistent SQLite backup, and ran integrity,
foreign-key, query-plan, and offline-compaction checks only on disposable copies.

- Main database: 196,378,624 bytes
- WAL / SHM: 4,276,592 / 32,768 bytes at observation time
- Reusable pages: 46,194 of 47,944 (96.35%, 189,210,624 bytes)
- B-tree used bytes: 4,794,452; cell payload bytes: 4,679,801
- Schema-24 rows: 8,045 across 37 tables at the final observation
- Migration backups: 10 files, 264,462,336 bytes total
- Verified disposable compact copy: 6,275,072 bytes
- Live replacement or live `VACUUM`: none

The operating database had 756 archived history candidates, 1,702 Job events,
five decision submissions, and zero result holds. Query plans use the Job event,
blocking interaction, and unfinished-work indexes. The bounded history query
still uses a temporary order B-tree, and result-hold expiry still scans the
sparse hold table. Those two schema-24 decisions and their revisit criteria are
documented in [`state-data-access.md`](../state-data-access.md).

## Correctness boundaries

- Question and decision queries were SQL-traced with zero writes.
- A late Decision Card delivery outcome at the exact lease deadline is rejected
  as stale; a following claim remains acceptance-unknown with attempt count one.
- Dashboard filtered overview uses created-time representative selection even
  when an older failure was updated later. Problem and automatic-recovery rows
  hydrate the selected page by exact retained Job ID, preserving timestamps and
  summaries that are outside the recent overview window. Deferred history uses
  the same exact representative even when it ranks fourteenth by update time;
  its `historyRevision` therefore matches the summary row.
- Job reads no longer perform TTL pruning; explicit Job maintenance preserves
  the previous durable deletion behavior. Runtime slices inspect at most 64
  Jobs, remove at most 32, use a 10 ms cooperative deadline, and resume from a
  persistent iterator.
- Event sweep skips byte-identical current-policy payloads.
- Event retention no longer writes `activity_events` or `result_holds` through
  its raw database handle; those cross-domain deletes execute through explicit
  State Unit-of-Work maintenance commands.
- Maintenance domains commit separately; thread release performs no database
  retention work.
- The macOS helper reads project roots through the shared read-only schema
  inspection contract.
- Existing migration provenance, restart recovery, exact completion delivery,
  Decision Card, and exact status-wait suites remain required release checks.
