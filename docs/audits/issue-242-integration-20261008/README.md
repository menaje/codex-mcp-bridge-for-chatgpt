# Issue #242 integration review candidate

This is a local development-stage review candidate. Integration into `dev` is
explicitly held. Local `dev` remains `ea8f93e2acbb9f4b6deca113165d27e8c9c23857`.
No production app, operational database, user data, conversation, GitHub Actions,
remote branch, or unrelated worktree was changed by this task.

## Source and integration

Required base: `f710974b33fc40432653c815d175058cba1adaee`, parent
`04ddf63ada7cc6a7172f4190b0909e8bd6d8a3b7`, tree
`bef9e8603b790327152beea63fa230f638f7aac4`.
Branch/worktree: `codex/issue-242-integration-review`,
`/Volumes/Data/Dev/codex-mcp-bridge-issue-242-integration-review`.
The worktree integration target was set to this review branch using the repository
lifecycle hook. This does not assert integration into `dev`.

All six component commits were replayed with `git cherry-pick -x`:

| Component | Original | Replay |
| --- | --- | --- |
| W3 implementation | `fa0cc25` | `45e6326` |
| W3 startup-count correction | `bff15a0` | `b5c54fe` |
| W3 audit head | `6580a196a36dacaa94fff7a6b5a101f58efff9a8` | `1214a73` |
| W4 sole task commit, parent `8474165…` | `2eb315d529e57164b3e4a53cf24737ef3f4649e1` | `fda7444` |
| R502 implementation | `49d29e9` | `abc1598` |
| R502 audit head | `e550798fe16bd5944f69f1941a98d249e84adefc` | `73e92d3` |

[Integration provenance](integration-provenance.json) records full original/replay
IDs, parents, trees, trailers and files. Every original added/removed line matches
its replay, excluding hunk context/line numbers. All 106 original component audit
files retain their exact blob IDs. W4 contributes only its task-owned diff above
`8474165`; none of that older base replaces W1/W2.

There were zero textual conflicts. Automatic overlaps were inspected directly:
`AppModel.swift` retains W2 confirmed observation/request generations, W3 readiness
and notification batching, and W4 unconfirmed tunnel health/recovery policy;
`AppPresentationTests.swift` retains all three sets of tests and composes the
fixture arguments. `runtimeProcess.ts` retains W1 read cancellation/deadline and
physical capacity accounting, W3 readiness/availability IPC, and R502 settled
response guards plus bounded correlation. Helper/status additions retain W2
cached bridge observation and generation fencing.

Two integration review commits follow the replay:

- `c83078898053470fb9b7e96e1760ab009addb790`: repair the P0 characterization
  harness for W3 persisted retry deadlines. It counts ten immediate attempts with
  one actual release/one mutation/one transaction, proves no immediate reclaim,
  advances only fixture time to the durable deadline and proves the same outbox
  ID is reclaimed. FK and integrity checks are added to that synthetic fixture.
- `e1cc5aea23da3fb8464301d00c0e905cca1b7bb7`: synchronize the R502 phase proof
  on both child handler cleanup and asynchronous response finish. All original
  assertions and timeouts remain. No product source changes follow `c830788`.

Final validated implementation: `e1cc5aea23da3fb8464301d00c0e905cca1b7bb7`,
parent `c83078898053470fb9b7e96e1760ab009addb790`, tree
`fceada340f793e6190a178caf8d236b642041c9e`.
The final audit commit is documentation only; its exact head, parent and tree
are returned in the handoff and obtainable with
`git show -s --format='%H %P %T' codex/issue-242-integration-review`.
[Validated identity](validated-identity.json) binds native validation to the
identical macOS subtree at the final implementation; the later change affects
only one Node test.

## Validation policy and outcomes

Existing dependencies were cloned from the authoritative base's `node_modules`;
no install, dependency resolution or lockfile modification was performed.
Codex CLI was explicitly resolved to the existing `0.153.3` binary recorded with
its SHA-256 in [environment.json](environment.json). Fast validation confirms
416 JSON / 827 TypeScript schema files. The existing pinned local tunnel binary
is `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`.

Following #240's demonstrated policy, validation children alone run under
`/usr/sbin/taskpolicy -a`; Vitest has one worker, task-owned TMPDIR, and operational
`CODEX_HOME` is unset. No validation adjustment changes the approved component deadlines or tests'
timeout constants. Live native companion/pairing opt-ins are excluded. This task's stages
are serialized; a separate candidate checkout ran tests concurrently on this
host and was left untouched. Global host load/cache exclusivity is not claimed.
See [host observations](host-validation-observations.json).

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| original characterization at `73e92d3` | FAIL | 1 command | — |
| build | PASS | 0 | — |
| tsc-noemit | PASS | 0 | — |
| validate-fast | PASS | 0 | — |
| focused-242 (14 files) | 171 | 1 | 1 |
| lifecycle-capacity-db (19 files) | 251 | 0 | 0 |
| characterization-1200 | PASS | 0 | — |
| completion-counts | PASS | 0 | — |
| tunnel-cost | PASS | 0 | — |
| native-full | PASS | 0 | — |
| node-full (135 files) | 1490 | 2 | 1 |
| harness-typecheck | PASS | 0 | — |
| w1-followup-contracts (4 files) | 66 | 0 | 0 |
| w3-compiled | PASS | 0 | — |
| tunnel-pinned (1 files) | 1 | 0 | 0 |
| baseline-build | PASS | 0 | — |
| baseline-characterization-1200 | PASS | 0 | — |
| baseline-progress | PASS | 0 | — |
| baseline-selected-failures (1 files) | 1 | 0 | 19 |
| candidate-selected-failures (2 files) | 1 | 1 | 33 |
| final-build | PASS | 0 | — |
| final-tsc-noemit | PASS | 0 | — |
| final-validate-fast | PASS | 0 | — |
| final-r502-retirement (3 files) | 38 | 0 | 0 |
| baseline-proxy-controls (1 files) | 5 | 0 | 0 |
| final-characterization-1200 | PASS | 0 | — |
| final-completion-counts | PASS | 0 | — |
| final-tunnel-cost | PASS | 0 | — |
| final-node-full (135 files) | 1493 | 0 | 0 |
| Full native, included in native-full | 244 | 0 | 2 |
| r502-authoritative-control | 1 | 0 | 14 |
| r502-authoritative-full-control | 14 | 1 | 0 |
| candidate-retirement-clean | 1 | 0 | 19 |

[commands.json](commands.json), [followup-commands.json](followup-commands.json),
[final-commands.json](final-commands.json), [additional-controls.json](additional-controls.json)
and their raw logs/reports retain each outcome, including selection skips and
failed runs. Runners are retained as exact execution evidence; their absolute paths and
TMPDIR must be adapted for another checkout. The first followup runner records
the original `.ts` helper attempt; use `baseline-progress-helper.mts` rather than
creating any module-mode file in TMPDIR for future reproduction. The first runner's tunnel opt-in
variable was misspelled, so its one opt-in Node skip is retained honestly. A
separate correctly enabled local Go fixture passed, and the final unfiltered
Node run enables it explicitly. This never launches a hosted/production tunnel.
Native skips are the live companion and live HTTPS pairing checks.

### Failure classification and corrections

- The first characterization script failed at the obsolete immediate-reclaim
  assertion, before it could emit its JSON. Its stderr is retained. This is a
  harness contract mismatch with W3, corrected without changing product retry
  semantics or loosening an assertion.
- The R502 test's complete phase set was asserted after child `cleanup` but
  before its asynchronous `response-complete` IPC record arrived. The full
  unmodified authoritative R502 source archive reproduces the same failure
  (14 pass / 1 fail); the selected case alone can pass (1 pass / 14 selection
  skips). This is an inherited test synchronization defect, not evidence of a
  production transport failure. Exact `f710974` predates that diagnostic API/test;
  its five existing proxy controls pass without any source overlay. The archive
  control verifies every original tracked blob and is documented in
  [r502-control-source.json](r502-control-source.json).
- The first full run's experiment-retirement failure was caused by this task's
  temporary ESM `package.json` in TMPDIR, used for an external TypeScript count
  helper. It changed the extensionless CommonJS fixture Git stub's module mode,
  producing `require is not defined in ES module scope`. Exact unchanged
  `f710974` passed the selected case in a separate clean TMPDIR. Removing only
  that task-owned helper file makes the unchanged candidate fixture pass too.
  The helper uses `.mts` for future reproduction; final validation uses a fresh
  TMPDIR with no ancestor `package.json`. This is validation environment
  contamination, not a product regression or an inferred host timing failure.

[Failure classification](failure-classification.json) links the original failed
runs, exact controls, corrections and final focused pass. No failures are erased
or relabeled as successful full-suite runs.

## Performance and transaction evidence

All measurements use synthetic temporary state and owned loopback services.
[Performance comparison](performance-comparison.json) includes full queue,
configuration/open/hydration/projection/serialization/response-byte/SQL metrics,
quantiles and raw counts. No per-statement duration, lock-wait attribution or
transport-only duration is invented. Warm read n=10 and tunnel n=60 p99 are
sample maxima; cache/load and separate fixture IDs/roots remain uncontrolled.

| Workload | Exact-base before | Integrated after |
| --- | --- | --- |
| 1,200 Jobs, list without history, p50/p95/p99 ms (n=10) | 33.066/36.661/36.661 | 30.509/40.296/40.296; median delta -7.73% |
| 1,200 Jobs, list with history, p50/p95/p99 ms (n=10) | 31.147/35.298/35.298 | 31.510/36.081/36.081; median delta +1.16% |
| History detail, p50/p95/p99 ms (n=10) | 2.473/3.675/3.675 | 2.486/7.082/7.082; median delta +0.52% |
| Eight simultaneous identical callers | 1 physical read, 7 coalesced | 1 physical read, 7 coalesced |
| Read timeout / over-native-budget fractions; capacity after | 0 / 0; 0 | 0 / 0; 0 |
| 20 empty claims: SELECT / writer transactions / changed rows | 20 / 20 / 0 | 20 / 0 / 0 |
| Ten immediate presentation attempts: releases / transactions / updates / changed rows | 10 / 20 / 20 / 20 | 1 / 1 / 1 / 1 |
| 400 progress events: SQL / transactions / changed rows | 0 / 0 / 0 | 0 / 0 / 0; no readiness notice/claim wake |
| Same-fixture tunnel CLI / direct probe, p50/p95/p99 ms (n=60) | 13.172/13.601/16.264 | 4.236/5.560/15.472; p50 -67.84%, p95 -59.12%; zero repetitive health subprocesses |
| Atomic status JSON, p50/p95/p99 ms (n=60) | 6.472/8.004/10.597 | 7.628/8.117/9.516; both fsync operations and cadence retained |

The historical P0 profile has 1,350 / 2,430 list SELECTs and 1,226 detail SELECTs,
versus 36 / 36 / 27 in the integrated profile. Those historical wall-time deltas
cannot be attributed solely to code across different scheduling policies. The
fresh exact-`f710974` comparison already includes W1/W2, and retains the same
bounded SQL counts and eight-call/one-physical-read sharing.

400 progress events across four synthetic running Jobs yield 400 ordinary
Dashboard notices, zero completion-readiness notices, zero completion SQL/
transactions/mutations. The native real-socket model test separately proves no
claim or availability wake from those 400 notices after startup; it drains
25 completions as 10/10/5 with three claims and three acknowledgments. Direct
count harness adds one read-only empty claim after the drain. Enqueue retains
100 required transactions and 775 changed rows; drain retains six transactions
and 50 updates/changed rows. Due retry changes one row in one transaction and
keeps the original event identity. These are fixture counts, not installed rates.

The tunnel fixture retains endpoint status, recent external poll success and
actual daemon identity separately. At 700 ms it confirms health; at 3 seconds it
expires the two-second observation and retains recent confirmed external success
with explicit timeout evidence. Stale polls, negative endpoints, shutdown,
identity replacement and actual daemon exit are covered by the tests. Atomic
status JSON still uses the five-second cadence, file fsync and directory fsync;
its additive payload remains protocol-1 compatible. File write/fsync measurements
are separate from SQLite. WAL file-length deltas are reported as lengths, not
frame writes, fsync, physical IO or lock-wait counts.

Proxy matrices cover pre-header reset, post-header incomplete body, application
and supervisor deadlines, caller-first detach, connection reuse/close, delayed
loop, and late request/response-error/timeout after a completed upstream response.
They prove one allocation cleanup/capacity release, preserved response framing,
bounded private correlation and continued application completion after observer
detach. Structured 503/unknown outcomes remain distinct from partial transport
loss/502 at the local Go boundary. Local response finish does not prove caller
receipt or result review; IPC record arrival order is not global event order.

## #242 acceptance map

Numbers refer to the 17 bullets in the saved authoritative Issue #242 snapshot.
“Fixture proven” describes the specific automated boundary, not installed or
production acceptance.

| # | Evidence and remaining scope |
| --- | --- |
| 1 | Partial: exact latest base and integrated 1,200-Job phased profiles, cold/warm conditions and timeout fractions recorded. Installed reproduction, realistic payload/distribution and population tails remain pending. |
| 2 | Fixture proven: bounded indexed list/detail SQL, ordering/count/filter/offset/history-revision equivalence; `issue242Reads`, Dashboard tools and full suite. |
| 3 | Fixture proven: same-query singleflight, A cancel/B survive, last waiter retains physical slot, queued work skipped, fresh retry, write/generation fences and exact capacity settlement. |
| 4 | Fixture proven: IPC queue deadline/cancellation; native partial-response absolute deadline, no-response/cancel/decode taxonomy and publication fences. Synchronous SQL/decode cannot be preempted. |
| 5 | Fixture proven: helper RPC and internal bridge timeout retain confirmed list/detail/time/Settings/Skills after grace; first failure, recovery, normal cancellation, actual stop and target/generation changes. Live installed flow pending. |
| 6 | Fixture proven: A pending -> archive/delete -> same-cwd new B UUID -> late A cannot republish or bind to B; exact A management remains `PROJECT_MANAGEMENT_ENDED`; backend and native fixtures. |
| 7 | Fixture proven: progress/settings do not emit readiness; 400 notices do not wake native claims; event-connected recovery cadence remains bounded. Installed per-method rates pending. |
| 8 | Fixture proven: truly empty/deferred preflight has zero writer transactions; concurrent consumer lost-race claim is revalidated atomically and counted separately; permission denial/revocation prevents claim. |
| 9 | Fixture proven: per-batch debounce, singleflight, ten-item cap, persisted retry deadlines and bounded recovery; failure/release does not self-trigger readiness. |
| 10 | Fixture proven: stable event ID, ack loss, duplicate/out-of-order notices, epochs/reconnect/restart, legacy unsupported notices, lease expiry and retry deadlines. |
| 11 | Partial: methods, SQL classes, BEGIN/COMMIT, changed rows, WAL lengths, subprocess and file/fsync metrics separated. Required terminal/event/lease/attempt/receipt records retained. Physical IO, full SQL duration and lock waits unmeasured. |
| 12 | Fixture proven: 700 ms and multi-second probes, abort/exit, stale/external poll, singleflight, identity fences and compatible fresh status files. Hosted external-failure acceptance pending. |
| 13 | Fixture proven for existing protection: full native/runtime/process suites retain hang/heartbeat/watchdog/drain protections and recovery notification policy; event availability is not tunnel/bridge liveness. Installed hang scenario pending. |
| 14 | Fixture proven: observation loss does not authorize Job cancellation/failure or replay; exact identity/result retrieval, stale heartbeat, detached caller completion, receipts/replay and worker isolation regressions pass. |
| 15 | Partial: isolated termination defect and cause-specific proxy/Go fixtures proven; bounded ingress/child/state correlation exists. **Production 502 cause remains unresolved.** No installed traces or fabricated closure/followup handoff. |
| 16 | Fixture proven: complete Node/native suites plus focused #240/#241 lifecycle/FK/replay and #185/#191/#200 execution, capacity, control/cancellation, permission and deduplication contracts. |
| 17 | Partial: automated evidence is separated from installed/bundle acceptance. Approved component deadlines, capacities and required durable records are preserved. Bounded recovery, liveness polling and heartbeats remain. Installed artifact-bound user flow remains pending. |

## Review handoff and lifecycle

Ready for an independent verifier of this clean committed review candidate.
Final automated gates are green, with the two native live opt-ins explicitly
skipped. This does not close Issue #242 or establish installed/production
acceptance. Remote `dev` was fetched and read back at `264fa5c…`; it has not moved
beyond the requested baseline, so no reconciliation was necessary.
[Changed files](changed-files.json) reports both the integration delta from
`f710974` and the complete issue delta from remote `dev`.

Component worktrees/branches and the unrelated candidate checkout remain intact.
Only this task's detached exact-base validation worktree is eligible for removal
after ancestry, clean-tree, ignored-output ownership and process/open-work checks.
The review branch/worktree is retained for the independent verifier and future
user-approved integration; dev integration and that later cleanup remain pending.
