# Authentication issues #208 and #210: acceptance status

This is a checkpoint for the implementation based on `origin/dev` at
`031c193`. It is not evidence that either GitHub issue is complete. The issue
checkboxes require separate product and operational evidence; a green unit
test or a successful build cannot substitute for it. A separately authorized
replacement installed the `7116217` candidate on Sep 30. Its shared-home
login guard and separate-profile flow are now running in the operating app.

A [Sep 30 read-only sign-out investigation](2026-09-30-codex-desktop-signout.md)
found four direct CLI browser-login starts followed within 9–28 seconds by
desktop authentication 401s. The old Bridge's shared-home login action is now
disabled in the installed candidate and first setup routes to separate profile
settings. The exact historical caller remains unknown.

## Sep 30 installed, non-billed acceptance checkpoint

The signed app and Helper report build `7116217e9916:1fa30981c720`. Both
legacy shared-home login actions return `CODEX_SHARED_LOGIN_DISABLED`. The
operating shared auth file was last modified Sep 29 at 08:12:34 KST. A new
persistent Bridge-owned ChatGPT profile was prepared in a different
`CODEX_HOME`, signed in through the selected app CLI, and verified through its
account, policy, and model checks. Its own auth file was created Sep 30 at
12:23:13 KST; the shared auth file's modification time did not change. Codex
desktop logs for Sep 30 contained no `desktop_fetch_auth_401` through this
checkpoint. No billed API execution was requested.

The verified profile is staged for activation. A non-forced restart reservation
is waiting for current Bridge Jobs and protected memory-only threads to clear;
the running Bridge still uses the original shared connection. The later
refresh, actual activation, and original-app continuity are not yet verified.

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
  execution. A last-confirmed Keyring owner labels historical reads until a
  later operational observation changes it, so installed external-login
  notification and display-freshness behavior still need acceptance.
- On CLIs that provide experimental `account/read.workspaceRouting`, its
  `chatgptAccountId` identifies the selected ChatGPT workspace even when the
  separate usage lookup fails. If usage also supplies an account ID, they must
  agree. An account with neither ID remains unverified, and a managed Keyring
  API key still has no supported owner identity from this protocol.
- The newer optional `account/sessions/list` protocol can report an active
  session's user ID and selected workspace. The Bridge now detects that method
  from the selected CLI's own schema and reads active-session evidence before
  and after `account/read`. Only a stable active session whose workspace agrees
  with `account/read` becomes a Keyring execution owner; absent, malformed,
  conflicting, or unsupported replies remain unverified. Synthetic worker and
  projection tests cover this path. The selected installed CLI
  `0.158.0-alpha.2.1` does **not** expose the method in its generated schema,
  so its Keyring ChatGPT combination remains blocked for new work. Managed
  Keyring API owner identity is also unresolved. The optional response is
  defined in [OpenAI's App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs).
- When that optional response also names the selected workspace, the local
  candidate and connection settings show its human-readable name alongside
  the account email and opaque fingerprint. The name is accepted only from a
  stable active user/session whose workspace agrees with `account/read`; it
  never becomes execution ownership proof or enters the GPT-facing account
  snapshot. The inspected installed CLI cannot supply this name through the
  optional method, so a human-readable current workspace and exact cost target
  are still unavailable for that combination. Local synthetic tests cover the
  verified and conflicting response branches; installed UI acceptance remains.
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
- The local authentication choice shows a capability warning when the selected
  CLI lacks active-session identity and the existing shared login is selected
  or fixed by explicit `CODEX_HOME`. The warning names the Keyring ChatGPT
  limitation while leaving file-backed login available. The selected installed
  CLI was checked again with isolated schema generation: its core contract is compatible, but
  `account/sessions/list` is absent. No operating credential was read or
  changed by this schema check.
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
  task. The retained executor is synthetic; process reconnection and an actual
  Keyring or external-login change remain separate acceptance conditions.
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
  that saved profile cannot be selected. This is an in-process replacement
  simulation; separate Helper processes and installed login behavior remain.
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
  recorded in the PR description; the newer `7116217` bundle is installed.

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
| LOGIN-3 | Partial live | A persistent independent profile completed sign-in and verification; activation and later refresh remain. |
| LOGIN-4 | Synthetic product path passed; live environment needed | Inspect actual selected source and managed-policy provenance. |
| LOGIN-5 | Synthetic product path passed; live environment needed; support scope decision needed | Verify actual file/Keyring refresh and external account changes; current CLI cannot prove Keyring user identity. |
| LOGIN-6 | Implementation incomplete; live environment needed | Establish App Server reconnect behavior after external login without interrupting original work. |
| LOGIN-7 | Implementation incomplete; synthetic product path passed; live environment needed | Original Job question, cancel, result, and restart subsets passed; queue, transport ACK, and existing-thread combinations remain. |
| LOGIN-8 | Partial live | The final candidate is installed and the shared auth file remained unchanged during separate login; observe original Codex app login through a later refresh. |
| LOGIN-9 | Read-only operating-log error found; live acceptance needed | Desktop logged the signed-out-or-different-account refresh error. Verify the final candidate through a later refresh. |
| LOGIN-10 | Synthetic product path passed; live environment needed | Re-run final-source checks and installed user acceptance; previous timer failure cause remains unknown. |
| LOGIN-11 | Live environment needed | Compare independent and shared-store multi-process refresh under separate authorization. |
| LOGIN-12 | Implementation incomplete; live environment needed | Confirm external changes without a file revision or `account/updated` in the installed CLI. |
| LOGIN-13 | Live environment needed | Verify real partial 401, usage/model failure, and turn behavior. |
| LOGIN-14 | Synthetic product path passed; live environment needed | Verify installed policy changes and running workers. |
| LOGIN-15 | Synthetic product path passed; live environment needed | Confirm installed effective-policy provenance and workspace restriction. |
| LOGIN-16 | Live environment needed | Compare original and selected CLI refresh behavior with documented upstream evidence. |
| AUTHSEL-1 | Synthetic product path passed; live environment needed | Exercise both same-user and different-user login in the installed app. |
| AUTHSEL-2 | Synthetic product path passed; live environment needed | Three executable/profile combinations passed synthetically; remote and billed paths remain. |
| AUTHSEL-3 | Synthetic product path passed; live environment needed; support scope decision needed | Known homes and saved profiles are selectable without a folder picker; real multi-home and unsupported Keyring/API ownership remain. |
| AUTHSEL-4 | Implementation incomplete; synthetic product path passed; live environment needed | The activation retry covers verified ChatGPT profile A→B as well as disconnect. An in-process Helper replacement simulation protects a cancelled login; separate-process replacement and actual failure recovery remain. |
| AUTHSEL-5 | Synthetic product path passed; live environment needed | Verify persistent profiles through a real app upgrade and CLI replacement. |
| AUTHSEL-6 | Synthetic product path passed; live environment needed | A verified synthetic ChatGPT profile A→B failure/retry passes; other mode pairs, real account changes, and key rotation remain. |
| AUTHSEL-7 | Implementation incomplete; synthetic product path passed; live environment needed | Original-worker HTTP and synthetic restart paths passed; queue, transport ACK, result collection, and real reconnection remain. |
| AUTHSEL-8 | Implementation incomplete; synthetic product path passed; live environment needed | Stopped-runtime retry passes for disconnect and verified ChatGPT profile A→B. One replacement/late-login simulation passes; other late callbacks, separate-process Helper behavior, and installed recovery remain. |
| AUTHSEL-9 | Synthetic product path passed; live environment needed | Verify actual credential-store logout and API-key removal. |
| AUTHSEL-10 | Synthetic product path passed; live environment needed | Real API execution and cost require separate approval. |
| AUTHSEL-11 | Live environment needed | Inspect final built UI and logs for secret exposure. |
| AUTHSEL-12 | Implementation incomplete; synthetic product path passed; live environment needed; support scope decision needed | Verified candidate may show workspace name; current CLI, remote sources, models, organization/project, and exact cost target remain unresolved. |
| AUTHSEL-13 | Synthetic product path passed; live environment needed; support scope decision needed | Confirm installed managed policy and determine verifiable Keyring/API combinations. |
| AUTHSEL-14 | Implementation incomplete; synthetic product path passed; live environment needed | Fixed-owner sessions and Job result paths passed; app resume, skills, and settings combinations remain. |
| AUTHSEL-15 | Live environment needed | Verify existing independent/API installations and upgrades. |
| AUTHSEL-16 | Implementation incomplete; synthetic product path passed; live environment needed | Complete remaining continuity combinations and final-source candidate/live acceptance. |

The `not-delivered` question retry and fixed `CODEX_HOME` warning are accepted
corrections. They stay in regression coverage and are not open implementation
items. A Keyring warning only explains a limitation; it does not count as
Keyring support. No operating credentials, app installation, paid API call,
merge, or issue closure is authorized by this status record.

### Selected CLI and credential-store support

| Combination | Current result | Next evidence or decision |
| --- | --- | --- |
| Several app/terminal/Bridge CLI executables using one known file-backed home | The executable is selected separately from the one credential source; synthetic three-CLI product paths pass. | Installed combination and refresh acceptance. |
| Several previously used external homes or saved Bridge-owned file profiles | Known homes and profiles are selectable without a folder picker or credential copy; synthetic paths pass. | Real multi-home/profile acceptance. |
| File-backed ChatGPT login | User and workspace can be checked from the existing credential and selected App Server; synthetic paths pass. | Live login, refresh, and account-change acceptance. |
| File-backed API key in a known or Bridge-owned profile | Synthetic three-CLI execution and API billing-route separation pass. | Real key storage and any billed call require separate approval. |
| Keyring ChatGPT with stable `account/sessions/list` user/workspace evidence | The optional Bridge path passes synthetic worker tests. | Confirm a selected CLI actually exposes the method, then perform live Keyring acceptance. |
| Keyring ChatGPT on inspected CLI `0.158.0-alpha.2.1` or isolated `0.159.0-alpha.9` | Their generated experimental schemas omit `account/sessions/list`; new execution is blocked, with an explanatory local warning. | **Support scope decision needed:** a safe user identity source or an explicit product scope change. The warning is not support. |
| Managed Keyring API credentials without verifiable owner | New execution is blocked. | **Implementation or support scope decision needed:** establish owner and billing target without guessing from a stale file or ambient key. |

The isolated `0.159.0-alpha.9` schema check did not install or select that
CLI, read a real credential, or run a paid request. Neither the selected
CLI's `account/read` email nor a workspace ID alone distinguishes users who
share a workspace.

| #208 condition | Current evidence and outstanding work |
| --- | --- |
| LOGIN-1 | Partial: [read-only desktop sign-out reconstruction](2026-09-30-codex-desktop-signout.md) shows four direct CLI browser-login starts followed 9–28 seconds later by desktop auth 401s. Upstream CLI clears the current auth before browser login and the old Bridge could launch this against the shared home. The actual invoker and affected build for each event remain unproven. |
| LOGIN-2 | Synthetic: five opt-in live probes no longer copy operating `auth.json`; build/package paths remain free of automatic live auth runs. Recheck the shipped package and any external agent automation. |
| LOGIN-3 | Partial live: a new persistent Bridge-owned profile was signed in independently and verified using the selected app CLI. Its own auth file was created without changing the shared auth file. Activation and later refresh are pending. |
| LOGIN-4 | Partial: selected source, home, generation, and CLI are projected through launcher/Helper/server. New task admission reads the selected App Server's effective policy before resolving saved Agents. Operating applied settings and installed managed-policy provenance were not inspected. |
| LOGIN-5 | Synthetic: initial unknown, account-read → recovered file for the same explicit account ID, temporary read failure, stable refresh identity, and same-email/different-account rejection. An optional CLI active-session user ID plus matching workspace can identify Keyring ownership without relying on email or usage; unstable or absent session evidence remains unverified. The selected CLI lacks this endpoint, and real Keyring and external-account changes remain live checks. |
| LOGIN-6 | Partial: transient admission observations can recover without relogin. Existing App Server re-read/reconnect behavior after an external login is unverified. |
| LOGIN-7 | Partial: no automatic login/API fallback; authentication switch blocks protected stored work, interactions, and undelivered results. New Jobs and schema-30 sessions persist a non-secret owner boundary; old completed results remain stored but cannot be replayed as executions. Original Job completion, failure, and interruption now record their session under the Job's admitted owner across an external login change and terminal commit retry. Active mismatched Jobs remain readable but cannot recover, be ACKed, cancelled, answered, or steered under a new owner without exact original-executor proof. A question blocked before upstream send records `not-delivered` and can retry the identical request after original-worker proof returns; a lost upstream reply remains `uncertain` and cannot resend. An HTTP Bridge restart with B leaves A's admitted Job dormant; a later restart with A recovers the same retained result under A and ACKs once, using a synthetic executor. Queue, transport ACK, and existing-thread behavior still need broader product acceptance. |
| LOGIN-8 | Partial live: installed build `7116217e9916:1fa30981c720` launched with matching Helper/bridge builds and connected tunnel. Separate profile login and verification left the shared auth file unchanged. A non-forced activation restart awaits protected work; original Codex app login through a later refresh remains unverified. |
| LOGIN-9 | Read-only operating desktop logs include the signed-out-or-different-account refresh error on Sep 25 and Sep 29. No token was collected or refresh forced. This supports cleared or changed auth state, but does not identify the direct CLI login caller. |
| LOGIN-10 | Partial: after the menu-bar usage correction, API-profile matrix, original-Job question retry fix, previously used external-home selection, original-worker cancellation, Bridge restart owner-recovery HTTP case, and local workspace-name display, the full four-worker Node suite passed 1,064/1,064 tests in 109 files, including the process-probe elapsed-time assertion. The prior 7-second failure was not reproduced; its timer diagnostic was not retained, so its cause remains unclassified and the timeout was not relaxed. The focused three-installation matrix passed 10/10, TypeScript build/release/localization passed, and macOS passed 215 Swift tests (2 skipped) plus nine-language checks. Settings visual acceptance includes the explicit `CODEX_HOME` warning and previously used location; the isolated pinned App Server schema check is separate evidence. The newer `7116217` bundle is installed; separate-profile sign-in and verification passed, while later refresh and broader user acceptance remain separate. |
| LOGIN-11 | Live: independent-copy and no-copy shared-store multi-process refresh must be measured separately with the selected CLI; neither was injected into operating auth. |
| LOGIN-12 | Partial: account observation is correlated and stale read results are rejected on local revision changes. External changes without file revision and missing `account/updated` need installed-CLI tests. |
| LOGIN-13 | Partial: account/model/usage paths remain separate; fake candidate model checks are present. Real partial 401/refresh cases and actual turns remain unverified. |
| LOGIN-14 | Partial: first sign-in and explicit local management remain; unavailable observation blocks new admission without changing credentials. Every new admission checks current local and effective App Server login, workspace, and store restrictions before resolving a saved Agent; a temporary effective-policy read failure is retryable. Installed policy-change and running-worker behavior remain unverified. |
| LOGIN-15 | Partial: shared local policy uses one top-level TOML parser, including valid inline comments; candidate, shared selection, and new admission use the same effective-policy comparison for `config/read` and `configRequirements/read`. The installed CLI's actual policy provenance, workspace identity, and original machine causality remain unverified. |
| LOGIN-16 | Partial: official documentation and upstream reports are distinguished in the [evidence record](2026-09-29-auth-connection-evidence.md). Installed CLI 0.158.0-alpha.2.1 behavior was not tested for refresh fixes. |

| #210 condition | Current evidence and outstanding work |
| --- | --- |
| AUTHSEL-1 | Partial: one local manager and shared Swift controls offer the three choices in setup/settings. Same-account and different-account real login are untested. |
| AUTHSEL-2 | Partial: CLI and auth source are separate, explicit `CODEX_HOME` wins, and remote client shows read-only server source. Product-path matrices with all three CLI installations verify selected-executable login/account/model/work against the same explicit shared home and saved Bridge-owned ChatGPT or API profile homes. Saved profiles start no extra login. ChatGPT plan-usage reads stay on the selected CLI and profile home; API billing is identified separately without inventing plan usage. The auth screen shows the selected CLI next to the applied connection. Actual API costs, remote and live combinations still need product acceptance. |
| AUTHSEL-3 | Partial: shared/default, unknown account, ChatGPT/API, and no automatic credential copy/login are handled. Multiple previously saved bridge-owned profiles can be selected and reverified without replacing their credentials. The Helper remembers distinct external `CODEX_HOME` locations it has actually used; setup/settings can select them without a folder picker after a fresh selected-CLI probe, and aliases are deduplicated. CLI installation paths do not imply separate credential homes. Synthetic manager/Helper coverage exists, but multi-home installed acceptance is pending. On a CLI that exposes `account/sessions/list`, the Bridge can verify a stable active ChatGPT user and selected workspace even when usage lookup fails. The inspected CLI `0.158.0-alpha.2.1` lacks that method; the local shared-login choice warns that this CLI cannot verify Keyring ChatGPT users. New Keyring ChatGPT work remains blocked on that CLI, and managed Keyring API without a verifiable owner remains blocked. |
| AUTHSEL-4 | Partial: candidate prepare, persisted login intent before browser/API process launch, CLI exit, verify, stage, pending cancel, and launch-specific activation are implemented. A restarted Helper reports an unconfirmed login result rather than success; an in-process replacement simulation rejects verification of that unresolved login, retains its profile in an unavailable state on cancellation, and preserves a new candidate through the old login's late callback. A local review action can clear a failed activation only while holding the launcher lock, after confirming no managed runtime or protected work remains; it retains the old selection, pending choice, and a stopped-unconfirmed record. A synthetic Helper case verifies two distinct ChatGPT profiles and retries B after its failed launch while restoring A first. Separate-process replacement and real failure recovery remain untested. |
| AUTHSEL-5 | Synthetic: bridge-owned file profiles live under persistent runtime home and survive candidate cancellation. Rebuild/reinstall/CLI replacement with real credentials needs acceptance. |
| AUTHSEL-6 | Synthetic: new profile/credential preparation is separate from the applied store and never restores old auth files. Activation re-probes account/CLI/policy, selects the pending profile only for a launch-specific ID, and commits after readiness and exact owned-profile home confirmation. One distinct ChatGPT profile A→B failure/recovery path passes with a fake CLI and launcher; other mode pairs, key rotation, and real account changes remain untested. |
| AUTHSEL-7 | Partial: graceful apply and stored retention protection prevent routine switching with active work, pending input, or uncollected results. New execution and request replay require current user/workspace confirmation. After a confirmed change or logout, an existing Job's question/cancellation requires its original live worker generation and turn; its ACK requires the original executor's retained receipt. HTTP MCP product-path cancellation is blocked without original worker proof and interrupts the exact turn after proof returns; the Job keeps A's owner. Proven pre-send question rejection remains retryable only under the original request ID after fresh question and worker checks; a possibly sent answer cannot be retried. Completion callbacks, including failure and interruption, use the Job's fixed owner for session persistence and rollback rather than the current login; synthetic product-path tests include a failed terminal commit and retry. Restarted bridges defer persisted execution recovery until the new process confirms the matching owner, retry after a later successful admission, and retain the original owner if the external login changes after recovery starts. An HTTP MCP restart case confirms B does not recover A's Job, then A recovers its retained result once with the original owner and ACK; the retained executor is synthetic. Old Job history remains stored. Other queue/transport/result delivery paths still need product verification. |
| AUTHSEL-8 | Partial: state revisions and candidate CLI/account/credential fingerprints reject common stale actions; a launched runtime failure leaves the prior selection and an uncertain activation marker. Explicit stopped-runtime reconciliation records an unconfirmed outcome and never restores credential files. A synthetic A→B profile switch confirms that startup remains blocked until reconciliation, A's home is restored, and the same B candidate applies on retry. Browser/API login intent and logout intent are durable before their side-effecting calls. In a simulated Helper replacement, an unresolved browser login cannot be verified or reused after cancellation and its late completion cannot overwrite the next candidate; in-flight API-key cancellation also quarantines its profile. Separate-process cancellation and other late-callback cases remain. |
| AUTHSEL-9 | Partial: bridge disconnect leaves shared login untouched. Explicit inactive bridge-owned ChatGPT logout and API key removal exist with confirmation, effective storage-policy checks, and protected-work preflight; synthetic tests cover lost logout replies and shared-store preservation. Installed credential-store behavior remains unverified. |
| AUTHSEL-10 | Synthetic: API switch needs billing confirmation and the execution key enters the selected CLI via stdin; no automatic API fallback. No billed real call was authorized. |
| AUTHSEL-11 | Partial: private local selection state stores choices, account email labels, and opaque correlations, never tokens or API keys; key input avoids CLI arguments/logs, and local management remains outside GPT tools. Full built-artifact and UI/log inspection remains. |
| AUTHSEL-12 | Partial: local setup/settings distinguish the email and workspace fingerprint recorded at last apply from the latest observed workspace. Verified candidates and staged choices carry a workspace fingerprint and billing route from their own probe. If a supported CLI reports a stable active user/session and a matching selected workspace, the local choice also displays that workspace's human-readable name; the name and email never prove ownership. Shared API billing still requires explicit confirmation. A selected CLI without active-session identity support shows the shared Keyring ChatGPT limitation for a selectable or explicitly fixed shared home. The inspected installed CLI cannot provide this optional workspace name. Current human-readable workspace/organization/project names, supported-model differences, exact cost target for unverified sources, and remote account details remain incomplete. |
| AUTHSEL-13 | Partial: local method/store/workspace values share one parser. Candidate/shared probes and new admission reject conflicting effective method, workspace, and managed credential-store values. A managed Keyring/auto choice no longer treats a stale shared `auth.json` as ownership evidence; an unknown active owner blocks selection. Installed effective-policy provenance and actual workspace identity are not verified end to end. |
| AUTHSEL-14 | Partial: schema-30 thread and Job metadata persist non-secret auth boundaries; legacy rows and completed results are retained but unowned threads cannot resume and an old request cannot be re-executed under a new connection. New owner boundaries include user and selected workspace; older workspace-only records stay stored but are not automatically attributed to a newly verified user. Original Job session results retain their admitted owner after an external login change, including terminal retry; session retention and in-memory rollback use that same owner. Unknown Keyring identities use a temporary process boundary until confirmed. Normal CLI replacement preserves the stable owner boundary, but an in-place replacement still requires runtime revalidation. The known-home choice now warns that conversations, skills, and settings may differ while history is retained. App resume, skills, and setting combinations need product acceptance. |
| AUTHSEL-15 | Partial: absent saved choice defaults to existing shared auth, and explicit `CODEX_HOME` remains authoritative. Existing independent/API installations and their upgrade paths need installed acceptance. |
| AUTHSEL-16 | Partial: full four-worker Node passed 1,074/1,074 tests in 110 files after the profile switch and cancelled-login changes; the historical process-probe timing failure did not recur and remains unclassified. The selected-CLI/auth-source product matrix passed 10/10, covering explicit shared home, saved Bridge-owned ChatGPT/API profiles, and a previously configured external home across app, terminal, and Bridge CLI choices. Separate HTTP MCP product-path cases passed live original-worker question proof, pre-send block followed by proof recovery and one delivery, lost upstream reply without a resend, and original-worker cancellation after external login change. The question cases retain fixed-owner result persistence and exact ACK; cancellation stays blocked without live original-worker proof. An HTTP Bridge restart case confirms B leaves A's Job dormant and a later A restart recovers its retained result once, preserving A's session and ACKing the same Job. Helper lifecycle coverage retries a pending choice after a stopped-unconfirmed activation, now including verified synthetic ChatGPT profile A→B. An in-process replacement simulation rejects unresolved login verification and preserves a new candidate through a late callback. The Helper file passed 53/53 and the auth-selection file passed 28/28; TypeScript type checking, release check, 215 Swift tests (2 skipped), and 1,400 strings across nine languages passed. Earlier settings visual acceptance includes a known external home and its continuity warning. The pinned App Server schema check passed separately at an earlier checkpoint; the selected installed CLI's isolated schema inspection confirms core compatibility without `account/sessions/list`. Installed `7116217` ran with matching Helper/bridge builds and a connected tunnel; its separate-profile login and verification passed without changing the shared auth file. Candidate bundle identity is tracked in the PR verification; activation, later refresh, billed API, and broader user acceptance remain outstanding. |

The previous checkpoint could not finish App Server schema reproducibility
because the available CLI was `0.158.0-alpha.2.1` and the check requires its
CI pin `0.153.3`. The follow-up used a temporary isolated installation of the
pin and passed that check without changing the operating CLI. The current
CLI's generated schema was inspected separately; actual policy, authentication,
and workspace responses still need product acceptance.

Before merging or closing either issue, complete the missing code paths and
run the separately authorized isolated acceptance plan. The operation should
record candidate artifact/build identity, selected CLI and configuration
source, profile ownership, original-app sign-in state before and after a later
refresh, same-store multi-process outcome, model/usage/turn partial failures,
Job/result/ACK ownership across every switch, and any billed API cost limit.
Never prepare the test profile by copying the operating credential store.
