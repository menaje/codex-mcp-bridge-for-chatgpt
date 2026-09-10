# Direct acceptance and issue scope · 2026-09-10

This follow-up uses actual ChatGPT, actual Codex work, the installed helper and
Tunnel, real launchd process recovery, physical Wi-Fi changes, and native
production views. It extends the [earlier review](2026-09-10-non-release-issue-completion.md)
and records failures as well as passes. The [sanitized evidence](2026-09-10-direct-acceptance.json)
contains outcomes without private request IDs, conversation links or credentials.

## Scope and builds

The user removed iOS and the separate device-matrix gate: #9 is closed as
`not planned`, with its useful evaluation history retained. The user also removed
VoiceOver from #15; actual notification arrival and click routing remain its
acceptance condition. The distinct #44 VoiceOver item was not silently waived.
Release issues #11, #52 and #53 remain outside this work.

The direct operating tests used the existing version 0.3.0 app, build
`535e264da4ca:38cb8ce3a4d3`, on macOS 26.6.2 (25G83). The source changes in this
review start from `535e264da4ca`. Separate acceptance applications compile the
production Swift views and model from the working source. They are identified
below where their source differs from the installed app. This task did not
replace the installed app; version and release stage remain unchanged.

The app-start defect observed during acceptance is handled by the concurrent
[#89 implementation, merged PR #90](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/90).
Its explicit per-app launch request distinguishes reopening the app from a
helper-only respawn. An initial overlapping helper-only startup change and its
test were removed from this change to preserve that distinction. This review's
product changes are the four fixes below.

After these direct tests, the separate #89 task installed
`917363a4a745:6f0b979b4158` and recorded actual graceful app shutdown and automatic
server/Tunnel startup after reopening at 10:05 and 10:07 KST. Its
[installed-app evidence](2026-09-10-issue-89-menubar-startup.md#installed-application-and-real-tunnel)
is reused for that portion of L79-2. It does not turn the earlier build's tests
into observations of this review's four new fixes.

## Actual operating lifecycle

An owned empty project ran synthetic canary Jobs whose only work was a bounded
wait followed by a known marker. Existing user Jobs and their configuration were
not used as test inputs. The successful service test ran from
`2026-09-10T00:11:29.720Z` to `00:14:59.029Z` and passed six checks:

1. A real running Job and its restart reservation survived 61,007 milliseconds.
2. Cancelling the reservation preserved the same running Job and runtime.
3. SIGKILL of the actual installed helper caused launchd to respawn it; the new
   helper adopted the same runtime process, running Job and pending reservation.
4. That Job completed once, then the reservation restarted and reconnected the
   real bridge and Tunnel without an additional request.
5. The original request still identified one Job after restart.
6. Final admission and interaction counts returned to zero.

A result read during reconnection returned HTTP 504. Retrying only the read
after readiness returned the expected marker in about 1.4 seconds. The Job was
not submitted again. This is successful state recovery, not uninterrupted
transport availability.

The first attempt stopped at a harness assertion: it accepted only `waiting`,
although the active bounded shell wait correctly produced `blocked`. The fixture
now accepts both protected pending phases. Its reservation was cancelled and
its Job completed. Two attempted follow-ups failed admission with
`MODEL_SELECTION_REQUIRED` and `PROJECT_REQUIRED`; neither created another Job.
Those attempts are not counted as service-test passes.

## Actual native controls

The `--connect-installed` acceptance app uses the production Dashboard and
AppModel against the installed service. Its bootstrapper does not replace or
start the helper, and it suppresses duplicate system notifications. Its server
controls deliberately operate on the real service. App-exit acceptance is not
provided by this fixture.

In that native window, choosing **restart after work completes** displayed the
restart reservation, cancel button, and no-wait-time-limit explanation. At
62,301 milliseconds the same reservation was still blocked on work and the
runtime process was unchanged. Clicking cancel removed the reservation banner
while the running count remained one. The helper confirmed `cancelled`.

A second reservation failed with `CODEX_LEASE_INVALID`. After the Job completed
once, the failure view offered a fresh request. A native retry after confirming
idle state completed, changed the runtime PID and returned bridge/Tunnel to
connected. The final native view showed zero running Jobs. The lease publication
fix below addresses a deterministically reproduced race consistent with that
failure; the live error alone does not prove its exclusive cause.

Together, the service and native observations complete L79-1. Helper crash and
adoption are directly observed. Actual app quit/mode preference transactions,
the full failure-to-safe-mode flow, and installed app replacement are separate
conditions, not inferred from this window.

## Physical network observations and fixes

Wi-Fi was turned off and restored three times, with automatic restoration in
the test's cleanup path. The 30-second baseline confirmed physical interface
power-off, absence of the default route, and a failed ChatGPT connectivity probe
(DNS failure, curl exit 6). The installed helper continued to report both bridge
and Tunnel connected during the outage. The local bridge socket remained
reachable; that is not evidence of external connectivity.

The supported Tunnel client 0.0.12 health command's successful-control-plane
requirement accepts a past successful poll. The launcher now additionally
requires an affirmative poll with a finite timestamp no older than 75 seconds.
This permits two 30-second polls with five-second guardrails and one monitor
interval. Missing, malformed, old, or implausibly future evidence is degraded.
The launcher integration test covers an exit-zero but stale poll followed by a
fresh poll, restoring readiness with the same launcher PID.

The production native model also records `NWPathMonitor` availability instead
of discarding it. Missing networking immediately shows connection checking even
if local IPC and the helper's previous Tunnel status remain healthy. The existing
grace period controls later operational attention. An intentionally stopped
local server remains stopped rather than appearing to reconnect.

The updated native acceptance app was tested during a further physical outage.
Its non-private model journal recorded network unavailable plus **Codex 브리지
상태 확인 중** at `00:55:43Z` while local IPC remained connected. The network became
available at `00:55:59Z` and normal at `00:56:05Z`. Computer Use observed the normal
view after recovery; its snapshot returned too late to capture the offline view.
This is a real live-model transition, not an offline screenshot claim.

All three tests restored Wi-Fi and real bridge/Tunnel readiness and preserved
the runtime PID. The new native behavior was exercised directly. The new
75-second launcher rule was verified with real launcher integration and
controlled Tunnel responses; it was not installed and held offline for that
duration. Long-outage system notification delivery and physical sleep/wake
remain unverified.

## Notification permission and native appearance

Inspection during the actual notification attempt found that the system
delivery class inherited a boolean permission fallback. A first installation's
`notDetermined` was therefore treated as `denied`, skipping the initial prompt.
The implementation now preserves the operating system's permission states and
passes only the Sendable enum across the callback/actor boundary. The regression
checks not-determined, denied, authorized and provisional mapping; existing
permission-policy and notification-routing tests remain in place.

The separate real native notification fixture still received
`UNErrorDomain Code=1` (notifications not allowed) on its actual authorization
attempt. No delivered notification or click is claimed. Its normal, transient,
authentication-problem and light/dark views were observed, and the problem
action opened Settings with the Codex page selected. That fixture supplies only
partial Settings data, so its Settings loading errors are not counted as product
failures. Full keyboard traversal was not established.

## Atomic runtime leases

A lease was previously written directly to the directory that independent
status readers enumerate. The regression deliberately pauses that write after
the empty file exists: before the fix, a concurrent snapshot fails with
`CODEX_LEASE_INVALID`. The write now completes in a private temporary file
outside the enumerated directory and is renamed atomically into place. The
acquisition lock and fail-closed handling of corrupt published leases remain.
Both complete-publication and corrupt-record tests pass. This regression proves
the race independently of the native observation described above.

## Actual ChatGPT question flow and private drafts

After refreshing the actual ChatGPT connection, the visible question card used
the installed `afdc0d76ab49` resource. Selecting Green and entering a synthetic
memo, then reloading the full conversation, lost both values. Thus the earlier
session-storage fix was insufficient in the actual host despite its local pass.

Reselecting and submitting those values resumed GPT. Without another user
message, GPT called `codex_user_answer` and returned Green plus the exact memo.
A separate cancellation likewise resumed GPT and read `cancelled` with no
answer. These fresh successful reads are distinct from earlier tests that
needed an explicit follow-up. No pending test question remains.

The revised renderer stores unsubmitted values in ChatGPT's UI-only
`widgetState.privateContent`, with browser-session fallback and in-memory
operation when both mechanisms are unavailable. Its state has empty
`modelContent` and no image IDs; drafts are not sent as tool input, output or
model context. The official [ChatGPT UI state documentation](https://developers.openai.com/plugins/build/chatgpt-ui#manage-state)
defines the private state channel and synchronous `setWidgetState` call.

Restoration follows an authorized question read and validates question, scope,
revision, expiry, field shape and value bounds. Submission, cancellation and
expiry clear the relevant draft. A browser regression disables iframe session
storage and persists only the host-owned private state across document reload;
it failed before the fix and now passes, including text/selection retention,
invalid question/scope/revision/expiry rejection and terminal cleanup. It checks
that the draft is absent from model-visible state and invokes no Codex operation.

The new current resource is `ui://codex-mcp-bridge/question/a93cf2f84a75.html`.
All 173 pre-existing resource revisions retain their URI, digest and metadata;
all 216 existing resource files retain their bytes. Other current card resources
are unchanged. This follow-up does not
claim actual ChatGPT reload success for this newly generated resource. Actual
host delivery-denied, unsupported and uncertain-handoff cases also remain open;
the nine-mode source/built browser passes use a simulated host.

## Verification

| Check | Result |
| --- | --- |
| Build and complete Node regression before removing the overlapping startup patch | 939 tests in 78 files passed with two workers, 198.38 seconds. |
| Strict macOS build and tests | 136 tests executed, 134 passed, two opt-in live tests skipped, zero failures; 718 strings in nine languages. |
| Lease red/green | One deterministic failure before the fix; both lease tests and the 71-test related selection passed after it. |
| Network-related Node regression | 11 tests passed across four selected files, including stale-success degradation and recovery in the real launcher. |
| Question-card browser | Nine source and nine built modes passed, including private host state; zero Codex calls. |
| Actual installed-service lifecycle | Six checks passed with actual work, launchd and Tunnel. |
| Final isolated launchd regression after startup deduplication | Nine checks passed from `2026-09-10T01:06:22.975Z`; real launchd/helper, synthetic work/Tunnel/exit receipts, installed runtime untouched. |
| Output contract and harness compilation | Committed output baseline matched; strict TypeScript compilation of the native acceptance builder passed. |

An earlier complete run passed 936 tests before the final lease/network additions.
A subsequent concurrent run passed 925 and timed out 11 tests (five-second test
timeouts) while other native and repository test work was active. The complete
two-worker run above then passed all 939. Resource contention is a plausible
explanation, not a proven assertion; no product/test timeout was relaxed.

## Remaining boundaries and cleanup

| Issue | Directly completed or corrected | Still open |
| --- | --- | --- |
| #9 | Closed `not planned`; iOS removed from active evaluation. | No separate device-matrix gate. |
| #15 | VoiceOver removed; initial permission handling fixed; actual permission refusal and in-app route observed. | Allowed system notification arrival, click destination and repeat/recovery observation. |
| #44 | Actual Wi-Fi loss/recovery and helper SIGKILL/adoption; native network-state fix and recovery presentation. | Sleep/wake, long-outage notification and safe-mode UI, full keyboard/VoiceOver and remaining final app screens. |
| #68 | Actual submit/cancel followed by automatic answer reads; private-draft fix and regressions. | New resource's actual-host reload; actual delivery denial, unsupported and uncertain delivery. |
| #79 | L79-1: real work beyond 60 seconds, native pending/cancel/retry, automatic restart and real reconnection. Separate #89 evidence also verifies actual app quit/reopen and automatic startup. | Remaining actual mode-switch/helper-replacement transactions in L79-2. |
| #80 | Earlier same-context round-trip evidence retained. | Native handoff control and clearing Codex's external-use warning. |

Computer Use rejected access to Codex, ChatGPT Desktop and Notification Center
with the stated reason "for safety reasons". Installed Bridge app selection timed out.
No alternate UI channel bypassed those restrictions. Actual native production
views were available through the separately identified acceptance app. A
privileged timed wake could not be scheduled; no physical sleep was attempted.

All owned canary Jobs completed and their three Agents were archived. The test
project registration and its empty directory were removed. The original four
projects and ordinary Bridge settings matched the initial values, except normal
revision/timestamp advances. Runtime counts for Jobs, admissions, interactions,
memory-only threads, background processes and unknown ownership were all zero.
The two acceptance apps were closed. The actual helper was deliberately
restarted for the tests but the installed app was not replaced. Raw private
identifiers and diagnostic contents are excluded from committed evidence.
