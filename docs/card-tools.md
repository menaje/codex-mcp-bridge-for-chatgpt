# Card tools and current discovery contract

The bridge exposes 26 current tools: 12 model-visible tools and 14
app-private card/control tools. There are no compatibility registrations,
unadvertised aliases, or retired card presenters.

## Model-visible tools

| Tool | Purpose |
| --- | --- |
| `codex_task` | Admit a new or continued Codex turn under the saved policy. |
| `codex_steer` | Send additional guidance to one active turn. |
| `codex_status` | Read a Job, Activity, thread, project, or bounded input wait. |
| `codex_cancel` | Explicitly cancel an exact Job or Activity. |
| `codex_answer` | Answer a current ordinary Codex question. |
| `codex_ask_user` | Create a user-decision question card. |
| `codex_user_answer` | Read a stored answer to a user-decision question. |
| `codex_dashboard` | Open the Dashboard card. |
| `codex_models` | Read the saved selection mode and allowed model catalog. |
| `codex_settings` | Open the Settings card. |
| `codex_agent` | Rename a retained Agent. |
| `codex_activity_update` | Apply a versioned non-cancelling Activity transition. |

## App-private tools

| Tool | Purpose |
| --- | --- |
| `codex_question_action` | Submit or acknowledge a Question card action. |
| `codex_activity` | Read Activity card data. |
| `codex_activity_rehydrate` | Restore a mounted Activity card. |
| `codex_activity_snapshot` | Read a compact Activity card snapshot. |
| `codex_activity_handoff` | Complete an Activity card handoff. |
| `codex_background_process_terminate` | Terminate a verified background process. |
| `codex_activity_job_cancel` | Cancel a card-selected Job. |
| `codex_interaction_respond` | Answer an original Codex approval or input request. |
| `codex_job_steer` | Steer a card-selected Job. |
| `codex_update_settings` | Commit versioned settings and project changes. |
| `codex_ui_read` | Read the current Dashboard, Settings, Question, control, history, or problem view. |
| `codex_ui_problem` | Inspect or resolve a verified UI problem. |
| `codex_ui_history` | Acknowledge a selected history item. |
| `codex_ui_stop` | Stop a verified Job or process from a card. |

App-private does not mean unconstrained. Each tool has a closed schema and
requires its normal card proof, scope, revision, ownership, or permission
checks. The model-visible list intentionally excludes those proof-bearing
operations.

## Cards

The four active resources are Settings, Activity, Dashboard, and Question.
Their current immutable URIs are in the [UI release policy](ui-release-compatibility.md).

`codex_settings` and `codex_dashboard` open a card. The card reads its current
view through `codex_ui_read`; it does not treat an old opener response as
authoritative data. `codex_activity` and the Activity-specific private tools
serve the current Activity card. `codex_ask_user` opens the Question card, and
`codex_question_action` preserves the card's proof and immutable answer rules.

## Contract sizing review

The offline current-protocol audit on 2026-09-14 measured 26 descriptors:

| Audience | Tools | Input schema bytes | Output schema bytes |
| --- | ---: | ---: | ---: |
| Model-visible | 12 | 17,240 | 54,843 |
| App-private | 14 | 38,591 | 98,323 |
| Total | 26 | 55,831 | 153,166 |

These are UTF-8 JSON bytes, not model-token counts. The larger private
descriptors preserve card proof, version, pagination, and ownership validation;
they are not sent in the model-visible tool inventory. See
[the final tool-contract audit](audits/mcp-tool-cleanup-review-2026-09-14.md)
for the method and remaining tradeoffs.
