# Issue #242 R502: isolated HTTP termination investigation

Base: `f710974b33fc40432653c815d175058cba1adaee` (exact approved W1/W2
baseline). Task branch: `codex/issue-242-r502`. Integration target is eventually
`dev`; integration and worktree cleanup are deliberately pending because the
user requested no dev merge. The new manually created task worktree is
`/Volumes/Data/Dev/codex-mcp-bridge-issue-242-r502`. No reset, rebase, force push,
GitHub Actions, production restart, production operational DB access, user-data mutation,
release build installation, or conversation action was performed.

## Finding and causal boundary

**Production cause remains unresolved.** Prior installed-build evidence is the
reported tools/call 502 with transport_closed/connection_reset or closed_pipe
and upstream_response_received=false. That report is not an R502 production
trace, and the new collector was not enabled on the installed application.

A bounded deterministic fixture proves a lifecycle defect in the baseline:
after a complete upstream response's `end`, the proxy still accepts a late
request error as a reason to destroy its outgoing response. If final downstream
framing is pending, that changes an otherwise complete response into HTTP 200
with an incomplete body. `lifecycle-race-red.txt` records the failing baseline
assertion. The control with immediate downstream framing completed normally;
the failure required the ordered race.

The reproduction uses the real Node HTTP proxy and real loopback sockets, with
two explicit scheduling injections: a late request `error` event after upstream
`end`, and a 20ms hold on downstream `ServerResponse.end`. The latter represents
pending final framing; it is not a measurement of a kernel send-buffer stall.
This proves that the lifecycle handler can truncate a response under that
ordering. It does **not** prove that Node, the installed tunnel, or production
traffic produced that ordering. The additional late response-error and timeout
fixtures exercise the same guard; their production occurrence is also unproven.

The minimal lifecycle fix makes upstream request/response error, idle timeout,
and incoming abort handlers inert after the allocation has settled. Error and
close observers remain available, but cannot destroy a successful pending
outgoing response or release capacity again. A late response callback cannot
start forwarding after settlement. Response error listeners are installed before
discarding a response belonging to a detached caller.

Pre-header upstream failure still attempts the existing structured unavailable
response, including its captured MCP ID. A partial response after headers still
terminates the connection; it does not acquire a fabricated complete MCP error.
The 120-second production observation/idle budgets, capacity/reserves, admission,
Job/turn identity, cancellation, durable receipt, and replay policy are unchanged.
No transport retry was added.

## Bounded correlation and phase evidence

The existing private programmatic `proxyDiagnostics` hook now joins supervisor
ingress and the actual state-owner HTTP child. It stays disabled by default.
An explicitly supplied observer enables the child's private diagnostics flag;
normal startup has no new environment toggle or public diagnostics endpoint.
No diagnostic file is written by product code. Fixtures write only sanitized
aggregates into this task's audit directory.

Each accepted diagnostic request gets a bridge-generated 36-character UUID.
The supervisor strips any public `x-bridge-private-http-trace`, sends its own
value only to the loopback child, and strips that header from upstream responses.
The child consumes it before host/auth validation or the SDK adapter sees the
headers. It never becomes execution identity, MCP request ID, authorization,
cancellation, deduplication, or replay evidence. Child observations are accepted
only for known IDs in the current child generation and reconstructed from fixed
allowlisted fields.

The collector observes at most **128 requests and 32 records per request** over
one supervisor lifetime, including merged child records: at most 4,096 emitted
records. `maximumRequests` can reduce this cap, including to zero. The cap is not
refreshed by eviction. The retained sessions are small counters/timestamps with
no incoming request, outgoing response, headers, URL, prompt, result, error text,
auth, SQL, or body references. Keeping these bounded sessions permits late child
completion after HTTP cleanup. Sink exceptions are caught; child IPC errors are
best effort. The fixtures independently check the whole-runtime cap, malformed
and forged IDs, IPC field stripping, observer exceptions, and trace-header privacy.

Phases cover public admitted, admission-rejected, body-classification queued,
proxy dispatch, complete boundary write, upstream headers, local header start,
upstream response end, local response finish, caller abort/close, upstream
close/error/idle timeout, and allocation cleanup. Child phases add HTTP admitted,
body completion, SDK application dispatch/response, actual tool callback
start/completion/error, and the first state operation's start/yield.

`atUnixMs` is captured at the event's source. `elapsedMs` uses a monotonic clock
within that source process. Child IPC delivery can occur after a later supervisor
event; array position is not cross-process event order. `firstTermination` marks
the first supervisor terminal observation, which can also be normal upstream
completion. It does not certify the globally earliest socket closer.
`response-end`/`upstreamComplete` concern the upstream HTTP message;
`response-complete`/`callerComplete` concern the local response's finish event.
Local finish does not prove caller receipt or result review.
The real-child detach fixtures show SDK response-exchange closure/cleanup before
the actual tool callback's later completion. `application-response` therefore
must not be substituted for `application-complete` when reasoning about work.

The state trace retains only the first observed operation and its first yield
or transaction response boundary. It is not per-query SQL duration, lock-wait
attribution, a count of physical writes, or complete asynchronous application
queue timing. `queued` is supervisor body classification; an HTTP child has no
separate application FIFO instrumented here. A trace after cap exhaustion is
intentionally incomplete. Absence of a phase is never proof of non-execution.

Transport failure outcomes retain their current definition: before the existing
complete supervisor request-write boundary, `not-observed`; after it, `unknown`.
The child may have acted even when the caller never observes a response.
`outcome` in successful traces is still the fallback transport-loss classification,
not a claim that a successful MCP result is unknown. HTTP detachment and timeout
do not issue execution cancellation, admit a replacement Job, or authorize safe
re-execution. Exact execution replay and duplicate prevention remain #185/#200.

## Regression matrix

Every failure fixture checks the next normal request and zero HTTP allocations.
Each serial request checks one ingress cleanup and one first terminal boundary;
cleanup accounting records active request and reserved byte counts.

| Fixture | Expected boundary / behavior | Evidence |
| --- | --- | --- |
| Upstream reset before headers | Structured complete 503, original MCP ID, outcome unknown | R502 and unchanged P0 proxy suite |
| Upstream reset after headers/partial body | Status 200, incomplete original body, no fabricated MCP response | R502 and P0 |
| No upstream response / proxy idle expiry | Structured 503 before headers; timeout is first terminal event | R502 and P0 |
| Application-owned timeout before headers | Complete application 503/MCP error forwarded; no supervisor timeout or reset | R502 application HTTP fixture |
| Real child tool exceeds fixture idle budget before headers | Structured 503/unknown; the child's callback later completes once | R502 supervised child |
| Caller disconnect during incomplete request body | Caller abort, not-observed, one allocation release | R502 |
| Caller disconnect after complete body | Caller close, unknown, detached synthetic action continues exactly once | R502 loopback application fixture |
| Real child callback after complete-body caller disconnect | Actual callback start precedes detach; callback completes once afterward | R502 supervised child |
| Upstream end then late request error with pending final framing | Original complete 200 preserved | Baseline red; R502 green |
| Upstream end then late response error with pending final framing | Original complete 200 preserved | R502 |
| Upstream end then late timeout with pending final framing | Original complete 200 preserved | R502 |
| Response completion and normal socket close | Both upstream completion and local finish recorded, one cleanup | R502 |
| Caller/internal keep-alive reuse | Reuse observed; deliberate upstream close creates a new connection; subsequent reset and recovery work | R502 |
| 300ms event-loop stall while upstream remains silent | Idle expiry delayed, structured unavailable, one cleanup, then recovery | R502 + event-loop histogram |
| Unknown-length/chunked ingress | admitted/queued/dispatch share one ID and one reservation | R502 |
| Public forged ID / upstream trace-header echo | Neither reaches the caller; bridge-generated ID replaces input | R502 |
| Ingress to actual child/state/application response | Same UUID, child/source timestamps, state first-operation span | R502 supervised child |
| Whole-runtime cap and failing observer | At most 4,096 records; observer failure does not affect transport | HTTP diagnostics unit suite and P0 |

The fixture idle limit is 200ms. Successful real-child observation and detach
tests use a 2,000ms fixture budget to accommodate child registration work; the
delayed conformance tool is 500ms. These fixture overrides do not change any
production default. The induced loop stall is a controlled cause of late timer
processing while the upstream is intentionally silent; it is not evidence that
loop delay alone causes a reset or explains installed 502s. The earlier reported
2.5/4.5-second successful delays are separate P0 evidence.

## Tunnel interpretation

The pinned installed classifier is
[tunnel_failure.go at 0f870e50a973fa820d4c409000059e181e8d242b](https://github.com/openai/tunnel-client/blob/0f870e50a973fa820d4c409000059e181e8d242b/pkg/dispatcher/internal/tunnel_failure.go).
It assigns transport_closed to reset/pipe/closed/EOF errors without an observed
target-owned error status. A target-owned 4xx/5xx is stronger evidence and uses
target_http plus upstream_response_received=true. Thus false is a classifier
outcome, not a zero-byte/header assertion. This is source-supported interpretation,
not proof of a production termination boundary.

The optional local tunnel fixture uses the same pinned binary with `dev proxy
--backend go`, temporary profile/home directories, bounded duration, in-memory
control plane, synthetic targets and no hosted/production tunnel connection.
Its separate report compares direct resets and bridge-generated structured
unavailable responses. No production tunnel logs or profile files are collected.

The executed pinned local fixture observes:

| Target / failure | Local tunnel result | Relationship to reported production classification |
| --- | --- | --- |
| Direct pre-header TCP reset | 502, transport_closed, connection_reset, false | Exact classification match; production termination location still unproven |
| Direct partial-response TCP reset | 502, client_internal, unknown, false | Same status/false; different source/kind |
| Bridge internal pre-header reset | Complete structured 503 | Does not reproduce the reported transport 502 |
| Bridge internal idle expiry | Complete structured 503 | Does not reproduce the reported transport 502 |
| Bridge partial-response reset | 502, client_internal, unknown, false | Same status/false; different source/kind |
| 2.5s / 4.5s successful direct responses | 200 / 200 | Delay alone does not reproduce a reset in this local run |

Each failed path is followed by a normal successful request. The post-header
fixture's unclassified client_internal result is recorded as observed; it is not
relabeled connection_reset just because the injected socket fault was a reset.
The late-event/framing race was not injected through the tunnel in this fixture;
its relationship to production remains a hypothesis.

## Validation and residual work

Validation commands and final counts are recorded alongside the corresponding
text logs. Final task checks, all with unchanged production budgets:

| Command / selection | Result | Artifact |
| --- | --- | --- |
| `vitest run test/httpDiagnostics.test.ts test/issue242R502.test.ts test/issue242ProxyCharacterization.test.ts --maxWorkers=1` | 23 passed in 3 files | `proxy-tests.txt`, `regression-matrix.json` |
| Pinned binary opt-in `vitest run test/issue242R502Tunnel.test.ts --maxWorkers=1` | 1 passed; 14 local requests with per-failure recovery | `tunnel-tests.txt`, `tunnel-matrix.json` |
| `tools.test.ts` / `jobRegistry.test.ts` selected response loss, exact retry, followup recovery, HTTP detach and status-wait abort cases | 6 passed; 96 deliberately unselected | `replay-detach-tests.txt` |
| `tsc -p tsconfig.json --noEmit` | exit 0 | `typecheck.txt` (empty on success), `validation.json` |
| `git diff --check` | exit 0 | `validation.json` |

The broader unchanged-budget focused run has **66 passed / 31 timed
out** across 11 files (7 files passed, 4 failed). All 26 runtimeProcess cases timed
out on startup or their existing test limits; three server cases, one lifecycle
recovery case and the current-selector replay case also timed out. The suite is
not reported as green. `focused-tests.txt` retains the failures, including a
cleanup hook timeout. No assertion failure established a different transport
semantics defect in that run.

An unmodified `git archive` of the exact baseline, in a task-owned temporary
directory with the same dependency installation, reproduces the selected
runtime and HTTP 5-second test timeouts (`baseline-control-tests.txt`). This
establishes that those two failures also occur without R502; it does not prove
the cause of all 31 timeouts or waive the remaining regression gate. Test imports
and child startup were slow under the shared host workload. No startup, test, or
production timeout was raised to turn that run green. The P0 proxy suite passed
on its sequential rerun with the same 200ms fixture and 20s startup limits.

The new tests prove HTTP allocation cleanup and one actual fixture
tool callback; they do not simulate admitting a new real Codex Job on transport
loss. Existing replay/recovery/cancellation suites provide the actual Job/turn
identity and receipt regression checks. The execution recovery, worker isolation,
operational command receipt, cancellation, stdio, runtime admission and runtime
lifecycle files passed in the broader run. The current-selector replay and full
runtimeProcess gate need another unchanged-budget run in a suitable environment
before integration.

Remaining production hypotheses include an external ingress reset, upstream
termination during a partial response, an idle expiry under actual traffic, and
the demonstrated late-event/pending-framing ordering. None has a joined installed
trace here. The known transport classification does not select among them.
Collector limits, IPC loss/delivery order, clock adjustment and local-finish vs
caller-receipt distinctions remain diagnostic limitations. The local fixture
does not verify a newly installed app or remote hosted tunnel.

Follow-up production collection requires a separately authorized bounded window
on an artifact-identifiable installed build, matching supervisor/child phases to
the existing tunnel failure's time and request. The private diagnostic UUID is
not exported to the tunnel, so concurrent external records may still be ambiguous.
Inspect the first incomplete phase and both completion boundaries; do not turn
response loss into automatic replay or claim a cause from a missing capped event.
Issue #242's production 502 investigation remains open.

Integration conflict assessment and exact task commits are recorded in
`validation.json` after tests. No task branch/worktree is removed while its
commits are outside dev; unrelated worktrees and the local dev HEAD remain intact.
