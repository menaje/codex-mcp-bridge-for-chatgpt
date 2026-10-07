# Issue #240 — strict follow-up and independent review boundary

Date: 2026-10-07. This continues the same Activity/Agent conversation and Draft
PR [#241](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/241). It does
not authorize merging, closing #240, deployment, operational DB migration, app
replacement or conversation actions. This audit records diagnosis and the
verification protocol before the final source freeze. The PR body and issue
progress comment record the published exact HEAD and final command results;
selected diagnostic checks below are not represented as a full-suite pass.

## Preserved state

The original clean local dev remains `ea8f93e2acbb9f4b6deca113165d27e8c9c23857`,
23 commits ahead of unchanged `origin/dev`
`c06be6782d4acd7d5f02628375522ea659ec5685`. Installed app metadata remains
`9be3bb6c70b8673137fb8663c9137c07d1d7c90d`. Initial task/review HEAD and PR HEAD
were `5f18d4c25242cec9dc9291149f467957a67501f3`; both worktrees were clean.
Only task-owned changes are included in `codex/issue-240-project-lifecycle`.
Review commits were fast-forwarded into that branch, without changing local dev
or including its unpublished predecessors.

A new detached comparison worktree at unchanged remote dev is
`/Volumes/Data/Dev/codex-mcp-bridge-issue-240-final-baseline`. Its build and selected
tests use fixtures only. The main task, review and comparison worktrees are
retained; dev integration/cleanup remain pending under the explicit no-merge
instruction. No reset, force push or other worktree/branch removal was used.

## Failure diagnosis without changing contracts

The full run at `5f18d4c` completed with ordinary inherited process policy:

```sh
env -u CODEX_HOME TMPDIR=/tmp/cb240-final-Rxx6Ux npx vitest run --maxWorkers=1 --reporter=verbose
```

It reported **115 passed / 10 failed files**, **1,396 passed / 30 failed tests**,
1,426 total, 1,993.09 seconds. There was no ENOSPC, suite load failure or unhandled
error. Twenty-seven cases exceeded their existing deadlines; three failed
read/storage-health assertions. The fresh, short TMPDIR is task-owned. No user
files, unknown caches, old worktrees or branches were deleted for disk space.

The [bounded classification JSON](2026-10-07-issue-240-node-failure-classification.json)
records every failed name and an exact escaped selection pattern. All 30 names
were rerun at unchanged remote dev with the same dependency versions and
original deadlines. Ordinary policy gave **22 failed / 8 passed / 145 filtered
skips** in 312.20 seconds. That observation alone did not establish the cause of
every failure.

Separate fixture measurements established process-policy effects. A configured
SQLite `busy_timeout=5000` took 15,033.83 ms with an initialized WAL database;
libc `usleep(100ms)` took 246–284 ms. Applying `/usr/sbin/taskpolicy -a` to a new
validation child produced a 5,106.73 ms SQLite wait and 100–102 ms sleeps. Git
process startup fell from 42–54 ms to 9–10 ms and Node from 134–187 ms to 24–25 ms.
Moving a child out of Darwin background priority or selecting latency tier zero
alone did not resolve the delay; a sleep assertion with `caffeinate -i` also did
not resolve it. No installed/operational process policy was changed.

With `taskpolicy -a`, **all the same 30 names passed** at unchanged remote dev,
with 145 filtered skips in 108.37 seconds. This controlled comparison identifies
an inherited execution-policy timing problem on this host. It is a selected
comparison, not a baseline full-suite run. ENOSPC from the previous handoff is a
separate historical environment failure, not an explanation for every old error.
No existing test timeout, IPC deadline, expectation, pinned CLI or dependency
was changed to achieve the comparison.

## Product and acceptance changes

Commit `aaae96ce68a4abe98a4792fbdb15e6c928959531` removes unnecessary MCP wire
registration from isolated read observations. Each request still constructs a
fresh query-only DB/session/Job/settings graph; it cannot reuse deleted identities
or stale project/session history. A same-store guard remains, and only the five
read methods are exposed. Actual HTTP/MCP dispatch still installs its existing
integrity guard and tool/resource contracts.

Diagnostic ordinary-policy reads previously spent 120–247 ms constructing wire
tools; warmed actual projection work took about 5–8 ms. The new warmed complete
read took about 10–11 ms. The existing capacity/reuse test passed with its unchanged
50 ms observation deadline even under ordinary policy. This is a robustness and
cost fix, not a relaxation of the observation contract.

Commit `47a39a90904d514bfc99aabe6b1793da2ea19ef4` adds host acceptance through real
HTTP/MCP plus the Settings application API and a separate IPC reader. Execution
and catalog are synthetic; worker, generation, thread and exact turn identities
are explicit. The two new cases passed under ordinary policy (11.69 seconds of
test work):

- Two full cycles, four new project identities, actual admitted/completed Jobs
  and fresh thread/session selection; archive, physical delete and same-cwd
  registration. Settings/Dashboard observations refresh at each stage. Old request
  replay and Job status return management-ended without execution.
- Failed exact termination stays unresolved and blocks fresh/continue/fork. Retry
  confirms only the target turn; a shared worker peer and a replacement current
  thread on the same Agent survive. Late target progress/results after delete
  cannot reappear or attach to the newly registered project.
- Every relevant fixture state checks `foreign_key_check` and `integrity_check`.
  A real temporary Git repository preserves HEAD/index/staged and untracked
  content; an original-conversation sentinel stays byte-identical. Reusable Agent
  identity may retain an idle row, with no old project, thread, Activity or history.

Initial fixture defects (incomplete synthetic catalog fields and an expectation
that reusable Agent identity would disappear) were corrected to match the read
and lifecycle contracts. No established repository expectation was weakened.
The existing 27 lifecycle cases additionally cover admission before assignment,
approved followup/recovery, ephemeral/unknown contexts, question/approval/background
work, receipt hashes, control journals, late Events, retry/restart/CAS and legacy
migration plus two restarts. See [project-lifecycle.md](../project-lifecycle.md)
for authority, retention and cleanup rules. Schema 31 and older immutable migration
checkpoints are unchanged by this follow-up.

The #224 browser fixture now explicitly configures its state, telemetry, model
cache and skill directory under its own temporary root. Its composed state store
was already isolated; this also excludes unused default operational paths from
the fixture configuration. No operational data was migrated or removed.

## Final verification protocol and limitations

Freeze and commit all product/test/documentation changes, build from that exact
clean HEAD, then run the following locally. Use `taskpolicy -a` only for validation
children; it does not alter CLI or test semantics. Keep the short task-owned
TMPDIR and unset the operational CODEX_HOME for Node fixtures. Serialize checks
so the full suite does not compete with another build/test run.

- `npm run build`; `npx tsc --noEmit`.
- Serial focused lifecycle/registry/session/thread/Agent/Job/questions/UI and
  `stateReadProcess` / host acceptance tests, without timeout overrides.
- Serial `test/stateSchemaMigration.test.ts`, without timeout overrides.
- Complete `npx vitest run --maxWorkers=1 --reporter=verbose`, without filters or
  timeout overrides. Selected reruns cannot establish full-suite success.
- `npm run macos:check` with strict concurrency and warnings as errors.
- `npm run test:issue-224-project-recovery` and `npm run test:issue-221-card` against
  fixture HTTP servers and the shipped cards.
- `npm run validate:fast` using the repository's isolated CLI **0.153.3** fixture,
  plus `git diff --check` and formatting of new/affected lifecycle tests. There is
  no repository lint script/config; no lint result is invented.

Final results, failure/skip counts, sourceHash and exact HEAD are recorded in the
PR body and issue comment after these checks. Raw logs/diagnostic scripts/reports
remain ignored under `output/issue-240-final` (and review-worktree output). They
are not large committed artifacts. No GitHub Actions/workflow is used or changed.

Operational application remains **none**. This acceptance does not call a real
model, authenticated installed app or live ChatGPT host, nor inspect/delete
original conversations. The native opt-in live-service tests remain outside
fixture coverage. Real original files/Git/conversations are preserved by scope;
fixture preservation is separately asserted. Independent review must still assess
ownership evidence on live backends, receipt retention and legacy uncertainty,
and follow the Settings v6 cache-refresh procedure before any later deployment.
