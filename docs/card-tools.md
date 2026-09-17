# Current tool and card contract

The default MCP discovery surface has 15 tools: 10 model-visible tools and 5
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
| `codex_dashboard` | Open the Dashboard card. |
| `codex_models` | Read the saved selection mode and allowed model catalog. |
| `codex_settings` | Open the Settings card. |
| `codex_agent` | Rename a retained Agent. |
| `codex_activity_update` | Apply a versioned non-cancelling Activity transition. |

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

Settings and Dashboard are the only current UI resources. `codex_settings` and
`codex_dashboard` open them; both load authoritative data through
`codex_ui_read`.

Ordinary Codex questions stay in the ChatGPT conversation. GPT reads a current
question with `codex_status({query:{kind:"input", ...}})`, asks the user in the
normal conversation if their decision is needed, then sends a valid current
answer through `codex_answer`. The retired `codex_ask_user`,
`codex_user_answer`, and `codex_question_action` routes have no replacement
card API.

`dashboardAutoOpen` controls automatic Dashboard presentation. It opens for a
newly admitted task in its originating conversation. The task continues even if
that card or conversation disconnects. Manual Dashboard opening remains available.

`completionFollowUp` enables a local macOS completion notification, independently
of card state. For a new one-job Activity without an explicit
completion policy, the bridge uses `notify` plus `sealed-jobs-terminal`; a
successful terminal completion enters the durable outbox. The local menu-bar
app claims only opaque `{eventId, outboxId}` receipts over its private Unix
socket, asks macOS to present a generic notification, then acknowledges the
exact outbox record. A failed presentation releases its lease for retry.

The notification contains no prompt, result, path, Activity ID, or ChatGPT
conversation ID. Clicking it opens the local Dashboard. It never resumes or
adds a ChatGPT message, and it is unavailable to remote companion clients.
Dashboard presentation neither claims the outbox nor sends a follow-up message.
The bridge may retry after a crash between macOS accepting the notification and
the durable acknowledgement, so this is not an exactly-once user-visible
delivery guarantee.

`ui/message` is an MCP Apps bridge request from a mounted component to its
host; it is not a Question-card or user-answer API. No current Bridge resource
calls it. The old shared card helper that exposed this request was removed with
the retired Question and Activity card paths, so ordinary user answers continue
through the normal ChatGPT conversation only.

## Retired public routes

The following routes are intentionally absent from discovery:

`codex_ask_user`, `codex_user_answer`, `codex_question_action`,
`codex_activity`, `codex_activity_rehydrate`, `codex_activity_snapshot`,
`codex_activity_handoff`, `codex_activity_job_cancel`,
`codex_background_process_terminate`, `codex_job_steer`, and
`codex_ui_history`.

Activity, Agent, Job, result, idempotency, and legacy question records remain
in SQLite for retention and migration compatibility. Retained state does not
reactivate a retired presenter or tool.
