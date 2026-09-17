# Issue 124 completion evidence — 2026-09-17

Issue: [#124 — remove foreground/background and use one durable asynchronous Codex execution contract](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/124)

## Result

The bridge now has one `codex_task` admission path. It validates the current
contract, commits the request ID and Job/Activity identity, starts execution
only after that transaction commits, and returns the durable running receipt
without waiting for Codex completion. Observation loss does not cancel the Job;
only the explicit cancellation contract requests cancellation.

This change does not claim that a GPT host received or acknowledged a terminal
result, and it does not add a GPT-state machine. Host delivery and automatic
conversation resumption remain the paired experiment's responsibility.

## Acceptance evidence

| Issue requirement | Evidence |
| --- | --- |
| One asynchronous contract, no foreground/background branch | `codex_task` input contract 6 rejects the retired field; schema 20 removes the Activity/Job columns and payload member; the deferred execution path commits admission before activation. |
| A Job longer than one minute does not delay admission | `test/tools.test.ts` returns the admission receipt in under 5 seconds, holds the admitted upstream Job running for 61 real seconds, recovers it by request ID, and then completes it. |
| Loss before admission is distinguishable | A custom Streamable HTTP client fails before dispatch; no Job or upstream call exists, `codex_status` reports no handle, and the exact retry admits one Job. |
| Loss after admission/while delivering the response is recoverable | A custom Streamable HTTP client cancels the admission response body after the server committed the Job. `codex_status` recovers the running Job by request ID, exact replay returns the same Job, and the upstream runs once. |
| Concurrent retry is deduplicated | Two simultaneous `codex_task` calls with the same scope, request ID, and request hash return one Job; one response is marked replay and only one upstream call occurs. Conflicting reuse remains rejected. |
| Disconnect is not cancellation | The HTTP abort regression verifies the Job stays running with no cancellation request, remains queryable by request ID, replays the same receipt, and later completes. Waiter abort paths remove their listeners and timers. |
| Terminal state is durable and atomic | Job registry fault injection covers initial and fallback terminal commit failures; Activity-store rollback covers Job terminal state, Activity transition, scope version, event, and outbox together. Memory never advertises an uncommitted terminal state. |
| Restart and retention do not replay work | Running Jobs restored after restart become interrupted without redispatch for every backend. History cleanup removes result detail while retaining request reservations, terminal facts, and protected uncertain/pending delivery records. |
| Job and Activity lifecycles remain separate | A terminal Job leaves the default Activity open. Sealed notification Activities complete only under their explicit policy; multi-Job and verification behavior remains covered separately. |
| Contracts and clients agree | State schema 20, Settings schema 5, task input contract 6, local Companion protocol 10, remote Companion protocol 8, Swift models, UI, nine-language catalog, release manifest, migration catalog, and documentation are synchronized. Swift rejects the previous remote protocol before decoding the renamed required Settings key. |

## Final verification

`npm run validate:full` completed successfully on the final tree:

- TypeScript build and release checks passed.
- 85 Vitest files passed, 753 tests total.
- Codex App Server compatibility matched Codex CLI 0.153.3: 416 JSON and
  827 TypeScript schema files.
- 1,320 macOS localization strings matched across nine languages.
- 203 Swift tests passed; two opt-in live tests were skipped because no live
  Companion socket or remote pairing invitation was supplied.
- Strict Swift concurrency and warnings-as-errors checks passed.

The opt-in live tests are transport deployment smoke tests, not evidence for GPT
automatic result receipt. Their skip does not substitute for or merge with the
paired GPT delivery experiment.
