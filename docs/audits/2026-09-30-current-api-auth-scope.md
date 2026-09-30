# Current API authentication and display scope

## Approved scope

The operator directed the Bridge to omit information that the current API does
not provide and to align authentication with current capabilities rather than
implement Keyring itself. The subsequent go-ahead covers source, UI, tests,
documentation and a new separately built candidate. It does not authorize an
operating installation, a paid API turn, PR integration or issue closure.

Supported sources are verified file-backed existing homes, separate
Bridge-owned ChatGPT profiles, and file-backed API profiles. Explicit API keys
may also identify execution when the selected App Server confirms API mode
and effective storage policy permits that source. Keyring and unverifiable
auto/ephemeral storage are outside this release scope. Effective administrator
policy cannot be bypassed by choosing another profile.

## Implementation

- Remove the speculative `account/sessions/list` capability, RPC calls,
  active-session identity projection and hypothetical fixture responses.
- Require the existing file user/workspace proof for ChatGPT admission and
  candidate/shared selection. Workspace routing and email alone cannot prove
  a login user. Unknown managed storage cannot use a stale file or an unrelated
  ambient API key. A failed selection provides an action to choose a separate
  Bridge login or verified file connection.
- Keep nullable compatibility fields for old responses and persisted selection
  state; current API projections do not fill them with invented owner or
  workspace-name metadata. Owner/workspace fingerprints remain internal checks
  and are absent from the native UI.
- Omit unprovided names, unknown method/plan/billing rows and missing quota or
  cost cards in native settings, the menu bar and the ChatGPT dashboard card.
  Confirmed usage and separate admin-API cost values remain visible. A failed
  refresh may explain a retained confirmed value; actual authentication,
  policy, connection and activation failures remain actionable.
- Replace hypothetical Keyring-positive Job and IPC tests with isolated
  file-backed credentials. Preserve original-worker question, result ACK,
  history and account-change checks using supported ownership evidence.
- Preserve the accepted API-exit, separate Helper-process and compound
  request/result/ACK product-path checks from the previous review.

## Validation and candidate

The current server source passed the full four-worker Node suite: **1,085/1,085
tests in 111 files**, including the accepted separate Helper and compound
transport cases. Build, TypeScript, release/localization checks and the isolated
CLI **0.153.3** schema check passed (416 JSON / 827 TypeScript files). The
ChatGPT dashboard browser regression passed confirmed, retained and absent
usage cases, including the narrow layout.

The isolated native harness built the current UI with strict concurrency and
warnings as errors and generated **27 AppKit scenario renders**. The current
Codex settings/override and supplied/missing account values were inspected
visually: no internal fingerprint, speculative workspace name, blanket
Keyring warning or empty usage title/card was shown; provided usage, credits
and configured API costs remained visible. An API method localization key and
an English-duration formatting issue found during that inspection were fixed
and the renders regenerated. Harness text metadata describes scenarios; it
is not OCR evidence. Latest renders are under
`/tmp/bridge-current-api-scope-visual-reviewed-20260930/artifacts/`.

## Clean uninstalled candidate checkpoint

Source `238dcc2f7609efb793125bc63b0fbc38aa73cee8` was committed and pushed
before the separate app bundle was built. Its bundle gates passed **216 strict
Swift tests (two skipped, zero failures)**, **1,390 strings across nine
languages**, ten icon variants and strict release compilation. Deep strict
ad-hoc signature verification passed both before and after retaining the
arm64 candidate.

| Candidate field | Recorded value |
| --- | --- |
| Embedded source commit | `238dcc2f7609efb793125bc63b0fbc38aa73cee8` |
| Build ID | `238dcc2f7609:aac9a831bcdb` |
| Source hash | `aac9a831bcdb896bc5ca77ae6cd4e9ab405b8caf480a14ca7de0b82d3da3771f` |
| Embedded dirty flag | `false` |
| Embedded build timestamp | `2026-09-30T08:41:41.951Z` |
| Retained app | `macos/build/candidates/238dcc2/Codex MCP Bridge for ChatGPT.app` |
| Operating installation | Not installed or launched |

The new candidate supersedes `21c31e8` as the proposed installation target.
Audit-only commits after this checkpoint do not change its embedded source
commit or either operating bundle identity. The prior candidate remains
preserved.

## Read-only operating isolation checkpoint

At Sep 30 **17:49 KST**, the operating Helper and Bridge still reported
`f6b98c46724d:f344f196e4a6`; both connection paths were healthy. The applied
and effective Bridge-owned ChatGPT profile and running home matched, at
generation **1**, with no pending activation, active Jobs, admissions, pending
input or background processes. The **13** original terminal Job payload and
delivery-record hashes remained unchanged: five `host-accepted`, eight
`acceptance-unknown`. Nothing was acknowledged, offered, read-marked or
discarded by this check.

Original desktop usage was readable and Sep 30 desktop authentication 401
events remained **zero**. At **17:52 KST**, a non-billed Helper account/status
probe using `account/read` with `refreshToken:false` confirmed authenticated
ChatGPT mode and available usage with **one window** through the same profile.
The shared auth-file mtime remained `2026-09-28T23:12:34.167Z` and the profile
mtime remained `2026-09-30T03:23:13.881Z`. The profile login log retained its
initial `2026-09-30T03:23:13.472Z` mtime and contained zero refresh-marker
lines. These checks collected safe metadata and sanitized log counts, without
reading or copying credential contents. No operating replacement, restart,
login/logout, connection switch or billed turn was performed for the source
and visual checks.

Healthy requests and unchanged metadata do not establish an actual later
token refresh. That event remains unobserved, and its acceptance stays pending.

## Operating acceptance still open

The operating app remains `f6b98c46724d:f344f196e4a6` with the independently
signed-in Bridge ChatGPT profile. Its existing 15-minute natural-refresh
monitor remains active. A later actual refresh has not yet been established.
Natural-refresh evidence, separately authorized installation, broader real
supported-mode/UI acceptance and `dev` integration remain pending. Branch,
worktree, original credential stores and retained result records are preserved.
