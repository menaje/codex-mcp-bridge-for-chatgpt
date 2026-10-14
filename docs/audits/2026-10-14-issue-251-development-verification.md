# #251 development implementation and verification

The shared history policy and both Dashboard surfaces implement the requirements
in [#251](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/251).
This report describes source, isolated fixtures and browser/native tests. It does
not claim installed-app acceptance, operating-data cleanup or a formal release.

Independent review approved product snapshot
`a348ea2c345de0354c90f1ec8938158400437df2` after five reproduced defects were
corrected. Supplemental review approved `b599208492326f256ea3aae76b27a7b9eb01cd1e`:
two problem-row builders omit absent optional metadata so real MCP JSON validation
accepts archived and Job-less history. No policy, control, schema or UI semantics
changed in this delta. Later fixture/document corrections preserve the reviewed
product bytes. The accompanying equivalence record verifies every tracked blob
outside test/document directories, including generated resources and metadata.

## Requirement coverage

| Issue criterion | Implementation and evidence |
| --- | --- |
| UI-1, UI-2 | Both surfaces use In progress / Execution history / Problem history. Removed response-needed/problem subdivision controls and duplicate native footer history icon. Card browser assertions and native Dashboard tests check panes, selection and read-only behavior; native input/localization checks validate generated resources. |
| ORDER-1, ORDER-2 | Representative execution start descending with stable identity ties; Activity follows latest member. Approval/input waits retain their statuses. `issue251Dashboard` verifies newer execution in an older Activity and approval ordering; shared queries, page tests and client reuse cover normal refresh. |
| HISTORY-1 | Three recent summaries per visible Agent, counts/has-more, explicit twelve-entry pages. Initial payload excludes prompts/results/diagnostic streams. `issue251Dashboard` checks bounded visible rows, bytes, pages and no runtime probes. |
| HISTORY-2 | Valid caches survive reopen, pane change and unrelated refresh. Card/native tests and browser checks require zero extra history reads for prepared summaries. |
| HISTORY-3 | Cache identity binds connection/scope/project/Agent/representative/history/policy; logical expiry changes revision before physical cleanup. Clients independently check their cached page's own expiry/count/boundary, reject stale pages/errors and isolate eviction. Tested policy changes, new representative, page merges and A→B→A late responses. |
| PERF-1 | Independent copies of a 20-Agent/600-execution fixture compare list time, response bytes and first history display; browser assertions count unfold/reopen/pane/refresh requests. No new timeout, complete-history preloading or durable deletion used for speed. See the measurement limits below. |
| WAIT-1, WAIT-2 | Input/approval waits remain visible under In progress; original question validity, scope, identity and delivery controls remain. `questionStore`, `questionOrchestration`, exact replay and cancellation tests cover applicable control boundaries. This is not an actual GPT-resumption test. |
| PROBLEM-1 | One occurrence list; public history processing actions reject read-only. Both UIs remove acknowledgement/recheck/retry/resolve forms and ignore stale legacy capability flags. No equivalent processing inbox is created. |
| PROBLEM-2 | Initial exact execution recovery is correlated once; confirmed runtime recurrence retains its distinct incident key. Job-less journals preserve source identity and retry budget across expiry/restart. Automatic recovery and independent recurrence reproductions check identity/counts. |
| PROBLEM-3 | Incident count and current-impact count are separate. A historical execution failure alone has no current impact; exact current Job/thread evidence determines confirmed/unknown impact. Independent recurrence test verifies two incidents and one current unknown impact. |
| SAFE-1 | Structural reads/pages do not probe recovery, acknowledge history, create/cancel Jobs, approve inputs or send conversation responses. Public problem actions reject; automatic internal recovery retains its existing bounded authority. |
| RETENTION-1 | One persisted policy (`historyPolicy.ts`), path/clock inventory below, and schema ownership documentation. Removed fixed durable event/telemetry count/byte TTL exceptions. No historical body is preserved by renaming it control data. |
| RETENTION-2 | Independent copies for 7/30/90/indefinite at ages 6/20/40/100: completed/failed/interrupted, archived/unarchived, resolved/unresolved and Job-less recovery, completion and cancellation material. Check visibility, disk payload and exact detail, not just UI hiding. |
| RETENTION-3 | Immutable run-end/incident/capture clocks; exact boundary tests; metadata/observations/operation completion do not renew them. Expired originals cannot be reintroduced by late snapshots, telemetry or policy extension. |
| RETENTION-4 | Actual live execution/approval authority survives history maintenance. Terminal holds, uncertainty or unresolved state do not preserve historical prose outside policy. Compact request/dispatch/intent/outcome/attempt controls remain without the historical body. |
| RETENTION-5 | Policy predicate precedes list/count/page/detail projection. Server logical revision and independent client expiry guard agree before physical sweeps; completed outbox reads/pending availability/claims use the same clock as cleanup. |
| RETENTION-6 | Both duration directions and finite↔indefinite tested across restart. Settings outer commit/rollback and telemetry deletion share a nonwaiting cross-process mutex; interleaved changes cannot succeed while old-policy deletion commits. Already erased content is not reconstructed. |
| RETENTION-7 | Full result bodies and original event payloads survive registry/cache eviction, archive, large payload/count pressure and restart. Physical expiry scrubs originals/diagnostics and related completion/cancellation prose, preserving only necessary control facts. |
| RETENTION-8 | Corrupt/missing/nonnumeric policy fails closed without inventing thirty-day deletion. Numeric zero survives propagation. Bounded slices, restart, failure rollback, same-process reentry and actual cross-process conflict/retry/exit tests cover cleanup authority. Diagnostics report applied policy and failed maintenance; execution-count cleanup totals are not labeled as all-domain deletion totals. |
| COMPAT-1 | Additive schema 32, immutable published migration entries, explicit legacy-partial/estimated provenance, optional older DTO decoding, synchronized card/native resources and nine-language catalog. Official App Server schema baseline is Codex CLI 0.153.3 (416 JSON / 827 TypeScript files). |

## Policy path and clock inventory

All rows below consume the same saved 7/30/90/0 setting. Zero means no age expiry.
An invalid existing policy does not authorize cleanup. Only initial installation
and explicitly migrated legacy defaults use thirty days.

| Material | Storage and query | Fixed clock | Cleanup / remaining control |
| --- | --- | --- | --- |
| Execution original, summary, failure diagnostic | `jobs`, `job_result_bodies`; shared list/count/page and exact scoped detail | First terminal `ended_at`; active work has no terminal clock | `WorkHistoryStore` + state Unit of Work scrub original/summary/events/body at expiry. Request/hash/outcome identity prevents duplicate execution. Archive changes residency, not original retention. |
| Original progress/usage/diagnostic/completion audit | `job_events`, completion-delivery journal | Related execution end | Event/history maintenance applies the saved policy; no durable per-Job/global row, byte or payload cap. Hydration/response bounds are independent of disk retention. |
| Runtime problem and automatic progression | `automatic_recovery`, `automatic_recovery_steps`; incident projection | First incident occurrence | All states and Job-less records expire alike. Current observation pointer and compact retry budget contain no historical reason/evidence body. Confirmed recurrence has a distinct key. |
| Question original and answer history | `question_history`, question delivery journal | First capture | Policy cleanup is separate from valid question/interaction authority; does not approve/resend or retarget an answer. |
| Activity completion delivery material | `completion_outbox`; normal/pending/native availability/get/claim predicates | Immutable outbox `created_at` | Independent bounded sweep reduces payload to `historyExpired:true`; opaque dispatch identity/attempt/lease/outcome fence prevents recreation. Late completion after Job expiry still gets its own full policy lifetime. |
| Cancellation rationale | `cancellation_operations`; scoped list/control projection | Immutable operation `created_at`, for both target kinds | Bounded prose scrub; identity/hash/root/child intent/status/machine reason/outcome remain. Unavailable policy omits prose from direct control reads without preventing settlement or deleting the original. |
| Transport, runtime measurements and diagnostics | Existing isolated telemetry DB and bounded memory projection | Related Job end for linked transport; own capture otherwise | Telemetry owner keeps operational source read-only and holds shared mutex through policy read/delete commit. No durable count cap; queue/memory/ACK controls contain no alternate historical body. |
| In-flight/cached history page | Card and native client caches | Page's own next expiry plus shared logical history revision | Evict/reject expired or mismatched pages and late responses. Cache eviction never deletes a retained disk original. |

The auxiliary policy mutex is an empty private SQLite file, not a historical
store or second operational writer. Settings acquire the existing operational
transaction then try the mutex with timeout zero; nested writes reuse it through
outer commit/rollback. Telemetry acquires mutex then its own transaction and only
reads the operational WAL. It does not request the operational write lock.
Contention rolls back/fails fast; fresh retries reevaluate current policy.
Exceptions and process exit release locks, with no timed stale-lease override.

## Author and independent verification

Author checks on the approved product snapshot passed: 13 affected Node suites /
123 cases, native Dashboard 25 cases under complete strict concurrency and
warnings-as-errors, four expiry-browser checks and ten existing pane/cache checks.
The final checkpoint added two lock tests; its exact focused run passed 24 cases
(18 review-boundary plus six client-expiry cases), and its exact build passed.
The product bytes remained unchanged between these checkpoints.

Independent R re-review at exact `a348ea2` passed five converted original defect
requirements, three actual cross-process commit/rollback cases, 29 repaired-boundary
regressions, two focused native expiry cases and four real-browser fixture checks.
R approved continuation to final validation and development integration, with no
new required product fix. Raw private review logs and local execution paths are
not published; this report contains source refs, synthetic measurements and
reproducible repository tests only.

Supplemental independent real HTTP MCP verification at `b599208` passed three
existing wire tests and two independently authored cases. Present recovery/URL
metadata survived, absent keys were absent, and other-scope material stayed out
of conversation-scoped reads.

Repository-wide validation initially found stale schema/clock fixtures, old
problem-processing expectations and the optional-MCP serialization bug. The bug
was fixed and independently reviewed; fixtures now check schema 32, real retained
originals, actual live-work protection, current history identities, and zero
writes from stale legacy processing capabilities. The two terminal residency
fixtures were updated only after explicit user approval; exact originals,
authentication boundaries, completion uncertainty and restart equality remain
asserted. The existing 61-second reservation case is excluded from repeat runs
under the requested long-duration-test boundary; it is not offered as longevity
evidence. Exact-SHA counts and comparison evidence appear in
[the validation record](2026-10-14-issue-251-validation.json). At fixture/docs
commit `39e6c9a`, release/schema checks and the build passed. The full Node run
reported 1,656 passed / 27 failed / 2 skipped in 149 files, not an overall pass.
Two failures (process inspection timeout and synthetic DMG mount) passed isolated
retries. The remaining 25 are in unchanged `issue162Context` (1) and
`issue246StartupSupervisor` (24) fixtures/runtime; a representative failure from
each also reproduced on `704020b9`. The complete 24-case baseline was not repeated
and these existing failures are not claimed repaired. This excluded legacy
startup/environment work is recorded as a repository validation limitation,
not concealed by disabled tests or changed production safeguards.

The full native command initially reported 316 tests, three skipped and ten
assertion failures in two functions. Both failing functions then passed with
strict concurrency and warnings-as-errors after test-only corrections. All
other native product/test bytes were unchanged; this is combined boundary
evidence, not a claim that the original full command passed. No operating-app
acceptance is implied. The user explicitly excluded #242/#246 full revalidation
and #247 actual resumption as prerequisites for this development integration.

## Performance measurement limits

Five list samples per independently seeded version used 20 Agents, 30 completed
executions each, requested limit 12 and indefinite retention. With history enabled,
the list median was about 10.4ms in both baseline and candidate. Structural baseline
returned no visible retained rows/previews and needed another snapshot to display
history; candidate immediately returned twelve rows with three summaries each and
needed zero additional snapshots. The structural payload grew from about 1.5KiB to
52KiB because it now supplies summaries and cache identity. These are local source
fixture samples; they do not establish installed-app latency or a universal speed
threshold. Browser checks verify zero additional history reads for prepared
unfold/reopen/pane/ordinary refresh, while more pages remain explicit requests.

## Remaining operational boundary

Development integration does not replace/restart the operating app, prune its
DB, change its settings/authentication, promote a release or prove long-running
load stability. No new soak/long-duration/time-compressed substitute or actual
GPT automatic-resumption test was added. #249 and #242/#246/#247 remain untouched.
Legacy originals already removed by earlier versions are marked partial; missing
terminal timestamps have estimated provenance rather than a fabricated new clock.
