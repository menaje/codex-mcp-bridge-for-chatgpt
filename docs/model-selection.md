# Model and reasoning selection

## Information sources

`codex_models({"contractVersion":"2"})` returns the current selection mode and
policy-allowed model/effort choices. Model names, model descriptions, effort
descriptions and service-tier descriptions come from the selected Codex
installation's catalog. The bridge preserves those descriptions; it does not
scrape a website or add a model ranking, performance score, benchmark, price
table or task-to-model recommendation.

The primary catalog source is App Server `model/list`. If refresh fails, the
bridge can retain the last successful result or use `codex debug models` as an
explicitly unverified fallback. The response reports `source`, `stale` and
`warning`. Both acquisition paths obtain Codex data; the cache is not a separate
authority. See the [official model/list contract](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

The result is a projection, not the complete upstream catalog. For example,
upstream defaults and migration metadata are not automatic selection hints in
the public `codex_models` response. Settings uses the fuller editor catalog.
Non-English effort help in Settings is a maintained UI translation; it does not
replace the original descriptions returned to GPT.

Bridge-owned guidance defines executable choices, fixed/automatic mode,
inheritance and error recovery. It is separate from model capability claims.
GPT's choice can also reflect the user's request and preferences, earlier
conversation, its existing knowledge, and instructions from its host. The
absence of a bridge recommendation table does not guarantee that GPT reasons
only from the catalog.

## Ultra eligibility

**Allow Ultra reasoning** controls eligibility for the exact `ultra` effort.
The saved wire field is still `modelPolicy.constraints.allowDelegation` for
compatibility. This field does not disable all agent features, prevent GPT from
creating multiple bridge Agents, or configure Codex's general subagent tools.
Ultra's upstream description includes automatic task delegation; that does not
make this switch a general delegation permission.

In automatic mode, an explicit allowlist stores the user's choices. Turning
Ultra off preserves any saved Ultra entries, marks them inactive in both the
Settings card and native app, and removes them from `codex_models`. Admission
independently rejects disabled Ultra even when GPT submits a stale choice or
tries to inherit it on a continued/forked thread. Re-enabling Ultra restores
saved entries only when the current catalog and operator limits also allow them.

If disabling Ultra leaves no executable saved choice, the restrictive policy
can still be saved. The list is empty and a warning explains that the choices
are retained but inactive. New work and continuation are blocked until a valid
choice is available; the bridge never adds an unselected model or effort. Fast
mode can remain saved in this state and does not turn the warning into a
misleading service-tier error. An entirely empty explicit saved allowlist is
still invalid.

In fixed mode, turning Ultra off while the fixed effort is Ultra requires the
user to select another supported effort before saving. Both editors show the
conflict and preserve the selected value until the user resolves it. This does
not silently lower the effort or change models. The existing fixed-mode
compatibility fallback for a model/effort removed from the catalog is a
different rule; its effective selection and warning remain visible in the
execution audit.

Already admitted turns keep their immutable execution decision. Changed settings
apply to later admission and do not cancel an active turn or alter an exact
request replay. Current policy is rechecked when admitting subsequent work.

## Validation

Policy and MCP tests cover explicit choices with Ultra on/off, preserved choices
through settings persistence, empty executable intersections, Fast enabled while
suspended, direct disabled requests, inherited Ultra and restoration after
re-enabling. Card browser checks cover the visible disabled state, saved payload,
fixed-mode conflict and locale changes. Native presentation tests verify that
retained Ultra choices are saveable in automatic mode without being executable.

These checks use an isolated catalog and fake execution backend. They validate
the bridge's Ultra gate, not a claim that all other forms of Codex delegation
are disabled, and do not change the user's running bridge configuration.

Run the browser regression with `npx tsx scripts/ultra-policy-browser-regression.ts`.
Its report, snapshots and screenshots are written to `output/playwright/ultra-policy/`.
The [dated completion review](audits/2026-09-09-ultra-policy.md) records acceptance
criteria, executed checks and the limits of runtime verification.
