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

| Inventory | Before | Migration default | Operator mode |
| --- | ---: | ---: | ---: |
| Model descriptors | 15 | 12 | 12 |
| Current app-only descriptors | — | 5 | 5 |
| Retained app-only descriptors | — | 12 | 12 |
| Operator descriptors | — | 0 | 2 |
| Total app-only descriptors | 15 | 17 | 19 |
| Total advertised descriptors | 30 | 29 | 31 |
| Serialized descriptor bytes, summed per tool | 179,781 | 238,260 | 249,415 |
| Model-only descriptor bytes | 50,860 | 45,371 | 45,371 |
| Unadvertised compatibility names | 0 | 2 | 2 |
| Total accepted names during migration | 30 | 31 | 33 |

The current contract is 17 tools (12 model and 5 app-only), totaling 138,445
serialized bytes, but that is a subset of actual migration discovery. Real
ChatGPT testing invalidated the original 17-descriptor rollout: saved cards
require both their original presenter and their app-call descriptors. Twelve
retained app-only registrations now carry `codex/registrationTier: compatibility`;
only `codex_input` and `codex_activity_cancel` remain unadvertised aliases.

GPT discovery shrinks by three names and 5,489 bytes (10.8%). Total discovery
shrinks by only one name during migration, and its bytes increase by 58,479
because current and old app contracts coexist. Do not report the 17-tool subset
as the live inventory or claim all descriptor duplication has already gone.
After a separately recorded deletion decision, the retired 14 names can be
removed under the conditions in [Card tools](../card-tools.md). Common handlers
and retained data remain. Diagnostics and recovery detach are operator-only.

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

## Actual ChatGPT and state verification

The user confirmed using both native and ChatGPT notifications. Saved
`background-only`/`auto-handoff` values were preserved, and no duplicate native
notification feature was added.

On 2026-09-08, the authenticated ChatGPT Safari host was exercised through its
normal UI against packaged native candidates. The original runtime was
`54296e0f0010-dirty:9af435da30f3`; the successful compatibility candidate was
`cf029606c66d-dirty:7cc1b24623e9`. The candidate's compiled runtime files match the
final checked build byte-for-byte, excluding build-info (audit-script changes
alter the source fingerprint). Helper replacement used its normal drain path;
no active Jobs existed at the cutovers.

- Actual Refresh discovered 17 tools, but reopening an existing explicit
  Activity failed with `Failed to fetch template`. Registering the Activity URI
  on a different private tool added the template to discovery but did not fix
  that saved presenter.
- Keeping the original presenter as app-only gave 18 descriptors and restored
  the frame. Its unadvertised read calls still failed: the card retained the
  previous day's cached timestamp and reported refresh failure.
- Keeping the 12 app-only compatibility descriptors gave **29 discovered tools,
  12 public and 17 private**. The same existing Activity then read current data
  and successfully refreshed to 10:25:07 KST. All retained app callers are kept
  for the documented migration window; this experiment directly exercised the
  presenter and reads, not every legacy mutation.
- The user's existing separate global-overview conversation reopened, refreshed
  current data and displayed the new details controls. Opening a harmless
  retained verification Agent's details showed the exact selected work. No
  unrelated work was modified.
- The independent `question/04852baeb268` card rendered in the actual host.
  An unpredictable ASCII value generated **after card creation** was entered
  only into the card. Refresh preserved the draft; submission initiated a host
  follow-up; GPT read the stored response and returned the exact value. Reentry
  showed the consumed message with no editable answer or submit control. SQLite
  independently showed `status: answered`, `notification: requested` and a
  `consumedAt` timestamp. No Codex execution was requested in this test.
- A consistent read-only copy of the user's live SQLite state was initialized,
  read and reopened twice with the real stores and MCP server. The final run
  includes **475 Jobs and the real answered question**, plus saved projects,
  settings, Activity/Agent links, results and idempotency records. All protected
  rows were preserved, with four app reads and zero Codex calls. See
  [state restart report](issue-69-state-restart.json). The first pre-cutover
  snapshot had two already expired questions; startup cleaned them under the
  existing #68 retention policy. No schema migration was introduced. Active-Job
  recovery was not exercised because the snapshot had no active Jobs.
- The compatibility revision passed the full TypeScript/release check and all
  **754 tests in 62 files**. Native packaging again passed 100 tests (2 skipped),
  an optimized build, isolated runtime installation and ad-hoc signature checks.

## Remaining rollout evidence

The card-free completion probe was submitted, and the work conversation was
left in favor of the separate overview. ChatGPT finished with an unread marker,
but **admission was blocked before a new Job existed**. Its automatic safety
check rejected project lookup and a full-access task call. The lower-risk
read-only attempt reached bridge validation but correctly returned
`SANDBOX_CONFLICT` against the saved `always-full` policy. No execution, setting
change, new Activity, Agent, Job or Activity card resulted. This proves neither
Codex completion nor completion notification delivery.

Keep actual Codex terminal state, retained result, GPT result retrieval and
user notification as separate outstanding checks. Real original approval,
active-stop and idle-process control also need a suitable authorized live
fixture; their domain/MCP/browser tests have passed locally. The live probe
block is external host approval plus the current saved execution policy, not
permission to weaken those checks or silently change settings.

The 17-tool fresh contract is implemented, but migration discovery is 29 until
a separate deletion decision. Retired entry points are not physically removed.
Final integration/deployment and issue closure remain gated by the actual
completion-flow checks in [Card tools](../card-tools.md).

The test runtime and ChatGPT metadata were restored to the original deployed
build (30 discovered tools), without replacing the live database. The user
independently disabled Priority at 10:38 KST and explicitly confirmed preserving
that change. Other saved preferences and the project registry matched the
pre-test backup. The #69 code remains in the isolated implementation worktree;
no integration, push or production rollout is claimed. Machine-readable host
observations are in [the live-host report](issue-69-live-host.json).

## Follow-up: permission ownership and completion re-audit

The user explicitly required that GPT never choose execution permissions.
Current task input therefore has no sandbox or approval-policy field. The bridge
applies saved access strategy and operator limits. There is no current
requested-permission-versus-setting conflict check. The retained adaptive value
now means Bridge default; all nine card and native UI languages were updated.
Task envelope generation changed to prevent silently reinterpreting an old
restricted call. Exact admitted replay remains supported. Existing-thread
policy checks and verification of actual upstream permissions remain intact.

Project resolution moved to the existing read-only status tool, with no new
registration. Previously it shared the potentially destructive/open-world Task
tool annotations even when performing only a lookup. This design defect is
verified in the descriptor; ChatGPT did not expose its internal safety-review
rationale, so it is not proof of the exact host classifier decision. The stale
Task description instructing GPT to show an Activity card was also removed.

The follow-up full build/release check passed **760 tests in 62 files**, and
macOS passed **100 tests, 2 skipped, zero failures**. A new read-only production
state copy preserved all 475 Jobs and settings through two restarts; its
question table was empty after normal expiry. The original answered-question
evidence above remains historical. See [follow-up restart evidence](issue-69-owned-permissions-restart.json).

Actual ChatGPT execution and notifications require a new host check against
this revision; earlier local/host passes do not establish full issue completion.
