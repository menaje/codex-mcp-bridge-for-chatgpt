# Job execution UI handoff

Base: `2dedefbf9ab63f02a0d8bf0a14a82ce8abae315e`. This UI change consumes A's `server-contract-v1.md` Job projection. It does not modify server projection, policy, schema, adapters, localization catalogs, or generated resources.

Both clients request `historyMode: jobs`. Progress consumes actual Job rows in `activeRows`; history consumes terminal Job rows and `executionCount`. Unsupported mode retries the legacy projection and labels its counts as groups. Exact details use scope/Job/revision/policy identifiers; there is no Agent substitute. The card calls `codex_ui_read` view `dashboard-execution`; native clients call `dashboard.execution-detail`.

Prepared summaries unfold without a request. Explicit detail reads cache by connection, scope, project, mode, Job, execution revision and policy revision. Target expiry and request generations reject expired or late results, including A→B→A scope changes. Page count/policy changes rebase history instead of merging shifted pages. Cancellation stays neutral and recorded versus absent reasons remain distinguishable.

Problem rows show exact execution identity, occurrence time, recorded failure/cancellation reasons, and recovery steps. Distinct affected Jobs, system incidents, unavailable linked Jobs and event totals use separate units. Processing controls remain removed; normal execution/security controls retain their existing server contract.

Validation: 20 targeted JavaScript tests, 28 `DashboardPopoverTests` with complete strict concurrency and warnings as errors, TypeScript no-emit checking, and eight browser fixture scenarios passed. Browser artifacts are under `output/playwright/tabs-execution`. These are source/fixture checks, not installed-app measurements or combined server integration tests.

Integration requirements for A:

- Synchronize `ui-localization-handoff.json` keys into all supported catalogs and generated resources; supplied translations cover English and Korean.
- Combine with the fixed server candidate and verify both detail routes, actual progress/control fields, bounded Job paging, policy expiry, and real distinct incident counts. The read-only server route inspection confirmed the card view name but is not integration validation.
- Perform independent review at the combined commit. UI commit stays local; push, PR and merge belong to final integration.

No operating app, operating database, settings, authentication, release, or unrelated issue work was changed.
