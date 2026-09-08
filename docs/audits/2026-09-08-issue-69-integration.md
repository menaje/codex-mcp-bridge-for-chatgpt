# Issue #69 integration and rollout preparation

The code integration and local validation are complete. **The issue and operating
rollout are not complete.** The current candidate has not replaced the running
service, and the earlier actual-host evidence does not establish adoption of
this integrated version.

## Integration and conflict cause

The integrated product source is `f5027b367309088d2e68782d99e13aa0e46b7033`.
It includes #69, #70's recovery fixes including `52607c9`, development commit
`323d55c`, and the original directory's pending work. `da41ba0` adds only #70
audit documentation. The subsequent browser assertion correction changes only
the expected English label from “GPT chooses per task” to “Bridge default”.

The original working tree was captured through a temporary Git index into
`2c3658b`, without changing its actual index or checkout. The source tree
`2501de7c902f14eaec6bb7568f6ff70a3eee9203` was compared again after integration
and still matches the original directory, including its 116 pending status
entries. Nothing was reset, stashed or overwritten in that directory.

The final merge had eight conflicting files, rather than the seven in the
earlier committed-dev-only preview: three setup/evaluation/question documents,
Activity, Dashboard, Settings, the generated UI manifest and its lock file.
The original pending work was part of the final merge and changed the merge
base/context. This was a code integration conflict between the card/tool
consolidation and the development Fast mode/UI changes. It was not another
GPT-requested permission versus saved-setting conflict.

Both intended changes were preserved: current card/tool names and historical
#68 context in documents, Activity form support plus Fast badges, Dashboard
details plus Fast styling, the current Settings description, and the union of
retained immutable card revisions. UI resources were regenerated with the
repository release tool. Compared with all four prior snapshots, no retained
URI, metadata or HTML bytes were lost or changed. See
[resource preservation](issue-69-integrated-resource-preservation.json).

## Verified behavior

The public Task still has no permission fields. Bridge settings decide access;
the original project's saved `always-full` and Fast mode off remain intact.
#70's errors preserve the intended project, never suggest creating a Job to
recover an unknown Job, and give executable catalog recovery using
`codex_models({"contractVersion":"2","refresh":true})`. Fixed selection
overrides and explicit fresh context have separate recovery instructions;
no saved policy is changed to resolve an error.

Discovery remains 12 GPT tools and 5 current app tools, with 12 additional
app-only compatibility descriptors during migration: 29 advertised names in
total. Two more compatibility names are accepted without advertisement. The
14 legacy names remain subject to a separate deletion decision.

The integrated migration descriptors total 234,009 bytes; GPT descriptors are
40,749 bytes versus the original 50,860 (19.9% smaller). The current 17-tool
subset totals 133,714 bytes. Operator discovery adds two tools, totaling 31
descriptors and 245,164 bytes. Total migration bytes still exceed the original
179,781 because old and new app contracts coexist. See the
[default](issue-69-integrated-card-tools.json) and
[operator](issue-69-integrated-operator-tools.json) inventories.

Production-handler counts still show Settings first display uses one snapshot
instead of two, and Dashboard structure plus enrichment uses two instead of
three. Opener/mount RPCs remain distinct; this is reduced duplicated server
work, not a claim that all opening RPCs disappeared.

## Validation

- Build, release policy and UI manifest checks passed. App Server compatibility
  matched CLI 0.153.3, with 416 JSON and 827 TypeScript schema files.
- The final full suite passed **780 tests in 63 files**, with four workers.
  A preceding run passed 779 but exceeded the unchanged five-second limit in
  one existing 24-Job projection fixture while browser tests also ran. The
  individual test passed, followed by the successful full run without those
  concurrent browser processes. No timeout was increased.
- macOS strict compilation/localization passed: **101 tests, 2 skipped,
  0 failures**. The app bundle was built and its ad-hoc signature verified.
- Browser tests used isolated fixtures, not the real ChatGPT host. Fast badges
  and Settings were checked in all nine languages on three renderers; Dashboard
  original-input controls passed four scenarios, progressive loading passed,
  and the built independent question renderer passed seven scenarios with
  zero Codex calls. The resilience suite's stale English permission label was
  corrected to the bridge-owned wording; all **29 resilience scenarios** then
  passed. The packaged runtime's 230 built files match the checked build.
- A consistent read-only copy of the actual database preserved all protected
  rows through two initializations/restarts and four app reads: **476 Jobs**,
  projects, preferences, links, results and idempotency records. No Codex call
  was made and the actual database was not replaced. The copy had no active
  Jobs or retained questions, so this does not establish active-Job recovery
  or new question-retention evidence. See
  [restart verification](issue-69-integrated-restart.json).

The packaged candidate identifies itself as
`f5027b367309:21c885d97b57`. Documentation and browser-test-only follow-ups do not
change its product source. Local browser artifacts and raw test logs are kept
outside Git. The machine-readable result is
[integration verification](issue-69-integration-verification.json).

## Actual-host boundary and remaining work

The normal computer-use tool reported that the Mac is locked and could not
unlock it. The user was asked to unlock it; no alternate route was used to
operate the locked ChatGPT UI. The running service is still
`54296e0f0010-dirty:9af435da30f3`, with no active Jobs. The integrated candidate
has not been activated and plugin discovery has not been refreshed in this run.

The remaining actual-host checks are unchanged: adoption of current descriptions
and model catalog v2, cached conversation schema transition, both native and
ChatGPT notifications, the existing automatic handoff behavior, original
approval/input/stop/process controls, and active-work restart. Prior host-denied
Activity completion was not retried. A retained final result is not proof of a
notification. Operational rollout and issue closure remain pending these
checks; legacy deletion is a separate later decision.
