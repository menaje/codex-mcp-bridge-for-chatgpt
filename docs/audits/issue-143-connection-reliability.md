# Issue 143 connection reliability evidence

The T1 investigation ran on 2026-09-21 against checkout
`bd41b788dc38ebb1b9e234bd278bcac7303f62be`. It did not modify, migrate,
checkpoint, compact, stop, or restart the operating database or runtime. The
controlled fault used a disposable schema-24 database.

## Outcome

The failure is an observed Bridge event-loop availability problem, not merely a
native-app status-label problem. The installed Bridge process remained alive
while both private `runtime.health` and public `/healthz` failed to respond
within the same two-second interval. The same PID later recovered without a
restart.

The evidence does not identify one exact SQL statement as the cause of every
stall. A main-thread sample immediately following a timeout contained synchronous
`better-sqlite3` reads/prepares and substantial minor garbage collection, but did
not capture a SQLite busy-wait stack. The controlled lock test proves that a
synchronous SQLite wait can create the reported symptom; it does not retroactively
prove that a database lock caused every operating incident.

## Installed-runtime evidence

The installed runtime reported version 0.4.1 and build
`f7f5056f9cf3:8d672a3d96bd`. Three Jobs were active during the initial read-only
baseline and the Tunnel reported connected. The ordinary baseline was healthy:
helper status took 3.218 ms, `runtime.health` took 0.651 ms, and `/healthz` took
5.823 ms.

The helper's bounded 200-entry in-memory log covered
2026-09-21T04:02:42.628Z through 2026-09-21T06:25:12.574Z. Within that retained
window it contained:

- 88 Bridge status timeouts and 88 recoveries;
- a longest recorded unavailable interval of 349,642 ms;
- 16 Tunnel `tools/call` failures with HTTP 502 and `connection_reset`;
- three Tunnel health failures.

These are counts from the retained tail, not complete incident totals. No raw
prompt, result, project path, token, or Tunnel identifier is stored in the audit.

A paired live probe then observed `runtime.health` time out after 2,002.2 ms and
`/healthz` time out after 2,002.1 ms. The Bridge PID was unchanged before and
after recovery. This rules out companion-socket saturation as a sufficient
explanation because the independent HTTP listener on the same event loop was
unresponsive at the same time.

A two-second process sample immediately after a timeout collected 1,410 main
thread samples. It attributed 348 samples to a timer callback, 225 to minor
garbage collection, and observed synchronous `better-sqlite3` statement work in
that timer path, including two `sqlite3_step` branches with 93 and 79 samples and
40 statement-prepare samples. The sample reported a 587.3 MiB physical footprint
and a 1.0 GiB peak. This establishes material synchronous storage and allocation
work on the response event loop, while leaving the exact initiating call open.

## Controlled fault

[`issue-143-connection-reliability-regression.ts`](../../scripts/issue-143-connection-reliability-regression.ts)
starts the production HTTP and companion servers around a disposable state
store. A second SQLite connection holds `BEGIN IMMEDIATE` for 3.2 seconds while
the Bridge process performs a synchronous state write.

This is a failure-characterization test. A green run means the known coupled
stall was reproduced and measured; it is not a resolution or release gate.

| Observation | Baseline | During contention | After release |
| --- | ---: | ---: | ---: |
| `/healthz` | 4.291 ms | 3,252.486 ms | 6.083 ms |
| `runtime.health` | 1.638 ms | timed out at 2,001.425 ms | 1.206 ms |
| event-loop timer delay | — | 3,248.814 ms | — |
| state write | — | 3,247.940 ms | completed |

The response paths recovered without restarting the fixture process. This
reproduces the helper's false-disconnection condition even though
`runtime.health` itself performs no database access: it cannot run while another
synchronous database call occupies the same event loop.

## Latency attribution and isolation comparison

The initial characterization was extended on 2026-09-21 with four lock durations and
the same supported `events` maintenance write through the protocol-v4 isolated
state prototype. Each row is one controlled sample, not a percentile claim.
The state operation remains subject to the injected lock in both designs; the
comparison asks whether that wait also occupies the Bridge response event loop.

| Lock | Current state op | Current `/healthz` | Current timer | Isolated state op | Isolated `/healthz` | Isolated timer |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 ms | 80.108 ms | 80.578 ms | 80.180 ms | 87.667 ms | 1.880 ms | 11.377 ms |
| 250 ms | 285.279 ms | 290.224 ms | 288.359 ms | 280.043 ms | 1.242 ms | 11.962 ms |
| 1,000 ms | 1,038.728 ms | 1,041.773 ms | 1,039.240 ms | 1,019.101 ms | 1.078 ms | 12.632 ms |
| 3,200 ms | 3,271.465 ms | 3,274.144 ms | 3,271.821 ms | 3,279.925 ms | 1.961 ms | 11.800 ms |

At 3.2 seconds, current `runtime.health` timed out at 2,002.743 ms. The
isolated comparison returned it in 2.036 ms while the state service correctly
reported `state-stale`, a 2,255 ms heartbeat age, and one in-flight operation.
This separates a bounded state-availability degradation from Bridge liveness.
The state command is still delayed and must keep its deadline, capacity and
outcome-unknown contract; isolation does not make SQLite or storage latency
disappear.

A follow-up run added a privacy-safe last-confirmed operation observation. With
the same 3.2 second lock, the isolated state service reported
`state-stale + write/maintain/events/write-lock-wait`, zero queued requests and
one in-flight request while `/healthz` and `runtime.health` returned in about
1.1 ms. The parent retained that phase after the child heartbeat stopped and
cleared it after the command response, while preserving the last commit time.
No request, scope, project, Job identifier or payload is included. This narrows
the blocked boundary to entry into `BEGIN IMMEDIATE`; it does not claim that a
timer can inspect SQLite internals or distinguish lock-manager, filesystem and
native-driver time while that synchronous call is blocked.

## SQLite busy boundary

The next characterization added one case immediately below the configured
`busy_timeout=5000` and one above it. The state-service response deadline was
set to eight seconds for these measurements so the test could observe SQLite's
own outcome rather than first collapsing it into the caller's outcome-unknown
deadline.

| Lock | Path | State outcome | State duration | `/healthz` | `runtime.health` | Bridge timer |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 4,900 ms | current | committed | 4,953.479 ms | 4,958.959 ms | timeout | 4,953.829 ms |
| 4,900 ms | isolated | committed | 4,988.038 ms | 9.287 ms | 3.193 ms | 10.704 ms |
| 6,500 ms | current | `STATE_STORAGE_BUSY` | 5,338.043 ms | 6,580.589 ms | timeout | 5,338.417 ms |
| 6,500 ms | isolated | `STATE_STORAGE_BUSY` | 5,383.775 ms | 2.669 ms | 1.430 ms | 11.789 ms |

The 4.9 second write therefore remained a valid slow commit. The 6.5 second
case was not called failed because an elapsed-time threshold was crossed; the
state child mapped an actual `SQLITE_BUSY` or `SQLITE_LOCKED` driver result to
the bounded `STATE_STORAGE_BUSY` contract. In both isolated cases the
last-confirmed phase was `write-lock-wait` and Bridge liveness remained
responsive. `busy_timeout` is a local lock-wait policy, not a Bridge connection
deadline, performance target, or SLA. Callers whose observation deadline ends
first still receive outcome-unknown and must use the existing command identity
and authoritative recovery path rather than infer storage failure.

A separate synthetic 350 ms main-thread CPU fault delayed `/healthz` by
350.927 ms, `runtime.health` by 350.706 ms, and the event-loop timer by
350.237 ms. State-process isolation therefore addresses the SQLite propagation
path but cannot protect the Bridge from synchronous serialization, allocation,
garbage collection, or other CPU work that remains on its event loop.

The resulting policy is:

- optimize normal SQL, payload, serialization, allocation and queue cost;
- isolate SQLite/storage stalls, Dashboard reads and diagnostic persistence;
- permit state unavailability, stale presentation and deferred maintenance only
  through bounded deadlines, explicit reason codes and preserved command IDs;
- tolerate Tunnel/network/Codex latency through separate clocks, reconnect and
  authoritative resynchronization;
- never permit a state fault to freeze liveness or turn uncertainty into a Job
  success, failure or cancellation.

At this measurement stage, this verified the isolation boundary only in a
disposable prototype. The protocol-v4 child supported all maintenance slices,
including bounded registry-planned `jobs` retention, and reported `ready` for
that surface. Production startup still used the in-process owner at that point;
the later production cutover result is recorded below.

## Timeout-domain audit and native mitigation

The visible surfaces do not share one fixed deadline. The native helper gives
the memory-only `runtime.health` observation two seconds, while the Swift client
allows the helper call five seconds. Dashboard and decision cards allow five
seconds for MCP initialization and 15 seconds for a tool dispatch. Codex App
Server bounded control requests default to 30 seconds; once a turn is accepted,
turn completion is notification-driven rather than limited by that control
deadline. Late App Server control responses are correlated separately instead
of blindly replaying a new request. Increasing the helper's two-second value
would therefore hide only one symptom and would not unblock cards or App Server
traffic when the shared Bridge event loop is occupied.

The native status contract now distinguishes `fresh`, `timed-out`, and `failed`
observations and carries `lastSuccessfulAt` only within the same managed PID
generation. A timeout keeps `connected=false`; it never becomes fresh admission,
shutdown, or mutation authority. The app gives the first miss the existing
eight-second checking window, then shows response-unconfirmed attention. If a
same-PID successful observation exists, the last Dashboard and Settings content
remains visible as stale while controls that require a fresh Bridge connection
remain unavailable. A timeout does not recommend a runtime restart. An immediate
probe failure and a confirmed process exit continue through the unavailable
path, and recovery requires a new successful observation.

This mitigation prevents a fixed observation deadline from being mislabeled as
a confirmed disconnect. By itself it did not resolve the underlying coupled
stall; the later production isolation result below supplies that boundary,
while the installed Tunnel/Card combination remains a separate deployment
gate.

## T1 decision

Direct observations and remaining uncertainty are now separated:

- Confirmed: one Bridge event loop currently serves HTTP, companion health,
  synchronous SQLite, maintenance timers, serialization, and allocation work.
- Confirmed: that event loop repeatedly misses the native two-second deadline in
  the installed multi-Job runtime and the misses coincide with real Tunnel 502
  connection resets in the retained window.
- Confirmed: an isolated SQLite wait is sufficient to reproduce the coupled
  health failure and no-restart recovery.
- Confirmed: moving the same locked operation behind the child-process boundary
  keeps Bridge health responsive while the state service becomes explicitly
  stale; the operation completion time itself is not shortened.
- Confirmed: the parent can retain the last state-owner write phase, queue depth
  and prior commit time across a stale heartbeat, distinguishing observed DB
  work from an unexplained connection timeout without exposing domain data.
- Confirmed: bounded main-thread CPU occupancy remains a separate coupled
  latency source after state execution is isolated.
- Unconfirmed: the exact SQL, lock owner, allocation source, or maintenance
  slice responsible for each operating stall.
- Unconfirmed at T1: production cutover behavior across every state caller,
  queue and read path, and the installed Tunnel/ChatGPT/Codex combination.

T1 therefore supports proceeding to #142 with execution isolation as the first
architectural boundary. File separation remains a later data-ownership and fault
containment step, not the first implementation step.

## Production cutover and bounded progress fairness

The production entry point now keeps public HTTP, native companion, and stdio
ingress in a SQLite-free supervisor. The complete Bridge application/runtime
and the sole operational writer run in a supervised child; query-only card
reads and non-authoritative telemetry use independent children and bounded
capacities. A 30.667-second stopped-runtime/write-lock fixture kept all 121
`/healthz` samples at HTTP 200 (p50 1.580 ms, p95 2.248 ms, p99 2.872 ms,
maximum 3.990 ms). Native `runtime.health` remained available at the 2.25,
10, and 30 second checkpoints while readiness truthfully reported
`state-stale + write-lock-wait`. The original mutation returned
`RUNTIME_RESPONSE_UNCONFIRMED`; after resume, Settings loaded in 23.838 ms,
Dashboard in 101.458 ms, and the authoritative Settings revision advanced
exactly once.

The operational owner also bounds disposable progress persistence separately
from authoritative state. Only non-terminal `updated` progress enters a
project-keyed round-robin queue with 256 total entries, 32 entries per project,
and four immediate writes per event-loop turn. Semantic milestones, errors,
usage, approvals/input, interaction resolution, resumed execution, terminal
state, cancellation, and delivery evidence do not use the disposable lane.
Queue health exposes counts only; it never exposes project or Job identity.

The saturation regression submitted 100 progress updates for project A in one
turn. Four used the immediate budget, the queue retained 32, and 64 older
disposable updates were dropped. Project B was still admitted and its update
ran on the second fair drain turn rather than after project A emptied. With
project A saturated again and the immediate budget exhausted, project B's
input-required event persisted immediately. This proves bounded admission and
cross-project scheduling for the reported progress-flood case. It does not
claim simultaneous writes during a SQLite lock: the central writer may still
make every operational mutation wait, but that wait is reported as degraded or
unconfirmed state and no longer consumes public connection liveness.

Current-checkout verification after this change: 96 TypeScript test files / 844
tests, build and release checks, the long production fault regression, and the
real companion socket plus production Swift-client contract all pass against
disposable databases. Applying the candidate to the installed helper, Tunnel,
and ChatGPT host remains an explicit deployment step rather than evidence
created by these local fixtures.
