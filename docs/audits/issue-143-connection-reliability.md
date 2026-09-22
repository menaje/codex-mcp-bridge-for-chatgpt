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

Current-checkout verification after this change: 96 TypeScript test files / 848
tests, build and release checks, the long production fault regression, and the
real companion socket plus production Swift-client contract all pass against
disposable databases. Applying the candidate to the installed helper, Tunnel,
and ChatGPT host remains an explicit deployment step rather than evidence
created by these local fixtures.

## Completion re-audit and corrective boundary (2026-09-22)

Issue #143 was reopened after comparing its closure claim with the checked-in
implementation and its own unchecked acceptance list. The installed build was
healthy, but the repository did not contain the full separate operational-state
owner described by the original target diagram. The production boundary moves
the whole application and its single writer into a supervised child; it does not
move every mutation through the maintenance-only state-service prototype.

The correction records two different outcomes instead of treating them as one:

- #143 owns public/native connection liveness, bounded request admission,
  truthful stale or storage-degraded state, stale presentation preservation and
  authoritative recovery after the application child resumes.
- #142 owns the later semantic conversion that would keep critical commands and
  unrelated application work runnable while the operational writer itself is
  blocked. The current central writer serializes writes, and issue #143 does not
  claim otherwise.

The corrective implementation adds a structured degradation response to proxied
MCP traffic. A stale write reports `state-write-unconfirmed` and `outcome=unknown`;
capacity or pre-admission degradation reports `outcome=not-observed`. The response
also carries `retry-after`, the privacy-safe last operation phase and no domain
identifiers. An actual SQLite `FULL` fault now disables new-Job admission and is
reported as `state-storage-full` until a later state transaction commits. The
same fail-closed mapping covers SQLite busy, I/O, corruption and read-only driver
results; classification comes from the driver code, never elapsed time.

The acceptance evidence is now interpreted as follows:

| Fault or contract | Evidence | #143 result |
| --- | --- | --- |
| 30.5 s application/state stall | 121 public health samples, native health checkpoints, exact-once settings recovery | pass |
| SQLite lock below and beyond `busy_timeout` | committed slow write versus explicit `STATE_STORAGE_BUSY` | pass |
| SQLite capacity exhaustion | real `SQLITE_FULL` on the runtime writer, fail-closed admission and explicit readiness limitation | pass |
| proxy saturation and large payload allocation | 112 incomplete requests with native reserve; four bounded 6 MiB JSON bodies with concurrent health probes | pass |
| progress flood and project fairness | 100 project-A updates, bounded/coalesced disposable queue, project-B fair turn and critical-input bypass | pass within the pre-SQLite queue; no in-flight write preemption claim |
| read projection stall | bounded read capacity, stale result and independent state write | pass |
| telemetry lock, flood, capacity and crash | bounded drop/failure accounting and independent operational write | pass |
| response loss and owner restart | durable command receipt replay, hash conflict rejection and single live writer generation | pass for implemented receipt surface |
| migration interruption and rollback | checkpoint reconciliation, verified pre-open restore and post-service-open rollback refusal | pass |
| installed app, Tunnel and ChatGPT card | exact installed build, injected runtime stop, native live view and installed card-resource regression | pass; see installed completion acceptance below |

Passing the disposable fault suite does not prove Tunnel, ChatGPT-host or Codex
network latency can be shortened. Those clocks remain external tolerance
domains. The closure record below identifies the exact installed build, runs an
installed fault without altering the operating database, confirms native and
card stale behavior, and fixes the #143/#142 scope boundary.

## Installed completion acceptance (2026-09-22)

The signed arm64 application installed at `/Applications/Codex MCP Bridge for
ChatGPT.app` contains commit `b53fcccf9580b85bc298b011bd3a1573b6c1c7d9`,
build ID `b53fcccf9580:12f58b20657a`, and a clean source hash. Before replacement,
the authoritative runtime snapshot reported zero active Jobs, admissions,
interactions, memory-only threads and background processes. The prior app was
stopped through the ordinary non-force lifecycle handoff, whose receipt was
`completed`. Its signed `b3d2b4f91bea:4be694bea2a1` bundle, helper definition
and a consistent SQLite backup are retained at
`~/.codex-mcp-bridge/backups/issue-143-pre-b53fccc-20260922T0847KST`;
the backup reports `quick_check=ok` and zero foreign-key violations.

Opening only the replacement app restored the helper, Bridge supervisor,
application runtime, read child, telemetry child and Tunnel. The installed
runtime then passed a non-database fault: its application child was sent
`SIGSTOP` for 6.020 seconds while the SQLite files were left untouched. All 58
public `/healthz` samples returned HTTP 200 (p50 2.156 ms, p95 3.629 ms, p99
19.167 ms, maximum 19.167 ms). At 2.511 seconds `/readyz` returned 503 with
`state-stale` and `state-response-unconfirmed`, while helper status still
reported the Bridge and Tunnel connected and disabled new-Job admission. After
`SIGCONT`, readiness and state-service status returned to ready in 8.301 ms.

A separately signed live-acceptance window used the production Swift views
against that installed helper. During the stop it changed from healthy to
attention/response-unconfirmed, while the last confirmed Running, Response
needed and Issues values and their confirmation time remained visible. It
returned to healthy after recovery. This directly verifies that native UI does
not translate the state stall into a disconnected process or erase the last
confirmed Dashboard.

The browser regression was also run by dynamically importing Dashboard,
Settings and Decision resources from the exact installed runtime directory,
not the checkout. Each retained its last confirmed DOM after a dispatched read
timeout and none issued a second compatibility tool call. The three installed
card modules are byte-identical to the `b3d2b4f` resources previously rendered
through the real ChatGPT web host, so this run adds installed fault semantics
without claiming a new independent human-host sample. No prompt, mutation or
operational card action was submitted for this acceptance.

After the fault, the live state database still reported `integrity_check=ok`
and zero foreign-key violations, the private environment file digest was
unchanged, the Tunnel doctor and connection were healthy, and admission,
state-read and telemetry status were ready. Final repository validation passed
96 TypeScript files / 848 tests, App Server schema compatibility, 205 macOS
tests with two opt-in skips, and 1,319 localized strings across nine languages.

This closes #143 only for connection liveness, truthful bounded degradation,
last-confirmed presentation and recovery. It does not claim that an in-flight
SQLite call can be preempted or that independent semantic writes continue while
the central writer is blocked. Moving every command/query behind the dedicated
operational-state owner remains #142.

## Request-outcome correctness follow-up (2026-09-22)

A post-closure audit found that the first structured MCP 503 implementation
derived `outcome` from the runtime's global last-confirmed state operation. That
mixed two independent facts: why the runtime was degraded, and whether the
current HTTP request crossed the supervisor-to-runtime boundary. In particular,
a new request rejected before proxying inherited `outcome=unknown` when an
unrelated write was already blocked, while a fully forwarded request could have
received `outcome=not-observed` when no state write happened to be visible.

The corrected proxy now tracks the current request independently:

- freshness, request-count and byte-capacity rejection before forwarding returns
  `outcome=not-observed`, regardless of an unrelated active operation;
- once the complete request has been flushed across the child HTTP boundary,
  loss of the response or heartbeat returns `outcome=unknown`;
- a child-proxy error can no longer return a contradictory 503 with
  `reason=ready`; it reports response-unconfirmed recovery state instead;
- `limitations` continues to describe the last-confirmed global runtime or
  storage condition, while `outcome` describes only the current request.

The runtime also observes original application errors at the HTTP tool, native
RPC and stdio tool boundaries. Actual SQLite driver codes remain the only input
to storage classification. `BUSY`, `FULL`, `IOERR`, `CORRUPT`/`NOTADB` and
`READONLY` close new-Job admission; an unrelated protocol or domain error does
not. The fault remains visible until a later state transaction commits, rather
than clearing merely because time elapsed or a read succeeded.

The focused regression verifies both sides of the request boundary: a new MCP
request rejected while another write is stale is `not-observed`, and a fully
forwarded delayed MCP request whose runtime child is stopped before its response
is `unknown` with `state-response-unconfirmed`. Deterministic MCP-boundary
injections for `SQLITE_IOERR_FSYNC`, `SQLITE_CORRUPT_VTAB` and
`SQLITE_READONLY_DBMOVED` each disable admission and recover only after a
confirmed Settings commit. The existing real `SQLITE_BUSY` and `SQLITE_FULL`
faults remain covered.

Post-correction repository validation passed 96 TypeScript files / 853 tests,
205 macOS tests with two opt-in skips, MCP 2026-07-28 conformance 29/29, App
Server compatibility against CLI 0.153.3, and 1,319 localized strings across
nine languages.

### Installed correction acceptance

The signed arm64 application installed at `/Applications/Codex MCP Bridge for
ChatGPT.app` now contains clean commit
`b34b9a7eec4e6cc240c196a9163630ad0fb1f63b`, source hash
`b441b19c2c650dbfbcdeaf5e1d9622487c78b89e3b47747a67e8e8932bce3329` and
build ID `b34b9a7eec4e:b441b19c2c65`. Before replacement, a fresh authoritative
snapshot confirmed zero active Jobs, pending admissions, interactions,
memory-only threads and background processes. The previous signed app,
LaunchAgent definition and online-consistent state and telemetry backups are
retained at
`~/.codex-mcp-bridge/backups/issue-143-outcome-pre-b34b9a7-20260922T0941KST`;
both backup databases passed `quick_check` with zero foreign-key violations.
The non-force application shutdown receipt
`D0279078-C03C-4FF5-AB7A-686FAB1E9247` completed before replacement.

The replacement restored the helper, Bridge, Tunnel, application runtime,
state-read child and telemetry child. A non-database installed fault then held
the application runtime child with `SIGSTOP` for 6.012 seconds. All 75 public
`/healthz` samples returned HTTP 200 (p50 2.132 ms, p95 4.619 ms, p99 19.841
ms and maximum 35.962 ms). During the stop, `/readyz` returned HTTP 503 with
`state-stale` and `state-response-unconfirmed`. A new MCP request submitted only
after that stale boundary returned HTTP 503 with `outcome=not-observed`; it was
not confused with an unrelated global operation. After `SIGCONT`, readiness
returned to HTTP 200 in 2.711 ms.

The complementary fully-forwarded case remains deterministic rather than
manufacturing a slow or mutating production request: the integration fixture
flushes a delayed MCP request to the runtime, stops the child before its
response, and verifies `outcome=unknown`. That fixture is compiled from the
same clean source revision installed above; its delay and SQLite-error controls
are unavailable during normal production startup.

After the installed fault, both live databases passed `integrity_check` with
zero foreign-key violations, the private environment digest remained
unchanged, and `/healthz`, `/readyz`, Bridge, Tunnel, state-read and telemetry
all returned healthy/ready. This installed result closes the request-outcome
correctness follow-up without claiming control over Tunnel or ChatGPT network
latency and without expanding #143 into #142's full state-owner migration.

## Admission enforcement and request-failure context follow-up (2026-09-22)

A further audit against `dev` commit
`de33505240bb67867b421e0e8f86649c781b2af3` found two remaining gaps inside
#143's stated boundary. First, a classified storage fault changed runtime
health to `acceptingNewJobs=false`, but the `codex_task` admission gate still
read only the ordinary drain flag. Second, a request whose own body would push
aggregate proxy bytes over the limit could receive HTTP 503 while a fresh
global readiness snapshot still said `reason=ready`. The same contradiction
was possible for a child HTTP connection failure with a fresh heartbeat.

The corrective implementation keeps request facts and runtime facts separate:

- the shared Job admission state now retains a classified storage fault and
  rejects a new `codex_task` with retryable `STATE_STORAGE_UNAVAILABLE` before
  Job creation or execution dispatch;
- MCP task errors converted into structured tool results are observed at that
  boundary, so SQLite failures from non-transaction task reads are not hidden
  from the runtime supervisor;
- automatic recovery work uses the same effective admission gate;
- only a later confirmed state transaction clears the storage gate;
- HTTP 503 top-level `reason` and `limitations` describe the current request,
  while `runtimeReadiness` preserves the independent global snapshot;
- aggregate-byte rejection reports `state-capacity`, and a child connection
  failure reports `state-recovering + state-response-unconfirmed`, even when
  the last heartbeat still reports ready;
- `outcome` remains request-local: rejection before crossing the runtime
  boundary is `not-observed`, while response loss after the complete request
  was forwarded is `unknown`.

The storage regression now sends real `codex_task` calls. A real
`SQLITE_FULL` writer failure and deterministic task-read driver errors for
`SQLITE_BUSY`, `SQLITE_IOERR_FSYNC`, `SQLITE_CORRUPT_VTAB` and
`SQLITE_READONLY_DBMOVED` each make runtime health non-admitting. The following
task call returns `STATE_STORAGE_UNAVAILABLE`, the live `jobs` table remains at
zero rows, and the fake Codex App Server records no turn. A confirmed Settings
commit then clears the gate. The separate real lock fixture still distinguishes
a slow commit from SQLite's actual busy result; no elapsed duration is used as
the storage classifier.

Two proxy regressions cover the contradictory-503 cases. Four incomplete
requests reserve 28 MiB while global readiness remains ready; a new 6 MiB body
is rejected as request-local `state-capacity`, `outcome=not-observed`, with the
nested global snapshot still ready. A deliberately closed child HTTP listener
likewise returns request-local recovery/response-unconfirmed rather than
`reason=ready` while preserving the fresh global snapshot.

Current-checkout validation passed 96 TypeScript files / 856 tests, MCP
2026-07-28 conformance 29/29, App Server compatibility against CLI 0.153.3,
205 macOS tests with two opt-in skips, the 30-second production-isolation
fixture, the real companion-socket Swift contract and all three stale-card
regressions. These results use disposable fault databases. Installed-build
acceptance for this exact correction is recorded after the signed candidate is
deployed and rechecked; earlier installed builds are not evidence for this
follow-up.
