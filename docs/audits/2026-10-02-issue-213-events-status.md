# Issue #213 — delivery failure visibility and intentional monitoring stops

Date: 2026-10-02 KST. Integration target: `dev`. Baseline: `53c91d6`.
Scope: the two P2 findings in ChatGPT's static review supplied by the user;
implementation and isolated regression validation. The previous
[card-free implementation audit](2026-10-02-issue-213-cardless-events.md)
retains its historical test results.

## Result and contract

`eventSubscription.state` continues to describe subscription authority. A
retained callback ledger independently exposes `delivery.state`, `attempts`,
`lastHttpStatus` and the safe `failureReason`. Waiting, pending, acknowledged
and final failed delivery are distinct. Permanent callback rejection (413,
including 410's disabled endpoint) and exhausted transient retries appear in
both `codex_status` and `codex_task` replay with an explicit warning that
automatic delivery has stopped. Neither a failed webhook nor its ACK changes
Codex execution, constitutes result review, or authorizes B. Original exact
results and bounded recovery remain available. Callback addresses, signing
keys, raw references and private callback diagnostics stay out of status.

Explicit revocation and native unsubscribe expose their reason and suppress
automatic issuance and subscription-completion guidance. Initial authorized
monitoring and response-loss recovery retain their exact-Job issuance action.
That action now survives the closed model-output projection, only in task and
status envelopes; other tool recovery contracts remain unchanged. Caller
scope/reference and revoke actions cannot enter that automatic action branch.

Unsubscribe retires the receipt even before initial callback binding. A user's
deliberate monitoring-resume request can issue a new reference in the original
authenticated conversation. The old reference cannot subscribe or refresh,
and its late unsubscribe cannot stop the newer delegation. No new per-Job
approval prompt is imposed on the initial already-approved workflow. The
Bridge enforces the guidance and receipt state; it does not independently
prove that a model's new ordinary issue call followed a new human instruction.

A noncredential stop record in the existing metadata journal preserves user
intent across bounded receipt cleanup and restart. It is at most one record
per retained Job and is removed with Job/history cleanup. Preexisting stopped
receipts are accounted for before garbage collection. Admission, stop writes,
linked-subscription disable and deliberate resume share the existing writer
UoW; write failures roll back together. A pruned Job is `job_unavailable`,
receives no issuance hint and cannot gain a new delegation through a stale
in-memory handle. No new DB, writer, migration or execution engine is added.

The [implemented delegation contract](../mcp-events-subscription-delegation.md)
documents these fields and guidance.

## Local verification

Eleven additional cases bring the delegation file to **43 cases** and the
focused Events/OAuth/output/guidance run to **143 passing tests**:

| Regression | Evidence |
| --- | --- |
| HTTP 413, 410, eight HTTP 503 responses | Real isolated callback HTTP responses travel through the injected webhook sender and actual MCP HTTP handlers to SQLite, final failed ledger, status and task replay. Same logical event, retained result, no new A or card fallback. Only retry deadlines are advanced to avoid sleeping through backoff. |
| Delivery phases | A held execution and held callback produce waiting, pending and ACK status without equating authority or ACK with successful GPT review. |
| Revoke and unsubscribe | Original-scope status and active-task replay omit automatic issue/completion guidance; a deliberate issue produces a different reference, rejects the old reference and leaves a resumed watch active despite a late old unsubscribe. |
| Legacy cleanup and restart | Simulated pre-fix receipts without stop metadata are collected, but original results and the stop reason survive product restart. Job archive removes stop metadata and rejects new monitoring. |
| Pending verification and rollback | First-challenge stops persist without a callback binding. Failed revoke/unsubscribe linked writes and failed resume admission preserve the complete previous state. |
| Closed next-action contract | Only exact Job issuance is projected in monitoring context. Caller scope/reference, malformed Job ID and automatic revocation stay guidance only. |

The earlier synthetic card-free A-to-B test still passes in the focused run.
It requires preapproved B, exact A result offer and original scope; concurrent
B requests converge to one Job with its own Events subscription. The HTTP
request inventory records **0 automatic Dashboard calls and 0 ui/message** in
that sequence and in the new failure/stop regressions. No GPT or iframe runs in
these isolated tests; these counts are not actual host instrumentation.

Affected validation passed release/localization, pinned Codex CLI **0.153.3**
compatibility, **1,257 Node tests across 116 files**, and **216 Swift tests,
2 skipped, 0 failures**. After the final Job-cleanup guard, type/build/schema
checks and the focused 143 tests passed again. The settled-source full Node
rerun had **1,256 passed and one failure** in the unchanged release-payload
suite: macOS `hdiutil detach` failed while cleaning up a mounted fixture. That
suite then passed all **6 tests** in an independent single-worker rerun, with
no source or test changes. No unresolved failed test remains; this is not
represented as a uniformly green settled-source full-suite invocation. The
failed mount was confirmed absent from `hdiutil info` afterwards.

The [sanitized JSON evidence](2026-10-02-issue-213-events-status.json) distinguishes
these runs. All executions are local on this Mac; there is no independent
GitHub CI rerun claim.

## Remaining real-host acceptance

This work changes code and isolated tests, not the operational OAuth/Tunnel
connection. It starts no live A/B and sends no OpenAI support inquiry.
The prior successful fresh A has no approved followups and must not run B.

Actual ChatGPT must still preserve exact custom arguments in native subscribe,
refresh and unsubscribe and preserve the original conversation scope in resumed
ordinary result/followup calls. Missing or different scope must remain denied.
Final EVT-NC acceptance uses a separate A with exact B approved at admission,
Dashboard never opened, departure from A's chat during execution, A event to
GPT resumption and exact original-result review, one B admission and B's own
event. Automatic completion Dashboard calls and ui/message must each be zero.
Duplicate events, old cards, token renewal and restart need real-host controls.

The guarantee remains original-conversation delegation of exact Job/event
monitoring to the same OAuth principal, not independently proven callback
membership of that conversation. Temporary issuer reachability and issuer
grant/refresh persistence remain operational conditions. **#213 stays OPEN**
until actual card-free Events A-to-B acceptance succeeds.
