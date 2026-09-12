# Release manifest and promotion flow

`package.json` is the source of truth for the bridge/runtime and release
SemVer. `release-manifest.json#/release/stage` is the independent release-stage
authority, and its `release.version` is a synchronized mirror.
`npm run release:sync` copies the package version into the manifest;
`npm run release:check` rejects a mismatch and also derives the state migration
catalog from the packaged implementation and source fixtures. Its shape is fixed by
`release-manifest.schema.json` and validated again by the built-in-only
`scripts/release-manifest.mjs` command, so release checks do not depend on a
globally installed schema utility. The complete authority, branch, RC, and
validation policy is in [release-governance.md](release-governance.md).

## Canonical fields

Current public identity:

| Kind | Value |
| --- | --- |
| Product | `Codex MCP Bridge for ChatGPT` |
| Plugin display name | `Codex MCP Bridge for ChatGPT` |
| Plugin developer/category | `menaje` / `Developer Tools` |
| GitHub repository | `menaje/codex-mcp-bridge-for-chatgpt` |
| npm package | `codex-mcp-bridge-for-chatgpt` |

The manifest controls:

- public display name and description;
- npm package name, retained executable name, and packaged file list;
- Node and npm versions used by local package metadata and GitHub Actions;
- the reproducible Codex CLI baseline for protocol regression checks;
- GitHub owner and repository name;
- personal/local plugin identity, descriptions, developer, category,
  capabilities, starter prompts, and registered ChatGPT app connection;
- immutable UI cache-key policy, hash algorithm and prefix length, minimum
  contract generations, and currently required logical resources;
- the single release unit, synchronized SemVer mirror, independent stage,
  derived publication channel, source-RC provenance, tag prefix, and release title;
- the version-derived `docs/releases/X.Y.Z.md` release notes and the manifest-v6
  release, state, and UI asset contract;
- state schema 19, supported source schemas 3 through 18, retired JSON imports,
  persistent Settings/task/helper/companion contracts, state-profile policy,
  recovery boundary, and the digest of `state-migrations.json`;
- two native targets: ad-hoc-signed, unnotarized macOS 13+ `arm64` and `x64`
  DMGs alongside the existing generic npm server archive.

## Archived skill documents

The former ChatGPT skill source is retained under `archive/skills/` only for
history and possible future reference. ChatGPT does not consume these files,
so they are not an active product surface and must not be installed or packaged.

The archive directory is deliberately outside the npm `files` allowlist and is
not copied into the native macOS app. Manifest version 6 does not declare a
skills artifact, and the release workflow neither builds nor publishes a skills
ZIP. A complete release therefore contains only the two architecture-specific
macOS DMGs, generic npm server tarball, npm tarball checksum, and aggregate
checksum file.

## State compatibility and recovery

`state-migrations.json` is packaged in the npm archive and both macOS runtimes.
It records the supported source range, unsupported schemas, exact and derived
fixture provenance, and each migration ID/from/to/implementation checksum. Once
recorded, an existing catalog entry is append-only. `release:sync` refuses to
rewrite it when migration code or a fixture changes; correct changed behavior
with a new schema step and catalog entry.

Stable, candidate, and development packages use separate default state profiles.
The release workflow audits migration and actual backup restore in the unpacked
npm archive and each mounted architecture-specific DMG. It also starts the
published v0.3.0 runtime against the restored schema-3 database. All reports are
artifact-bound, sanitized private workflow evidence rather than public release
assets. The exact upgrade, backup-retention, pre-service restore, and post-service
forward-repair procedure is in the
[state upgrade and recovery runbook](state-upgrade-recovery.md).

## Personal/local plugin package identity

`npm run release:sync` derives `.codex-plugin/plugin.json` and `.app.json` from
the `plugin` block. The first file contains the plugin's user-facing metadata
and always uses the release SemVer. The second maps the package to the existing
developer-mode ChatGPT connection. Both files are generated and included in
the npm package; do not edit them directly.

`npm run release:check` rejects either missing file, malformed JSON, or any
field that has drifted from `release-manifest.json`. Public marketplace-only
assets and policy URLs are intentionally omitted while this package remains a
personal/local plugin.

## UI resource identity and compatibility

UI identity is independent from release SemVer. `npm run release:sync` currently
renders Settings, Dashboard, Question and retained Activity HTML, combines it
with canonical host-affecting metadata (`mimeType`, CSP, widget domain, and
presentation preference), and derives an immutable SHA-256 URI:

```text
ui://codex-mcp-bridge/settings/<content-hash>.html
ui://codex-mcp-bridge/dashboard/<content-hash>.html
ui://codex-mcp-bridge/question/<content-hash>.html
ui://codex-mcp-bridge/activity/<content-hash>.html
```

The command is the only supported writer for:

- `ui-manifest.lock.json`, which records current and retained identities;
- `ui-resources/`, which contains immutable source-side HTML snapshots;
- `src/uiManifest.generated.ts`, which gives the server the same identities;
- build-time `dist/ui-manifest.json` and packaged snapshots.

The server registers every revision selected by `ui-release-catalog.json` with
that revision's original descriptor and content metadata. The release manifest
binds the catalog digest, and the generated lock records inventory provenance,
presenter, and required tool contracts. Packages contain one current revision
for each active card plus supported published baselines and explicit deployed
exceptions. Unclassified development lock history is not copied.
The resource descriptor, `_meta.ui.resourceUri`, and compatibility
`openai/outputTemplate` must all name the same current URI.

The [UI card release and retirement policy](ui-release-compatibility.md) defines
separate supported stable baselines, one development current per active card,
and exact exceptions for deployed development or RC clients. Only the final
current cards enter the next stable baseline. Activity is compatibility-only;
its selected resources and presenter remain available, while new work uses
Dashboard and Question.

Before the final RC, verify the catalog's exact selection in the npm archive and
both DMGs (#52). The current selection contains eight unique snapshots: current
Settings, Dashboard, and Question; the actual v0.3.0 non-hashed Settings and
Activity resources; and the explicitly deployed development Settings,
Activity, Dashboard, and shared Question revision. Document card refresh and
reopening against that candidate (#11). Do not prune cards during stable
promotion; a changed UI payload requires another RC.

`npm run release:check` reproduces the render and fails on content, digest,
metadata, snapshot, missing-resource, duplicate-URI, descriptor, or output
template drift. Do not edit generated manifests or snapshots by hand. A SemVer
change with identical cards preserves the URIs; a card or relevant metadata
change produces new URIs even before the next version bump.
The same check rejects UI catalog digest drift, missing classifications,
unreviewed Activity renderer changes, and catalog/lock lifecycle differences.

Retained snapshots that reference the source compiler's missing `__name`
helper receive a small name-decorator bootstrap when served. Their stored
snapshots, resource identities, and protocol generations remain unchanged;
the bootstrap only supplies that missing runtime function. Current cards must
serialize without compiler-only dependencies. `test/uiResourceCompatibility.test.ts`
executes the affected helpers across every retained revision, and
`npm run test:card-resilience-browser` covers card error recovery, host result
wrappers, draft preservation, and late responses after remount. Run it again
with `-- --built` after building to check the packaged HTML as well.

A restart with an unchanged build does not require plugin metadata refresh.
After a UI or tool-metadata change, follow the OpenAI deployment order: sync and
build, restart the MCP server, select **Refresh** in ChatGPT Plugins, then test a
new conversation. Existing conversations may keep their cached descriptor, so
the supported compatibility resources remain part of the packaged build.
Ordinary saved settings, project, availability, and model-catalog changes do not
change stable `codex_task` contract v2 and require neither this release flow nor
another connection Refresh.

## App Server protocol compatibility

`release-manifest.json`'s `toolchain.codexCli` is the development test baseline. Runtime connections inspect the chosen executable and validate the public initialization response, without a CLI version allowlist or full-schema hash gate.

`app-server-schema.lock.json` records the baseline version, file counts and aggregate fingerprints for generated JSON Schema and TypeScript. `protocol/cli-contract.json` records normalized JSON fingerprints for development drift review only. These files do not approve or reject user installations.

After installing the manifest-pinned CLI, verify the lock without network
access:

```bash
npm run app-server:compat:check
```

When intentionally changing `toolchain.codexCli`, inspect that CLI's generated
protocol first, then update and review the small lock:

```bash
npm run app-server:compat:update
npm run release:check
npm run app-server:compat:check
```

`release:check` rejects a lock whose version metadata differs from the
manifest. The release workflow installs the exact manifest version
and regenerates both schema formats before build/test, so ordinary unit tests
remain offline and fixture-driven.

### App Server execution verification and recovery

App Server is the only execution path. Schema snapshots detect development drift; they do not approve end-user versions. Before a live release smoke check, finish active turns and resolve approvals, input and background processes before restarting.

Check catalog freshness, worker health, retryable failures and orphaned Agents. Verify restart continuation and two allowed model/effort selections, recording requested/effective/actual selection and any reroute. Exercise command, file, permission and user-input resolution, including cancel, decline, session acceptance, automatic resolution and expiry.

If recovery is needed, preserve history and authentication. A DB snapshot and
previous bridge runtime are one verified pair and are supported only before the
migrated service opens; follow the [state recovery runbook](state-upgrade-recovery.md).
For an App Server-only failure, restore an explicitly selected CLI installation.
Do not reactivate a retired execution backend or replay requests as a recovery
step. See [runtime policy](codex-runtimes.md).

For the issue-40 steering gate, use a deliberately long-running root Job and
record that one `codex_steer` call reaches the same active turn without another
`turn/started`. Replay the exact request and verify there is only one upstream
`turn/steer`; then verify a stale Job version and a terminal/cancel race fail
closed without queuing a later turn. Confirm a pending interaction is unchanged,
no execution/project/Activity policy changes, and no raw steering prompt appears
in SQLite or diagnostics. The deterministic suite must additionally use only
the four public fields with host-derived scope and force an exact prompt echo
through progress, event, final result, and exact status output. A crash after
the durable dispatch boundary must
return `DELIVERY_UNCERTAIN` on replay without automatic resend. Attach the dated,
sanitized evidence; do not mark the gate passed from fake-protocol tests alone.

Live verification consumes authenticated model capacity and remains separate from ordinary fixture CI. Record its dated evidence and scope; schema and fixture results alone do not establish live feature parity.

### Native macOS app distribution gate

The issue #44 app bundle is a developer preview until all of the following are
recorded for the release candidate:

- `npm run check`, `npm run macos:check`, and `npm run macos:bundle` pass from a
  clean checkout;
- the bundled runtime starts through its per-user LaunchAgent and exposes only
  private `0700`/`0600` Unix socket paths;
- an existing private dotenv, SQLite state, Settings, and project registry are
  reused without mutation, while a legacy Tunnel profile is left untouched and
  the dedicated app profile is reused exactly; the Tunnel path causes no
  operating-system credential-store prompt, and the configured Codex store is tested
  separately;
- first-run save, Tunnel profile repair, graceful drain, forced stop, crash
  backoff/safe mode, helper-crash runtime adoption, and app-only quit are
  exercised without secret-bearing logs, duplicate runtimes, or unexpected Job
  replay;
- Dashboard and Settings snapshots decode in the native client and changes are
  observed in both the native UI and retained ChatGPT cards;
- VoiceOver labels, full keyboard navigation, light/dark appearance, sleep and
  wake, network loss and recovery, and helper crash recovery are checked on a
  physical Mac;
- the Apple Silicon and Intel architecture matrix and bundled native artifacts
  are recorded and verified independently;
- the quarantined-download first-launch path is tested on a clean Mac, including
  the per-app approval in **System Settings > Privacy & Security**; the
  documentation never asks users to disable Gatekeeper globally;
- manual DMG app replacement and rollback behavior is documented and tested:
  the running app and its helper/runtime are stopped before the app bundle is
  replaced, and the replacement is launched only after that stop is verified;
  there is no automatic updater, while transactional LaunchAgent replacement
  remains covered by the automated suite;
- app removal unloads and removes the per-user helper LaunchAgent without
  deleting the private dotenv, SQLite state, project registry, or Codex login;
- the release records whether the menu-bar UI itself opens at login separately
  from the helper's existing `RunAtLoad` server behavior.

The current `macos/build-app.sh` output is host-architecture and ad-hoc signed.
`macos/package-release.sh` is the separate public packaging boundary: it checks
the manifest version, minimum macOS version, selected `arm64`/`x64` native
architecture, matching `better-sqlite3` prebuild, app signature, and DMG
container, then emits a filename containing
`unnotarized`. It deliberately needs no Apple developer account, certificate,
App Store Connect key, or GitHub signing secret. Because Apple does not trust or
notarize this artifact, downloaded copies can require the user's explicit
per-app approval before first launch.

The distribution manifest supports separate Apple Silicon and Intel packages.
Both are built on matching GitHub-hosted native runners and both must pass before
promotion. Universal packaging remains unsupported and is not inferred from
architecture-neutral Swift source.

### Direct server distribution

The native macOS app does not replace the existing Node.js server path. The
canonical npm archive remains a release asset for users who choose to install,
configure, supervise, and run that server directly in their own environment.
The project does not create additional operating-system-specific server ZIPs,
installers, GUIs, services, process wrappers, or support claims. Direct-server
users retain the existing `.env`, card, SQLite, and command contracts.

### Legacy runtime namespace

The following compatibility identifiers deliberately retain the bare
`codex-mcp-bridge` namespace and are not current product, repository, or npm
package names:

- the installed executable;
- the `CODEX_MCP_BRIDGE_*` environment prefix;
- the private `~/.config/codex-mcp-bridge/.env` runtime configuration path;
- `~/.codex-mcp-bridge`, its SQLite state, sidecars, and migration backups;
- the legacy default tunnel profile (the app-owned
  `codex-mcp-bridge-macos` profile is a separate migration namespace and must
  not overwrite it);
- MCP App resource URIs and the conversation-scope HMAC namespace.

Renaming those values requires a separate credential, state, service, and UI
resource migration. A repository or package rename must not silently perform
that migration.

## Plan and prepare a version

Keep `dev` at a suffix-free development version and add `.changes/*.json`
fragments with the user-visible impact. Inspect the aggregate without mutation:

```bash
npm run release:plan
```

Create the exact reported `release/X.Y.Z` branch, switch to it, and then run
`npm run release:prepare-candidate`. Only `X.Y.Z-rc.N` candidates are accepted.
Before the candidate check, add `docs/releases/X.Y.Z.md` with the user-visible
changes, migration steps, supported retained cards, macOS architecture choices,
and trust model. Candidate and stable publication both use that exact file and
may append GitHub's generated change list; a missing or incomplete file fails
the release check.
Open a draft pull request from that same-repository release branch to `main`;
it is the only PR shape admitted by the release workflow. Candidate commits run
read-only validation, and the required Stable promotion gate succeeds while the
candidate remains draft. The draft state blocks merging; marking the candidate
ready before stable promotion makes the gate fail.

Use `npm run release:next-rc` after any candidate payload change and
`npm run release:promote` only after the final candidate passes every gate.
The promotion preserves the numeric version, records the source RC, removes the
RC suffix, rebuilds and compares the npm distribution, and promotes each
published candidate app into its stable DMG by updating only version/build
metadata before re-signing. The same PR then reruns the strict stable payload
comparisons before merge. See
[release-governance.md](release-governance.md) for the full lifecycle and
validation ladder.

Rerun an unchanged candidate commit only for a transient Actions failure. Any
source or payload correction requires a committed fix and the next `rc.N`; a
published candidate is immutable and is never repaired in place.

If another manifest field is intentionally edited, run:

```bash
npm run release:sync
npm run release:check
```

Do not use `npm version` directly. `npm run build` and the release workflow reject
derived metadata that has drifted from the runtime package version.

## ChatGPT rollout and smoke test

For a UI or tool-contract change, use this order:

1. run `npm run release:sync`, `npm run release:check`, and `npm run check`;
2. deploy or restart the bridge so it serves current and retained UI URIs;
3. open the plugin detail in ChatGPT Developer mode and select **Refresh**;
4. verify the registered `codex_settings` output template equals the current
   Settings URI in `dist/ui-manifest.json`;
5. test Settings open, save, model-list refresh, and default restore in a new
   conversation;
6. for the issue-36 M2 smoke, run a generation-11 `codex_task`, confirm its
   private bootstrap renders and snapshot refreshes; verify Settings,
   foreground/background, same-response sibling election, and next-response
   supersession; then confirm an existing retained generation-7–10 Activity
   mount still resolves and refreshes. Record the results in the output-contract
   audit before declaring M2 complete.

The bridge cannot force ChatGPT to replace a static tool contract already cached
by a conversation. Refresh once when migrating a pre-v2 conversation or after a
genuine tool/UI metadata change; after v2 adoption, ordinary runtime Settings
and project changes remain valid in that same conversation. If a future static
contract is retained despite Refresh, record that limitation and use a new
conversation. See
[`docs/chatgpt-setup.md`](chatgpt-setup.md) for the full checklist.

## GitHub workflow contract

`.github/workflows/ci.yml` starts for a PR targeting `main`, a manual run on a
matching `release/X.Y.Z` branch, or an explicit push to `main`. The PR path
accepts only a same-repository `release/X.Y.Z` head in candidate or stable
state, remains read-only, and never publishes. Development pushes,
release-branch pushes, and ordinary PRs to `dev` run no release Actions. A
candidate PR stays on `HOLD` through its draft state; the required Stable
promotion gate is green for a draft candidate and fails if that candidate is
marked ready. After promotion, the same PR must pass its stable validations
before merge. The manual path accepts only an RC and the `main` path accepts
only a source-RC-backed stable promotion. The workflow:

1. runs the full Node.js server checks and production dependency audit;
2. builds the canonical npm tarball and its checksum;
3. builds the macOS app on native arm64 and Intel runners, ad-hoc signs both app
   and DMG variants, and verifies the version, minimum OS, architecture,
   signatures, bundled native module, and container;
4. runs the state migration/restart/restore audit in the unpacked npm archive and
   both mounted DMG runtimes, including published-v0.3 rollback execution, and
   retains three sanitized artifact-bound reports;
5. assembles exactly those npm assets and both macOS DMGs, rejecting undeclared
   files and writing deterministic aggregate checksums;
6. aggregates the read-only jobs for release PRs and prevents candidate state
   from being merged to `main`;
7. compares the rebuilt npm payload with the latest named source RC, promotes
   each published candidate app into the stable DMG with only enumerated
   release/build/signature metadata changes, and compares the unpacked macOS
   payload after re-signing in both the stable PR and final publication run;
8. refuses a repository mismatch or conflicting tag and skips an already
   published release rather than replacing it;
9. publishes all five assets together and marks only candidate-stage runs as
   GitHub prereleases.

The macOS jobs have no Apple signing or notarization secrets. Their public assets
are intentionally named with `macOS-arm64-unnotarized.dmg` and
`macOS-x64-unnotarized.dmg`, and the release notes must identify both variants
and the safe first-launch approval path. A future move to Developer ID or
notarization is a separate product and account decision; the workflow must not
silently change the trust model.

Development pushes and PRs targeting `dev` do not start this workflow at all.
Never merge, fast-forward, cherry-pick, or push development work to `main`
unless the user explicitly instructs that specific promotion. Before that
promotion, prepare the planned unused RC, open the release PR, and complete both
physical release-candidate smoke gates, including the clean-Mac Gatekeeper
path. Apply the workflow before enabling its required remote status check so
`main` is not left waiting for a context that cannot yet run.
