# Issue 251 server contract for UI implementation

Base: dev `704020b9aa7c9e728e225a14e9921357364dbd2e`. This is a development
checkpoint, not an installed-app or production-data acceptance report.

The canonical panes are 진행 중 / 실행 기록 / 문제 기록. `running` includes input,
approval and termination waits, retaining their distinct status strings. Current
rows sort by representative start time descending, stable row key for ties.
Activity groups inherit their most recent member's position.

Structural snapshots provide at most three recent history summaries per visible
Agent. `includeHistory:false` no longer removes those summaries. No prompts,
result bodies or diagnostic streams are embedded. `historyIncluded:true` means
these bounded summaries are available, not that all history was loaded.

Snapshot rows retain `history: DashboardTurn[]`, `historyCount: number` and add:

| Field | Type | Meaning |
|---|---|---|
| historyHasMore | boolean | count exceeds delivered summaries |
| historyRevision | 64-hex string | actual admission/terminal/history content change AND logical retained-set change; unrelated progress is excluded |
| representativeExecutionKey | 32-hex string or null | exact execution represented by this Agent row |
| policyRevision | 64-hex string | applied retention policy identity; unrelated settings edits do not invalidate it |
| nextExpiryAt | ISO timestamp or null | earliest retained record's expiry for this Agent; null for unlimited retention |

`DashboardTurn` adds `executionKey: 32-hex string`, and historical rows expose
`endedAtSource: recorded | legacy-estimate` and `detailAvailability: complete |
legacy-partial | expired`. Missing legacy detail is not reconstructed. These
fields are additive/optional when decoding old saved responses.

`historyPolicy` adds `policyRevision` and `evaluatedAt: ISO timestamp`. Its
retentionDays is read from the persisted policy, including numeric zero. A bad
current policy causes a failed read/cleanup, never an invented 30-day deletion.
Only new installation and explicit schema-2 legacy defaults use 30 days.

`statusRows` is bounded by the requested limit. `statusRowsComplete` is false for
a partial population. `statusPagination` has the existing DashboardPage shape.
`statusOffset` is an additive request field for structural paging; use the
returned page offset plus returned count. `terminalOffset` remains compatible.
For current-work paging, request `statusFilter:running`. Complete counts remain
separate from the number of delivered rows.

On-demand `dashboard-history` / native `dashboard.history-detail` takes existing
`rowKey`, optional `historyCursor: string`, and the unchanged authorized scope.
It returns at most 12 summaries, `historyCount`, the same cache fields above,
`historyHasMore`, and `nextCursor: string | null`. Cursor validation binds scope,
Agent, policy and actual history revision, including time-based expiry before physical cleanup. A stale cursor fails with
`DASHBOARD_HISTORY_TARGET_CHANGED`; refresh that target. Merge pages by
executionKey. Do not fetch on unfolding already supplied/cached summaries;
loading additional records is a separate explicit action.

Cache keys must include connection/security generation, selected conversation
or all-work scope, project identity, row key, representativeExecutionKey,
historyRevision and policyRevision. Expiry is a freshness boundary, not a disk
deletion policy. Reject late responses before publishing them, including an
A-to-B-to-A scope round trip. Preserve valid caches across ordinary refresh and
pane changes. Check the cached page's OWN nextExpiryAt independently, as well as
matching count and expiry boundary against the fresh row. A later snapshot's new
boundary cannot revive an expired cached page. Older responses without the new identity fields require a
conservative refresh rather than being treated as matching current responses.

Problems are one occurrence-ordered list. The deprecated request fields
`view`/`review` are accepted for old callers but do not recreate subdivisions or
acknowledgement filtering. Read-only kind filtering and offset paging remain.

`problems` adds `incidentCount` and `currentImpactCount`. `counts.problems`
counts incidents; historical failures alone do not contribute to current impact.
Deprecated pending/reviewable/acknowledged counts are zero. Each problem adds:

| Field | Type | Meaning |
|---|---|---|
| occurredAt | ISO timestamp | fixed first occurrence, also used for ordering |
| currentImpact | none / confirmed / unknown | current exact-source evidence, independent of record age |
| progress | array of {at,step,reason,evidence,attempt} | retained automatic recovery progression; reason/evidence/attempt may be null |

All `canAcknowledge`, `canUnacknowledge`, `canRecheck`, `canRetryStop` flags are
false. Legacy manual problem/history commands reject with
`PROBLEM_HISTORY_READ_ONLY`. Internal authorized automatic recovery retains its
existing recheck path. No UI read, unfolding or refresh issues a recovery command.
A failed execution and its recovery are one incident. Jobless incidents do not
borrow the Agent's newer Job, Activity, or project. Actual recurrence after
confirmed recovery has a distinct identity.

UI owner B edits `src/dashboardCard.ts`, Swift clients/models and Dashboard,
problem and cache presentation files. A owns `src/tools.ts`, policy/storage,
schema/migration, `src/dashboardPresentation.ts`, server/state read adapters and
server tests. B does not edit those shared files. Localization source and generated
resources/manifests are synchronized once at final integration.

Contract fixture checks: `test/issue251Dashboard.test.ts` and
`test/issue251Retention.test.ts`. The contract checkpoint also reuses automatic
recovery and durable-question safety tests. UI cache request-count and rendering
acceptance remains B's work; independent review and dev integration remain later
steps. No production app, database, settings or authentication were changed.
