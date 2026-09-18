# Execution history and current work

The current dashboard and macOS menu show **Current work**, **Problems**, and
**Run history**. Problems has **Needs action**, **Failure history**, and **Automatic
processing** views. Finished failures/interrupted runs enter Failure history
without requiring user acknowledgement. Needs action contains unresolved runtime
inspection, disconnection, and termination problems. A probe that has not yet run
is an inspection notice and is not a failed inspection.

Current work contains execution, response waits, termination in progress and
observed background work. Finished runs keep their original status in history.
Native and card rows use the same time rule: live turns show elapsed work time at
the last explicit snapshot; terminal turns show recorded duration and relative end time.
Missing historical timing remains unavailable.

## Automatic recovery and asynchronous Job ownership

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

Every `codex_task` admission durably records the request receipt, Job identity,
state, versions, and requery handles before it returns. The Job then runs
independently of the originating GPT response, MCP request, HTTP connection, and
card. A disconnect is retained only as transport evidence; it is not cancellation.

If the admission response is lost, the caller can recover the same receipt with
`codex_status({query:{kind:"request", requestId}})` in the original scope. An
identical `codex_task` retry returns that existing Job, while a different payload
with the same request ID is rejected. Terminal results are read from exact status;
there is no callback lease, wait token, or continuation authority. A Job reaching
a terminal state does not by itself close its Activity: Activity sealing,
completion barriers, verification, and multi-Job policy keep their own lifecycle.

Safe maintenance never authorizes ambiguous task replay. After an unexpected
restart, unfinished persisted Jobs become interrupted for inspection and are not
submitted again automatically. There is no queued GPT response, generic
future-session handoff, or wake mechanism; paired GPT result delivery is outside
this bridge contract. Operational issues remain in the native menu and Dashboard.

A fresh confirmed-to-unknown inspection transition opens a new durable incident,
even when the Agent, thread and latest Job have not changed. Repeated failed
inspections preserve that incident's three-attempt budget. Verified recovery closes
it atomically with its evidence; a later recurrence gets a separate record and
budget. Restarting preserves both the current incident and older action history.
The current runtime problem displays only its own incident's automatic result;
older resolved evidence remains in Automatic processing. A fresh failed inspection
is actionable immediately, even while older display details remain cached. A confirmed manual or
display inspection can also close an unresolved inspection incident.

The schema-16-to-17 checkpoint adds persistent incident identities to the
automatic-action journal. Current upgrades run it under the single private
pre-schema-23 recovery backup. Existing attempt budgets, failed outcomes and
cancellation provenance remain unchanged. Automatic records follow history
retention; unresolved budgets survive while their original work is retained.

## Optional failure review and manual recovery

Failure history retains all failed/interrupted executions, with optional review
and undo controls. Needs action has filters for unavailable status, failed
termination and disconnection. Automatic processing shows action, attempt count,
current state and evidence. The Problems summary counts unresolved runtime issues,
and opens this dedicated area. Acknowledgement belongs to each
execution, so a later success or a different failure on the same Agent cannot
hide the earlier unreviewed failure. Failures belonging to Agents restored by the
schema-18 migration remain reviewable. Every retained failure remains available throughout its configured
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
Both interfaces read the same durable state. Native clients still subscribe to
service changes, while Dashboard display data reloads only after its own actions,
explicit refresh, menu reopening, or a card scope/history request.

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

## Agent restoration and compatibility

Schema 18 restores every Agent archived by earlier bridge versions before current
history is served. The migration preserves its identity, Activity/thread/project
links, retained executions and results, review state, next-run settings and stored
timestamps. It restores active and waiting state from a retained current Job,
keeps orphan evidence, and otherwise makes the Agent idle. It performs no work
replay, thread resume, or Codex conversation load.

Current native and card interfaces have no Agent archive/restore controls, list,
filter or API schema. Dashboard history is read through `codex_ui_read`; targeted
review and recovery mutations use `codex_ui_problem` with an exact execution
proof. Retained archive/restore inputs are rejected with
`AGENT_ARCHIVE_REMOVED` without changing the Agent. Snapshots without the optional
`problems` query retain the prior seven-day/latest-Agent problem projection for
compatibility. Clients that send `problems` without `view` retain the earlier
per-execution Needs action/Reviewed history contract. Current clients send
`view: actionable`, `history`, or `automatic`.

## Retention

General Settings provides 7, 30, 90 days, or indefinite history retention. The
default is **30 days**. The settings pane and Run history both disclose the policy
and the last non-empty cleanup time and count. Changing the policy affects the
next maintenance pass; increasing it cannot restore already removed history.

After the existing full-result retention has archived a terminal Job, history
maintenance removes its expired execution/usage/review display summary and
disposable events. It preserves formal terminal state and timing, a compact
terminal receipt, and the original
request reservation to prevent replay. Agent identity, thread linkage, project pins,
cancellation/delivery journals, original Codex conversations, and project files
remain intact. Active work, blocking responses, undelivered results, unresolved
response delivery, pending cancellations, and valid result holds are protected.
Indefinite history retention does not change the existing full-result or raw
log retention limits documented in [thread-lifecycle.md](thread-lifecycle.md).

Each transaction scans at most 500 terminal rows. A persisted cursor progresses
past protected batches. Late snapshots cannot resurrect expired display data.
Native and card pagination discard cached history pages when cleanup changes the
removal count. The schema-14-to-15 checkpoint enables these rules under the
current upgrade's single private recovery backup.

Schema 19 stores the per-Job acknowledgement/expiry sequence in
`work_history_state` and the global revision, cursor, and cleanup totals in
`work_history_control`. It removes their dynamic metadata keys and stores the one
display summary in `jobs.summary`. See [database schema and lifecycle](database-schema.md)
for the complete ownership and retention matrix.

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

Current resource generations are recorded in the generated UI manifest. Only
Dashboard and Settings are current resources; each has one current HTML file and
an explicit URI version. The Dashboard HTML budget is 200 KiB, including problem review,
history actions and policy copy in all nine supported languages.
