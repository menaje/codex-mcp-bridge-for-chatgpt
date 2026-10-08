# Issue 242 integrated candidate, 2026-10-08

This candidate combines the exact user-approved P0/W0, W1/W2, W3, W4 and R502
components. It is ready for independent local verification. It is not integrated
into `dev`, installed, published, or a claim that all production acceptance is
complete. Production 502 causality remains **unresolved**.

## Authority, history and preservation

| Component     | Exact approved HEAD                        | Integration                                                           |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| P0/W0 + W1/W2 | `f710974b33fc40432653c815d175058cba1adaee` | Exact starting commit and tree                                        |
| W3            | `6580a196a36dacaa94fff7a6b5a101f58efff9a8` | Ordinary merge `bb1d0c2`; includes `fa0cc254`, `bff15a07`, `6580a196` |
| R502          | `e550798fe16bd5944f69f1941a98d249e84adefc` | Ordinary merge `ac8500a`; includes `49d29e9`, `e550798`               |
| W4            | `2eb315d529e57164b3e4a53cf24737ef3f4649e1` | Ordinary merge `b52c1b8`, after W3 and R502                           |

Branch: `codex/issue-242-candidate-20261008`. Worktree:
`/Volumes/Data/Dev/codex-mcp-bridge-issue-242-candidate-20261008`.
The lifecycle target is explicitly recorded as eventual `dev`. The user's
no-merge instruction takes precedence over completing that integration now.
Candidate/worktree cleanup and eventual divergent-dev integration remain pending.
No component or pre-existing worktree was removed. No conversation was changed.

[components.json](components.json) records full commit IDs, trees, component
commit lists, changed-file inventories and binary-diff hashes. All four approved
heads are ancestors of the candidate. W4's merge base is exact
`8474165e523b47d881f688bd09caf2e4c78ac7af`; that base already belongs to the
W1/W2 starting history. Its 35 staged paths exactly matched the authoritative
`8474165e..2eb315d5` changed-file set before committing. This imports W4's delta
without replacing newer baseline files.

Audits and each changed-file set were inspected before merging. There were no
textual conflicts. R502's `runtimeProcess.ts` overlap preserves W1's read
contexts and W3's generation-checked `completion-outbox-ready` topic alongside
private HTTP diagnostics and settled-response guards. W4's native overlaps in
`AppModel.swift` and `AppPresentationTests.swift` retain W2's confirmed-helper
history, content/health generations and late-A fencing, plus W3's completion
wake state, authorization, debounce and recovery. W4 adds tunnel observation
attention without converting helper observation failure into execution authority.
No whole-file checkout from the older W4 base was used.

[preservation.json](preservation.json) verifies unchanged original local `dev`
`ea8f93e2acbb9f4b6deca113165d27e8c9c23857`, its complete 23 local-only commits,
unchanged `origin/dev` `264fa5c99ca1c8edeef50af247614204c8f3df53`, unchanged `main`,
and clean original checkout. No reset, rebase, force push, remote write, GitHub
Actions, production app/DB/user-data operation or installed runtime restart was
performed.

## Integration-owned fixture corrections

Commit `0bd61eb7c29521e1c4e33ecb8e0fe54a983bb42c` makes two fixture changes:

- R502's real-child phase assertion now waits for both handler `cleanup` and
  HTTP `response-complete`. These events cross IPC independently. Waiting only
  for cleanup can inspect the list before finish arrives. The initial candidate
  had 57 passing focused cases and this one failure. The **unchanged exact
  `e550798` component** reproduced the same missing-finish assertion, with its
  other 14 cases passing. All original expected phases, privacy assertions and
  the existing `vi.waitFor` deadline are preserved. No product code changed.
- `scripts/issue-242-integration-read-cost.ts` preserves the existing W1/W2 read
  workload and assertions, while completion costs run separately through W3's
  fixture. The historical characterization script remains untouched: its W0
  immediate-release/reclaim assertion intentionally describes the pre-W3
  behavior and cannot measure W3's deferred retries. No historical expected
  value was changed to obtain a passing test.

Commit `36ffd412249822390478631cdef4092f370ec0fc` only formats the new read-cost
script with repository-established Prettier 3.6.2. It does not alter the workload.
[failure-evidence.json](failure-evidence.json) preserves the original failing
logs and hashes, including the exact R502 component control.

## Validation identity and reproducibility

The first complete implementation validation used clean HEAD
`0bd61eb7c29521e1c4e33ecb8e0fe54a983bb42c`, tree
`0710230427c409199cbcb4d0d0f72efe05c28c80`.
[validation.json](validation.json) binds commands, exit codes, times and log
SHA-256 values to their exact heads. [node-index.json](node-index.json) records
all 135 file results and focused acceptance test names.

All checks run serially with a fresh short task-owned TMPDIR, explicit task-owned
XDG configuration/cache directories, and a restricted child environment that
does not inherit operational `CODEX_HOME`, OpenAI/tunnel credentials or bridge
configuration. `/usr/sbin/taskpolicy -a` applies only to validation children, as
established by the prior #240 ordinary-policy/controlled-policy comparison.
There are no timeout overrides or changes to product deadlines, capacities,
expected results, freshness, retention or durable recording.

The available isolated CLI is exact **0.153.3**, at the path in
[environment.json](environment.json). `validate:fast` verifies the pinned App
Server lock, including 416 JSON and 827 TypeScript schema files. The local
tunnel fixture uses Homebrew's available exact
`0.0.14+0f870e50a973fa820d4c409000059e181e8d242b` binary. Its opt-in R502 test uses
synthetic loopback targets and temporary profiles, without a hosted connection.

| Check at implementation HEAD                                                       | Result                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Build, `tsc --noEmit`, `validate:fast`                                             | Pass                                                                                                                      |
| Strict extra typecheck of all Issue 242 tests and count/read fixtures              | Pass                                                                                                                      |
| Complete unfiltered Node suite, one worker, default deadlines                      | **135 files / 1,493 tests pass**, zero failures or skips; 786.03s Vitest duration                                         |
| All Issue 242 focused/characterization tests, HTTP diagnostics and W4 tunnel tests | Included in full suite: **58 cases pass**, including the pinned local tunnel case                                         |
| #240/#241 lifecycle                                                                | 27 lifecycle + 5 host cases pass; late pending A/delete/same-cwd B also passes in Issue 242 reads and native presentation |
| State migration fixtures                                                           | 16 cases pass; host fixtures verify `integrity_check=ok` and empty `foreign_key_check`                                    |
| Strict macOS suite                                                                 | **246 executed, two live opt-in skips, zero failures**; complete concurrency and warnings-as-errors                       |
| #224 project-recovery browser fixture / #221 card fixture                          | Pass / six scenarios pass                                                                                                 |
| Integration delta `git diff --check f710974 HEAD`                                  | Pass                                                                                                                      |
| New integration-owned read fixture Prettier check                                  | Pass                                                                                                                      |

The aggregate `264fa5c..candidate` whitespace scan reports eight blank EOF lines
in preserved W1/W2 historical logs. Its output is **byte-identical** to
`git diff --check 264fa5c f710974`; no new whitespace defect was introduced by
integration. Those artifacts remain byte-identical to their approved component.
The broader default Prettier scan reports 39 inherited component files after
formatting the new fixture. [format-provenance.json](format-provenance.json)
reproduces every flag on an exact approved component version. This is a recorded
style limitation, not a green aggregate formatting result. There is no repository
lint script/config; no lint pass is invented. Reformatting unrelated baseline
lines or historical evidence is outside this integration's scope.

After this audit is committed, the candidate is frozen. Build/type/fast, full
Node, focused Issue 242, strict native, browser, cost, integration-diff and own
format checks are run again at **that same final HEAD**. Raw logs and exact-head
receipts remain in ignored `output/issue-242-integration-20261008/` under
`final-*`; `final-verdict.json` records the final HEAD/tree and results. This
keeps the committed audit stable while making the final candidate directly
verifiable. The final response reports that result; earlier heads are never
substituted for a failing final run. The retained
[validation-runner.py.txt](validation-runner.py.txt) is the original runner
source; copy it and a newly allocated environment configuration into an ignored
evidence directory before reproducing commands.

## Comparable cost evidence

Both read sides use Node 24.11.1, Darwin arm64, the same locked dependencies and
SQLite 3.53.4, the same process policy, and serial task-only workload. Before
is an unchanged exact `8474165e` archive with its original characterization
script. After is the integrated implementation's read-only copy of the same
workload. There are 1,200 retained Jobs, 120 Agents/Sessions, ten Jobs per Agent,
20% failures, nine-byte results and a 12-row page. No execution or runtime
enrichment occurs. The fixture CLI is `/usr/bin/false`.

| Read operation          | Before p50 / p95 / p99 ms    | Integrated p50 / p95 / p99 ms | Child SELECT/request before → after                 |
| ----------------------- | ---------------------------- | ----------------------------- | --------------------------------------------------- |
| Warm overview           | 145.65 / 159.73 / 159.73     | 30.66 / 36.30 / 36.30         | 1,350 → 36                                          |
| Warm history            | 196.41 / 200.40 / 200.40     | 31.89 / 37.67 / 37.67         | 2,430 → 36                                          |
| Warm selected detail    | 121.01 / 126.90 / 126.90     | 2.58 / 3.84 / 3.84            | 1,226 → 27                                          |
| Eight identical callers | 531.88 / 1,053.58 / 1,053.58 | 28.69 / 28.80 / 28.80         | Eight physical reads → one, seven coalesced callers |

Each sequential warm mode has ten samples; p95/p99 therefore equal the maximum,
not population tails. Before burst values are parent-observed physical IPC
latency; after values use the added caller-latency observation around the shared
promise. Both measure completion of the same eight calls, but are not pure wire
latency. First overview is 186.77→49.27ms; Settings is 307.37→198.49ms. Physical
reads are 41→34. Both sides have zero 10-second deadline failures, zero IPC
comparisons above the native three-second budget, and zero physical slots after
settlement. Child SQL excludes parent revision SELECT/PRAGMA checks. OS cache and
background load are uncontrolled. These numbers must not be compared causally
with the earlier ordinary-policy component runs.

The W3 before cost was rerun on unchanged exact `f710974` using its historical
40-Job characterization; after uses the integrated canonical W3 40-Job count
fixture. Identical direct empty/retry samples exclude setup.

| Completion cost                       | Before → integrated                                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twenty empty claims                   | 20 SELECTs on each side; **20 → 0 BEGIN/COMMIT pairs**; zero updates/changed rows                                                                                                       |
| Ten immediate retry checks            | Release/claim dispatches 10/10 → 1/10; SELECTs 30→11; transactions, UPDATEs and changed rows **20→1**                                                                                   |
| Four hundred ordinary progress events | Integrated: 400 Dashboard notices, **zero readiness notices, claims, SQL or transactions** in this progress fixture; native event fixture separately checks no progress-triggered claim |
| Twenty availability calls             | 20 SELECTs, zero transactions or changed rows                                                                                                                                           |
| Twenty-five completion backlog        | Batches 10/10/5; three claim + three ack transactions, 82 SELECTs, 50 UPDATEs/changed rows; extra empty confirmation remains read-only                                                  |
| Due retry                             | Three SELECTs; one transaction, update and changed lease                                                                                                                                |

Required Activity/Job/event/outbox records remain: enqueue produces 25 readiness
notices, 100 required transactions and 775 changed rows. Retry WAL file-length
delta is 123,600→0 bytes; this is not a count of reused WAL frames, fsync, physical
I/O or lock wait. No required recording was removed to obtain these costs.

W4's 60-sample comparison runs old CLI health and direct polling against the same
owned fixture endpoints in one process, then measures old/additive status JSON.

| Runtime cost       | CLI/before p50 / p95 ms | Direct/after p50 / p95 ms |
| ------------------ | ----------------------- | ------------------------- |
| Tunnel observation | 14.368 / 15.578         | 4.343 / 5.813             |
| Atomic JSON        | 7.016 / 8.027           | 7.050 / 8.067             |
| File fsync         | 2.844 / 3.832           | 1.842 / 3.373             |
| Directory fsync    | 3.131 / 3.827           | 3.033 / 3.526             |

Steady-state health subprocesses become zero (previous five-second cadence:
12/minute). Both implementations poll three endpoints; both file and directory
fsync remain, and status publication stays at five seconds with 20-second
freshness. Direct 700ms delays settle confirmed in 705.21ms. A three-second delay
settles in 2,006.56ms with timeout, surviving daemon and bounded retained recent
external success. Both CLI controls exit 2 with a positive external-poll metric.
Endpoint success, external success, local observation failure and daemon exit
remain distinct. n=60 p99 is the sample maximum. Sequential batches, OS/cache
load and fsync interception prevent claims about physical I/O or installed rates.

Raw aggregate reports are [read-before.json](read-before.json),
[read-after.json](read-after.json), [completion-before.json](completion-before.json),
[completion-after.json](completion-after.json) and [runtime-cost.json](runtime-cost.json).
Final-HEAD repeat measurements are retained separately with exact-head receipts;
host variation does not change the deterministic SQL/transaction contracts.

## All 17 issue acceptance criteria

Numbers follow the saved authoritative
[issue snapshot](../issue-242-p0-w0-20261007/issue-snapshot.json).
“Fixture pass” does not mean installed acceptance.

| #   | Criterion and test/evidence mapping                                                                                                                                                                   | Verdict / limitation                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Read stage costs/quantiles: paired 1,200-Job reports, queue/config/DB/registry/projection/encoding/response size, separate uninstrumented controls                                                    | Fixture pass. Larger/production distributions, ≥100 population samples, SQL lock/disk and pure transport attribution remain open.                                                                                                                                                                                           |
| 2   | Page/count/filter/order/history revision equivalence: `issue242Reads`, Dashboard tool contracts, fresh selected-detail/Settings hydration                                                             | Fixture pass. Whole-list metadata still scales with retained data; no all-work-is-page-sized claim.                                                                                                                                                                                                                         |
| 3   | Same-query sharing, A cancel/B survive, last waiter cancellation and synchronous physical reservation: `issue242Reads`, `displayReadPool`, `stateReadProcess`, runtime capacity/control-reserve tests | Pass; physical capacity remains charged until response or child exit, settlement exactly once.                                                                                                                                                                                                                              |
| 4   | Absolute deadline, partial response, cancellation and taxonomy: `issue242ReadTransport`, companion/remote suites, `UnixSocketRPCClientTests`, independent read-service lanes                          | Fixture pass. Synchronous SQLite and Swift decode cannot be CPU-preempted; expired results cannot publish. Universal production payload headroom remains unproven.                                                                                                                                                          |
| 5   | Retained confirmed content/check time after helper/internal timeout, eight-second grace, first failure, recovery, normal cancellation, stop/target/generation changes, Settings/Skills                | Native `testIssue242HelperRPCFailureRetainsObservationAfterGrace`, `testIssue242HelperRPCFailureKeepsSettingsSkillsDetailAndFencesLateReads`, late helper/confirmed stop and RPC transport tests pass. Historical display grants no execution permission.                                                                   |
| 6   | Pending A → archive/delete A → same-cwd new UUID B → late A response; exact old management request                                                                                                    | `issue242Reads` rejects A publication and preserves `PROJECT_MANAGEMENT_ENDED`; 27 lifecycle + 5 HTTP/Settings host cases, native late Dashboard/detail and browser fixture pass. DB integrity and FK checks pass.                                                                                                          |
| 7   | Ordinary progress/unrelated Settings do not wake completion claims; supported-event periodic recovery is bounded                                                                                      | W3 400-progress costs, native `testW3ProgressDoesNotClaimAndReadyDrainsTwentyFiveInDebouncedBatches`, wake-state progress/Settings and 60s/10s recovery tests pass. No installed timer-rate measurement claimed.                                                                                                            |
| 8   | Empty preflight is read-only, consumer race retains atomic revalidation, denied permission never claims                                                                                               | `issue242Completion`, 20-empty cost, native denied/revoked authorization and preflight tests pass. Lost consumer races remain separately counted transactions.                                                                                                                                                              |
| 9   | Debounce/singleflight/ten-item batches and delivery-failure backoff                                                                                                                                   | Native generation/singleflight/batch tests, durable owner/retry tests, 10/10/5 drain and deferred-release costs pass. Release does not emit readiness.                                                                                                                                                                      |
| 10  | Lost ack/event, duplicates/order, unsupported/reconnect/epoch/app restart, lease/retry and stable IDs                                                                                                 | `issue242Completion`, `CompletionNotificationWakeTests`, delivered-but-ack-lost and actual DB close/reopen/lease tests pass. Notification retry never retries a Codex Job.                                                                                                                                                  |
| 11  | Separate SQL/transaction/rows/WAL/file costs; preserve input/approval/terminal, lease/attempt/receipt records                                                                                         | Completion reports plus full Job/input/approval/receipt/storage suites pass. WAL length is separated from physical I/O; lock/disk costs remain unmeasured.                                                                                                                                                                  |
| 12  | 700ms/seconds delay, failed probe, actual daemon exit, stale/frozen external poll; singleflight/identity/restart/wire/file freshness                                                                  | 21 `tunnelHealth` cases, runtime-status/managed-file/helper identity and heartbeat, real fixture daemon-exit/launcher tests pass. Actual hosted external outage and installed acceptance remain open; no cached readiness crosses observer restart/PID/origin replacement.                                                  |
| 13  | Events cannot mask bridge health; observation gap/recovery and drain protections                                                                                                                      | Independent ten-second `beginPolling` status watchdog remains outside event support; native observation-gap/grace/recovery and backend stale-heartbeat/hang/lifecycle/drain tests pass. 30s max observation gap/60s recovery unchanged. Installed events-up/bridge-hang timing remains unmeasured; drain code is unchanged. |
| 14  | Observation failure does not cancel/fail/re-execute ongoing Jobs; recover same identity/result                                                                                                        | Full execution recovery, cancellation, thread/Job isolation, exact replay/current-selector, durable receipt, HTTP detach and lifecycle retention suites pass. No observation path adds execution authority.                                                                                                                 |
| 15  | Identify actual 502 termination cause with causal before/after-header/caller-close regression evidence                                                                                                | **Production cause unresolved.** R502 real proxy/child, late request/response/timeout framing races, exact-once allocation cleanup, privacy/cap and pinned local tunnel tests pass. Synthetic race is fixed; it does not prove installed causality. Follow-up below.                                                        |
| 16  | Preserve #143/#185/#191/#193/#200/#240/#241 isolation, permissions, execution retention, capacity, control priority, errors, replay and lifecycle                                                     | Complete 1,493-case Node and strict native gates, explicit lifecycle/capacity/read/runtime/server/event/completion files and DB fixtures pass. No installed original-conversation mutation or acceptance experiment.                                                                                                        |
| 17  | Distinguish tests and installed bundle, avoid timeout/capacity increases, history/durable loss or removing all polling                                                                                | No installation performed. Exact-head fixture evidence, preserved deadlines/data contracts, independent watchdog and direct tunnel polling retained. **Installed-bundle acceptance intentionally unresolved** under the user's production prohibition.                                                                      |

## Residual investigation and verification boundary

The known synthetic settled-response race has regression evidence and a minimal
guard. All proxy error/timeout/caller-abort paths are inert after settlement;
capacity settles once, and post-header faults do not fabricate a complete MCP
error. Private correlation stays capped at 128 requests × 32 records and disabled
by default. Local response finish is not proof of caller receipt. IPC arrival
order is not cross-process causality. None of this identifies the installed 502
initiator.

Production follow-up requires separate authorization for a bounded diagnostic
window on an artifact-identifiable installed build: join supervisor ingress,
child application/state, local socket completion/close and existing tunnel
failure evidence for the same request. Completion requires locating the causal
termination boundary, reproducing it with matching classifier/framing evidence,
and validating the cause-specific fix and normal recovery. Until then, external
ingress reset, partial upstream termination/idle and late framing-event ordering
remain hypotheses. Do not label this integration a production 502 fix.

Independent verification may proceed from the frozen candidate using its final
exact-head receipts and the preserved component audits. `dev` integration and
worktree cleanup are deliberately pending; eventual integration must separately
review the original 23 unrelated local-only commits. Installed-bundle/live host
acceptance and broader production distributions remain separate work. Historical
aggregate whitespace and inherited default-formatter flags are explicitly
recorded; functional gates must not be represented as cleaning those style flags.
