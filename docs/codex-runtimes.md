# Codex installations and updates

ChatGPT connects to the bridge through MCP. The bridge executes work by connecting directly to the selected Codex CLI's App Server. App Server is a mode of that executable, not another CLI installation.

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

## Ownership and updates

| Installation | Owner |
| --- | --- |
| App-bundled Codex | The app's updater |
| Terminal CLI | The original package manager or installer |
| Bridge CLI | The bridge, following explicit user actions |

Updates are manual. A version check or notification never downloads or activates a release. Pins, skipped releases and notification preferences survive restart. External app/terminal files can change independently of the saved path.

A new managed installation resolves the latest stable release unless the user specifies or pins a version. Reinstall preserves the selected version. Failed registry lookup offers retry; it does not silently install the CI baseline. Previously installed versions remain available for explicit recovery.

Managed files live under `~/.codex-mcp-bridge/runtimes` or `CODEX_MCP_BRIDGE_RUNTIME_HOME`. Each installation gets a separate version directory. HTTPS downloads, publisher integrity checks, safe archive extraction and recorded executable hashes protect installation integrity. The bridge does not alter external app bundles or global package-manager installations.

Running bridges hold usage leases. Installation may finish while work is running, then wait for safe application. Applying an update never replays work. Pending approvals/questions and live memory-only Agents block a change; finish the work and archive memory-only Agents before applying it. Graceful shutdown waits for active work; explicit force-stop retains cancellation provenance.

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

**Show bridge threads in Codex app** controls new and forked threads. Enabled threads are persisted in the selected Codex home; disabled threads are memory-only and cannot resume after the worker stops. This does not change older threads or guarantee immediate refresh of the app's list.

`CodexService` owns CLI selection, account projection, cache context and the optional billing connection. Account usage belongs to the account, not to an individual executable. Missing limits, credit balances or reset counts are unavailable, not zero. API mode does not imply unlimited requests or display a ChatGPT weekly quota. Reset credits are never redeemed automatically.

Codex settings show installation and account information. Status refresh runs every 30 seconds while visible; installation progress uses a two-second refresh with cached account information. Update notifications respect the user's notification, pin and skip preferences.

Observed cumulative token counts are not added repeatedly and are not treated as a complete task invoice. Cost estimation requires explicit dated prices and attributable token data.

**Optional API cost connection:** Supply a separate OpenAI Admin API key, organization ID and optional project ID under **API 비용 연결**. The key is stored with current-user permissions in `runtimes/billing/connection.json`, outside registered projects, and is never used for Codex execution or returned through MCP/status. Disconnect removes only this billing connection.

Cost information covers the current UTC month and the configured organization/project, potentially including work outside this bridge. It is not attributed to an inference key or presented as an individual Agent's cost. Failed or unauthorized reads are unavailable; verified zero remains zero. Tests use mock billing responses.

## Validation

Run `npm run check`, `npm run app-server:compat:check` with the development baseline CLI, and `npm run macos:check`. Deterministic protocol tests cover approvals, input, cancellation, additional instructions, history and restart behavior without billed model requests. A live authenticated release smoke check is separate evidence; offline initialization does not certify every execution feature.

References: [App Server](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Costs API](https://platform.openai.com/docs/api-reference/usage/costs).
