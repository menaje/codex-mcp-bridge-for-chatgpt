# Authentication issues #208 and #210: acceptance status

This is a checkpoint for the implementation based on `origin/dev` at
`031c193`. It is not evidence that either GitHub issue is complete. The issue
checkboxes require separate product and operational evidence; a green unit
test or a successful build cannot substitute for it. A separately authorized
replacement installed the older `b24bb26` candidate; later source corrections
in this draft have not been installed. No operating login was changed during
the source-only follow-up.

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
  configuration. It stores no credential copy and deduplicates aliases of the
  same directory. Setup/settings can stage a previously used location without
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
- The installed CLI `0.158.0-alpha.2.1` generated its TypeScript App Server
  schema in a temporary home without authentication. It includes
  `account/read.workspaceRouting.chatgptAccountId` and a nullable usage
  `accountId`. A separately installed temporary CLI `0.153.3` passed the pinned
  schema reproducibility check (416 JSON and 827 TypeScript files). Neither is
  a real login test. Candidate artifact identity for each committed source is
  recorded in the PR description; the installed `b24bb26` bundle remains older.

Status terms: **synthetic** means implementation exercised with fake accounts
or local fixtures; **partial** means a stated part is missing; **live** means
the item needs an independently authorized, isolated real-account or installed
app acceptance run.

| #208 condition | Current evidence and outstanding work |
| --- | --- |
| LOGIN-1 | Partial: [source/installation chronology](2026-09-29-auth-connection-evidence.md) separates report, observed guard rejection, and conditional source hazard. The original sign-out timeline and identity of the build involved in that report remain unknown; the later `b24bb26` replacement identity is recorded separately. |
| LOGIN-2 | Synthetic: five opt-in live probes no longer copy operating `auth.json`; build/package paths remain free of automatic live auth runs. Recheck the shipped package and any external agent automation. |
| LOGIN-3 | Synthetic: marked persistent independent test home and fixture coverage. No independently signed-in test profile was supplied or used. |
| LOGIN-4 | Partial: selected source, home, generation, and CLI are projected through launcher/Helper/server. New task admission reads the selected App Server's effective policy before resolving saved Agents. Operating applied settings and installed managed-policy provenance were not inspected. |
| LOGIN-5 | Synthetic: initial unknown, account-read → recovered file for the same explicit account ID, temporary read failure, stable refresh identity, and same-email/different-account rejection. An optional CLI active-session user ID plus matching workspace can identify Keyring ownership without relying on email or usage; unstable or absent session evidence remains unverified. The selected CLI lacks this endpoint, and real Keyring and external-account changes remain live checks. |
| LOGIN-6 | Partial: transient admission observations can recover without relogin. Existing App Server re-read/reconnect behavior after an external login is unverified. |
| LOGIN-7 | Partial: no automatic login/API fallback; authentication switch blocks protected stored work, interactions, and undelivered results. New Jobs and schema-30 sessions persist a non-secret owner boundary; old completed results remain stored but cannot be replayed as executions. Original Job completion, failure, and interruption now record their session under the Job's admitted owner across an external login change and terminal commit retry. Active mismatched Jobs remain readable but cannot recover, be ACKed, cancelled, answered, or steered under a new owner without exact original-executor proof. A question blocked before upstream send records `not-delivered` and can retry the identical request after original-worker proof returns; a lost upstream reply remains `uncertain` and cannot resend. Queue, transport ACK, and existing-thread behavior still need broader product acceptance. |
| LOGIN-8 | Partial live: after a separately authorized replacement, installed build `b24bb2616935:dfbdb90c8b89` launched with matching Helper/bridge builds, connected tunnel, preserved reported Codex login availability, and opened schema 30. The original Codex app login through a later refresh and this subsequent source revision were not installed or exercised. |
| LOGIN-9 | Synthetic/source audit: no raw credential copy, logout, deletion, or forced refresh was added to routine diagnostics. Actual refresh error type was not observed. |
| LOGIN-10 | Partial: after the menu-bar usage correction, API-profile matrix, original-Job question retry fix, previously used external-home selection, and original-worker cancellation HTTP case, the full four-worker Node suite passed 1,062/1,062 tests in 109 files, including the process-probe elapsed-time assertion. The prior 7-second failure was not reproduced; its timer diagnostic was not retained, so its cause remains unclassified and the timeout was not relaxed. The focused three-installation matrix passed 10/10, TypeScript build/release/localization passed, and macOS passed 215 Swift tests (2 skipped) plus nine-language checks. Settings visual acceptance includes the explicit `CODEX_HOME` warning and previously used location; the isolated pinned App Server schema check is separate evidence. The installed `b24bb26` bundle predates these source corrections; real-account and user acceptance remain separate. |
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
| AUTHSEL-4 | Partial: candidate prepare, persisted login intent before browser/API process launch, CLI exit, verify, stage, pending cancel, and launch-specific activation are implemented. A restarted Helper reports an unconfirmed login result rather than success. A local review action can clear a failed activation only while holding the launcher lock, after confirming no managed runtime or protected work remains; it retains the old selection, pending choice, and a stopped-unconfirmed record. Real failure recovery remains untested. |
| AUTHSEL-5 | Synthetic: bridge-owned file profiles live under persistent runtime home and survive candidate cancellation. Rebuild/reinstall/CLI replacement with real credentials needs acceptance. |
| AUTHSEL-6 | Synthetic: new profile/credential preparation is separate from the applied store and never restores old auth files. Activation re-probes account/CLI/policy, selects the pending profile only for a launch-specific ID, and commits after readiness and exact owned-profile home confirmation. All mode-pair and A→B/key-rotation product cases remain untested. |
| AUTHSEL-7 | Partial: graceful apply and stored retention protection prevent routine switching with active work, pending input, or uncollected results. New execution and request replay require current user/workspace confirmation. After a confirmed change or logout, an existing Job's question/cancellation requires its original live worker generation and turn; its ACK requires the original executor's retained receipt. HTTP MCP product-path cancellation is blocked without original worker proof and interrupts the exact turn after proof returns; the Job keeps A's owner. Proven pre-send question rejection remains retryable only under the original request ID after fresh question and worker checks; a possibly sent answer cannot be retried. Completion callbacks, including failure and interruption, use the Job's fixed owner for session persistence and rollback rather than the current login; synthetic product-path tests include a failed terminal commit and retry. Restarted bridges defer persisted execution recovery until the new process confirms the matching owner, retry after a later successful admission, and retain the original owner if the external login changes after recovery starts. Old Job history remains stored. Other queue/transport/result delivery paths still need product verification. |
| AUTHSEL-8 | Partial: state revisions and candidate CLI/account/credential fingerprints reject common stale actions; a launched runtime failure leaves the prior selection and an uncertain activation marker. Explicit stopped-runtime reconciliation records an unconfirmed outcome and never restores credential files. Browser/API login intent and logout intent are durable before their side-effecting calls. Cross-Helper cancellation and other late-callback cases remain. |
| AUTHSEL-9 | Partial: bridge disconnect leaves shared login untouched. Explicit inactive bridge-owned ChatGPT logout and API key removal exist with confirmation, effective storage-policy checks, and protected-work preflight; synthetic tests cover lost logout replies and shared-store preservation. Installed credential-store behavior remains unverified. |
| AUTHSEL-10 | Synthetic: API switch needs billing confirmation and the execution key enters the selected CLI via stdin; no automatic API fallback. No billed real call was authorized. |
| AUTHSEL-11 | Partial: private local selection state stores choices, account email labels, and opaque correlations, never tokens or API keys; key input avoids CLI arguments/logs, and local management remains outside GPT tools. Full built-artifact and UI/log inspection remains. |
| AUTHSEL-12 | Partial: local setup/settings now distinguish the email and workspace fingerprint recorded at last apply from the latest observed workspace. Verified candidates and staged choices carry a workspace fingerprint and billing route from their own probe; shared API billing still requires explicit confirmation. A selected CLI without active-session identity support shows the shared Keyring ChatGPT limitation for a selectable or explicitly fixed shared home. Email and workspace hash do not prove ownership alone. Human-readable workspace/organization/project names, supported-model differences, exact cost target for unverified sources, and remote account details remain incomplete. |
| AUTHSEL-13 | Partial: local method/store/workspace values share one parser. Candidate/shared probes and new admission reject conflicting effective method, workspace, and managed credential-store values. A managed Keyring/auto choice no longer treats a stale shared `auth.json` as ownership evidence; an unknown active owner blocks selection. Installed effective-policy provenance and actual workspace identity are not verified end to end. |
| AUTHSEL-14 | Partial: schema-30 thread and Job metadata persist non-secret auth boundaries; legacy rows and completed results are retained but unowned threads cannot resume and an old request cannot be re-executed under a new connection. New owner boundaries include user and selected workspace; older workspace-only records stay stored but are not automatically attributed to a newly verified user. Original Job session results retain their admitted owner after an external login change, including terminal retry; session retention and in-memory rollback use that same owner. Unknown Keyring identities use a temporary process boundary until confirmed. Normal CLI replacement preserves the stable owner boundary, but an in-place replacement still requires runtime revalidation. The known-home choice now warns that conversations, skills, and settings may differ while history is retained. App resume, skills, and setting combinations need product acceptance. |
| AUTHSEL-15 | Partial: absent saved choice defaults to existing shared auth, and explicit `CODEX_HOME` remains authoritative. Existing independent/API installations and their upgrade paths need installed acceptance. |
| AUTHSEL-16 | Partial: full four-worker Node passed 1,062/1,062 tests in 109 files; the historical process-probe timing failure did not recur and remains unclassified. The selected-CLI/auth-source product matrix passed 10/10, covering explicit shared home, saved Bridge-owned ChatGPT/API profiles, and a previously configured external home across app, terminal, and Bridge CLI choices. Separate HTTP MCP product-path cases passed live original-worker question proof, pre-send block followed by proof recovery and one delivery, lost upstream reply without a resend, and original-worker cancellation after external login change. The question cases retain fixed-owner result persistence and exact ACK; cancellation stays blocked without live original-worker proof. TypeScript and Swift UI build, 215 Swift tests (2 skipped), nine-language localization, and settings visual acceptance including a known external home and its continuity warning passed. The pinned App Server schema check passed separately at an earlier checkpoint; the selected installed CLI's isolated schema inspection confirms core compatibility without `account/sessions/list`. Installed `b24bb26` ran with matching Helper/bridge builds, a connected tunnel, and reported login availability, but it predates these source corrections. Candidate bundle identity is tracked in the PR verification; real-account, billed API, and user acceptance evidence remain outstanding. |

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
