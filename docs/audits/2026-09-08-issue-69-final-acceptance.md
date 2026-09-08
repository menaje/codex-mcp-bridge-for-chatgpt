# Issue #69 operating controls and remaining host gate

Follow-up to merged PR #71 (`899aca3`). This record distinguishes actual
ChatGPT observations, real Codex requests, and simulated browser tests.

## Scope correction

The issue explicitly excludes building a new, unsupported card-free wake of an
already-ended GPT response from mandatory completion. Earlier residual lists
incorrectly treated that feature as an unconditional gate. Existing mounted
Activity handoff and saved settings remain supported during the documented
compatibility period; no new Activity screen is created. New work uses an
active GPT response, bounded waits and exact Job result retrieval.

The [PR #71 operating run](2026-09-08-pr-71-runtime-acceptance.md) observed Codex
completion, retained result, GPT final answer and ChatGPT's unread indication
after leaving the work conversation. The old separate overview reopened and
refreshed. These observations establish the supported ChatGPT completion path;
they do not establish a native OS banner or a new ended-response wake.

Bridge native notifications continue to cover operational problems only, as
specified by #15 and `docs/operations.md`. This follow-up changes no native
notification or legacy handoff source. The official
[desktop settings reference](https://learn.chatgpt.com/docs/reference/settings)
documents app-owned turn notification preferences. Actual native-app UI access
was denied by the Computer Use tool for safety reasons; no OS banner is claimed.
#15's outstanding native notification-click and VoiceOver tests remain in #15.

## Defect found and repaired

The actual ChatGPT outer iframe had
`sandbox="allow-scripts allow-same-origin allow-forms"`, without `allow-modals`.
On the operating #71 build, clicking the overview's stop button produced no
confirmation and no cancellation. A second direct screen click behaved the
same; no JavaScript dialog was present. The renderer used native `confirm()`.

Commit `26ee1522f165a14d6b8b79949cc5d8724474d1b9` moves confirmation into the
card. It displays the selected project, work, Agent, process when applicable,
and impact warning. Cancel is initially focused. Refresh, target changes and
closing details remove stale confirmation. Final dispatch stays bound to the
displayed detail and uses the existing signed proof, exact versions and domain
handlers. No approval/scope check is relaxed and no mutation is auto-retried.

Affected retained renderers `942a289cb691` and `07b8cdf45ca3` receive an exact
serve-time repair of only their broken stop handlers. Snapshot bytes, resource
identities, metadata, remaining handlers and the existing name-helper repair
are preserved. Current resource: `dashboard/8fa4d968a57b.html`. Earlier
read-only overview resources remain unchanged.

Six browser cases load the current and both affected retained cards in a real
sandbox without `allow-modals`. Job/process confirmation, cancel without
dispatch, refresh invalidation, selected target/proof and double-click single
dispatch pass. Four existing original input/form/URL browser cases also pass.
Those tests use a simulated host; the operating observations below are separate.

## Operating build and preservation

The signed app was built from clean `26ee1522f165a14d6b8b79949cc5d8724474d1b9`:
`26ee1522f165:994b2f5f82d7`, source hash
`994b2f5f82d7c866d2a362d8171908cf5ea71bd5f4df09755d3e0619d08b73b8`.
After the test waits completed naturally, the helper drained with no active
Jobs, pending requests or background processes. The previous signed bundle and
SQLite snapshot were retained privately before replacement. The same operating
path was used; no user settings or projects were migrated or reset.

At 05:14:54 UTC the helper was running, tunnel connected, no last error, and
reported the new build. Signature verification passed before and after move
and after execution. The pre-replacement snapshot contains 480 Jobs,
208 Activities, 239 Agents, one settings record and four project records.
The first post-restart comparison found every pre-existing row unchanged.

Validation: 780 tests in 63 files; TypeScript build; release/UI manifest and
CLI 0.153.3 schema checks; macOS 101 tests, 99 passed, 2 opt-in skips, 0 failures;
9-language localization validation. No GitHub CI checks are configured, so
local validation is not reported as a GitHub CI pass.

## Actual controls

The browser used the existing separate overview conversation. Its host wrapper
still labels resource `dashboard/5c3aa611519e.html`; that label alone is not
evidence of the renderer bytes selected by ChatGPT. In-card confirmation was
visibly available after reloading it, without opening a replacement card.

- Job `51026ac6-5482-40fb-83d6-b990f50b2f24`, “수정 후 중단 검증”: started
  through GPT on the new build, with no Activity/Settings card. Canceling the
  in-card confirmation left it running. Some submitted attempts were refused
  with `INVALID_ARGUMENT` while the running version advanced; they are not
  counted as cancellations. After explicitly refreshing details and confirming
  again, exact version 16 was accepted at 05:19:32 UTC. The tool response and
  overview showed `cancelled`, version 18, `terminalOrigin: explicit-cancellation`,
  `source: widget-control`, tool `codex_ui_stop`, status `succeeded`, and the
  exact Codex App Server turn interruption. This was about four minutes into
  a ten-minute wait, not natural completion. No native dialog was used.

- Job `27134b8b-499d-4482-ac79-5602962187a0`, “원본 승인 검증”: a temporary
  project-local MCP fixture produced a real Codex approval elicitation for
  `original_control_probe.approval_probe`. The global row showed input needed;
  details displayed the original server/tool approval request. Clicking **거부**
  resolved it and the same Codex Job completed at 05:22:50 UTC, reporting a
  rejected decision and no retry. The fixture's invocation ledger remained
  absent: the tool body did not run. GPT's ordinary-question route was not used.

- Job `72fbeda0-fb9d-4eec-8aff-08452ad17d32`, “터미널 세션 종료 검증”:
  Codex ran `sleep 600` with a one-second yield and completed its turn with
  terminal session `50860`. At 05:28:35 UTC the runtime independently confirmed
  zero active Jobs and one remaining process. Overview details showed completed
  work and process `50860`. Its in-card confirmation identified the same
  project/work/Agent/process. After confirmation, the process disappeared from
  details and the runtime confirmed zero processes at 05:29:00 UTC. The Job's
  completed result stayed intact. An earlier shell-background attempt
  (`b485db09-670b-4522-9a68-9141e271184f`) had already exited and is not counted
  as a successful card process-termination test.

## Remaining actual-host gate

An additional original form-input test asked GPT to start a new Job that would
call `original_control_probe.input_probe`, then reflect the selected test colour
in its result. ChatGPT reported that its safety check rejected Job creation
before execution (its response reports two attempts). No such Job was admitted.
The displayed response supplied no detailed safety rationale. The request was
not reformulated or sent through another channel to circumvent that block.

This is **not** evidence of an input submission or reflection pass. The existing
four browser input/form/URL cases and #68's real CLI original-input response
tests remain valid, but do not substitute for this actual ChatGPT test. Issue
#69 remains open for this single original-input acceptance gate. The completed
stop fix, actual approval rejection and process termination can be merged and
operated independently. No native-banner or new ended-response-wake requirement
is added to #69; #15 and any separately approved wake feature keep their scope.

The temporary project-local MCP configuration was removed after verification,
with its exact contents checked before removal. The approval ledger remained
absent. A graceful helper restart clears the fixture's loaded MCP connection;
no saved project, model/access policy or authentication configuration was changed.

The final restart reported running/connected at 05:31:48 UTC, with zero active
Jobs, pending admissions/interactions and remaining processes, and no last error.
Comparison across 17 protected tables found zero changes to pre-existing rows,
including 480 Jobs, 208 Activities, 239 Agents, all 103,336 prior Job events,
settings/projects, steering and cancellation records. Four new test Jobs and
their own history were added. The question tables were empty in both snapshots;
that comparison is not represented as a new persisted-question host test.
The structured [acceptance report](issue-69-control-acceptance.json) records the
passing checks and blocked gate separately.
