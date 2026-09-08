# Issue #69 implementation and validation

2026-09-08. Implementation is based on local snapshot `6d84d4d`, which includes
the pre-existing pending #68 work. Review #69 relative to that snapshot; it is
not a claim that the baseline or this change is deployed. The original working
directory was preserved; changes were developed in an isolated worktree.

## Discovery and callable names

Measured with real MCP `tools/list` against isolated SQLite-backed servers.
The baseline was measured before changes, and its counts are retained in
[before](issue-69-card-tools-before.json). Current and operator measurements are
in [after](issue-69-card-tools-after.json) and
[operator](issue-69-card-tools-operator.json).

| Inventory | Before | Current default | Operator mode |
| --- | ---: | ---: | ---: |
| Model descriptors | 15 | 12 | 12 |
| App-only descriptors | 15 | 5 | 7 |
| Total advertised descriptors | 30 | 17 | 19 |
| Serialized descriptor bytes, summed per tool | 179,781 | 137,544 | 148,699 |
| Unadvertised compatibility names | 0 | 14 | 14 |
| Total accepted names during migration | 30 | 31 | 33 |

Discovery shrinks by 13 names and 42,237 bytes (23.5%). The temporary accepted-name
count is deliberately reported separately: old handlers have not all been
deleted. Fourteen bounded aliases share the retained handlers and do not publish
descriptors. Diagnostics and recovery detach are operator-only. There are no
additional experimental registrations. Alias removal requires the migration
window and completion/host checks in [Card tools](../card-tools.md).

## Actual work and calls

`scripts/card-open-audit.ts` counts application snapshot and catalog calls using
the production MCP handlers. For the baseline it imports an isolated archive
of `6d84d4d`, with a synthetic catalog and temporary database; no real Codex work
is executed. Raw cumulative observations are in
[before](issue-69-card-opens-before.json) and
[after](issue-69-card-opens-after.json).

| Flow | Before | After | Meaning |
| --- | ---: | ---: | --- |
| Settings open + first mount: snapshot calls | 2 | 1 | Opener no longer reads the editor |
| Settings open + first mount: catalog-provider calls | 2 | 1 | No duplicate catalog path in opener |
| Dashboard open + structure + enrichment: snapshot calls | 3 | 2 | Opener no longer builds an aggregate view |
| Question mount + submit + notify: app calls | 5 | 4 | Current action replies remove the final read |
| Question submit/notify host messages | 1 | 1 | Required host delivery is retained |

The public opener and mount RPCs still exist: Settings has two tool invocations
and Dashboard has three through enrichment. Their improvement is less duplicated
server work, not fewer UI-opening steps. The question flow saves one actual
app RPC, while preserving submission, claim, host dispatch and acknowledgment.
Question counts were measured in both current and legacy browser renderers
against the same real question handlers and SQLite store. The straightforward
compatibility-host case records old `card → submit → notify → notify → card`
versus current `ui_read → action:submit → action:claim → action:ack`.

The current question resource is approximately 22 KiB and independent of the
Activity renderer. Global details add original-request forms, control buttons
and their nine-language strings; the Dashboard HTML budget rises from 112 to
136 KiB to cover that deliberate addition. Structural rendering still precedes
bounded runtime/usage enrichment. Intermediate development resource hashes were
discarded; each final resource is added once while baseline immutable resources
remain available.

## Validation completed locally

- Final `npm run check`: TypeScript build, release checks and **754 tests in 62
  files passed**. Earlier failures exposed an empty-object union projection and
  stale expectations; published unions now retain closed branches and runtime
  validation. The final full run passed without a concurrent rebuild.
- MCP integration covers cross-conversation global UI controls, no expansion of
  GPT scope, wrong widget/target/version/request, ordinary-question refusal,
  same-request cancellation replay, shared-session process-stop deduplication,
  and an Agent version race during asynchronous process inventory. Existing
  termination impact, input cursor/wait, ownership and retained-result tests pass.
- Question browser: **7 current scenarios** (standard and compatibility hosts,
  missing app metadata, denial/retry, uncertain delivery, expiry and read failure
  recovery), including refresh/locale draft preservation and simulated page
  restoration. **6 legacy-renderer scenarios** also pass. No Codex execution or
  approval was triggered by question submission.
- Dashboard controls browser: **4 scenarios** covering choice/free-text inputs,
  secret original input, MCP form values and original request URL. Overview
  refresh preserves the selected detail-form answer. Screenshots were inspected.
- Progressive browser: **5 report groups** cover structural paint, enrichment,
  stale reply rejection and recovery for the overview/settings and retained
  Activity. Card resilience browser: **29 scenarios** cover metadata wrappers,
  errors, retry, late replies, visibility/page restoration, standard initialization,
  retained resources, read timeout and no mutation fallback retry.
- macOS localization and strict Swift checks: **100 tests, 2 skipped, 0 failures**.
- App Server compatibility: CLI **0.153.3**, 416 JSON and 827 TypeScript schema
  files matched. UI manifest and release policy checks pass. A release fragment
  documents the discovery change and compatibility conditions.

Browser artifacts are local under `output/playwright/`: `question-card-regression-built`,
`question-card-regression-built-legacy`, `dashboard-controls-regression`,
`progressive-card-regression`, and `card-resilience/dist`. These are real browser
tests with a simulated ChatGPT host, not evidence of actual ChatGPT resumption.

## Remaining rollout evidence

The user confirmed using both native and ChatGPT notifications. The saved
`background-only`/`auto-handoff` combination confirms an enabled legacy card
dependency; it does not itself prove which notification was received.

Saved values and mounted legacy handoff remain intact. New instructions keep the
current GPT response active through bounded waits and exact result retrieval.
Native notifications are unchanged and no bridge-native duplicate alerts were
added. Before deployment or closing #69, verify actual ChatGPT completion,
result retrieval and notification after leaving the work conversation, and
reopen the existing overview conversation. Verify that the host permits the
cached alias calls as well as the new discovery/visibility contract. Protocol
compatibility alone does not prove that host behavior.

No production replacement, push, or actual ChatGPT end-to-end notification test
was performed in this implementation run. The code is prepared for review;
the issue remains open for these explicit rollout checks.
