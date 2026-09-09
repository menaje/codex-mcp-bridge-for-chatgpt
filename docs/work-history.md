# Execution history and current work

The current dashboard and macOS menu distinguish live work from the outcome of a
finished run. A failed or interrupted run stays in **Run history**, sorted by its
last execution time. It contributes to **Issues** for seven days, unless the user
acknowledges it or archives the Agent. A newer failed run on the same Agent requires
its own acknowledgement. Acknowledgement never changes the recorded outcome.

Actual running work, pending responses, uncertain live execution, failed termination,
and observed background processes remain current. A missing historical Codex thread
does not make an otherwise idle Agent current. Native and card rows use the same
rule for time: live turns show elapsed work time and relative start time; terminal
turns show recorded duration and relative end time. Missing historical start or
duration information remains unavailable instead of becoming zero or a continuously
increasing duration.

## Review and Agent archive

A history row offers **Acknowledge**, **Archive Agent**, or **Restore Agent** as
appropriate. Archiving is reversible and only changes the Bridge's Agent state.
Before archiving, the service checks the current Agent revision and inspects Codex
without resuming a thread. Live work or unverified background state blocks the
operation. A changed target after inspection also blocks it. It never stops a turn,
changes a result to success, or archives/deletes a Codex conversation.

The native companion uses `dashboard.history`. The mounted card first reads a
short-lived history proof through `codex_ui_read`, then calls app-private
`codex_ui_history`. Proofs bind the row revision, widget and host conversation;
request IDs make retries idempotent. A history proof cannot authorize execution
controls. Remote native management requires the existing `settings.write`
capability in addition to authentication and pinned server identity.

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

Current resource generations are Dashboard 25 and Settings 18. Prior published
resource snapshots remain immutable. The Dashboard HTML budget is 152 KiB, including
history actions and policy copy in all nine supported languages.
