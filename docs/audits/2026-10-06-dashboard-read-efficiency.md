# Dashboard read efficiency and queue isolation

Baseline: `6b3368d6c51c4f4a9eb5a1e26e0b77541edf064c`.
The installed runtime used this same commit. Read-only companion probes observed
two running Jobs and successfully loaded the Dashboard at inspection time;
the reported earlier card failure could not be attributed to a captured error.

A regression fixture holds Settings model discovery until a sentinel is
released, then requests two database-only Dashboard snapshots with a one-second
deadline. The baseline returns `STATE_READ_STALE`; the correction returns both
snapshots, including a Settings change committed while model discovery waits.
The production read deadline remains ten seconds. Read capacity, abandoned-read
accounting, process restart, and query-only ownership remain covered separately.

The same online SQLite backup was opened read-only for both query traces. No
production state was changed, and the temporary backup is excluded from Git.
The first structural snapshot with the card's actionable-problems query produced:

| Measurement | Baseline | Corrected |
| --- | ---: | ---: |
| SQL statements | 990 | 34 |
| Repeated lookup of the same recovery incident | 572 | 1 |
| Individual Activity reads | 386 | 0 |
| Batched Activity-title reads | 0 | 1 |

Four subsequent projections used 988 statements before and 32 afterward.
Five-sample median projection time was 57 ms before and 34 ms afterward. These
times exclude IPC, server construction, account/model lookup, and runtime probes;
they are not a claim about end-to-end card latency. Overview counts matched,
including both running Jobs.

`test/dashboardReadQueries.test.ts` checks bounded query counts at two history
sizes, exact recovery metadata, retained titles, handoff evidence, no writes,
and batches crossing the 500-parameter boundary. `test/stateReadProcess.test.ts`
checks concurrent Dashboard reads during delayed Settings model discovery and
fresh WAL state on reused connections.

Validation passed with `npm run validate:affected -- --base 6b3368d6c51c4f4a9eb5a1e26e0b77541edf064c`:
release/localization checks, the pinned CLI 0.153.3 protocol schema, TypeScript
build, 127 Node test files / 1,432 tests, and macOS validation (274 tests,
two opt-in tests skipped, no failures). The test CLI was selected through PATH
without overriding the fixture-specific runtime command settings.
