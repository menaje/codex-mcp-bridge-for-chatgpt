# Codex installations and updates

ChatGPT connects to the bridge through MCP. The bridge executes work by connecting directly to the selected Codex CLI's App Server. App Server is a mode of that executable, not another CLI installation.

Persistent conversation connections now have an independent six-hour idle grace period. The local **Continue in Codex** action verifies release before opening the app; returning to the bridge can remain blocked while the app owns its writer. Ephemeral conversations and protected shared workers are retained. See [connection lifetime, storage settings and recovery](thread-lifecycle.md) for protocol capabilities, app visibility constraints, database migration and measured cache behavior.

## Choose an installation

Open **Settings → Codex** in the macOS app. App-bundled Codex, terminal installations and bridge-managed installations are listed together.

| Situation | Initial behavior |
| --- | --- |
| Saved selection or explicit `CODEX_MCP_BRIDGE_CODEX` path | Preserve it; an explicit environment setting takes precedence. |
| One independent external installation | Select and save it automatically. |
| Several independent external installations | Ask the user to select once. |
| Only a managed installation exists | Select the managed installation. |
| No installation | Offer installation without starting it automatically. |

Symlinks and official npm launchers resolving to the same native executable count as one installation. Independent copies remain distinct. Installing another CLI does not replace the saved choice. A missing selection requires repair or an explicit new choice; there is no automatic fallback.

Terminal-managed servers can set an explicit executable path in their private runtime environment file. Remove that override and restart the helper before changing the saved selection in the app. Authentication, model discovery and execution use the same selected installation.

## Central execution policy

Execution permissions are resolved once in `src/executionPolicy.ts`, independently
of the selected installation. App-bundled, terminal and bridge-managed Codex all
receive that policy through the same App Server adapter for start, resume and
fork. HTTP and stdio bridge entry points use this same path.

| Saved access strategy | Sandbox | Command approvals | Connector default |
| --- | --- | --- | --- |
| Always full access | Full access, when allowed by the operator | `never` | `approve` |
| Read-only | Read-only | Runtime approval default | `auto` |
| Bridge default | Runtime sandbox default; retained threads keep their sandbox | Runtime approval default | `auto` |

`CODEX_MCP_BRIDGE_APPROVAL_POLICY` supplies the approval default for read-only and
bridge-default strategies. `CODEX_MCP_BRIDGE_APPROVALS_REVIEWER` selects `user`
(the default) or `auto_review`. The bridge sends both explicitly; changing CLI
installation does not substitute that executable's user defaults. Always full
access now supplies approval-free command execution and the connector default
together. Setting `never` alone would not approve an MCP elicitation.

Connector defaults use the thread-scoped
`apps._default.default_tools_approval_mode` override. Explicit app/tool exceptions,
disabled tools, server authentication/input, managed requirements, and the host's
own approval boundary remain authoritative. The bridge does not automatically
answer an approval or retry a rejected action through a different tool.

The adapter compares the returned sandbox, approval policy, reviewer and working
directory before a model turn. It preserves named permission profiles. Connector
evidence records that the config override was sent; App Server does not return
the effective per-tool configuration in its thread response. A loaded thread
with different connector defaults requires fresh context; it cannot silently
reuse the old policy. Selecting another CLI or replacing its executable triggers
protocol checks, including reviewer/config inputs and the generated config
schema's connector approval field and supported values. A generic `config`
object alone is insufficient evidence of compatibility.

These settings govern Codex launched through the bridge. They do not rewrite
`~/.codex/config.toml` or settings for an independently launched Codex app/CLI.

## Ownership and updates

| Installation | Owner |
| --- | --- |
| App-bundled Codex | The app's updater |
| Terminal CLI | The original package manager or installer |
| Bridge CLI | The bridge, following explicit user actions |

Updates are manual. A version check or notification never downloads or activates a release. Pins, skipped releases and notification preferences survive restart. External app/terminal files can change independently of the saved path.

A new managed installation resolves the latest stable release unless the user specifies or pins a version. Reinstall preserves the selected version. Failed registry lookup offers retry; it does not silently install the CI baseline. Previously installed versions remain available for explicit recovery.

Managed files live under `~/.codex-mcp-bridge/runtimes` or `CODEX_MCP_BRIDGE_RUNTIME_HOME`. Each installation gets a separate version directory. HTTPS downloads, publisher integrity checks, safe archive extraction and recorded executable hashes protect installation integrity. The bridge does not alter external app bundles or global package-manager installations.

Running bridges hold usage leases. Installation may finish while work is running, then wait for safe application. Applying an update never replays work. Pending approvals/questions and live memory-only conversations block a change; resolve the request and wait for the connection to release, or use the explicit force path after reviewing the Dashboard. Graceful shutdown waits for active work; explicit force-stop retains cancellation provenance.

Repair, retry, rollback and cleanup appear when applicable. Cleanup protects active, staged, running, pinned and recovery installations. It reclaims only files with bridge ownership records. Rollback restores executable files, not historical copies of user data.

Removing a managed installation preserves Codex authentication, configuration, history, projects and bridge settings. If that installation was selected, an explicit new choice is required.

## Compatibility

The bridge has no CLI version allowlist. Versions are diagnostic and reproducibility information. Every live App Server connection validates its public `initialize` response; requests are checked against the operations the bridge uses. New optional fields do not invalidate a connection. Unknown permission requests are never automatically approved.

Managed installation performs an offline initialization in a temporary Codex home without a model turn. Execution checks the current executable and establishes the same App Server protocol. The selected installation stays visible if it cannot connect, and errors identify the failed connection or operation.

`release-manifest.json` and `app-server-schema.lock.json` define a reproducible development baseline. `protocol/cli-contract.json` is a development snapshot used for drift review. None of these is an end-user execution admission list, and an installed binary need not match an old full-schema hash. When an external executable changes, version probes are invalidated by its file identity before subsequent worker admission.

## Earlier execution settings and history

Internal `codex mcp-server` and Codex SDK execution have been retired. OpenAI deprecated the former on [2026-08-24](https://learn.chatgpt.com/docs/changelog#codex-2026-08-24); the SDK removal decision is recorded in [#29](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/29#issuecomment-5565001692).

Earlier backend settings resolve to App Server for new work and produce a startup notice. Historical backend identities remain readable, but cannot launch a retired worker or silently resume under another account or storage location. Start a fresh context with an explicit `handoffSummary` to carry a concise summary forward. This copies neither hidden context nor approvals and does not replay the original request. Existing transcripts and authentication profiles remain untouched. Old SDK-managed directories are not loaded or automatically deleted by the application.

Before replacing a running bridge or app, use graceful shutdown and finish or explicitly cancel active turns, pending approvals, user-input requests and background processes. If force-stop is necessary, use the existing explicit stop action and retain its cancellation record. After an unexpected restart, unfinished saved jobs are marked interrupted with a bridge-restart origin; they are not resumed or submitted again. Old approval and input requests belong to the retired process and cannot authorize a new App Server turn. Use the summary handoff after shutdown to continue the task.

The external ChatGPT MCP connection and Codex's own connected MCP tools remain supported.

## Authentication, storage and account usage

Authentication uses the selected CLI's existing configuration. ChatGPT login and API-key authentication remain distinct; the bridge does not switch a failed ChatGPT login to API billing. A changed account identity invalidates account/model caches and prevents an existing worker from admitting another turn until restart. Same-account token refresh does not trigger that boundary.

**Show bridge threads in Codex app** controls new and forked threads. New installations enable it by default for resumable context; existing saved preferences are preserved. Enabled threads are persisted in the selected Codex home; disabled threads are memory-only and cannot resume after the worker stops. This does not change older threads or guarantee immediate refresh of the app's list.

`CodexService` owns CLI selection, account projection, cache context and the optional billing connection. Account usage belongs to the account, not to an individual executable. Missing limits, credit balances or reset counts are unavailable, not zero. API mode does not imply unlimited requests or display a ChatGPT weekly quota. Reset credits are never redeemed automatically.

Codex settings show installation and account information. Status refresh runs every 30 seconds while visible; installation progress uses a two-second refresh with cached account information. Update notifications respect the user's notification, pin and skip preferences.

Observed cumulative token counts are not added repeatedly and are not treated as a complete task invoice. Cost estimation requires explicit dated prices and attributable token data.

**Optional API cost connection:** Supply a separate OpenAI Admin API key, organization ID and optional project ID under **API 비용 연결**. The key is stored with current-user permissions in `runtimes/billing/connection.json`, outside registered projects, and is never used for Codex execution or returned through MCP/status. Disconnect removes only this billing connection.

Cost information covers the current UTC month and the configured organization/project, potentially including work outside this bridge. It is not attributed to an inference key or presented as an individual Agent's cost. Failed or unauthorized reads are unavailable; verified zero remains zero. Tests use mock billing responses.

## Validation

Run `npm run check`, `npm run app-server:compat:check` with the development baseline CLI, and `npm run macos:check`. Deterministic protocol tests cover approvals, input, cancellation, additional instructions, history and restart behavior without billed model requests. A live authenticated release smoke check is separate evidence; offline initialization does not certify every execution feature.

References: [App Server](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Costs API](https://platform.openai.com/docs/api-reference/usage/costs).
