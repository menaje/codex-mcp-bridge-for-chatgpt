# Sep 30 authentication process and transport boundaries

This follow-up addresses the API-login deadline defect and the remaining
separate-process Helper and execution-transport checks in draft PR #211.
The operating app remains source `f6b98c4`, build
`f6b98c46724d:f344f196e4a6`, with its already applied Bridge-owned ChatGPT
profile. The changes described here have not been installed. See the
[installed app checkpoint](2026-09-30-local-rpc-errors.md) for that separate
artifact's evidence. PR #211 remains draft and unmerged into `dev`.

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

The follow-up source tree passed `npm run check`: build, TypeScript,
release/localization checks and **1,087/1,087 Node tests in 111 files** with
four workers (200.66 seconds). This includes the 33-case manager suite, both
separate Helper-process cases, and both compound HTTP/transport cases.
The App Server schema check also passed against the existing isolated CI pin
`0.153.3` (416 JSON and 827 TypeScript files); the operating CLI was unchanged.
The subsequent clean macOS candidate and signature checks are recorded after
building the committed source. That candidate will remain uninstalled.

## Remaining acceptance

The installed app and monitor are preserved while these source checks run.
Actual token refresh must be evidenced by a refresh event, successful
authenticated requests afterward through the Bridge and original Codex app,
and no new sign-in requirement or authentication error. A 15-minute observation
interval or an auth-file modification time alone is insufficient.

Current CLI Keyring support scope, real account/mode combinations, broader
installed failure recovery and UI acceptance, and any separately authorized
billed API turn remain outstanding. No shared login, credential deletion or
restore, periodic forced refresh, operational restart, or new installation
was used to finish these tests.
