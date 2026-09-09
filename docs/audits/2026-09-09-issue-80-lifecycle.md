# Issue #80 lifecycle, retention and resume acceptance

Date: 2026-09-09. Scope: durable thread connection intent, independent idle release, local native app handoff, bounded diagnostic retention and usage accounting. This record distinguishes implemented behavior, fixture validation and live observations. The same-context app round trip succeeded in the later production-runtime check; graphical warning and native handoff interaction acceptance remains open.

## Implementation and automated coverage

- Job result retention remains six hours/100 Jobs; `CODEX_MCP_BRIDGE_THREAD_IDLE_MS` independently defaults to six hours from the first durable terminal transition of the latest actual turn. Reads and restart reconciliation do not renew it. Zero disables automatic connection release.
- Fresh installations default to persistent visible threads. Explicit and historical missing-field visibility preferences are preserved, with regression coverage for both. Hidden durable creation remains unsupported by the verified runtime.
- Fake clocks cover the exact boundary, passive reads, rollback of a failed result commit and restart restoration. Admission races, active forks changing targets, blocking input, a full batch of blocked requests, ephemeral/unknown persistence and 30-day local Agent archive have targeted tests.
- App Server fixture tests distinguish unsubscribe acknowledgement from unload and observed process exit, process close notifications without an active turn, protect a shared worker's ephemeral conversation/background work, and prevent implicit resume after release. Writer-lock failures are surfaced before a bridge turn starts.
- SQLite tests cover resumable pre-v14 backup/migration, bounded progress, preserved usage after expiry, durable request deduplication, undelivered results, blocking input, uncertain steering and renewable holds. Explicit terminal-result review can clear only the uncertain-response hold, without rewriting delivery history or enabling replay; a new uncertain delivery protects again. Cancellation/question/delivery authority stays outside diagnostic event deletion.
- Local companion tests validate the exact request envelope, current target/evidence handling and exclusion of `thread.handoff` from remote methods.
- Production-runtime regression tests cover idle release, explicit handoff and restart protection through `createExecutionRuntime`, its lazy backend and its real App Server fixture worker. The initial adapter-only checks missed missing lazy forwarding; the corrected path reaches verified worker exit and prevents read-only reacquisition. Protection recorded before lazy initialization is applied before the backend is exposed.
- Mixed-Job migration regressions cover both schema 13 and already-scanned schema 14. Every encountered Job receives its 256-event bound; the diagnostic cursor is reset once for earlier schema-14 test builds. Reopening preserves progress and usage summaries survive pruning beyond the current migration slice.

Final validation after integrating `dev` at `69d4c01`: `npm run build` passed; the full Vitest run passed **892 tests in 72 files** (293.79 seconds); App Server compatibility matched CLI 0.153.3 (416 JSON and 827 TypeScript schema files). `npm run macos:check` passed **129 tests with 2 skipped**, strict concurrency/warnings checks, and **654 strings in nine languages**. `git diff --check` and release-policy validation passed. The repository intentionally runs no release Actions for ordinary `dev` pull requests; no release workflow was dispatched.

## Live Codex observations

The opt-in measurement used Codex CLI 0.153.3, `gpt-5.6-sol`, low reasoning, a private empty temporary directory, read-only access and no model tool use. One synthetic persistent conversation remembered a marker and the stage sequence. No repository prompt, transcript, user identifier or private path is included here. Input/cache figures below are the last individual request sample, not a claim that an unknown thread counter is a per-Job total. No compaction event was observed in the bridge samples.

| Path | Elapsed | Input | Cached input | Cached/input | Output | Continuity |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Warm-up | 7,168 ms | 20,798 | 0 | 0% | 12 | `W` |
| A: kept loaded | 2,498 ms | 20,832 | 20,608 | 98.92% | 12 | `WA` |
| B: unsubscribe then resume | 4,230 ms | 20,866 | 20,608 | 98.76% | 13 | `WAB` |
| C: verified worker exit then restart | 7,290 ms | 22,589 | 20,736 | 91.80% | 13 | `WABC` |
| D: continue through actual Codex app | 6,595 ms | 31,245 | 0 | 0% | 14 | `WABCD` |
| E: app → bridge through production runtime | 7,899 ms | 25,404 | 13,440 | 52.90% | 13 | `WABCDE` |

B returned `unsubscribed`; it did not claim that the documented upstream unload grace had elapsed. C and the outgoing app handoff observed the owning test worker exit. The app then successfully continued the same persistent conversation and retained the marker and all prior stages. The app turn used the same model/effort but a different application instruction/tool context, so its cache observation is not a controlled like-for-like comparison with A–C. C restarted its usage counter without a known start baseline; the bridge correctly labels the whole-Job accounting unknown and retains the last-request sample separately.

The immediate app-to-bridge attempt was refused by Codex with an active-writer error before `turn/start`. A second attempt at 06:07:23 UTC, over 30 minutes after navigating away from the test task, was also blocked in 1,199 ms with `THREAD_EXTERNALLY_OWNED` and no turn events. At 07:57:27 UTC, a further attempt through the corrected `createExecutionRuntime` factory succeeded: the same conversation retained the marker and the app's latest stage, then returned `WABCDE`. The bridge subsequently verified its own worker exit through that same production runtime. This observation does not establish exactly when or why the app relinquished its writer; a completed app turn or navigation alone is still not evidence of release. No original thread was archived/deleted and no app/shared process was terminated to bypass this boundary. E's counter had no start baseline, so the table shows its last-request sample and whole-Job usage remains unknown.

Direct graphical inspection of the Codex warning and the native handoff button could not be completed because computer-use access to Codex was denied. Purpose-built app task operations and the later production-runtime return confirmed both directions and preserved context, but do not prove the visual warning has disappeared. Graphical warning and native interaction acceptance remains open.

These are single-run observations without controlled cache eviction. Account-wide parallel work also prevents attributing plan-limit changes to these turns. No subscription quota decrement or API-price conversion is claimed. The default remains six hours; it is an operating choice, not a cache guarantee. See the official [App Server unload grace](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread), [API prompt cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) and [Codex plan usage explanation](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan).

## Private database-copy measurement

A read-only SQLite backup of the operating schema-13 database was migrated and cleaned in an isolated private copy. Only aggregates are published. The live database and Codex rollout directory were not modified by this measurement.

| Measure | Before | After cleanup |
| --- | ---: | ---: |
| Job events | 126,942 | 31,208 |
| Event payload bytes | 127,207,178 | 5,008,433 |
| Main DB bytes | 196,378,624 | 196,378,624 |
| Reusable pages | — | 34,704 of 47,944 |

Backup/schema migration took 705 ms. There were 114 resumable maintenance batches: median 23.86 ms, p95 56.09 ms, maximum 74.20 ms. The retained dashboard Job/Activity query measured median 1.95 ms and p95 2.49 ms after cleanup. Offline compaction of the closed copy took 138 ms and reduced the main DB to 21,700,608 bytes. Ordinary maintenance performs no live `VACUUM`; reclaimed pages can be reused before physical compaction.

Logical row digests matched before/after across 19 control/identity tables, including 603 Jobs, 367 sessions, 321 Agents, 329 thread relationships, 283 Activities, 134 steering deliveries and all cancellation/project/request metadata. The source completion-outbox and question tables were empty, so preservation of pending states is demonstrated by nonempty fixture tests rather than inferred from that copy.

A supplementary run measured WAL using only the already captured schema-13 backup, without accessing the operating database again. That consistent backup had a compacted 191,660,032-byte main file and zero WAL bytes. After 114 batches, the main file was 191,815,680 bytes, the live WAL 6,229,472 bytes, and 34,259 of 46,830 pages were reusable. Median/p95 batch latency was 22.08/55.37 ms, maximum 74.78 ms; query p95 was 2.22 ms. Safe close, offline checkpoint and compaction reduced the main file to 21,250,048 bytes in 112 ms. The later seven-day cutoff produced 30,917 events/4,993,345 payload bytes; these are a separate run, not a rewrite of the first observation.

## Remaining acceptance

The release protocol, corrected production forwarding, retention boundaries, safe ownership refusal and eventual same-context app round trip are verified. Before closing #80, the graphical external-use warning and native handoff interaction must be checked through an available supported UI path. The app's release timing remains outside bridge control; retain the explicit writer-lock check rather than forcing a handoff.
