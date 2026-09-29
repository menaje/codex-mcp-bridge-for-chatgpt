# Authentication connection evidence — 2026-09-29 KST

This records the non-destructive implementation investigation for issues #208
and #210. It does not claim to reconstruct the user's earlier logout events.
The user reported that the Codex app itself also signed out. The previously
observed `CODEX_AUTH_CHANGED` response proves only that the bridge's guard
rejected an admission; it does not prove that the guard caused the sign-out.

| Subject | Source/build and CLI evidence | Store and policy evidence | Authority and process boundary |
| --- | --- | --- | --- |
| Repository source | Work started from `origin/dev` at `031c193`; earlier issue analysis used `44072d5` | The code previously copied `auth.json` in five opt-in live probes | Source inspection establishes a hazard, not the field cause |
| Installed native app, Helper, launcher, server | Local bundle reported product `0.4.1` and helper, launcher, server processes were present; exact build commit was not established | Applied environment and account state were not queried from the operating service | Existing processes were not restarted or replaced for this investigation |
| Installed ChatGPT Codex CLI | Local help/version reported `codex-cli 0.158.0-alpha.2.1` and `login --with-api-key` reading standard input | The operating `auth.json` and `config.toml` existed with private permissions; contents, tokens, and claims were not collected | Running Codex app and CLI processes were present; no authentication request was sent |
| Live probes | Five scripts had the opt-in `--run-authenticated` entry | Each copied the operating `auth.json` to a disposable home with file credential storage | Their independent token refresh could leave the operating file stale; no live probe was run in this investigation |
| New test policy | All five probes now require a marked, persistent test home | No source path copies operating credentials; test profile rotation survives synthetic-project cleanup | Tests without an independently signed-in profile are unverified, not replaced with operating credentials |

The likely sequence behind the source hazard is: active token copied to a
disposable home, test profile refreshes first, operating client later tries its
older token, and the disposable latest state is deleted. This is a conditional
mechanism, not a confirmed timeline for the reported sign-outs. A separate
same-store, multi-process refresh race remains a distinct upstream and
installed-CLI question. No operating token expiry, revocation, login, logout,
or policy mismatch was injected or observed here.

The bridge guard previously used one `keyring-or-unavailable` value for every
unreadable state. The new guard does not pin that value as identity; file-based
identity is stable across access-token refresh, and a keyring profile can use
an `account/read` correlation when Codex provides one. Transient read failure
blocks only a new admission and can recover without resetting the worker.
The account, model, usage, and actual turn paths remain separately observable;
a successful read is not a guarantee of a future refresh or of another
process's current state.

The local `forced_login_method` and `forced_chatgpt_workspace_id` values now
participate in the file-based admission boundary. Managed policy files and a
previously running process's effective configuration were not inspected in
this audit. The [official authentication guide](https://learn.chatgpt.com/docs/auth)
states that a credential/policy mismatch can make Codex log out and exit; this
is a separate possible cause, not a diagnosis for this machine.

Verification evidence is limited to synthetic Node and native tests, source
inspection, and read-only local installation metadata. Installing a candidate
app, reproducing the prior failure, testing independently signed-in profiles,
API billed execution, and observing the original app through a later token
refresh require a separately approved acceptance run and are not represented
as completed by this record.

The implementation checkpoint ran `npm run check` (109 test files, 990 Node
tests) and the macOS bundle build's Swift suite (212 tests, 2 skipped) before
the final local-policy and unknown-keyring-boundary changes. Focused tests for
those changes passed afterward. The app bundle is an ad-hoc signed build
artifact in the task worktree, not an installed product or an operating auth
test. See [acceptance status](2026-09-29-auth-acceptance-status.md) for each
unmet condition.
