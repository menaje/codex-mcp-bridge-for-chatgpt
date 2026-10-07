# Issue #240 — implementation 1, local verification

Date: 2026-10-07 (Asia/Seoul). This is a Draft PR handoff, **not permission to
merge, close #240, deploy, migrate an operational database, or replace the app**.
The exact published HEAD is recorded in the PR and issue comment; this audit is
the only file added after the tested code HEAD below.

## Preserved starting state and review boundary

| Checkout / reference | Exact commit |
| --- | --- |
| Original clean local `dev` | `ea8f93e2acbb9f4b6deca113165d27e8c9c23857` |
| `origin/dev`, task base | `c06be6782d4acd7d5f02628375522ea659ec5685` |
| Installed app's read-only build metadata | `9be3bb6c70b8673137fb8663c9137c07d1d7c90d` |
| Frozen broad-test snapshot | `e2fd12730cde1315f0f233a57fd215c7a0930a65` |
| Final tested code | `6840cc548feb5bd73b460d3714b33f09ee8370c2` |

Local dev was 23 commits ahead of remote dev, including accepted #236 and other
unpublished work. The task started from remote dev in
`/Volumes/Data/Dev/codex-mcp-bridge-issue-240` on
`codex/issue-240-project-lifecycle`; none of those predecessor commits is included
in the remote-dev review diff or discarded. The original checkout's ignored
artifacts were preserved. No unexplained tracked changes were found.

A detached baseline worktree at remote dev was used for comparison. After its
tests ended and its clean state/process ownership were checked, it became the
review-fix worktree `/Volumes/Data/Dev/codex-mcp-bridge-issue-240-review`, branch
`codex/issue-240-review-fixes`. This kept the broad-test source snapshot frozen.
Only the task branch is published; the review commits are its ordinary ancestors.
There was no reset, history rewrite, force push, dev merge, or conversation action.

A read-only `git merge-tree --write-tree --name-only dev HEAD` reports four future
local-dev integration conflicts: `docs/ui-release-compatibility.md`,
`src/uiManifest.generated.ts`, `ui-manifest.lock.json`, and
`ui-resources/settings.html`. It changed no reference or checkout. Integration
and task branch/worktree cleanup remain pending by the user's explicit no-merge
instruction.

## Contract and migration

See [project-lifecycle.md](../project-lifecycle.md) for state authority, receipt
retention, cleanup ownership, storage faults, and legacy checkpoint recovery;
[database-schema.md](../database-schema.md) and
[state-upgrade-recovery.md](../state-upgrade-recovery.md) cover schema and rollback.

- Archive records a short durable intent and blocks every project admission and
  last dispatch boundary. External turn/background/context termination runs
  outside SQLite transactions. Revision CAS and fresh ownership checks establish
  completion. Unknown or failed termination stays unresolved with retry reasons.
- Idle/open history alone does not block cleanup. Exact turns are preferred;
  whole-worker fallback requires ownership of every affected context. Shared
  Agent identity, another project's work and replacement current threads survive.
- Restore reactivates registration only. Delete requires confirmed archive and
  physically removes registration and owned execution/context/result/control
  projections. It preserves independent deduplication facts without owning cwd,
  project, Activity, or session. Unknown legacy request hashes are never invented.
  Deleted Job management returns `PROJECT_MANAGEMENT_ENDED`; late writes and
  retries cannot revive old identities or attach them to a new same-cwd project.
- Schema 30→31 is appended, introduced in
  `cce99c5fdfeaafe2e50861d826dffd15cdd0f6b1`. Older migration steps/checkpoints
  remain byte-identical to the task base. Legacy archived/deleted registrations
  enter the same restartable cleanup, including a confirmed archive checkpoint
  left before physical deletion. Old deleted identities cannot be restored.
- Settings API/card and native UI expose processing, unresolved/retry, and
  complete states. Settings resource URI advances to v6; Dashboard remains v5.
  Old mounted cards require the documented close/refresh/reopen procedure.
  No conversation archive, original-conversation deletion, or permanent deleted
  project history UI was added.

## Local verification and limits

Host: macOS arm64, Node 24.11.1 (ABI 137), Vitest 4.1.11, better-sqlite3 13.0.3,
SQLite 3.53.4, MCP SDK 2.0.0. The task reused the original dependency tree through
a symlink; relevant versions match the task lockfile. CLI schema checks use an
isolated Codex CLI 0.153.3 fixture binary.

| Check | Command / scope | Observed result |
| --- | --- | --- |
| Final focused | `env -u CODEX_HOME npx vitest run test/projectLifecycle.test.ts test/projectRecovery.test.ts test/userSettings.test.ts test/threadConnections.test.ts test/agentState.test.ts test/uiI18n.test.ts test/jobRegistry.test.ts test/projectRegistry.test.ts test/uiResourceFiles.test.ts test/uiResourceCompatibility.test.ts test/sessionRegistry.test.ts test/questionStore.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | **180/180**, 12 files, 92.01 s |
| Final migrations | `env -u CODEX_HOME npx vitest run test/stateSchemaMigration.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | **16/16**, 1 file, 19.08 s |
| Typecheck | `npx tsc --noEmit` | PASS on final code |
| Build | `npm run build` | PASS, clean final-code build metadata |
| Fast validation | `CODEX_MCP_BRIDGE_CODEX=/tmp/codex-cli-0.153.3/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex npm run validate:fast` | PASS; release/localization checks and 416 JSON / 827 TypeScript protocol files |
| Formatting | `git diff --check`; `npx --yes prettier@3.6.2 --check src/projectLifecycle.ts test/projectLifecycle.test.ts` | PASS |
| Lint | `npm run lint` | Unavailable: repository has no lint script/config; command exits 1, not counted as PASS |
| Native | `npm run macos:check` | 225 tests: **223 passed, 2 skipped, 0 failed**; strict concurrency/warnings as errors; localization check 1,423 strings × 9 languages |
| Browser #224 | `npm run test:issue-224-project-recovery` | PASS: real MCP + shipped HTML, unresolved reason/retry, delete, same-cwd new identities twice, draft preservation |
| Broader impact at frozen snapshot | 20 files covering execution/process/DB/schema/recovery/session/history/questions/meta/UI/releases, serial Vitest | 262 tests: **256 passed, 6 failed**; 17 passed / 3 failed files; one unhandled error |
| First exploratory full Node | `npm test` (4 workers, during iterative work) | 1,418 tests: **1,229 passed, 189 failed**; 91 passed / 34 failed files; five unhandled errors; 976.95 s |
| Frozen full Node | `env -u CODEX_HOME npx vitest run --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | Exit 1: **99 passed / 26 failed files**, 49 reported failed cases and four suites unable to load due to ENOSPC; no final total case count emitted |

The 27 lifecycle cases include two complete register/use/archive/delete/reregister
cycles (four project identities), real fixture Git HEAD/index/staged/untracked/
ignored content and original-conversation sentinel preservation, queued/preparing
and delayed worker assignment, input/approval/background work, termination failure,
shared worker/Agent, late progress/results, thread replacement, shutdown/restarts,
legacy data and two restarts, legacy deletion commit gaps, storage fault retries,
indirect control journals, unknown hashes, and cache/deferred-write fencing.
SQLite `foreign_key_check` and `integrity_check` are asserted on fixture lifecycle
states; migration tests compare fresh/upgraded schema and retained checkpoints.

**The full Node suite is not green.** Frozen-snapshot failures span runtime lock/
capacity/startup tests, execution readiness, MCP HTTP resets and followup restart,
#221 delivery, input readiness, state child busy/startup behavior, launcher/CLI/
OAuth/server/native payload/auth helper/retention/release timeouts, a Job event-loop
budget assertion, late App Server response timing, two obsolete UI fixture
expectations, and four ENOSPC suite-load failures. UI fixtures were corrected and
pass in final focused validation. Selected execution failures reran **2/2** green;
selected Events/ACK cases reran **4/4** green. A later 4-file selected recheck still
had **5 failures / 6 passes / 75 filtered skips** (DB busy/startup, #221 timeout/reset,
input readiness), and a question HTTP test also reset. These remain verification
gaps, not waived failures.

At unchanged remote-dev baseline, runtime tests were **6 passed / 20 failed**;
followup restart reproduced ECONNRESET. Baseline #221 delivery was **21/21** green.
This does **not** establish that every task failure is baseline-only. Full Node
was not repeated after the final storage/cache/legacy/input fixes; those deltas
are covered by final focused and migration checks. Native files, localization and
the browser script/shipped Settings HTML were unchanged after their successful
checks. No live installed-app, authenticated Codex/ChatGPT-host or deployment E2E
was performed; the two native opt-in live service tests were skipped.

The last preliminary focused run was invalidated by ENOSPC. After confirming no
users/processes of the artifacts, only this task's generated `macos/.build` and
two terminated Vitest transform roots explicitly named in its logs were removed;
two orphan fixture execution/fake-upstream PIDs were terminated. No original
checkout artifacts, unknown temp directories, operational data, or installed app
were removed. Final focused validation then passed. Disk pressure is not claimed
as the cause of all earlier timeout/reset failures.

## Evidence identity and operational scope

Final clean-code build `sourceHash`:
`b109af3c493e2998fb361f758cfe2bc6b2666f0f59c3107de8661c29bd21acff`.
Settings HTML SHA-256:
`af137b0403784b81a0f973895ac3e838c7ca1b221539511ddff0889d6c21d6dd`.
Migration manifest SHA-256:
`e9a2fc589cce86f2ec46857821cee35eb389de0b470312a0d7bfabd417daa337`.
Browser script SHA-256:
`0266bf0120f7bfa4c8f0a7515b1d11f107bb82d9367862182c48274b47537ad4`.

Raw local logs, screenshots, cleanup receipt and hashes remain in the task's
ignored `output/issue-240` and `output/playwright` directories; they are not
published artifacts. The public audit reports failures as well as passes.
Operational application: **none**. Only copies/fixtures were used for mutations.
Original folders/files/Git/Codex/ChatGPT conversations and the installed app were
preserved. GitHub workflows were neither changed nor invoked; the existing sole
workflow triggers only main pushes/main PRs/manual dispatch, so this task branch
push and dev Draft PR do not match its triggers. Issue #240 remains open.
