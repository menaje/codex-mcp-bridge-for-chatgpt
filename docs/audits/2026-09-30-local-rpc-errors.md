# Native local-service error presentation

## Report and diagnosis

The operator reported intermittent menu-bar/settings text:
`로컬 서비스에 연결할 수 없습니다: Localized text is unavailable.`

The native presenter passed a raw RPC diagnostic to the semantic localization
resolver. An unknown key returned the missing-copy fallback. The presenter
mistook that fallback for a successful translation and returned before its
existing problem classification. Thus the message concealed the underlying
local-service failure.

A process-filtered read of the app's unified log found a helper-health failure
at **2026-09-30 13:23:49 KST**, from the then-installed `7116217` app. Its safe
diagnostic was `Resource temporarily unavailable`. The native client uses a
five-second health read deadline and categorizes a failed socket read as
`connectionFailed`; this is consistent with a response timeout. It does not
identify the specific later message the operator saw or establish why that
response was late. No corresponding health-failure event was found for the
replacement `a8dc7ec` app in the inspected interval.

The running Helper/Bridge/Tunnel were connected during diagnosis. The selected
separate profile was still applied, with no pending activation or active work.
The original Codex desktop's September 30 authentication-401 count was zero.
There is no observed sign-out associated with this report.

## Correction

- Resolve raw diagnostics only when they are known semantic keys; otherwise
  use the existing localized problem classification.
- Map socket timeout, unavailable-service, and denied-access causes to three
  specific messages in all nine supported languages.
- Recognize legacy English error wrappers using their authored `%@` template
  prefix. Semantic identifiers are not human-readable message prefixes.
- Preserve request deadlines and the Helper protocol. The correction improves
  error presentation; it does not establish that transient timeouts cannot
  recur.

## Verification

The initial unknown-diagnostic regression failed with the reported fallback in
all nine locale cases (18 assertions). The added regressions cover an unknown
remote diagnostic, its legacy connection wrapper, and typed connection/write
errors for timeout, unavailable socket, refused connection, and access denial.
Private diagnostic suffixes are not displayed.

After the correction, both focused native regressions passed with strict
concurrency and warnings-as-errors. The full four-worker Node suite passed
**1,078/1,078 tests in 110 files**; release, generated-localization, and
TypeScript build checks passed.
The App Server schema check also matched the repository's isolated CLI
**0.153.3** baseline (416 JSON and 827 TypeScript files). The first default-CLI
attempt was rejected because the operating CLI is 0.159.0; it was not replaced.

The exact clean source commit is
`f6b98c46724d0c23d966a251f4140af0a01089af`. Its separate arm64 bundle passed
**217 Swift tests, 2 skipped, 0 failures**, and compiled localization checks for
**1,403 strings across nine languages**. Deep strict ad-hoc signature
verification passed before and after installation. The embedded build identity
is **`f6b98c46724d:f344f196e4a6`**, with `dirty: false` and source hash
`f344f196e4a6057610f5aea9b31ab279f6e93e47f76bd1fdcaf2736f192feabb`.

## Installed acceptance

The idle `a8dc7ec` runtime completed a non-forced shutdown; its handoff receipt
matched the request and reported completion. App/runtime processes and sockets
were absent before bundle replacement. The old installed bundle is preserved
for rollback. No login, logout, or authentication-selection change was made.

At **2026-09-30 14:27:58 KST**, the installed app's Helper and Bridge both
reported the expected `f6b98c46724d:f344f196e4a6` build. Runtime and lifecycle
phases were running/completed, and both Bridge and Tunnel were connected.
Applied/effective selection and the running Codex home still matched the
separate profile at generation 1, without pending or uncertain activation.
Active Jobs, admissions, input, and confirmed background processes were zero.

All **13** original retained terminal payloads and delivery records remained
unchanged (5 host-accepted, 8 acceptance-unknown). Shared and profile auth-file
mtimes remained at their earlier baselines: September 29 08:12:34 KST and
September 30 12:23:13 KST respectively. The original desktop usage read
succeeded; its September 30 authentication-401 count remained **0**. No billed
execution or result-receipt mutation occurred.

These installed checks establish the new build and preserved service/auth
state. The error-copy regressions and compiled-language checks establish its
presentation correction. A real service timeout was not deliberately induced,
and the native menu-bar accessibility snapshot was unavailable from the
computer-use tool. Neither a full visual acceptance nor absence of future
timeouts is claimed. A later actual token refresh remains under observation.
The draft PR remains unmerged into `dev`.
