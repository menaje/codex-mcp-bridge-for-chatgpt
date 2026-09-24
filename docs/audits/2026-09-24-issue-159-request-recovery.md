# Issue 159: exact request recovery and follow-up identity review

## Basis and decision

The task began from clean `dev` and `origin/dev` at
`8820db927594256999c5fb65989bfb49c2af5094` on 2026-09-24. The issue's
earlier static reference was `53c4fb5ab5aaa555aca0012f85c83292f9246635`.
The current code and tests were reviewed again. Tests in this review use a
fixture upstream and temporary SQLite files; no installed app, operating
database, user Job, or real Codex work was fault-injected.

Decision: keep the existing scoped `requestId` and Job admission transaction as
the execution authority. Improve recovery instructions and exact status reads
after result expiry. Add two-stage failure tests. Do not add a second safety
store, a required planning/registration call, a global UNKNOWN gate, or a
follow-up linkage table in this issue. A new logical ID for the same follow-up
remains an unguaranteed boundary, documented below. This is completion of the
design review and bounded recovery improvement, not a claim of universal
exactly-once Codex effects or new live-host acceptance.

## Identity and authority boundaries

| Operation | Identity and behavior |
| --- | --- |
| Exact Job/request status read | Read-only observation. A timeout or host abort leaves the Job lifecycle unchanged. A result offer is not evidence that GPT consumed it. |
| Lost admission response and exact retry | The same conversation scope, logical `requestId`, and matching request hash recover one Job. A different payload under that ID is a conflict. The MCP transport request ID is not the logical work ID. |
| Repeated parent result with an already approved next turn | The caller must retain that next turn's own `requestId`, query it after ambiguous admission, and retry only the identical input. The server cannot infer the identity of two newly generated IDs from the parent result or prompt text. |
| Different branch, revised review, or explicit rerun | A separate authorized logical turn uses a fresh `requestId`; matching prompt text and the same Agent do not make it a duplicate. Authorization, project, scope, and input checks still apply. |

The existing `jobs` unique key on `(scope_id, request_id)`, request-hash check,
and deferred execution activation already protect exact retries. The
`operational_command_receipts` transaction remains the state-owner command
receipt, not a second Job identity system. Job execution state, live-card or
direct-wait delivery policy, result offer, and actual host/GPT consumption stay
separate. The code added here reads the preserved compact Job row after full
result retention expires. A scoped exact Job or request status query now returns
the original Job ID, terminal state, and `omitted`/`unavailable` result. It
cannot reconstruct the expired result. Missing and foreign handles still return
the same `HANDLE_UNAVAILABLE` response.

An archived request's `codex_task` retry now checks its admission receipt before
new Agent/activity selection, so an unrelated validation error cannot hide
the prior admission. Its error directs the caller to the exact status read.
A retired hash-version retry also directs the caller to the existing request
read before considering a new logical turn. These reads and messages do not
grant new execution authority or ask for user reapproval within an already
approved workflow.

## Failure evidence

The new `test/tools.test.ts` two-stage case names synthetic Jobs A, B, and an
independent C. It exercises the real HTTP MCP handler and temporary state DB,
with a fixture upstream. IDs are deliberately omitted from this record.

| Boundary | Observation | Coverage limit |
| --- | --- | --- |
| A result read twice; B admission response dropped after commit | Both A reads retained the same answer. B was found `running` by its own request ID. Two concurrent identical B retries returned one B Job; A and B produced two upstream calls. A changed Activity version after B admission, so full status envelopes were correctly not compared byte for byte. | The fixture retains B's ID. A host that generates a new B ID has a different case below. |
| Same B ID with different prompt | Conflict returned; no extra upstream call. | Existing request-hash protection, now checked in a two-stage flow. |
| Independent C while B is held | C reached `completed` before B was released; three upstream calls total for A, B, C. | Shows no new global wait or block in the fixture, not production throughput. |
| B result and restart | B completed and its exact terminal result was retrieved. A new bridge process recovered B by request ID with no new upstream call. | Restart was after B completed. Existing `test/activityStore.test.ts` covers a running Job restart being recovered as `interrupted`; this review does not claim the old execution automatically resumes. |
| Intentional new turn with B's same prompt | A fresh ID produced another Job and a fourth upstream call. | This also demonstrates the remaining risk if a host mistakenly changes B's ID while reprocessing A. The bridge has no stable step key to distinguish those intents. |
| Result and history expiry, then restart | An exact scoped Job/request query returned a compact terminal receipt with `replay: true`, original Job ID, and an omitted result. No original answer leaked. Recalling `codex_task` with that ID failed before Agent selection and made zero upstream calls. | A dependent next step requiring the expired result cannot be inferred or automatically continued. |
| Foreign or missing expired ID | Both produced identical `HANDLE_UNAVAILABLE` errors. | Neither error proves that the target was never admitted in some other context. |

Earlier single-request regressions in `test/tools.test.ts` cover loss before
dispatch, loss after admission, concurrent identical retries, payload conflict,
and aborted exact status reads. `test/stateStore.test.ts` covers immutable
direct-wait policy, live-card lease exclusion, offer versus acceptance, and
delivery retention. `test/workHistory.test.ts` covers compact request
reservations after expiry. `test/telemetryService.test.ts` already injects
diagnostic database capacity failure without blocking operational state;
`test/operationalCommandReceipt.test.ts` covers same-transaction command
receipts and rollback. The new status path reads authoritative state, and a
failure there is not ignored or retried as a new request ID. No diagnostic
write was added to admission, status, or next-turn execution.

The historical #154 live ChatGPT trials show direct result receipt and one
approved follow-up under tested host states. They did not submit the same
follow-up under two distinct logical IDs. This review does not reinterpret
those trials as that guarantee or as proof of host acceptance for the new
compact status response.

## User flow and measured local cost

The normal `codex_task` input contract remains unchanged: no new required
field, tool call, registration, planning wait, user confirmation, or approval.
The added exact archived-ID lookup is one indexed SQLite read during admission;
ordinary exact status reads retain their existing path. Expired-result reads
perform a scoped lookup only when the active Job is absent. No new global lock,
queue, result-delivery lease, or diagnostic dependency was added. The C test
above confirms that an uncertain B read did not hold independent work.

For a same-machine before/after comparison, the same four HTTP fixture tests
were run three times each with one Vitest worker. The baseline worktree used
`8820db9` and a copy of the same test source; the changed worktree used the
new source. Values are per-test median wall times reported by Vitest, in ms.

| Test path | Baseline | Changed |
| --- | ---: | ---: |
| Ordinary durable admission | 344 | 335 |
| Lost admission response recovery | 280 | 272 |
| Exact request replay/conflict | 258 | 255 |
| A → B response loss, reads, C branch, restart | 418 | 416 |

The raw baseline/changed runs respectively were: admission
`[585, 344, 338]`/`[343, 333, 335]`, lost response
`[273, 280, 280]`/`[274, 271, 272]`, exact replay
`[261, 258, 255]`/`[255, 253, 256]`, and A → B
`[412, 441, 418]`/`[416, 407, 424]` ms. These times include fixture setup and local HTTP
overhead; they are not isolated per-call latencies, production p95 values, or
proof of a speedup. The small differences do not establish a measurable normal
flow regression in this sample. The number of required tool round trips is
unchanged. A recovery read is needed only when an admission result is actually
uncertain. No performance threshold was invented from these measurements.

## Proposal disposition

| Proposal | Decision and reason |
| --- | --- |
| Scoped request identity, durable admission, exact replay, bounded waits, Job delivery policy | Already satisfied; retain and reuse. |
| Two-stage lost-ack, concurrent replay, separate branch, deliberate rerun, restart and expiry checks | Verification strengthened. The tested stable-ID flow recovers B without another execution and continues through its retained result. |
| Compact exact admission receipt after result expiry and safer retry guidance | Adopted. It prevents an expired exact request from looking merely absent and fixes a misleading pre-admission error ordering. |
| Durable parent-result → follow-up-step linkage | Structural candidate deferred. With only a newly chosen UUID and prompt, the server cannot distinguish accidental B-2 from an expressly approved rerun. A mandatory plan/registration protocol would add a new failure and user-flow dependency; no observed operating incident or stable host-provided step key currently justifies it. |
| Additional display or large diagnostic subsystem | Optional and deferred. Existing Job, delivery, and offer records distinguish execution from server offer. They do not establish GPT consumption, and display state cannot become execution authority. |
| Once dependency, external service/DB, global UNKNOWN gate, automatic card fallback | Unnecessary for this review and outside its stated scope. |

If a future host trial shows that an approved B routinely loses its ID across
result replay or conversation resumption, the minimum candidate is a stable
caller-visible step key tied to the exact parent Job result/version and explicit
attempt or plan revision. The first caller must be able to derive or recover
that key without a new user procedure. A unique scoped link and the B Job
admission must commit atomically in the existing store, and exact reads must
return the linked Job after a lost response. Same-key payload or permission
changes must conflict; separate branches and intentional reruns need distinct
keys. A random key generated anew on each B retry would not solve the gap.
Adopt that candidate only with host evidence and a normal-flow/latency check.

No separate implementation issue was opened from this review. The remaining
new-ID boundary is recorded here and in #159; if the product later requires a
cross-ID same-step guarantee, it should have its own implementation and host
acceptance scope. Result expiry, host GPT-run termination, and a running Job
interrupted by bridge restart remain explicit limits on automatic continuation.

## Validation

`npm run validate:affected` passed on the final changed worktree, with the
repository's pinned Codex CLI 0.153.3 placed first on `PATH` for the App Server
schema check. It ran release/localization checks, the App Server schema lock
comparison (416 JSON and 827 TypeScript files), the Node build and all 895
tests in 101 files, and the macOS localization check and Swift suite (212
tests, 2 intentionally skipped, 0 failures). `git diff --check` passed. The
validation used the temporary fixture data described above and did not test a
real ChatGPT host resumption, installed app upgrade, or production latency.
