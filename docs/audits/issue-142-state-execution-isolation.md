# Issue #142 state/execution isolation acceptance

## Scope and final design

Issue #142 is complete only when operational state, read projection,
diagnostics and actual Codex execution no longer share one blocking event loop,
all production command/query entry points cross the operational owner boundary,
and the installed application is verified against the same source revision.

The final implementation uses a whole-coordinator state boundary instead of
turning every repository call into a separate asynchronous RPC:

```text
SQLite-free ingress (HTTP / MCP / native / stdio)
  └─ operational state owner (application coordinator + sole state.sqlite writer)
       ├─ read projection (state.sqlite read-only)
       ├─ telemetry owner (sole telemetry.sqlite writer)
       └─ Codex executor (App Server pool; no Bridge DB/listener authority)
```

This preserves every existing multi-repository Unit of Work. Native calls use
the closed `bridge-operational-state-owner` v2 command/query/control protocol;
MCP traffic crosses the same bounded process boundary before admission. The
executor uses `bridge-codex-execution` v1 and relays assignments, progress,
interactions, steering, release checks, results and late responses. Account App
Server I/O also uses the executor, while account cache/presentation policy stays
with the state owner.

The protocol-v4 maintenance writer remains a receipt and fault-test harness.
Production never starts it beside the state owner, so it cannot become a second
SQLite writer.

## Implemented boundaries

- Ingress has 128 total state-owner requests, reserves 16 slots from MCP, caps
  one message at 8 MiB and proxied bytes at 32 MiB. Pre-forward rejection is
  `not-observed`; response loss after forwarding is `unknown`.
- Codex execution has 128 requests, a 2 MiB request cap, 32 MiB in-flight cap
  and 8 MiB response cap. It has a generation heartbeat and bounded restart.
  A crashed active turn becomes `CODEX_WORKER_LOST` and is persisted as
  interrupted/worker-lost rather than false success or cancellation.
- Executor-to-owner IPC keeps at most 256 critical messages/32 MiB and
  coalesces ordinary `updated` progress to 128 request entries/8 MiB. Critical
  overflow fails the executor closed instead of growing process memory without
  a bound; input, approval, warning, error, usage and lifecycle milestones are
  never classified as disposable progress.
- The executor environment excludes both Bridge DB paths, model/skills state,
  companion socket and bearer token. A test fixture observes that exclusion in
  the actual Codex subprocess.
- Thread release does not serialize a state callback. The executor asks the
  state owner again before each unsubscribe/process-close step and fails closed
  if the check cannot be confirmed.
- Dashboard and Settings structural reads use the independent read-only child
  with 16-request/8 MiB bounds and stale-view semantics.
- Telemetry uses a 4,096-record/16 MiB queue and separate SQLite process. Its
  schema now includes metadata/source identity, transport observations,
  duration measurements, diagnostic transitions, persistent drop counters and
  restartable retention state. Failed drop-counter writes use bounded
  exponential retry rather than a failure-amplification loop.
- Telemetry startup locks recover by restart. Corrupt, incompatible or
  wrong-source databases are moved with WAL/SHM into a recoverable quarantine
  directory before an empty source-bound telemetry DB is created. Operational
  state is never rolled back because telemetry failed.
- The existing 256-total/32-per-project progress queue, critical-event bypass,
  bounded maintenance slices and domain idempotency journals remain intact.

## Source fault/load acceptance

`npm run test:issue-142-state-execution-isolation` uses only disposable DBs and
the production startup path. On 2026-09-22 it produced:

| Check | Result |
| --- | --- |
| topology | ingress, state owner and Codex executor were distinct PIDs; state DB UUID remained stable across replacement |
| Dashboard reads | 12 structural readers completed concurrently in 201.892 ms; first account-enriched read started the executor |
| execution child stall | `/readyz` reported `execution-stale`, actual `codex_task` admission returned retryable `EXECUTION_UNAVAILABLE`, and the durable Job count stayed zero |
| 25 healthy state commands | p50 2.409 ms, p95 6.015 ms, p99/max 7.548 ms |
| telemetry DB write lock + 25 state commands | state p99/max 2.302 ms; `/healthz` and `/readyz` stayed HTTP 200; telemetry drained after unlock |
| operational DB lock | 253 `/healthz` samples: p50 1.507 ms, p95 2.446 ms, p99 3.530 ms, max 7.018 ms |
| ingress event-loop lag during state lock | p50 2.617 ms, p95 3.732 ms, p99 5.150 ms, max 8.131 ms |
| state-lock certainty | caller received unknown/unconfirmed; readiness showed `state-stale + state-write-unconfirmed`; the authoritative revision later advanced exactly once |
| executor crash | `/healthz` returned in 1.311 ms; executor restarted; state-owner PID and DB UUID did not change |
| state-owner crash | `/healthz` returned in 0.656 ms; one replacement owner acquired the same DB UUID and preserved the settings revision |

The focused execution regression also blocks the state-owner event loop for
500 ms and proves from an executor-written timestamp that Codex completed while
the owner was blocked; the result was delivered after the owner resumed.

The wider automated evidence includes:

- 100-update noisy-project progress saturation, project-fair drain and critical
  input bypass in `test/jobRegistry.test.ts`;
- execution crash/restart, interaction privacy, thread release rechecks and
  authority stripping, plus a 2,000-update flood while the owner event loop is
  blocked, in `test/executionServiceProcess.test.ts`;
- telemetry lock/flood/drop persistence, `SQLITE_FULL`, startup lock recovery,
  corruption quarantine and source-identity rebuild in
  `test/telemetryService.test.ts`;
- state/read/runtime lock, storage error, response loss, capacity, owner crash,
  rollback compatibility and telemetry rebuild in `test/runtimeProcess.test.ts`;
- migration checkpoint interruption, verified backup/restore and post-open
  rollback refusal in the state lifecycle/recovery suites.

The final source checkout passed the release/build checks, App Server schema
compatibility check, 98 TypeScript test files / 869 tests, and 205 macOS tests
with two environment-dependent live smoke tests skipped. The issue-specific
fault/load command above also passed again after the final queue and admission
changes.

## Exact limits retained

Isolation does not shorten a held SQLite lock, `fsync`, filesystem/hardware
stall or external Tunnel/ChatGPT/Codex network delay. The one operational
writer is intentionally serialized, and no queue preempts a synchronous write
already inside SQLite. During that interval ingress health and the executor can
continue, but state mutations wait or become explicitly unconfirmed.

A state-owner process crash replaces its read, telemetry and execution
generations. It does not keep an orphan Codex process running without a state
authority; an unfinished Job is reconciled as worker-lost. This is different
from an executor-only crash, which restarts without replacing the state owner.

## Installed acceptance

The production cutover was completed on 2026-09-22 KST from installed build
`90b64c35d78a:2f89aecac2b4` to the issue implementation merge
`ab760afab04e639c43baff09d021bb2217b8ec23`, build
`ab760afab04e:139092fee804`. The installed bundle passed strict code-signature
verification and its embedded build identity matched the merge before the
replacement runtime was admitted.

Immediately before shutdown, authoritative `runtime.snapshot` reported zero
active Jobs, pending admissions, pending interactions, memory-only threads and
background processes. The application then used a non-force lifecycle
reservation and all app, helper, launcher, server, state, read, telemetry,
execution and Tunnel processes exited before replacement.

The rollback artifact is
`~/.codex-mcp-bridge/backups/issue-142-pre-ab760af-20260922T1715KST` and contains
the previous signed application, its LaunchAgent definition, build metadata
and SQLite online backups of both databases. The state backup passed
`quick_check` and had zero foreign-key violations; the telemetry backup passed
`quick_check`. The state and telemetry backup SHA-256 values are respectively
`a3706d18742f144da5ea61f3583624595a31476342a3efff9ba570859da30b5d` and
`365343df1b0f519c45008ae27d7f0c8d04a3c4d3111a3ee908a119c477af85a9`.
Normal rollback uses the previous compatible application against the current
authoritative state file; the pre-cutover state snapshot is disaster-recovery
evidence and is not permission to discard post-cutover writes.

The installed process tree contained distinct server, state-owner, read,
telemetry and execution PIDs. Telemetry recorded the same source state database
identity, `d710d487-807d-4813-9786-f3a262322848`, and exposed all six final
schema groups: metadata, transport observations, runtime measurements,
diagnostic events, drop counters and retention state.

Installed fault and integration results were:

| Check | Installed result |
| --- | --- |
| executor stopped for 2.7 seconds | `/healthz` stayed HTTP 200 in 24.165 ms; `/readyz` became HTTP 503 `execution-stale` in 7.528 ms; `runtime.health` and authoritative snapshot returned in 2.225/2.136 ms and both denied new admission |
| executor terminated | `/healthz` stayed HTTP 200 in 3.995 ms; executor PID and generation changed while state-owner PID and generation did not |
| state owner terminated | `/healthz` stayed HTTP 200 in 20.658 ms; the server PID remained, one replacement state owner acquired the same database identity, settings revision 168 remained unchanged, and read, telemetry and execution children were replaced |
| Tunnel stopped for 6.5 seconds | local `/healthz`, state and execution stayed ready; the Tunnel probe timed out and native status became `degraded`; resuming the same Tunnel returned `ready` and `connected` without replacing the state owner |
| native contract | the production Swift client decoded live installed Dashboard and Settings responses from the real companion socket; 1 test passed in 0.958 seconds |
| installed cards | Dashboard, Settings and Decision cards retained the last confirmed UI through dispatched-read timeouts and did not create a second tool-call retry path |

After every injected fault, authoritative admission returned to true with zero
active Jobs, pending admissions, pending interactions, memory-only threads and
background processes. Tunnel `/healthz` and `/readyz` returned `live` and
`ready`. Final live state checks again returned `quick_check=ok`, zero foreign-
key violations and `telemetry.sqlite` `quick_check=ok`; state, read, telemetry
and execution services all reported ready.

This installed evidence uses the same implementation revision as the source
fault/load evidence. Together they satisfy the issue gates. The exact limits in
the preceding section remain accepted behavior, not unfinished work: isolation
does not shorten SQLite, filesystem, hardware or external-network latency, and
it does not make the intentional single operational writer concurrent.
