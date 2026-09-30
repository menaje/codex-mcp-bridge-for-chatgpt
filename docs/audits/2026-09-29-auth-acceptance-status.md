# Authentication issues #208 and #210: acceptance status

This is a checkpoint for the implementation based on `origin/dev` at
`031c193`. It is not evidence that either GitHub issue is complete. The issue
checkboxes require separate product and operational evidence; a green unit
test or a successful build cannot substitute for it. A separately authorized
replacement installed the `7116217` candidate on Sep 30, followed by the
idle-restart correction `a8dc7ec` and the native error-presentation correction
`f6b98c4`, then the separately authorized `238dcc2` replacement. Its shared-home
login guard, separate-profile flow, corrected restart guard and current-API
scope are now running in the operating app. The
[Sep 30 process-boundary follow-up](2026-09-30-auth-process-boundaries.md)
corrects the API-login timeout and adds separate Helper-process and compound
HTTP/execution-transport tests. That follow-up is included in installed source
`238dcc2`; the healthy operating connection now reports
`238dcc2f7609:aac9a831bcdb`.

The Sep 30 review accepts source `21c31e8`'s API-login exit correction and
the separate Helper-process and compound request/result/ACK tests as passing
within their documented synthetic scope. Those paths are no longer open
implementation defects or missing product-path tests. The reviewer also
reported eight passing isolated exit-monitor checks; that separate Linux
exercise is not a rerun of the repository, macOS bundle, or CI. The
[process-boundary follow-up](2026-09-30-auth-process-boundaries.md) records the
review and the distinction between source acceptance and installation.

A [Sep 30 read-only sign-out investigation](2026-09-30-codex-desktop-signout.md)
found four direct CLI browser-login starts followed within 9–28 seconds by
desktop authentication 401s. The old Bridge's shared-home login action is now
disabled in the installed candidate and first setup routes to separate profile
settings. The exact historical caller remains unknown.

## Sep 30 approved scope correction

The operator directed the Bridge to match current API capabilities: omit
unprovided account, workspace, usage and billing information from the UI,
and do not implement Keyring itself or a speculative identity method. The
subsequent go-ahead authorizes source/UI/docs cleanup and a new separately
built installation candidate. Operating replacement, paid execution, PR
merge and issue closure remain separate actions.

The [current API scope record](2026-09-30-current-api-auth-scope.md) supersedes
older optional-session and workspace-display claims below. Keyring and
API-unprovided metadata are **outside the approved release scope**, rather
than unfinished implementation. The latest source retains verified file
ChatGPT/API profiles and explicit API-key admission subject to effective
policy. Unknown Keyring/auto/ephemeral ownership stays blocked with an action
to select a supported connection. Internal owner checks remain private.
Previously accepted API-exit, separate Helper-process and request/result/ACK
paths remain accepted within their synthetic scope. Natural refresh and
broader installed real-mode/interaction acceptance remain open. The later
operator-approved alternative display check is complete as recorded below.

Current source `238dcc2` passed 1,085 Node tests in 111 files, the isolated
pinned-CLI schema check, dashboard browser checks and 27 isolated AppKit
renders. Its clean uninstalled arm64 candidate passed 216 strict Swift tests
(two skipped), 1,390 strings across nine languages and deep strict signature
verification, with build ID `238dcc2f7609:aac9a831bcdb`. It supersedes
`21c31e8` as the proposed installation target. The current scope audit records
its exact embedded identity and the Sep 30 17:49/17:52 KST read-only operating
checkpoint: installed `f6b98c4`, the same profile and all 13 original result
records stayed unchanged, both authenticated usage reads succeeded, and an
actual later refresh remains unestablished.

The subsequent source-scope review inspected product source `238dcc2`, its
changed tests, PR and audit HEAD `34b4cff`. It accepts this correction within
the approved scope, with no newly confirmed defect in the reviewed changes.
Authentication/policy protections, API billing consent and actual error
controls remain required; Keyring and API-unprovided metadata are excluded,
not unfinished requirements. The reviewer checked the author's local suite,
visual and signature records without rerunning the full suites, rechecking
the app file or querying the operating state/monitor; zero product-source
Check Runs were reported. This is source acceptance for the next separately
authorized installation step, not installation or merge approval. The
[review record](2026-09-30-current-api-auth-scope.md#accepted-source-scope-review)
preserves those evidence limits and the exact candidate identities.

## Sep 30 authorized current-source installation

The operator separately approved `238dcc2` installation at **18:34 KST**.
The production lifecycle completed a non-forced shutdown with idle checks and
confirmed process/socket exit. The staged candidate and installed replacement
passed exact embedded identity and deep strict signature checks; the previous
`f6b98c4` app remains preserved for rollback. By **18:42 KST**, app/Helper/Bridge
reported `238dcc2f7609:aac9a831bcdb`, with Bridge and Tunnel connected.

At **18:47 KST**, the same applied/effective ChatGPT profile, running home and
generation **1** remained confirmed, with no pending activation or active work.
All 13 original Job payload/delivery hashes were unchanged. Non-billed Bridge
and original desktop account/usage reads succeeded, both auth-file mtimes
remained unchanged and Sep 30 desktop auth 401s remained zero. No new login,
credential transfer, forced refresh or billed turn was performed. The
[installation record](2026-09-30-current-api-auth-scope.md#authorized-installation-acceptance)
preserves these evidence limits. Initial native computer-use inspection
timed out. The operator then requested alternative display verification at
**19:19 KST**. Seven unchanged production-view AppKit renders bound to real
installed Helper/Bridge snapshots were generated and manually inspected at
**19:31 KST**. Playwright inspected the installed dashboard HTML with a
read-only adapter to the installed Bridge, confirmed a real refresh/value/
timestamp at **19:37 KST**, and checked desktop plus 360-pixel light/dark
layouts. No fixture responses were substituted in those installed-data
checks; prior isolated renders retain supplied/missing API-state coverage.
The [display record](2026-09-30-current-api-auth-scope.md#installed-display-acceptance-with-approved-alternative-tools)
states the method, actual operational warnings and limits. The **19:41 KST**
checkpoint again confirmed the same profile, all 13 original results,
unchanged credential metadata and successful Bridge/desktop reads.

At **20:03 KST**, the operator ended the recurring observation after repeated
healthy checks. The existing 15-minute heartbeat is now **PAUSED**, with no
further periodic checks scheduled. Its final **19:58 KST** checkpoint retained
the same installed `238dcc2` build, profile/generation and all 13 original
results, with successful Bridge/desktop authenticated reads, zero desktop
auth 401s and unchanged credential/login-log metadata. An actual later natural
refresh remains unestablished; the observation stop does not mark it passed.
The [observation-stop record](2026-09-30-current-api-auth-scope.md#operator-ended-periodic-observation)
preserves this distinction. The operator subsequently accepted `dev`
integration using the existing review, local tests, exact-source installation
and installed-data display evidence. Remaining real-mode/policy/reconnect,
interaction and natural-refresh conditions are transferred to
[post-merge validation #218](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/218).
Their unverified status is preserved; they are no longer blanket prerequisites
for this PR's integration. Keyring and API-unprovided information remain out
of scope, and the heartbeat remains paused.

## Sep 30 installed, non-billed acceptance checkpoint

The first signed app and Helper reported build `7116217e9916:1fa30981c720`. Both
legacy shared-home login actions return `CODEX_SHARED_LOGIN_DISABLED`. The
operating shared auth file was last modified Sep 29 at 08:12:34 KST. A new
persistent Bridge-owned ChatGPT profile was prepared in a different
`CODEX_HOME`, signed in through the selected app CLI, and verified through its
account, policy, and model checks. Its own auth file was created Sep 30 at
12:23:13 KST; the shared auth file's modification time did not change. Codex
desktop logs for Sep 30 contained no `desktop_fetch_auth_401` through this
checkpoint. No billed API execution was requested.

The verified profile was staged for activation. A non-forced restart reservation
initially waited for active Bridge Jobs and protected memory-only threads.
After active Jobs reached zero, the persisted-work guard failed the restart
with `CODEX_AUTH_WORK_PENDING`. A read-only state inspection found 13 terminal
Jobs protected by `undelivered-chatgpt-result`: eight delivery records marked
`acceptance-unknown` and five marked `host-accepted`, all without an exact
completion-result offer. Their Job updates date from Sep 20–26. The Bridge
remained on the original shared connection; the verified separate profile and
pending choice stayed intact. No result was marked read or discarded. The
later refresh, actual activation, and original-app continuity after activation
were not yet verified. At that check the original desktop usage read succeeded,
the shared auth file still had its Sep 29 modification time, and the Sep 30
desktop log still had zero `desktop_fetch_auth_401` events.

The operator then authorized a forced restart and reported no ongoing work.
The Helper confirmed zero active Jobs and background processes. The installed
build rejects a forced restart while an auth change is staged, so the pending
request was temporarily cleared while retaining its verified candidate. A
forced restart of the shared connection completed with Bridge and Tunnel
connected; the same candidate was then staged again.

This inspection identified a guard defect: `retentionProtection()` describes
why an answer or delivery record must stay stored, but the Helper used every
such reason as evidence of unfinished execution. The source guard now checks
active Job states and pending input. Three Helper regressions verify idle
activation while preserving a user-held result or an unresolved accepted or
unknown completion delivery. Two HTTP MCP cases restart under a distinct user
and home, lose the first exact completion-result response, and recover the
same receipt and answer in the originating scope. The original owner and
delivery state are preserved. Cross-conversation access and request replay
are rejected; result reads invoke no execution recovery, upstream work, or
new-executor ACK.

The correction passed the full four-worker Node suite: **1,078/1,078 tests in
110 files**. Build, TypeScript, release checks, and localization passed. One
older runtime-adoption fixture was isolated from the operator's runtime and
state settings after its first run read the real staged authentication choice.

The clean `a8dc7ec` arm64 app was then built separately and ad-hoc signed.
Deep strict signature verification passed before and after installation. The
bundle build ran 215 strict Swift tests with two skipped and zero failures,
plus 1,400 macOS strings across nine languages. Embedded build identity is
`a8dc7ec29623:c7f8390b654f`, commit
`a8dc7ec296235407a63b59d39f4a80ba26d3158d`, `dirty: false`. The replaced
`7116217` app bundle was preserved for rollback.

With no active Jobs, admissions, input, or background processes, the old app
completed a non-forced shutdown. Its verified candidate was preserved, then
reverified and staged in the corrected app. A **non-forced restart completed**
and applied the separate Bridge-owned ChatGPT profile. At Sep 30 13:36 KST,
Helper and Bridge reported the new build; Bridge and Tunnel were connected.
Applied and effective selections and the running Codex home all matched the
profile, generation was 1, and no pending or uncertain activation remained.

Read-only record comparisons confirmed all 13 old terminal Job payloads and
delivery records were unchanged (five `host-accepted`, eight
`acceptance-unknown`). No result was marked read or discarded. The original
Codex desktop usage read still succeeded; its shared auth file remained at
Sep 29 08:12:34 KST, and Sep 30 desktop logs had zero
`desktop_fetch_auth_401`. Both legacy Helper login actions still rejected with
`CODEX_SHARED_LOGIN_DISABLED`. No billed API execution was sent. The profile
auth file remained at its initial Sep 30 12:23:13 KST modification time. At that
checkpoint, a later actual refresh remained unobserved and was tracked by the
existing heartbeat. These results establish the installed idle-restart
correction and separate-profile activation, not completion of all #208/#210
requirements.

The later `f6b98c4` replacement corrected native local-service error messages.
Its [installation record](2026-09-30-local-rpc-errors.md) confirms the same
applied profile and generation, matching Helper/Bridge build identities,
connected Bridge/Tunnel, and unchanged 13 retained Job payloads and delivery
records. Original desktop usage remained readable, both auth-file modification
times stayed at their initial values, and no Sep 30 desktop auth 401 was found
at that checkpoint. Actual refresh still had not been observed.

The process-boundary follow-up preserved this installation and monitor at
that checkpoint, before the later replacement and operator-ended observation.
Source `21c31e8` passes the full four-worker Node suite, 1,087/1,087 tests in
111 files, with build, TypeScript, release/localization and isolated pinned-CLI
schema checks. Its clean uninstalled arm64 bundle passed 217 strict Swift tests
(two skipped, zero failures), 1,403 strings across nine languages and deep strict
signature verification, with build ID `21c31e8b4e2f:e37052f0d3b5`. The manager
suite passes 33 cases, including two real-PID deadline regressions
and three non-terminal input/process-error cases. Two actual Helper-process
cases cover late browser-login completion and a real 30-second API deadline
with a surviving writer across Helper crash/replacement. Two HTTP MCP cases
use the real isolated execution owner and socket transport to recover queued
requests and completed responses across an observed synthetic auth change,
ACK/reply loss and reconnect. Each retains the original Job/session owner,
commits before ACK, and records exactly one turn. The Codex processes and
credentials in those tests are synthetic; real-account refresh and broader
installed acceptance remain separate.

## Follow-up implementation after PR checkpoint `c6cf380`

- Stable session and Job ownership now uses the selected auth source, Codex
  home, and proven account/workspace or credential owner. The CLI executable's
  file fingerprint remains an admission and cache input. An in-place CLI change
  during one Bridge process raises `CODEX_CLI_CHANGED`; a restarted Bridge must
  verify the selected CLI before continuing the same owner's work.
- Schema 30 persists each new session's non-secret auth boundary. Existing
  schema-29 rows acquire a null boundary and remain in history without being
  assigned to the current login or automatically resumed. The read-only state
  process receives the operational process's owner boundary, verification time,
  and observation kind over private IPC. A missing or changed owner hides the
  matching session in that projection; this IPC evidence never authorizes new
  execution. A last-confirmed file owner labels historical reads until a later
  operational observation changes it. Installed external-login notification
  and display freshness still need acceptance.
- On CLIs that provide experimental `account/read.workspaceRouting`, its
  `chatgptAccountId` identifies the selected ChatGPT workspace even when the
  separate usage lookup fails. If usage also supplies an account ID, they must
  agree. An account with neither ID remains unverified, and a managed Keyring
  API key still has no supported owner identity from this protocol.
- An earlier checkpoint added an optional `account/sessions/list` adapter,
  hypothetical active-session fixtures and conditional workspace-name display.
  Those paths are removed by the approved current-API scope correction. They
  are not current product support or evidence of a real Keyring login. The
  API's workspace routing remains an internal policy correlation and cannot
  substitute for the file token's user/workspace ownership proof. Workspace
  names and owner/workspace fingerprints are omitted from connection settings.
- App-bundled, terminal, and Bridge-managed CLI installations are separate
  executable choices. The synthetic product-path matrix installs all three at
  once and checks that login, account, model fallback, and execution use the
  selected executable while preserving the same explicit existing Codex home.
  A second matrix keeps a saved Bridge-owned login home across all three CLI
  choices without starting another login or changing the applied auth source.
  The authentication screen now names the selected executable next to the
  applied connection. Several executables pointing at one home are one
  existing credential source, not three different accounts. The user need not
  choose a folder for these known combinations: the Bridge uses its current
  shared home, an explicit operator override, or a saved Bridge-owned profile.
  Other existing credential homes that the Bridge has never been configured to
  use cannot be inferred from CLI executable locations.
- The Helper now remembers distinct external `CODEX_HOME` locations it has
  actually used, including an explicit location that is later removed from
  configuration. It records only absolute locations, stores no credential
  copy, and deduplicates aliases of the same directory. Setup/settings can
  stage a previously used location without
  a folder picker; the selected CLI probes its account, policy, models, and
  billing route again before activation. A moved or redirected location fails
  closed, and the ready runtime must report that exact home. Using the saved
  location retains the same session owner boundary as the earlier explicit
  override. Synthetic manager and Helper-status tests cover this path; real
  multi-home login and installed UI acceptance remain outstanding.
- The saved-profile matrix now also exercises Bridge-owned API key profiles
  with each of the three installed CLI choices. It checks selected executable,
  unchanged profile home, API authentication and billing route, model fallback,
  and a synthetic work start without a second login or ambient API key. The
  selected CLI's ChatGPT plan usage endpoint is exercised only for ChatGPT
  profiles; API cost remains unknown without a separate authorized cost
  source. This is synthetic product-path evidence, not a billed API call.
- The earlier blanket Keyring capability warning has been removed. It also
  appeared for supported file-backed shared login. A real attempt to choose an
  unverifiable connection now returns an actionable supported-connection
  error. Missing API fields produce no permanent warning or placeholder row.
- A synthetic HTTP MCP product-path test now starts a Job for user A, holds a
  real pending question in the Bridge, changes the external file login to user
  B, and checks original-worker outcomes. With exact live worker/turn proof,
  the answer reaches the original executor. Without proof, the Bridge records
  `not-delivered` and sends nothing; after proof returns, the identical request
  can answer the still-current question once. If the upstream receives an answer
  but its reply is lost, delivery remains `uncertain` and neither the same nor
  a new request resends it. The original result is then stored under A and its
  exact retained result is ACKed once. This does not
  replace the separate Bridge restart and real-account checks.
- A separate HTTP MCP cancellation case now holds A's original Job through an
  external A→B login change. Without exact live worker/turn proof, the public
  cancellation call is rejected and the Job keeps running. Once the original
  worker proof is available, the public call interrupts that one turn and the
  Job remains recorded under A. The upstream worker is synthetic, so a real
  process-group interruption and reconnect still need acceptance.
- An HTTP MCP restart case keeps A's admitted Job and SQLite state while the
  Bridge state owner is replaced. A restarted Bridge that confirms B leaves
  A's Job running in history and does not call execution recovery. After a
  second restart confirms A, the same Job ID recovers its retained result once,
  persists the session under A, and ACKs that Job once without starting a new
  task. The retained executor is synthetic; process reconnection and a supported external file-login change remain
  separate acceptance conditions. Keyring acceptance is outside this scope.
- A Helper lifecycle product-path test now continues after a failed activation:
  it records an uncertain result, confirms the launched runtime is stopped,
  keeps the prior applied connection and pending choice, restarts the prior
  runtime, and then applies the same pending choice once a healthy launcher is
  available. The prior stopped-unconfirmed event stays in the audit state.
  A second case uses distinct synthetic ChatGPT profiles A and B: it verifies
  each candidate through the selected fake CLI, applies A, fails B's launch,
  blocks startup until stopped-runtime reconciliation, confirms A's profile
  home after recovery, and applies the same verified B candidate on retry.
  The full Helper test file passed 53/53 and TypeScript type checking passed
  after this addition. Both cases use a synthetic launcher; installed runtime
  failure recovery remains.
- A simulated Helper replacement now starts a browser login in one manager
  instance, recreates the manager without its process registry, cancels the
  unresolved candidate, and prepares another profile. The old login's late
  exit callback leaves the new candidate untouched. Verification of the
  unresolved login is refused, and the cancelled profile is retained but
  unavailable for reuse while its writer may still exist. The same quarantine
  applies to an in-flight API-key login. The local settings view explains why
  that saved profile cannot be selected. This was an in-process replacement
  simulation; later separate Helper-process cases now pass in the
  [process-boundary follow-up](2026-09-30-auth-process-boundaries.md).
  Installed login failure behavior remains separate.
  After the guard and display change, the four-worker Node suite passed
  1,074/1,074 tests in 110 files, strict Swift passed 215 tests (2 skipped),
  TypeScript checking and the release check passed, and macOS localization
  validated 1,400 strings across nine languages.
- The installed CLI `0.158.0-alpha.2.1` generated its TypeScript App Server
  schema in a temporary home without authentication. It includes
  `account/read.workspaceRouting.chatgptAccountId` and a nullable usage
  `accountId`. A separately installed temporary CLI `0.153.3` passed the pinned
  schema reproducibility check (416 JSON and 827 TypeScript files). Neither is
  a real login test. Candidate artifact identity for each committed source is
  recorded in the PR description; the installed sequence and current
  `f6b98c4` bundle are recorded above.

## Acceptance classification

The categories below apply to the *remaining acceptance work*, not to whether
an entire issue can be closed. Multiple categories can apply to one condition.
"Synthetic product path passed" names a verified subset and does not cover
every scenario in that condition. A source review or isolated predicate test
alone is not marked as product-path evidence. The detailed rows below retain
the exact evidence and remaining scenarios.

| Condition | Classification | Specific remaining boundary |
| --- | --- | --- |
| LOGIN-1 | Read-only operating-log timeline found; attribution still needed | Four direct CLI login starts preceded desktop 401s. Identify the caller and affected build. |
| LOGIN-2 | Synthetic product path passed; live environment needed | No-copy build/probe paths were exercised; inspect the shipped package and external automation. |
| LOGIN-3 | Partial live | Persistent independent-profile sign-in, verification and non-forced activation passed; continuity after an actual natural refresh remains. |
| LOGIN-4 | Synthetic product path passed; live environment needed | Inspect actual selected source and managed-policy provenance. |
| LOGIN-5 | Synthetic product path passed; live environment needed; Keyring out of scope | Verify natural file refresh and supported external account changes. Keyring ownership is outside the approved scope. |
| LOGIN-6 | Live environment needed | Establish selected App Server reconnect behavior after external login without interrupting original work. |
| LOGIN-7 | Synthetic product path passed; live environment needed | Original Job question, cancel, result and restart subsets, plus queued-request/result loss and repeated ACK recovery through a real execution-owner process and sockets, passed. Broader installed-CLI and existing-thread combinations remain. |
| LOGIN-8 | Partial live | Installed `238dcc2` preserves the profile applied by `a8dc7ec`; non-forced activation and subsequent normal replacements retain all 13 terminal results and shared auth. A later actual refresh remains pending. |
| LOGIN-9 | Read-only operating-log error found; live acceptance needed | Desktop logged the signed-out-or-different-account refresh error. Verify the final candidate through a later refresh. |
| LOGIN-10 | Synthetic product path passed; source-scope review accepted; partial live; live environment needed | Source `238dcc2` passed local gates and authorized installation with exact identities, preserved profile/results and non-billed reads. The approved alternative installed-data display check passed. Natural refresh and broader installed interaction/mode acceptance remain; the historical timer failure cause stays unclassified. |
| LOGIN-11 | Live environment needed | Compare independent and shared-store multi-process refresh under separate authorization. |
| LOGIN-12 | Live environment needed | Confirm external changes without a file revision or `account/updated` in the installed CLI. |
| LOGIN-13 | Live environment needed | Verify real partial 401, usage/model failure, and turn behavior. |
| LOGIN-14 | Synthetic product path passed; live environment needed | Verify installed policy changes and running workers. |
| LOGIN-15 | Synthetic product path passed; live environment needed | Confirm installed effective-policy provenance and workspace restriction. |
| LOGIN-16 | Live environment needed | Compare original and selected CLI refresh behavior with documented upstream evidence. |
| AUTHSEL-1 | Synthetic product path passed; live environment needed | Exercise both same-user and different-user login in the installed app. |
| AUTHSEL-2 | Synthetic product path passed; live environment needed | Three executable/profile combinations passed synthetically; remote and billed paths remain. |
| AUTHSEL-3 | Synthetic product path passed; live environment needed; Keyring out of scope | Known file homes and saved profiles are selectable without a folder picker. Real multi-home acceptance remains; Keyring is excluded. |
| AUTHSEL-4 | Synthetic product path passed; live environment needed | Verified ChatGPT profile A→B activation failure/retry and separate OS Helper replacement/crash with late browser/API writers passed. Installed real-account failure recovery remains. |
| AUTHSEL-5 | Synthetic product path passed; partial live | The applied ChatGPT profile survived the authorized `a8dc7ec`→`f6b98c4`→`238dcc2` app replacements. Independent/API upgrades and real CLI replacement remain. |
| AUTHSEL-6 | Synthetic product path passed; live environment needed | A verified synthetic ChatGPT profile A→B failure/retry passes; other mode pairs, real account changes, and key rotation remain. |
| AUTHSEL-7 | Synthetic product path passed; live environment needed | Original-worker HTTP/restart paths and real isolated-execution request/result/ACK loss and reconnect passed with synthetic auth. Real CLI/authentication-mode reconnection remains. |
| AUTHSEL-8 | Synthetic product path passed; live environment needed | API exit confirmation, cancelled-writer quarantine, separate Helper crash/replacement and stopped-runtime activation retry passed. Broader real-account late callbacks and installed recovery remain. |
| AUTHSEL-9 | Synthetic product path passed; live environment needed | Verify actual credential-store logout and API-key removal. |
| AUTHSEL-10 | Synthetic product path passed; live environment needed | Real API execution and cost require separate approval. |
| AUTHSEL-11 | Installed-data display inspected; broader live environment needed | Current ChatGPT screens contain no raw credentials or internal fingerprints. Complete broader built-artifact and log inspection. |
| AUTHSEL-12 | Current-API display scope approved; installed-data display verified; broader live environment needed; unprovided metadata out of scope | Seven native production-view renders and the installed dashboard with real IPC data passed manual display checks, refresh and narrow light/dark layout. Unprovided names, unknown account rows/cards and internal fingerprints are omitted. Broader API/mode interaction acceptance remains. |
| AUTHSEL-13 | Synthetic product path passed; live environment needed; Keyring out of scope | Confirm installed managed policy for supported file/API sources; do not bypass required unsupported stores. |
| AUTHSEL-14 | Synthetic product path passed; live environment needed | Fixed-owner sessions and Job result paths passed; installed app resume, skills and settings combinations remain. |
| AUTHSEL-15 | Live environment needed | Verify existing independent/API installations and upgrades. |
| AUTHSEL-16 | Synthetic product path passed; source-scope review accepted; partial live; live environment needed | Installed `238dcc2` retains exact identities, the same profile and all 13 results. Approved alternative installed-data display checks passed. Current scope and prior API exit/Helper/transport paths remain accepted. Natural refresh and broader supported-mode/policy/reconnect interactions remain. |

The `not-delivered` question retry and fixed `CODEX_HOME` warning are accepted
corrections. They stay in regression coverage and are not open implementation
items. The accepted API exit monitor, separate Helper processes and compound
request/result/ACK recovery have the same status. Keyring and API-unprovided metadata are explicitly outside the approved
release scope. The former optional adapter and blanket warning are removed. No operating credentials, app installation, paid API call,
merge, or issue closure is authorized by this status record.

### Selected CLI and credential-store support

| Combination | Current result | Next evidence or decision |
| --- | --- | --- |
| Several app/terminal/Bridge CLI executables using one known file-backed home | The executable is selected separately from the one credential source; synthetic three-CLI product paths pass. | Installed combination and refresh acceptance. |
| Several previously used external homes or saved Bridge-owned file profiles | Known homes and profiles are selectable without a folder picker or credential copy; synthetic paths pass. | Real multi-home/profile acceptance. |
| File-backed ChatGPT login | User and workspace can be checked from the existing credential and selected App Server; synthetic paths and one installed separate-profile sign-in/verification/activation pass. | Natural refresh and broader account-change acceptance. |
| File-backed API key in a known or Bridge-owned profile | Synthetic three-CLI execution and API billing-route separation pass. | Real key storage and any billed call require separate approval. |
| Keyring ChatGPT, including the inspected `0.158.0-alpha.2.1`, `0.159.0-alpha.9` and selected `0.159.0` CLIs | Unverifiable ownership cannot authorize selection or execution; the speculative adapter is removed. | **Out of approved scope.** Choose a separate Bridge login or a verified file-backed source, subject to effective policy. |
| Managed Keyring/auto/ephemeral API credentials without verifiable owner | Stale file credentials and unrelated ambient keys do not authorize work. | **Out of approved scope.** Administrator storage policy remains authoritative. |
| Workspace/organization names and other account metadata absent from the current API | Entire fields, labels and empty cards are omitted, including internal fingerprints and unknown values. The approved installed-data renderer/browser check confirms the current ChatGPT display. | **Out of approved scope.** Broader API/mode interactions remain; do not add placeholder metadata. |

The isolated `0.159.0-alpha.9` schema check did not install or select that
CLI, read a real credential, or run a paid request. Neither the selected
CLI's `account/read` email nor a workspace ID alone distinguishes users who
share a workspace. The Sep 30 selected `0.159.0` capability probe also used a
temporary home without operating credentials; it confirms the public schema
limitation, not a live Keyring result. See the
[current CLI probe](2026-09-30-auth-process-boundaries.md#selected-operating-cli-capability).

| #208 condition | Current evidence and outstanding work |
| --- | --- |
| LOGIN-1 | Partial: [read-only desktop sign-out reconstruction](2026-09-30-codex-desktop-signout.md) shows four direct CLI browser-login starts followed 9–28 seconds later by desktop auth 401s. Upstream CLI clears the current auth before browser login and the old Bridge could launch this against the shared home. The actual invoker and affected build for each event remain unproven. |
| LOGIN-2 | Synthetic: five opt-in live probes no longer copy operating `auth.json`; build/package paths remain free of automatic live auth runs. Recheck the shipped package and any external agent automation. |
| LOGIN-3 | Partial live: a new persistent Bridge-owned profile was signed in independently, verified using the selected app CLI, and applied by a non-forced restart. Its own auth file was created without changing the shared auth file. Continuity through a later actual refresh remains pending. |
| LOGIN-4 | Partial: selected source, home, generation, and CLI are projected through launcher/Helper/server. New task admission reads the selected App Server's effective policy before resolving saved Agents. Installed source/home/generation/build settings matched after activation; complete managed-policy provenance remains unverified. |
| LOGIN-5 | Synthetic: unknown or email/workspace-only account metadata never proves ChatGPT execution ownership. A recovered file must prove the login user and workspace before admission. Temporary file read failures recover, token refresh retains that owner, and another user in the same workspace is rejected. Natural file refresh and supported external account changes remain live checks; Keyring is out of the approved scope. |
| LOGIN-6 | Partial: transient admission observations can recover without relogin. Existing App Server re-read/reconnect behavior after an external login is unverified. |
| LOGIN-7 | Partial: no automatic login/API fallback; authentication switch blocks active stored work and pending interactions while preserving retained terminal results and delivery receipts. New Jobs and schema-30 sessions persist a non-secret owner boundary; old completed results remain stored but cannot be replayed as executions. Original Job completion, failure, and interruption now record their session under the Job's admitted owner across an external login change and terminal commit retry. Active mismatched Jobs remain readable but cannot recover, be ACKed, cancelled, answered, or steered under a new owner without exact original-executor proof. A question blocked before upstream send records `not-delivered` and can retry the identical request after original-worker proof returns; a lost upstream reply remains `uncertain` and cannot resend. An HTTP Bridge restart with B leaves A's admitted Job dormant; a later restart with A recovers the same retained result under A and ACKs once, using a synthetic executor. Two additional HTTP cases use the real isolated execution owner and socket transport across queued-request/result loss, an observed synthetic auth change, dropped ACKs/replies and reconnect. The same request, owner and execution generation persist, ACKs follow terminal commit, and only one turn executes. Broader installed-CLI behavior remains unverified. |
| LOGIN-8 | Partial live: the previous installed build `f6b98c46724d:f344f196e4a6` retained the separate profile applied by `a8dc7ec`, with matching Helper/Bridge identities and connected Tunnel. The subsequent approved `238dcc2f7609:aac9a831bcdb` replacement retains that same profile and generation 1. Separate profile login, verification, non-forced activation and both replacements left the shared auth file unchanged. All 13 protected terminal result payloads and delivery records survived unchanged. Original desktop and Bridge usage reads succeeded at the 18:47 KST installed checkpoint; continuity through a later actual refresh remains unverified. |
| LOGIN-9 | Read-only operating desktop logs include the signed-out-or-different-account refresh error on Sep 25 and Sep 29. No token was collected or refresh forced. This supports cleared or changed auth state, but does not identify the direct CLI login caller. |
| LOGIN-10 | Partial: the previously accepted product source `21c31e8` passed the full four-worker Node suite, 1,087/1,087 tests in 111 files, plus build, TypeScript, release/localization and the isolated pinned App Server schema check. Its clean uninstalled arm64 candidate passed 217 strict Swift tests (two skipped, zero failures), 1,403-string checks across nine languages and deep strict signature verification. These supersede the earlier 1,064-test checkpoint. The historical 7-second failure was not reproduced; its timer diagnostic was not retained, so its cause stays unclassified and the timeout was not relaxed. Settings visual evidence includes the explicit `CODEX_HOME` warning and previously used location. Installed `7116217`→`a8dc7ec`→`f6b98c4` acceptance covers separate-profile sign-in, verification, non-forced activation and preservation through replacement. Source `21c31e8`'s API/process/transport correction stays accepted. The [current API cleanup](2026-09-30-current-api-auth-scope.md) at source `238dcc2` supersedes its display/Keyring scope and installation target; 1,085 Node tests, isolated browser/native renders, and the clean candidate's 216 strict Swift tests and signature verification pass. Its separately approved installation now passes exact running identity, preserved profile/results and non-billed authenticated-read checks. The operator-approved alternative installed-data display check subsequently passed seven production-view native renders and the installed dashboard using real IPC snapshots, including manual refresh and a 360-pixel light/dark layout. The 19:41 KST checkpoint again preserved the profile/results and authenticated reads. Actual refresh and broader installed interaction/mode acceptance remain. |
| LOGIN-11 | Live: independent-copy and no-copy shared-store multi-process refresh must be measured separately with the selected CLI; neither was injected into operating auth. |
| LOGIN-12 | Partial: account observation is correlated and stale read results are rejected on local revision changes. External changes without file revision and missing `account/updated` need installed-CLI tests. |
| LOGIN-13 | Partial: account/model/usage paths remain separate; fake candidate model checks are present. Real partial 401/refresh cases and actual turns remain unverified. |
| LOGIN-14 | Partial: first sign-in and explicit local management remain; unavailable observation blocks new admission without changing credentials. Every new admission checks current local and effective App Server login, workspace, and store restrictions before resolving a saved Agent; a temporary effective-policy read failure is retryable. Installed policy-change and running-worker behavior remain unverified. |
| LOGIN-15 | Partial: shared local policy uses one top-level TOML parser, including valid inline comments; candidate, shared selection, and new admission use the same effective-policy comparison for `config/read` and `configRequirements/read`. The installed CLI's actual policy provenance, workspace identity, and original machine causality remain unverified. |
| LOGIN-16 | Partial: official documentation and upstream reports are distinguished in the [evidence record](2026-09-29-auth-connection-evidence.md). The selected CLI is now 0.159.0; its unauthenticated schema was inspected, but this does not establish a refresh fix or natural-refresh continuity. |

| #210 condition | Current evidence and outstanding work |
| --- | --- |
| AUTHSEL-1 | Partial: one local manager and shared Swift controls offer the three choices in setup/settings. Same-account and different-account real login are untested. |
| AUTHSEL-2 | Partial: CLI and auth source are separate, explicit `CODEX_HOME` wins, and remote client shows read-only server source. Product-path matrices with all three CLI installations verify selected-executable login/account/model/work against the same explicit shared home and saved Bridge-owned ChatGPT or API profile homes. Saved profiles start no extra login. ChatGPT plan-usage reads stay on the selected CLI and profile home; API billing is identified separately without inventing plan usage. The auth screen shows the selected CLI next to the applied connection. Actual API costs, remote and live combinations still need product acceptance. |
| AUTHSEL-3 | Partial: shared/default file sources, Bridge-owned ChatGPT/API profiles and no automatic credential copy/login are handled. Saved profiles are selected and reverified without replacing credentials; distinct previously used external homes are remembered and aliases deduplicated. Installed multi-home acceptance remains. Unsupported Keyring/auto/ephemeral ownership is rejected with a supported-connection action, and is outside the approved scope. No hypothetical active-session RPC is used. |
| AUTHSEL-4 | Partial: candidate prepare, persisted login intent before browser/API process launch, CLI exit, verify, stage, pending cancel, and launch-specific activation are implemented. A restarted Helper reports an unconfirmed login result rather than success; an in-process replacement simulation rejects verification of that unresolved login, retains its profile in an unavailable state on cancellation, and preserves a new candidate through the old login's late callback. A local review action can clear a failed activation only while holding the launcher lock, after confirming no managed runtime or protected work remains; it retains the old selection, pending choice, and a stopped-unconfirmed record. A synthetic Helper case verifies two distinct ChatGPT profiles and retries B after its failed launch while restoring A first. Actual separate Helper processes now cover unresolved browser completion and a real API timeout across crash/replacement with a surviving writer and quarantined profile. The Codex CLI is synthetic; real-account failure recovery remains untested. |
| AUTHSEL-5 | Synthetic and partial live: bridge-owned file profiles live under persistent runtime home and survive candidate cancellation. The installed Bridge-owned ChatGPT profile persisted through the authorized `a8dc7ec`→`f6b98c4`→`238dcc2` replacements. Independent/API upgrades and real CLI replacement still need acceptance. |
| AUTHSEL-6 | Synthetic: new profile/credential preparation is separate from the applied store and never restores old auth files. Activation re-probes account/CLI/policy, selects the pending profile only for a launch-specific ID, and commits after readiness and exact owned-profile home confirmation. One distinct ChatGPT profile A→B failure/recovery path passes with a fake CLI and launcher; other mode pairs, key rotation, and real account changes remain untested. |
| AUTHSEL-7 | Partial: graceful apply prevents routine switching with active work and pending input. Terminal result retention continues independently through an idle connection change. New execution and request replay require current user/workspace confirmation. After a confirmed change or logout, an existing Job's question/cancellation requires its original live worker generation and turn; its ACK requires the original executor's retained receipt. HTTP MCP product-path cancellation is blocked without original worker proof and interrupts the exact turn after proof returns; the Job keeps A's owner. Proven pre-send question rejection remains retryable only under the original request ID after fresh question and worker checks; a possibly sent answer cannot be retried. Completion callbacks, including failure and interruption, use the Job's fixed owner for session persistence and rollback rather than the current login; synthetic product-path tests include a failed terminal commit and retry. Restarted bridges defer persisted execution recovery until the new process confirms the matching owner, retry after a later successful admission, and retain the original owner if the external login changes after recovery starts. An HTTP MCP restart case confirms B does not recover A's Job, then A recovers its retained result once with the original owner and ACK; the retained executor is synthetic. Old Job history remains stored. Accepted and unknown completion receipts also survive a distinct user/home and a lost HTTP result response. Two additional HTTP MCP cases with the real isolated execution owner now preserve queued requests, retained results and ACK identity through a synthetic external login change, response/ACK loss and reconnect, with exactly one turn and no new-owner admission. Broader installed auth/CLI combinations remain. |
| AUTHSEL-8 | Partial: state revisions and candidate CLI/account/credential fingerprints reject common stale actions; a launched runtime failure leaves the prior selection and an uncertain activation marker. Explicit stopped-runtime reconciliation records an unconfirmed outcome and never restores credential files. A synthetic A→B profile switch confirms that startup remains blocked until reconciliation, A's home is restored, and the same B candidate applies on retry. Browser/API login intent and logout intent are durable before their side-effecting calls. In a simulated Helper replacement, an unresolved browser login cannot be verified or reused after cancellation and its late completion cannot overwrite the next candidate; in-flight API-key cancellation also quarantines its profile. Actual separate Helper-process cancellation/late-completion cases now pass, including a real API deadline and crash/replacement while the old credential writer remains alive. API deadline/input/post-spawn errors preserve an unconfirmed state until exit. Other real-account late-callback combinations remain. |
| AUTHSEL-9 | Partial: bridge disconnect leaves shared login untouched. Explicit inactive bridge-owned ChatGPT logout and API key removal exist with confirmation, effective storage-policy checks, and protected-work preflight; synthetic tests cover lost logout replies and shared-store preservation. Installed credential-store behavior remains unverified. |
| AUTHSEL-10 | Synthetic: API switch needs billing confirmation and the execution key enters the selected CLI via stdin; no automatic API fallback. No billed real call was authorized. |
| AUTHSEL-11 | Partial: private local selection state stores choices, account email labels, and opaque correlations, never tokens or API keys; key input avoids CLI arguments/logs, and local management remains outside GPT tools. The approved installed-data native/dashboard display inspection contains no raw credential or internal fingerprint; full built-artifact and broader log inspection remains. |
| AUTHSEL-12 | Current-API scope: setup/settings show selected CLI, source, provided email, known method, plan and billing route. Available usage windows/credits and separately configured confirmed API costs are displayed. Unprovided names, internal owner/workspace fingerprints, unknown rows and empty quota/cost cards are omitted. Real authentication/policy errors remain actionable. API-unprovided metadata is outside the approved scope. The operator-approved alternative display check uses seven unchanged production-view native renders with real installed snapshots and the installed dashboard HTML/IPC, with provided-value/refresh/timestamp and narrow light/dark layout checks. Current ChatGPT display is verified; broader API/mode interaction acceptance remains. |
| AUTHSEL-13 | Partial: local method/store/workspace values share one parser. Candidate/shared probes and admission reject conflicting effective method, workspace and managed storage policy. Keyring/auto/ephemeral do not authorize work from stale files or unrelated ambient keys; those unverifiable combinations are outside the approved scope. Installed effective-policy provenance for supported sources remains a live acceptance check. |
| AUTHSEL-14 | Partial: schema-30 thread and Job metadata persist non-secret auth boundaries; legacy rows and completed results are retained but unowned threads cannot resume and an old request cannot be re-executed under a new connection. New owner boundaries include user and selected workspace; older workspace-only records stay stored but are not automatically attributed to a newly verified user. Original Job session results retain their admitted owner after an external login change, including terminal retry; session retention and in-memory rollback use that same owner. Unknown ownership uses an unverified temporary process boundary and cannot authorize new work; Keyring is excluded. Normal CLI replacement preserves the stable owner boundary, but an in-place replacement still requires runtime revalidation. The known-home choice now warns that conversations, skills, and settings may differ while history is retained. App resume, skills, and setting combinations need product acceptance. |
| AUTHSEL-15 | Partial: absent saved choice defaults to existing shared auth, and explicit `CODEX_HOME` remains authoritative. Existing independent/API installations and their upgrade paths need installed acceptance. |
| AUTHSEL-16 | Partial: source correction `a8dc7ec` passed the full four-worker Node suite, 1,078/1,078 tests in 110 files, plus TypeScript and release checks. Its separate arm64 bundle ran 215 strict Swift tests (two skipped, zero failures) and passed 1,400-string checks across nine languages and deep strict signature verification. The suite includes the selected-CLI/auth-source matrix, original-worker question/cancellation and retained-result ACK ownership, synthetic A→B activation failure/recovery, in-process Helper replacement with a late login, and accepted/unknown completion retrieval after a new login and a lost HTTP response. The installed `a8dc7ec29623:c7f8390b654f` completed non-forced separate-profile activation with matching Helper/Bridge builds and a connected Tunnel. Thirteen original retained Job payloads and delivery records were unchanged; original desktop usage remained readable and the shared auth file stayed unchanged. The operating build later advanced through `f6b98c4` to the separately approved `238dcc2` replacement. Current source `238dcc2` and retained candidate `238dcc2f7609:aac9a831bcdb` pass source/UI/native/signature gates within the approved file/API scope, including the accepted separate Helper and compound transport checks. The Sep 30 18:47 KST installed checkpoint confirms exact app/Helper/Bridge identities, the same profile/generation, all 13 retained results, unchanged auth metadata and successful Bridge/desktop usage reads. The subsequent approved alternative installed-data display check passed seven native renders and the installed dashboard with real IPC data; the 19:41 KST checkpoint again preserved all 13 results, the same profile and authenticated Bridge/desktop reads. A later actual refresh, billed API and broader supported-mode/policy/reconnect interactions remain outstanding. The historical process-probe timing failure remains unclassified. |

The previous checkpoint could not finish App Server schema reproducibility
because the available CLI was `0.158.0-alpha.2.1` and the check requires its
CI pin `0.153.3`. The follow-up used a temporary isolated installation of the
pin and passed that check without changing the operating CLI. The current
CLI's generated schema was inspected separately; actual policy, authentication,
and workspace responses still need product acceptance.

Before merging or closing either issue, resolve the explicit display/support
scope gaps and run the separately authorized operating acceptance plan. The
operation should
record candidate artifact/build identity, selected CLI and configuration
source, profile ownership, original-app sign-in state before and after a later
refresh, same-store multi-process outcome, model/usage/turn partial failures,
Job/result/ACK ownership across every switch, and any billed API cost limit.
Never prepare the test profile by copying the operating credential store.
