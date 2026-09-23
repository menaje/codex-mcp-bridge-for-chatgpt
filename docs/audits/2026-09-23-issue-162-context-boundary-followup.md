# Issue 162: context boundary follow-up

Review basis: PR #166 merged at `950d1f4`. This follow-up started from `origin/dev` at `bac5b15e56d999c78f3d51184c0efb43af955cdf` after reopening #162, then was rebased onto `3ee82b9` for final validation. The earlier [implementation record](2026-09-23-issue-162-cli-context.md) describes the initial centralization; its late-result and pending-environment claims did not cover the races corrected here.

## Corrections

| Boundary | Change | Evidence |
| --- | --- | --- |
| Model acquisition and cache publication | The provider revision is sealed at creation. The acquired CLI context carries its manager fingerprint into the model revision, and the result must still match that revision before memory or disk cache publication. The CLI lease remains held through publication. A changed context returns `CODEX_ACCOUNT_CHANGED` without stale fallback. The App Server path also rejects late results before updating memory. | A controlled A → B acquisition and late-response test verifies that B never runs or overwrites A's disk record. A new A provider reloads A's model as `valid`. |
| Applied, running and requested environment | The launcher stores its applied allowlisted Codex environment with a fingerprint in its private 0600 status file. While the runtime is running, Helper uses that environment for Codex status, account, usage and billing. The requested private-file environment is shown separately and inspected without changing its saved selection. Helper adoption after a restart retains the same applied view. | A/B runtime-home test checks A selection, A lease version and A account after the file requests B, including Helper adoption. A legacy launcher with only a fingerprint is accepted when current settings match and fails closed when they differ. |
| Pending action scope | Login and CLI installation, selection or activation wait for safe runtime restart. Status, account, update checks, preferences, cleanup and billing connection management remain available in the applied environment. Restart keeps existing memory and interaction protections. | Pending-state test exercises allowed management actions and rejected context-changing actions. Helper SIGTERM/re-adoption lifecycle test completes a waiting restart. |

The private status file is an internal handoff record and can contain allowlisted proxy or certificate values. It is restricted to the current user. Public Helper and MCP status responses contain only the selected command and home paths, not the environment values. Existing Codex jobs are not cancelled or replayed by these changes.

## Verification scope

- Source build and Node suite: 900 tests passed on the rebased branch.
- App Server schema: the pinned Codex CLI 0.153.3 matched 416 JSON and 827 TypeScript schema files. The first full-validation command encountered the installed 0.155.0-alpha.16 CLI; the pinned CLI was installed in a temporary directory for the reproducible schema check.
- macOS localization and strict Swift checks: 1,333 strings across nine languages and 207 tests (two skipped) passed.
- The A/B CLI, account and cache tests use synthetic executables and responses. They do not authenticate a real account or send a paid model turn.

Package and installed-app verification are recorded separately from these source checks.
