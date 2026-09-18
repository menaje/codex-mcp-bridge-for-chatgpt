# Current tool and card contract

The default MCP discovery surface has 17 tools: 12 model-visible tools and 5
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
| `bridge_skill` | Read one Bridge-owned reusable procedure. |
| `bridge_skill_manage` | Manage the Bridge skill library under its explicit mutation contract. |

## App-only tools

| Tool | Purpose |
| --- | --- |
| `codex_ui_read` | Read Dashboard, Settings, work detail, or problem-review data. |
| `codex_update_settings` | Commit versioned settings and project changes. |
| `codex_interaction_respond` | Respond to an original Codex approval or non-ordinary input request. |
| `codex_ui_problem` | Resolve a verified UI problem. |
| `codex_ui_completion` | Lease and record one exact live-Dashboard completion delivery attempt. |

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

Dashboard creation and completion delivery are orchestration defaults, not user
preferences. Every admitted `codex_task` returns an exact
`scope + jobId + presentationRef` Dashboard render action and instructs GPT to
call it before prose. Old `dashboardAutoOpen`, `completionFollowUp`, and
`activityCardVisibility` values are ignored and removed during settings
migration; neither Settings surface nor the mutation schema exposes them.

The exact terminal Job creates one durable `job_completion_deliveries` record.
Only a live originating Dashboard whose host metadata, Job, and presentation
reference all agree can claim its bounded lease through
`codex_ui_completion`. The card then sends standard `ui/message`. Definite host
rejection is retryable with backoff; acceptance uncertainty is terminal for
automatic sending so a reconnect cannot duplicate a message merely because an
acknowledgement was lost. The message contains an opaque receipt and lookup
instruction, not the Job result. The Bridge stores only the small delivery
record, not a copy of the generated message. A server receipt is correlation,
never authorization.

The automatic message tells GPT to call `codex_status` once with
`query.kind="completion"`. That read requires current authenticated ChatGPT
conversation metadata, rechecks the receipt's exact retained Job and scope, and
records that the server offered the result. An ordinary authenticated exact Job
or request query records a separate direct offer. Neither offer proves that GPT
received or reported the result, changes the completion-delivery state, or
cancels a live-card send. Supplying a scope ID explicitly cannot authorize a
lookup. The automatic path prevents duplicate card sends for one completion;
it does not claim exactly-once reporting across both direct queries and automatic
messages.

After a card crosses the send boundary, an unresolved completion protects the
exact Job result only through the selected run-history retention period. A
merely pending event with no live card follows ordinary result retention. A receipt offer starts
one ordinary result-retention recovery window so a response lost at the return
boundary can be queried again without retaining successful results for the full
history period. When run history expires, its small completion-delivery record
also expires. Card teardown permanently stops that instance; cardless and
post-navigation wake are intentionally unsupported. Codex execution remains
independent of card liveness.

The Activity `completion_outbox` remains a different local macOS notification
channel. When an explicit Activity policy creates such an event, the menu-bar
app claims an opaque receipt, presents generic text, and opens the local
Dashboard when clicked. It never proves or substitutes for ChatGPT follow-up.

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
