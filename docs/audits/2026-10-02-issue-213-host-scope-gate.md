# Issue #213 — actual card-free Events reach the host, resumed reads fail scope

Date: 2026-10-02 KST. Product code: `6102c5073f7463531c47c55d83f791a4272796a3`.
Integration target: `dev`. This is an operational host observation performed
by Codex under the user's explicit trial-connection/login approval. It is not
ChatGPT's earlier static code review or full EVT-NC acceptance.

## Outcome

The new isolated OAuth connection succeeded. ChatGPT web **Work** discovered
the current tools and event, and its tools were rescanned. Native
`events/subscribe` preserved the system-issued `jobId` and `subscriptionRef`,
authenticated as the Job's OAuth principal, verified its own callback with
HTTP 200, and stored the subscription. A's terminal webhook received HTTP 200.
ChatGPT received the completed event and tried to retrieve the exact A result.

That ordinary `codex_status` call included host session metadata and the **same
OAuth principal**, but resolved to a **different scope from A**. Bridge returned
the tool error `HANDLE_UNAVAILABLE`; this was HTTP 200 with `isError: true`,
not a transport failure. GPT reported the scope gate and admitted **no B**.
The UI's advanced event-task setting displayed “same chat on every run,” so
the visible conversation route or that setting alone does not prove stable
server-side scope. The observer retained derived comparisons, not raw host
session/subject/organization values; which identity component changed remains
undetermined. No scope or followup check was weakened.

The trial watch was then paused through ChatGPT. Native `events/unsubscribe`
also preserved the exact issued Job/reference, omitted session metadata,
authenticated as the same Job principal and succeeded. The ledger became
`disabled: "unsubscribed"`, revision 2; its delegation receipt was retired,
revision 3. The connection, A result and unused approval remain preserved.

**#213 stays OPEN.** The result is live subscription/delivery/resumption
evidence and an observed scope gate, not successful original-result review or
card-free A-to-B completion.

## Trial isolation and admission

The old trial application's cached authorization address no longer resolved;
its tools-refresh operation failed and reconnect still used that old address.
The task-owned authorization gateway was restarted with a fresh temporary
public HTTPS address. The existing installation sealing key, signing key,
registered client, operator, protected resource, private HTTP Tunnel, isolated
SQLite and read-only fixtures were retained. A changed issuer changes the
OAuth principal: previous Jobs or approvals were **not migrated** to it.
Only the authorization service is publicly reachable; Bridge and Codex remain
behind the private Tunnel.

Following action-time approval, Codex created **“Codex MCP Bridge — #213 카드
없는 Events 시험”**, preserving existing applications and connections. OpenAI
login, Bridge consent and authorization-code exchange succeeded; the service
records one verified login, one code exchange, zero authentication-service
model requests, and no retained raw OpenAI credentials. Authenticated host
discovery returned the current `codex_event_access` tool and terminal event.
The isolated runtime was fast-forwarded to the accepted product commit and
rebuilt before this test. Task-only instrumentation observed normal handlers
and the existing webhook sender; it manufactured no host request or callback.

The initial GPT reply stopped before admission because it looked for native
Events as an ordinary tool. A clarification explicitly allowed native Work
**event-triggered** monitoring while continuing to forbid time schedules and
polling. The same fresh conversation then admitted one new A, with the exact B
prompt predeclared in `approvedFollowups`; no old A or receipt was reused.
Two task requests occurred, one rejected before admission and one admitted;
the database contains exactly **one new A and zero B**.

A Job: `51bb2c61-c0ea-4c79-94db-0f456db85ab8`. Actual execution used
`gpt-5.6-luna`, reasoning `low`, read-only sandbox and immutable Events delivery.
The retained output matches `fixture-a.json` exactly. This match was checked
through read-only local SQLite and did not offer the result to GPT. Its one
approved B receipt has no admitted Job or reviewed version. The earlier fresh
A with zero approved followups was not used.

## Actual sequence

UTC timestamps below are preserved from the handler observer and SQLite;
add nine hours for KST. See the [sanitized evidence](2026-10-02-issue-213-host-scope-gate.json)
for exact requests, statuses and assertion boundaries.

| Time (UTC) | Observation |
| --- | --- |
| 02:36:59.802 | Fresh A persisted; exact B already approved, Events policy. |
| 02:37:00.718 | Original-scope `codex_event_access` returned the system reference. |
| 02:37:09.613 | A terminal state persisted; output matches the fixture. |
| 02:37:41.762–42.461 | Operator navigated away from A's conversation. |
| 02:37:42.593 | Native subscribe arrived without session, with both exact custom arguments. |
| 02:37:43.151–158 | Callback challenge and subscription admission succeeded. |
| 02:37:43.162–46.329 | Retained A terminal event delivered, HTTP 200. |
| 02:38:09.958–995 | GPT's exact A read had a different scope and was rejected; B remained zero. |
| 02:44:50.754–806 | Native unsubscribe preserved both custom arguments and succeeded. |

A completed in about ten seconds. Navigation happened after terminal but
before webhook delivery, so **departure while A was running was not met**.
No repeated A was created to disguise that timing failure. Late subscription
still delivered the retained committed terminal event; that recovery is useful
evidence but does not satisfy the stricter departure criterion.

## Card-free observation and limits

Dashboard was never opened. The complete authoritative handler trace from the
trial boundary contains **0 `codex_dashboard` calls and 0
`codex_ui_completion` calls**. A's completion record has attempt count zero,
no lease and no result-offer/read timestamps. There was one exact Job status
read after the event, which failed scope; no completion wait/poll loop or time
schedule fallback occurred. Catalog `resources/read` prefetch during connection
discovery is distinguished from mounting Dashboard for completion. ChatGPT's
native event-task controls are not a Bridge Dashboard.

GPT reported zero automatic `ui/message`. Browser DOM observations showed the
generic DIL execution sandbox and no Bridge Dashboard. However, the CDP event
buffer reported truncation, and no exhaustive JavaScript `window.postMessage`
counter was installed. Therefore zero `ui/message` here is the host report
supported by the absent Dashboard/claim path, **not an independently exhaustive
browser message measurement**. Final acceptance must still measure that bound.

## Gates and next decision

Subscribe and unsubscribe custom-argument preservation are now observed.
**Refresh remains unverified.** GPT could read the active event-task entry but
could not establish a same-identity manual refresh operation from the exposed
update contract. No speculative update, new callback, new grant or fabricated
protocol call was attempted. The watch was paused before an automatic expiry
refresh could be observed; pause/restart is not presented as refresh evidence.

The next host question is how normal event-resumed tool calls retain the
original conversation identity, or carry an official equivalent that supports
the existing scope checks. A same-principal subscription reference does not
solve original-result access. It must not become a result/task capability or an
explicit-scope bypass. This observation does not independently prove callback
membership in the originating conversation and does not identify a universal
ChatGPT defect. No OpenAI support inquiry was sent.

Original-scope reads/review and B admission are blocked in this tested flow.
After an official compatible routing path is established, final acceptance
still needs departure while A is running, exact original A review, one
preapproved B, B's own subscription/event, unchanged refresh arguments,
exhaustive card/message observation, duplicates, old-card controls, token
renewal and restart. Do not repeat identical fresh A trials merely to rediscover
the same scope failure.

## Verification and operational retention

This turn passed the runtime build and limited tools/Events discovery. It did
not rerun the Node or Swift suites or establish independent GitHub CI. The
[previous audit](2026-10-02-issue-213-events-status.md) retains its exact
per-invocation results, including the final full Node 1,256-pass/one-packaging-
cleanup-failure run and separate six-pass retry; they are not combined here.
No product source, authority boundary or operating project registration changed.

Documentation affected validation passed for all four changed paths: release
and localization checks and the App Server schema lock against CLI 0.153.3.
Its planner correctly selected neither Node nor macOS suites. Audit JSON
assertions, credential/privacy scanning, relative Markdown links and Git
whitespace checks also passed. These checks validate this evidence update;
they do not resolve the observed host gate.

Private request traces, screenshots and continuity snapshots remain in the
task-owned temporary trial directory. Tokens, cookies, callback URLs, signing
secrets, raw references, raw host identifiers and private account details are
excluded from committed evidence. The isolated authorization/Bridge/Tunnel
services and their runtime worktree remain available for follow-up diagnostics;
that worktree cannot safely be removed while those processes use it. The
separate audit branch/worktree follows the normal integration/cleanup lifecycle.
