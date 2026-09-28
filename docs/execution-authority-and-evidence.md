# Execution authority and evidence (#200)

This is the current ownership contract for the Bridge. It supplements the
resource accounting in [#196](issue-196-request-lifetime-accounting.md) and the
process boundary in [#142](state-execution-isolation.md). A SQLite row is the
durable authority for **Bridge business state**. It is not, by itself, a live
measurement of a Codex turn, worker, host delivery, or user acceptance.

## Facts and decisions

| Fact | Evidence producer and decision owner | Durable Bridge role | What does not prove the fact |
| --- | --- | --- | --- |
| Original turn, question, terminal result | Exact App Server event/response matched to thread, turn, request and worker generation by the execution owner | The state writer commits admission, current input, terminal result and replay identity. The execution journal keeps an uncommitted result until the matching terminal commit is acknowledged. | A historical `jobs.status='running'`, elapsed time, `thread/read` showing idle/notLoaded, or a missing heartbeat. |
| Worker/connection lifetime | Execution owner holding the connection and its directly owned process-exit event | `thread_connections` records handoff/release evidence and relationship; it cannot turn a connection observation into a terminal result. | A failed `ps`, stale Dashboard cache, detached caller, or DB row. |
| Admission, scope, project, Activity and Agent | State writer's transaction and exact version/scope checks | SQLite is the durable authority for these Bridge decisions. No App Server event bypasses permission or idempotency checks. | A tool description, card request, or current thread name. |
| Control intent and delivery certainty | State writer's cancellation, steering, answer/question and command receipts plus the original worker response | Unconfirmed effects remain unconfirmed and use the same request identity for inspection/recovery. | IPC write callback, caller timeout, or automatically reconstructed prompt. |
| Result persistence and offer | State writer terminal transaction and `job_completion_deliveries` offer timestamps | A committed terminal result is retained for exact scoped retrieval. Result offer records only that the server constructed an authenticated response. | Execution-owner memory alone, a generated tool response, or `result.availability='delivered'` as proof of GPT consumption. |
| Host delivery and Activity completion | Host acceptance/rejection/uncertainty receipt; separate explicit or policy-controlled Activity transition | Delivery receipt/outbox and `activities.lifecycle` are independent of Job terminal state. | Terminal commit, native notification attempt, host acceptance as proof of a new GPT turn, or a completed Codex turn as proof the user's task is done. |
| Display/health/diagnostic observation | Read child, Dashboard runtime probe and auxiliary observer with their own source and observation time | May show stale/unknown. Disposable telemetry grants no execution, cancellation or replay authority. | A display refresh deadline, heartbeat age, or probe failure. |

No new global poller or second execution-state store is introduced by this
contract. A live owner and an already committed terminal receipt have different
roles: loss of the former cannot erase the latter. Conversely, a committed
`running` receipt describes the last Bridge transaction, not a current process.

## Path inventory and disposition

`Keep` means the state has a distinct authorization, idempotency, persistence or
presentation role. `Narrow` means an observation cannot be promoted to an
execution fact. `Follow-up` identifies the single issue that owns additional
work outside this contract.

| Managed fact and current consumer | First evidence and owner | Why persistent; normal update and restart comparison | Disposition, code and verification |
| --- | --- | --- | --- |
| New Job admission; exact request replay in `codex_task` | Scope/project/permission validation and state writer transaction before execution dispatch | `(scope_id, request_id)` and task fingerprint prevent a second turn; after restart the same admission is read before any dispatch. | Keep: `src/tools.ts` admission, `src/stateStore.ts` Job/receipt; `test/jobRegistry.test.ts`, #142 isolation. New admission fails closed if this transaction is unavailable. |
| Original turn start and assignment | App Server `turn/start` and worker assignment with exact thread/turn/request/generation | Job/Agent/thread linkage is needed for scoped recovery; sequence and identity checks reject late events. | Keep: `src/appServerUpstream.ts`, `src/executionServiceProcess.ts`, `src/tools.ts`; #185/#189 recovery tests. Do not infer another start from DB `running`. |
| Ordinary progress and usage | Exact owner events, coalesced by Job/version | Compact last progress and needed usage projection survive restart; verbose diagnostics may be bounded/dropped. | Keep the compact projection; narrow disposable events: `src/tools.ts` progress queue, `src/stateStore.ts`; #137/#193 tests. No global App Server rescan per progress event. |
| Input and approval | Original App Server request plus current scope, question and interaction ID | Current question, response intent and idempotency require durable checks; a resumed controller recovers the same reference. | Keep: `src/tools.ts` interaction/answer, `src/stateStore.ts` question receipts; #185/#186 tests. An old DB question alone cannot authorize an answer to a different current turn. |
| Steer and explicit cancel | User intent, exact Job/version and original worker's reply | Delivery may be uncertain after a lost response; durable steering/cancellation journals prevent implicit resend. | Keep: `src/tools.ts`, `src/cancellation.ts`, state receipts; #185/#186 tests. A display timeout does not request cancellation. |
| Terminal result, storage and ACK | Exact owner result; then state writer terminal transaction; then owner ACK | Owner retains the original result until terminal commit is confirmed. ACK loss retries the same receipt; it never starts a replacement turn. | Keep: `src/tools.ts` settlement, `src/executionJournal.ts`, `src/executionServiceProcess.ts`; `test/jobRegistry.test.ts` commit-failure tests, #185/#189. |
| Connection loss and same-execution recovery | Direct owner/worker exit or reconnect, authenticated generation and retained request ID | `thread_connections` and journal evidence locate the original execution. A restarted state owner subscribes to that same request, not reconstructed prompt text. | Keep; narrow `thread/read` and loaded-thread probes to inspection: `src/appServerUpstream.ts`, `src/threadConnections.ts`, `src/tools.ts`; #185/#186 and `test/executionRecovery.test.ts`. |
| Dashboard and native runtime projections | Read child snapshot, optional App Server probe, actual observation timestamp | Last confirmed presentation may remain visible when reads fail, with unknown/stale indicators; it cannot mutate terminal state. | Narrow: `src/tools.ts` Dashboard/status, `src/stateReadProcess.ts`, `src/dashboardCard.ts`, macOS `BridgeModels.swift`; #193 budget and Dashboard tests. #198 owns a later integrated host trace. |
| Completion/result offer and host receipt | State writer terminal receipt, exact scoped status offer, mounted card host response | Offer, accepted, rejected and uncertain are separate; no offer or host ACK proves GPT consumed the result. | Keep: `src/stateStore.ts` `job_completion_deliveries`, `src/tools.ts` exact reads, `src/dashboardCard.ts`; `test/completionDelivery.test.ts`. |
| Activity verification and business completion | User/policy Activity transition with version and verification evidence | `activities.lifecycle` and verification are independent of Codex terminal/host delivery. | Keep: `src/activity.ts`, `src/tools.ts`, Activity tests. A terminal Job only makes its Agent idle unless an explicit sealed-Job policy applies. |
| Recovery and cleanup work | Exact incident/owner evidence; bounded due work and page cursors | Attempt and incident identity prevent restart from resetting limits; cleanup must retain unknown ownership. | Keep bounded reconciliation: `src/automaticRecovery.ts`, `src/threadConnections.ts`, #193/#199 tests. #196 owns capacity/reservation corrections; #197 owns confirmed storage bottlenecks. |

The prior all-DB authority wording in `docs/database-schema.md` and
`docs/setup.md` is narrowed to the Bridge's durable business state. The
Dashboard's `statusSource='codex-runtime-only'` names the **scope of included
work** (Codex runtime work instead of other ChatGPT tasks), not the source of
every live status fact: the rows combine committed Bridge state with optional
runtime enrichment and may be stale. This legacy field is retained for card and
native compatibility; it is not a worker-liveness certificate.

## Four completion meanings in current outputs

| Meaning | Current code/API evidence | Limit |
| --- | --- | --- |
| Execution terminal | The exact owner's terminal result, exposed as `completionEvidence.ownerTerminalResult` while its commit is pending; a committed Job has `terminalOrigin` | Worker loss/interruption and an App Server successful completion are distinct origins. A null pending observation only means this state owner has not yet received a matching terminal result. |
| Durable terminal storage | A terminal Job's state-writer transaction and `updatedAt`; `completionEvidence.jobRecord` remains `active-last-known` while an observed owner result awaits commit | While commit fails, the original result remains in the execution journal and the stored Job may still say `running`; it is not proof that the turn continues. |
| Delivery/offer | `job_completion_deliveries` distinguishes pending, leased, host-accepted/rejected/unknown, result-read, and direct/completion offer times | `result.availability='delivered'` means answer bytes are present in the returned model payload, not observed consumption. A host ACK is not a new GPT execution. |
| Activity completion | Versioned `activities.lifecycle`, verification and completion policy | Neither a terminal Job nor a host receipt automatically marks the user's goal complete. |

An exact `codex_status` Job item exposes `completionEvidence`: whether its
Bridge record is active-last-known or terminal-committed, whether this state
owner has received a matching terminal result while its durable commit is
pending, the last owner observation when execution remains unconfirmed,
committed terminal origin, prior result-offer path, host delivery record and the
separate Activity lifecycle. `ownerTerminalResult` is transient observation,
not a second durable Job status. It is cleared when the terminal commit succeeds;
after state-owner restart, the same retained result must be recovered before
this pending observation can be shown again. The current response is recorded
as an offer only **after**
its projection succeeds, so its evidence describes earlier offers. The existing
Job status, result retention, terminal wait and Dashboard control contracts do
not change. Card/native status labels already separate unknown from running
where runtime evidence is absent. No new status store or four-table state
machine is needed.

## Failure and restart decisions

1. If the state writer cannot durably admit a **new** request, do not dispatch
   it. A response-loss retry checks the exact receipt and fingerprint. Existing
   owner work continues without a new turn.
2. If App Server terminal evidence arrives but the terminal transaction is
   busy or fails, keep that exact result reserved at the execution owner. The
   Bridge does not publish a terminal DB state or ACK it until the commit.
3. If the state owner restarts, match generation/request/Job and subscribe to
   the retained execution. Reconcile the existing result or question. Unknown
   owner state remains unknown; no timeout or historical `running` row can
   authorize replacement work.
4. If the directly owned worker or owner actually exits, report the affected
   scope and preserve committed facts. A `ps` failure, heartbeat delay,
   `thread/read` idle/notLoaded or card close is only an observation.
5. Offer, host acceptance and business completion are recorded separately.
   Unobserved GPT consumption remains unobserved. Never turn an uncertain
   delivery into silent success, a fresh turn or a false failure.

Source regressions for these decisions are the existing #142/#185/#186/#189
product-path scripts and focused Job, execution-recovery, completion-delivery
and Dashboard tests. Their successful isolated runs do not establish deployment
to a running app or an end-to-end ChatGPT host acceptance. #198 owns that later
integrated installation judgment; #197 owns any measured SQLite bottleneck.
