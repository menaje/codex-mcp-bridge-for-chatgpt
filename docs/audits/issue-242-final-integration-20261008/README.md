# Issue #242 final integration selection

The user authorized remote `dev` integration on 2026-10-08 after independent
verification. This authorization supersedes the historical integration holds in
the preserved candidate and verifier reports. It does not authorize installation,
production-state changes, GitHub Actions changes, or Issue #242 closure.

The selected candidate is `de037d99d82aa42c5a792c1d3bd9c88afb45b173`, tree
`b7c4cee8d90725dd4fa554cb777b201af50e899a`. The selected independent audit is
`d1a36b52e84c90c5a3738d2d845ecb2595e0b394`, its direct child, tree
`1ebdf49c7ef0aac187008d008180670e445a5acf`. That child adds only
`docs/audits/issue-242-independent-20261008/`; it changes no candidate source,
tests, scripts or historical evidence. This selection preserves both commits
in the integration history rather than rewriting them.

Remote `dev` was fetched and read back as
`264fa5c99ca1c8edeef50af247614204c8f3df53`, tree
`20f5abd270d15c33e5104665f47e5da4b9abb851`. It is an ancestor of both selected
commits. No remote-base reconciliation is needed at this observed identity.
The final merge requires another exact remote-base/head readback. The repository
currently reports `main` as its GitHub default branch; this work explicitly
targets `dev` and changes no repository settings. No existing Issue #242 PR was
found at the initial readback.

Remote-base, selected-candidate, independent-audit and local-root `AGENTS.md`
are identical. The lifecycle instructions require commit integration and safe
task-owned cleanup. The existing root `dev` is deliberately preserved at
`ea8f93e2acbb9f4b6deca113165d27e8c9c23857`, including all 23 pre-existing
local-only commits. It is not the remote integration input. The eleven existing
worktrees, their branches and their original HEADs remain outside cleanup scope.

## Alternate candidate reconciliation

The other candidate is `b9cb19d49e8ef9192e1044ddd5880e66c06e1cca`, tree
`4f2a35d66b1b2d53809e70c967ec028f06f12a71`. The complete tree comparison has
no difference in product code, native code, dependencies, release metadata,
GitHub Actions or repository instructions. Only three paths outside audit
records differ:

| Path | Difference and decision |
| --- | --- |
| `scripts/issue-242-characterization.ts` | The alternate retains the old immediate completion release/reclaim assertion. The selected script adapts that fixture to W3's persisted retry deadline and verifies stable event identity, integrity and foreign keys. Keep the independently tested selected script. |
| `scripts/issue-242-integration-read-cost.ts` | The alternate adds a read-only copy to measure read cost separately from completion cost. It introduces no product behavior. The selected characterization and independent populated-read samples already cover the required workload; do not add a redundant harness. |
| `test/issue242R502.test.ts` | Both await child cleanup and asynchronous response completion within the unchanged original wait bound before checking the phase set. Only expression/comment wording differs. Keep the independently verified selected expression. |

The alternate audit compares reads against the older `8474165e…` baseline,
whereas the selected integration audit's fresh comparison starts at
`f710974b…`, which already includes W1/W2. These are distinct comparisons and
their latency deltas must not be combined. Both retain the same synthetic
population and disclosure of uncontrolled cache/load, small samples and
unmeasured production costs. The alternate's ignored final-verdict receipt was
inspected and preserved separately. It contains no material product correction
missing from the selected candidate. Its historical formatter findings do not
warrant changes to independently verified source or byte-bound evidence.

Both original branches/worktrees are retained. A verified complete-history Git
bundle preserves all three exact source/audit refs independently of those
worktrees. All 85 selected integration artifacts and all 33 independent-audit
artifacts match their recorded byte counts and SHA-256 values; see
[selection evidence](selection.json). Historical audit files remain unchanged.

## Validation and acceptance boundary

The final integration worktree clones the already verified dependencies without
an install or lockfile change. Fresh build, TypeScript, fast metadata/schema,
focused Issue #242 and related contract checks, unfiltered full Node, strict full
native, characterization, completion-count and local tunnel checks are required
on the final committed selection before pushing. Commands, exact source/tree,
log hashes, raw results and subsequent GitHub readbacks are retained in the
task-owned external evidence directory. The PR description reports the observed
results; a preceding successful run is never substituted for a failing final run.

Validation uses the existing CLI 0.153.3 and pinned local Go fixture, serialized
`taskpolicy -a` children, one Vitest worker and fresh task-owned temporary/home
paths. No product deadline, capacity, retention rule or test expectation is
changed. The Go opt-in uses synthetic loopback endpoints only. The two native
live companion/pairing opt-ins remain excluded. Existing audit-only EOF findings
are retained byte-for-byte rather than changing hashed historical transcripts.

Installed-app acceptance and live production 502 causation remain explicitly
**UNVERIFIED**. Automated fixtures establish bounded read/observation,
completion and transport behavior; they do not establish the installed user
flow, production latency, hosted external-failure recovery or the cause of the
observed production 502. Issue #242 must remain open.

Next acceptance requires an authorized artifact-bound installation/host exercise
with realistic data distributions, observed per-method rates and liveness/recovery
scenarios. Production 502 investigation requires authorized cause-specific,
bounded correlation evidence across ingress, child and tunnel. The current work
performs none of those production actions. Reconciliation of unrelated local
`dev` commits is separate work with its own validation.
