# Issue #193: background work budget and exact-control priority

The state owner is a single JavaScript event loop around operational SQLite. A synchronous discovery loop delays exact Job and input/result reads even when SQLite has no writer contention. Before this change, one automatic recovery tick hydrated all retained Jobs, all blocked incidents, all connections and all Agents, then issued per-Agent lookups. An unrelated scope notification could request the same global survey. Shared-worker release rediscovered all recovery candidates again.

## Work contract

`BackgroundWorkSlice` gives recovery and connection reconciliation a common target, estimated synchronous lookup, continuous-time and cooperative-yield budget. Estimates guard scheduling; scale tests trace actual SQL. State maintenance executes one domain slice at a time in the separate state process, with bounded rows and transaction lifetimes. A running Job can defer maintenance for 30 seconds, then a bounded slice proceeds without cancelling that Job.

| Internal task | Trigger | Input cardinality | Current bound | DB/CPU cost | Yield point | User-critical path impact |
| --- | --- | --- | --- | --- | --- | --- |
| Automatic recovery discovery and attempt revalidation | Changed Agent, due retry, 5-second fallback | 1 Agent by identity, up to 4 due Agents, or keyset page | 32 targets, 384 planned lookups, 25 ms continuous work, 4 attempts/tick | Indexed Agent, current thread, current connection and incident lookups; no global Job/blocked/connection hydration | Every 8 targets and each awaited attempt | Exact status/input/result and control can run between pages; side effects revalidate current Job, Agent version and connection revision |
| Work-history retention | Maintenance rotation | Archived terminal Jobs | 64 rows, 25 ms, durable `(updated_at, job_id)` cursor | Indexed candidate query; protected result checks only for visited rows | Next domain slice | Protected results remain; no full-history transaction |
| Event retention | Maintenance rotation and bounded per-Job insertion enforcement | Events past cursor, expired events, budget overflow | 64 rows per phase, 25 ms maintenance decision deadline; 64 overflow rows per insertion | Event cursor and per-Job indexes; diagnostic payload may be dropped under pressure | Next domain slice | No long global event sweep in the state owner |
| Job registry retention | Idle maintenance or admission headroom | Retained terminal Jobs | 64 inspected, 32 removed, 10 ms planning | In-memory iterator; exact version and durable protection recheck before archive | Next scheduler turn | Active Job/result protection remains authoritative |
| Dashboard and status projection | User read or mounted card refresh | Scope/page selection, maximum 200 runtime probes | Separate read-projection child; 8 concurrent runtime probes | WAL read and cached display probes, not state-owner discovery | Child IPC / probe await | Exact status is independent of background projection; card reads may still take their own time |
| Runtime problem inspection | Selected card problem recheck | Selected Agent/Job identity | One selected revision and bounded probe pool | Exact Agent/thread lookup and current observation | Upstream await | Version/revision check prevents stale result from changing another Job |
| Thread connection release eligibility | Explicit handoff or 30-second timer | Indexed handoff and idle-due lanes | 16 from each lane, 32 total, 192 planned lookups, 25 ms continuous work | Exact unfinished-work and revision checks; shared worker peers limited to 32 | Every 8 targets and release await | No full connection scan per tick; unsafe peers cannot be released |
| Recovery, question and command-receipt retention | Maintenance rotation | Old records/expired questions/maintenance receipts | 64 per relevant domain query | Indexed cutoff or exact reference checks; unresolved attempt budgets retained | Next domain slice | No deletion of live or blocked authority solely to make capacity |
| SQL/operation observation | Synchronous state read or transaction phase | SQL statements in one synchronous read span | One start, one serialization and one clear IPC per span; no IPC per statement | Class-only observation; no SQL text in IPC | Microtask after synchronous stack | Observation loss cannot cancel or change operational work |
| Telemetry delivery | Diagnostic records and sampled measurements | Bounded queue | 4,096 entries, 16 MiB; excess drops with counters | Separate telemetry child and DB | Async child acknowledgement | Telemetry remains disposable and cannot decide Job state or lifetime |
| State-owner readiness and health | Startup/250 ms heartbeat | Owner and child processes | One heartbeat snapshot per interval; request lifetime remains separate | No historical recovery survey in heartbeat | Timer turn | Stale observation alone does not terminate an active request |

A one-time, indexed ID-only iterator protects previously detached threads from implicit resume before admitting work. That safety pass is not a periodic reconciliation, does not retain an all-record array, and does not inspect each connection's history or eligibility. Existing Job hydration at startup remains the registry's exact-result authority; the formerly unbounded per-Job retention classification is now a first 32-Job slice followed by ordinary maintenance.

## Scale characterization

Run `NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx scripts/issue-193-work-budget-benchmark.ts` in isolated source checkouts. The fixture creates 1,200 Agents, 1,200 retained Jobs, 1,200 connection records and 600 blocked recovery records. It performs one warm-up tick, collects garbage, then measures the next tick while queuing exact status, input and result SQL reads plus a 5 ms timer. The baseline callback mirrors the former global candidate discovery; the updated callback uses exact per-Agent access. This is a controller-level characterization, not an operating-app latency guarantee. Five runs per checkout on 2026-09-28 report medians; raw output contains only synthetic identifiers and counts.

| Measure | `origin/dev` before | Issue #193 branch after |
| --- | ---: | ---: |
| Agents visited in one tick | 1,200 | 31 |
| SQL statements in the tick and exact reads | 2,410 | 161 |
| Rows materialized by discovery | 10,800 | 78 |
| Sweep wall time | 51.0 ms | 4.0 ms |
| Queued exact status/input/result completion | 65.0 ms | 1.9 ms |
| 5 ms timer lateness (heartbeat proxy) | 46.1 ms | 0.3 ms |

The row count is application-hydrated rows, not SQLite internal page scans. Exact-read latency includes event-loop queue time and three indexed synthetic reads. The benchmark does not extrapolate a fixed latency bound for a busy user machine or ChatGPT transport.

## Safety and regression proof

The tests cover 1,200-Agent no-op reconciliation, eventual reach of a late incident, due-retry priority outside the current page, attempt/backoff persistence across restart, 20 simultaneous Jobs with 600 progress notifications, shared-worker release revalidation, protected history rotation, indexed startup protection and schema 28→29 upgrade. The final local suite passed 948 tests; the macOS suite passed 212 tests with 2 skipped; MCP conformance passed 29/29. The isolated #137, #138, #142, #185, #186 and #189 regressions passed. The #142 lock test previously expected an unconfirmed response even though its 3.2-second lock is shorter than the current 5-second SQLite busy timeout; that stale expectation also failed on the unmodified `dev` baseline. The updated test requires a confirmed response and the exact committed revision after lock release.

The #193 benchmark exercises recovery alongside queued exact reads and an event-loop timer. A separate 1,200-Agent test places recovery, event retention, Dashboard selection, exact result/input reads and durable cancellation admission in the same event loop, then verifies that the foreground work runs before the 32-Agent page completes. The #142 isolation regression exercises Dashboard and state reads during a locked state command; #186 exercises input, steer and cancel during degraded observation; #189 exercises controls during saturated execution retention. These fault scenarios do not claim an operating-app latency guarantee for every combination. No timeout or capacity setting was increased; no active executor or Job is killed to reduce background work.
