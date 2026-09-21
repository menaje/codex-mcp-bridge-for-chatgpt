# State execution isolation architecture

This document is the issue #142 architecture decision produced from the issue
#143 T1 evidence. It extends the schema-25 ownership contract in
[State data access and maintenance ownership](state-data-access.md). It does not
make a second writer legal, relax any Unit-of-Work invariant, or treat a queued
IPC message as a durable state change.

## Decision

Adopt three execution boundaries and two SQLite files:

```text
Bridge ingress process
  - HTTP, MCP and local companion listeners
  - authentication, scope and request validation
  - in-memory execution signals and bounded IPC admission
  - no SQLite connection after state-service cutover
             |
             | versioned asynchronous command/query protocol
             v
Operational state child process
  - one state.sqlite writer and one semantic command scheduler
  - schema migration, Unit of Work and authoritative maintenance
  - durable command receipts and worker generation
  - one read-only worker thread for Dashboard/history projections
             |
             | independent bounded diagnostic batches
             v
Telemetry child process
  - one telemetry.sqlite writer
  - sampling, coalescing, drop accounting and retention
  - no authority to admit, cancel, complete, deliver or recover work
```

The operational state owner and telemetry owner are child processes, not two
event loops sharing the Bridge process. The operational read path is a worker
thread inside the state child and opens `state.sqlite` read-only. It is not a
third database or a writer. `better-sqlite3` remains the initial driver in all
three isolated execution contexts.

A worker thread alone is insufficient for the operational writer because a
native crash, runaway allocation or process-level failure would still terminate
the Bridge. A separate local service is unnecessary for the first version:
authenticated network exposure, install management and another external
lifecycle would add failure modes without improving the single-host ownership
contract. A supervised child process provides the selected boundary.

## Why execution isolation precedes file separation

Issue #143 directly observed both `runtime.health` and `/healthz` miss the same
two-second interval while the Bridge PID remained alive. The post-timeout sample
contained synchronous `better-sqlite3` work and garbage collection on the main
event loop. A disposable lock test delayed the state write, HTTP health and an
event-loop timer by about 3.25 seconds and made `runtime.health` exceed its
two-second deadline.

Moving rows to another file while both files remain on the Bridge event loop
does not address that failure. The implementation order is therefore:

1. introduce an asynchronous semantic state boundary and convert every caller;
2. cut all SQLite ownership over to the operational state child at one point;
3. move read models to its read-only worker thread;
4. add the telemetry child and move only classified disposable data;
5. integrate degraded state and end-to-end recovery in the native app and
   Dashboard.

## Database classification

Unclassified or mixed-use data remains in `state.sqlite`. Importance is decided
by consumers and recovery semantics, not by a table or event name.
The exhaustive schema-25 table, index, trigger, consumer, recovery and file
security inventory is maintained in
[State schema ownership catalog](state-schema-ownership-catalog.md).

### `state.sqlite`

The following current schema-25 tables remain authoritative operational state:

| Domain | Tables | Reason |
| --- | --- | --- |
| schema and ownership | `bridge_meta`, `bridge_instances` | database identity, migration, instance generation, HMAC and recovery evidence |
| scope and configuration | `scopes`, `project_registry`, `projects`, `user_settings` | admission, permission and version authority |
| execution relationships | `sessions`, `activities`, `agents`, `agent_threads`, `activity_agents`, `thread_connections` | resume, ownership, assignment and lifecycle authority |
| Job state | `jobs`, `job_interactions`, `result_holds` | admission receipt, exact state, input and retained-result protection |
| mutation certainty | `agent_mutations`, `cancellation_operations`, `cancellation_intents`, `steering_deliveries` | idempotency, provenance and uncertain-effect recovery |
| completion delivery | `completion_outbox`, `job_completion_deliveries` | pending delivery, lease, receipt and acceptance certainty |
| questions and decisions | `user_questions`, `codex_question_deliveries`, `decision_cards`, `decision_card_versions`, `decision_card_requests`, `decision_submissions` | user-response authority and delivery recovery |
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

`transport_observations.bridge_instance_id`, scope, Activity and Job identifiers
are correlation values, not foreign keys into `state.sqlite`. Telemetry may lag,
duplicate or outlive the corresponding operational row. It can never establish
that an operation happened or authorize a replay.

## State protocol

The Bridge sends semantic operations, never arbitrary SQL, table names or raw
query fragments. The protocol is local-only and uses length-bounded structured
messages over Node child IPC in the first implementation. Every request has this
envelope:

```ts
type StateRequestEnvelope = {
  protocol: "bridge-state-service";
  version: 2;
  requestId: string;          // unique IPC attempt UUID
  commandId: string;          // stable UUID for a logical mutation retry
  kind: "command" | "query" | "control";
  operation: string;          // closed discriminated union
  aggregateKey?: string;      // Job, Agent, Activity or scope ordering key
  scopeId?: string;           // already authenticated by the Bridge
  expectedVersion?: number;
  workerGeneration: string;
  deadlineAt: number;
  payloadSha256: string;
  payload: unknown;
};
```

The state service validates the complete envelope again. `deadlineAt` controls
queue admission only; it cannot interrupt a running synchronous SQLite call or
turn an unknown commit result into a rejection.

Mutation results use exactly three certainty classes:

- `committed`: the transaction and durable command receipt committed and the
  response carries the resulting authoritative version;
- `not-applied`: validation, version or capacity rejection occurred before a
  transaction could apply the command;
- `outcome-unknown`: IPC closed or the worker generation changed after the
  command might have committed.

On `outcome-unknown`, the Bridge queries the durable receipt for the same
`commandId` and payload hash. It never invents a new logical request ID. A hash
mismatch is a conflict, not a retry. External effects retain their existing
prepared/dispatching/uncertain journals; a state receipt does not claim an
external recipient accepted anything.

Schema 25 adds `operational_command_receipts` with command ID, operation,
payload hash, aggregate, resulting version, compact result, generation and
commit time. Receipts are capacity-bounded only after every referencing request
and uncertainty window expires. Existing domain request IDs remain the business
idempotency authority; the receipt closes the IPC response-loss window.

## Queue and fairness contract

Capacity is reserved before a payload is sent to child-process IPC. Transport
buffer acceptance is not state acceptance.

| Lane | Work | Initial request/byte budget | Behavior at capacity |
| --- | --- | ---: | --- |
| critical | cancellation intent/result, user input, terminal result, required delivery state, receipt lookup | 256 / 16 MiB reserved | reject only new work that has not started; preserve recovery/query access |
| admission | new Job/Activity/Agent commands and settings/project mutations | 512 / 32 MiB | explicit retryable `state-busy` before external execution starts |
| progress | coalescible non-terminal progress state | 1,024 / 32 MiB | coalesce only identical aggregate successors whose skipped versions have no consumer |
| maintenance | retention and reconciliation slices | one running plus one pending per slice | defer while critical or admission work is queued |
| query | exact state, Dashboard and history | 128 / 64 MiB response budget | exact reads get reserved slots; large optional history reads fail retryably |

These are implementation constants to be verified under load, not public SLA.
One message is capped at 2 MiB for commands, 256 KiB for query input, and 8 MiB
for query output. Larger result bodies use the existing bounded Job-result
contract and a chunked or exact-result read operation rather than an unbounded
IPC object.

Commands for the same aggregate are FIFO. Across independent aggregates, the
scheduler uses round-robin scope/project buckets so one progress-heavy project
cannot consume all normal capacity. Critical work has reserved capacity but is
not allowed to reorder two commands for the same Job or Agent. Maintenance runs
only when the higher lanes are empty and retains the bounded slice contracts
from schema 25.

The Bridge limits total in-flight state requests to 64. The state child processes
one write transaction at a time. Read-only worker queries have a separate limit
of eight in flight and do not hold a read transaction while waiting for change
notifications.

## Read protocol and freshness

The state child publishes an in-memory authoritative summary after each commit:
state database ID, generation, last committed sequence, last commit time, queue
depths and admission state. The Bridge may use that summary for presentation and
readiness, never to authorize a mutation.

Dashboard/history queries run in the read worker against a read-only WAL
connection. A query result includes the state database ID, writer generation,
snapshot sequence, data-confirmed time and stale flag. If the read worker fails,
the Bridge may retain the last successful presentation with an explicit stale
marker. It must not replace Jobs with an empty list or treat stale content as
current cancellation/completion authority.

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
  `state-incompatible`, `state-capacity` or `admission-draining`;
- telemetry and read-worker degradation are reported as feature limitations but
  do not by themselves make operational mutation admission false.

`runtime.health` remains in-memory and adds the last state-service heartbeat,
read/telemetry availability and feature reason codes. The native helper presents
`healthy`, `degraded`, `state-unavailable`, `response-unconfirmed`, and
`process-exited` separately. One timeout first lowers freshness; only a confirmed
PID exit becomes `process-exited`. Recovery becomes healthy only after a current
generation and fresh authoritative snapshot are observed.

## Failure and restart rules

The Bridge supervises both children independently with bounded exponential
backoff. A telemetry crash never restarts the Bridge, state child, Tunnel or
Codex runtime. A state-child crash makes new state-changing work fail closed,
but does not cancel existing Codex processes or report their Jobs failed.

The Bridge retains only a finite, byte-bounded memory buffer for runtime
terminal observations that arrived while state was unavailable. It reports
`observed-not-persisted` and reconciles from the actual Codex runtime where that
runtime supports exact result/status recovery. Buffer exhaustion is recorded as
`missing-or-unconfirmed`; it never fabricates success.

State-child recovery follows this order:

1. acquire the canonical database lease and reject any live older owner;
2. validate schema, integrity boundary and worker generation;
3. resolve durable command receipts for in-flight command IDs;
4. reconcile prepared/dispatching/uncertain domain journals;
5. query actual runtime state without replaying work;
6. rebuild the current read snapshot;
7. publish a fresh heartbeat and only then re-enable admission.

Messages and responses from an older generation are rejected. A slow old child
cannot become a second writer after its lease has been revoked; the supervisor
must confirm its exit and lock release before starting a replacement writer.

## Telemetry flow

Operational commit never waits for telemetry. After a state commit, a sanitized
diagnostic fact may be offered with an idempotent observation ID. Failure to send
or persist it increments an in-memory drop counter and does not change the
operational result.

The Bridge-to-telemetry queue is capped at 4,096 records and 16 MiB; batches are
capped at 500 records or 512 KiB. Severity transitions and drop counters have
reserved capacity. Repeated measurements may be coalesced into count/min/max/
sum buckets. Records never include raw prompts, Job results, secrets, absolute
project paths or unsanitized subprocess output.

The telemetry database has an independent global byte target, WAL checkpoint
policy and retention scheduler. Disk-free-space admission is checked before a
batch. Telemetry stops accepting detail before it can consume the reserve needed
by `state.sqlite`; repeated failure reporting is rate-limited and cannot create
an error-amplification loop.

## Migration, cutover and rollback

The asynchronous API conversion and physical owner cutover are separate:

1. Add the typed state-service interface and in-process compatibility adapter.
   Convert all repositories, controllers and tools to await semantic operations.
   SQLite still has one in-process owner; this stage claims no isolation.
2. Add the child-process implementation and fault tests. At startup, close the
   compatibility owner before the child acquires the canonical lease. No stage
   permits both to write.
3. Add the read worker and switch Dashboard/history queries after snapshot and
   version equivalence tests.
4. Create `telemetry.sqlite` from a consistent copy while admission is stopped.
   Copy only classified `transport_observations`, verify counts/digests, bind the
   telemetry source identity, then select both databases as one cutover
   generation. Current mixed event tables remain in state.
5. Start telemetry writes. Keep the old state table unused for one compatibility
   window if rollback requires the older binary; removing it needs a later
   catalogued schema migration.

### Current implementation status

The repository now contains the versioned child-process transport, generation
checks, bounded parent admission, deadlines, heartbeats, schema-25 durable
command receipts, and standalone locked-database/response-loss isolation tests.
An identical command ID and payload is replayed from its original receipt after
a state-owner restart; a changed payload fails closed. Only the maintenance
semantic operation is implemented through that transport. Production startup
deliberately continues to use the
in-process compatibility owner and reports `state-incompatible` from `/readyz`.
The child must not be selected until every operational command and query caller
has crossed the asynchronous boundary and the compatibility owner can be closed
before child startup. This status is implementation progress, not cutover or
resolution evidence.

Before every physical cutover, create and verify a consistent state backup that
includes committed WAL content. Do not copy the main file alone and do not run
live `VACUUM`. New state writes after service-open forbid restoring an older
snapshot. Roll back by running a compatible state-service implementation against
the current authoritative `state.sqlite`, or by a reviewed forward-preserving
conversion. Loss of `telemetry.sqlite` never authorizes rollback of state.

## Verification gates

The implementation is not complete until all of these pass on disposable
fixtures and the actual installed app/runtime combination:

- 100 concurrent progress producers, multiple Dashboard readers and every
  maintenance slice while `/healthz` p99 remains under 200 ms;
- Bridge event-loop delay p99 under 50 ms under the declared test load;
- critical state command commit p99 under 500 ms when the operational database
  is healthy;
- a locked, delayed, killed and restarted telemetry child without direct effect
  on operational command latency or Bridge health;
- a locked and killed state child with no false success, no automatic Job
  cancellation and explicit readiness failure;
- commit-then-response-loss, duplicate request, late response and old-generation
  cases resolved through the same command receipt;
- slow Dashboard/history reads that do not block state commands;
- state-child crash/restart with one writer and preserved cancellation,
  interaction, terminal and completion-delivery evidence;
- migration interruption before and after cutover, and post-service rollback
  refusal without loss of new operational state;
- stale Dashboard preservation, generation-aware resync and no cross-scope cache
  or event mixing;
- macOS sleep/wake, Tunnel interruption and ChatGPT card remount with authoritative
  state convergence and no inferred failure/cancellation.

Record p50, p95, p99, maximum stall, queue bytes/depth, worker generation,
database identity, build, load shape and fault timing. Passing unit tests or
starting separate processes alone is not completion evidence.
