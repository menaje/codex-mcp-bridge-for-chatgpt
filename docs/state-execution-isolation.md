# State execution isolation architecture

This document is the issue #142 architecture decision produced from the issue
#143 T1 evidence. It extends the schema-25 ownership contract in
[State data access and maintenance ownership](state-data-access.md). It does not
make a second writer legal, relax any Unit-of-Work invariant, or treat a queued
IPC message as a durable state change.

## Decision

Adopt five execution boundaries and two SQLite files:

```text
Bridge ingress process
  - HTTP, MCP and local companion listeners
  - authentication and bounded IPC admission
  - no SQLite or Codex App Server connection
             |
             | bridge-operational-state-owner protocol v2
             v
Operational state-owner child process
  - application command coordinator and sole state.sqlite writer
  - schema migration, Unit of Work, admission and maintenance
  - domain idempotency journals and worker generation
  ├─ state-read child: read-only Dashboard/Settings projections
  ├─ telemetry child: sole telemetry.sqlite writer
  └─ Codex execution child: App Server pool, no Bridge SQLite authority
```

The operational state owner, read projection, telemetry owner and Codex
executor are separate processes, not several queues sharing one event loop.
The read child opens `state.sqlite` read-only and is not a second writer. The
executor receives the Codex CLI environment but no state/telemetry path,
Bridge bearer token, companion socket or SQLite module. `better-sqlite3`
remains the driver in the state, read and telemetry processes only.

A worker thread alone is insufficient for the operational writer because a
native crash, runaway allocation or process-level failure would still terminate
the Bridge. A separate local service is unnecessary for the first version:
authenticated network exposure, install management and another external
lifecycle would add failure modes without improving the single-host ownership
contract. Supervised child processes provide the selected local boundaries.

## Why execution isolation precedes file separation

Issue #143 directly observed both `runtime.health` and `/healthz` miss the same
two-second interval while the Bridge PID remained alive. The post-timeout sample
contained synchronous `better-sqlite3` work and garbage collection on the main
event loop. A disposable lock test delayed the state write, HTTP health and an
event-loop timer by about 3.25 seconds and made `runtime.health` exceed its
two-second deadline.

Moving rows to another file while both files remain on the Bridge event loop
does not address that failure. The implemented order was therefore:

1. move the complete application/state coordinator behind one versioned process
   boundary, preserving the existing atomic repositories and one writer;
2. move Dashboard and Settings projections to a read-only child;
3. move classified diagnostics to a telemetry child and independent database;
4. move the Codex App Server pool out of the state-owner event loop;
5. expose truthful readiness, certainty and recovery state to the native app
   and Dashboard.

This whole-coordinator cutover replaced the earlier plan to make every
repository method asynchronous. It creates the required state boundary without
splitting existing Unit-of-Work transactions across hundreds of RPC calls. All
external command/query entry points cross the state-owner boundary, while the
actual long-running Codex work crosses a second execution-only boundary.

## What isolation changes and what remains

The issue #143 characterization now applies 50, 250, 1,000, 3,200 and 4,900 ms
SQLite write locks plus a 6,500 ms lock beyond the configured 5,000 ms
`busy_timeout` to both the current in-process state call and the protocol-v4
child prototype. At 3,200 ms, both state operations still took about 3.28
seconds. At 4,900 ms both committed; beyond the busy timeout both returned the
driver's bounded `STATE_STORAGE_BUSY` result. Isolation does not shorten an
external lock, filesystem stall or `fsync`.

The availability effect is different. The current path delayed `/healthz` and
the Bridge event-loop timer by about 3.27 seconds and made the two-second
`runtime.health` request time out. With the state call in the child, `/healthz`
and `runtime.health` each returned in about 1.7 ms and the Bridge timer fired in
about 11 ms. The state service reported `state-stale` with the operation still
in flight. That is the intended boundary: state readiness can degrade within a
deadline and outcome-certainty contract without turning into Bridge liveness
failure.

A separate 350 ms synthetic main-thread CPU fault delayed both health paths and
the Bridge timer by about 350 ms. Work that stays on the Bridge event loop—large
serialization, allocation/garbage collection, synchronous file work or other
CPU-heavy handlers—must therefore be measured, bounded, split or moved even
after the SQLite cutover. Database isolation is necessary for the reproduced
failure mode, but it is not a blanket latency fix.

Those original measurements were deterministic single fault samples, not p99
evidence. The later production-boundary load/fault results are recorded in
[the issue #143 audit](audits/issue-143-connection-reliability.md); the final
state/execution topology and installed acceptance are recorded in
[the issue #142 audit](audits/issue-142-state-execution-isolation.md).

## Database classification

Unclassified or mixed-use data remains in `state.sqlite`. Importance is decided
by consumers and recovery semantics, not by a table or event name.
The exhaustive schema-27 table, index, trigger, consumer, recovery and file
security inventory is maintained in
[State schema ownership catalog](state-schema-ownership-catalog.md).

### `state.sqlite`

The following current schema-27 tables remain authoritative operational state:

| Domain | Tables | Reason |
| --- | --- | --- |
| schema and ownership | `bridge_meta`, `bridge_instances` | database identity, migration, instance generation, HMAC and recovery evidence |
| scope and configuration | `scopes`, `project_registry`, `projects`, `user_settings` | admission, permission and version authority |
| execution relationships | `sessions`, `activities`, `agents`, `agent_threads`, `activity_agents`, `thread_connections` | resume, ownership, assignment and lifecycle authority |
| Job state | `jobs`, `job_interactions`, `result_holds` | admission receipt, exact state, input and retained-result protection |
| mutation certainty | `agent_mutations`, `cancellation_operations`, `cancellation_intents`, `steering_deliveries` | idempotency, provenance and uncertain-effect recovery |
| completion delivery | `completion_outbox`, `job_completion_deliveries` | pending delivery, lease, receipt and acceptance certainty |
| questions | `user_questions`, `codex_question_deliveries` | user-response authority and delivery recovery |
| history and recovery | `work_history_state`, `work_history_control`, `runtime_problem_resolutions`, `automatic_recovery`, `automatic_recovery_incidents` | review, recovery budgets and restart evidence |
| mixed event/control history | `activity_events`, `job_events`, `event_budget`, `event_retention_state` | current cursors, usage/status projection and recovery consumers prevent whole-table movement |
| state IPC certainty | `operational_command_receipts` | atomically resolves commit-then-response-loss without rerunning a different logical command |

`activity_events` and `job_events` are not moved in the first telemetry schema.
Before a later move, every cursor, usage projection, summary extraction,
hydration, retention and compatibility consumer must be replaced by an
authoritative state projection. A later migration may copy purely diagnostic
event variants to telemetry, but unknown event kinds remain operational by
default.

Specific `bridge_meta` keys are likewise not moved merely because they appear
diagnostic. Schema identity, conversation HMAC material, migration provenance,
late-response certainty and service-open rollback markers stay operational.

### `telemetry.sqlite`

The first telemetry schema contains:

| Table | Content | Failure policy |
| --- | --- | --- |
| `telemetry_meta` | schema version, database identity and compatible source state-database identity | required for opening telemetry only; never affects state admission |
| `transport_observations` | the current bounded aborted/detached/presentation observations | bounded drop allowed; no cross-database foreign key |
| `runtime_measurements` | event-loop, IPC, queue, SQL-class and maintenance duration buckets | sampling and coalescing allowed |
| `diagnostic_events` | sanitized component/error transitions without prompt, result, secret or absolute project path | bounded drop allowed by severity policy |
| `telemetry_drop_counters` | dropped/coalesced count and first/last occurrence per kind | retained even when detail is dropped, subject to a small fixed cap |
| `telemetry_retention_state` | restartable cleanup cursor and last completion | telemetry-local only |
| `telemetry_record_deliveries` | idempotent delivery UUID to actual per-kind record ID | prevents an ACK loss or startup-ID collision from becoming a silent `INSERT OR IGNORE` loss; pruned with retained detail |

`transport_observations.bridge_instance_id`, scope, Activity and Job identifiers
are correlation values, not foreign keys into `state.sqlite`. Telemetry may lag,
duplicate or outlive the corresponding operational row. It can never establish
that an operation happened or authorize a replay.

## State protocol

Production uses the local-only `bridge-operational-state-owner` protocol v2.
Native application calls use a closed method union and an explicit `command`,
`query` or `control` kind. MCP traffic crosses the same bounded process boundary
as an authenticated HTTP request and is parsed and revalidated by the state
owner; no ingress caller can submit SQL, a table name or a query fragment.
Native requests have this envelope:

```ts
type StateRequestEnvelope = {
  protocol: "bridge-operational-state-owner";
  protocolVersion: 2;
  generation: string;
  requestId: string;
  kind: "command" | "query" | "control";
  method: ApplicationRpcMethod; // closed union
  args: unknown[];
};
```

The ingress process validates protocol, generation, method/kind agreement,
request count and byte capacity before sending. The state owner validates the
same envelope again. Sixteen of 128 request slots are reserved for native
control, completion delivery and recovery; MCP bodies are limited to 8 MiB and
32 MiB in flight. A queued or written IPC message is never treated as a durable
state change.

Mutation certainty remains request-specific:

- a request rejected before it crosses the boundary is `not-observed`;
- a request sent to the state owner whose response is lost is `unknown` until
  an exact read or its domain idempotency record resolves it;
- a returned domain result carries its committed version/receipt as before.

Job admission, Agent mutation, cancellation, steering, card submission and
completion delivery keep their existing durable request IDs and
prepared/dispatching/uncertain journals. A caller never invents a replacement
logical request ID after an unknown response. Queries are safe to repeat.
Settings use expected revision and an authoritative follow-up read instead of
pretending an unconfirmed mutation did not run.

SQLite execution failures are classified from the driver's error code, not
from elapsed time. `SQLITE_BUSY` and `SQLITE_LOCKED` become
`STATE_STORAGE_BUSY`; full, read-only, I/O and corrupt/not-a-database results
have separate bounded storage codes. The configured `busy_timeout` controls
how long SQLite attempts lock acquisition. It is not a liveness deadline or
SLA. If the caller's observation deadline ends first, the result remains
outcome-unknown until a late response, receipt lookup or authoritative retry
resolves it; elapsed time alone never fabricates a storage error.

Schema 25 `operational_command_receipts` remains the durable replay authority
for maintenance operations and their commit/response-loss tests. Business
commands continue to use their stricter domain receipts rather than wrapping a
multi-transaction or external-effect workflow in a misleading generic receipt.
The protocol-v4 maintenance service remains a fault/receipt conformance harness;
it is not started beside the production state owner and therefore cannot become
a second writer.

## Queue and fairness contract

Capacity is reserved before a payload is sent to child-process IPC. Transport
buffer acceptance is not state acceptance.

The final implementation uses bounded queues at the boundaries where work can
actually accumulate:

| Boundary | Capacity | Policy |
| --- | ---: | --- |
| ingress to state owner | 128 requests, 16 slots reserved from MCP, 32 MiB proxied bodies | reject before forwarding with `not-observed`; preserve native control/recovery access |
| Codex execution | 128 requests with 16 control slots reserved, 2 MiB each, 32 MiB total with 8 MiB reserved for control, 8 MiB result; 9 MiB socket frames, 16 MiB socket buffer, controller outbound queue 256 messages / 40 MiB | ordinary admission stops at 112 requests or 24 MiB, including terminal replies awaiting release ACK; bounded controls may use the reserve; backpressure or a broken control link never authorizes killing the execution owner |
| Execution journal | independent reservations: 30 execution, 8 inspection, 8 metadata, 6 control; 8 MiB result and 8 MiB event budget per record | retain authoritative replies until receipt ACK, and durable Job replies until commit ACK; ACK window 16 with 8 reply-release slots reserved and idempotent retries; elapsed time never evicts active work or unacknowledged results ([#189 audit](audits/issue-189-execution-retention.md)) |
| read projection | 16 independent requests, 8 MiB response | fail retryably and retain the last confirmed presentation |
| disposable Job progress | 256 total, 32 per project, four immediate writes | per-project round robin; drop/supersede only non-authoritative `updated` progress |
| telemetry | 4,096 records, 16 MiB, 16 KiB per sanitized record | bounded drop with persistent kind/count/first/last counters; never affect operational outcome |
| maintenance | one bounded slice at a time | defer/retry by slice; never run unbounded cleanup |

Started, completed, waiting, error, warning, usage, approval/input, resumed,
terminal, cancellation and delivery state bypass the disposable progress queue.
Commands for one aggregate retain their existing transaction/version ordering.
The central SQLite writer remains serialized by design: no queue can preempt a
synchronous write after it entered SQLite. The important guarantee is that the
Codex executor, ingress health loop, read process and telemetry process do not
share that blocked event loop.

## Read protocol and freshness

The state owner publishes a generation-bound in-memory health summary with last
commit time, active operation phase, request capacity and admission state. The
stable state database UUID binds `telemetry.sqlite` privately and is checked by
tests and recovery tooling; it is not exposed from unauthenticated health.

Dashboard/history/Settings queries run in a separate process against a
read-only WAL connection. The state owner publishes that process's generation,
heartbeat age, in-flight count, last successful snapshot time and current read
phase. If it fails, the native/card presentation retains the last successful
view with an explicit stale marker. It must not replace Jobs with an empty list
or treat stale content as current cancellation/completion authority.

An exact mutation command is always revalidated by the writer against current
scope, permission and expected-version state. A fresh read result does not
reserve that version.

## Health and readiness

`/healthz` remains a minimal unauthenticated liveness response from the Bridge
process. It waits for no database, worker, queue, Tunnel or Codex call and
contains no project or Job data.

`/readyz` is added as an unauthenticated, bounded reason-code response:

- HTTP 200 only when the state-service protocol is compatible, its heartbeat is
  no older than two seconds, migration/recovery is complete, the generation is
  current, critical capacity remains and admission is enabled;
- HTTP 503 for `state-starting`, `state-stale`, `state-recovering`,
  `state-incompatible`, `state-capacity`, `execution-starting`,
  `execution-stale`, `execution-recovering`, `execution-capacity` or
  `admission-draining`;
- telemetry and read-worker degradation are reported through private runtime
  health/presentation state but do not by themselves make mutation admission
  false;
- a disconnected/starting execution control link or actual request capacity limit
  disables new Job admission. Execution heartbeat age and auxiliary process
  observation are independent diagnostics and do not deny admission or controls.
  `execution-stale` remains a compatibility reason code, not a heartbeat kill policy.

`runtime.health` remains in-memory and adds the last state-service heartbeat,
read/telemetry availability and feature reason codes. The native helper presents
`healthy`, `degraded`, `state-unavailable`, `response-unconfirmed`, and
`process-exited` separately. One timeout first lowers freshness; only a confirmed
PID exit becomes `process-exited`. Recovery becomes healthy only after a current
generation and fresh authoritative snapshot are observed.

The state child also publishes a privacy-safe operation boundary before and
during synchronous writer work. The Bridge retains only access class, semantic
operation, maintenance slice, last confirmed phase (`write-lock-wait`,
`executing`, `committing`, or `responding`), start/observation times, queue depth and last
commit time. It never publishes a request, scope, project or Job identifier or
the command payload through unauthenticated health. A stale heartbeat freezes
this as the **last confirmed** phase; it is not permission to infer a more
specific SQLite, filesystem or hardware cause. The read child publishes the
same bounded phase/freshness form for Dashboard and Settings projections.

## Failure and restart rules

Read and telemetry children use bounded exponential restart. The Codex execution
owner has an authenticated, reconnectable private local socket (execution protocol
6). Its lifetime is independent of the state owner's IPC connection. A broken
control link reconnects to the existing owner; it neither closes worker pipes nor
creates a replacement turn. Heartbeats describe freshness and never authorize a
kill. See the [issue #185 policy and evidence](audits/issue-185-execution-lifetime.md).

An actual execution-owner exit rejects its active turns as `CODEX_WORKER_LOST`.
Before replacement, the controller cleans the retained, birth-verified worker
ledger. Auxiliary observation failure retains uncertain capacity; it does not
constitute proof of death. Each App Server spawn event establishes root ownership
without a global process-table prerequisite. One auxiliary observer in the owner
runs at most once every two seconds, with one probe in flight. There is no parallel
parent scan or command-start scan. Worker cleanup reserves only that worker slot;
other healthy workers and free slots remain available.

A state-owner crash temporarily makes authoritative state mutations unavailable
while ingress `/healthz` remains live. Its replacement reopens the same single-writer
DB lease and reattaches active, recoverable Jobs by their original Job/request IDs.
The execution owner retains exact assignment, live question and terminal receipts;
results are acknowledged only after a durable terminal commit. No prompt or new
turn is automatically replayed. The controller's read and telemetry processes can
restart independently. A normal explicit application shutdown still closes the
execution owner after the application's existing drain policy.

Legacy active Jobs without execution receipts retain their previous restart
reconciliation. A missing owner receipt is reported explicitly; recovery does not
invent a result or execute the prompt again. Existing durable answer/steering
journals preserve uncertain delivery when a controller dies during dispatch.

State-child recovery follows this order:

1. acquire the canonical database lease and reject any live older owner;
2. validate schema, integrity boundary and worker generation;
3. resolve durable receipts and prepared/dispatching/uncertain domain journals;
4. reattach exact recoverable Jobs, or reconcile a confirmed lost owner without replaying
   work;
5. start fresh read, telemetry and execution generations;
6. publish a fresh heartbeat and only then re-enable admission.

Messages and responses from an older generation are rejected. A slow old child
cannot become a second writer after its lease has been revoked; the supervisor
must confirm its exit and lock release before starting a replacement writer.

## Telemetry flow

Operational commit never waits for telemetry. After a state commit, a sanitized
diagnostic fact may be offered with an idempotent observation ID. Failure to send
or persist it increments an in-memory drop counter and does not change the
operational result.

The state-owner-to-telemetry queue is capped at 4,096 records and 16 MiB, with a
16 KiB sanitized-record limit. Transport observations, duration measurements
and diagnostic state transitions have independent retained row caps. Queue,
send and write loss update persistent kind/count/first/last drop counters via a
reserved control message. Failed counter persistence uses bounded exponential
retry so a full diagnostic disk cannot create a reporting loop. Records never
include raw prompts, Job results,
secrets, absolute project paths or unsanitized subprocess output.

Records accepted while the initial telemetry open is recovering are not sent
until the database reports ready. Their provisional IDs are rebased above the
database maximum, and every record also carries an idempotent delivery UUID.
The child uses a strict insert, remaps a genuine legacy-ID collision, and
returns the actual persisted ID; retry after ACK loss resolves through the
delivery ledger instead of silently ignoring a row. Drop counters accumulated
during that startup interval are added to, rather than overwritten by, the
persisted counters before the reserved counter update is sent.

The telemetry database uses its own WAL/checkpoint and retention state. A lock,
capacity failure or process exit only accumulates bounded telemetry work or
drops detail; it never changes an operational transaction. Transient startup
locks recover by restart. A corrupt, incompatible or wrong-source telemetry
database is moved with its WAL/SHM into a recoverable quarantine directory and
rebuilt against the current state database UUID. Telemetry loss never causes an
operational database restore.

## Migration, cutover and rollback

The production cutover keeps the existing schema-25 operational database and
atomic repositories intact:

1. ingress starts no SQLite connection and starts exactly one state owner;
2. the state owner acquires the canonical lease before it advertises ready;
3. it starts a read-only projection child and a source-UUID-bound telemetry
   child;
4. classified observations begin writing only to `telemetry.sqlite`; the old
   state table remains unused for one compatibility window and is not
   destructively migrated;
5. the Codex executor starts lazily, without Bridge database paths or listener
   credentials, before the first runtime/account operation.

Starting the separate protocol-v4 maintenance writer beside this topology is
forbidden. No cutover stage permits two live operational writers. Keeping the
old diagnostic table avoids a destructive data migration; historical
diagnostics are allowed to remain in the rollback-compatible state file while
new observations use the bound telemetry file.

### Current implementation status

The issue #142 production topology is selected for both HTTP and stdio. Public
HTTP, native companion and stdio ingress stay in a SQLite-free supervisor. The
state owner is the sole operational writer and all native application methods
cross its versioned command/query/control protocol. MCP requests cross the same
process boundary before they can reach admission or any repository. Dashboard
and Settings projections, best-effort diagnostics and actual Codex App Server
execution each run in a separate child.

The state owner still contains application orchestration and synchronous atomic
repositories. That is deliberate: moving each repository method behind another
RPC layer would split existing Units of Work without adding failure isolation.
The long-running Codex work that must continue during a state DB wait is now in
the executor child, while all state decisions remain with the one writer.

The production central writer is consequently serialized by design. Project-
fair progress admission prevents a noisy project from filling the disposable
progress queue, and native/control requests retain parent capacity, but neither
claim can preempt a synchronous SQLite call that has already started. During
that interval readiness reports the last confirmed `read` or `write` phase and
callers receive a bounded unconfirmed outcome; public connection liveness stays
available. The executor can continue already-admitted Codex work during that
wait; its progress/result is applied after the state owner resumes. This does
not claim SQLite writes became concurrent.

Storage failures returned by SQLite are now distinct from elapsed time. `BUSY`,
`FULL`, I/O, corruption and read-only errors make mutation admission fail closed
and remain visible in readiness until a later authoritative transaction commits.
Proxied MCP failures include the bounded limitation, retryability and certainty
class instead of collapsing the condition into a generic disconnect.

Before every physical cutover, create and verify a consistent state backup that
includes committed WAL content. Do not copy the main file alone and do not run
live `VACUUM`. New state writes after service-open forbid restoring an older
snapshot. Roll back by running a compatible state-service implementation against
the current authoritative `state.sqlite`, or by a reviewed forward-preserving
conversion. Loss of `telemetry.sqlite` never authorizes rollback of state.

## Verification gates

Issue #142 completion requires these checks on disposable fixtures and the
actual installed app/runtime combination:

- a 2,000-update executor burst while the owner cannot receive IPC, plus a
  100-update noisy-project persistence burst, second-project fair drain and
  critical-input bypass without an unbounded queue;
- multiple concurrent Dashboard readers and every bounded maintenance slice,
  with `/healthz` p99 under 200 ms during the declared state-fault load;
- Bridge event-loop delay p99 under 50 ms under the declared test load;
- critical state command commit p99 under 500 ms when the operational database
  is healthy;
- a locked, delayed, killed and restarted telemetry child without direct effect
  on operational command latency or Bridge health;
- a locked and killed state child with no false success, no automatic Job
  cancellation and explicit readiness failure;
- commit-then-response-loss, duplicate request, late response and old-generation
  cases resolved through the applicable maintenance or domain receipt/journal;
- slow Dashboard/history reads that do not block state commands;
- state-child crash/restart with one writer and preserved cancellation,
  interaction, terminal and completion-delivery evidence;
- migration interruption before and after cutover, and post-service rollback
  refusal without loss of new operational state;
- stale Dashboard preservation, generation-aware resync and no cross-scope cache
  or event mixing;
- installed native lifecycle, Tunnel interruption and card remount with
  authoritative state convergence and no inferred failure/cancellation.
- App Server-first exit while a same-group command remains, with admission and
  replacement fenced until that command is verified gone;
- executor loss while a long-running command owns a separate Unix process
  group, with both groups verified gone before executor replacement.

Record p50, p95, p99, maximum stall, queue bytes/depth, worker generation,
database identity, build, load shape and fault timing. Passing unit tests or
starting separate processes alone is not completion evidence. The executable
gate is `npm run test:issue-142-state-execution-isolation`; unit and installed
evidence, exact build identity and any accepted limits belong in the issue #142
audit linked above.
