# UI card release and retirement policy

This policy was recorded on 2026-09-11. Its implementation is a release-readiness
requirement tracked in [#53](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/53),
with artifact verification in [#52](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/52)
and upgrade guidance in [#11](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/11).
The current generator still accumulates development revisions. Recording this
policy does not claim that pruning, Activity-card removal, or a release has
already happened.

## Three separate inventories

| Inventory | Contents | Admission to a release payload |
| --- | --- | --- |
| Published baseline | The exact final cards of each supported stable release, with release tag/commit, original URI, HTML digest, cache metadata, original presenter and required tool contracts | Retain explicitly supported identities; record an explicit retirement decision for any removed identity |
| Development current | One current revision per active card, updated as development changes | Include only the final candidate revision of each active card |
| Temporary deployment exceptions | Exact development or RC revisions already used by supported clients, with build/RC provenance, usage evidence, required contracts, owner and an exit condition | Include only explicitly selected exceptions that still need migration support |

The latest stable release is the starting inventory. Older releases still
within a declared support window also participate. A directory of development
snapshots, a successful local build, or the `previous` array alone is not proof
that a revision was published or remains supported. RC publication and local
operating deployment can create real clients even without a stable release;
review those deployments before excluding their revisions.

Keep publication provenance even after support ends. Within a supported set,
identical resource identities shared by multiple releases are stored once and
linked to each release. A retired card can still have published-baseline or
temporary-exception entries; retirement is a lifecycle state, not evidence that
its clients never existed.

## Development, candidate and stable transitions

1. Ordinary `release:sync` should replace the development-current entry without
   automatically promoting the displaced revision into published compatibility.
   Development-only snapshots may be kept outside the release payload for local
   work, but must not enter packaging merely because they exist on disk.
2. Candidate preparation selects supported published identities, final current
   cards, and explicit temporary exceptions. Freeze the selected files,
   metadata, presenters and tool dependencies before publishing the final RC.
   If any of them changes after an RC is published, produce another RC.
3. Stable promotion preserves the final RC's selected payload. Record the exact
   final active cards once as that stable release's baseline, so they become
   prior-release compatibility in the next development cycle. Do not import
   the intervening development history.
4. Publication evidence may record the final stable tag outside the compared
   payload. Any inventory embedded in the payload must already have the same
   content in the source RC. Do not extend payload-normalization exceptions to
   conceal card additions, deletions, metadata changes or tool changes.

SHA-256 identities remain independent of product SemVer. Preserve the original
URI, snapshot and cache-affecting metadata for a retained revision. Do not
serve incompatible current HTML under an old identity. Compatibility includes
the original presenter, discovery visibility and strict read/mutation contracts,
not just a retained HTML file. Settings saves require particular attention to
schema, revision and permission checks.

## Activity-card retirement

The target active card set is **Settings, Dashboard and Question**. Activity
cards are retired from new use and must not keep generating a new current
release card. Existing supported Activity identities belong only to the
compatibility inventories above until their migration is complete. The current
four-resource manifest and generator have not yet implemented this distinction.

The physical-removal change must inventory the renderer, resource registration,
original `codex_activity` presenter, app-only reads and controls, rehydration,
card leases/watchers, completion handoff and legacy display/handoff settings.
Remove only dependencies exclusive to retired clients after checking current
Settings, Dashboard, Question and native callers. The 14 names listed in
[Card tools](card-tools.md#existing-cards-and-settings) are a dependency-audit
input, not a blanket deletion list. Activity/Agent/Job data, ownership, results,
questions, idempotency and shared execution/control logic remain supported.

The existing #69 default for supported legacy clients remains **at least 60 days
and two stable releases after the first stable containing #69, whichever is
later**. It is not a requirement to publish every development snapshot. As of
the baseline below, that stable release has not happened. An earlier complete
removal, including removal in the next stable release, needs a recorded decision
that explicitly supersedes that default for the affected clients, a breaking
change fragment and release-note migration instructions, and verified migration
of those clients. Policy documentation alone is not that removal decision.

Before removal, identify the affected exact URIs and tool contracts, refresh
discovery, verify the existing separate overview conversation and the chosen
Activity-to-current-UI transition, and confirm that no supported clients still
depend on the removed contracts. Preserve and verify any previously used
completion handoff or its supported replacement. Keep exact result retrieval,
GPT response and user notification evidence distinct. The accepted #69 work
stays completed; new verification concerns the newly changed support boundary.
Neither elapsed time nor absence of a stable release proves absence of clients.

Actual #69 host testing found that dropping the original presenter broke
template loading and dropping its app callers broke refresh. A generic stale
HTML notice is not a migration plan if the old URI/presenter no longer resolves.
See the [dated host evidence](audits/2026-09-08-card-tool-consolidation.md#actual-chatgpt-and-state-verification).

## Implementation and release evidence

The following requirements remain open under #53:

- Reconstruct the published baseline from actual release artifacts, including
  legacy non-hashed URIs. For each identity, either verify compatible behavior
  or record its intentional retirement and migration; never silently omit it.
- Implement the three inventories and Activity lifecycle in generation,
  registration and packaging. Repeated development syncs must not grow the
  published inventory; the next stable's final cards are added once.
- Review deployed development/RC clients and record the exact temporary support
  set and exit conditions. Finalize Activity retention/removal before the final RC.
- Test retained URI/metadata/tool resolution, strict Settings mutations, final
  current selection, deduplication and rejection of unclassified revisions.
  Test any implemented retirement/transition behavior and state preservation.

#52 verifies that the npm archive and both macOS DMGs contain the same selected
UI inventory and required contracts, exclude unselected development snapshots,
and preserve the selection through RC-to-stable payload comparison. Record
counts and sizes by current, published-compatibility and temporary-exception
class; a file's presence alone does not establish compatibility.

#11 documents supported release versions and exact migration/retirement
behavior, plugin refresh and card reopening, the existing overview conversation,
Settings preservation and completion/result behavior against that same final
candidate. Pending answers, saved results and running work must survive the
changed support boundary. A development acceptance record is not evidence that
the final candidate or previously published clients were tested.

## Observed baseline: 2026-09-11

Source: dev commit `25a7886`. The latest stable is
[v0.3.0, published 2026-08-22](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/releases/tag/v0.3.0).
Inspection of its actual npm archive found `settings-v6.html` and
`activity-v1.html`; Dashboard and standalone Question were added in development
after that release. Those two original stable URIs are absent from the current
hashed registry. Historical #69 testing of deployed development cards does not
establish v0.3.0 upgrade compatibility.

| Card | Current entries in the existing lock | Previous entries | Registered HTML total |
| --- | ---: | ---: | ---: |
| Settings | 1 | 48 | 49 |
| Activity, currently compatibility-only | 1 | 65 | 66 |
| Dashboard | 1 | 64 | 65 |
| Question | 1 | 2 | 3 |
| Total | 4 | 179 | 183 |

The selected HTML snapshots total approximately 35.03 MiB before compression.
`deriveUiResourceManifest` currently adds displaced current revisions to
`previous`; only Settings history is pruned by minimum contract generation.
`write-build-info.mjs` copies every current/previous entry into `dist/ui`.
There is no published-versus-development classification check yet. The existing
release check passes this baseline, which demonstrates the enforcement gap
rather than completion of the requirements above.
