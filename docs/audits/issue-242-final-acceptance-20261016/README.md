# Issue #242: final installed acceptance

**The remaining acceptance evidence is complete. #242 can close under the user's
explicit current-nonrecurrence policy for historical HTTP 502.** Its direct cause
remains unconfirmed; [#262](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/262)
retains the evidence and reopens if the same failure recurs. No long soak or
arbitrarily shortened substitute was added. This record supersedes the remaining
acceptance statements in the earlier October 8/16 audits, preserving them as
historical observations.

This final change adds audit evidence only. The product corrections are already
integrated through [#243](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/243),
[#244](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/244),
[#245](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/245), and
[#265–#269](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/265).
[#264](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/264) is complete:
its erroneous recovery guidance was related to #242's read delay, and its installed
local recovery check is recorded separately below. #261's GPT relay is not used
as proof that these native completion-notification conditions passed.

## Identity and acceptance boundaries

The operational app stayed at **0.4.1 build 17**, build ID
`0d26c7f14353:41d00390ea3a`, during this protocol. The app/helper/runtime were not
restarted. [Identity](identity.json) preserves the exact source fingerprint and
public `dev` base. The installed local source includes an existing unpublished
relative-time/completion-label change; the whole installed tree is therefore
not identical to public `dev`. The eleven listed read/connection/completion
implementation files are blob-identical between them. The unrelated local work
was preserved and was not published by this task.

Existing source of evidence:

- [Independent contract verification](../issue-242-independent-20261008/README.md):
  read bounds/cancellation, event/lease/permission/failure contracts, regression
  preservation, and separate synthetic workloads.
- [Read-delay cause and same-condition controls](../issue-242-read-delay-cause-20261016/README.md):
  unnecessary public-event hydration and background scheduling, using frozen
  real data. Original Background: 7/10 timeouts; corrected Interactive: 10/10
  successful, 45–173 ms. The unchanged deadlines and controlled matrix establish
  causation; unrelated operating samples are not treated as a speedup ratio.
- [Installed build/read/menu acceptance](../issue-242-264-build17-20261016/README.md):
  20 summary/history reads, 10 exact details and 10 health checks successful;
  normal menu refresh and pagination; a guarded read-child pause preserves 24
  cards/panel/confirmed time; explicit Reload list recovers the same reader.
- [#264 correction and validation](../issue-264-recovery-20261016/README.md):
  first-load/remote/late-reply/exact-detail fixtures, bounded reads and action
  classification. The SIGPIPE finding concerns a test-fixture shutdown ordering
  race; it is not a historical operating 502 cause.

## Actual installed completion notification

At 14:37 KST on October 16, one explicitly identified acceptance Job was admitted
through the actual Bridge MCP tool in the registered repository project. Its
only instruction was to return a fixed marker, without tools, commands or file
changes. Exact original status returned that marker, a normal completed terminal
record and a completed Activity. Model selection followed the saved automatic
policy; the initial missing-selection rejection admitted no Job, and only one
Job was subsequently admitted. No timed-out Job was replaced or replayed.

The actual durable notify outbox gained **one row**. The installed native app
observed **one** `completion-outbox-ready` notice, made **one claim for one event**,
then **one successful `completion.delivered` call**, with **no release/retry**.
The row's attempt count is 1 and its delivery timestamp is **184 ms** after its
creation. The exact Job/Activity/outbox identifiers and raw MCP receipts remain
private; [the public receipt](completion.json) records their checked relationships.

The installed `SystemOperationalNotificationDelivery` calls
`UNUserNotificationCenter.add` and returns only after the OS success callback;
`CompletionNotifications` acknowledges only successfully accepted notifications.
Thus the recorded ack proves OS acceptance in the installed path, rather than
only a fixture callback. System Settings visibly showed notifications enabled,
including Desktop and Notification Center, temporary banners and sound. No
notification setting was changed. The user later reported that a notification
had arrived. The exact visible title was not independently captured; OS
acceptance, durable delivery and the user's report are distinguished.

The Job's terminal/result/Activity/outbox records were retained. The test did not
cancel, replay or modify existing Jobs. Automatic GPT relay policy is a separate
channel and is not being used as the native delivery proof.

## Operating timer/topic and method counts

A temporary same-UID `0600` Unix-socket observer forwarded bytes exactly once
without retries and saved only method names, approved topic names, booleans,
counts and elapsed times. A private fixture first checked fragmented responses,
request identity, no payload logging and original-inode restoration
([receipt](proxy-fixture.json)). All original socket inodes and permissions were
restored, all forwarded connections drained, and an independent watchdog needed
to replace no socket. Preexisting connections were counted only after natural
reconnection; these counts do not describe startup or all earlier activity.

The **180.050-second** bounded observation covered a readiness delivery, explicit
functional reads and one full existing 60-second post-delivery fallback interval.
The remaining long-poll responses drained by 201.308 seconds. The cap is a cleanup
bound, not a stability target. It neither replaces nor shortens a long-duration
acceptance test. [Every sanitized event](operating-rpc.jsonl),
[aggregate counts and phase boundaries](operating-rpc-summary.json).

| Captured method / observation | Count |
| --- | ---: |
| helper `helper.health` / forwarded bridge `runtime.health` | 29 / 29 |
| Natural app health polls after subtracting 10 explicit probe calls + 1 guard | 18 |
| helper / bridge `changes.wait` | 9 / 43 |
| Dashboard / settings / completion-ready topic notices | 36 / 1 / 1 |
| `completion.availability` | 4 (3 empty, 1 available) |
| `completion.claim` / `completion.delivered` / `completion.release` | 1 / 1 / 0 |
| Explicit Dashboard snapshot / exact detail reads | 20 / 10 |
| Successful captured RPC responses / requests | 148 / 148 |

The two health hops are one logical native poll. The completion-ready notice
preceded the native availability request by **130 ms**, consistent with the
existing 100 ms debounce plus scheduling/transport. After successful delivery,
the next empty availability response arrived **62.264 seconds** after its final
preflight, consistent with the 60-second recovery policy checked on health polls.
Normal Dashboard/settings notices and normal health traffic produced **no empty
claim**, including the actual Job's progress/terminal traffic. The earlier
[400-progress-event, 4-Job fixture](../issue-242-installed-acceptance-20261016/completion-counts.json)
remains the independent multi-Job and write-count proof; this operating run does
not pretend to be that synthetic workload.

## SQL timing, waiting and disk I/O

A separate **query-only** connection loaded the installed `BridgeStateStore`
against the operating SQLite database, without changing the original 5,000 ms
busy timeout. It recorded statement preparation/execution durations and statement
kinds, without SQL text, bindings or returned records.
[All statement measurements](operational-sql.json).

| Read-only store operation | Calls | SELECTs | Statement execution p95 / max | Changed rows |
| --- | ---: | ---: | ---: | ---: |
| Dashboard Job hydration (22 currently eligible rows) | 10 | 20 | 1.779 / 84.796 ms | 0 |
| Empty completion availability | 20 | 40 | 0.008542 / 0.195500 ms | 0 |

No statement failed. These durations include scheduling and any lock waiting;
exact lock-wait duration is not separately instrumented. This observer is not the
native read child or an operational writer transaction profile. Its filtered 22
Job hydration rows differ from the Dashboard's **734 retained executions** after
the new test Job and from the previous frozen 1,439-row database.

The actual operating read child was sampled at a requested 1 ms interval while
40 native read/health RPCs ran. All succeeded: summaries 62.194–270.484 ms,
history 72.450–86.131 ms, exact details 1.735–4.921 ms, health 1.077–2.985 ms
([summary](sampled-read-summary.json)). These instrumented timings are descriptive,
not a new controlled before/after benchmark.

The three-second active sample contains **2,480 main-thread samples**, including
294 inclusive `sqlite3_step` and 41 `pread` samples, with **zero observed SQLite
busy-sleep stacks**. A separate disposable database held an EXCLUSIVE writer
transaction while the same installed SQLite module's reader waited. The sampler
then detected **849 busy-callback/sleep samples**, and the query succeeded after
release at 1,392.996 ms. This positive control validates the wait detector without
locking or faulting the operating database. Inclusive stacks overlap, sample
intervals vary, and short waits can be missed; these are not exact wait durations
or independent statement counts. [Wait observations and control](sql-wait-observation.json).

`proc_pid_rusage(RUSAGE_INFO_V4)` snapshots captured actual **OS-accounted disk
bytes read/written**, separately from logical write bytes, for nine fixed existing
owned app/helper/runtime/reader/telemetry/tunnel processes.
[Per-process/window counters and limits](process-io.json).

| Mixed operating window | Seconds | Disk bytes read | Disk bytes written | Logical write bytes |
| --- | ---: | ---: | ---: | ---: |
| Quiet operation | 51.785 | 233,472 | 2,818,048 | 2,846,368 |
| Completion + model catalog | 49.309 | 5,644,288 | 5,287,936 | 5,154,320 |
| Sampled reads | 42.492 | 15,085,568 | 3,448,832 | 4,474,344 |
| Post-read + restoration | 34.785 | 1,036,288 | 1,359,872 | 2,232,784 |

These windows include normal status/telemetry/config/cache writes and exclude
separately spawned CLI processes and the observer. The final snapshot is about
eight seconds after socket restoration. Disk counters are not per-SQL or
per-notification attribution, and are not whole-device hardware measurements.
A read child's filesystem writes do not imply mutation of its query-only state
connection. WAL file-length deltas from earlier fixtures remain separate; they
are not physical writes/fsyncs or these OS counters. Normal durable writes remain
present even though empty completion checks perform no writes. The prior fixture
still supplies transaction/changed-row/lease/attempt/receipt write accounting.

## Mapping the 17 original completion conditions

“Contract fixtures” below means the independently verified automated scope,
complemented by the current installed observations where applicable. It does not
mean every destructive/failure variant was injected into the user's installation.

| # | Acceptance evidence |
| --- | --- |
| 1 | Frozen actual-data same-condition four-variant cause matrix, phased/synthetic percentiles and timeout rates; installed build 17 successful summary/history/detail samples and current instrumented 40-read check. |
| 2 | Independent indexed/batched query, counts/filter/order/pagination/revision/result-equivalence regressions; actual installed normal pagination and exact detail identity checks. |
| 3 | Coalescing A-cancel/B-survive, last-waiter cancellation, queue and active synchronous SQL capacity settlement fixtures; #264 rapid-refresh and late-response regressions. |
| 4 | Absolute queue/partial/no-response/native decode deadlines, cancellation/mismatch taxonomy and physical-capacity regressions; installed deadlines unchanged. |
| 5 | Helper probe/RPC retention, first failure, grace/recovery/stopped/target/generation/Settings/Skills fixtures; installed pause/reload preserves 24 cards, panel and time. |
| 6 | Pending A -> archive/delete -> same-cwd new B -> late A fixtures, exact management-ended contract; no stale resurrection. |
| 7 | Four-Job/400-progress fixture plus current operating 36 Dashboard notices/one settings notice; only one readiness event claims one notification, empty fallback preflight about 60 seconds. |
| 8 | Independent empty preflight/claim and atomic lost-race/denied-permission fixtures; current 20 query-only empty availability calls are SELECT-only with zero mutations. |
| 9 | Debounce/singleflight/10-item batch and failure/backoff/release fixtures; operating single readiness -> single claim/ack, zero releases/retry. |
| 10 | Stable-ID/ack-loss/restart/lease/retry/lost/duplicate/reordered/epoch/legacy/25-event backlog fixtures; current installed one-row OS delivery and durable attempt/ack. |
| 11 | Separate method/topic, SQL execution/preparation, transactions/changed rows/leases, WAL-length, sampled wait and OS disk/logical-write evidence above; no required durable records removed. Exact wait duration and per-SQL physical-I/O attribution are explicit limits, not fabricated zeroes. |
| 12 | 700 ms/3 s/health exit/daemon exit/stale poll/external failure/identity/freshness/wire/handoff fixtures; current operational health/connected tunnel and real MCP request/result path successful. |
| 13 | Event-live/hung-service liveness/watchdog/drain contract fixtures remain; observed 18 natural health polls during event availability and installed read-staleness/recovery. No production whole-runtime hang injection is claimed. |
| 14 | Observation faults preserve execution/result/owner and dedup fixtures; installed recovery did not cancel/replay Jobs, and the exact acceptance Job completed once. |
| 15 | User explicitly accepts historical 502 as provisionally resolved when no longer recurring; no recurrence during current functional checks, direct cause remains unknown, retained #262 reopens on recurrence. |
| 16 | Independent #143/#185/#191/#193/#200/#240/#241 map and current focused/native results preserved; no product code changes in this final audit. |
| 17 | Bundle/source/operating/fixture results distinguished. Build 17 strict native/bundle gate passed; current docs-only affected gate recorded below; original timeout/capacity/history/durability/liveness contracts preserved. |

## Validation and reproduction

The installed build's strict native/bundle gate executed **352 tests, 3 skipped,
zero failures**, and passed production compile/localization/dependency/signature
checks. The newer unfiltered Node gate had **2,046 passes, 8 failures, 1 skip**;
all eight failures were independently reproduced in the preceding baseline, as
recorded in the #264 audit. This final record does not recast it as a green full
Node gate. Current docs-only validation is in [validation.json](validation.json).

The path-parameterized reference templates are [the RPC observer](RPCObserver.py.txt),
[its separate watchdog](ObserverWatchdog.py.txt), [the disk counter probe](ProcessIO.c.txt)
and [the query-only SQL observer](SQLObserver.mjs.txt). They are not installed
product instrumentation. Set `ISSUE242_EVIDENCE_DIR` to a fresh private `0700`
directory; copy `.txt` sources to their corresponding executable-language names.
First run the RPC observer's `fixture` mode. For a live observation, confirm
correct runtime/socket ownership and no active Jobs/admissions, run the watchdog
and observer, and stop via `stop-observer`; preserve original inode checks and
connection draining. Build the C probe with `clang -Wall -Wextra -Werror` and take
same-PID snapshots. SQL observation always opens the state store `readOnly:true`;
never substitute a writer or inject a lock into the user's operating database.
The existing installed read probe is linked from the earlier build 17 audit.

[Private evidence hashes](private-evidence-receipt.json) bind exact MCP identities,
original observer sources, full OS samples and disposable lock-control artifacts.
The public templates parameterize private paths and omit unused CPU counters;
they are not represented as byte-identical executed sources. No raw prompts, model results,
credentials, task paths, SQL bindings, execution IDs or user screenshots are published.
[Public artifact hashes](artifact-sha256.json) bind all other files in this record.

After measurement, original sockets were restored and the same installed runtime
reported connected bridge/tunnel, reader ready, **zero active Jobs and zero pending
admissions**. No app/runtime restart or configuration/permission change was needed.
