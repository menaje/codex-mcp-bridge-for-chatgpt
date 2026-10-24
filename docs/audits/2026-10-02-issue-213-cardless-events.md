# Issue #213 — restricted OAuth delegation and card-free Events

Date: 2026-10-02 KST. Integration target: `dev`. Baseline: `01392e9`.
User-authorized scope: [card-free design and EVT-NC1–NC8](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213#issuecomment-5942805508).

## Implementation result

The limited subscription delegation is implemented. The prior proposal status
in the [Dashboard deployment audit](2026-10-02-issue-213-dashboard-resource.md)
is historical and superseded by this authorization and implementation.

`codex_task completionDelivery="events"` persists an immutable opt-in policy.
It requires enabled Events, OAuth and original host conversation metadata.
`codex_event_access {action:"issue",jobId}` then checks the exact Job, Activity,
Agent, project, principal and original scope in the existing writer UoW and
issues or recovers an opaque Bridge-owned subscriptionRef. Its only permission
is monitoring that exact Job/event for that same authenticated principal.

Native subscribe/refresh/unsubscribe preserve `{jobId,subscriptionRef}`. Only an
absent native session takes the delegation path; present invalid/different
session metadata is denied. Challenge-time and transaction-time revalidation,
first callback binding, revision comparisons and atomic linked revocation
protect concurrent refresh, unsubscribe, expiry and late verification/ACK.
No new database, writer, supervisor or task execution engine was added.

Events Jobs never request an automatic completion Dashboard. Both server render
and completion-wait/claim boundaries deny that delivery, including for old
cards. The SQL lease boundary still permits only live-card Jobs. Manual
Dashboard history/state/control remains available. The existing client watcher
already requires live-card presentation, so this change does not alter HTML or
invalidate its v3 URI. Dashboard iframe acceptance is a separate gate.

Approved B inherits Events, retains all previous reviewedVersion/prompt/scope/
principal/context/model/permission/dedup checks, and requires its own exact B
subscription. SubscriptionRef cannot be supplied to result/task/configuration
tools to replace their normal authority. Callback ACK is not review or approval.
Terminal Events intent retains the original result for a finite 24-hour recovery
window before a subscription exists; subscription recovery survives ACK,
failure, unsubscribe and revocation. Existing retention applies afterwards.

See the [implemented contract](../mcp-events-subscription-delegation.md) and
[sanitized evidence summary](2026-10-02-issue-213-cardless-events.json).

## Local validation

The new test file has **33 regression cases** using signed OAuth JWTs, a real
loopback JWKS endpoint, actual HTTP MCP handlers, controlled callback promises
and temporary SQLite. These are isolated product tests; no actual ChatGPT or
model provider is involved. They cover system-issued reference recovery,
wrong principal/Job/event, missing versus invalid session, rollback, callback
races, refresh/ACK preservation, revocation, expiry, capacity, old-card denial,
finite recovery, disabled-runtime restart and denial of unapproved B.

One synthetic sequence predeclares exact B, subscribes A without native session,
observes its committed event, offers exact A in its original scope, and makes
two concurrent B calls with different caller UUIDs. Both converge to one B;
B inherits Events despite a changed Settings policy, is separately subscribed
and emits its own terminal event. The sequence counts **0 automatic Dashboard
calls and 0 ui/message**. This establishes Bridge mechanics, not actual GPT
result understanding or host resumption.

Local affected validation passes: **1,246 Node tests across 116 files** and
**216 Swift tests, 2 skipped, 0 failures**. Release/localization checks and the
pinned **Codex CLI 0.153.3** schema check pass. CLI pinning uses a PATH shim so
explicit fixture CLI overrides still take precedence. These are local results,
not an independent GitHub CI run. A final Node check also validates the settled
production source; the changed canProceed fixture is separately rechecked.

## Remaining real-host gates

| Gate | Evidence still required |
| --- | --- |
| Native custom arguments | Observe the same reference on actual subscribe, refresh and unsubscribe without logging its value. |
| Resumed ordinary tool scope | Verify original conversation scope on exact A result retrieval and B admission; missing/different scope must remain denied. |
| EVT-NC1–NC8 | Dashboard never opened; leave A's conversation during execution; A terminal event resumes GPT, exact A is read/reviewed, preapproved B is admitted once, and B's own event completes. Zero automatic completion Dashboard and ui/message. |
| Controls | Duplicate events, old cards, token renewal/product restart and denied-access cases in the same real connection. |
| Operational authentication | Reachable current issuer and working ChatGPT connection; prototype issuer-service grant/refresh persistence is separate from the durable product subscription ledger. |

The Bridge does **not** independently prove callback-conversation membership.
The guarantee is the original conversation's limited exact monitoring delegation
to the same OAuth principal. If resumed ordinary tools lose their original
scope, leave a host gate; do not relax results or B authorization.

This task does not modify the operational connection, send the prepared OpenAI
inquiry, start a live A/B, or reuse the previous successful fresh A (which has
zero approved followups) for B. Final acceptance needs a separate A with the
exact B approved before admission. No automatic card, time-based schedule or
repeated-poll fallback is created. **#213 remains OPEN** until actual card-free
Events A-to-B acceptance succeeds.
