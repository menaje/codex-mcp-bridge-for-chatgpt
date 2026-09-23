# Issue 162: selected Codex CLI context

Source baseline: `origin/dev` at `2ee4e450ef0325f2b2945831e62786d0dc101af0` on 2026-09-23 KST. The issue's earlier static baseline was `38fb4a057feb5b938ae0e189cd6e1b2b603313d9`. The installed macOS app inspected during this work carried build `dc7c70ac0167:226fc3c1ab70` and source commit `dc7c70ac0167323a0f1aecc5cfa86e58e488666d`; it was not replaced. The installed private environment file had no explicit Codex executable, runtime home, Codex home, proxy or certificate value. Its saved selection was an app CLI at version `0.153.4` with no pending selection. These observations do not establish that the private-file-only mismatch occurred in that installed session.

## Product call map

| Function | Entry and selection | Environment and directory | Protection and cache |
| --- | --- | --- | --- |
| Settings installation status, versions and update actions | Native Helper `codex.runtime` → `CodexRuntimeManager`; configured override or saved state | Shared Codex child projection; selected runtime home | State lock, managed install ownership and live leases; account display keyed by service revision |
| Login and account/usage | Helper `auth.login` / `auth.status` → `CodexService.acquireContext()` → selected CLI | Shared projection; stable home working directory | Lease held for login process or account RPC; auth and effective CLI identity key the account cache |
| Models | HTTP/stdio server and isolated Settings read process → `createModelCatalog()` → selected `CodexService`; App Server first, selected CLI fallback | Acquired context and stable home for fallback | Short lease for CLI fallback; contextual account/CLI revision rejects late results; private persisted CLI cache is keyed to the applied context |
| New, continue, fork and control | HTTP/stdio → `createExecutionRuntime()` → selected CLI's App Server worker or isolated execution process | Runtime environment frozen at process start; isolated child strips Bridge-only variables; validated project/thread directory for turns | Long-lived selection lease; exact worker/thread assignment; new worker rechecks executable protocol |
| Version and compatibility | Manager discovery/probe; explicit candidate executable | Candidate's environment; compatibility probe uses temporary `CODEX_HOME` | Candidate-only inspection; no user login, selection mutation or model turn |
| Managed install, repair, rollback and cleanup | Manager's explicit owned install records | Managed runtime home; validation target is the new candidate | SHA verification, state lock and leases; no external app or terminal update/removal |
| Schema drift and acceptance scripts | Explicit development or fixture command | Temporary homes and repositories | Not a product selection path; kept outside operational model/account fallback |

The old Helper functions `resolveCommand` and `runCommandStatus` had no callers and were removed. Independent process adapters and worker control code remain: they consume the selected command or a pinned worker identity rather than choosing a new CLI. Direct candidate probes and development scripts are intentional exceptions.

## Reproduction and boundary evidence

- A regression using a real `MacOSBridgeSupervisor` with different saved choices in the default and private-file runtime homes failed before the fix: Helper selected the default-home CLI. It passes after the shared projection and after an in-place private-file change.
- Synthetic app, terminal and bridge-managed installations were selected independently. Helper login/account, selected CLI model fallback and an App Server task all invoked only the chosen installation for user functions. Candidate version/schema probes were allowed on other installations. These fixtures logged only an installation label, call type and Boolean environment markers.
- The built launcher and HTTP MCP model path are exercised separately with a private-file-only runtime home and an alternate default-home choice. Its private status fingerprint is compared with the Helper projection.
- The built HTTP Settings card read traverses the isolated state-read process and gets its model list from the selected CLI. A 50 ms structural-read deadline regression and a same-context-only persisted model cache test pass.
- Synthetic Tunnel and Bridge credentials loaded by the launcher are absent from Codex account, model and worker processes; Codex proxy and certificate values remain present.
- Missing saved executables remain errors in Helper authentication and execution admission even when another `codex` exists on `PATH`. Selection state corruption, active lease/pending application, npm native replacement, same-account token refresh and late cache results retain their dedicated regression coverage.
- The new context revision uses the manager's applied command and physical native executable identity, then adds Codex home, authentication/configuration and network environment inputs. Pending selections and update-check timestamps do not masquerade as an applied change. Raw environment values are neither logged nor returned in status.

## Scope of verification

Final source validation: `npm run validate:full` passed on 2026-09-23 KST, including the build, 893 Node tests, the CLI 0.153.3 App Server schema check, macOS localization checks and 206 Swift tests (2 skipped). The built launcher was also exercised through real HTTP MCP model and Settings reads. The private-file-only mismatch was captured failing before the change and passing after it.

The tests use synthetic CLIs and do not authenticate against a real account, send a paid model turn or prove a network proxy connection. The source changes and built runtime are validated in this worktree. The installed app/helper/server above still run their earlier build until a separate package installation and safe lifecycle transition.
