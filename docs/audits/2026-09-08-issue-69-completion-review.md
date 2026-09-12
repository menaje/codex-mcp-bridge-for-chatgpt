# Issue #69 completion review

This is the **pre-integration review**. The subsequent integration resolved
the code findings and is recorded in [integration and rollout preparation](2026-09-08-issue-69-integration.md).
The actual-host and operating rollout conditions remain open.

The overall issue is **not complete**. This review inspected `b6157b0`, the
running service, GitHub acceptance criteria, and the independently implemented
#70 follow-up at `e62b583`. It did not change the user's running service,
settings, or existing work, and did not merge any branches.

## Confirmed implementation

The public Task input has no permission fields. The bridge resolves saved
access settings; the previous caller-permission-versus-setting comparison is
absent. Retired permission-bearing requests cannot admit new work, while exact
already-admitted replay returns its original result. Existing-thread and actual
upstream policy checks remain distinct.

Eighteen targeted permission, continuation, replay and project tests passed
again; 219 other tests were excluded by the name filter. Release checks passed.
This was not another full 760-test run. The prior full suite and live background
Job/result evidence remain valid for that tested revision, not the unmerged
current development work.

## Blocking findings

1. **The revised implementation is not deployed.** The service still runs
   `54296e0f0010-dirty:9af435da30f3`, following the explicitly recorded restoration.
   Saved access is `always-full` and Priority is off.
2. **The #70 fixes are not in #69.** Isolated calls against actual MCP handlers
   reproduced four recovery problems in #69: unavailable Alpha recommends
   available Beta, omission of a project recommends executing the sole available
   project, an unknown Job suggests creating a new task, and an unregistered
   project name immediately directs opening Settings. The same probes against
   #70 no longer produced these behaviors. Both probes used synthetic projects,
   zero upstream calls, zero Jobs and no live state. #70 also adds the card-free
   model-policy read; its local verification is not deployment into #69.
3. **Final code integration has unresolved conflicts.** A merge-tree preview
   with #70 was clean. A separate preview against committed `dev` at `323d55c`
   found seven conflicting files: the native localization catalog, Activity,
   Dashboard, Settings, UI translations, and the generated manifest plus lock.
   The original directory also has 116 pending status entries. Those uncommitted
   changes were not included in this preview, so seven is not a claim about the
   final combined conflict count. Neither preview changed a checkout or index.
4. **User-flow acceptance remains partial.** Existing conversations retaining
   old tool schemas, native/ChatGPT notification delivery, the prior ended-GPT
   handoff, actual approval/input/stop/process controls, and active-work restart
   still require their recorded rollout checks. The previous Job completed and
   GPT retrieved its result; the host-denied Activity completion metadata remains
   open. No denied action was retried during this review.

The 14 legacy names are deliberately retained under the agreed compatibility
window and separate deletion decision. Their presence is not an accidental
omission and does not by itself require immediate removal.

The prior wording should be read as **permission implementation and one actual
execution path verified**, not final integration or issue completion. The
implementation, transition checks, and operating release must be reported
separately. Machine-readable observations are in
[the completion review](issue-69-completion-review.json).
