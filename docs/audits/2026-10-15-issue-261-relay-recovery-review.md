# #261 input relay recovery correction and independent review

Date: 2026-10-15 (Asia/Seoul). Baseline and integration target:
`ba6d8a669674114773280cf109a85fc710e8b68d`, `dev` / `origin/dev` when this
follow-up began. This corrects the [initial implementation audit](2026-10-15-issue-261-relay.md).

## Findings and correction

The user's independent review reproduced a P1 failure in the original delivery
module: the same unresolved question could return as `pending`, attempts 0,
after `connected → liveness-unknown → connected`, despite an earlier
`accepted`, `unknown` or `sending` attempt. Stable event identity alone did not
preserve its delivery record. The initial integration/push report was correct;
it did not establish that all #261 requirements were satisfied.

Four focused regressions were run against the unchanged baseline before the
fix. All four failed: the three delivery states each allowed a second send
entry, and exact running Job status described Relay as direct result delivery.
These were functional fixtures using disposable SQLite / controlled HTTP MCP
upstream replies, not actual duplicate ChatGPT messages observed in production.

The correction separates source identity from dispatch eligibility. Owner
liveness loss retains the current event's complete minimal delivery record and
pauses claim/entry. It removes that event from readiness without changing its
attempt, lease, counter, retry or outcome. Recovery restores eligibility for
that record; entered or accepted/uncertain sends never become new pending
attempts. The same attempt's late ACK remains recordable while paused.

Actual resolution/replacement moves the inactive event's minimal receipt to
an exact indexed `relay_event_history_v1/<jobId>/<eventId>` key. An exact identity
return restores it atomically; the current registration remains authoritative.
Inactive events cannot obtain late entry or reopen through stale ACKs.
Progress/liveness changes do not append history. Common Job expiry deletes
inactive receipts by indexed Job prefix, and project deletion removes them
under the existing project-identity cleanup. There is no SQL migration, separate
database, retention override, source-body copy or new message API.

Running `relay-card` status now explicitly describes automatic event-reference
relay. Its optional exact queries/bounded waits agree with `nextActions` and
the [delivery contract](../relay-delivery.md).

The change preserves records present at upgrade. It cannot reconstruct prior
delivery evidence already erased by the old defect. No operational data repair
or retroactive delivery certainty is claimed.

## Verification scope

Final implementation checks ran on the content committed as
`d290d9bb3e8117d2352f13361a52b2deb42eb539`, using Node 24.11.1, temporary state
and controlled upstream/host replies.
No operational DB, user Job, actual Codex work session or runtime deployment is
part of this correction.

| Check | Result |
| --- | --- |
| Baseline red proof | 4 focused regressions failed before production edits. |
| Delivery / admission / contract selection | 136 passed in 12 files: `relayDelivery`, `relayAdmission`, `relayCard`, `stateStore`, `questionStore`, `questionOrchestration`, `issue247Followups`, `issue221Delivery`, `outputContracts`, `uiResourceCompatibility`, `uiResourceFiles`, `releaseManifest`. |
| Relay subset within that selection | 45 cases: 29 SQLite delivery/authority/retention fixtures, 8 HTTP MCP admission/status groups, 8 shipped-HTML script cases under Node `vm`. |
| General task regression | 55 passed, 1 duration case explicitly excluded. |
| Build | `npm run build` passed, including localization and release metadata/policy checks. |
| Fast schema | `npm run validate:fast` passed using an isolated repository-pinned Codex CLI 0.153.3 (416 JSON / 827 TypeScript generated schema files). The installed user's CLI was not replaced. |
| Native checks | `npm run macos:check` passed: localization/native-input contracts and 343 Swift tests, including 3 existing opt-in skips, with 0 failures. |

The delivery coverage now includes the three P1 outcomes through owner
reconnection, each across a SQLite restart, actual resolution/replacement and
the same identity's return, pending/leased suspension, rollback and committed
readiness, no writer for repeated unchanged paused recovery, late ACK and proven
no-send retry while paused, ordinary retention expiry and project deletion.
States/order are constructed directly, without waiting for a lifetime boundary,
shortening retention, replacing the clock or running a duration substitute.

The earlier browser six are `test:issue-221-card` synthetic-host Chromium
Dashboard retirement/legacy sender checks. They are not new Relay end-to-end
evidence and were not rerun for this correction. The eight Relay HTML cases
above run the shipped script in Node `vm`; HTTP MCP and SQLite checks are
separate. Real GPT automatic resumption, real A→review→B and duration/soak or
accelerated substitutes remain explicitly excluded. User observation is not
an additional acceptance gate. Host visibility/lifetime and conversation-wide
exactly-once delivery are not established by these fixtures.

## Fixed-commit independent review

A fresh Codex reviewer agent, without implementation conversation history or
editing responsibility, reviewed `56e850bc25034c7fd138336797164f446ac9b417`
against the baseline. This is a separate agent's code review, not a claim of
human approval or real-host acceptance. The reviewer reported:

> The original P1 delivery-history reset did not reproduce. Inspection and
> functional checks supported preservation across pause/resume,
> resolution/replacement/reactivation, restart, late ACK, and cleanup.

The review found one actionable **P2** at `src/tools.ts:11101` and its
`nextActions` guidance: after successful HTTP `codex_relay_control` relay stop,
exact running status still promised automatic relay/remained connected even
though terminal completion correctly produced no pending notice. A
followups-only stop must continue allowing notices.

Reviewer-run checks at that SHA: 42 Relay suite tests; 15 independent disposable
scenarios for inactive-history restart/reactivation, additional owner states,
ownership denial, archive/restore rollback, stops and indexed recovery at 32/64
records; an additional HTTP fixture reproducing P2; TypeScript `--noEmit` and
`git diff --check`. The worktree remained clean. These are the reviewer's
functional reports, separate from the implementation checks above.

The P2 correction derives shared message/next-action guidance from current goal
stops, closed Activity, paused input and registration, while keeping the
admission policy immutable. Enabled delivery is conditional on an available
host connection. Three HTTP status regressions cover relay stop, followups-only
stop and a directly constructed closed-goal state; they failed against the
first fixed code and pass after the correction. Execution continues and only
followups-only stopping preserves pending notices in that fixture.

The same independent reviewer then reviewed the new fixed commit
`d290d9bb3e8117d2352f13361a52b2deb42eb539`. Its completed report states:

> No actionable findings in the reviewed change or exercised surrounding paths.

The reviewer independently reran 45 Relay suite tests and the 15 supplemental
history scenarios, and passed six new HTTP variants: enabled, relay stop,
followups-only stop, ended goal, paused input and missing registration. Each
compared message, next actions and terminal notice eligibility. TypeScript
`--noEmit`, diff checks and the clean/fixed-HEAD check passed again. Paused and
ended states were constructed directly; the latter does not assert that a
running Activity can be completed through its public tool.

The [retained reports, reproducible scripts and raw status observations](2026-10-15-issue-261-review-evidence/README.md)
preserve the reviewer-created bytes with SHA-256 checksums. The final audit
update adds only documentation/evidence after the reviewed code; production
source and regression tests remain identical to the reviewed commit. Integration
target remains `dev`; this code review is not human or real-host acceptance.
