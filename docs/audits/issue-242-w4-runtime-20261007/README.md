# Issue 242 W4 runtime and tunnel observation

Task base: exact P0/W0 commit `8474165e523b47d881f688bd09caf2e4c78ac7af`.
Branch: `codex/issue-242-w4-runtime`.
Worktree: `/Volumes/Data/Dev/codex-mcp-bridge-issue-242-w4-runtime`.
Integration target: `dev`, explicitly recorded in worktree Git metadata.
Integration and cleanup remain pending: the user expressly withheld a dev merge.
The original checkout remains at `ea8f93e2acbb9f4b6deca113165d27e8c9c23857`.
No reset, rebase, push, GitHub Actions, installed-app update, operational DB,
user-data write, or conversation action is part of this work.

## Delivered behavior

The launcher directly polls its owned tunnel daemon with asynchronous concurrent
GETs to `/healthz`, `/readyz`, and `/metrics`, through a bounded keepalive Agent.
The metric is `commands_poll_last_successful_timestamp_seconds`, the same
last-success evidence used by the health command. Direct GET is still polling.
There is no health SSE, new tunnel event, or dependence on bridge change events.

The whole observation has a 2-second monotonic deadline. Each response rejects
late success even when event-loop delay prevents the abort timer from running
on time. Cancellation destroys outstanding requests. The launcher retains its
5-second monitor singleflight; the observer additionally shares the same physical
promise. Startup requires a complete positive snapshot from this observer,
not only a metric or a previous launcher's evidence.

Before and after requests, private locator/PID files are validated. The PID
must match the child the launcher actually spawned, and that PID must survive.
The supported launcher always requests `127.0.0.1:0`; direct probes accept only
that numeric loopback HTTP origin, including equivalent `/healthz` and `/readyz`
locators. Credential-bearing, remote, DNS, other-path, query, fragment, symlink,
and insecure-permission locators fail closed. Redirects are not followed.
A changed origin, mismatched PID, or exit invalidates retained readiness and
external-success evidence. Connection pools are destroyed on identity change.
This does not introduce support for arbitrary external or Unix-socket health
locators; those are outside this launcher's existing configuration.

Version 1 status remains compatible: existing fields, protocol and version stay
intact; optional `tunnel.observation` carries endpoint status/failure, historical
external success time and freshness, and current observation failure. It contains
fixed reason codes and numeric statuses, never bodies, URLs, credentials or raw
errors. Old version 1 records are accepted. The helper forwards the additive
field only for a current launcher/build/profile/freshness match.

The local observation can fail while `processRunning=true` and `connected=true`:
connected then means retained complete readiness plus recent external evidence,
not a successful current local probe. The existing `tunnel-health-probe-failed`
problem makes that case visible to old readers. A small native presentation hunk
shows attention and observes `.responseUnconfirmed` instead of counting healthy
recovery. It leaves bridge/execution availability and retained Dashboard intact.

## State decisions

All retained readiness is scoped to this launcher-owned PID and locator origin.
External timestamps accept the existing 5-second future skew and 75-second age.

| Process / identity | Current endpoints | Last external success / metric | Outcome |
| --- | --- | --- | --- |
| Alive, validated; first observation | Both 2xx | Valid and <=75s old | Establish connected; no observation failure |
| Alive, validated; first observation | Timeout/transport failure | Recent success | Remain starting/unconnected; process survives; no fabricated first snapshot |
| Alive, validated; previously complete | Both 2xx, including 700ms delays | Recent success | Connected with confirmed current observation |
| Alive, validated; previously complete | Timeout/transport failure, including 3s delays | Recent success | Retain connected, record local observation failure, attention/responseUnconfirmed |
| Alive, validated | Explicit non-2xx, including readyz 503 | Even recent success | Disconnected/degraded; clear readiness latch; subsequent unknown cannot erase this negative |
| Alive, validated | Both 2xx | Zero/invalid/future metric | Disconnected; current poll unverified; historical success stays historical |
| Alive, validated | Any | Success older than 75s or none | Disconnected/degraded; no indefinite cached success |
| Alive, validated; failed external attempts | Both local APIs healthy | Last-success timestamp freezes | Accept historical external success only until 75s, then degrade; local APIs do not prove external connectivity |
| Alive, validated | Metrics request unavailable | Previously recent success | Bounded retained connectivity and explicit metrics observation failure; expires at 75s without new success |
| Actually exited | Any, even delayed 200 responses | Any | Process false, connected false; failure process-exited; existing launcher exit/shutdown policy applies |
| Alive but PID/locator mismatch/replacement | Any | Any | Fail identity observation, discard retained evidence; do not label the owned process dead |
| Observer restart / launcher replacement | Missing first response | Old observer success | Starting/unconnected until a new complete snapshot |
| Parent loop delayed past absolute deadline | Late success | Any | Timeout observation; a late response cannot establish initial readiness |
| Writer stops refreshing file | Any | Any | Existing 20s managed-file staleness disables helper connectivity; takeover/build/PID checks remain |

The old endpoints/metric cannot identify the latest external poll failure or its
cause. A frozen timestamp after external failures is observable; a new successful
poll is separate evidence. The implementation does not invent a remote-failure
field, issue causal 502 conclusions, or infer daemon death from a missing API.

## Timing, publication and recovery contracts

No file-cadence or fsync changes: each settled monitor still publishes one
private atomic JSON snapshot, fsyncs the file before rename and attempts directory
fsync. Repeated unchanged healthy state refreshes generatedAt; a healthy state
cannot become stale merely because its semantic content is unchanged. Helper
watcher fingerprints ignore checkedAt and successful-poll timestamp movement,
but retain endpoint/failure/freshness changes. Routine heartbeats do not wake
runtime change consumers; real observation transitions do.

The unchanged 5-second cadence plus 2-second observation deadline fits the
20-second status freshness budget. A stopped/blocked writer can still become
stale; timestamps are evidence, not promises about a stopped event loop.
Operational max-observation gap remains 30 seconds, grace/recovery remains 60
seconds, and independent bridge watchdog health remains active with events up.
Incomplete tunnel observation interrupts continuous healthy recovery. No Job
cancellation, execution retry, force-restart, drain, archive or retention action
is introduced by the observer.

## Measurement method and scope

Run `node scripts/issue-242-runtime-cost.mjs baseline /path/to/tunnel-client` or
`compare`. The harness only allocates temporary fixture roots, synthetic status
files, a loopback HTTP server, and its own PID locator. The supplied binary runs
`--version` and read-only `health` against those fixtures; it does not run its
daemon or touch installed operational state. It accepts no DB, runtime home,
locator, status or user-data input path.

`before.json` records a pre-change 60-sample baseline. `after.json` reruns the
same baseline and direct implementation in one fixture, plus an actual additive
status payload. Empty Node exec, spawn-to-spawn-event, and spawn-to-exit duration
are separate from the real Go health-command total. Atomic JSON totals include
JSON encoding, permission checks, temp creation, write, file fsync, rename and
directory fsync. Fixture-only fsync interception records file and directory calls
separately (including small fstat classification overhead); production file code
has no instrumentation changes. These are API wall times, not physical disk-I/O,
WAL, transaction or syscall counts. Both fsync calls remain required.

Quantiles use nearest rank. n=60 p99 is the maximum, not a population-tail
estimate. Batches are sequential, not randomized; OS/background load is
uncontrolled. The earlier baseline and later comparison can have different
host load. No installed app latency or throughput is inferred.

Public health-command source was inspected at
[`openai/tunnel-client@12ef7f9`](https://github.com/openai/tunnel-client/blob/12ef7f9bcc18f66fa4851ced778df0753f3c7e1e/cmd/client/health_command.go),
with [endpoint semantics](https://github.com/openai/tunnel-client/blob/12ef7f9bcc18f66fa4851ced778df0753f3c7e1e/pkg/codexplugin/session/session.go).
The measured binary reports `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`;
that SHA's raw source returned 404, so the public source is not asserted to be its
exact build source. Actual fixture behavior independently confirms 500ms
endpoint expiry, 2xx readiness, and the metric report: 700ms and 3s delays make
the old health command exit 2 despite a successful external-poll metric.
The direct implementation preserves those evidence semantics while intentionally
changing endpoint scheduling/deadline to concurrent 2 seconds.

## Measured before / after

Final same-fixture run after the task's full Node run settled, milliseconds,
n=60 per condition:

| Operation | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Tunnel health CLI / direct API | 57.706 / 64.778 | 4.959 / 6.009 |
| Managed atomic JSON | 6.999 / 8.835 | 7.000 / 9.021 |
| File fsync | 2.677 / 3.484 | 1.729 / 3.490 |
| Directory fsync | 2.853 / 3.706 | 2.936 / 3.620 |

The final comparison's parent event-loop delay p99/max was
13.566/459.276ms. Background host load remains uncontrolled.
The pre-change baseline was health CLI p50/p95 69.785/149.728ms and atomic JSON
8.828/15.391ms. An intermediate run overlapped four-worker Node validation:
[after-contended.json](after-contended.json) measured CLI/direct p50
129.343/62.386ms and parent event-loop delay p99/max 35.389/1006.109ms.
Do not compare independent host-load batches as a causal estimate.
In the final same-fixture run direct polling cut health-command p50 by
approximately 91.4% and removed all 12 steady-state health subprocesses per minute.
Both implementations still request three local routes per observation.
Startup/configuration commands and bridge startup curl remain unchanged.
The empty Node exec p50/p95 was 118.510/127.951ms;
spawn-event 2.087/2.578ms and
spawn-exit 119.114/124.857ms.

Synthetic JSON payloads were 461 bytes before and 800 bytes after;
there is no claimed file/fsync optimization. Measurement writes are back-to-back,
not a production-cadence write test. Publication remains every settled 5-second
monitor tick, with the same file and directory fsync behavior.
700ms delayed endpoints completed directly in 707.260ms, connected and confirmed.
3-second delayed endpoints settled in 2006.225ms with timeout, surviving process,
recent external success, and retained connectivity. Both old CLI probes exited
2 while their external-poll metric remained positive. See [before.json](before.json)
and [after.json](after.json). The latter binds the measured runtime/script source
fingerprint to `1acbe37cf5c0e481b86feb717f604f1e020fd6aeacadd70d1148862a555669c7`.

## Integration ownership

- W3 must preserve helper `runtimeChangeFingerprint` timestamp suppression;
  failure transitions must still notify once. Do not count durable file
  heartbeats as completion readiness events. File durability and cadence remain.
- W2 owns final integration of the narrow AppModel `tunnelResponseUnconfirmed`,
  operational-observation and attention hunks, and the AppPresentation fixture
  extension. They use an existing stable problem code and avoid a native wire
  model migration. Keep the separation from bridge observation/Job execution.
- R502 must account for the new asynchronous polling workload and event-loop
  deadline behavior; no proxy/runtimeProcess transport hunks changed. GETs are
  polling, and nothing here establishes the production 502 initiator or fixes it.
- Integration must retain npm release-manifest/package file-list agreement and
  macOS bundle inclusion of `scripts/tunnel-health.mjs`; run affected gates on
  the combined W1/W2/W3/R502 head. No acceptance checkbox or installed validation
  claim is made by this W4-only work.

## Verification and limits

- `env -u CODEX_HOME npx vitest run test/tunnelHealth.test.ts test/runtimeStatus.test.ts test/managedFile.test.ts test/runtimeLock.test.ts test/runtimeLifecycleRecovery.test.ts test/runtimeLifecycle.test.ts --maxWorkers=1`: **69 passed**, [observation-tests.txt](observation-tests.txt).
- Final owned-probe suite, including known 503 headers with a stalled body: **21 passed**, [final-probe-tests.txt](final-probe-tests.txt). The prior quiet measurement is preserved in [after-quiet-preliminary.json](after-quiet-preliminary.json); final after.json follows this regression fix.
- Targeted real supervisor helper contracts: **4 passed / 51 skipped**, [helper-contract-tests.txt](helper-contract-tests.txt). These cover unchanged heartbeat suppression, installation-independent health, crash adoption and adopted-runtime drain.
- Helper profile/transport identity rejection: **2 passed / 53 skipped**, [helper-identity-tests.txt](helper-identity-tests.txt).
- Real launcher + fixture daemon unexpected exit: **1 passed / 3 skipped**, [daemon-exit-tests.txt](daemon-exit-tests.txt). A previously complete first snapshot is followed by SIGTERM of the daemon only; final launcher status is failed/processRunning=false/connected=false/process-exited.
- `npm run macos:check`: **229 tests, 2 skipped, 0 failures**, [native-tests.txt](native-tests.txt), including strict concurrency/warnings-as-errors, operational max-gap/grace/dedup and the new retained-tunnel-observation recovery test.
- Release metadata/build/type checks passed. [package-check.json](package-check.json) verifies npm dry-run inclusion and macOS bundle-copy inclusion. Package manifest now uses 29 entries of its 30-entry limit; coordinate any additional standalone script packaging.
- The initial focused run inherited the session's explicit CODEX_HOME; that overrides fixture dotenv selection by existing policy and produced auth-home assertion failures. Later Node runs remove it for the command only. No production environment precedence was changed. Logs remain in [focused-tests.txt](focused-tests.txt).
- The fast compatibility gate failed because no `codex` executable is on the test shell PATH; it could not verify the configured default executable. [fast-validation.txt](fast-validation.txt). No installation or operator setting was changed to satisfy this gate.
- The HTTP launcher integration fixtures missed their existing 10-second first-snapshot wait; the long lifecycle fixture also hit its 45-second test limit. [launcher-tests.txt](launcher-tests.txt), [launcher-debug.txt](launcher-debug.txt) and [launcher-startup-trace.json](launcher-startup-trace.json) preserve evidence. The traced failure is runtime=starting/tunnel=stopped before the tunnel observer begins. This is not attributed to W4 or host load without a same-condition baseline. Fixture cleanup now gives the launcher SIGTERM before a last-resort task-fixture kill. One orphaned fake daemon from the earlier cleanup was explicitly identified as task-owned and terminated.

The broader Node result is recorded in node-check.txt and the final validation
record. Its failures must be reviewed/rerun on a controlled combined integration
head with a configured CLI. No production timeout, capacity, freshness, history,
or durability constraint was loosened to make a failing check pass. These unit
and synthetic fixture results do not constitute installed-bundle acceptance.

Final broader `env -u CODEX_HOME npm run check` result: **95/129 files passed;
1,225/1,461 tests passed, 236 failed, 12 reported errors** (1,129.23 seconds),
[node-check.txt](node-check.txt). This gate is not clean. Failures include the
pre-tunnel HTTP first snapshot, backend execution/read/account/recovery and
fixture timeout paths. No claim is made that these are established baseline or
host-load failures: they require triage/reproduction outside W4's isolated
observation fixes. The current code should not be treated as a fully validated
integration/release head. The fast gate additionally needs a configured CLI.
Post-run task-prefixed fixture processes were inspected; the remaining temporary
state-owner/read/telemetry processes exited naturally before finalization.
