# Current API authentication and display scope

## Approved scope

The operator directed the Bridge to omit information that the current API does
not provide and to align authentication with current capabilities rather than
implement Keyring itself. The subsequent go-ahead covers source, UI, tests,
documentation and a new separately built candidate. It does not authorize an
operating installation, a paid API turn, PR integration or issue closure.

At Sep 30 **18:34 KST**, after the source and audit reviews, the operator
separately approved the `238dcc2` installation acceptance step, including app
replacement and service restart while preserving the current profile and all
13 retained results. The authorized installation checkpoint below supersedes
the earlier uninstalled state. Paid execution, PR merge and issue closure were
not part of this approval.

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

## Clean candidate checkpoint before installation

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
| Operating installation | Uninstalled at this build checkpoint; subsequently installed under the separate authorization below. |

The new candidate supersedes `21c31e8` as the installation target.
Audit-only commits after this checkpoint do not change its embedded source
commit or either operating bundle identity. The prior candidate remains
preserved.

## Accepted source-scope review

The Sep 30 review inspected product source
`238dcc2f7609efb793125bc63b0fbc38aa73cee8`, its changed tests, the PR and the
audit follow-up at remote HEAD
`34b4cffaa6c3df6b357af834f8f0d6fbc3485ca6`. It accepts the implementation
within the approved current-API scope and found **no newly confirmed
implementation defect in the reviewed changes**. Keyring and API-unprovided
metadata are excluded scope, not incomplete requirements or reasons to repeat
the same implementation.

The review confirms that file user/workspace proof, effective storage and
administrator policy, account-change admission checks, and the rejection of
stale files or unrelated ambient keys remain enforced. Omitted display fields
do not remove API billing consent, candidate validation, activation/error
states, cancelled-writer quarantine or explicit disconnect/cancel controls.
Confirmed zero values remain valid data. The removed hypothetical success
tests and the retained negative/ownership/usage tests give no identified basis
to treat the change from 1,087 to 1,085 cases as weaker validation.

| Evidence | Review level |
| --- | --- |
| Product source and changed tests | Inspected; current support-scope correction accepted. |
| Node and Swift totals | Author-local full-run records reviewed; suites not rerun by this reviewer. |
| Manager, separate Helper and compound transport cases | Existing accepted scope and records compared against the changes. |
| Browser and 27 AppKit scenarios | Generation/regression/inspection records reviewed; no new installed UI check. |
| Candidate commit, build ID and signature | Saved identity and signature evidence reviewed; app file not independently rechecked. |
| GitHub Check Runs | Reviewer reported zero for the product source; local passing totals are not independent CI results. |
| Operating state and 15-minute monitor | Repository records reviewed; neither was queried live by this reviewer. |

Source `238dcc2` can proceed to the **separately authorized installation
acceptance step**. This review does not execute or approve installation and
does not authorize `dev` integration before the remaining real-environment
acceptance. The installation target stays `238dcc2f7609:aac9a831bcdb`, the
operating build stays `f6b98c46724d:f344f196e4a6`, and the reviewed remote
HEAD is an audit-only commit. Preserve the current profile and all 13 retained
results, then compare exact app/Helper/Bridge identities after any authorized
installation. New login or forced refresh is not needed for that comparison.

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

## Authorized installation acceptance

The approved replacement used the existing production lifecycle coordinator
with **`force:false`**. It rechecked the exact `f6b98c4` baseline, applied
profile/generation and zero active work, pending input, protected memory-only
threads and background processes. The shutdown receipt matched the request
and reported `completed`; both local sockets and all related app/runtime
processes were absent before replacing the bundle. No force stop or result
receipt change was used.

The retained `238dcc2` app was copied to a separate staging location and its
embedded source/build identity and deep strict signature checked before the
shutdown. The prior installed app was moved to
`/Users/seongsik/.codex-mcp-bridge/install-backups/installed-f6b98c46724d-20260930-153nf2ni.app`.
The staged replacement was moved to
`/Applications/Codex MCP Bridge for ChatGPT.app`, its deep strict signature
was checked again, and only the installed app was opened. The retained
candidate and previous installed bundle remain preserved. The empty staging
directory was removed after the successful move.

The installed app's embedded identity is unchanged from the clean candidate:
source `238dcc2f7609efb793125bc63b0fbc38aa73cee8`, build
`238dcc2f7609:aac9a831bcdb`, source hash
`aac9a831bcdb896bc5ca77ae6cd4e9ab405b8caf480a14ca7de0b82d3da3771f`,
`dirty:false`. The app process runs from that installed path. The first
18:40 KST probe found Bridge connected while Tunnel was reconnecting; by
**18:42 KST** both were connected and lifecycle completed. The final
**18:47 KST** checkpoint confirms:

| Installed check | Result |
| --- | --- |
| App / Helper / Bridge | Exact build `238dcc2f7609:aac9a831bcdb`; running, lifecycle completed, Bridge/Tunnel connected. |
| Applied and effective authentication | Same Bridge-owned ChatGPT profile and running home; generation **1**; no pending or uncertain activation. |
| Work | Zero active Jobs, admissions, pending input and background processes. |
| Protected retained results | All **13** original payload and delivery-record hashes unchanged; five `host-accepted`, eight `acceptance-unknown`. |
| Bridge account / usage | Authenticated ChatGPT, available usage with **one window** through the same profile; `account/read` used `refreshToken:false`. |
| Original Codex desktop | Authenticated usage read succeeded; Sep 30 desktop authentication 401 count **zero**. |
| Credential-store metadata | Shared/profile auth-file mtimes unchanged at `2026-09-28T23:12:34.167Z` / `2026-09-30T03:23:13.881Z`. |
| Natural-refresh event | Not established; initial profile login-log mtime `2026-09-30T03:23:13.472Z` and zero refresh-marker lines. |

No login/logout, authentication-source switch, credential transfer, forced
token refresh or billed execution was performed. These observations establish
the approved app replacement, exact running identities, retained-profile/result
preservation and non-billed authenticated reads. They do not establish a paid
model turn, supported-mode switching or continuity after an actual later
natural refresh.

Direct installed native UI inspection remains unverified: two computer-use
lookups of the exact installed app path timed out, and the bundle-ID lookup
was ambiguous because preserved older app copies share it. The existing
isolated 27-scenario AppKit and dashboard browser evidence is retained; it is
not substituted for inspection of the installed app's screen. No new product
defect is established by this tool limitation.

The existing **15-minute ACTIVE heartbeat** now watches installed build
`238dcc2f7609:aac9a831bcdb`, with the same profile, result and credential-mtime
baselines. Its name, interval, destination and quiet notification behavior
are preserved. Healthy status, elapsed time and file mtimes remain insufficient
proof of refresh.

## Operating acceptance still open

The operating app is now `238dcc2f7609:aac9a831bcdb`, preserving the
independently signed-in Bridge ChatGPT profile. Its existing 15-minute
natural-refresh monitor remains active. A later actual refresh has not yet
been established. Natural-refresh evidence, broader real supported-mode,
policy/reconnect and installed UI acceptance, and `dev` integration remain
pending. Branch, worktree, original credential stores, previous app bundles
and retained result records are preserved; safe Git cleanup follows integration.
