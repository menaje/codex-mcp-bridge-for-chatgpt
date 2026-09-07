# App Server-only execution · 2026-09-07

This change implements the execution-policy decision in [#60](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/60), the SDK removal decision in [#29](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/29#issuecomment-5565001692), and the compatibility portion of [#58](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/58).

OpenAI deprecated the internal `codex mcp-server` command on [2026-08-24](https://learn.chatgpt.com/docs/changelog#codex-2026-08-24). ChatGPT's external MCP connection to the bridge remains supported. The Python SDK is removed and no TypeScript SDK replacement is introduced. The comparison, published package versions and limits of the SDK probes are preserved in the linked decision comment.

## Implementation and evidence

| Requirement | Implementation and verification |
| --- | --- |
| One execution path | `executionRuntime.ts` registers only App Server. The router rejects registration or execution of retired backends. The old MCP process adapter, SDK worker, runtime, catalogs and installation locks are removed. |
| Existing settings | Old `mcp-server` and `codex-sdk` defaults resolve to App Server with a startup notice. Management writes accept only App Server. `config.test.ts` and `runtimeEnv.test.ts` cover the transition. |
| Preserve history and authentication | Historical backend identities remain readable. Retired continuations and forks fail explicitly. `tools.test.ts` verifies summary-only handoff and exact-request replay without a second execution; `codexService.test.ts` verifies old credential files remain unchanged. |
| Work in progress | Restarted jobs preserve their original backend and become interrupted with `bridge-restart` provenance. They are not rerun or misreported as user cancellation. The runtime policy documents graceful shutdown, pending approvals/input and explicit force-stop. |
| No version admission list | CLI discovery, selection, installation, activation, execution and updates no longer consult approved versions or full historical schema hashes. The schema lock and `protocol/cli-contract.json` remain development snapshots. |
| New CLI versions | Tests admit `99.0.0`; the diagnostic version parser also accepts future prereleases. App and terminal binary replacement tests immediately refresh the installed version, preserve the saved selection and keep the live lease's running version separate. Managed integrity checks and explicit update controls remain covered. |
| Protocol changes | Every new worker validates public initialization. Tests accept additional fields and unknown optional notifications, reject an unknown permission request with a protocol error, and verify the worker can still serve a later request. Missing required initialization fields fail with their actual names. |
| Native app and distribution | SDK/backend choice, installation, auth and status UI/API are removed. Current Settings HTML and nine native localizations are synchronized. App and npm payload inspections confirm removed runtime files are absent. |
| Authentication and ownership | Account-cache invalidation, login/API distinctions, billing separation, explicit CLI selection, external installation ownership, pins, staging, repair, rollback and cleanup retain regression coverage. |

The continuity smoke script now selects both retired-backend handoff tests. Its previous reference to the deleted MCP execution test was removed so the migration check is actually executed.

## Test-app self-review

The follow-up review found that the account inquiry connection did not yet share the execution worker's initialization checks. It now validates required initialization fields, waits for the `initialized` notification to be written, and releases its CLI lease even if closing the connection fails. These failures could otherwise hide the actual incompatibility, continue an incomplete handshake, or leave an installation marked in use. Three regression cases failed before the fix and passed afterward, including a real child-process fixture with an incompatible initialization response.

## Verification scope

- The targeted runtime, restart and App Server suite passed 88 tests after the added boundary cases.
- `npm run test:continuity` passed all three stages: four transport tests, five task/Agent/handoff tests, and four process/thread recovery tests.
- The real terminal CLI 0.153.3 and app-bundled CLI 0.153.4 both completed the bridge adapter's initialization and `model/list` calls. Their catalogs contained five and six entries respectively. Each process used a temporary empty Codex home; no model turn, API key or account profile was used.
- Full regression, schema-baseline, Swift/localization and bundle results are recorded with the implementation PR. Reproduce them with `npm run validate:full` and `npm run macos:bundle`.

The installed-CLI checks establish connection and catalog behavior. They do not establish authenticated feature parity, live approvals or ChatGPT host UI behavior. Deterministic tests provide the execution, input, cancellation, steering and recovery evidence. Release smoke checks remain governed by [the release runbook](../releasing.md).

Issue #58 also tracks its broader native management UI matrix: state-specific clicks, screen re-entry and restoration after app restart. Those physical UI acceptance items remain separate from this compatibility change and must not be marked passed from unit tests or a successful app build.

Current migration and operator instructions are in [Codex installations and updates](../codex-runtimes.md). Existing SDK directories and authentication are not automatically deleted, and old immutable card resources and audit records remain historical compatibility material.

## Subsequent CLI management acceptance

The [CLI management acceptance report](2026-09-07-cli-management-acceptance.md)
records the subsequent completion of #58's native UI state matrix and fixes
found during that work. It also verifies authenticated new turns, durable
continuation after process restart, steering, confirmed interruption and archive
with terminal CLI 0.153.3, app CLI 0.153.4 and a newly installed managed CLI
0.153.4. Actual ChatGPT host smoke and live approval/input behavior remain
separate from those verified stages; #60 is not closed by that follow-up.
