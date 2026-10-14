# #251 current runtime incident boundaries

The independently reviewed product candidate is
`8229136d79a366668e58de34926844d2158f1dba`, based on development commit
`fb573efae1b2896f781129ca508c0a7b7622130e`. This follow-up corrects current
incident-generation and retry-control behavior; it does not repair historical
records, adjust historical counts, restore missing data, or change operating
apps, databases, settings or authentication.

## Current management and continuous origins

An old orphaned Agent or an unavailable historical thread inspection alone
cannot discover a new runtime incident. New discovery requires unfinished work
(including blocking input/approval or unresolved cancellation), an unreleased
connection with unconfirmed shutdown, or a current busy/background observation.
Safety inspection remains available when the related Job history has expired.

For a proven continuous origin, current identity lookup reuses the existing
active control. Durable Job/Thread linkage is independent of an Agent rename
or other ordinary metadata version/update. Missing legacy lineage is not
guessed, and ambiguous old origins are not merged. One current per-Agent alias
contains control identifiers only. Existing journal keys and historical bodies
remain intact, with their original occurrence time, attempts, retry backoff and
history-expired authority. A new Job or Thread starts its own context.

Confirmed healthy inspection and later problematic inspection use the same
origin lookup, including a healthy observation before the first alias exists.
This closes the proven old control before a real recurrence, allowing a new
incident and fresh budget. Confirmation never restores expired original text
or progress. Plain unavailable inspection without current management evidence
does not create a healthy transition or a new budget.

## Verification

The author isolated four discovery/display failures on the original development
baseline. On the first repair candidate
`7947aded50bd8389040cc054b16094de15621d43`, independent review then reproduced
two current counterexamples: rename before the first handoff replenished an
exhausted budget; first healthy inspection without an alias hid a later real
recurrence behind that old exhausted budget. Both were retained as required
behavior tests and repaired in the reviewed candidate.

Author verification on the reviewed source: **78 passing cases across seven
files**, including 25 runtime-boundary cases and the two independent
counterexamples; `npm run build` and `git diff --check` passed. The related
regressions preserve the existing bounded SQL request budget.

Independent exact-candidate re-review: **29 passing cases** (the original two
counterexamples, the 25 boundary cases, and two additional input/approval safety
cases). Input and approval remained blocked, the running Job stayed running,
and no upstream execution/control dispatch occurred. The reviewer reported
**GO for development integration**, with no new blocker in this scope.

These are isolated source/synthetic checks, not installed-app acceptance. The
previously disclosed 25 unrelated repository-wide failures were not rerun or
claimed repaired; focused results do not represent a green full suite. No
long-running substitute, release, operating cleanup, or operating app replacement
is included. Remote PR review and development integration remain separate gates.

Only documentation is added after the reviewed candidate. Product mode/blob
equivalence is recorded in the adjacent runtime-equivalence audit; the exact
publication HEAD and GitHub review outcome belong to the follow-up PR.
