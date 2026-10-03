# Current tool and card contract

The default MCP discovery surface has 16 tools: 12 model-visible tools and 4
app-only tools. Recovery-only tools are opt-in and do not appear in the default
inventory. There are no compatibility registrations, aliases, Question-card
presenters, or Activity-card presenters.

## Model-visible tools

| Tool | Purpose |
| --- | --- |
| `codex_task` | Admit a new or continued Codex turn under the saved policy. |
| `codex_steer` | Send additional guidance to one active turn. |
| `codex_status` | Read a Job, Activity, thread, project, or bounded input wait. |
| `codex_cancel` | Explicitly cancel an exact Job or Activity. |
| `codex_answer` | Answer a current ordinary Codex question. |
| `codex_dashboard` | Open the Dashboard card on explicit user request. |
| `codex_models` | Read the saved selection mode and allowed model catalog. |
| `codex_settings` | Open the Settings card. |
| `codex_agent` | Rename a retained Agent. |
| `codex_activity_update` | Apply a versioned non-cancelling Activity transition. |
| `bridge_skill` | Read one Bridge-owned reusable procedure. |
| `bridge_skill_manage` | Manage the Bridge skill library under its explicit mutation contract. |

## App-only tools

| Tool | Purpose |
| --- | --- |
| `codex_ui_read` | Read Dashboard, Settings, work detail, or problem-review data. |
| `codex_update_settings` | Commit versioned settings and project changes. |
| `codex_interaction_respond` | Respond to an original Codex approval or non-ordinary input request. |
| `codex_ui_problem` | Resolve a verified UI problem. |

Each app-only action has a closed schema and requires its normal mounted
Dashboard proof, scope, revision, and ownership checks. Model-visible tools do
not receive those proof-bearing operations.

## Cards, ordinary questions, and completion follow-up

Settings and Dashboard are the current UI resources. `codex_settings` and
`codex_dashboard` open them and load authoritative data through `codex_ui_read`.
The Decision Card tools and resource are retired; see the
[retirement note](decision-cards.md). For complex GPT–user choices, a
[standalone HTML artifact](standalone-decision-html.md) can present comparisons
and generate a summary that the user explicitly returns to the conversation.
It cannot call Bridge tools or authorize Codex execution.

Ordinary Codex questions stay in the ChatGPT conversation. GPT reads a current
question with `codex_status({query:{kind:"input", ...}})`, asks the user in the
normal conversation if their decision is needed, then sends a valid current
answer through `codex_answer`. The retired `codex_ask_user`,
`codex_user_answer`, and `codex_question_action` routes have no Codex-question
card replacement. Standalone HTML does not change that contract.

All new ordinary Jobs snapshot `completionDeliveryPolicy="direct-wait"`, regardless of the retired experiment setting. Admission returns an exact bounded terminal-wait action and an exact input action. After every non-terminal return, inspect current input before repeating the wait. A timeout, host abort, or detached response ends only that read and never cancels the Job or permits a replacement. Terminal waits default to 20 seconds, allow up to 60 seconds per read, and ignore ordinary progress.

Handle questions in the conversation. After user deliberation, refresh input and answer only the still-current question reference. Original approval requests retain their formal approval contract; neither a question nor an approval automatically opens Dashboard. Retrieve and review the exact original result before admitting a system-issued preapproved followup. Its canonical request ID converges duplicate calls and lost responses to one Job.

Dashboard is an explicitly requested status/history/management surface. Initialization, display refresh, scoped tool calls, and explicit management controls remain available. Its completion watcher, message sender, send lease, acknowledgement, and retry paths are removed. New cards cannot send `ui/message` or `window.openai.sendFollowUpMessage`, and neither admission nor errors supply an automatic card action.

Retained historical Jobs keep their policy, result, request hash, and receipt identities. Running live-card Jobs continue execution and use ordinary exact reads; the sender stays retired. Already-admitted legacy followups replay the original Job. Unexecuted live-card followups are refused with `FOLLOWUP_DELIVERY_RETIRED`; explicit reapproval uses a new ordinary request in the original Activity/Agent. Historical Events records remain readable and grant no ordinary execution permission. See the [transition table](issue-221-delivery-transition.md).

An exact Job/request read records a result offer, which is not proof of GPT receipt or review. Historical delivery records remain available for audit and existing retention protection, but cannot be claimed or sent. Native notification outbox receipts and ordinary followup deduplication remain distinct from the retired card sender.

The [#222 final evidence](audits/2026-10-03-issue-222-final-evidence.md) includes actual A→B/replay, measured 30/60-minute results, and user-confirmed resumption after screen departure/app exit. Preserve these evidence categories without asserting every host behaves identically. When automatic continuation does not occur, request the retained exact result in the originating authenticated conversation. An expired result receipt establishes prior admission and never authorizes an automatic rerun.

Upgrade both server and cards together, refresh connector discovery, and close/reopen old cards using the new URI. Server refusal cannot revoke an old iframe that already holds result text or a queued host message. Cached v3 code may still send from its own memory; close or tear down those instances before accepting the cutover. [Cache and deployment verification](ui-release-compatibility.md) distinguishes server-path blocking from host-side sender removal.

The Activity `completion_outbox` remains a different local macOS notification
channel. When an explicit Activity policy creates such an event, the menu-bar
app claims an opaque receipt, presents generic text, and opens the local
Dashboard when clicked. It never proves or substitutes for ChatGPT follow-up.

## Retired public routes

The following routes are intentionally absent from discovery:

`codex_ui_completion` (explicit retired-path error), completion-receipt status queries, automatic Dashboard inputs,
`codex_ask_user`, `codex_user_answer`, `codex_question_action`,
`codex_activity`, `codex_activity_rehydrate`, `codex_activity_snapshot`,
`codex_activity_handoff`, `codex_activity_job_cancel`,
`codex_background_process_terminate`, `codex_job_steer`, and
`codex_ui_history`.

Activity, Agent, Job, result, idempotency, and legacy question records remain
in SQLite for retention and migration compatibility. Retained state does not
reactivate a retired presenter or tool.
