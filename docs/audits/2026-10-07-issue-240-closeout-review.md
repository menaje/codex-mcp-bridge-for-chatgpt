# Issue #240 final independent review

The final-completion request supersedes the earlier Draft/no-merge handoff.
The review began from live GitHub Issue #240, related #224/#80/#95, PR #241,
its commits, conversation/review comments, and the actual remote diff. Initial
PR HEAD was `2e4b2d45b37f2588ea5ba439b04c38520f202381`; base `dev` was
`c06be6782d4acd7d5f02628375522ea659ec5685`. GitHub's diff and the local diff
match after normalizing only index abbreviation and hunk heading presentation.
There were no existing PR review or conversation comments. The main local dev
was clean at `ea8f93e2acbb9f4b6deca113165d27e8c9c23857`, with its 23 unpublished
commits preserved separately from this PR.

## Reviewed boundaries

- Archive intent closes admission before external work; execution preparation
  rechecks it at durable dispatch. Unknown legacy dispatch/worker ownership
  cannot be treated as an undispatched Job. Cancellation keeps honest terminal
  outcomes and incomplete cleanup remains unresolved.
- Cleanup runs outside SQLite transactions and commits only under the current
  archive revision plus fresh Job/thread ownership. Retry, shutdown, startup
  sweeps and legacy confirmed-delete crash checkpoints use the same controller.
- Exact-turn cancellation, questions/approvals, background termination and
  persistent/ephemeral/unknown contexts have explicit ownership/release checks.
  Worker fallback checks all loaded/active contexts. Shared Agents, unrelated
  workers and a replacement current thread are preserved.
- Physical deletion and all FK/indirect control, result, event, followup and
  recovery projections are separated from independent idempotency receipts.
  Undelivered results are removed without asserting delivery. Late memory,
  progress, completion, session and connection writes cannot revive retired
  identities or bind them to a new registration at the same cwd.
- The schema-31 step is appended; all pre-existing migration and fixture records
  were compared directly with remote dev and are unchanged. Legacy archived and
  deleted rows enter supported cleanup rather than requiring manual DB changes.
- Settings API/card/macOS DTOs and UI expose pending/unresolved/complete states
  and retry. Settings v6, Dashboard v5 and the project/thread/database contracts
  agree on management deletion while preserving files, Git and source
  conversations. #224 continues protecting actual active work and registry CAS.

## Defect reproduced and corrected

The real HTTP/MCP `codex_task` retry path checked the retired admission receipt
without a hash before attempting content comparison. A changed prompt with the
same accepted requestId therefore returned `PROJECT_MANAGEMENT_ENDED` even when
the original Job had an existing public-envelope digest. The new HTTP assertion
failed at the initial implementation with that exact response; it must return
`REQUEST_ID_CONFLICT` without dispatching work.

Deletion now retains that already observed digest as `task-envelope-v1`, using
the existing independent receipt schema. The admission digest is also retained
because it includes admission-time execution semantics. Only the digest,
algorithm version and existing acceptance/outcome facts survive, with no prompt,
project, cwd, Activity or session relationship. The API compares the envelope
before looking up a retired project or approval journal. Unknown legacy envelopes
and followups requiring removed approval data retain the fail-closed admission
fence; their content is not reconstructed or guessed. No migration changes are
needed for this fix.

HTTP tests cover identical and changed retries across repeated lifecycle cycles,
full host/registry restart, and new identity registration at the same cwd. They
also cover Jobs without an envelope digest and attempted reuse against the new
project. Both cases preserve the new identity and perform zero extra execution.
The development check of the lifecycle and host files passed all 32 tests.

## Final verification and scope

After committing this review and the fix, rerun build, typecheck, focused,
migration, integration, the complete unfiltered Node suite, macOS, fast validation
and the #224/#221 browser regressions on that same clean HEAD. No existing
deadline, expectation or dependency is relaxed. A fresh task-owned TMPDIR and
Darwin `taskpolicy -a` apply only to newly launched validation children, following
the previously demonstrated host scheduling constraint. The pinned validation
CLI remains 0.153.3. There is no repository lint script/config.

Exact final HEAD, command results, merge SHA and GitHub readback are recorded in
PR #241 and the final Issue #240 comment after the checks finish; earlier results
are not substituted for that final validation. The existing workflow accepts
only main PRs/pushes or manual dispatch; no GitHub Actions are invoked here.
Deployment, installed-app replacement, operational DB migration and live
authenticated Codex/ChatGPT-host acceptance are outside this completion request.
All write tests use isolated fixtures, including synthetic execution and original
conversation sentinels. Native opt-in live-service checks and Intel-host execution
remain separate deployment checks. Cleanup is limited to merged issue-240 task
branches/worktrees after preservation, ownership, process and ancestry checks.
