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

The clean signed candidate identity and bundle-specific native gates are
recorded in the following candidate checkpoint. The new candidate supersedes
`21c31e8` as the proposed installation target and remains uninstalled.

## Operating acceptance still open

The operating app remains `f6b98c46724d:f344f196e4a6` with the independently
signed-in Bridge ChatGPT profile. Its existing 15-minute natural-refresh
monitor remains active. A later actual refresh has not yet been established.
Natural-refresh evidence, separately authorized installation, broader real
supported-mode/UI acceptance and `dev` integration remain pending. Branch,
worktree, original credential stores and retained result records are preserved.
