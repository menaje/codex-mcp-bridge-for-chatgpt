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

## T1 decision

Direct observations and remaining uncertainty are now separated:

- Confirmed: one Bridge event loop currently serves HTTP, companion health,
  synchronous SQLite, maintenance timers, serialization, and allocation work.
- Confirmed: that event loop repeatedly misses the native two-second deadline in
  the installed multi-Job runtime and the misses coincide with real Tunnel 502
  connection resets in the retained window.
- Confirmed: an isolated SQLite wait is sufficient to reproduce the coupled
  health failure and no-restart recovery.
- Unconfirmed: the exact SQL, lock owner, allocation source, or maintenance
  slice responsible for each operating stall.
- Unconfirmed: that a second database file without execution isolation would
  improve response availability.

T1 therefore supports proceeding to #142 with execution isolation as the first
architectural boundary. File separation remains a later data-ownership and fault
containment step, not the first implementation step.
