# Restricted original-conversation Events delegation

This is a separate disabled-by-default experiment. Startup requires `CODEX_MCP_BRIDGE_EXPERIMENTAL_PROFILE=events` and `CODEX_MCP_BRIDGE_EVENTS_ENABLED=1` in addition to the authentication configuration below. A legacy enable flag alone does not activate it. Ordinary direct-wait setup requires none of these services.

Status: **implemented for opt-in OAuth Events Jobs; actual ChatGPT host acceptance remains pending**.
The user explicitly authorized this design in [#213's card-free acceptance supplement](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213#issuecomment-5942805508).
This replaces the proposal status recorded at `01392e9`. It does not change
ordinary result/task scope or assert independent callback-conversation proof.

## Guarantee and boundary

Observed native `events/subscribe` and `events/unsubscribe` omit `openai/session`,
while ordinary tools in the same connection include it. The [official reference](https://developers.openai.com/plugins/reference)
describes this field under Tool calls. The [Events contract](https://developers.openai.com/plugins/build/mcp-events)
authorizes the authenticated user, event and arguments without promising that
native conversation field.

The Bridge proves that **the original conversation delegated monitoring one
exact Job/event to the same authenticated OAuth principal**. It cannot
independently prove that the callback belongs to that conversation. A supplied
malformed or different session is rejected; only absent native session metadata
uses the delegation. OAuth authentication and callback verification alone grant
no Job access.

## Public flow

1. Admit A with `codex_task`'s `completionDelivery: "events"`. This requires
   enabled Events, OAuth authentication and original **host** conversation
   metadata. A caller's compatibility `scopeId` cannot enable this policy.
   Declare only exact B prompts the user already approved in `approvedFollowups`.
2. Follow the returned exact-Job `codex_event_access` action:

   ```json
   { "action": "issue", "jobId": "the returned exact A Job UUID" }
   ```

   This is an ordinary authenticated tool in the original conversation. It
   rechecks Job, Activity, Agent, active project, principal and scope inside the
   existing State UoW. It issues or recovers a system reference; caller-supplied
   scope, reference and receipt IDs are rejected. No additional card or approval
   is required for already-authorized monitoring.
3. Preserve the tool's event and **exact arguments** in the native lifecycle:

   ```json
   {
     "name": "codex.job.terminal",
     "arguments": { "jobId": "exact A", "subscriptionRef": "esr_..." },
     "delivery": { "mode": "webhook", "url": "host-provided HTTPS callback", "secret": "host-provided signing secret" }
   }
   ```

   OAuth event discovery requires both arguments. GPT neither creates callback
   credentials nor imitates `events/subscribe` with an ordinary tool.
4. Subscribe/refresh revalidate the receipt before the callback challenge and
   again after it in the writer transaction. Both arguments must remain exact
   for refresh and unsubscribe. A supplied session must resolve to the original
   scope; a reference cannot override it. The first successful challenge binds
   one callback atomically. Another callback requires an authorized new grant.
5. A terminal event carries an exact original-result query, version and available
   system-issued followup IDs. Its ACK is receipt only. Resumed ordinary
   `codex_status` and `codex_task` calls still need the original conversation
   scope. Read/review A before returning its reviewedVersion and exact approved
   B prompt. Existing followup receipt checks and atomic deduplication remain.
6. B inherits A's immutable Events policy, even if Settings changed. It gets its
   **own exact B Job** delegation and native subscription. A's reference cannot
   authorize B or a different event. With no preapproved followup, report A and
   await instructions; result data such as `canProceed=true` is not approval.

`codex_event_access` action `revoke` takes only the exact Job ID in its original
conversation. It revokes that Job's references and disables linked subscriptions
atomically. An intentionally authorized issue after revocation creates a new
system reference; old references remain revoked.
Native unsubscribe also retires its reference, including before the first
callback binding. After either explicit stop, status and task replay expose
`reason: "revoked"` or `"unsubscribed"` and no automatic issuance action. They
instruct the model to wait for a user request to resume monitoring. Such a
request uses the existing original-conversation `action: "issue"` to obtain a
new reference; the old reference still cannot subscribe or refresh. An old
reference may disable its own callback, but cannot stop a newer delegation.
Initial already-approved monitoring and response-loss recovery still return
the exact-Job issuance action; no additional approval is required for those.

## Persistence and races

`src/mcpEventAccess.ts` stores bounded receipts in the existing `bridge_meta`
journal, under `mcp_event_access_v1/`. No new database, connection, writer,
supervisor or workflow engine was added. Each receipt contains:

- system-created receipt UUID and opaque-reference hash;
- principal, exact Job/Activity/Agent/project, original scope and allowed event;
- issue/expiry/revocation times and revision;
- unsubscribe time when the host explicitly stops that reference;
- verified callback hash and admitted subscription ID once bound.

The public `esr_` reference is a domain-separated 256-bit HMAC of that UUID under
the stable installation sealing secret. Neither its raw value nor callback URL
or signing key is stored in the receipt. Database data alone cannot regenerate
a reference without that secret. An authorized exact-Job issue call recovers the
same live reference after response loss or product-server restart. Keep the
installation secret; rotation requires explicit revoke/reissue and does not
migrate another principal's Jobs.

A small `mcp_event_monitoring_stop_v1/<jobId>` record preserves the principal,
original scope, event, stop reason and time after credential receipts expire.
It grants no authority and contains no reference, callback or signing key.
There is at most one per retained Job; Job archival/history expiry removes it.
Maintenance preserves explicit stops from preexisting receipts before bounded
cleanup, but never turns expiry into a stop or stops a newer delegation. New
authorized issuance clears the stop record in the same UoW as admission;
storage failure rolls both changes back. This uses the existing metadata
journal and single writer, with no new database or migration.

Limits are one callback per reference, eight retained receipts per Job and 256
globally. A reference lasts 24 hours, cannot be extended by native refresh, and
is removed after an additional bounded 24-hour expired-disable window. OAuth
subscription expiry is capped by requested finite TTL, reference expiry and
verified access-token expiry. `ttlMs: null` does not grant indefinite renewal.
A longer watch requires an authorized original-conversation issue call.

Binding, revocation, unsubscribe and subscription writes compare revisions in
the existing writer transaction. Simultaneous different callbacks cannot both
bind. Expiry, revocation, ownership loss or unsubscribe during a challenge
prevents late admission. Expired/revoked references can only disable an existing
exact callback subscription; unsubscribe cannot bind or re-enable one. A pending
first unsubscribe advances the receipt revision without binding a callback,
fencing its late challenge. An already-started webhook cannot be recalled, but
its late ACK cannot undo refresh/unsubscribe/revocation. Refresh merges the
latest ACK, attempts, retry and result-recovery state after verification.

Existing HTTPS, SSRF/DNS checks, socket pinning, no redirects, encrypted
callback destinations, key rotation and bounded webhook retry remain intact.
Every send rechecks the current subscription, receipt and exact Job access.
Raw references stay out of event payloads, generic status summaries and logs.

## Card-free policy and retained recovery

The optional input is persisted as `completionDeliveryPolicy: "events"`.
Legacy Jobs keep their original `live-card` or `direct-wait` policy; there is no
retroactive conversion. Events intent is separate from actual subscription:

| Exact-Job field | Meaning |
| --- | --- |
| `eventSubscription.state=pending` | No callback is active yet; an unbound live grant may exist. A failed challenge still admits no subscription. |
| `active` | A matching live receipt and verified bound subscription exist in this runtime. This does not promise delivery/review. |
| `unavailable` | The runtime cannot deliver, or the previously bound/issued grant is expired, revoked, unsubscribed or inaccessible. |

Subscription authority and delivery are separate. While its delivery ledger is
retained, an exact Job also exposes `eventSubscription.delivery`:

| Delivery field | Meaning |
| --- | --- |
| `state` | `waiting` for terminal intent, `pending` for send/retry, `acknowledged` for webhook receipt, or `failed` for final failure. ACK is not GPT review. |
| `attempts` | The persisted number of webhook send attempts. |
| `lastHttpStatus` | The last HTTP code, or `null` when no HTTP response is available. No endpoint or raw error text is exposed. |
| `failureReason` | `callback_rejected` for a permanent callback rejection, `retry_exhausted` for exhausted transient/network attempts, otherwise `null`. |

For example, an otherwise valid subscription can remain `state: "active"`
while its delivery is `failed` after HTTP 413 or eight HTTP 503 attempts.
`codex_status` and `codex_task` replay retain that distinction and explicitly
warn that automatic delivery has stopped. They supply no automatic issue,
card, polling or rerun action for a final delivery failure. A 410 additionally
reports `reason: "callback_gone"`. Other unavailable reasons distinguish expiry,
Job/history availability, project access and runtime availability. Explicit stops retain their reason
even after credentials and delivery records are cleaned up or the Bridge
restarts. A delivery failure never changes a successful Codex Job to failed;
the original result remains readable under the existing scope and retention
rules.
After Job/history cleanup, monitoring is `job_unavailable`; stale in-memory
Job handles cannot receive a new delegation or produce an issuance hint.

Events admission/status never requests an automatic Dashboard mount or a completion polling loop. The card sender is retired for every policy: old completion calls and automatic Dashboard arguments return `CARD_DELIVERY_RETIRED` before any wait, claim, or Job mutation. New Dashboard v4 keeps explicit state/history/control display and has no watcher or message sender. See the [deployment transition](issue-221-delivery-transition.md).

Subscription failure must be surfaced. There is no implicit card, schedule or
repeated status-poll fallback. Manual exact reads remain available. Terminal
Events intent protects the original result for 24 hours even before callback
admission; subscribed result recovery also survives ACK, failure, unsubscribe
and revocation. Afterwards existing retention applies. Terminal receipts,
result-offer evidence, reviewedVersion and followup deduplication remain distinct.
Intermediate input/approval is not terminal completion; no claim is made that
terminal-only Events resolve every unattended input boundary.

## Local verification and actual host gates

`test/mcpEventDelegation.test.ts` uses signed OAuth JWTs, a loopback JWKS server,
real HTTP MCP handlers and temporary SQLite. It exercises missing/present bad
sessions, principal/Job/event substitution, system-owned references, response
loss/restart/refresh, first-callback races, expiry/revocation/unsubscribe during
verification, ACK/rotation races, transaction rollback, bounded grants, finite
original-result retention, old-card refusal and a card-free synthetic A-to-B
sequence with concurrent B retries converging to one execution. Existing Events,
OAuth, followup and output-contract tests remain applicable.
Additional regressions route the injected webhook sender to an isolated real
HTTP callback returning 413, 410 or eight 503 responses and verify exact status,
task replay, failure sanitization and retained results. They also cover delivery
phases, explicit-stop guidance, deliberately resumed new references, legacy
cleanup/restart, pending callback stops and UoW rollback.

Those tests establish Bridge behavior. **They are not actual GPT review or host
resumption evidence.** Real host acceptance must separately observe:

- custom arguments preserved on native subscribe, refresh and unsubscribe;
- resumed ordinary tools keep the original conversation scope;
- Dashboard unopened throughout; leave A's chat before terminal; A event resumes
  GPT, exact A is read/reviewed, exactly one preapproved B is admitted and B's
  own event completes, with zero automatic Dashboard calls and zero ui/message;
- duplicate events, old cards, token refresh/restart and denied-access controls.

The successful prior fresh A has `approvedFollowups=0`; do not use it to run B.
The final trial needs a separately authorized A with the exact B approved before
admission. If resumed tools lack the original scope, leave a host gate and do not
weaken result or followup checks. Temporary public issuer reachability and the
prototype authorization service's restart/refresh persistence are separate
operational conditions; product-ledger persistence does not resolve them.

The [2026-10-02 real-host audit](audits/2026-10-02-issue-213-host-scope-gate.md)
now observes native subscribe/unsubscribe preserving both custom arguments,
callback verification, terminal delivery and GPT resumption. The resumed
ordinary exact-Job read resolves to a different scope despite the same OAuth
principal and the UI's same-chat setting, and remains denied. B was not admitted.
Native refresh, departure while A was running and full A-to-B acceptance remain
unverified; no result/task authority is added to the monitoring reference.

Dashboard iframe deployment acceptance remains a separate UI test. The prepared
OpenAI inquiry is still unsent. Issue #213 stays **OPEN** until the real card-free
Events A-to-B acceptance succeeds.
