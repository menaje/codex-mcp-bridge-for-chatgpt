# Runtime lifecycle reservations

Issue: [#79](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/79)

The macOS helper owns lifecycle intent independently of the requesting socket or app window. Native actions use `lifecycle.request` and receive a durable receipt; they do not keep the app globally busy until a running job finishes. Waiting reservations have no expiry. Actual admission fencing, process cleanup, startup and readiness checks remain bounded.

## Ownership and state

`RuntimeLifecycleCoordinator` serializes start, restart, stop, configuration/import, profile repair, application shutdown, local-to-remote mode changes and helper replacement. Its private `lifecycle.json` is beside the canonical launcher lock, including when an alternate dotenv is used. Writes are atomic, owner-only and outside registered project roots. Configuration credentials are not projected into RPC status and are removed from persisted terminal records.

The state sequence is `waiting` / `blocked` → `executing` → optionally `reconnecting` → `completed`. Waiting and blocked reservations are cancellable. A prepared external action instead enters `handoff-ready`, then `handing-off` when its owner accepts it. Acceptance is not completion.

The coordinator subscribes to companion change events. Events invalidate observations; a new runtime snapshot determines whether execution is safe. A five-second fallback covers missing events, older companions and reconnects. Its own long-poll socket is closed before process shutdown. A fresh final admission fence checks jobs, starting admissions, pending interactions, memory-only threads and background processes across every graceful path. A race at the fence restores admission, publishes the restored runtime state and retains the reservation for rechecking.

New requests freeze the CLI selection revision and command, configuration fingerprint, discovered setup contents and helper target build where applicable. CLI activation checks its target again under the CLI state lock. A changed target fails visibly instead of applying a different selection. Force remains an explicit request; elapsed waiting time never escalates it.

## Control protocol

The helper advertises `lifecycle.reservations.v1`.

| Method | Behavior |
| --- | --- |
| `lifecycle.request` | Accepts a UUID `requestId`, action `kind`, explicit `force`, and action-specific configuration/candidate/build target. Persists before returning. |
| `lifecycle.status` | Returns `{ operation }`, optionally for a specific `requestId`. Helper health/status also includes the latest operation. |
| `lifecycle.cancel` | Cancels the identified waiting, blocked or prepared reservation. A prepared handoff has already stopped the runtime; cancelling it does not start the runtime again. |
| `lifecycle.acknowledge` | Claims a prepared external action, moving it to `handing-off`. |

Identical IDs and payloads return the existing receipt. Reusing an ID for different content fails. Only one operation can be pending. A caller can explicitly replace a cancellable operation using `replacesRequestId`; otherwise it must cancel first. Execution and reconnection cannot be cancelled midway. Native retries after a lost receipt reuse the same ID and payload.

Existing synchronous RPC methods are compatibility adapters to this coordinator. They retain their explicitly bounded `timeoutMs` attempt contract. The current native lifecycle controls use reservations; only migration from a helper without the reservation protocol uses the old replacement preparation call.

## Recovery and external handoff

On helper re-entry, pending intent is reloaded. Executing operations are reconciled against the launcher PID and lock owner token, selected CLI and actual connection readiness. Reconciliation only observes state; any required helper-replacement activation returns to the coordinator, which checks cancellation/replacement and persists an uncancellable execution claim before starting a process. A recovered helper does not blindly repeat a completed restart. Recovery owns its launch even when it ends in cancellation or failure, so implicit startup cannot overwrite that result. Explicit stop/mode-switch outcomes suppress automatic startup; an explicit start creates new intent. Crash backoff checks pending lifecycle intent before restarting.

The native app submits one graceful `start` intent with `applicationLaunchAt` and
a stable request ID for each new app instance. This timestamp belongs only to
`start`; it cannot force or replace another operation. The helper first reconciles
an older shutdown receipt, then the coordinator serializes the launch intent with
other requests. A completed shutdown from the previous app instance permits the
new start. Pending operations, newer user commands, and cancellation or failure
during recovery take precedence; the reply can identify that existing operation
instead of creating a start. Regular lifecycle controls still return their own
request ID. Retrying an app launch uses the same ID and timestamp.

Opening the menu bar, refreshing status, or reconnecting the helper within the
same app instance does not create another launch intent. After a transport-only
lost receipt, a fresh helper observation permits at most two additional native
receipt submissions with the original request ID and timestamp. These are
receipt replays, not runtime attempts. User lifecycle actions fence late launch
responses and suppress those receipt submissions. A helper-only respawn
keeps completed stop/shutdown/mode-switch outcomes and terminal cancellation or
failure stopped. A fresh local app launch may start after an older completed
stop; remote client launches never request a local start. Setup and startup
failures continue to expose helper status and recovery controls.

A helper SIGTERM/SIGINT releases supervision while preserving the detached runtime, its active work, and pending reservations. The replacement helper adopts that runtime using the private lock owner and build identity. The app-managed launcher tolerates its old helper's diagnostic pipes closing; loss of a log reader does not terminate work. Application quit, mode changes and explicit force operations still stop the runtime through the coordinator before releasing the helper. The supervisor's opt-in `close({ runtime: "force-stop" })` is used for isolated test teardown, not the helper's signal handler. An OS-enforced runtime kill cannot be made graceful by this policy.

For application exit and mode changes, the app claims the handoff only after verifying the runtime is stopped. It then verifies helper shutdown, commits the connection mode when required, and writes a separate private `lifecycle-handoff.json` receipt. Intermediate `claimed` and `runtime-stopped` records let app re-entry finish a transaction interrupted between helper exit and preference persistence. Receipt file changes trigger reconciliation in both `handoff-ready` and `handing-off`, including a failed settings flush or final status request before acknowledgement. Failure records carry a stable category, not raw native error text, and let the user submit a new request. Failed external actions do not claim completion or trigger automatic force. Helper replacement retains the existing launchd rollback safeguards; the replacement build completes its reservation after the bridge and tunnel become ready.

The common native notice translates the failure cause and actual configuration rollback outcome, distinguishing a restored configuration from a failed restore or failed restart after restoration. Failure to restore job admission or configuration is terminal rather than an automatic retry against partially recovered state.

Restart and settings reservations continue while the app window is closed. Exit, mode switch and helper replacement can remain prepared until the native app is available to perform their final steps. The app displays waiting reasons and cancellation without treating a planned transition as a lost bridge connection.

## Bounded initial startup (Issue #246)

A configured initial application launch, or a helper launch proven to belong to
an initial/new OS boot, can recover a confirmed transient startup failure. A
loaded helper without a handshake is first observed for up to 150 seconds,
including each hello RPC and sleep. An absent handshake never authorizes helper
replacement. Permission/contract failures remain failures; confirmed incompatible
helpers still use the existing replacement reservation, ownership and rollback
path. Loaded definition changes also require a handshake before replacement.

The helper owns one private durable initial-start record. It consumes an attempt
and saves its unique owner token before spawning a launcher. There are at most
**three total attempts (one initial plus two retries)**. The record's request ID,
origin, target, attempts, backoff and absolute deadline survive helper re-entry;
a late app launch can only shorten that deadline. The app cannot renew it through
receipt replay. OS boot identity stays private and distinguishes initial boot
from KeepAlive re-entry after startup completed. A completed running instance is
adopted without creating another receipt; a same-boot runtime crash continues to
use the existing crash-window policy.

The initial-start budget is 300 seconds, anchored to the app's launch timestamp
or the initial helper intent. Seven seconds inside that budget are reserved for
a fresh protection read (up to two seconds) and owned process cleanup (up to
three seconds TERM plus two seconds KILL). The server-start deadline is therefore
the remaining overall deadline minus that reserve. Initial state-owner readiness
is capped at 75 seconds, local HTTP at 90 seconds, and Tunnel readiness at 60
seconds; each cap is the smaller of its stage allowance and remaining time.
Setup subprocesses in this scope also obey remaining time and retain smaller
existing command caps. A validated private IPC message can shorten an in-flight
deadline; it cannot increase it. No fresh whole budget is granted per attempt.
These values are development bounds, not measured reboot guarantees. Existing
migration/recovery, indefinite reservation waits, bounded legacy RPCs and ordinary
runtime crash limits are separate contracts; a known state migration is not
silently moved into this initial retry policy.

Only structured `STARTUP_STATE_TIMEOUT`, `STARTUP_HTTP_TIMEOUT` and
`STARTUP_TUNNEL_TIMEOUT` are retry candidates, and only after cleanup is confirmed.
A raw `RUNTIME_READINESS_EXITED`, text resembling a timeout, storage/authentication
failure, changed target, rollback/handoff failure, unknown ownership or incomplete
cleanup does not authorize retry. Fixed child storage categories are retained
alongside the failing stage and cleanup result. Before another spawn the helper
rechecks current CLI/configuration, exact lock ownership and the previous process
group. It releases only an exact stopped owner; it never removes another owner's
lock or signals an unconfirmed group.

Launcher exit alone does not prove its children have stopped. Initial-start exit
handling defers to this cleanup policy rather than ordinary crash group cleanup.
Any surviving attempt group first uses the existing `beginDrain` contract to
close admission and obtain a fresh protection snapshot including background
inspection. An idle read-only snapshot cannot authorize cleanup. Drain must be
acknowledged with admission closed, and exact ownership is checked after the
snapshot and again before each signal. Protected work, pending admission,
missing/unreachable protection or changed ownership preserves the group and
prevents another automatic spawn. On blocked cleanup, `cancelDrain` is attempted
within the same budget only for the exact owned service, including after a lost
drain response. An uncertain cancellation is retained in the failure cause;
admission restoration is not assumed.

Initial cleanup drain and cancellation requests carry the expected launcher PID,
owner token, original request ID, attempt and absolute deadline. The state-owner
binds its receiver identity once from the launcher's inherited context, not from
the current lock file or caller's observation. Validation and the existing Job
admission gate mutation execute synchronously in the same receiver boundary.
A replacement service rejects another runtime's expected identity before changing
admission; sender-side lock rechecks alone are not a solution to this race.
Cancellation additionally requires the owned drain (or records cancellation
before a delayed begin), preventing stale begin/cancel from undoing restoration
or reopening another operation's drain. A later ordinary beginDrain retires the
initial target and clears its ownership before closing admission, so a late
initial cancellation cannot reopen that ordinary stop/drain/force/handoff gate.
The ordinary operation's own cancellation remains available; a delayed initial
begin cannot revive after that cancellation. Without a later ordinary begin,
legacy cancel cannot reopen an owned initial cleanup fence. No public grant or
new admission queue is introduced. Executing user stop/cancel keeps its existing
rejection plus durable retry-suppression contract, rather than claiming to have
interrupted protected work.

Process-table inspection is capped at two seconds per call and by the remaining
absolute initial-start budget, including retry/re-entry cleanup and every
termination recheck. Deadline expiry, stalled/failed inspection, partial,
malformed or empty output never proves that cleanup completed. The inspection
subprocess alone is stopped on timeout; runtime signals require fresh inspection,
remaining time and the ownership guard. The 300-second budget is not renewed.

If the still-running attempt reports protected work, or its protection state
cannot be freshly confirmed, it is preserved and startup fails visibly for
review. A user stop/cancel can replace a cancellable initial retry backoff and
wins over later app receipt replay. Execution phases keep the existing
non-cancellable contract. A stop/cancel arriving during an executing initial
attempt still reports that it cannot interrupt that attempt, but durably disables
all later automatic attempts. If that attempt succeeds, Stop must be requested
again to stop it; the reply does not claim the server is already stopped. The
suppression survives helper re-entry and also prevents implicit crash restart
until a new explicit start intent. Preparing/retrying/final failure and attempt/elapsed
information are available in native status; final failures retain their stage.
Opt-in startup diagnostics use fixed stage/category names, elapsed/CPU time and
attempt counts, without credentials, settings values or raw authentication output.

This startup policy does not establish the cause of the operational 502 in
Issue #242. Installed reboot/login/network-delay acceptance remains separate
from source and isolated fixture validation.

## Verification

On macOS, `npm run build && npm run test:launchd-lifecycle` exercises the built
helper through a unique temporary launchd service using the production
KeepAlive, throttle and exit-grace settings. It checks a real 61-second wait,
cancellation, SIGKILL respawn, adoption of the same running process, one restart
after the completion event, graceful helper re-entry, and a transition between
two synthetic build identities. Shutdown/mode-switch receipt recovery must not
start another runtime. The script verifies removal of its service, processes,
sockets and lock. It never registers the installed app's service label.

Only launchd and the helper are real in that check: work admission, tunnel
readiness, bundle identity and the native caller's handoff receipt are fixtures.
The fixture refreshes launcher status as a live launcher does; stale status
must refuse adoption. This does not certify native buttons, saved connection
mode changes, real model continuity, physical sleep/wake or a network outage.

Tests cover a real 61-second running-job wait followed by an event-triggered restart, all seven destructive graceful paths with memory-only conversations, final admission races, duplicate and conflicting requests, cancellation races, CLI target fencing, missing events, helper recovery and crash-restart arbitration. Recovery tests also launch the actual helper entrypoint, send SIGTERM while work is active, restart it, verify adoption of the same launcher and completion of the original reservation, and verify shutdown completion after another re-entry. The production launcher is tested with its output readers disconnected while tunnel diagnostics are emitted. Native socket tests cover receipts, UI availability during waits, re-entry, cancellation, connection presentation, verified quit/mode handoff, pre-acknowledgement failure and retry, error categories, rollback copy, and replacement preparation. Native waiting and failure notices are rendered at popover width. All processes and configuration used for these checks are isolated from the installed user runtime; these checks do not claim that the installed app has been upgraded.

## Direct operating-service acceptance

The [2026-09-10 direct acceptance record](audits/2026-09-10-direct-acceptance.md) distinguishes real Codex work, the installed helper and Tunnel, and actual native controls from isolated fixtures. `npx tsx scripts/native-operational-acceptance.ts /tmp/bridge-live-acceptance --connect-installed` builds a separate window using production views against the installed service. Its controls affect that service, and opening it uses the production AppModel startup request. It does not replace or bootstrap the installed helper and is only for a controlled operator test. The default invocation continues to use synthetic socket data.

Runtime usage leases are written outside the enumerated lease directory and atomically published before acquisition returns. Concurrent status reads cannot observe a partially written lease. Corrupt published leases still stop unsafe activation.

A locally healthy Tunnel daemon and one past control-plane success do not prove current connectivity. The launcher requires a successful poll within 75 seconds, allowing two supported 30-second polls with 5-second guardrails and one monitor interval. The native app also observes the current network path, so a missing network immediately shows a connection check even while local IPC remains reachable. Longer outages use the existing operational-notification grace and recovery policy.

The managed Tunnel daemon inherits a private file-creation mask on POSIX hosts.
Its PID locator remains current-user-only even when `tunnel-client` requests
mode `0644`; readiness still rejects permissive, foreign-owned or symlinked
locators. The launcher restores its own mask immediately after spawning the
daemon, including when spawning throws.

Set `CODEX_MCP_BRIDGE_STARTUP_DIAGNOSTICS=1` in the private runtime environment
for a controlled restart to diagnose startup delays. Helper runtime logs then
contain `[bridge-startup]` records for launcher, server, runtime-parent and
state-owner stages. `elapsedMs` measures time since each Node process started
(including import time); `stepMs` measures time since that role's previous
record. Cumulative `cpuUserMs` and `cpuSystemMs` help distinguish CPU work from
elapsed waits. Records contain only fixed role/stage names, PID and timings,
with no configuration values or paths. Diagnostics are disabled by default;
remove the flag after collecting evidence. The runtime's 20-second startup
deadline is unchanged.
