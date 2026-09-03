# Release governance

This repository has one product release unit: `codex-mcp-bridge`. The native
macOS app and the generic npm server archive are two distributions of that one
product. They never receive independent product versions.

## Version authorities and independent axes

| Classification | Authority or mirror | Meaning |
| --- | --- | --- |
| Product SemVer authority | `package.json#/version` | The one product version |
| Release-stage authority | `release-manifest.json#/release/stage` | `development`, `candidate`, `stable`, or `deprecated` |
| Release-unit authority | `release-manifest.json#/release/releaseUnitId` | Always `codex-mcp-bridge` |
| Product-version mirrors | root versions in `package-lock.json`, `release.version`, `.codex-plugin/plugin.json#/version`, `CFBundleShortVersionString`, tag and asset names | Must match the product authority |
| Derived publication channel | `release.channel` | `none`, `prerelease`, or `stable`, fixed by the stage |
| Candidate provenance | `release.sourceVersion` | Suffix-free development version from which the target bump was calculated |
| Stable provenance | `release.sourceCandidate` | Exact last `X.Y.Z-rc.N` used for stable promotion |
| Build identity | `CFBundleVersion`, `dist/build-info.json` commit/time/source hash | Identifies a build, not the product version |
| Manifest schema | `manifestVersion` (currently 3) | Release metadata schema compatibility |
| UI compatibility | UI contract generations and content-hashed resource URIs | Cached-card compatibility, independent of SemVer |
| State compatibility | SQLite schema version (currently 12) | Local data migration axis |
| Tool/runtime compatibility | Task input contract 2, helper protocol 2, companion protocol 1, execution-policy references, App Server schema lock and pinned Codex CLI | Independent protocol and compatibility axes |
| Runtime state | `.env`, authentication material, SQLite data, process locks | Never a version authority or release payload |

`npm run release:check` checks the version mirrors, generated plugin and UI
metadata, manifest schema, release stage, branch combination, and active change
fragments in one entry point. `npm run release:sync` repairs derived metadata;
it does not choose a stage or grant publication authority.

## Stage and branch lifecycle

```text
ordinary work -> dev -> release/X.Y.Z -> main
```

| Stage | Allowed publication branch | Version form | Publication |
| --- | --- | --- | --- |
| `development` | `dev` and ordinary work branches | `X.Y.Z` | none |
| `candidate` | matching `release/X.Y.Z` | `X.Y.Z-rc.N` | GitHub prerelease |
| `stable` | prepared on matching release branch, published from `main` | `X.Y.Z` | GitHub release |
| `deprecated` | historical record only | `X.Y.Z` | forbidden |

`main` accepts only a suffix-free stable state. A release branch can contain a
candidate and then its stable-promotion commit, but manual publication accepts
only the candidate state. Other branches cannot carry candidate or stable
state. Existing tags, releases, and assets are immutable and are never replaced.

## Change fragments and version selection

Release-relevant work adds one repository-owned `.changes/*.json` fragment.
The schema is documented in `.changes/README.md` and enforced without a third-
party tool. The highest requested bump wins; no fragments means PATCH. During
`0.x`, compatible fixes are PATCH and features or structural changes are MINOR.
A breaking `0.x` fragment requires at least MINOR, a `BREAKING:` summary, and a
migration instruction. At `1.x` and later, a breaking fragment requires MAJOR.

Inspect the non-mutating plan on `dev`:

```bash
npm run release:plan
```

For the current accumulated fragments, the expected plan is
`release/0.4.0` and `0.4.0-rc.1`. This is a plan only: it does not change the
version, create a branch, publish a tag, or publish a release.

After creating and switching to the exact planned branch, prepare metadata:

```bash
npm run release:prepare-candidate
```

Open one draft pull request from that same-repository `release/X.Y.Z` branch to
`main`. While the manifest is `candidate`, the pull request runs the complete
read-only release validation, but its required **Stable promotion gate** remains
on `HOLD`; the pull request must not be merged in candidate state. Publish each
validated RC only through the manual release workflow.

If a candidate validation or publication run fails for a transient runner or
network reason without changing the commit or payload, rerun that exact commit.
If the fix changes any source or payload, keep the PR on `HOLD`, commit the fix
on the release branch, run `release:next-rc`, and publish the new RC; never
replace an existing RC tag, release, or asset.

Each changed candidate increments only `rc.N`:

```bash
npm run release:next-rc
```

After the last RC passes all gates, remove only its RC suffix, record that RC,
and consume its active fragments:

```bash
npm run release:promote
```

The same pull request then reruns in `stable` mode, compares both rebuilt
payloads with the latest published source RC, and passes the required gate only
after every read-only job succeeds. Merge that exact promotion into `main` for
the stable publication. After the stable state is merged back to `dev`, restore
the non-publishing stage without changing the product number:

```bash
npm run release:development
```

None of these local metadata commands publishes a tag or GitHub release.

## Validation ladder

| Level | Command or evidence | Scope |
| --- | --- | --- |
| Fast | `npm run validate:fast` | manifest/mirror/UI drift, fragments, App Server schema lock |
| Affected | `npm run validate:affected` | fast checks plus Node and/or Swift checks selected from changed paths |
| Full integration | `npm run validate:full` | full Node build/tests, exact App Server schema, full Swift tests |
| Candidate | `npm run validate:candidate`, the read-only release PR, plus the manual release workflow | clean installs, all four assets, npm archive, app/DMG structure, architecture, ad-hoc signatures, checksums |
| Stable promotion | `npm run validate:stable`, the required Stable promotion gate, the main release workflow, and physical-Mac evidence | latest source RC, normalized payload equivalence, exact stage/tag, installation readiness |

A successful result applies only to the exact commit and inputs that produced
it. An unexplained difference, absent source candidate, missing asset, failed
physical-Mac check, or ambiguous evidence leaves the release on `HOLD`.

## RC-to-stable payload boundary

Stable publication downloads the two actual source-RC artifacts and compares
them with the newly built stable artifacts. The npm archives and DMGs are
unpacked. Version strings, release stage/channel/provenance, build identity,
`CFBundleVersion`, `CFBundleShortVersionString`, ad-hoc signatures, and DMG
container details are the enumerated normalization boundary.

Everything else participates in a sorted SHA-256 tree digest, including file
paths, modes, symlinks, JavaScript, the native executable, UI resources, public
contracts, runtime scripts, and production dependencies. Any unclassified
difference stops stable publication and requires another RC. The final four
files still receive their own new checksums; payload evidence is workflow
evidence and does not add a fifth public asset.

## GitHub Actions authority

The release workflow has three entry points with separate authority:

- a `pull_request` targeting `main`, accepted only when its head is a
  same-repository `release/X.Y.Z` branch whose manifest is `candidate` or
  `stable`; this path is read-only and never publishes;
- `workflow_dispatch` on an exact `release/X.Y.Z` ref whose manifest is
  `candidate` and whose version is `X.Y.Z-rc.N`;
- a push to `main` whose manifest is `stable`, suffix-free, and names its exact
  source candidate.

Pushes to `dev`, pushes to release branches, and ordinary pull requests to
`dev` do not run this workflow. A non-release pull request targeting `main` is
rejected by the first policy job. The policy validates the event, same-repository
head, base, stage, branch, and version before installing dependencies or
building. Candidate PRs expose successful read-only validation while their
Stable promotion gate deliberately remains on `HOLD`. Stable PRs additionally
require the latest existing GitHub prerelease for `sourceCandidate` and compare
both npm and macOS payloads before the gate passes. Only manual candidate and
`main` push runs receive publication authority. The publisher rejects
repository mismatches, conflicting tags, duplicate releases, missing declared
assets, and extra undeclared assets.

The public asset set remains exactly:

```text
Codex-MCP-Bridge-for-ChatGPT-<version>-macOS-arm64-unnotarized.dmg
codex-mcp-bridge-for-chatgpt-<version>.tgz
codex-mcp-bridge-for-chatgpt-<version>.tgz.sha256
SHA256SUMS.txt
```

The macOS app remains ad-hoc signed and unnotarized. No Apple developer account,
Developer ID, notarization secret, non-macOS app, installer, wrapper, or skills
archive is introduced by this policy. The generic npm server remains available
for users who want to run the server directly.

## Remote protection and promotion hold

The intended remote boundary is: `dev` is the default branch; `dev` and `main`
reject force-push and deletion; `main` requires a pull request and the strict
**Stable promotion gate** status check; release branches reject force-push but
remain deletable because they are short-lived. These settings are defined in
`.github/rulesets/`. Version-tag rules permit a new `v*` tag but reject moving
or deleting an existing one. Apply the workflow before activating the required
remote status context, then verify the remote settings separately. Remote
protection does not replace the repository-local checks.

No candidate should be published until the physical clean-Mac install,
upgrade, quit/process cleanup, `.env`, and state-preservation checks are recorded.
No stable release should be published until its source RC passes those gates.
