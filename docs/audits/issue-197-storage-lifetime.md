# #197 SQLite read lifetime and WAL audit

Audited on 2026-09-28 against `dev` at `66178345e1442cfa1217d007d2b7ccad096a4abd` (schema 29). This is a source and isolated-fixture result. The installed app and operating databases were inspected read-only; they were not upgraded, checkpointed, copied into this repository, or used for fault injection.

## Decision

No state or telemetry storage policy change is supported by the evidence below. The tested product reads do not leave a WAL snapshot open after completion. An intentionally held reader does obstruct checkpoint progress, and progress resumes when it ends. The normal fixture write path is short; the external lock produces an explicit storage-busy outcome and a later write succeeds. Keep one state writer, `synchronous=FULL`, the current automatic checkpoint policy, and the separate best-effort telemetry owner. Do not use DB pressure to terminate a Job or release a result before terminal commit.

This does not establish that every operating write will meet a latency target. The operating app has an older schema and no in-process SQLite phase measurements were taken. In particular, the audit does not measure filesystem `fsync` time, SQLite internal page visits, or operating WAL frame progress.

## Effective configuration and owners

| Connection | Source contract | Installed/operating observation | Limit |
| --- | --- | --- | --- |
| Operational `state.sqlite` writer | Sole state-owner child; SQLite WAL, `synchronous=FULL`, `busy_timeout=5000`; schema 29; no explicit `wal_autocheckpoint` override | Installed bundle also sets WAL/FULL and 5000 ms. Operating DB schema is 27. Journal mode observed as WAL; SQLite 3.53.4 and `better-sqlite3` 13.0.3 in the installed runtime. | The source worktree must not open the older operating DB as its writer. Writer-local `synchronous`, timeout, and auto-checkpoint values were not read from the running connection. |
| State read child | Opens query-only/read-only, validates schema, completes `.get()`/`.all()` projection calls, closes its per-request store in `finally`; no explicit read transaction around async waits | Installed child is running; operating DB was inspected by a separate read-only connection | An inspector's PRAGMA values are its own connection-local settings, not the installed writer's settings. |
| Telemetry writer | Separate child/file; WAL, `synchronous=NORMAL`, `busy_timeout=1000`, `wal_autocheckpoint=128`; test-only startup freeze path can truncate | Operating telemetry journal mode WAL; same installed SQLite/driver family | The installed writer's connection-local settings were inferred from bundled code, not queried in its process. |
| Codex executor | No Bridge SQLite authority | Not probed with a live Job | DB inspection cannot prove executor liveness. |

Both operating files have 4096-byte pages. Read-only inspection saw about 8.3 MB main + 4.4 MB WAL for operational state and 1.3 MB main + 0.6 MB WAL for telemetry. These are **physical file sizes only**, not a count of uncheckpointed frames. The logical state database ID exists but is deliberately omitted from this public report. The separate inspection connection returned `synchronous=1`, timeout 5000, and auto-checkpoint 1000; those values are **not** a measurement of either running writer's connection-local settings.

Startup has an identity-bound lease and migration preflight. Schema upgrades use a private `VACUUM INTO` snapshot before service opening, verify its identity, digest, integrity and foreign keys, and preserve generation evidence. No live user-request path adds a checkpoint or `VACUUM`; copying only the main DB file would omit committed WAL content. The diagnostic database remains separate from operational state and may lose diagnostic records without rolling back a state command.

## Read lifetime and supported measurements

- Exact Job/input/result and command read-model methods execute synchronous SQLite statements in the state owner. The state transaction wrapper uses `BEGIN IMMEDIATE` through `COMMIT`/`ROLLBACK` within one synchronous callback; it contains no `await`. This audit found no open cursor passed into a Job wait, network response, or user-input wait.
- Dashboard/history/Settings use the read child. Its per-request store is closed in `finally` after the projection and server cleanup. No explicit `BEGIN` spans its await. The only source iterator found is the startup-only `protectedThreadIds()` loop, consumed synchronously while applying in-memory resume protection; it is not held across an external await.
- Product reads are tested by `test/stateReadProcess.test.ts`: a 16-request timeout/capacity case, new committed Settings visibility while a separate old reader pins a snapshot, and child recovery. The new probe additionally finishes 16 concurrent product reads and then obtains a non-busy `TRUNCATE` checkpoint **on its disposable fixture**.
- The probe reports `PRAGMA wal_checkpoint(PASSIVE)` `{log, checkpointed}` for a disposable file. A positive `log - checkpointed` is a snapshot of frames not checkpointed at that point; it is not the WAL file's byte size or an estimate of business rows. `TRUNCATE` is used only on the isolated fixture to test recovery. The operating DB was not checkpointed.
- The probe's transaction phase callbacks separate elapsed `BEGIN IMMEDIATE`, SQL plus mapping, and `COMMIT` plus return overhead. These are application boundary times, not SQLite internal CPU or `fsync`. Settings read times include read child IPC and projection work, not just SQL. No per-SQL production tracing, new IPC, or hot-path metric was added.

## Reproducible isolated evidence

Run `npm run test:issue-197-storage`. The command creates a schema-29 temporary database with synthetic Agents, starts the product read child, emits one JSON object, and removes the fixture. It makes 160 product writes, interleaves 20 Settings reads, deliberately holds an old reader, runs checkpoint experiments, completes 16 more reads, and tests a write lock. The numeric measurements are machine-specific snapshots and are not release-wide latency guarantees. For a sample below 100, p99 is `null`.

| Condition | Observed result |
| --- | --- |
| 160 normal Agent writes, 20 Settings read-child calls | All succeeded; write phase samples and read call summary emitted as JSON. No operating data used. |
| Deliberately held old reader while writes continue | `PASSIVE` reported 1006 WAL frames with 155 checkpointed. Physical WAL file was 4,144,752 bytes. `TRUNCATE` returned `busy=1`. Product reads still returned current committed Settings. |
| Old reader released | `PASSIVE` advanced to 1006/1006; `TRUNCATE` returned `busy=0` and the fixture WAL file became zero bytes. |
| 16 completed product read calls | Later fixture `TRUNCATE` returned `busy=0`; completed reads did not retain an old snapshot. |
| External write lock | Product write reported `SQLITE_BUSY` after its configured wait; releasing the lock allowed the next write to commit. |

Additional source tests passed: `test/stateReadProcess.test.ts` and `test/telemetryService.test.ts` (9/9); `test/stateStore.test.ts` and `test/stateServiceProcess.test.ts` (29/29); #185 execution recovery and #189 retention fault scripts. #185 preserved the execution owner across two state-owner restarts, recovered three exact results, and reported zero duplicate Jobs/turns. #189 withheld 16 commit acknowledgements under saturation, then recovered and released reservations with zero duplicate turns. These tests use isolated state files and synthetic upstream behavior. The macOS installed bundle and ChatGPT host were not exercised here.

One inherited #143 characterization failed at its native `settings.snapshot` assertion: its client waits 5 seconds for a bounded uncertainty response, while current source allows a 120-second RPC observation unless the fixture selects its test-only override. This is a **test contract drift**, not evidence of a SQLite checkpoint or writer failure. The failure remains visible and is assigned to #198's common regression runner; #198 must fix and rerun that scenario before a cumulative pass is claimed.

## Boundary and follow-up for #198

Required durable records remain in the state writer: authorization, admission, idempotency receipts, user control intent, and terminal result commit. Derived telemetry has its separate capacity and durability policy. The #200/#196 completion evidence and result-before-ACK contract are reused through #185/#189 rather than recreated here. A state lock may delay or reject a **new** durable admission, but it does not establish that an already running executor died. The audit adds no worker stop/restart condition and no second state writer.

#198 should run this probe with its source/bundle fingerprint, keep its JSON and the original #143 failure/retest records, and mark operating SQLite timing, installed app behavior, actual Codex/ChatGPT round trips, and low-level disk latency as unverified until directly measured.
