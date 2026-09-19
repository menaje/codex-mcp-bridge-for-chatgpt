# Issue 138 state access audit

Tested 2026-09-20 against schema 24. The running bridge was not restarted and
its database was not modified.

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
