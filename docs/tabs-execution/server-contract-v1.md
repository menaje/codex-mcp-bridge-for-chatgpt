# Tab execution contract v1 — A/B implementation handoff

Start/base: dev `2dedefbf9ab63f02a0d8bf0a14a82ce8abae315e`; same installed PR256 build. Tracked checkout clean; only private evidence untracked. Only unrelated PR249 is open and remains untouched. AGENTS.md/release governance read; `.agents/skills` is absent in this checkout/original-path lookup. Existing R server investigation reused; archived bridge-orchestration skill is not invoked in this direct workflow.

## Snapshot and compatibility

- Add `historyMode?: "agents" | "jobs"` to dashboard.snapshot/BridgeDashboardSnapshotOptions. Omission preserves existing Agent representative rows and expandable history. B requests `jobs` for the new UI.
- Add output `executionContractVersion: 2`, `historyModeApplied: "agents" | "jobs"`. Existing fields remain; new fields are additive. Older servers may reject historyMode; B must retry the legacy request on unsupported-parameter/method response and treat old Agent row identities as grouped rows, never as distinct Job identities.
- In jobs mode each progress Job and each terminal Job is its own row. `rowKey` for those rows is the existing per-Job executionKey (not the Agent hash); Agent/Activity grouping is display-only. Jobless runtime/current-control rows retain their separate identity and never increase Job counts. No nested Agent history duplicate in jobs-mode rows (`history=[]`, historyCount=0).
- `terminalOffset` remains the terminal page offset; in jobs mode `pagination.terminal.total` and returned are Job counts, not group counts. Order is execution startedAt descending with Job-ID tie-break. All completed/failed/interrupted/cancelled Jobs within current policy are included, including older executions of an active Agent.
- Add `counts.progressJobCount` (actual running/terminating/termination-failed Jobs including their question/approval states), `counts.executionCount` (all four terminal statuses under scope/current retention policy). These totals are independent of page size, folding, Agent/Activity grouping and runtime-only display rows. Existing category counts remain.

## Identifiable execution metadata and exact detail

- Job rows and their latestTurn add `jobId`, `scopeId`, `activityId`, nullable `agentId`, `executionRevision`, `executionName`, `summary`, `error`, `reasonAvailability: "recorded"|"unrecorded"`, existing detailAvailability and cancellation. executionName/summary/error are bounded/redacted stored metadata; missing historical data stays null/unrecorded. Activity title is context, not proof of a separately recorded Job title.
- Add read-only `dashboard.execution-detail` / service method `dashboardExecutionDetail` with `{scopeId, jobId, expectedExecutionRevision?, expectedPolicyRevision?}`. jobId is an opaque nonempty string <=200; scope is exact. Wrong scope, expired/unavailable record, or changed expected revision/policy rejects with explicit stale/not-found result. No by-name/latest-Agent substitution.
- Response `{kind:"dashboard-execution", jobId, scopeId, executionRevision, policyRevision, execution: DashboardTurn}`. Same names/reason/status/time/cancellation fields as list, using the exact durable Job and original retained body where available. This is the detail for a Job row; legacy dashboard.history-detail remains Agent history only.
- executionRevision identifies meaningful retained execution content/status/identity; ordinary usage/runtime observation does not invalidate historical detail. Cache by scope+Job+executionRevision+policyRevision; drop late replies when source scope/project/connection/mode changes. Policy expiration applies equally to list/totals/detail.

## Problem history units and fields

- Include failed/interrupted/cancelled execution events. kind becomes failed/interrupted/cancelled explicitly; cancellation is never an error. Keep runtime/recovery events and existing exact initial/direct-recovery grouping rules; no blanket merging of every later event for a Job.
- Problem entries add nullable `jobId`, `scopeId`, `activityId`, `agentId`, `executionKey`, `executionRevision`; `executionAvailability: "retained"|"unavailable"|"not-linked"`; nullable bounded executionName/summary/error; reasonAvailability recorded/unrecorded. Existing row/latestTurn/cancellation, occurredAt/progress/automatic/currentImpact and read-only flags remain. Never infer an expired Job from the Agent's current/latest Job.
- Collection adds `affectedExecutionCount` (distinct currently retained Job IDs associated with these events), `unavailableExecutionCount` (distinct explicitly linked Job IDs whose retained execution is unavailable), `systemIncidentCount` (events with no Job link). incidentCount remains all events after exact grouping; it is not an execution count. Include an explicit Job-less system label in B's UI. Current impact remains separate from historical counts.
- Full totals precede kind/page filtering; page.total counts selected events. Same Job with multiple events contributes once to affectedExecutionCount. Old 65 partial failure/interruption reasons remain null/unrecorded; no recovery claim.

## Ownership and tests

A: TS server/shared output schemas/options; tools.ts, workHistory.ts, stateStore.ts, stateReadModels.ts, problemReview.ts; exact-detail read worker/provider and TS RPC registration/routing; bounded persisted display metadata and policy checks; source tests/change fragment/integration. A owns TS protocol/routing contracts, not Swift consumers.
B: dashboardCard.ts; Swift DashboardViews/ProblemReviewViews/DashboardPopoverLayout/AppModel, Swift DTO/protocol/local/remote clients/cache and UI checks. B sends translation keys to A; no concurrent edits to A files/generated catalogs.

Validate: fixed-time isolated fixtures, 7/30/90/unlimited, list/page/distinct-total/detail equality for mixed statuses; repeated Job events and Jobless events; canceled reason vs missing error; active Agent's older terminal Jobs; exact scope/late-response/cache revision/policy shrink/expiry fences; bounded page/body reads and source redaction. Preserve PR256 orphan/proof/pool/controller regressions. Reuse existing evidence; no long-duration/soak, no operating SQL writes/deletion/auth changes. First server candidate SHA will be passed to B/R; this contract is not a claim of implementation/test completion.

## Implemented additions

Exact detail includes `nextExpiryAt: string | null`; both Job rows and linked problem rows carry the same expiry. Card requests use `codex_ui_read` view `dashboard-execution`, with widgetInstanceId, scope, exact scopeId/Job ID, and optional expected execution/policy revisions. Native requests use `dashboard.execution-detail`. Cancellation metadata comes from exact retained intent/operation provenance for all sources, without the old latest-100 model-only display limit. New settled executions persist a bounded preview of sanitized retained text; absent historical metadata remains absent.
