# Authentication issues #208 and #210: acceptance status

This is a checkpoint for the implementation based on `origin/dev` at
`031c193`. It is not evidence that either GitHub issue is complete. The issue
checkboxes require separate product and operational evidence; a green unit
test or a successful build cannot substitute for it. No operating login,
running bridge, or installed Codex app was changed for this checkpoint.

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
- The installed CLI `0.158.0-alpha.2.1` generated its TypeScript App Server
  schema in a temporary home without authentication. It includes
  `account/read.workspaceRouting.chatgptAccountId` and a nullable usage
  `accountId`. A separately installed temporary CLI `0.153.3` passed the pinned
  schema reproducibility check (416 JSON and 827 TypeScript files). Neither is
  a real login test. The earlier `c6cf380` signed candidate is stale after
  these source and schema changes; the PR description carries later artifact
  identity when available.

Status terms: **synthetic** means implementation exercised with fake accounts
or local fixtures; **partial** means a stated part is missing; **live** means
the item needs an independently authorized, isolated real-account or installed
app acceptance run.

| #208 condition | Current evidence and outstanding work |
| --- | --- |
| LOGIN-1 | Partial: [source/installation chronology](2026-09-29-auth-connection-evidence.md) separates report, observed guard rejection, and conditional source hazard. The original sign-out timeline and installed build identity remain unknown. |
| LOGIN-2 | Synthetic: five opt-in live probes no longer copy operating `auth.json`; build/package paths remain free of automatic live auth runs. Recheck the shipped package and any external agent automation. |
| LOGIN-3 | Synthetic: marked persistent independent test home and fixture coverage. No independently signed-in test profile was supplied or used. |
| LOGIN-4 | Partial: selected source, home, generation, and CLI are projected through launcher/Helper/server. New task admission reads the selected App Server's effective policy before resolving saved Agents. Operating applied settings and installed managed-policy provenance were not inspected. |
| LOGIN-5 | Synthetic: initial unknown, account-read → recovered file for the same explicit account ID, temporary read failure, stable refresh identity, and same-email/different-account rejection. A documented `account/read` email alone is not used as ownership proof. Real keyring and external-account changes remain live checks. |
| LOGIN-6 | Partial: transient admission observations can recover without relogin. Existing App Server re-read/reconnect behavior after an external login is unverified. |
| LOGIN-7 | Partial: no automatic login/API fallback; authentication switch blocks protected stored work, interactions, and undelivered results. New Jobs and schema-30 sessions persist a non-secret owner boundary; old completed results remain stored but cannot be replayed as executions. Active mismatched Jobs remain readable but cannot recover, be ACKed, cancelled, answered, or steered under a new owner. Queue, transport ACK, and existing-thread behavior still need product acceptance. |
| LOGIN-8 | Live: candidate installation, app replacement, Helper survival, and original Codex app login through a later refresh were not exercised. |
| LOGIN-9 | Synthetic/source audit: no raw credential copy, logout, deletion, or forced refresh was added to routine diagnostics. Actual refresh error type was not observed. |
| LOGIN-10 | Partial: this follow-up passed 1,029 Node tests, TypeScript compilation, release/localization checks, and the isolated pinned App Server schema check. The preceding checkpoint passed 212 Swift tests (2 skipped), nine-language native localization checks, and synthetic settings/setup visual checks. Candidate bundle evidence is tracked with its exact HEAD in the PR description. Installed and user acceptance remain separate. |
| LOGIN-11 | Live: independent-copy and no-copy shared-store multi-process refresh must be measured separately with the selected CLI; neither was injected into operating auth. |
| LOGIN-12 | Partial: account observation is correlated and stale read results are rejected on local revision changes. External changes without file revision and missing `account/updated` need installed-CLI tests. |
| LOGIN-13 | Partial: account/model/usage paths remain separate; fake candidate model checks are present. Real partial 401/refresh cases and actual turns remain unverified. |
| LOGIN-14 | Partial: first sign-in and explicit local management remain; unavailable observation blocks new admission without changing credentials. Every new admission checks current local and effective App Server login, workspace, and store restrictions before resolving a saved Agent; a temporary effective-policy read failure is retryable. Installed policy-change and running-worker behavior remain unverified. |
| LOGIN-15 | Partial: shared local policy uses one top-level TOML parser, including valid inline comments; candidate, shared selection, and new admission use the same effective-policy comparison for `config/read` and `configRequirements/read`. The installed CLI's actual policy provenance, workspace identity, and original machine causality remain unverified. |
| LOGIN-16 | Partial: official documentation and upstream reports are distinguished in the [evidence record](2026-09-29-auth-connection-evidence.md). Installed CLI 0.158.0-alpha.2.1 behavior was not tested for refresh fixes. |

| #210 condition | Current evidence and outstanding work |
| --- | --- |
| AUTHSEL-1 | Partial: one local manager and shared Swift controls offer the three choices in setup/settings. Same-account and different-account real login are untested. |
| AUTHSEL-2 | Partial: CLI and auth source are separate, explicit `CODEX_HOME` wins, and remote client shows read-only server source. Product login/model/usage/turn combinations are unverified. |
| AUTHSEL-3 | Partial: shared/default, unknown account, ChatGPT/API, and no automatic credential copy/login are handled. Multiple previously saved bridge-owned profiles can be selected and reverified without replacing their credentials. `account/read` routing identifies the selected workspace without usage availability, but a Keyring ChatGPT login also needs the active-session user ID. The inspected CLI `0.158.0-alpha.2.1` lacks that method and is blocked for new Keyring ChatGPT work; managed Keyring API without a verifiable owner remains blocked. Discovery and selection of multiple external existing sources remain unimplemented. |
| AUTHSEL-4 | Partial: candidate prepare, persisted login intent before browser/API process launch, CLI exit, verify, stage, pending cancel, and launch-specific activation are implemented. A restarted Helper reports an unconfirmed login result rather than success. A local review action can clear a failed activation only while holding the launcher lock, after confirming no managed runtime or protected work remains; it retains the old selection, pending choice, and a stopped-unconfirmed record. Real failure recovery remains untested. |
| AUTHSEL-5 | Synthetic: bridge-owned file profiles live under persistent runtime home and survive candidate cancellation. Rebuild/reinstall/CLI replacement with real credentials needs acceptance. |
| AUTHSEL-6 | Synthetic: new profile/credential preparation is separate from the applied store and never restores old auth files. Activation re-probes account/CLI/policy, selects the pending profile only for a launch-specific ID, and commits after readiness and exact owned-profile home confirmation. All mode-pair and A→B/key-rotation product cases remain untested. |
| AUTHSEL-7 | Partial: graceful apply and stored retention protection prevent routine switching with active work, pending input, or uncollected results. New execution and request replay require current user/workspace confirmation. After a confirmed change or logout, an existing Job's question/cancellation requires its original live worker generation and turn; its ACK requires the original executor's retained receipt. Restarted bridges defer persisted execution recovery until the new process confirms the matching owner, and retry after a later successful admission. Old Job history remains stored. Other queue/transport/result delivery paths still need product verification. |
| AUTHSEL-8 | Partial: state revisions and candidate CLI/account/credential fingerprints reject common stale actions; a launched runtime failure leaves the prior selection and an uncertain activation marker. Explicit stopped-runtime reconciliation records an unconfirmed outcome and never restores credential files. Browser/API login intent and logout intent are durable before their side-effecting calls. Cross-Helper cancellation and other late-callback cases remain. |
| AUTHSEL-9 | Partial: bridge disconnect leaves shared login untouched. Explicit inactive bridge-owned ChatGPT logout and API key removal exist with confirmation, effective storage-policy checks, and protected-work preflight; synthetic tests cover lost logout replies and shared-store preservation. Installed credential-store behavior remains unverified. |
| AUTHSEL-10 | Synthetic: API switch needs billing confirmation and the execution key enters the selected CLI via stdin; no automatic API fallback. No billed real call was authorized. |
| AUTHSEL-11 | Partial: private local selection state stores choices, account email labels, and opaque correlations, never tokens or API keys; key input avoids CLI arguments/logs, and local management remains outside GPT tools. Full built-artifact and UI/log inspection remains. |
| AUTHSEL-12 | Partial: candidate and staged account email is shown only in local management alongside an owner fingerprint; email never proves execution ownership. Source/mode and account/usage cache checks remain separate. Shared users before a staged probe, workspace, verified capability, cost target, and remote details are still incomplete. |
| AUTHSEL-13 | Partial: local method/store/workspace values share one parser. Candidate/shared probes and new admission reject conflicting effective method, workspace, and managed credential-store values. A managed Keyring/auto choice no longer treats a stale shared `auth.json` as ownership evidence; an unknown active owner blocks selection. Installed effective-policy provenance and actual workspace identity are not verified end to end. |
| AUTHSEL-14 | Partial: schema-30 thread and Job metadata persist non-secret auth boundaries; legacy rows and completed results are retained but unowned threads cannot resume and an old request cannot be re-executed under a new connection. New owner boundaries include user and selected workspace; older workspace-only records stay stored but are not automatically attributed to a newly verified user. Unknown Keyring identities use a temporary process boundary until confirmed. Normal CLI replacement preserves the stable owner boundary, but an in-place replacement still requires runtime revalidation. App resume, skills, and setting combinations need product acceptance. |
| AUTHSEL-15 | Partial: absent saved choice defaults to existing shared auth, and explicit `CODEX_HOME` remains authoritative. Existing independent/API installations and their upgrade paths need installed acceptance. |
| AUTHSEL-16 | Partial: 1,037 Node tests, TypeScript compilation, and Node release/localization checks passed with the current implementation; the exact replacement-controller binding test also passed after the full run. Candidate assembly passed 212 Swift tests (2 skipped), nine-language native localization validation, and ad-hoc signature verification. The pinned App Server schema check and synthetic native visual checks passed at preceding checkpoints. The exact candidate source commit and build ID are tracked in the PR description; a later source change requires a new bundle. Separate installed, real-account, billed API, and user acceptance evidence is outstanding. |

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
