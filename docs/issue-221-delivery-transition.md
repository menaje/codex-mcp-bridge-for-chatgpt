# Ordinary Chat delivery transition (#221)

The integration target is `dev`, starting at
`4fc1619b07a50c4454daa6c079cbd495ba7d02b4`. This document fixes the transition
contract before the delivery implementation. Implementation, fixture evidence,
deployment identity, and real ChatGPT acceptance are separate gates.

| State at upgrade | Contract |
| --- | --- |
| New ordinary Job | Always admit `direct-wait`, including old true, false, and missing experimental settings. |
| Completed historical Job | Preserve admission policy, request hash, exact identity, result and authorization; recover through ordinary exact reads. |
| Running historical live-card Job | Keep the execution and identity. Disable card sending, supply same-Job bounded waits and input reads; never cancel or replace because of delivery retirement. |
| Unadmitted historical live-card followup | Return `FOLLOWUP_DELIVERY_RETIRED` after checking original scope and prompt. Do not rewrite the receipt or reserve a replacement. Explain explicit reapproval as new logical work with a fresh requestId and the original Activity/Agent context. |
| Already admitted B replay | Authenticate the original scope and validate the prompt, canonical request identity and context, then return the original B before rejecting new work under its historical delivery policy. Do not revalidate reviewedVersion equality for this idempotent return. Retention expiry returns a receipt/expiry error, never another B. |
| Historical Events Job/receipt | Preserve exact authorized reads and history. Ordinary mode cannot admit a new Events followup or create monitoring grants. Already admitted B remains replayable. |

The current source stores policy on Jobs and followup receipts and compares them
at atomic admission. It must not regenerate followupIds, canonical requestIds,
prompt digests or request hashes to implement this upgrade. No approval migration
framework is introduced. New explicitly reapproved work uses the ordinary task
contract and cannot silently consume the old followup.

First admission of an approved B requires the current completed predecessor's
reviewedVersion and a recorded exact result offer. An older version is rejected
without admitting B or modifying its receipt. After admission, replay returns
the existing B even with an older reviewedVersion; it creates no execution and
does not change the recorded review. These are separate validation boundaries.

A replay may retain its old delivery selector after response loss. A narrow
wire compatibility rule accepts that selector only for an already-admitted B
with the original authenticated scope, prompt digest and canonical request ID.
The ordinary handler still verifies every context override and returns that B
or its retention-expiry error before considering admission. No stored approval,
policy or hash changes; pending and unrelated requests receive retired-mode
errors. This compatibility is not advertised as a new ordinary delivery option.

## Remove and retain

Remove the Dashboard completion watcher, terminal-result message construction,
`ui/message`/follow-up sends, automatic render actions, and card-only
claim/accept/reject/release execution. Keep ordinary exact result-offer records,
approval receipts, scope checks, execution ACKs, native notification outbox/ACKs,
card initialization, display refresh, and existing explicit management controls.

Retired wire calls receive an identifiable upgrade error and cannot offer a
completion payload, claim a lease, mutate a Job, or launch work. Old stored
delivery records remain historical data. A server cannot retract a message or
stop host `ui/message` already initiated by an old iframe. Cached-card tests must
distinguish blocked server-dependent requests from an iframe with a previously
received result. Close old cards, refresh connector discovery, and reopen only
on explicit request; use a new conversation when a host retains the old mount.

## Required evidence

Record red/green summary tests, normal tool/capability/input/output differences,
legacy pending versus admitted replay, settings migration restart/idempotency,
same-Job timeout/input/approval, result expiry and original-scope rejection,
normal startup without Events services, native notifications, and new/old card
browser fixtures. Bind built and deployed source/manifest/resource identity.
Real ChatGPT A-to-B and explicit-card display/management without sending must
run on the deployed version before closing #221.

Existing #222 long-duration measurements are reused unless the final diff changes
wait lifetime, transport/connection handling or result retention. User-confirmed
resume remains user-confirmed evidence, not a promise for every host.
