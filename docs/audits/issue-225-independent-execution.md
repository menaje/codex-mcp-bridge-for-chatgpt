# Issue #225 independent execution acceptance

This record separates code/fixture evidence, native CLI storage evidence and
real-account/Dot acceptance. No absent observation is a pass. SIWC #214 remains
outside the current implementation.

## Implemented scope

- #219 work access, replay, recovery, admission and inherited-session protection
  were integrated through [PR #226](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/226),
  commit `f6da4704b0ffc7966303d9577d8f267b7e833f5c`, merge
  `d7eb60799a4ef3ad7e911e7a82cc7a5666fbce2d` on `dev`.
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
additional Dot task or reproduced the previous disconnect. Read-only inspection
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

1. Start Bridge work first, then a distinct Dot task. Complete both and record
   that neither authenticates, cancels, resumes or changes the other's writer.
2. Start Dot first, then Bridge work. Complete both with the same evidence.
3. Change the applied test login A → B → A through candidate verification and
   safe apply. Read existing Activity/Agent/Job/results at each step; replay the
   same canonical request and verify one original Job. Continue/fork the same
   durable thread only when its original store and current CLI support it.
4. Fail/cancel a separate candidate login and confirm the applied Bridge and
   desktop logins remain usable. Exercise native refresh separately.
5. Cancel and restart test work, recover the exact original executor result,
   and verify that replay does not submit another turn or acknowledge a foreign
   worker receipt. Distinguish graceful restart from simulated worker loss.
6. Keep the app visibility preference off and confirm durable Bridge context
   survives restart. Any app discovery/opening result is a separate observation;
   do not infer it from persistent storage or a successful app launch.

Do not claim the unperformed portions of this live matrix completed. The
existing concurrency baseline is accepted from the user; any additional native
account/application assertions require their own actual evidence. Storage/account access
failures should preserve history and explain the blocked condition, not select
another installation, replay work or create a replacement conversation.
