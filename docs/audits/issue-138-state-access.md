# Issue 138 state access audit

Tested 2026-09-19 against schema 24. The running bridge was not restarted and
its database was not modified.

## Runtime and scale results

The disposable scale fixture is recorded in
[`issue-138-state-access.json`](issue-138-state-access.json).

| Fixture | Overview rows loaded | Overview SQL | Overview time | Agent history rows |
| --- | ---: | ---: | ---: | ---: |
| 100 Jobs / 100 Agents | 100 | 1 | 1.169 ms | 1 |
| 1,000 Jobs / 500 Agents | 500 | 1 | 4.518 ms | 2 |
| 10,000 Jobs / 1,000 Agents | 1,000 | 1 | 23.154 ms | 10 |

Ordinary overview materializes only the latest archived Job per Agent. An exact
Agent history query loads at most 13 rows and reports its complete total from the
same SQL statement. Summary projection is one bulk query, not one query per row.

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
- Job reads no longer perform TTL pruning; explicit Job maintenance preserves
  the previous durable deletion behavior.
- Event sweep skips byte-identical current-policy payloads.
- Maintenance domains commit separately; thread release performs no database
  retention work.
- The macOS helper reads project roots through the shared read-only schema
  inspection contract.
- Existing migration provenance, restart recovery, exact completion delivery,
  Decision Card, and exact status-wait suites remain required release checks.
