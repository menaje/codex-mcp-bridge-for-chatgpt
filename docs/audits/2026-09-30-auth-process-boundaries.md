# Sep 30 authentication process and transport boundaries

This follow-up addresses the API-login deadline defect and the remaining
separate-process Helper and execution-transport checks in draft PR #211.
At this follow-up's original checkpoint, the operating app remained source `f6b98c4`, build
`f6b98c46724d:f344f196e4a6`, with its already applied Bridge-owned ChatGPT
profile and the changes described here had not been installed. See the
[installed app checkpoint](2026-09-30-local-rpc-errors.md) for that separate
artifact's evidence. PR #211 remains draft and unmerged into `dev`.

The subsequent, separately approved Sep 30 replacement installed source
`238dcc2`, including these accepted process/transport corrections and the
current-API scope cleanup. The operating app/Helper/Bridge now report
`238dcc2f7609:aac9a831bcdb`, with the same profile and all 13 retained results
preserved. The [current installation record](2026-09-30-current-api-auth-scope.md#authorized-installation-acceptance)
contains the 18:47 KST authenticated-read and identity evidence. Earlier
uninstalled `21c31e8` candidate checkpoints below are historical; natural
refresh, broader supported-mode/UI acceptance and `dev` integration remain open.

## API login needs exit evidence

The previous `setApiKey()` deadline sent a termination signal and resolved the
RPC as failed. Its completion handler then removed the child registry entry
and changed the candidate to the reusable `login-failed` state. A child that
ignored the signal could still write credentials while a retry began.

Two new regression tests failed against that behavior with a real synthetic
CLI process that ignored `SIGTERM`. The deadline was triggered under test
control; the PID remained alive while the candidate had become `login-failed`.
The tests pass after the correction.

The new monitor separates the RPC reply from the writer's lifetime:

| Observation | Persisted candidate and retry behavior |
| --- | --- |
| Successful exit without a stop request | `login-completed`; selected-CLI verification is still required |
| Failed exit or proven failure to spawn | `login-failed`; retry can begin after the writer is gone |
| Deadline, missing/failed stdin, or error after spawn with a live PID | Request `SIGTERM`, retain the writer, persist `login-unconfirmed`, block retry and verification |
| Exit after a stop request, including exit code zero | Record `login-failed` only after exit is observed; do not treat the interrupted flow as success |
| Cancel unresolved candidate | Quarantine its retained profile and allocate a different home for the next candidate |

Only the terminal observer owns the API login's final state update and child
registry cleanup. It checks the exact child, candidate ID, and unresolved
status before changing state. A late completion cannot update a newer
candidate. Failure to persist an uncertainty marker leaves `login-started`,
which also blocks reuse. No credential file is restored or deleted.

The manager suite also tests missing stdin, an asynchronous stdin error, and
a process error after spawn. Successful signal delivery does not clear the
block; an explicit exit event does. Existing missing-executable and successful
stdin-login cases remain covered.

## Separate operating-system Helper processes

`test/authHelperProcess.test.ts` launches the actual `src/macosHelper.ts`
entrypoint in separate Node processes with private local sockets, temporary
runtime homes and synthetic CLI credentials. Managed Bridge and Tunnel
autostart are disabled. Neither test touches operating authentication.

1. Helper A launches a browser-login writer. Helper B starts with a different
   PID and the same selection store, rejects verification of A's unresolved
   login, cancels and quarantines it, then completes its own API candidate in
   a different home. A's late exit callback runs; the persisted selection, B's
   auth bytes, and the synthetic shared auth bytes remain unchanged.
2. A real 30-second API deadline expires while its writer ignores `SIGTERM`.
   Only the test Helper A is killed to simulate a crash. Helper B starts at
   the same socket path with a fresh registry and preserves the unresolved
   block. After cancellation and creation of B's candidate, A's surviving
   writer finishes in its own profile. B's state and credentials and the
   synthetic shared store remain unchanged.

PID and parent-PID observations establish that the writer belongs to the old
Helper and survives the tested deadline/crash. Test output is checked for the
synthetic key values. This is real Helper-process evidence with a fake Codex
CLI; it does not establish real-account failure recovery or token refresh.

## HTTP Job, retained request, result and ACK

Two `test/tools.test.ts` cases use the production `createExecutionRuntime()`
with process isolation, the real execution owner and local socket transport,
HTTP MCP admission, and SQLite Job/session persistence. The selected Codex
process is the synthetic App Server fixture. Fault injection is confined to
test-side send and receive callbacks.

- One admitted request is withheld before delivery, then the temporary auth
  file changes from user A to user B. Reconnection retransmits the exact
  retained Job request and arguments.
- Another A turn is already assigned when the auth file changes. Its completed
  result response is dropped; reconnection recovers that same response.
- In both cases, a new B task is rejected with `CODEX_AUTH_CHANGED` before a
  new Job or turn is created. The original result and session remain under A.
- Each case drops the first ACK, drops an ACK reply, and disconnects on a
  later reply. Every retry targets the same Job ID and execution generation.
  Every ACK follows a committed terminal Job under the original owner.
- The execution-owner PID and generation remain unchanged; the assigned
  worker/thread/turn remain unchanged for the already assigned case. The
  fixture records exactly one `turn/start`, including after historical result
  retrieval, and pending ACKs eventually reach zero.

These cases establish product-path request/result/ACK identity and duplicate
execution prevention across an observed synthetic auth change. They do not
prove the operating CLI's credential-reload behavior, all authentication-mode
pairs, or real-account operation after refresh. Existing accepted/unknown
completion-receipt and lost-HTTP-response tests provide the distinct
conversation-delivery boundary.

## Source validation

Source commit `21c31e8b4e2ff232d782cff76e038c4a85f47870` passed `npm run check`: build, TypeScript,
release/localization checks and **1,087/1,087 Node tests in 111 files** with
four workers (200.66 seconds). This includes the 33-case manager suite, both
separate Helper-process cases, and both compound HTTP/transport cases.
The App Server schema check also passed against the existing isolated CI pin
`0.153.3` (416 JSON and 827 TypeScript files); the operating CLI was unchanged.
The committed clean source produced a separate arm64 macOS candidate:

| Artifact field | Evidence |
| --- | --- |
| Build ID | `21c31e8b4e2f:e37052f0d3b5` |
| Embedded commit | `21c31e8b4e2ff232d782cff76e038c4a85f47870` |
| Embedded dirty flag | `false` |
| Source hash | `e37052f0d3b5ea83bf5519c2295f79e122610b306c2124c7f4705ea741711321` |
| Swift validation | 217 strict tests, two skipped, zero failures |
| Localization | 1,403 macOS strings across nine languages |
| Signature | Ad-hoc signing; deep strict verification passed after moving the bundle |
| Retained path | `macos/build/candidates/21c31e8/Codex MCP Bridge for ChatGPT.app` |
| Installation | **Not installed**; the operating app remains `f6b98c4` |

At Sep 30 15:31 KST, a read-only operating check confirmed matching
`f6b98c46724d:f344f196e4a6` Helper/Bridge identities, connected Bridge/Tunnel,
and the same applied/effective ChatGPT profile and running home at generation
1. There was no pending activation or active/admission/input/background work.
All 13 original result/delivery hashes remained unchanged. Original desktop
usage remained readable; no Sep 30 desktop auth 401 was found. Shared and
profile auth-file modification times remained at their initial values, and
the profile login log exposed no corroborating refresh event. This establishes
current preservation, not success after token refresh.

The existing 15-minute heartbeat was found paused during this follow-up. The
operator explicitly authorized resuming the required natural-refresh check;
the existing heartbeat was reactivated. Its prompt requires event evidence
followed by authenticated Bridge and original-app requests, and explicitly
forbids periodic forced refresh and operational login/restart/installation.

## Accepted Sep 30 review

The reviewer accepted the API-login deadline correction in product source
`21c31e8b4e2ff232d782cff76e038c4a85f47870` and found no newly confirmed
defect in that reviewed correction. The separate OS Helper cases and the
compound request/result/ACK cases are also accepted as passing within the
synthetic Codex scope described above. They are not outstanding implementation
defects or missing product-path tests. ACK messages may be retransmitted;
the execution count and original result identity remain the tested invariants.

The reviewer supplied a separate eight-case exit-monitor exercise and reported
**8/8 passed**. It extracted the monitor into a temporary JSON persistence
harness, used Linux Node child processes and synthetic events, and invoked the
deadline callback under test control. Its cases include normal exit, a live
signal-ignoring writer, late completion after candidate replacement, missing
stdin, stdin/process errors, uncertainty persistence failure and spawn failure.
This is reviewer-reported evidence; the attached external files were not run
or imported into this Mac workspace. It does not rerun the full repository,
separate Helper tests, Swift suite, app signing or CI. The review reported
zero GitHub Check Runs for the product source; the full-suite and bundle
results above remain local validation records.

Source acceptance does not establish deployment. The `21c31e8` bundle is still
uninstalled, and the healthy operating `f6b98c4` app is preserved. Candidate
installation requires a separately approved procedure; this review does not
authorize an operating replacement, restart or new login.

## Selected operating CLI capability

During the Sep 30 review, the installed Helper reported the selected app CLI as
`0.159.0` at
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
The applied profile and generation remained unchanged. That executable then
generated its experimental JSON App Server schema using a temporary `HOME`
and `CODEX_HOME` with a minimal environment and no operating credentials.

The output contains **440 JSON files**, including `account/read`, but no
`account/sessions/list` method. This updates the earlier alpha-version probe
with the currently selected executable. It does not establish real Keyring
behavior or provide a stable Keyring ChatGPT user identity. Email and workspace
identity alone cannot distinguish users sharing a workspace. New execution
with unverifiable Keyring ownership stays blocked. The later approved
[current API scope correction](2026-09-30-current-api-auth-scope.md) excludes
Keyring and removes the hypothetical adapter and metadata display. That
decision resolves the earlier support-scope question. No CLI replacement, live login, credential
read or billed request was performed for this capability probe.

## Remaining acceptance

The installed app and monitor are preserved while these source checks run.
Actual token refresh must be evidenced by a refresh event, successful
authenticated requests afterward through the Bridge and original Codex app,
and no new sign-in requirement or authentication error. A 15-minute observation
interval or an auth-file modification time alone is insufficient.

The later current-API scope decision excludes Keyring and unprovided metadata.
Real supported account/mode combinations, broader
installed failure recovery and UI acceptance, and any separately authorized
billed API turn remain outstanding. No shared login, credential deletion or
restore, periodic forced refresh, operational restart, or new installation
was used to finish these tests.
