# Execution history and current work

The current dashboard and macOS menu show **Current work**, **Problems**, and
**Run history**. Problems has **Needs action**, **Failure history**, and **Automatic
processing** views. Finished failures/interrupted runs enter Failure history
without requiring user acknowledgement. Needs action contains unresolved runtime
inspection, disconnection, and termination problems. A probe that has not yet run
is an inspection notice and is not a failed inspection.

Current work contains execution, response waits, termination in progress and
observed background work. Finished runs keep their original status in history.
Native and card rows use the same time rule: live turns show elapsed work time and
relative start time; terminal turns show recorded duration and relative end time.
Missing historical timing remains unavailable.

## Automatic recovery and original GPT wait

The bridge performs safe maintenance without asking the user to review every
failed turn. It freshly rechecks unknown/disconnected state without loading a
thread, releases idle persistent connections after failed/interrupted/cancelled
work, and retries an already requested exact-turn stop. Attempts are durable,
limited to three per incident, and spaced by five then thirty seconds. A restart
preserves the budget and never converts an interrupted attempt into success.
Each sweep admits at most four incidents; new work admission and shutdown take
priority. Actual evidence is required before an automatic record becomes resolved.

Connection release uses the existing worker maintenance lock, current execution
and connection revisions, non-loading background inspection, and loaded-thread
inventory. A shared worker can retire only when all its loaded conversations are
eligible finished persistent connections and have no active work, pending requests,
unknown state, or protected background process. Ephemeral or unowned threads prevent
retirement. Background services are not killed merely because their parent turn
failed. An automatic stop retry requires the existing failed cancellation intent,
same Job/thread/turn/worker generation, and exact version; it never falls back to
process-group termination. Another conversation's running Job remains untouched.

Task-level GPT judgment is returned only from a live original `codex_task` callback
or a live exact-Job/input `codex_status` wait descended from it. `waitContext.token`
is passed as `waitToken` to the next bounded wait; it is single-use, rotated after
each wait, expires after a 90-second gap, and binds conversation, Job and original
task request. It is never persisted or exposed by replay, overview, cards, or
historical reads. A failure must arise while that callback is observing running
work. The bridge gives safe recovery a bounded first chance before returning the
failure receipt. Reading the receipt does not resolve the issue or prove success.

The host does not supply a reliable GPT-response-ended signal. A token proves
continuation provenance, not that a previous GPT response remains alive. Server
instructions therefore require discarding it when that response ends; server-side
leases exist only during actual callbacks, and aborted callbacks return no recovery
directive. There is no queued GPT recovery, generic future-session handoff, or wake
mechanism. Once the original wait has ended, safe bridge maintenance continues and
remaining operational issues stay in the native menu and dashboard. Any GPT retry
must stay within the original user's task authorization and verify its result.

Schema 16 adds the automatic action journal and creates a private consistent
pre-migration backup. Original failed outcomes and cancellation provenance remain
unchanged. Automatic records follow history retention; unresolved budgets survive
while their original work is retained.

## Optional failure review and manual recovery

Failure history retains all failed/interrupted executions, with optional review
and undo controls. Needs action has filters for unavailable status, failed
termination and disconnection. Automatic processing shows action, attempt count,
current state and evidence. The Problems summary counts unresolved runtime issues,
and opens this dedicated area. Acknowledgement belongs to each
execution, so a later success or a different failure on the same Agent cannot
hide the earlier unreviewed failure. Archived Agents' retained failures remain
reviewable. Every retained failure remains available throughout its configured
retention period; seven days no longer silently removes an unreviewed item in
current clients.

**Acknowledge** records optional review while the failure stays in Failure history
with its original outcome. **Undo review** removes that review mark. Neither
changes the Needs action count. The native menu supports individual and
all-finished-failure review. The card additionally supports selected failures and
limits bulk review to its chosen conversation/all-work scope. Bulk review collects
all matching pages before changing anything, then sends at most 100 exact targets
per atomic request. A changed page revision cancels collection. A changed target
rejects its whole request, and partial completion across requests is reported.
Both interfaces read the same durable state. Native clients subscribe to changes;
cards reload after their own actions, refresh, and visibility recovery.

Unavailable runtime state cannot be acknowledged. **Check status again** makes a
fresh, bounded, non-loading inspection. The problem remains while execution or
background state is unknown. An orphan can be recorded as resolved only when
there is no active Job and fresh evidence confirms no loaded turn or background
process. This preserves the Agent and original outcomes. Changed execution
identity or a later failed inspection invalidates that resolution.

**Retry termination** is offered only for failed termination. The confirmation
shows the exact number and names of affected executions. A changed impact or
execution revision rejects the action before termination. A retry records durable
cancellation provenance and remains idempotent. Remote native clients keep their
existing non-execution authority and do not offer or permit this stop action.

The native API uses `dashboard.snapshot.problems` and `dashboard.problem`. Cards
first read `codex_ui_read` with `view: problem-control`, then send the exact action
to app-private `codex_ui_problem`. A five-minute proof binds the entire target set,
revision, action, stop impact, widget, host identity and selected scope. Proofs
cannot authorize an unrelated action; writes never use a fallback transport or
automatic replay. Local/native review and remote review use existing authenticated
companion paths; remote review requires `settings.write`.

## Agent archive and compatibility

History separately offers **Archive Agent** / **Restore Agent**. Archiving changes
only the Bridge Agent lifecycle after fresh non-loading inspection and revision
checks confirm no active work or unknown background state. It never stops work,
changes an outcome, or archives/deletes a Codex conversation.

`dashboard.history` and app-private `codex_ui_history` remain for these controls
and immutable older cards. Snapshots without the optional `problems` query retain
the prior seven-day/latest-Agent problem projection for compatibility. Clients
that send `problems` without `view` retain the earlier per-execution Needs
action/Reviewed history contract. Current clients send `view: actionable`,
`history`, or `automatic`. Agent archive and optional review remain independent.

## Retention

General Settings provides 7, 30, 90 days, or indefinite history retention. The
default is **30 days**. The settings pane and Run history both disclose the policy
and the last non-empty cleanup time and count. Changing the policy affects the
next maintenance pass; increasing it cannot restore already removed history.

After the existing full-result retention has archived a terminal Job, history
maintenance removes its expired display summary, timing/model/error/usage details,
and disposable events. It preserves a compact terminal receipt and the original
request reservation to prevent replay. Agent identity, thread linkage, project pins,
cancellation/delivery journals, original Codex conversations, and project files
remain intact. Active work, blocking responses, undelivered results, unresolved
response delivery, pending cancellations, and valid result holds are protected.
Indefinite history retention does not change the existing full-result or raw
log retention limits documented in [thread-lifecycle.md](thread-lifecycle.md).

Each transaction scans at most 500 terminal rows. A persisted cursor progresses
past protected batches. Late snapshots cannot resurrect expired display data.
Native and card pagination discard cached history pages when cleanup changes the
removal count. Schema 15 creates a consistent private pre-migration backup before
enabling these rules.

## Process inspection

The dashboard ranks the entire known Agent set by last inspection attempt before
applying its 200-candidate display budget. It merges observations from all retained
cache entries. This replaces the repeated selection of the same 200 recent Agents
that left 84–88 of 284 Agents perpetually uninspected. Failed inspections also
participate in fair scheduling; active liveness can be checked again immediately.
Modern history rows only request non-loading background inspection, avoiding
unnecessary reads of old Codex threads. Live/unknown Agent state still receives
liveness inspection. Unknown results remain visibly unknown.

## Other macOS settings fixes

Notification authorization refreshes when settings open and when the application
becomes active. Authorized permission shows its current state; denied permission
links to macOS notification settings. Repeated requests do not prompt again after
authorization. The official model-description disclosure uses the shared full-row
button and leading-aligned, selectable text.

Current resource generations are Dashboard 27, Settings 20, and Activity 30. Prior published
resource snapshots remain immutable. The Dashboard HTML budget is 200 KiB, including
problem review, history actions and policy copy in all nine supported languages.
