# Issue #185: execution lifetime and control recovery

Implementation baseline: PR #184, `cb052932c5813b1b313077d54b323225889010b3`.

The original receipt limits and ACK scheduling below were corrected by
[#189](issue-189-execution-retention.md); use that audit for current capacity,
release acknowledgement, and diagnostic behavior.
This supersedes the global observation fences and parent-IPC lifetime rules in
the historical #142/#182 audits. Those audits remain records of their tested builds.

## Evidence, authority, scope, recovery

| Evidence | Decision owner | Affected scope | Recovery / termination authority |
| --- | --- | --- | --- |
| Exact `turn/completed`, matching thread/turn and worker generation | App Server protocol adapter, then state writer | Original Job | Retain exact result; commit terminal state; acknowledge receipt. No new turn. |
| Direct owned App Server exit | Execution owner | That worker's turns and slot | Reject its active turns; retain slot during descendant cleanup. Other workers remain usable. |
| Direct execution-owner exit or absent recorded PID | Control proxy | That owner's Jobs | Worker-loss reconciliation and verified retained-tree cleanup before replacement. Never infer success. |
| `/bin/ps` timeout, spawn/exit/parse/output/ledger failure, unknown observer error | Auxiliary observer | Diagnostic state; uncertain cleanup slot where applicable | Bounded retry; no executor kill, terminal Job mutation or global admission fence. |
| Missing heartbeat, clock jump, process pause | Control freshness reporting | Freshness field | No kill/restart. An open link may carry bounded work and exact controls. A paused process cannot confirm delivery until it resumes. |
| Socket EOF, send failure, backpressure | Reconnectable transport | Control link and its bounded pending requests | Reconnect; resend the same request ID/fingerprint; owner deduplicates. Never return delivery success from a send callback. |
| State-writer crash/restart | Ingress supervisor and replacement state writer | State availability | Acquire the existing DB lease; subscribe to exact active Job receipts; recover assignment/question/result. |
| Durable explicit cancellation | Job registry and original worker | Exact turn, with existing explicit worker escalation policy | Completed turn wins a late cancellation. Unknown turn ownership cannot authorize shared-worker termination. |
| Explicit application close | Existing application drain/lifecycle owner | Selected runtime | Close owner and workers. The five-second forced-close fallback applies to explicit shutdown, not observation. |
| Per-request result/input size or retention reservation exhaustion | Execution receipt journal | Original request; admission when real capacity is exhausted | Bounded explicit delivery error. Oversized live input requests precise turn interruption, with no shared-worker fallback. Other receipts survive. |
| OS kill / OOM / machine power loss | OS | Process or host actually lost | Cannot recover an uncommitted in-memory receipt after its execution owner dies. This is distinct from an auxiliary observer timeout. |

## Ownership and reconnect contract

The existing execution process remains the owner of the CLI stdin/stdout pipes.
No attempt is made to reopen a dead pipe. A private directory keyed by the state
file identity contains an authentication token, local socket, owner PID/generation
and bounded process-tree ledger. Directories are `0700`, regular files `0600`;
POSIX socket mode is `0600`. The execution process receives no Bridge SQLite path
or credentials. There is still exactly one state writer and no telemetry-based
execution authority.

Protocol 6 authenticates the controller, identifies the execution generation,
and maintains a stable Job UUID as the turn request ID. A replacement controller
uses subscribe-only recovery; it does not reconstruct prompt arguments. The owner
checks duplicate request fingerprints. Assignment/progress sequence numbers and
event IDs suppress duplicate callbacks; terminal receipts cannot be overwritten
by late events. The state registry reconstructs thread/Agent linkage and the same
question reference. Existing scope, Agent, thread and workspace policy checks
remain at admission.

A result remains in the owner until the DB's terminal transaction commits. Lost
acknowledgements are resent after reconnect and explicitly confirmed. DB commit
failure retains the original outcome for retry instead of substituting a failed
turn. On controller restart, already-terminal durable Jobs release any leftover
receipts. Active Job receipts survive controller replacement. Ephemeral control
responses from a dead controller have no live caller; existing durable answer,
steering and cancellation journals represent their delivery as unconfirmed and
prevent automatic re-execution. Reconnection within the same controller recovers
the original control request ID and response.

## Resource limits

- 36 receipt reservations: 30 ordinary, six reserved for controls. Each reserves
  at most 8 MiB result and 8 MiB events, plus a small explicit error receipt.
  Request arguments are separately bounded to 2 MiB. Actual storage is allocated
  on demand. A pending or unacknowledged result continues to consume capacity.
- Current questions and the latest assignment are retained; ordinary progress
  is coalesced to one 64 KiB snapshot. At most 64 retained event keys per request
  and 4,096 acknowledged-ID tombstones prevent unbounded history. After a terminal
  acknowledgement the durable Job/request ledger owns future deduplication.
- 9 MiB transport frames, a 16 MiB socket write bound, a finite controller queue,
  one outbound write at a time, and fair receipt rotation prevent a stalled
  reader or noisy worker from creating unbounded buffers.
- Oversized completed results produce `EXECUTION_RESPONSE_TOO_LARGE`, never a
  fabricated saved result. Oversized important input produces an explicit
  `EXECUTION_EVENT_RETENTION_EXHAUSTED` observation and precise containment of
  that turn. If interruption cannot be confirmed, its reservation stays held;
  the owner does not kill unrelated turns to recover space.

## Process observation and cleanup boundary

There is one auxiliary two-second observer in the execution owner. It coalesces
concurrent probes and persists only changed ledgers. Parent periodic scans,
command-start scans and registration/cleanup acknowledgement round trips are
removed. A spawn callback establishes root ownership; no successful `ps` query
is required before a healthy worker accepts work. Actual cleanup uses bounded
probes and retries within the retained worker slot.

The ledger compares PID, process group and OS birth stamp before signaling
individual captured descendants. A numeric reused PID/PGID does not establish
ownership. An unverified root/group is retained instead of being killed or
counted as free capacity. A cleanup failure on A cannot select a replacement A
while B and an unused C slot remain available.

This portable process-table ledger cannot prove ownership of a detached child
that forked, detached and lost its parent between observations. It also lacks
an atomic OS process-handle signal operation for reparented descendants; birth
checks reduce reuse exposure but do not claim a race-free kernel containment
boundary. Tests cover observed detached and same-group descendants and reject
reused identity evidence. Full containment of arbitrary escaping children would
require an OS job/cgroup facility, not a shorter polling deadline.

## Validation

The fixtures use isolated temporary state and fake App Server processes; they do
not modify the user's live database or inject faults into live Jobs.

| Test | Evidence |
| --- | --- |
| Continuous slow/failed/oversized `ps` | Existing turn and independent new turn complete before the fault is removed. Slow case exceeds two old/current probe deadlines. |
| Missing heartbeat only | Normal worker traffic and new work continue beyond the old ten-second kill threshold. |
| Actual executor `SIGSTOP`/`SIGCONT`; parent clock/event-loop/SQLite pause | Separate from missing-heartbeat injection; same execution resumes. |
| A registration and cleanup blocked | B answers its exact question; free C executes; A is not replaced and still consumes a slot. |
| Control socket failure/reconnect | Original request/thread/turn/generation and exact final result retained. |
| Actual state writer `SIGKILL`, then `SIGTERM` | Replacement is temporarily stopped; two workers finish two Jobs with no controller; a third Job's question survives both restarts. All three original results are recovered, one answer is delivered, no Job/turn is duplicated. |
| Completion/cancel race and busy terminal transaction | A completed turn returns `already-completed`; another active turn on the same worker is not killed. A deferred result and an upstream error retain their exact outcomes through commit failure; no receipt is acknowledged before durable commit. |
| Large reconnect history | 600 terminal acknowledgements and 600 protected thread IDs drain through the finite queue without replacing the owner or preventing new work. |
| Sender error, progress flood, oversized important event, reservation exhaustion | Finite retention, explicit scoped failure, preserved peer result and reserved controls. |
| Actual worker/owner death and captured detached descendants | Existing #142 cleanup/replacement protections retained; actual loss remains distinct from observation uncertainty. |

Source reproduction: `npm run test:issue-185-execution-recovery` and
`npm run test:issue-142-state-execution-isolation`. The #185 script also accepts
`CODEX_TEST_BUNDLE_DIST` pointing at an installed bundle's `dist` directory.
Installed-artifact identity and final test counts are recorded in the PR/issue
completion evidence. Synthetic fault injection is not evidence of long-running
real-user load or a physical machine sleep/wake test; those observations must
be reported separately.
