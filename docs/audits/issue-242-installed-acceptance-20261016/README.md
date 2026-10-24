# Issue #242 installed-service acceptance, 2026-10-16

**NO-GO for closing #242.** The current installed service still fails the native
Dashboard summary and history-list reads. The unresolved production 502
investigation is explicitly transferred to [#262](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/262).
That transfer does not resolve the observed list-read failure or complete the
other installed acceptance conditions.

The installed app is version 0.4.1, build
`0129ae123694:d4a2a1d2ac95`, from clean commit
`0129ae123694ac53b876240968269b7a29f9f003`. Its signature passes deep/strict
verification. Current remote/local `dev` at the start of validation is
`f8395a5fe643394397d82d050e6e91ddb4873db8`; the intervening changes are two
historical-document annotations. All product source, native source, scripts and
dependency inputs are identical. The recomputed runtime source hash matches the
installed build. [Identity receipt](identity.json).

## Actual installed-service results

The probes compile the unchanged production `CodexBridgeKit` clients and call the
existing installed helper/bridge sockets. They do not replace the app, start a
second helper, submit a Job, claim/ack a notification, or inject a production
fault. This verifies actual Swift IPC and decoding against the installed runtime;
it does not verify the installed menu-bar window's visual behavior.

| Production client method | n | Success / failure | p50 ms | p95 / p99 ms |
| --- | ---: | ---: | ---: | ---: |
| `dashboardJobs`, summary, history excluded | 10 | 0 / 10 | 2523.384 | 2545.856 |
| `dashboardJobs`, 12-row history page | 10 | 0 / 10 | 2521.905 | 2603.731 |
| `dashboardExecutionDetail`, exact scoped terminal Job | 10 | 10 / 0 | 12.242 | 120.351 |
| `helper.health` | 10 | 10 / 0 | 9.068 | 36.016 |

These are serial, request-count functional checks, with the original 3-second
native list deadline and 2.5-second server budget for requests with `problems`.
No dwell/soak duration was introduced or shortened. With ten samples, p95/p99 are
sample maxima. The error is the structured remote `STATE_READ_STALE: Observation
deadline expired; retain the last confirmed view.` An independent raw request
with the same native query conditions reproduced that code after 2517.762 ms.
The successful detail target was selected privately from the read-only snapshot
because the native history-list check supplied no successful selection.

Earlier exploratory calls are retained separately: two older-compatible requests
without `problems` failed at their existing 1.5-second server budget; three calls
with the native query conditions succeeded in 942.136–1523.802 ms before the fixed
sample above. These successes are not substituted for the later failures, and
the shorter compatibility path is not mislabeled as the native app's budget.
[Samples](installed-reads.jsonl), [detail samples](installed-detail.jsonl),
[summary](installed-read-summary.json), [other observations](operational-observations.json).
The two retained Swift probe sources describe the exact calls.

Throughout the observed failure, helper health reported `running`, bridge
`connected=true`, and `observation=fresh`; six Jobs were active. A later health
read reported the state service ready and the reader in `read-snapshot`.
The tunnel observation had both endpoints at 200 and a fresh external poll.
Thus the observations distinguish a list-read deadline failure from a confirmed
helper/runtime/tunnel exit. They do not prove which layer consumed its budget.
No execution restart or retry is justified by this read failure.

## Real population and bounded profiling

A read-only SQLite backup contained 1,425 Job rows, 807 Agents, 831 Sessions and
14,164 Job events; 1,395 Job rows were archived. The snapshot Dashboard retained
716 executions under the current history policy. Database rows and visible
retention counts describe different populations. [Aggregate population](population.json).
The private snapshot and exact target identifiers were not committed or uploaded.

Using the installed reader implementation, a fresh query-only child read the
snapshot in 341.044 ms for its first summary and 155.154 ms for its following
history page. Each measured 112 SQL statements, including 110 SELECTs; first-read
registry Job hydration was 228.789 ms and projection 84.634 ms. A separate fresh
query-only child against the live database measured 325.952 / 144.930 ms, with
the same statement counts. The latter observed one naturally added execution;
it is not a frozen replay of the earlier snapshot. An installed-environment
control and a synthetic cached-inventory control also completed their projections.
These controls do not reproduce the long-lived operational service's full cache,
queue, concurrent workload or uptime. They cannot establish a controlled
before/after improvement or the cause of its much slower native list responses.
[Snapshot phases](read-profile-snapshot.json), [live query-only phases](read-profile-live-query-only.json),
[environment control](read-profile-installed-environment.json),
[inventory control](read-profile-inventory-control.json).

Two-second process samples observed SQLite execution/reads in the installed
reader. Those stacks do not identify the responsible SQL or allocate end-to-end
delay between queueing, state-owner IPC, SQLite and projection. Existing cumulative
state transaction telemetry had a 5,147 ms maximum, but is not joined to the
failed requests and is not their cause. Actual SQL lock-wait time, physical I/O
and installed per-method/timer/topic rates remain unmeasured. Green synthetic
counts do not fill that gap.

## Existing functional checks on current dev

- Focused Node suite: **59 passed, 0 failed, 0 skipped**, nine files, including
  the actual pinned tunnel-client 0.0.14 local Go proxy matrix. These are isolated
  fixtures, with private HOME/CODEX_HOME and no operational profile.
- Strict native checks: **40 passed, 0 failed**, in two disjoint selections
  (32 socket/completion/connection tests and eight observation-preservation
  tests). Strict concurrency and warnings as errors were enabled. These prove
  fixture behavior, including helper RPC failure after grace, late-response
  fencing, retained Settings/Skills/detail, and notification scheduling.
- Completion counts: 400 progress events produced 400 Dashboard notices and
  zero readiness-triggered claims/SQL/changed rows. Twenty empty claims and
  twenty availability checks each performed 40 SELECTs, zero writer transactions
  and zero changed rows. Twenty-five completions drained in 10/10/5 batches;
  immediate release/reclaim attempts remained bounded by the durable retry time.
  WAL file-length deltas are not WAL-frame writes, fsync counts or disk I/O.

[Node summary](focused-test-summary.json), [native summary](native-test-summary.json),
[completion counts](completion-counts.json). Tests kept their existing timeouts,
capacity and expectations. No source fix, deadline increase, history deletion,
polling removal or durable-record removal was made. A full release-distribution
validation was not needed or claimed for this audit-only change.

The audit-only `validate:affected -- --base origin/dev` gate passed, including
localization/release metadata and exact App Server schema comparison with the
repository-pinned CLI 0.153.3. The pin was installed only in the private validation
directory; the operational CLI was not replaced. The initial ambient-version
mismatch and one private-pin verification failure are retained alongside the
successful retry in the [validation receipt](validation.json).

## Remaining boundary and 502 transfer

Native UI selection of the installed accessory app timed out twice; Finder AX
access worked. No installed popover screenshot/click result was obtained. Actual
window retention/recovery, notification permission/delivery, installed event-loss
and hosted-failure/hang recovery therefore remain unverified. Fixture results
are not a substitute. Production runtime or helper faults were not injected
while six Jobs were active.

The original #242 report's five 502s remain historical evidence. Current helper
logs, tunnel metrics and telemetry do not supply the missing request/termination
join. The private UUID/phase implementation in `httpDiagnostics.ts` is enabled
through a fixture option; normal CLI startup does not export operational phase
records. No new correlated production 502 was collected. #262 now owns the
remaining operational correlation, cause-specific regressions, evidence limits
and closure criteria. Similar isolated reset classification is not a production
root-cause finding.

For #242, criterion 1 currently **fails** installed list acceptance; criteria
5/7/11/12/13/17 retain their installed-flow/rate/I/O limitations from the earlier
audit. Criterion 15's unresolved investigation is linked to #262, without claiming
the 502 itself fixed. Existing successful implementation/fixture evidence is
preserved. Next work should locate the long-lived installed list-read delay,
verify a same-condition repair with unchanged deadlines, and complete native
recovery/notification observations before reconsidering closure.

Raw process samples, the private data snapshot, full test output and exact probe
target remain in the task-owned private local evidence directory. The
[private receipt](private-evidence-receipt.json) binds filenames, bytes and hashes
without publishing private paths or contents. Public artifacts contain aggregate
measurements and generated test/probe code only.
