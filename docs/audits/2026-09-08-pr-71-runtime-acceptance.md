# PR #71 runtime acceptance

The current PR bundle completed a real background Codex Job, GPT retrieved its
exact result, ChatGPT marked the conversation unread while the operator was in
the existing overview conversation, and graceful restart waited for the active
Job before replacing the runtime. This closes the execution/restart blocker
recorded in the earlier unlock audit. The user explicitly requested continuing
through PR merge and the following operating steps after the simple task worked.

## Artifact and checks

The earlier one-word success ran on the restored old operating bundle; it was
not used as current-PR execution evidence. A fresh development bundle was built
from clean commit `9a1334f14902039ab9e38f3d83ebf4a67b676bb2`, with build ID
`9a1334f14902:ee5c395db3f7`. Product `src` and Swift source were byte-identical to
the previously validated integrated source. The 780-test repository run and CLI
0.153.3 contract evidence therefore remain applicable. The fresh bundle build
also passed release checks, localization/compilation, and 101 macOS tests
(99 passed, two skipped, zero failed). Its ad-hoc signature passed before and
after moving the bundle to the actual operating path.

A previously copied staging bundle had an invalid sealed `node-which` link.
It was not deployed. The fresh signed bundle was moved intact instead.

## Actual ChatGPT execution and notification

ChatGPT plugin discovery was refreshed through the in-app browser and showed the
short Settings description and the current consolidated UI read tool. A new
conversation loaded the current definitions. The operator sent a short request
for a background 60-second wait followed by one word, without file changes.
GPT performed project/model lookup, admitted one new Job with a fresh Activity
and Agent, and used the current status contract to await its result. No new
Activity or Settings card appeared.

The Job used `gpt-6-astra / low`. Its recorded upstream access matched saved
bridge policy: `danger-full-access`, `on-request`, user approvals reviewer and
network access enabled. GPT did not change saved permissions or model policy.
The exact retained Job reached `completed` and its result contained the expected
one-word response. The expanded ChatGPT tool UI showed an exact Job terminal
wait with `waitMs: 60000`; GPT's final response named that same Job and returned
the expected result.

The operator left the work conversation while execution was active and opened
the existing separate global overview. That retained resource rendered the
running test, then `Codex turn completed` after refresh, with working detail
disclosure after restart. The ChatGPT sidebar displayed the work conversation
as **unread** with its final-response navigation marker before the operator
reopened it. This verifies ChatGPT's in-app completion indication for the
active-response path. It does not establish OS push/banner delivery or wake of
an already ended GPT response. A bounded overview enrichment warning was shown
during the transition; the retained structural state and exact detail remained
available and refreshed to the completed result.

## Graceful active-work restart and preserved state

The helper received one normal `runtime.restart` request in drain mode while
the sole test Job was running. Observed phases were running with one active Job,
draining with one, draining with zero, starting under a different launcher PID,
and running with a connected tunnel. No force was used. The same Job completed
normally and its result remained available after restart. This is graceful
completion-before-restart evidence, not a claim that an in-flight upstream turn
was killed and recovered.

The existing 477 Jobs, 205 Activities, 236 Agents, settings, four project rows
and registry row were compared against a consistent pre-switch SQLite backup.
Every pre-existing row in these tables was unchanged. Exactly one new test
Job/Activity/Agent was added. The database was not replaced, the original bundle
was retained for rollback, and the verified PR bundle remains running for the
authorized development rollout.

## Scope of the remaining issue #69 work

The earlier complex request's host rejection remains historical evidence; it
does not describe this successful later user-authorized simple request. The
current execution, result retrieval, in-app unread indication, retained overview
and graceful active-work restart are now verified. The independent question
round trip and short descriptions/model catalog v2 were already verified on
the identical product source in the unlock audit.

Issue #70's implementation and runtime adoption are ready for dev integration.
Keep issue #69 open for independently unverified native banner delivery,
already-ended-response Job wake, and real original approval/input/stop/process
controls. Existing loaded old tool definitions still require observed current
discovery. The retained compatibility window is unchanged. Development
integration and the user's local operating rollout do not claim every #69
acceptance criterion or a public stable release is complete.

See [structured evidence](pr-71-runtime-acceptance.json) and the earlier
[unlock audit](2026-09-08-issue-70-unlocked-host.md).
