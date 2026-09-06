# Codex installations and the optional Python SDK

The ChatGPT connection continues to use MCP. The execution backend, the installation that supplies Codex, and the authentication source are separate choices. Existing backend settings and existing Agent threads keep their choices.

## Choose an installation

Open the macOS app's **Settings → Codex**. The app finds app-bundled Codex, terminal installations, and installations owned by the bridge.

| Situation | Initial behavior |
| --- | --- |
| A saved selection or explicit `CODEX_MCP_BRIDGE_CODEX` path exists | Keep it. An explicit environment setting takes precedence. |
| One independent external installation exists | Select and save it automatically, including when a managed installation also exists. |
| Several independent external installations exist | Ask for a selection once. Do not infer preference from version or running apps. |
| No external installation exists, but managed Codex exists | Select managed Codex. |
| No installation exists | Offer installation in the app; do not install automatically. |

Symlinks and official npm launchers that resolve to the same native executable count as one installation. Copies of the same version remain distinct. **Other Codex** exposes additional choices without adding a picker to the everyday single-installation flow. Installing another CLI later does not replace the saved choice. A missing selection requires repair or an explicit new choice; there is no silent fallback.

Terminal-managed servers can set `CODEX_MCP_BRIDGE_CODEX` to an explicit executable path in their private runtime environment file. That path takes priority over app selections and is shown in Settings. Selection and activation controls remain unavailable while the override is set; remove it and restart the helper before using the saved app selection. Authentication checks, login, model discovery and direct execution resolve the same installation.

App Server is an execution mode of Codex, not another installed CLI. Direct execution remains available through `app-server` and the retained `mcp-server` compatibility backend.

## Ownership and updates

| Installation | Who manages it |
| --- | --- |
| Codex bundled in an app | The user, through that app's update mechanism |
| Terminal CLI | The user, through the original package manager or installer |
| Bridge CLI | The bridge, following the user's explicit install/update/remove actions |
| Python SDK environment | The bridge, as one verified Python/SDK/Codex bundle |

Updates are manual. Checking a version or receiving a notification never downloads or activates it. A version pin, a skipped release and notification preferences survive restarts. External app/terminal files can change independently; choosing their path does not promise an immutable version.

The menu's bottom **코덱스 업데이트** button appears only for the selected bridge CLI when a supported, unpinned, unskipped update is available and notifications are enabled. SDK updates are separate: the SDK's Codex dependency cannot be upgraded independently. The first installation resolves the latest stable release at the time of installation. An existing version pin takes precedence. Reinstall retains the selected version; SDK reinstall also reuses that installation’s exact dependency lock. If registry lookup fails, the bridge offers retry or an explicit known version instead of silently installing its CI baseline.

Installations live under `~/.codex-mcp-bridge/runtimes` (or `CODEX_MCP_BRIDGE_RUNTIME_HOME`). Each install gets a new immutable version directory. Downloads require HTTPS and publisher integrity verification; archives are checked before extraction. The SDK additionally pins Python archive SHA-256 digests and every Python wheel hash. Global npm, pip, Python and app bundles are untouched.

Running bridges hold usage leases. An update can be downloaded and verified while work runs, then wait for a safe restart. Applying it never replays work. Pending approvals/questions and live memory-only Agents block a change; resolve or archive them before applying. Existing persisted Agent threads remain on their original backend after changing the default.

Settings provide repair after installation damage, retry after an operation failure, rollback when a validated recovery version exists, and cleanup only when reclaimable data exists. Cleanup protects active, staged, running, pinned and recovery installations. Interrupted downloads with bridge ownership markers can be reclaimed; unrecognized files are left alone. Rollback restores executable files, not a historical copy of user data.

Removing managed Codex preserves shared Codex login/config/history, projects, bridge settings and SDK credential profiles. If the removed installation was selected, the bridge leaves a selection-required state and does not reinstall or switch automatically. Unused managed CLI files can also be removed while an external CLI remains selected.

## Compatibility policy

The reproducible CI baseline remains **Codex CLI 0.153.3**. User-supported direct App Server versions are **0.153.3 and 0.153.1**. The latter was checked against all 416 generated JSON schemas after removing documentation-only fields, and with an offline initialize/thread identity smoke test. CI schema generation still requires the exact baseline; a user-supported older version cannot regenerate the lock accidentally.

External versions outside the baseline allowlist stay selected and receive a compatibility explanation. Newly downloaded managed CLI versions must match every existing normalized JSON protocol schema in `sdk/cli-contract.json`; documentation changes and additional schema files do not invalidate that check. A binary hash and contract identifier record the result, and App Server admission verifies that record. A changed contract is rejected before activation. The user can explicitly install a known version. This conservative check does not claim that an arbitrary newer release is compatible.

## Experimental Python SDK

**SDK execution environment** installs an isolated managed runtime without requiring a system Python. **Use SDK for new Agents** is explicit opt-in. The previous direct backend is saved and can be restored; existing SDK threads are not converted to direct threads. Cross-backend handoff continues to require a fresh thread and an explicit `handoffSummary`.

The first approved bundle is:

| Component | Exact version |
| --- | --- |
| Python | 3.12.14, python-build-standalone 20260901 |
| `openai-codex` | 0.147.0 |
| `openai-codex-cli-bin` | 0.147.0 |
| Update channel | stable, manual |

See [`sdk/runtime-lock.json`](../sdk/runtime-lock.json) and [`sdk/requirements.lock`](../sdk/requirements.lock) for the reproducible test baseline. New installations resolve the latest stable `openai-codex` and its exact `openai-codex-cli-bin` dependency, freeze all resolver-selected wheels with publisher SHA-256 hashes, and retain a per-installation lock. The independently latest CLI is never substituted into the SDK bundle. The managed Python baseline is retained; SDKs requiring a different Python version fail admission until that Python is supported. Managed Python assets cover macOS and Linux, arm64 and x64. This release does not supply a Windows SDK bundle. Installation performs an offline SDK initialization check in a temporary Codex home; login failure is not installation damage.

The TypeScript bridge supervises a long-lived Python worker pool. Python uses the exact SDK's public `CodexClient` methods and generated types; it never substitutes the selected external CLI or falls back to direct protocol execution.

| Contract | SDK 0.147.0 behavior |
| --- | --- |
| Start, continue, restart resume, fork, read, archive/restore | Supported; exact thread identity retained |
| Foreground/background work, progress, model/effort/tier selection | Supported through the existing job and policy layer |
| Command/file/permission approval and user input | Public SDK callbacks; explicit request correlation |
| Steering and cancellation | Exact active turn; explicit cancellation provenance required |
| Process supervision | Worker generation/PID/group, exit, restart and version evidence |
| Background terminal inventory / individual termination | Unsupported; fails closed |
| Memory-only threads | Unsupported; reliable completion recovery requires persisted history |
| App visibility disabled | Supported through a separate persisted bridge profile |

A loaded SDK thread can make background-process state unknown during a graceful stop. The bridge then defers restart or update rather than assuming that no processes remain. Review the work before using the existing explicit force-stop control; persisted threads can subsequently resume.

For ChatGPT SDK sessions, enabling app visibility uses the shared Codex home. Disabling it uses `runtimes/sdk/profiles/chatgpt`, which persists history but is not linked to the app. That private profile may require its own ChatGPT login using **SDK ChatGPT 로그인**. Credentials are not copied from shared storage. API sessions always use the private API profile, including when app visibility is enabled. A custom `CODEX_HOME` is not advertised as linked to the standard app because its app configuration is unconfirmed. Sharing storage never promises immediate app list refresh.

Each new SDK thread gets a persisted profile binding before the Agent records admission. Continuation uses that binding after settings changes and restarts. Forking across storage profiles is rejected with an instruction to start fresh or restore the original storage setting. SDK threads created before profile bindings were introduced fail with `SDK_SESSION_CONTEXT_UNKNOWN`; their history remains untouched, and they require a fresh Agent instead of guessing an account or storage location.

SDK 0.147.0 can discard a completion delivered before its turn queue is registered. The worker reconciles once through public `thread/read`, without repeating the turn. It accepts stored completion only when the live thread is terminal: an active thread's unfinished stored turn may be labeled interrupted. Memory-only threads cannot provide the required history and are therefore not advertised as supported.

## Authentication and billing

SDK authentication defaults to **ChatGPT**. The worker checks the selected source before model or turn requests and removes ambient `OPENAI_API_KEY`, `CODEX_API_KEY` and alternate API endpoint variables. Missing ChatGPT credentials fail closed; they never select API billing automatically.

API Key mode requires a local app action, a billing acknowledgment and a key supplied through a private stdin pipe. It uses `runtimes/sdk/profiles/api-key`, a separate Codex home with file-based credentials and current-user permissions. This location is checked against registered project roots. Changing auth requires stopping SDK use safely. No model-visible MCP tool can set authentication or receive the key. `auto` is not offered.

ChatGPT inspection never injects `forced_login_method`, which could otherwise change a mismatched shared login. Both direct CLI and SDK status report the actual authentication mode. A changed account file invalidates catalogs and quota caches; a running worker rejects new turns after an account identity change until the bridge is restarted. Normal same-account token refreshes do not trigger that admission guard.

ChatGPT use follows the account's plan/workspace Codex allowance and credit policies. API Key use follows OpenAI Platform billing. The app reports requested and verified authentication sources without exposing account IDs, claims or tokens. SDK job status/audit retains Python, SDK and Codex versions and verified source; overview `codex_status` reports active, staged and recovery versions. Secrets remain in the isolated credential store, not bridge job storage.

## Validation and rollback

Run `npm run check`, `npm run app-server:compat:check`, `npm run sdk:check`, and `npm run macos:check`. SDK checks create a disposable venv with hash-locked packages, or use `CODEX_MCP_BRIDGE_SDK_TEST_PYTHON` when supplied. They use the real SDK with a test-only fake runtime and make no billed model calls. `CODEX_MCP_BRIDGE_SDK_LONG_TEST=1 npm run sdk:check` includes a 610-second completion test; release CI requires it.

On 2026-09-05, managed installation and removal of CLI 0.153.3, managed Python/SDK installation, ChatGPT authentication, and real SDK restart continuation were checked locally. A read-only ChatGPT SDK turn completed after 624 seconds; an earlier attempt failed with an upstream DNS error, with the failure delivered rather than an implicit bridge timeout. API-key tests use mocks only; no API-billed smoke run was performed.

Explicit UI/model/operator cancellation retains the existing cancellation-intent audit. SDK timeout/abort, runtime interruption, auth/usage failure and worker loss remain distinct from host HTTP disconnect observations. Disconnecting a foreground caller does not cancel its tracked job.

The SDK remains experimental. It must not become the default until the unsupported feature gaps, exact bundle compatibility, authentication boundaries, restart continuity and long-running acceptance are reviewed. Updating or restoring a bundle requires a verified version and safe application; an unavailable recovery version is not silently replaced with another backend.


## Central Codex service and account data

`CodexService` owns the installation managers, execution/storage policy, account projection, cache context and optional billing connection. Execution entrypoints and the local helper use the same service. CLI/SDK adapters retain protocol-specific transport and supervision; they do not each invent authentication, storage or billing policy. `ContextualModelCatalog` retains data only within the originating context and prevents an old account’s fallback catalog from leaking into another account’s choices.

The overview’s quota belongs to the account for the selected default execution environment, not to a particular executable copy. Existing Agents still use their saved backend and SDK profile. Switching the default does not convert those Agents. Short and weekly windows are shown when supplied. Extra-credit balance/status appears in details only when supplied and relevant; balance does not prove past credit use. Rate-limit reset coupons are a separate count and are never redeemed automatically. Missing data is unavailable, not zero. API mode does not display a ChatGPT weekly quota or imply unlimited requests.

The menu retains the existing Codex weekly gauge. Spark is labeled **GPT-5.3-Codex-Spark**, and only its windows with remaining allowance below 100% appear inside the same card. Fully replenished Spark windows are hidden. A positive extra-credit balance is shown numerically when a Codex plan window is exhausted; it is labeled as a balance, never inferred spending. API mode uses a compact monthly organization/project cost summary when cost reporting is connected.

Codex settings show the execution method for **new tasks** first, followed by one account-usage section with gauges. Accounts known to be the same are deduplicated; distinct or unverified identities remain available under the other runtime's account disclosure. SDK installation does not enable SDK execution automatically. Installation paths are left-aligned in installation details with copy/reveal controls. Disclosure headers reuse the other tabs' full-row button, including the title and empty space.

Update checks sit beside notification preferences and show the last attempt, last successful check, available version, skipped version and pin state. Disabling notifications stops scheduled checks; manual checks remain available, and installation always requires a user action. Normal settings refresh runs every 30 seconds while that tab is visible; only installation progress polls every two seconds, using cached account information. Duplicate status requests are coalesced and unchanged snapshots are not republished. Structural dashboard refreshes reuse account information for at most five minutes within the same authentication/storage context, avoiding replacement of a detailed account snapshot by an unrelated fallback display.

Observed token totals are shown per session when Codex supplies them. Repeated cumulative notifications are not added together. These counters can include earlier turns and are not treated as a complete task invoice. The cost estimator requires explicit dated prices and attributable tokens; the UI does not invent a model price or dollar estimate from incomplete session totals.

**Optional API cost connection:** In an API account’s local Codex settings, expand **API 비용 연결** and supply a separate OpenAI Admin API key plus an organization ID and optional project ID. The key is stored with current-user permissions in `runtimes/billing/connection.json`, outside registered project roots. It is never used for Codex execution and is never returned through MCP or helper status. Disconnect deletes only this billing connection.

The connection reads the official organization Costs endpoint for the current UTC month, follows pagination, and shows the configured organization/project total with its scope. It may include work performed outside this bridge, and is not matched to an inference key or described as this Agent’s cost. Absent permission, an unknown amount or a failed request is shown as unavailable; a verified zero remains zero. The official API usage dashboard remains available without connecting an Admin key. Tests use mock billing responses only.

References: [Codex authentication](https://learn.chatgpt.com/docs/auth), [App Server account and usage API](https://learn.chatgpt.com/docs/app-server), [OpenAI Costs API](https://platform.openai.com/docs/api-reference/usage/costs), [API rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
