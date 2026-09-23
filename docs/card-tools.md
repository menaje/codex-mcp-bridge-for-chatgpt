# Current tool and card contract

The default MCP discovery surface has 20 tools: 14 model-visible tools and 6
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
| `codex_decision` | Create or revise an independent sanitized free-form decision card. |
| `codex_decision_result` | Read one exact stored semantic decision by its same-conversation receipt. |
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
| `codex_ui_decision` | Read, store, lease, and record delivery for one mounted Decision card. |

Each app-only action has a closed schema and requires its normal mounted
Dashboard proof, scope, revision, and ownership checks. Model-visible tools do
not receive those proof-bearing operations.

## Cards, ordinary questions, and completion follow-up

Settings, Dashboard, and Decision are the current UI resources.
`codex_settings` and `codex_dashboard` open the first two and load authoritative
data through `codex_ui_read`. `codex_decision` opens the shared Decision runtime
with a private, scoped snapshot of one immutable sanitized card version; its
app-only actions use `codex_ui_decision`.

Decision cards are a GPT–user aid, not a Codex Question presenter. They require no
project, Activity, Agent, or Job. GPT uses ordinary conversation for simple
questions and may create a card when comparison, editable constraints, or a
visual explanation materially helps. The free-form HTML body is parser-sanitized
and inert; native labeled inputs become a server-owned semantic contract. User
confirmation is durably stored before a same-conversation `ui/message` attempt.
That message carries a receipt lookup instruction, and GPT must call
`codex_decision_result` to receive exact labels, values, units, intent, conditions,
and comments. Card confirmation has `executionApproved: false` and never answers
a Codex input request or starts work. See [GPT–user decision cards](decision-cards.md).

Ordinary Codex questions stay in the ChatGPT conversation. GPT reads a current
question with `codex_status({query:{kind:"input", ...}})`, asks the user in the
normal conversation if their decision is needed, then sends a valid current
answer through `codex_answer`. The retired `codex_ask_user`,
`codex_user_answer`, and `codex_question_action` routes have no Codex-question
card replacement. The independent Decision card does not change that contract.

Dashboard creation and live-card completion delivery remain the default
orchestration policy. Unless the experimental direct-result setting was enabled
when a Job was admitted, `codex_task` returns an exact
`scope + jobId + presentationRef` Dashboard render action and instructs GPT to
call it before prose. Old `dashboardAutoOpen`, `completionFollowUp`, and
`activityCardVisibility` values are ignored and removed during settings
migration; the only completion-route control exposed by either Settings surface
is the off-by-default experimental direct-result switch.

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

The Dashboard's eight-second completion wait and a model-visible exact Job wait
use the same terminal lifecycle signal but retain separate bounded request
lifetimes. Ordinary progress does not wake either terminal waiter. A timeout,
host abort, card teardown, or detached response ends only that read and never
cancels the Job. Model-visible exact waits default to 20 seconds; when the
originating Dashboard is mounted, GPT should not keep another terminal wait
solely to duplicate the card's completion watcher. Exact manual reads and
bounded input waits remain available.

The optional experimental direct-result setting changes only newly admitted
Jobs. Such a Job persists `completionDeliveryPolicy="direct-wait"`, returns a
bounded exact terminal-wait action instead of an automatic Dashboard render
action, and cannot claim a live-card delivery lease. After timeout or host abort,
GPT retries the same exact Job; it never starts a replacement for the same work.
After every non-terminal return, GPT inspects the supplied exact-Job input action
before waiting again. After the terminal result, GPT may continue only work
already approved by the user and must stop at a new approval or input boundary.
Codex execution remains independent if navigation, backgrounding, screen lock,
or connection loss ends the GPT wait. Automatic continuation is host-dependent,
not guaranteed for every such state. The 2026-09-23 [#154 host audit](audits/2026-09-22-issue-154-direct-result-receiving.md)
observed ordered continuation through one screen lock and one short macOS
Clamshell Sleep in ChatGPT Work's in-app browser; it did not test the separate
native ChatGPT app, a terminated GPT run, or whole-device network loss.

A bounded wait timeout is not the end of a GPT run: while the run is active, it
repeats the exact Job wait. If the host ends the GPT run itself, the Bridge does
not silently switch that Job to live-card or send a completion message. The Job
and result remain under their ordinary retention policy. To resume, the user
must return to the originating authenticated conversation and ask GPT to read
the same retained Job with `codex_status` (or locate it in that conversation's
Dashboard and then read it). The scope check still applies; a Job ID is not a
cross-conversation capability. This manual recovery does not itself authorize
or automatically start a later Job.

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
