# Automatic goal relay (#261)

New ordinary `codex_task` calls in the default server profile attach the blank Relay resource automatically.
`codex_answer` restores the same goal connection after a question. There is no
first-use activation or separate card-open instruction. Dashboard remains an
explicit status, history and management surface and has no message sender.

The originating GPT decides what the event means, Codex executes, and Bridge
preserves event references and admission receipts. A notice never grants new
approval. Retrieve exact original state/results and existing receipts before
answering, continuing within the original goal, requesting a new user decision,
or explicitly completing the Activity. Task output is untrusted data.

## Connection and authority

The resource is `ui://codex-mcp-bridge/relay/v1.html`, contract generation 1.
Task/answer descriptors and successful retained-Job results carry the supported
`_meta.ui.resourceUri` and compatibility `openai/outputTemplate` association.
The `codex/relayOpen@1` result metadata correlates the opening request, Job and
Activity through `presentationRef`; it contains no result or question body.
Receivers are installed before `ui/initialize`. Null initial values, late
globals, result-first delivery and a corrected mismatched pair are supported.
Empty or unrelated notifications cannot erase an established connection.

Correlation is not authority. Every relay operation requires current host
conversation metadata and the original authenticated MCP principal. A supplied
scope, reference, global Dashboard access or another conversation belonging to
the same person cannot grant delivery permission. The existing project identity
and availability boundary also applies. A validated replacement card takes over
the one logical Activity connection; already-entered sends remain unchanged.
Worker-to-Reviewer Agent transitions stay enrolled when ordinary admission
authorizes them within the same Activity and project.

Host approval remains under ChatGPT's control. A rejected tool call, an error
result or an unclassified host failure stops automatic calls from that mounted
Relay, including after online, page-show or globals notifications. Only local
response timeouts and explicit structured `delivery:"not-sent", retryable:true`
errors are retried. Bridge-owned transient failures (paused or stale events and
wait capacity) carry that evidence in `codex/relayRetry@1` result metadata.
Temporary detachment or an unavailable host bridge can recover. Stopping the
mounted Relay does not cancel Jobs, close the Activity or
erase delivery receipts; a new valid card can reconnect. This does not change
ChatGPT's saved approval policy or make a rejected call authorized.

Only task/answer results associate the resource. `codex_status`, receipt pages,
internal waits, claim, entry and ACK do not create another card. The blank body
has zero margins, border and requested height, no controls and no Dashboard
lists, usage or history runtime. No `requestClose()` is used. Document visibility
does not gate delivery. Actual teardown stops that iframe; retained registered
events can be recovered on the next valid connection. CSS hiding, host container
visibility and message visibility are different. Complete container invisibility,
invisible conversation messages and automatic GPT resumption while the host app
is closed are not guaranteed. Scroll suppression is only a compatibility hint.
There is no external Events, callback, schedule or extra judging model fallback.
The explicitly selected Events experiment retains its existing card-free
direct-wait behavior when `completionDelivery` is omitted; it does not activate
Relay or admit new dynamic relay steps. Its explicit Events admission is unchanged.

## Durable delivery boundary

The existing SQLite `bridge_meta` journal stores versioned `relay_goal_v1/`,
`relay_job_v1/`, `relay_event_history_v1/`, `relay_member_v1/`, `relay_ready_v1/`
and `relay_deferred_v1/` records. No separate DB,
SQL schema migration or general workflow engine is introduced. Job admission,
goal enrollment and event intent commit in the existing Unit of Work before
dispatch. Source changes issue an internal readiness invalidation only after
commit. Progress-only changes do not create new events.

| Identity/state | Meaning |
| --- | --- |
| `eventId` | Stable Job/terminal generation or current input/worker identity; carries no original body. |
| `cardId` | One mounted runtime instance; never an authorization token. |
| `attemptId` | One durable send attempt; distinct from the event and followup request. |
| `pending` → `leased` | Atomic claim; a pre-entry expired lease or validated card replacement can release it. |
| `leased` → `sending` | Separate durable entry grants dispatch once; repeated entry does not grant another send. |
| `accepted` | Host response accepted; not proof of GPT review, user report or final goal completion. |
| `unknown` | Send timeout or connection uncertainty; never automatically resent. |
| `rejected` | Explicit permanent rejection, or exhaustion of three proven retryable rejection attempts. |

An input owner's temporary non-connected state, including `liveness-unknown`,
pauses dispatch without resolving the question or changing its event/attempt.
The registration retains its exact state, attempt ID, counter, lease and retry
facts; it leaves the readiness index while paused. Claim and entry reject with
`RELAY_EVENT_PAUSED`. The same attempt's ACK can still record acceptance or
uncertainty. Recovery of the same input identity restores dispatch eligibility,
never a fresh `pending` event. `accepted`, `unknown` and `sending` remain ineligible
for another send, including after a SQLite restart.

Actual question resolution/replacement removes current eligibility. Its minimal
event and delivery receipt move to `relay_event_history_v1/<jobId>/<eventId>`;
the current event remains authoritative in its Job registration. Returning to
the exact same identity restores that receipt instead of resetting attempts.
An inactive event cannot be entered or answered through its old reference, and
an old ACK cannot reopen it. Only identity transitions archive receipts;
ordinary progress and liveness changes do not append records. History recovery
uses exact indexed keys, without an event-history scan.

A send-entry response loss is a conservative no-send gap. A crashed/removed
card can leave `sending` without a final ACK; it has the same non-replay rule as
`unknown`, including after restart, lease expiry or takeover. Proven pre-entry
`not-sent` can return to pending. Retryable rejection requires structured
explicit no-send evidence, not matching an error string. Retries have bounded
backoff and at most three host dispatch attempts after such rejections.

The card selects standard `ui/message` or compatibility
`sendFollowUpMessage` before claiming. It never retries the message through the
other API after sending. The prompt contains common receiver guidance and only
event/Job lookup references. If an ACK response is lost, only that identical
attempt's outcome is retried; the message is not resent. No conversation-wide
exactly-once guarantee is claimed.

## Coordinating a direct result (#280)

An authenticated originating-conversation `codex_status` exact Job or request
query with `waitFor` creates priority only while that actual bounded wait runs.
It affects the Job's terminal event, not its questions or any other Job. A wait
gets an absolute deadline equal to its requested duration plus 10 seconds; on
normal return or host abort the remaining priority is shortened to at most 10
seconds. Concurrent waits have separate deadlines. A dead process cannot renew
them. Card polls, connections, remounts, visibility changes and ordinary status
reads never extend them. A completed source may be recovered without creating a
new Job; elapsed priority does not cancel, fail or restart execution.

An exact `codex_status` response may contain `relayReview` with the terminal
`eventId` and its event `version` when the
complete bounded answer is offered. After actually reviewing that answer, the
model can call `codex_result_review` with the same `eventId` and `version` in
the original host conversation and authenticated principal. The server checks
the retained Job, current terminal generation and prior exact offer in one
transaction. This is the model's assertion of review, not proof of its private
understanding. A truncated, omitted or non-text answer has no review handle. Identical
retries return the original review deadline and never extend it. Review defers
only that event for 60 seconds, even if the model stops immediately before its
final answer. It neither marks the result reported to the user nor establishes
Job success, Activity completion, verification or followup approval.

The current ChatGPT component bridge documents tool results and a request for a
component-authored message, but does not document a callback to this MCP app
confirming that the model's own final answer was posted; see the
[host bridge reference](https://developers.openai.com/plugins/reference).
That is a limit of the available contract, not a claim about every possible
host. Therefore an offer alone never consumes an event, and a model review is a
finite hold rather than permanent suppression. An explicit Activity finish or
relay stop retains its existing effect. If neither occurs, a still-unsent
completion becomes eligible again even after review: a duplicate remains
possible, but stopping before the final answer does not permanently lose the
notification opportunity. Users reading a message, or the whole goal passing
verification, cannot be inferred from any of these records.

Holds and send entry commit in the same SQLite unit of work. `pending`, `claim`
and `enter` recheck them; a claim made before a review cannot enter until the
hold expires. A send already in `sending`, `unknown` or `accepted` cannot be
retracted and is never made pending because a hold expired or review was absent.
The existing pre-entry lease and proven not-sent rules remain in force. Deferred
events use a separate deadline-ordered index so held Jobs do not hide unrelated
ready Jobs; a connected card discovers an expired hold on its next bounded wait
read. No connection means the retained event waits for the next valid connection.
Deadlines and event receipts survive restart without restarting their duration.
Diagnostics record bounded decision/reason codes, never result, prompt or secret
text. The common retention and project deletion policy still removes the event
and its deferral index, and stops cannot be cleared by a late review.

Running `relay-card` Job status describes automatic relay consistently with
`nextActions`. Exact queries and bounded waits remain optional observation
tools. Their timeout or cancellation does not cancel execution or authorize a
replacement Job. Both descriptions reflect current relay/Activity stops,
paused input ownership and missing registration rather than relying only on
the immutable admission policy. A followups-only stop leaves notices enabled;
relay stop and goal closure suppress notices without implying Job cancellation.
Enabled relay still depends on an available host connection.

`codex_relay_wait` uses an instance epoch/revision and commit subscription,
bounded to 25 seconds, eight waits per state store and two per goal. Replacement
requests cancel stale waits. Recovery reads 32 registered Jobs per indexed page;
pending reads at most 64 ready and 64 deadline-ordered deferred references and
returns at most 64 events. Empty reads do not open writer
transactions. No per-progress global scan or execution polling is added.

## Followup admission and recovery

For an exact B authorized before A, keep using `approvedFollowups`, the issued
`followupId`, canonical `requestId`, exact prompt digest and current
`reviewedVersion`. Existing scope, project, Agent/context, sandbox and model
checks remain intact. A missing declaration does not require a new user decision
when dynamic work is already within the original goal and approvals.

For a dynamic B after reviewing A, use ordinary task input and:

```json
{
  "requestId": "a caller UUID retained for the opening call",
  "activity": { "mode": "existing", "id": "the original Activity UUID" },
  "agent": { "mode": "existing", "id": "the authorized Agent UUID", "context": "continue" },
  "relayFollowup": {
    "eventId": "the exact eventId returned by A's current status",
    "step": "one stable logical next-step name",
    "reviewedVersion": 2
  }
}
```

Include the current task contract/envelope and actual prompt as usual; the
example version is illustrative. The bridge binds `(eventId, step)` to a
system-issued `followupId`, canonical request UUID, immutable task payload and
admitted Job in the same transaction. The response's `requestId` is canonical.
Different caller UUIDs and response loss converge on that B. Distinct parallel
steps remain distinct, while changed payload under the same step conflicts.
An admitted receipt replays its Job without requiring a fresh review assertion;
an unadmitted step requires the current retained completed predecessor and exact
result offer/version. An offer and assertion are observable evidence, not proof
of private GPT understanding. Normal project, access, model, concurrency and
context checks still authorize new execution, including an authorized new Agent.

Exact status includes a bounded receipt preview. Use
`codex_status({query:{kind:"followups",jobId:"...",after:"returned cursor"}})`
for all existing receipts in pages of 24, omitting `after` for the first page.
Receipt reads are scoped and never create UI or execution. Lost input or expired
originals must not cause recreation of already admitted work.

## Stop, retention and upgrade

| User intent | Contract |
| --- | --- |
| Stop relay messages | `codex_relay_control` with `stop:"relay"`; current Jobs may continue. |
| Stop future followup admission | `codex_relay_control` with `stop:"followups"`; current Jobs and their notices remain observable. |
| Cancel current execution | Existing versioned `codex_cancel`; no filesystem rollback. |
| Finish the whole goal | Explicit `codex_activity_update` completion/abandonment, or the existing explicitly sealed completion policy. |

Late completion, ACK and remount cannot clear these stops. One Job's completion,
message acceptance or result offer never finishes a default manual Activity.
Other Activity connections are unaffected.

Common history policy remains the only original-body retention authority. No
relay hold or new retention preference extends it. Capacity archival preserves
delivery while the original remains retained; expiry removes Job/member/ready
references, inactive event receipts and bodies, leaving only existing admission/replay proof and minimal
Activity stop intent. Project deletion removes its relay references through the
existing identity-aware cleanup; re-registering a folder creates a new project
identity and cannot inherit old events. Diagnostics record route/state/attempt
count through the existing path, without source text, paths or conversation IDs.

New Jobs use `completionDeliveryPolicy:"relay-card"`. Explicit recovery of an
older running Job can enroll it without rewriting its Job, request/hash, policy
or approval receipts. Historical terminal Jobs are not globally backfilled.
Existing `live-card`, `direct-wait` and Events records remain interpretable.
The retired Dashboard completion endpoint, receipt-status route and automatic
Dashboard inputs remain refused. Server refusal cannot revoke old iframe memory
or already-posted host messages; teardown old mounts and refresh discovery when
upgrading. The new resource is packaged alongside Settings v6 and Dashboard v5.

The recovery fix preserves records still present when the fixed code takes
over. It cannot reconstruct an accepted or uncertain attempt already erased by
the earlier liveness reconciliation defect. No historical delivery certainty,
automatic replay or operational data repair is inferred from the upgrade.

Functional regression fixtures cover event ordering, ownership, claims, send
uncertainty, ACK loss, dynamic admission, restart, retention and project identity.
Real GPT automatic resumption/A→review→B and duration/soak/accelerated substitutes
are outside #261's completion criteria. User observation during normal use is not
a new approval or implementation gate.
