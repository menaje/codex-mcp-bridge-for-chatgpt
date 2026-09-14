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
| `codex_ui_problem` | Resolve a verified UI problem and acknowledge Dashboard completion delivery. |
| `codex_ui_stop` | Stop a Dashboard-selected Job or verified background process. |

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

`dashboardAutoOpenBackground` controls automatic Dashboard presentation. It
opens only for a newly admitted background task in its originating conversation;
foreground work never opens it automatically. Manual Dashboard opening remains
available.

`completionFollowUp` uses the durable completion outbox independently of card
state. A verified host conversation-resume event takes priority when one is
implemented and verified. Until then, an automatically opened Dashboard can
send one bounded `ui/message` follow-up and acknowledge the exact outbox event.
If no route exists the event remains pending. If message delivery becomes
uncertain, it is held out of automatic retries rather than being sent through a
second channel.

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
