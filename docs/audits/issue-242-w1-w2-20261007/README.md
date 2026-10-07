# Issue 242: W1 backend reads and W2 native observation

W1 and W2 were implemented sequentially on `codex/issue-242-p0-w0`, continuing
the approved P0/W0 commit. Integration into `dev` and task worktree cleanup
remain pending by explicit user instruction. W3, W4 and R502 are not implemented
by this change. No production app, helper, tunnel, operational database or user
data was changed, and no GitHub Actions, push or remote write was invoked.

## Exact source and preservation

| Item | Commit |
| --- | --- |
| Remote-dev base after #241 | `264fa5c99ca1c8edeef50af247614204c8f3df53` |
| Starting P0/W0 task HEAD | `8474165e523b47d881f688bd09caf2e4c78ac7af` |
| W1 backend implementation | `4b8d935cc381db875c6133e1e960d0e57b78eb7b` |
| W2 native implementation / measured after source | `047156605d8556fa0de1c52f375d2da4f9d39b03` |
| Final code / regression corrections | `04ddf63ada7cc6a7172f4190b0909e8bd6d8a3b7` |
| Preserved original local dev | `ea8f93e2acbb9f4b6deca113165d27e8c9c23857` |

The after benchmark ran on committed W2 source with an empty source diff. A
subsequent native cancellation catch correction and regression-test changes do
not change the measured Node implementation. The final branch HEAD includes
those corrections and this evidence; inspect `git rev-parse HEAD` for that exact
head. [validation.json](validation.json) binds checks and artifacts to source.

The original checkout remains `/Volumes/Data/Dev/codex-mcp-bridge`; the task
worktree remains `/Volumes/Data/Dev/codex-mcp-bridge-issue-242-p0-w0`. Original
local dev is clean and still 23 local-only / 17 remote-only commits from
`origin/dev`. [local-preservation.json](local-preservation.json) records exact
refs, both worktrees, the unchanged P0/W0 evidence diff and all 15 original
artifact hash verifications. No reset, rebase, merge, cherry-pick, force push,
unrelated branch/worktree deletion or conversation change occurred.

Authority remains the saved [issue snapshot](../issue-242-p0-w0-20261007/issue-snapshot.json)
from 2026-10-07. Installed build `9be3bb6c70b8:2dd00dba8f3d` and its tunnel
evidence in that issue are historical observations. All new results here use
latest-dev synthetic fixtures; none is an installed-build acceptance result.

## Delivered contracts and file ownership

W1 retains #241's query-only read facade and constructs fresh config, Session,
Job and Settings objects for each physical request. It reuses the immutable
runtime-metadata validator, batches retired-Job checks, activity titles and
returned-row handoff lookups, and formats histories after page selection.
Selected detail hydrates only the freshly resolved Agent's Jobs; Settings
hydrates no Jobs. The opaque Agent row identity is resolved from fresh Agent
rows, never from a cached cwd. Counts, representatives, ordering, offsets and
history revisions retain their existing semantics.

`DisplayReadPool` shares only identical pending reads. Keys contain canonical
arguments, read-process generation, query epoch, SQLite `data_version` and
project registry revision. There is no completed-view or identity cache. A
committed write prevents joining an older read; a registry revision change
before publication rejects the late result with `STATE_READ_TARGET_CHANGED`.
This is conservative: unrelated committed writes can also prevent sharing.

Each subscriber has independent cancellation and an absolute deadline. A
cancelled A does not cancel B. When the last subscriber leaves, queued work is
marked for cancellation and a new read can use a fresh key, but the old physical
slot remains charged until its response or process exit. The supervisor keeps
its existing abandoned-request reservation too. Executing synchronous SQLite
cannot be preempted safely; its late result is discarded. Settings and Dashboard
use separate existing-child promise lanes so awaited Settings CLI work does not
hold the Dashboard queue; synchronous work still shares that process.

Private companion/remote read forwarding carries local AbortSignals and
absolute budgets. Default native, read-service and proxy timeouts and capacity
constants are not raised. Internal read IPC is version 3; public companion/MCP
schemas and execution command authority are unchanged. Read cancellation never
cancels or replays an execution command.

W2 stores `lastConfirmedHelperStatus` and `lastConfirmedHelperCheck` independently
from `helperObservationFailure` and `helperObservationFailedAt`. RPC failure
retains confirmed dashboard, detail, Settings, Skills and their check times as
unconfirmed display. Shared notices on all three screens identify that state.
Current `bridgeConnected` becomes false, so retained health grants no execution
permission. First failure without confirmed history becomes unavailable after
the existing grace period. Normal cancellation does not create a failure.
Recovery clears the failure; a confirmed stopped phase immediately invalidates
pending reads and clears retained content. Connection-target changes clear the
historical helper observation.

Helper-health and content generations fence older results. Settings registry
revision changes invalidate dashboard/detail generations across A archive,
delete and same-cwd B registration. Delayed healthy helper responses cannot
overwrite a confirmed stop. The Unix RPC client classifies timeout, refusal,
peer close, cancellation, permission failure and contract mismatch with phase
and errno where available. An absolute timer covers encoding/queue, connect,
send, receive and decode publication; partial bytes cannot renew it. Cancellation
remains cancellation through decoding. The timer interrupts blocking socket
work using shutdown; the transaction retains exclusive descriptor-close ownership.

| Owner / boundary | Changed files |
| --- | --- |
| W1 read sharing, fresh graph, query work | `src/displayReadPool.ts`, `src/stateReadProcess.ts`, `src/stateReadModels.ts`, `src/stateStore.ts` read methods, `src/threadConnections.ts`, Dashboard/detail/registry/validator hunks in `src/tools.ts` |
| W1 observation transport | Read-context hunks in `src/companionServer.ts`, `src/remoteCompanionServer.ts`, `src/runtimeProcess.ts`; proxy behavior is unchanged |
| W1 fixtures/contracts | `scripts/issue-242-characterization.ts`, `test/issue242Reads.test.ts`, `test/issue242ReadTransport.test.ts`, updated read/companion/runtime assertions, `.changes/issue-242-read-observation.json` |
| W2 native observation | `UnixSocketRPCClient.swift`, `AppModel.swift` status/content/connection-generation hunks, `AppLocalization.swift`, new `ConnectionObservationNotice.swift`, one notice insertion in Dashboard/Settings/Skills views |
| W2 fixtures/contracts | `AppPresentationTests.swift`, `UnixSocketRPCClientTests.swift`, `RuntimeLifecycleTests.swift`, `.changes/issue-242-native-observation.json` |

## Comparable 1,200-Job measurements

Before: [P0 final report](../issue-242-p0-w0-20261007/read-1200.json), source
`11cd8b9cee9167b97ce8a335a09f60479fffe039`. After:
[read-1200-after.json](read-1200-after.json), committed source `0471566…`.
[comparison.json](comparison.json) retains every measured stage before/after.
[benchmark-conditions.json](benchmark-conditions.json) records no concurrent
task test/build before the after run. Both use Node 24.11.1, Darwin arm64,
SQLite 3.53.4, 120 Agents/Sessions, ten retained Jobs per Agent, 20% failed Jobs,
nine-byte results, a 12-row page, no execution/enrichment and fixture CLI failure.

| Operation | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | Child SELECT/request before → after |
| --- | ---: | ---: | ---: |
| Warm overview | 971.86 / 1307.36 / 1307.36 | 202.01 / 256.43 / 256.43 | 1350 → 36 |
| Warm history list | 1300.63 / 1595.51 / 1595.51 | 200.91 / 306.68 / 306.68 | 2430 → 36 |
| Warm selected detail | 856.61 / 939.27 / 939.27 | 17.20 / 40.35 / 40.35 | 1226 → 27 |
| Eight identical burst callers | 3483.01 / 7811.85 / 7811.85 | 190.71 / 191.72 / 191.72 | 8 physical reads → 1 |

Overview Job construction p50 falls 750.81→106.48ms and projection
188.39→82.17ms. History construction/projection p50 falls
741.48/516.50→90.28/95.22ms. Detail construction/projection falls
725.83/100.57→2.31/6.63ms. Overview config p50 remains about 1.3ms;
serialization preflight remains about 0.04ms. Overview/detail response bytes
remain 1587/2331. Burst child queue maximum falls 6644.56→0.065ms, with seven
callers sharing one physical read. Total physical reads fall 41→34. List IPC
calls above the native 3-second budget fall 5/30→0/30; read deadline failures
remain zero, and physical capacity after completion remains zero.

First overview improves 1205.52→323.98ms. The single Settings observation
improves 2379.31→1245.21ms, with 0.097ms Job construction; most remaining time
is fixture CLI/Settings projection. Uninstrumented controls show overview
p50/p95 944.05/1101.70→202.39/234.71ms and history
1306.80/1567.58→206.33/254.31ms. They use a second child; this is not an isolated
estimate of diagnostic overhead.

Ten warm samples per mode use nearest-rank quantiles, so p95/p99 are the sample
maximum, not population-tail estimates. Host load and OS cache are uncontrolled.
Legacy unfiltered non-history calls return counts with no rows; the original
options are intentionally preserved and actual paged/history correctness is
tested separately. Whole-list metadata/count computation and fresh Job hydration
still scale with retained data. Complete `statusRows` materializes its requested
histories. This change does not claim all list work is proportional to page size.

Child SQL counts exclude the new parent revision SELECT/PRAGMA reads. Stage
times include their SQL; there is no SQL lock-wait, disk I/O or pure transport
measurement. IPC latency is not a Swift socket timeout fraction. Swift decoding
is synchronous: expiry/cancellation prevents publication after it returns but
does not preempt expensive decoder CPU work.

W3 counters remain intentionally unchanged: empty20 has 20 SELECTs and 20
BEGIN/COMMIT pairs, zero UPDATEs/changed rows; release/reclaim10 has 20
transactions, 20 UPDATEs and 20 changed rows. WAL file length delta is zero,
which does not establish zero WAL frame writes, fsync or physical I/O.

## Acceptance and regression evidence

Acceptance numbers refer to the saved issue's 17 bullets; the complete original
map remains in the [P0 audit](../issue-242-p0-w0-20261007/README.md).

| Acceptance | Focused proof / remaining scope |
| --- | --- |
| 1–2: phase costs, paging/count/order/filter/revision | Same W0 fixture before/after; new `issue242Reads` page/offset/count/history/detail comparison and bounded SQL; existing Dashboard tools regressions. Larger/production distributions and population quantiles remain open. |
| 3: same-query sharing and real capacity | `issue242Reads`: reordered argument keys share one read; A cancel/B succeed; last waiter holds old slot, queued cancellation skips hydration, fresh retry uses another slot; write/deadline isolation. Existing pool/capacity/restart tests and supervisor 128-slot test. |
| 4: deadline/cancellation/taxonomy | `issue242ReadTransport`: deadline and cancellation across real isolated supervisor IPC; Unix RPC tests: real refusal, peer close, malformed envelope, partial-response absolute deadline, cancellation through decode and existing wait cancellation/independent health. Synchronous decode cannot be preempted. |
| 5: retained observation contract | Native helper-RPC failure retains dashboard/detail/Settings/Skills/check time after grace; first failure, timeout metadata, recovery, cancellation, confirmed stop, target switch, delayed health and delayed content tests. All production opt-in/live tests excluded. |
| 6: A pending → retire A → same-cwd B UUID | Backend fixture commits actual archive/completion/delete/B registration before A response publication, rejects A, displays separate B identity and preserves `PROJECT_MANAGEMENT_ENDED` for A management request. Native delayed A page/detail cannot publish across Settings registry changes. Existing three lifecycle/replay tests pass. |
| 7–11: completion event/claim/retry cost | W0 characterization and completion counters preserved, not fixed; W3 owns durable readiness, preflight, bounded calls/backoff and recovery matrix. |
| 12–13: launcher/runtime observation and watchdog | Deferred to W4. Existing native lifecycle/operational notification tests run, without changing launcher health/probe/drain behavior. |
| 14,16: execution, replay, permissions, prior contracts | Selected runtime forwarded-request/stale-heartbeat, proxy-readiness, caller-close, capacity and valid question/cancellation/exact-result saturation controls; query-only writer-ownership checks; full native suite. Observation failure adds no execution replay/cancel path. Full repository/installed integration acceptance remains later work. |
| 15,17: 502 and artifact-bound installed validation | Existing five proxy characterization fixtures still pass. No installed 502 cause or installed-app fix is claimed. |

[validation.json](validation.json) records commands, outcomes and artifact hashes.
The build and strict harness typecheck pass. Focused Node checks account for
19 read/pool/transport cases, 12 lifecycle/dashboard/proxy cases, 25 companion/
remote cases and four runtime controls plus the corrected capacity recheck.
Full strict-concurrency/warnings-as-errors native validation passes 236 cases
with two live opt-in tests skipped and zero failures. One additional synthetic
slow-decoder test passes, proving that synchronous decode cannot publish after
the absolute deadline; it does not assert CPU preemption.
The helper-failure retention test was first run red against W0 behavior, then
passed with W2. Final review added a decoder-cancellation red/green regression.
An existing runtime capacity assertion was updated from the old generic timeout
string to the intentional read-specific `STATE_READ_STALE`; control error,
128-slot reservation and settlement assertions remain intact and pass.

The worst-case Node Skills test (3 MiB C0 source, about 18 MiB JSON) exceeds its
existing 20-second fixture limit in both current-source quiet execution and an
identical temporary P0 source snapshot. All three failed-run logs are retained.
This is a pre-existing validation gap; no timeout was raised to hide it. The
Swift byte-envelope test now explicitly uses a test-only 60-second call budget
because the debug decode phase (validation and decoding) can exceed the ordinary
deadline. Separate deadline tests
verify rejection of trickled responses and publication after expiry. This proves
byte-capacity compatibility, not maximum-payload performance within production
deadlines. An earlier Swift run edited during compilation was discarded and
rerun with fixed inputs; it is not counted as a passing check.

## Next work and integration boundaries

W3 can proceed with one owner for completion/event hunks in `tools.ts`, outbox
methods in `stateStore.ts`, `completionDelivery.ts`, `changeSignal.ts` and
companion topic contracts; native delivery/change/poll hunks in `AppModel.swift`
and `CompletionNotifications.swift` must preserve W2 observation generations.
Use a durable readiness topic, read preflight, atomic conditional claim and
due-time retry/backoff; prove event up/down rates, lease/dedup/reconnect behavior
and required durable records. Do not edit the W1 hydration/query hunks in parallel.

W4 can proceed on launcher/status/managed-file code, `macosHelperServer.ts` and
`OperationalNotifications.swift`, with coordinated helper/native status schema
changes. Reuse W2 failure/confirmed-observation contracts. Measure API/probe/
subprocess/file cost and keep health independent of event liveness; retain
watchdog/drain protection and actual-stop handling. W4 does not own Dashboard
query optimization or completion retry policy.

R502 investigation can proceed in proxy/ingress hunks of `runtimeProcess.ts`,
`server.ts` and isolated fault fixtures; W1 owns that file's read-RPC hunks.
Existing synthetic outcomes are pre-header reset/idle→structured MCP 503,
post-header partial body→incomplete 200 and caller-first close. Production 502
cause remains unconfirmed. Obtain tunnel/internal/application phase correlation
and connection-close/event-loop-delay evidence before choosing a causal fix;
retain unknown outcomes and replay/execution contracts.

No user decision blocks those implementation streams. Remaining risks are the
maximum-payload validation/performance gap, synchronous SQL/decode cancellation
limits, large/distributed workload coverage and eventual integration conflicts.
Original local-only `9be3bb6…` overlaps W1 reads/batching, and other preserved
native/model work overlaps AppModel and views. Review those commits deliberately
before integrating the remote-dev task line into local dev. Keep this committed
branch/worktree and all P0/W0 evidence until the user authorizes integration.
