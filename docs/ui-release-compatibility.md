# UI card release and retirement policy

This policy was recorded on 2026-09-11 and implemented for the 0.4.0 release
line through `ui-release-catalog.json`, release manifest version 6, and the
generated UI inventory. Final candidate artifact verification remains tracked
in [#53](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/53),
[#52](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/52), and
[#11](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/11).
The implementation prunes unselected development revisions from packages; it
does not claim that the final candidate has been published or that the retained
Activity compatibility resources can already be removed.

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

The active card set is **Settings, Dashboard and Question**. Activity is
compatibility-only and no longer receives a development-current entry or a new
presentation. Existing supported Activity identities belong only to the
published-baseline and temporary-exception inventories until their migration is
complete. The renderer is frozen to the selected deployed revision; changing it
requires an explicit catalog entry and review.

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

`ui-release-catalog.json` is the source of truth for published baselines,
temporary exceptions, current tool contracts, and Activity retirement. The
release manifest binds its SHA-256 digest. `release:sync` derives only the three
active current cards plus catalog-selected compatibility revisions, and
`release:check` rejects catalog drift, missing snapshots, changed immutable
metadata, an unclassified compatibility card, or a modified Activity renderer.
Each retained revision is registered with its original descriptor, content
metadata, presenter, and required tool set. Legacy source bytes that do not fit
the repository's text-file convention are stored as base64 and decoded without
changing the served content.

The packaged inventory contains eight unique snapshots totaling 1,152,927 HTML
bytes: three Settings, two Activity, two Dashboard, and one Question. Their
provenance memberships are three development-current, two published-baseline,
and four temporary-exception entries; the current Question belongs to both the
development-current and deployed-exception inventories and is stored once.
Repeated synchronization ignores the old lock history and cannot grow this set.

#52 verifies that the npm archive and both macOS DMGs contain this same selected
inventory and required contracts, exclude unselected development snapshots, and
preserve the selection through RC-to-stable payload comparison. The artifact
audit records counts, bytes, catalog digest, identities, and required tools
without including card HTML or user data. Final evidence must come from all
three artifacts built from the same candidate commit.

#11 documents supported release versions and exact migration/retirement
behavior, plugin refresh and card reopening, the existing overview conversation,
Settings preservation and completion/result behavior against that same final
candidate. Pending answers, saved results and running work must survive the
changed support boundary. A development acceptance record is not evidence that
the final candidate or previously published clients were tested.

## Reconstructed baseline and pre-implementation measurement

Source: dev commit `25a7886`. The latest stable is
[v0.3.0, published 2026-08-22](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/releases/tag/v0.3.0).
Inspection of its actual npm archive found `settings-v6.html` and
`activity-v1.html`; Dashboard and standalone Question were added in development
after that release. Those two original stable URIs are absent from the current
hashed registry. Historical #69 testing of deployed development cards does not
establish v0.3.0 upgrade compatibility.

Before the catalog implementation, the accumulated lock contained:

| Card | Current entries | Previous entries | Registered HTML total |
| --- | ---: | ---: | ---: |
| Settings | 1 | 48 | 49 |
| Activity, currently compatibility-only | 1 | 65 | 66 |
| Dashboard | 1 | 64 | 65 |
| Question | 1 | 2 | 3 |
| Total | 4 | 179 | 183 |

Those 183 snapshots totaled approximately 35.03 MiB before compression. This is
the measured input that exposed the enforcement gap; it is not the current
package selection. The catalog reconstructs the v0.3.0 non-hashed Settings and
Activity resources from the published npm artifact and records the one locally
deployed development build as an explicit, bounded exception.
