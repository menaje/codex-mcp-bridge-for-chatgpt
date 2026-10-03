# Issue #225 independent execution acceptance

This record separates code/fixture evidence, native CLI storage evidence and
real-account/Dot acceptance. No absent observation is a pass. SIWC #214 remains
outside the current implementation.

## Implemented scope

- #219 work access, replay, recovery, admission and inherited-session protection
  were integrated through [PR #226](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/226),
  commit `f6da4704b0ffc7966303d9577d8f267b7e833f5c`, merge
  `d7eb60799a4ef3ad7e911e7a82cc7a5666fbce2d` on `dev`.
- The independent-storage implementation was integrated through
  [PR #227](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/227), commit
  `8eda683660e848bfb7dab80b8904894cf0ab219b`, merge
  `148e55acafdf6ea93e245b82efeee522e7ad0ca7` on `dev`.
- New installation discovery recommends the managed CLI; saved/explicit choices
  remain authoritative. Installation and switching require explicit actions.
- New login profiles share owned rollout/archive directories and SQLite state.
  Credentials remain in separate native profile homes. Legacy stores are not
  adopted or moved. Changed storage bindings block new work.
- Conversation persistence defaults to durable and is independent of the app
  visibility preference. Existing memory-only conversations retain their actual
  lifetime. Private-store app opening is unverified.
- Native Codex still owns login/refresh. Candidate verification, pending apply,
  billing confirmation, cancellation and failure recovery remain in place.

## Evidence on 2026-10-03

| Layer | Observation | Status |
| --- | --- | --- |
| #219 synthetic regression | Full validation: 1,307 TypeScript tests; CLI 0.153.3 schema check; 218 Swift tests, 2 skipped, 0 failures | PASS |
| Native layout feasibility | Empty homes, deterministic loopback Responses provider; CLI 0.153.3 and 0.160.0 completed one turn, retained its rollout, read/resumed the same thread after profile change/process restart, and created a distinct persistent fork | PASS |
| Implemented profile projection | Profiles created by `CodexAuthSelectionManager`, projected by the actual environment helpers; native CLI 0.153.3 and 0.160.0 retained one completed turn across restart/profile change and persistent fork | PASS |
| Independent storage code | Full validation: 1,320 TypeScript tests across 121 files; CLI 0.153.3 schema check; 218 Swift tests, 2 skipped, 0 failures. Ownership/tampered-link/SQLite guards, legacy paths, separate credentials, explicit storage preferences and runtime selection regression | PASS |
| Actual account A → B → A | No real account login/switch performed | NOT RUN |
| Existing independent Bridge CLI with Dot | User reports successful simultaneous use in the already installed managed-CLI/separate-login environment; the earlier disconnect was observed on the Dot side | USER-REPORTED PASS for that existing environment |
| Real login cancellation/refresh and app update during Bridge work | No operating authentication or app process changed | NOT RUN |
| Private store discovered/opened by desktop app | No supported opening route demonstrated | UNVERIFIED |

The [sanitized evidence record](issue-225-independent-execution.evidence.json)
binds these observations to implementation commits, source file SHA-256 values,
native binary/log hashes and the native thread/fork identities. The raw temporary
probe outputs stay outside the release payload. The record includes no operating
credential, user conversation content or production storage path.

The complete Node run includes `issue221Delivery`, `issue221Profiles`,
`issue221Summary`, `stdioServer` and the tools tests. Ordinary result delivery
remains `direct-wait`; canonical replay returns the admitted Job. Retired card
delivery remains rejected, and a status card does not relay completion or execute
a follow-up. The new authentication and persistence defaults do not restore that
retired route. The archive also includes the new storage modules, verified by
importing the environment helper from an unpacked npm package.

The native provider is synthetic even though the binaries and native storage
operations are real. No OpenAI model request, credentials, account refresh,
production transcript, installed application replacement or operating Bridge
restart is used by these probes. Native rollout paths may retain the original
profile's linked path; deleting retained profile directories is not supported.

## Accepted existing-environment evidence

On 2026-10-03 the user clarified that concurrent Bridge/Dot work had already
been exercised successfully in the existing Bridge CLI environment and asked
not to repeat that live experiment merely to verify its new default. This
report reuses that user-provided evidence. It does not claim that Codex ran an
additional Dot task, verified each start order or reproduced the previous
disconnect. Read-only inspection
confirmed that the operating installation already selected managed CLI 0.160.0
and a distinct Bridge login home, from installed source
`a16cc51f20af396ba05d83b8d165240b52d528b5`. Its legacy profile has not been moved
into the new shared conversation store.

The current code additionally changes work access, session retention and new
profile persistence. Those changes are validated by synthetic regressions and
native storage probes. Real account A → B → A and login refresh/cancellation
were not performed against operating credentials. The user's existing
concurrency observation is not silently used as proof of those other cases.

## Optional live acceptance for changed storage/authentication paths

A repeated Bridge/Dot baseline run is not required for this change, per the
user's explicit direction. If further live storage/account evidence is needed,
use designated test accounts and a disposable project. Keep ordinary `direct-wait`
(#221) as the result path. Status cards must not relay completion or launch a
follow-up. Record the Bridge/CLI/app versions, integration commit, storage roots
with credentials redacted, canonical request ID, original thread/turn, worker
and generation, terminal result and committed result/ACK evidence.

1. Change the applied test login A → B → A through candidate verification and
   safe apply. Read existing Activity/Agent/Job/results at each step; replay the
   same canonical request and verify one original Job. Continue/fork the same
   durable thread only when its original store and current CLI support it.
2. Fail/cancel a separate candidate login and confirm the applied Bridge and
   desktop logins remain usable. Exercise native refresh separately.
3. Cancel and restart test work, recover the exact original executor result,
   and verify that replay does not submit another turn or acknowledge a foreign
   worker receipt. Distinguish graceful restart from simulated worker loss.
4. Keep the app visibility preference off and confirm durable Bridge context
   survives restart. Any app discovery/opening result is a separate observation;
   do not infer it from persistent storage or a successful app launch.

Do not claim the unperformed portions of this live matrix completed. The
existing concurrency baseline is accepted from the user; any additional native
account/application assertions require their own actual evidence. Storage/account access
failures should preserve history and explain the blocked condition, not select
another installation, replay work or create a replacement conversation.

## Follow-up: missing shared storage directories

Review found that preparing another profile could recreate a missing `sessions`,
`archived_sessions` or `sqlite` directory in an existing owned store. This could
make an older profile's binding validate against an empty directory while the
original data remained elsewhere. First creation now initializes those
directories; reuse requires all three to exist and never fills missing paths.
An interrupted existing initialization also stays unavailable until restored.

The local isolated regression in
[executionStorage.test.ts](../../test/executionStorage.test.ts) covers each
directory through both the helper and `CodexAuthSelectionManager.prepare()`:
preparation is rejected, no empty replacement is created, data/credentials and
saved selection remain intact, and the older profile still reports
`CODEX_STORAGE_UNAVAILABLE`. Restoring the original directory permits reuse of
the same store. These three cases failed before the fix and pass afterwards;
all 11 storage tests pass on macOS with Node 24.11.1.

Release metadata, schema compatibility and the Node build passed locally. The
full Node attempt recorded 1,313 passes and 10 process/socket/time-limit failures
across five suites; rerunning those suites alone with one worker passed all
119 tests without changing code, assertions or timeouts. The initial full
invocation remains a failed run, rather than being reported as a clean PASS.

The JSON record above remains historical evidence for #227's implementation
commit. This follow-up has separate local validation; it adds no real-account,
Dot concurrency or installed-runtime observation to the earlier evidence.

## Full regression confirmation after #229

After [PR #229](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/229)
merged, the unchanged `dev` commit
`7bebd8fb0dfc73674adfdb0ab0f97cadfc15145d` passed one complete local
`npm run validate:full` invocation on 2026-10-03. A fresh temporary worktree
used its own locked `npm ci` dependencies, temporary Node 22.16.0/npm 10.9.3,
macOS 26.6.2 arm64 and Apple Swift 6.3.3. Native schema validation used the
repository's pinned Codex CLI 0.153.3. Product code, test assertions, timeouts
and the existing four-worker Node test command were unchanged.

| Check | Result in this single invocation |
| --- | --- |
| Release metadata, localization and Node build | PASS |
| Full Node regression | 1,323 passed, 0 failed across all 121 files |
| App Server schema compatibility | PASS; CLI 0.153.3, 416 JSON and 827 TypeScript files |
| Full Swift regression, strict concurrency and warnings as errors | 218 tests, 2 skipped, 0 failures |
| Complete command | Exit 0 |

The [full regression evidence](issue-225-full-regression.evidence.json) records
the exact tested commit/tree, runtime and dependency versions, source hashes,
build identity and local log hashes. Subsequent changes in this documentation
follow-up are confined to evidence and a release change fragment; they do not
change the tested product, dependency lock, test configuration or assertions.

The earlier Node 24 full attempt remains a failed run with 1,313 passes and
10 failures. Its 119-test isolated retry overlaps that attempt and is never
added to either full-run total. The new run confirms a complete pass in its
recorded environment; it does not establish the cause of the earlier failures,
prove repeated-run stability or constitute a GitHub CI pass. If a parallel
failure recurs, preserve that run and investigate it separately from the
accepted storage fix.

This is development-source integration evidence. The next release candidate
still requires validation at its exact final commit and artifact inputs under
the release governance. No candidate, tag, release, installation update,
operating account switch or additional Dot concurrency experiment was performed.
Previously unperformed operating acceptance items remain unperformed.
