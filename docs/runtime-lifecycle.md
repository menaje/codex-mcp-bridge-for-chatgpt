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
same app instance does not submit another launch intent. A helper-only respawn
keeps completed stop/shutdown/mode-switch outcomes and terminal cancellation or
failure stopped. A fresh local app launch may start after an older completed
stop; remote client launches never request a local start. Setup and startup
failures continue to expose helper status and recovery controls.

A helper SIGTERM/SIGINT releases supervision while preserving the detached runtime, its active work, and pending reservations. The replacement helper adopts that runtime using the private lock owner and build identity. The app-managed launcher tolerates its old helper's diagnostic pipes closing; loss of a log reader does not terminate work. Application quit, mode changes and explicit force operations still stop the runtime through the coordinator before releasing the helper. The supervisor's opt-in `close({ runtime: "force-stop" })` is used for isolated test teardown, not the helper's signal handler. An OS-enforced runtime kill cannot be made graceful by this policy.

For application exit and mode changes, the app claims the handoff only after verifying the runtime is stopped. It then verifies helper shutdown, commits the connection mode when required, and writes a separate private `lifecycle-handoff.json` receipt. Intermediate `claimed` and `runtime-stopped` records let app re-entry finish a transaction interrupted between helper exit and preference persistence. Receipt file changes trigger reconciliation in both `handoff-ready` and `handing-off`, including a failed settings flush or final status request before acknowledgement. Failure records carry a stable category, not raw native error text, and let the user submit a new request. Failed external actions do not claim completion or trigger automatic force. Helper replacement retains the existing launchd rollback safeguards; the replacement build completes its reservation after the bridge and tunnel become ready.

The common native notice translates the failure cause and actual configuration rollback outcome, distinguishing a restored configuration from a failed restore or failed restart after restoration. Failure to restore job admission or configuration is terminal rather than an automatic retry against partially recovered state.

Restart and settings reservations continue while the app window is closed. Exit, mode switch and helper replacement can remain prepared until the native app is available to perform their final steps. The app displays waiting reasons and cancellation without treating a planned transition as a lost bridge connection.

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

The [2026-09-10 direct acceptance record](audits/2026-09-10-direct-acceptance.md) distinguishes real Codex work, the installed helper and Tunnel, and actual native controls from isolated fixtures. `npx tsx scripts/native-operational-acceptance.ts /tmp/bridge-live-acceptance --connect-installed` builds a separate window using production views against the installed service. Its controls affect that service; it does not replace or bootstrap the installed helper and is only for a controlled operator test. The default invocation continues to use synthetic socket data.

Runtime usage leases are written outside the enumerated lease directory and atomically published before acquisition returns. Concurrent status reads cannot observe a partially written lease. Corrupt published leases still stop unsafe activation.

A locally healthy Tunnel daemon and one past control-plane success do not prove current connectivity. The launcher requires a successful poll within 75 seconds, allowing two supported 30-second polls with 5-second guardrails and one monitor interval. The native app also observes the current network path, so a missing network immediately shows a connection check even while local IPC remains reachable. Longer outages use the existing operational-notification grace and recovery policy.
