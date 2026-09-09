# Card tools and migration (issue #69)

Cards are user interfaces. GPT opens Settings or the status card on request,
and creates a question card when it needs the user's decision. New Task calls
and status/history queries never open Activity cards. Activity, Agent and Job
records remain the execution, ownership and verification model.

## Current discovery

The new contract has **19 tools: 12 model tools and 7 app-only tools**. During
migration, actual discovery also includes **12 app-only compatibility
descriptors**, for **31 total (12 model, 19 app-only)**. Operator mode
(`ENABLE_RECOVERY_TOOLS=1`) adds diagnostics and recovery detach, for 33.
Two old model names remain unadvertised aliases. Thus the server accepts 33
names by default and 35 in operator mode. All 14 retired names are still tracked
for later removal; this is not a claim that their implementations were deleted.

Actual ChatGPT testing rejected unadvertised calls from retained cards. Keeping
only their server handlers and immutable resources was insufficient: removing
the original presenter broke template loading, and keeping that presenter alone
restored the frame but broke refresh. The compatibility descriptors are private
to apps and marked `codex/registrationTier: compatibility`. GPT's tool inventory
remains 12; current cards use the seven consolidated contracts below.

| Model tools | Purpose |
| --- | --- |
| `codex_task`, `codex_steer` | Execute a turn or steer an active turn |
| `codex_status` | Scoped status, exact retained result, pagination, input cursor/wait |
| `codex_cancel` | Exact-version Job or whole-Activity cancellation |
| `codex_answer` | Answer a verified ordinary Codex question |
| `codex_ask_user`, `codex_user_answer` | Create a user question and retrieve its response |
| `codex_dashboard`, `codex_settings` | Thin UI openers |
| `codex_models` | Current permitted model/effort catalog; explicit contract v2 also identifies fixed/automatic selection policy without a card |
| `codex_agent`, `codex_activity_update` | Agent management and non-cancelling Activity transitions |

| App-only tools | Closed operations |
| --- | --- |
| `codex_ui_read` | `view: dashboard`, `settings`, `question`, `control`, `history` or `problem-control` |
| `codex_update_settings` | Save/reset with existing revision checks |
| `codex_question_action` | `operation.kind: submit`, `claim` or `ack` |
| `codex_ui_problem` | Review/undo individual failed executions, recheck live problems, or retry failed termination with the exact affected executions |
| `codex_ui_history` | Acknowledge or archive/restore the selected Agent with a private history proof |
| `codex_ui_stop` | `kind: job` or `process` with exact private target proof |
| `codex_interaction_respond` | Respond to the original Codex approval/input request |

The current discovery budget is 165,000 UTF-8 JSON bytes, including the seven app-only contracts; the model-visible inventory remains 12 tools.

These unions contain closed object branches. Unknown fields and mismatched
branches fail validation. They are not arbitrary-method or free-form routers.
`objectSchemaUnion` preserves these branches both in the MCP SDK's object-root
discovery format and at runtime; input transforms remain enforced. Reads,
settings changes, answer submission, approval and termination keep distinct
annotations and responsibilities.

Examples (host metadata supplies GPT's conversation scope):

```json
{"query":{"kind":"input","jobId":"exact-job-id","afterCursor":"64-hex-input-cursor","waitMs":60000}}
```

The input cursor changes for questions/messages or terminality, not unrelated
progress. Read a final answer with `codex_status` and
`{"query":{"kind":"job","id":"exact-job-id"}}`; summaries never copy answers.

```json
{"requestId":"unique-uuid","target":{"kind":"activity","id":"exact-activity-uuid"},"expectedVersion":4,"reason":"The user stopped this work"}
```

Use `target.kind: job` for one Job. Reasons, target versions, shared-worker
impact acknowledgment, durable cancellation intent, replay and termination
confirmation retain their original domain checks. The old Job input form is
runtime-only compatibility, absent from the new descriptor.

## Cards and calls

Settings and Dashboard openers return presentation acknowledgment and minimal
locale/bootstrap metadata. They do not call a settings/dashboard snapshot or
model catalog. Initial data and refreshes use `codex_ui_read`. Settings retry
can request a fresh model catalog. Saving Settings returns committed editor
state in the same response.

The user-facing name is **Codex status** (Korean: **Codex 현황**). Generation 23
opens with `codex_ui_read` and `{view: "dashboard", scope: "auto"}`. A retained
Activity or Job in the opening GPT conversation, including completed/archived
history, selects **This conversation**; no records or missing host identity
selects **All conversations**. The two buttons allow switching both ways. The
thin opener also accepts missing host identity, while rejecting malformed
identity metadata. It still returns no work records or snapshot. The resolved
choice is then sent explicitly on structural reads, enrichment,
refresh, and pagination; only a new cold mount chooses automatically. Losing
host identity while explicitly viewing this conversation fails the read rather
than silently replacing it with all work.

The server filters Jobs, archived summaries, Agents, threads, runtime probes,
history and counts before pagination. In the conversation view, tracked
projects counts relevant active registrations; account usage remains explicitly
account-wide. Switching scope clears row/page caches and selected work details,
and obsolete responses cannot repaint the new scope. Omitting `scope` preserves
all-work behavior for native and immutable older clients. The new card does not
open or require the retired Activity presenter.

The current card and native menu bar share three Agent counts in a single row
of tiles, following the previous menu-bar dashboard style. Each tile places a
muted icon and label above a larger number:

| Summary | Meaning |
| --- | --- |
| Running | Agents whose current Codex turn is running |
| Response needed | Agents waiting for input or approval, counted once even when both are pending |
| Issues | Unresolved latest failure, interruption, termination failure, unknown liveness, or orphaned Agent; excludes normal input/approval waits |

Counts cover the entire selected conversation scope before pagination or status
filtering. Selecting a summary filters the rows; **Show all** restores that scope.
Background processes have a separate conditional link, with unknown/deferred
inspection still visible. Terminating work keeps its row badge. Current work
prioritizes responses and problems. **Run history** includes the recorded turns
of idle Agents, with per-Agent history and conversation links preserved. There is
no separate idle count/list, and an idle Agent without any recorded turn is hidden.
A later run clears an earlier failed outcome from **Issues** while retaining it
in history. Archived Agents remain historical and do not become current issues.
The menu-bar health indicator does not treat ordinary response waits as a fault.

Generation 24 and the native client opt into this projection with app-private
`statusFilter: "all" | "running" | "response-required" | "problems" | "background"`.
Omission preserves the original active/recent/idle pages for immutable older
cards. This presentation change does not unload threads, hand conversations to
Codex, or change Agent/Job/database retention; those are tracked in issue #80.

Dashboard retains its structural-first render, bounded enrichment, pagination,
refresh error recovery and disclosure state. A user deliberately opens **Review requests** or **Manage work** on one row to see its project, Activity, Agent and original requests.
Overview refreshes do not replace that form. Details are reread on refresh and
page restoration. Stop confirmation appears inside the card (ChatGPT's sandbox
does not allow native JavaScript dialogs), shows the selected target and preserves
the impact warning. Idle background processes are separate from active turns.

The detail response exposes only `{kind: control, ready: true}` publicly. Exact
targets, original approval input and a five-minute signed proof are private.
The proof binds the widget, opening host scope (when available), target scope,
Activity generation, Agent/Job identity and versions, and allowed process IDs.
Domain handlers revalidate current ownership, versions, pending request and
process state immediately before dispatch. Restart invalidates proofs; a fresh
read recovers them. A global UI action never expands the model's ordinary
conversation scope. GPT-authored questions cannot approve original requests;
ordinary Codex questions in details direct the user back to GPT handling.

The standalone Question resource no longer imports the Activity renderer.
Submission stores an answer; claim, host message and acknowledgment remain
separate operations. Each action returns current private card state, removing
the old post-ack read. Identical in-flight reads coalesce. Timeouts, metadata
wrappers, stale-response rejection, teardown and page restoration use shared
transport helpers. Mutations and uncertain host delivery are never automatically
replayed via another channel. A stored answer, host acknowledgment and GPT
consumption remain distinct states.

## Existing cards and settings

Retain compatibility for **at least 60 days and two stable releases after the
first stable release containing #69, whichever is later**. There is no timer
that automatically disables a mounted card. Removal also requires an announced
upgrade, fresh discovery of current tools, verified reopening of the user's
existing overview conversation, no supported mounted clients depending on the
old contracts, and the completion-flow rollout checks below. The 14 retired
names remain tracked for removal, not permanent retention. Record a separate
deletion decision before removing their compatibility entry points and unused
handlers, retained resources and legacy settings in a subsequent change. Elapsed
time alone does not authorize automatic deletion. Preserve common handlers still
used by the current tools and all retained work, question and result data.

The 14 retained names are `codex_activity`, `codex_activity_cancel`,
`codex_input`, `codex_activity_snapshot`, `codex_activity_rehydrate`,
`codex_activity_handoff`, `codex_job_steer`, `codex_activity_job_cancel`,
`codex_background_process_terminate`, `codex_dashboard_snapshot`,
`codex_settings_snapshot`, `codex_question_card`, `codex_question_submit`, and
`codex_question_notify`. Each retains strict parsing, output validation and
original scope/widget checks. Only `codex_activity_cancel` and `codex_input` are
unadvertised; the other 12 are app-only compatibility descriptors needed by
retained cards. Current renderer code and model instructions use the consolidated
contracts. Immutable old resource files, including the overview, remain retained
during this window. A narrow serve-time compatibility repair supplies a missing
name helper and replaces the two #71 overview stop handlers that depended on
blocked native dialogs; resource identities, metadata and domain checks remain
intact. No execution is restarted to rebuild a result.

Current ChatGPT and macOS Settings hide Activity display and card-handoff
controls. Persisted values and the legacy default remain intact for mounted
old cards; they do not trigger new presenters. Projects, execution/model/access
policy, questions, results, idempotency records and running work are retained.
There is no new database schema migration in #69 (the #68 baseline is schema 13).

## Completion-flow acceptance

The subsequent [PR #71 actual-host run](audits/2026-09-08-pr-71-runtime-acceptance.md)
verified the current active-response path: background execution, leaving the
work conversation, exact result retrieval, GPT final response and ChatGPT's
unread completion indication. The retained global overview and graceful restart
with active work also passed. The user authorized dev integration and local
operating rollout on this evidence. The [subsequent control acceptance run](audits/2026-09-08-issue-69-final-acceptance.md)
fixed the sandboxed confirmation defect and verified actual overview Job stop,
original approval rejection and idle process termination. The [original-input
retry](audits/2026-09-08-issue-69-input-retry.md) reached the real form and resolved
its request, but the fixture had already timed out. A further attempt after
extending the fixture timeout was blocked before Job creation. These are
historical observations: the user subsequently confirmed the remaining
same-Job input result and explicitly accepted completion, so
[#69 closed on 2026-09-08](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/69#issuecomment-5580775771).
The earlier failed and blocked attempts remain in their dated audit records.
Native banner tests belong to #15, and a new
unsupported already-ended-response wake is explicitly outside #69's mandatory
scope. Earlier residual lists that made those unconditional #69 gates were too broad.

The user reports using both native Codex/macOS and ChatGPT notifications.
The inspected saved policy is `background-only` plus `auto-handoff`, so removing
the old mounted card's completion handoff silently would be a regression.

Native Codex alerts are unchanged; the bridge adds no duplicate native job
alerts. Existing mounted old cards keep their handoff path during migration.
For new work the orchestration contract keeps GPT's current response active
through bounded input waits and exact terminal result retrieval. This supports
leaving the work conversation while processing continues, but instructions and
local protocol tests alone do not prove ChatGPT's notification behavior.

Future changes to this flow should repeat the applicable actual-host regression:
leave the work conversation, allow Codex to finish, observe
retained result retrieval, GPT's final response and the user's notification;
also reopen the existing separate overview conversation. Record Codex terminal
state, retained result, GPT execution and notification separately. An already
ended GPT response needs a supported host wake or explicit user continuation;
a host message acknowledgment is not proof of that wake. If the active-response
replacement does not preserve the user's existing behavior, resolve the
regression before rollout. A new unsupported card-free wake mechanism is not
implicitly included as a separate feature in #69.

See the [implementation audit](audits/2026-09-08-card-tool-consolidation.md) for
the earlier discovery/call measurements, and the [current evaluation plan](chatgpt-evaluation.md)
for the remaining #9/#68 device and host-fault checks. Completed #69 acceptance
is not reopened by those separate requirements.

## Bridge-owned execution permissions

GPT task input has no sandbox or approval-policy field. The bridge applies saved
access settings within operator limits; the retained adaptive option means
Bridge default. Current execution has no GPT-permission-versus-setting conflict
check. Existing thread and actual upstream-policy checks remain. The execution
envelope changed, so refresh discovery before admitting new work. Cached calls
with permission input are refused; exact previously admitted replays retain
their result and never execute again.

Project resolution uses the existing read-only `codex_status` query
`{kind: "project", name: "<exact name>"}`, without a card, permission input or
Codex execution. The former lookup branch is runtime-only compatibility.
The registered tool count remains 29 during migration (12 GPT, 17 app-only).
