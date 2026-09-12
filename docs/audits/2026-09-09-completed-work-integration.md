# Completed-work integration into dev · 2026-09-09

The completed execution-policy work was still present in the primary checkout
and four preservation branches after the issue-specific integrations. This
integration applies that pending difference to `dev` at `80f5116`, including
the model-description work merged through PR #85. Issue #80 continues in its
separate worktree and is outside this integration.

## Recovered behavior

The shared policy resolver applies the saved access strategy to fresh,
continued and forked work, regardless of which Codex installation is selected.
Always full access supplies `danger-full-access`, `never` and the connector
default `approve` together when the operator permits full access. Other
strategies retain the configured approval default. The adapter explicitly
passes and verifies the approval reviewer before starting a turn.

Operator limits, existing-thread sandbox conflicts, named permission profiles,
explicit app/tool exceptions, authentication and host approvals remain enforced.
The bridge does not answer pending approvals automatically. Connector evidence
means that the thread configuration override was sent; it does not claim that
App Server returned the effective policy of every connected tool.

The [September 8 audit](2026-09-08-central-execution-policy.md) and its historical
results are retained. They describe the earlier local implementation and
deployment, not validation of the present integration.

## Reconciliation evidence

| Preserved work | Disposition |
| --- | --- |
| Central execution policy | Recovered from the primary checkout; the policy modules in all four preservation branches have identical content. |
| Fast-mode display worktree | Its complete saved tree is identical to merged commit `323d55c`. |
| Card refresh and information consistency worktrees | Their change fragments and implementation were integrated in `be98e00`, with later refinements retained. |
| Conversation status card and inline controls | Retain the final `dev` integration in `c2621cb` and the preceding control fixes. |
| Status summaries | Retain `b7876c6` and subsequent menu-bar corrections. |
| Runtime lifecycle reservations | Retain the final integration in `d376c3c`. |
| Former CLI/SDK branch | Preserve the later SDK rejection/removal decision from issue #29 and the current CLI manager. |
| Issue #80 | Keep its branch, working files and active worktree. |

The existing 163 UI resource revisions retain their URI, digest, metadata and
HTML bytes. Two previously local Dashboard snapshots are also retained at
`ui://codex-mcp-bridge/dashboard/801e73250086.html` and
`ui://codex-mcp-bridge/dashboard/dc0af19df7bc.html`. All current card URIs and
renderers are unchanged. Release tooling regenerates the derived manifests.

Before cleanup, the committed history and all pending non-#80 files were saved
in a verified Git bundle and file archives. The local reconciliation report
records the original refs, content hashes, patches and retained test artifacts.
Removal is conditional on those working files remaining unchanged and no live
process using the affected worktree.

## Validation

| Check | Result |
| --- | --- |
| Build, release metadata/policy and TypeScript | Passed; 55 active change fragments, no generated drift. |
| Complete Node suite, one worker | 869 tests in 68 files passed, with the original timeouts (319.72 seconds). |
| App Server compatibility | CLI 0.153.3 matches 416 JSON and 827 TypeScript schema files. |
| macOS localization | 645 strings across all nine languages passed. |
| Strict-concurrency Swift build and tests, warnings as errors | 129 passed, two opt-in live tests skipped, zero failures (131 total). |
| Whitespace and UI resource retention | Passed; existing revisions and all current card URIs unchanged. |

An initial full Node run with four workers encountered 22 timeout failures
during concurrent local verification, including a helper-exit timeout. Its
result is retained and is not counted as a passing run. The complete serial
rerun above passed without source changes, increased timeouts or skipped Node
tests. The native checks followed the successful Node run.

The offline installation audit passed on terminal CLI 0.153.3, app-bundled CLI
0.153.4 and bridge-managed CLI 0.153.4: 9 shared-policy checks, 27 explicit
policy combinations, 12 filesystem checks and 24 read-operation checks.
The audit used isolated temporary Codex homes and projects. It did not run a
model turn, perform an authenticated external write, change the selected CLI,
or restart the operating bridge.

This integration keeps version 0.3.0 in development stage. No tag, release or
deployment is part of this work.
