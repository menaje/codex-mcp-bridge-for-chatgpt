# Issue 242 implementation kickoff: P0 / W0

Scope: baseline, acceptance mapping, ownership/conflict review, bounded private
diagnostics, and isolated characterization. W1–W4 and R502 are recommendations,
not delivered fixes. No issue acceptance checkbox is marked complete by this
audit. The user expressly withheld integration into `dev` for this kickoff.

Authority: [GitHub #242](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/242),
read on 2026-10-07, `updated_at=2026-10-07T09:46:56Z`, zero comments.
[issue-snapshot.json](issue-snapshot.json) preserves the exact body and metadata.
The issue label is P1; P0/W0 here names the kickoff scope, not a priority relabel.

## Git baseline and preservation

| Item | Exact state |
| --- | --- |
| Repository | `menaje/codex-mcp-bridge-for-chatgpt` |
| Task base / remote dev | `264fa5c99ca1c8edeef50af247614204c8f3df53`, merge of #241 |
| Original local dev | `ea8f93e2acbb9f4b6deca113165d27e8c9c23857` |
| Local dev divergence | 23 local-only / 17 remote-only commits |
| Original main / remote main | `8bb81b1b27745532b7bc2113bb00e66c43df3bbb` |
| Initial worktrees | Only `/Volumes/Data/Dev/codex-mcp-bridge`, on local dev |
| Original status | Empty `git status --porcelain=v1 --untracked-files=all` before and after work |
| Task branch | `codex/issue-242-p0-w0` |
| Task worktree | `/Volumes/Data/Dev/codex-mcp-bridge-issue-242-p0-w0` |
| Integration target | `dev`, explicitly recorded with the lifecycle hook |
| Measured implementation | `11cd8b9cee9167b97ce8a335a09f60479fffe039` |

`git ls-remote` matched the already-present `origin/dev` object; no fetch, reset,
rebase, cherry-pick, merge, push or unrelated ref movement was necessary.
[local-preservation.txt](local-preservation.txt) records unchanged original refs,
the complete local-only commit list, divergent paths, both worktrees, and remote
refs. Its four initial SHA lines are local dev, origin/dev, main, and original
checkout HEAD, respectively. Original tracked/untracked work was clean; ignored
files were not moved, deleted or reused. Dependencies, builds and new files were
created only in the task worktree. Fixture homes/databases/sockets were newly
allocated in temporary directories and removed by their owning harness.

The installed source named in #242, `9be3bb6c70b8673137fb8663c9137c07d1d7c90d`,
is present among the preserved **local-only** commits. Its existing audit is
historical evidence, not a measurement of this remote-dev baseline. We did not
run, update, restart or fault the installed app/helper/tunnel, open operational
databases, inspect user prompts/results, or change user settings. No GitHub
Actions, PR, release or remote write was invoked.

## Instrumentation and measurement semantics

`ChildProcessStateReadService.start({onMeasurement})` opts into one fixed-size
numeric record per settled read. It records child queue wait, config, database
open, Session/Job/Settings construction, read-facade construction, projection,
cleanup, JSON size/preflight encoding, SQL/SELECT counts, parent-observed total
duration and caller abandonment. The existing query-only #241 facade is used;
fresh registry construction remains intact. No tools/cards/schemas are registered
for these reads. The default service does not request measurement records.

`createIsolatedHttpServer({proxyDiagnostics})` opts into at most ten phase records
per admitted proxy request. Locally generated IDs correlate dispatch, request
finish, response headers, response end, internal idle expiry, upstream errors and
caller close/abort. `firstTermination` identifies the first termination event
**observed by this parent**, not a proven physical initiator. Hooks throw in tests
to verify that diagnostic failures cannot change transport/results/capacity.
No headers, paths, MCP IDs, SQL strings, credentials or payloads enter records.
This hook does not yet trace ingress rejections, application IPC dispatch or the
external tunnel. Collectors in the fixtures are capped at 128 records.

SQL timing is not isolated: the existing verbose callback gives statement counts,
not execution duration. Registry/projection stages include their SQL. Parent
`endToEndMs` includes parent send, IPC encoding/parsing/scheduling, queue and child
work. It is not a Swift socket measurement or pure wire latency.
`jsonPreflightMs` times the existing size-check encoding; IPC encodes again.
Queue timing starts at child message receipt, not at public ingress.

Completion fixtures reuse `BridgeStateStore.traceSql`, `total_changes()` on the
fixture handle, the real Job registry claim/release paths and the existing outbox.
Statement/BEGIN/COMMIT counts, changed rows and WAL **file length** delta are
separate fields. File length cannot count reused frames, fsync or physical writes.
Lock waits, SQL CPU time, disk I/O and probe subprocess cost remain unmeasured.

## Reproduction conditions and interpretation

Run `npx tsx scripts/issue-242-characterization.ts 100` or `1200`. The fixture
uses one synthetic scope, ten retained terminal Jobs per Agent, one tracked
Session per Agent, 20% failed Jobs, nine-byte synthetic results, a 12-row page,
no execution, no runtime enrichment and `/usr/bin/false` as the fixture CLI.
Fixture roots are canonicalized so the configured root ceiling matches stored
cwd paths. This distribution is documented, not asserted to match operational
data. No DB path or installed runtime path is accepted as input.

Each run has a first overview read, ten warm overview reads without history,
a first history-including read plus ten warm reads, ten selected-detail reads,
eight simultaneous identical overview reads and one Settings read. A second
child then makes ten warm reads per list mode without diagnostics. Registries
are rebuilt on every read in both variants. OS cache/load is uncontrolled.
The history-mode first read is not a cold process start. Quantiles use nearest
rank: for ten samples p95 and p99 equal the maximum and are not population-tail
estimates. Settings includes fixture CLI discovery/failure, not production CLI
performance. Parent event-loop delay does not characterize the child's loop.

The final aggregate reports are `read-100.json` and `read-1200.json`. An earlier
run overlapped Swift compilation; `read-1200-loaded-preliminary.json` retains that
separate sample. It exceeded 3 seconds for 7 of 30 list reads, including the first
read and six burst members, but had no 10-second read-service timeout. Do not
attribute its wall time to a function without accounting for host load.

The preliminary fixture preceded the canonical root ceiling and explicit
session-decision thread linkage used in the final harness. It lacks the
uninstrumented control. Its own latency/budget observations are retained, but it
is not a before/after comparison with the final run.

Final sequential measurements (milliseconds, diagnostics enabled):

| Fixture / operation | n | p50 | p95 / p99 | SELECT statements per request |
| --- | ---: | ---: | ---: | ---: |
| 100 Jobs, overview warm | 10 | 107.29 | 381.27 | 138 |
| 1,200 Jobs, overview warm | 10 | 971.86 | 1,307.36 | 1,350 |
| 1,200 Jobs, history warm | 10 | 1,300.63 | 1,595.51 | 2,430 |
| 1,200 Jobs, detail warm | 10 | 856.61 | 939.27 | 1,226 |
| 1,200 Jobs, burst of identical overview reads | 8 | 3,483.01 | 7,811.85 | 1,350 |

At 1,200 Jobs, overview Job construction p50 was 750.81ms and projection p50
188.39ms. Detail still constructed the Job registry (725.83ms p50) before its
100.57ms projection. Burst queue wait reached 6,644.56ms; all eight projections
ran separately. Five of 30 list calls (all burst members) exceeded the native
3-second budget by IPC timing; all 41 profiled calls completed by the 10-second
read deadline and physical read capacity returned to zero. No Swift timeout
fraction is inferred from these IPC calls.

The uninstrumented 1,200-Job controls measured overview p50/p95 944.05/1,101.70ms
and history p50/p95 1,306.80/1,567.58ms. They used another child, so differences
are not an isolated causal estimate of instrumentation overhead. The final run
had no concurrent task-owned build/test workload; background OS load remains
uncontrolled. SQL counts and these stage costs justify investigating fresh Job
construction and page/detail work in W1; they do not identify the installed
app's production bottleneck.

The W0 tests establish these current behaviors:

- Forty production progress-handler invocations across four fixture Jobs become
  forty application `dashboard` topics. No completion outbox exists. This tests
  backend conversion; native debounce means it is **not forty measured claims**.
- Twenty explicit empty claims execute 20 SELECT / BEGIN IMMEDIATE / COMMIT
  sequences, zero UPDATEs and zero changed rows. WAL file length stays unchanged.
- One real notify candidate acquires an atomic lease with one changed row.
  Ten explicit release/reclaim cycles acquire it again without any retry due
  time: 20 transactions, 20 UPDATEs, 20 changed rows. This is bounded re-eligibility
  evidence, not proof of an operational self-triggered infinite retry loop.
- The production Swift completion dispatcher makes 20 claims in 20 authorized
  explicit empty refreshes; another 20 denied refreshes add zero claims.
  Ten explicit helper reads and ten Dashboard reads reach their respective
  fixture methods and cause zero completion claims by themselves. These are
  caller-driven counts, not measurements of the native 10-second timer.
- The production AppModel retains a Dashboard for helper-internal `timed-out`
  evidence and shows `attention/responseUnconfirmed` after eight seconds. The
  RPC catch's `nil` observation plus error string first shows `checking`, then
  `unavailable/runtime`, and clears the Dashboard. W2 must change the latter
  behavior; its W0 test intentionally expects the defect. No real helper is stopped.
- The real internal proxy, with only its upstream destination redirected to an
  isolated HTTP fixture, returns structured MCP 503/`outcome=unknown` after a
  pre-header reset or internal idle expiry. After a partial body reset it leaves
  status 200 with `complete=false` and destroys the outgoing connection. Complete
  caller-first disconnect is separately observed. Subsequent valid requests,
  including a 100ms delayed response on a reused caller connection, succeed.
  The fixture idle limit is 200ms; production remains 120 seconds.

None of these proxy outcomes proves which path produced the installed tunnel's
502s. External tunnel classification, 2.5/4.5-second response tests and 700ms
health fixtures remain **reported installed-build evidence from #242**, not newly
performed latest-dev tests. Simultaneous connection reuse/close races and induced
high event-loop delay still require R502 coverage.

## Acceptance-to-test map

Numbers follow the 17 unchecked acceptance bullets in the saved issue. Existing
tests are starting points, not a claim that the new acceptance condition passes.

| # | Acceptance boundary | Current code / reusable evidence | Remaining test or implementation owner |
| --- | --- | --- | --- |
| 1 | Version-separated list/detail phase time, quantiles, timeout fractions | W0 script, read hook, final reports; `stateReadProcess.test.ts` | W1: larger samples and representative distributions, same-fixture before/after; installed comparison later |
| 2 | Page-sized work; count/sort/filter/history-revision equivalence | `stateReadModels.ts`, `tools.ts` Dashboard/detail builders; `workHistory.test.ts`, `tools.test.ts` | W1: SQL plans/indexes, per-page vs whole-history queries, complete equivalence across filters/offsets |
| 3 | Bounded refreshes, A cancel/B retain, last waiter, actual capacity | `DisplayReadPool`; `displayReadPool.test.ts`, `stateReadProcess.test.ts` abandoned-capacity case | W1: structural-read singleflight and waiter cancellation across native/remote/card callers; keep executing synchronous work charged |
| 4 | Absolute vs idle deadlines, cancellation, finite read retries | `UnixSocketRPCClient.swift`, companion dispatch, child read; `UnixSocketRPCClientTests`, proxy fixtures | W1/W2: queue-inclusive absolute budgets, fragmented responses, cancellation/error taxonomy, bounded retry; no execution replay |
| 5 | Last-good helper/list/detail/time, recovery, first failure, exit, cancellation, Settings/Skills | AppModel `refreshStatusOnce`/observation/read guards; W0 nil/probe contrast; `ConnectionRecoveryWindowTests`, `AppPresentationTests` | W2: independent last-good and latest failure, first/exit/recovery/cancel/target-generation matrix and Settings/Skills/details |
| 6 | A delayed read, retire A, same-cwd B UUID, late A fencing; exact management ended | fresh #241 graph, `projectLifecycle.ts`; `projectLifecycle.test.ts`, `projectLifecycleHost.test.ts` | W1/W2: combined in-flight projection/UI generation race with archive/delete and B re-registration, never cache by cwd alone |
| 7 | Progress/settings do not wake claims; event-up fallback rates | `tools.ts` broad topic conversion; AppModel change watcher/polling; W0 40-topic and empty-dispatch tests | W3: durable readiness topic and measured native timer/topic rates with event up/down |
| 8 | Empty preflight avoids writes; claim race stays atomic; permission gate | real outbox list/conditional claim; W0 empty20 and Swift denied refresh | W3: read preflight, two consumers race after positive preflight; distinguish that empty revalidation from ordinary empty check |
| 9 | Debounce/singleflight/batch bound and failure backoff | AppModel delivery Task; `CompletionNotifications.swift`; bounded release/reclaim fixture | W3: sustained signals, failure release notification, minimum interval and persisted next-attempt due time |
| 10 | Ack loss, missed/duplicate/reordered events, reconnect/epoch/restart/lease retry | `completionDelivery.test.ts`, `activityStore.test.ts`, `changeSignal.test.ts`, `CompletionNotificationsTests` | W3: end-to-end recovery matrix, stable IDs/dedup, bounded resync and lease/retry deadline wakeups |
| 11 | Call/SQL/transaction/rows/WAL/file distinctions; preserve durable evidence | W0 counters; `operationalCommandReceipt.test.ts`, progress fair queue and terminal persistence | W3/W4: lock/physical I/O and required-record comparisons; verify actual production in-process maintenance path before counting receipts |
| 12 | API delay vs probe exit vs daemon exit vs old poll/external failure; wire/freshness | launcher existing singleflight, `runtime-status.mjs`, helper watch; `runtimeStatus.test.ts`, launcher fixtures | W4: 700ms/multi-second API fixtures, bounded direct probe, locator/PID checks, 20-second file freshness and compatible unknown observation |
| 13 | Detect bridge hang with events up; watchdog 30s/60s; protected drain | helper health and 500ms drain snapshots; `OperationalNotificationsTests`, `runtimeAdmission.test.ts`, helper lifecycle tests | W4: hang/events-healthy, observation gap/recovery; drain only if measured, with loss/deadline/final protection revalidation |
| 14 | Observation failure never ends/retries Codex work; recover same identity/result | executor isolation, request replay/receipts; `runtimeProcess.test.ts`, `executionRecovery.test.ts`, `jobRegistry.test.ts`, `workerIsolation.test.ts` | W1/W2/W4: observation failure during active Job, recovery with same Job/turn and one execution |
| 15 | Production 502 cause and phase evidence; cause-specific regression/explicit handoff | W0 proxy phases and fault fixtures; installed evidence only via issue | R502: public/tunnel/internal/application correlation, closure races and induced loop delay; cause remains open, no follow-up issue created |
| 16 | Preserve #143/#185/#191/#193/#200/#240/#241 contracts | read/display/changes tests, selected runtime controls, project recovery/lifecycle; referenced prior audit suites | All owners: affected integration gate plus exact replay/receipt, fairness, permission and lifecycle regression suites before delivery |
| 17 | Test vs installed bundle; no timeout/capacity/history/durability shortcuts | W0 uses synthetic homes/DBs, fixed defaults and evidence categories | Later integration/release: artifact-bound installed validation, separate from unit/fixture passes |

## Recommended work boundaries and file ownership

These are logical ownership assignments for later work, not spawned agents or
parallel edits. Keep a single owner for shared files and coordinate boundary
changes before another workstream edits them.

| Stream | Scope / owned files | Entry and exit boundary |
| --- | --- | --- |
| W1 backend reads | `stateReadProcess.ts`, `stateReadModels.ts`, Dashboard/detail and registry-load sections of `tools.ts`, read portions of `stateStore.ts`, `sessionRegistry.ts`; `displayReadPool.ts`; read options/AbortSignal forwarding in `companionServer.ts`/`remoteCompanionServer.ts` | Reuse #241 facade and freshness, measure construction vs projection, then bulk/page SQL and scoped singleflight. Exit with equivalent counts/order/filter/page/revision and A/B project fencing, waiter cancellation and real capacity tests. No writer replacement or whole-controller redesign. |
| W2 native observation | `UnixSocketRPCClient.swift`, `BridgeClients.swift`, `BridgeApplicationClient.swift`, `AppModel.swift` status/read/connection generations, `AppLocalization.swift`; `BridgeModels.swift` only for a coordinated compatible contract | Add structured stage/errno taxonomy and separate latest failure from last-good data. Exit with cancellation/contract/first/exit/recovery and last-good list/detail/Settings/Skills matrix. Past observations preserve display, never grant new execution. |
| W3 completion/event cost | `completionDelivery.ts`, outbox methods in `stateStore.ts`, notify/subscription/claim/release sections in `tools.ts`, `changeSignal.ts`, companion topic contracts; `CompletionNotifications.swift`, AppModel delivery/change/poll hooks | Readiness signal after durable commit, preflight before writer reservation, conditional atomic claim and due-time retry/backoff. Exit with bounded native call rates and durable outbox recovery/dedup matrix. W2 owns AppModel editing and incorporates W3's narrowly reviewed hunks. |
| W4 tunnel/runtime observation | `start-codex-mcp-bridge.mjs`, `runtime-status.mjs`/`.d.mts`, `managed-file.mjs`, `macosHelperServer.ts`, `OperationalNotifications.swift`, corresponding status/notification models | Measure process/API/poll/probe/fsync separately; preserve singleflight, 75-second poll freshness, 20-second file freshness and wire/PID/locator checks. Then evaluate async direct local API and separate observation failure. Health remains independent of event liveness; watchdog 30-second gap/60-second recovery policy stays tested. Drain/recovery/archive/retention redesign excluded. |
| R502 independent investigation | Proxy/ingress sections of `runtimeProcess.ts`, bounded shared diagnostics only as justified; request observation in `server.ts`/application IPC, isolated proxy fixtures | W0 hook is a local parent correlation point. Obtain evidence joining public/tunnel/internal/application stages before a causal fix. Keep `not-observed/unknown`, MCP errors, #185/#200 replay and duplicate-execution contracts. No execution retry on read failure. |

`tools.ts` and `stateStore.ts` are shared W1/W3 files; review distinct hunk owners
sequentially. `AppModel.swift` is shared W2/W3 and sometimes W4; W2 integrates
those native changes. `runtimeProcess.ts` is shared W1 transport and R502; R502
owns proxy hunks, W1 owns read/application forwarding. Completion topic/model
changes require backend and native consumers together; tunnel status schema
changes require launcher/helper/native consumers together.

Preserved local conflict sources:

- `9be3bb6` already changes read lanes/construction, activity/recovery batching,
  `stateReadModels.ts`, `threadConnections.ts`, `stateStore.ts`, `tools.ts` and
  `stateReadProcess.test.ts`, and adds `dashboardReadQueries.test.ts`. Compare it
  deliberately with #241's fresh project-identity graph before adopting any
  portion. It is not in this task branch and was not retired or overwritten.
- Local model/reasoning/native editing work changes AppModel, BridgeApplicationClient,
  Settings/Skills/Dashboard views, localization, contracts, companion/remote
  code and execution code. New P0/W0 Swift hunks are only fixture tests; future
  W2/W3 work must preserve those commits and coordinate their eventual integration.
- Local `ea8f93e` changes CLI-update menu UI. Avoid consuming its branch or
  implicitly installing a bundle from it. Exact changed-path inventory is in
  `local-preservation.txt`.

Provisional W1 benchmark goals: at this fixed 1,200-Job distribution, overview
and selected-detail p95 below 1 second and p99 below 2 seconds in at least 100
samples, with 12-row queries bounded by page/bulk work; complete structured server
outcomes before the native absolute read budget, reserving measured encoding/
transport headroom. Final thresholds must use the measured environment and
larger sample set; they are proposed review targets, not achieved results or a
reason to increase timeouts. Eight identical readers should share needed work
without allowing one cancellation to invalidate the other seven.

## Validation and remaining state

See `validation.json` and the retained aggregate reports. Tests intentionally
expect several current defects; passing them establishes characterization, not
the issue's desired behavior. New fixture scripts/tests receive an additional
strict TypeScript check because the repository build includes only `src`.

Initial fixture problems were corrected locally: the proxy seeding connection
had to close before the runtime could become sole writer; the client had to use
the unmocked HTTP request so it reached the actual proxy; MCP error details live
under `error.data`; the nil-helper fixture also needed the RPC catch's error
string; and canonical fixture cwd/root paths had to match. An early Swift build
was invalidated by edits during compilation and was rerun. These are harness
corrections, not product fixes. An existing read restart poll missed its limit
under concurrent compilation and passed on the serial rerun. The existing proxy
readiness test exceeded its default five-second whole-test limit; its isolated
rerun passed with a 15-second Vitest limit (about 5.13 seconds test time).
Production 3/5/10/120-second budgets and all capacity constants are unchanged.

No implementation-blocking user decision is required for the next W1/W2/W3/W4
steps. Open evidence requirements are production-scale distributions, real
native timer/topic rates, SQL lock/disk/probe cost, installed-bundle acceptance,
and production 502 correlation. Existing local dev integration is a separate
preserved-work boundary; resolve it before eventually integrating this remote-dev
line into the divergent local dev checkout. Do not merge this kickoff now.

Task code, tests and evidence are committed on the isolated branch. Final head
is available with `git rev-parse codex/issue-242-p0-w0`; reports bind to the exact
measured implementation above. Integration into `dev` and task branch/worktree
cleanup remain pending by explicit user instruction. The task worktree remains
available for review and later work; no unrelated branch/worktree or Codex
conversation was removed or changed.
