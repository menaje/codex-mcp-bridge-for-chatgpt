# Authentication issues #208 and #210: acceptance status

This is a checkpoint for the implementation based on `origin/dev` at
`031c193`. It is not evidence that either GitHub issue is complete. The issue
checkboxes require separate product and operational evidence; a green unit
test or a successful build cannot substitute for it. No operating login,
running bridge, or installed Codex app was changed for this checkpoint.

Status terms: **synthetic** means implementation exercised with fake accounts
or local fixtures; **partial** means a stated part is missing; **live** means
the item needs an independently authorized, isolated real-account or installed
app acceptance run.

| #208 condition | Current evidence and outstanding work |
| --- | --- |
| LOGIN-1 | Partial: [source/installation chronology](2026-09-29-auth-connection-evidence.md) separates report, observed guard rejection, and conditional source hazard. The original sign-out timeline and installed build identity remain unknown. |
| LOGIN-2 | Synthetic: five opt-in live probes no longer copy operating `auth.json`; build/package paths remain free of automatic live auth runs. Recheck the shipped package and any external agent automation. |
| LOGIN-3 | Synthetic: marked persistent independent test home and fixture coverage. No independently signed-in test profile was supplied or used. |
| LOGIN-4 | Partial: selected source, home, generation, and CLI are projected through launcher/Helper/server. Operating applied settings and effective managed policy were not inspected. |
| LOGIN-5 | Synthetic: initial unknown, account-read → recovered file for the same explicit account ID, temporary read failure, stable refresh identity, and same-email/different-account rejection. A documented `account/read` email alone is not used as ownership proof. Real keyring and external-account changes remain live checks. |
| LOGIN-6 | Partial: transient admission observations can recover without relogin. Existing App Server re-read/reconnect behavior after an external login is unverified. |
| LOGIN-7 | Partial: no automatic login/API fallback; authentication switch blocks protected stored work, interactions, and undelivered results. New Jobs persist a non-secret authentication boundary; old completed results remain stored but cannot be replayed as executions, and active mismatched Jobs cannot recover under a new owner. Queue, transport ACK, and existing-thread behavior still need product acceptance. |
| LOGIN-8 | Live: candidate installation, app replacement, Helper survival, and original Codex app login through a later refresh were not exercised. |
| LOGIN-9 | Synthetic/source audit: no raw credential copy, logout, deletion, or forced refresh was added to routine diagnostics. Actual refresh error type was not observed. |
| LOGIN-10 | Partial: this checkpoint passed 1,011 Node tests, 212 Swift tests (2 skipped), and an ad-hoc signed macOS candidate bundle. Installed and user acceptance remain separate. |
| LOGIN-11 | Live: independent-copy and no-copy shared-store multi-process refresh must be measured separately with the selected CLI; neither was injected into operating auth. |
| LOGIN-12 | Partial: account observation is correlated and stale read results are rejected on local revision changes. External changes without file revision and missing `account/updated` need installed-CLI tests. |
| LOGIN-13 | Partial: account/model/usage paths remain separate; fake candidate model checks are present. Real partial 401/refresh cases and actual turns remain unverified. |
| LOGIN-14 | Partial: first sign-in and explicit local management remain; unavailable observation blocks only new admission. Candidate and shared selection probes check effective App Server policy, but ongoing execution admission still lacks a fresh effective managed-policy check. |
| LOGIN-15 | Partial: shared local policy uses one top-level TOML parser, including valid inline comments; candidate and shared probes compare effective `config/read` and `configRequirements/read` restrictions. The installed CLI's actual policy provenance, workspace identity, and original machine causality remain unverified. |
| LOGIN-16 | Partial: official documentation and upstream reports are distinguished in the [evidence record](2026-09-29-auth-connection-evidence.md). Installed CLI 0.158.0-alpha.2.1 behavior was not tested for refresh fixes. |

| #210 condition | Current evidence and outstanding work |
| --- | --- |
| AUTHSEL-1 | Partial: one local manager and shared Swift controls offer the three choices in setup/settings. Same-account and different-account real login are untested. |
| AUTHSEL-2 | Partial: CLI and auth source are separate, explicit `CODEX_HOME` wins, and remote client shows read-only server source. Product login/model/usage/turn combinations are unverified. |
| AUTHSEL-3 | Partial: shared/default, unknown account, ChatGPT/API, and no automatic credential copy/login are handled; discovery of multiple existing sources is not implemented. |
| AUTHSEL-4 | Partial: candidate prepare, persisted login intent before browser/API process launch, CLI exit, verify, stage, pending cancel, and launch-specific activation are implemented. A restarted Helper reports an unconfirmed login result rather than success; uncertain activation resolution after a failed launched runtime still needs a product path. |
| AUTHSEL-5 | Synthetic: bridge-owned file profiles live under persistent runtime home and survive candidate cancellation. Rebuild/reinstall/CLI replacement with real credentials needs acceptance. |
| AUTHSEL-6 | Synthetic: new profile/credential preparation is separate from the applied store and never restores old auth files. Activation re-probes account/CLI/policy, selects the pending profile only for a launch-specific ID, and commits after readiness and exact owned-profile home confirmation. All mode-pair and A→B/key-rotation product cases remain untested. |
| AUTHSEL-7 | Partial: graceful apply and stored retention protection prevent routine switching with active work, pending input, or uncollected results. New Job ownership blocks cross-auth replay and recovery; all queue/transport ACK/result delivery paths still need product verification. |
| AUTHSEL-8 | Partial: state revisions and candidate CLI/account/credential fingerprints reject common stale actions; a launched runtime failure leaves the prior selection and an uncertain activation marker. Browser/API login intent and logout intent are durable before their side-effecting calls. Cross-Helper cancellation, uncertain activation resolution, and other late-callback cases remain. |
| AUTHSEL-9 | Partial: bridge disconnect leaves shared login untouched. Explicit inactive bridge-owned ChatGPT logout and API key removal exist with confirmation, effective storage-policy checks, and protected-work preflight; synthetic tests cover lost logout replies and shared-store preservation. Installed credential-store behavior remains unverified. |
| AUTHSEL-10 | Synthetic: API switch needs billing confirmation and the execution key enters the selected CLI via stdin; no automatic API fallback. No billed real call was authorized. |
| AUTHSEL-11 | Partial: private local selection state stores choices, account email labels, and opaque correlations, never tokens or API keys; key input avoids CLI arguments/logs, and local management remains outside GPT tools. Full built-artifact and UI/log inspection remains. |
| AUTHSEL-12 | Partial: candidate and staged account email is shown only in local management alongside an owner fingerprint; email never proves execution ownership. Source/mode and account/usage cache checks remain separate. Shared users before a staged probe, workspace, verified capability, cost target, and remote details are still incomplete. |
| AUTHSEL-13 | Partial: local method/store/workspace values share one parser. Candidate/shared probes reject conflicting effective method, workspace, and managed credential-store values; ongoing execution-policy freshness and actual workspace identity are not verified end to end. |
| AUTHSEL-14 | Partial: thread and Job metadata have non-secret auth boundaries; legacy rows and completed results are retained but unowned threads cannot resume and an old request cannot be re-executed under a new connection. Unknown keyring identities use a temporary process boundary until confirmed. App resume, skills, and setting combinations need product acceptance. |
| AUTHSEL-15 | Partial: absent saved choice defaults to existing shared auth, and explicit `CODEX_HOME` remains authoritative. Existing independent/API installations and their upgrade paths need installed acceptance. |
| AUTHSEL-16 | Partial: 1,011 Node tests, 212 Swift tests (2 skipped), nine-language localization validation, and an ad-hoc signed candidate bundle passed locally. Separate installed, real-account, billed API, and user acceptance evidence is outstanding. |

Before merging or closing either issue, complete the missing code paths and
run the separately authorized isolated acceptance plan. The operation should
record candidate artifact/build identity, selected CLI and configuration
source, profile ownership, original-app sign-in state before and after a later
refresh, same-store multi-process outcome, model/usage/turn partial failures,
Job/result/ACK ownership across every switch, and any billed API cost limit.
Never prepare the test profile by copying the operating credential store.
