# Release manifest and promotion flow

`package.json` is the source of truth for the bridge/runtime and release
SemVer. `release-manifest.json#/release/stage` is the independent release-stage
authority, and its `release.version` is a synchronized mirror.
`npm run release:sync` copies the package version into the manifest;
`npm run release:check` rejects a mismatch. Its shape is fixed by
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
- the exact Codex CLI version admitted for the experimental App Server;
- GitHub owner and repository name;
- personal/local plugin identity, descriptions, developer, category,
  capabilities, starter prompts, and registered ChatGPT app connection;
- immutable Settings and Activity UI cache-key policy, hash algorithm and
  prefix length, retained-generation count, and required logical resources;
- the single release unit, synchronized SemVer mirror, independent stage,
  derived publication channel, source-RC provenance, tag prefix, and release title;
- generated release-note policy and the manifest-v3 release asset contract;
- the first native target: an ad-hoc-signed, unnotarized macOS 13+ arm64 DMG,
  alongside the existing generic npm server archive.

## Archived skill documents

The former ChatGPT skill source is retained under `archive/skills/` only for
history and possible future reference. ChatGPT does not consume these files,
so they are not an active product surface and must not be installed or packaged.

The archive directory is deliberately outside the npm `files` allowlist and is
not copied into the native macOS app. Manifest version 3 does not declare a
skills artifact, and the release workflow neither builds nor publishes a skills
ZIP. A complete release therefore contains only the macOS DMG, generic npm
server tarball, npm tarball checksum, and aggregate checksum file.

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

UI identity is independent from release SemVer. `npm run release:sync` renders
the final self-contained Settings and Activity HTML, combines it with the
canonical host-affecting metadata (`mimeType`, CSP, widget domain, and
presentation preference), and derives an immutable SHA-256 URI:

```text
ui://codex-mcp-bridge/settings/<content-hash>.html
ui://codex-mcp-bridge/activity/<content-hash>.html
```

The command is the only supported writer for:

- `ui-manifest.lock.json`, which records current and retained identities;
- `ui-resources/`, which contains immutable source-side HTML snapshots;
- `src/uiManifest.generated.ts`, which gives the server the same identities;
- build-time `dist/ui-manifest.json` and packaged snapshots.

The server registers each current URI. Non-Activity history is filtered by its
configured minimum contract generation. Activity resources are immutable mount
targets, so every retained Activity revision remains registered even after the
minimum advances; generation 12 is the minimum for new descriptors while the
current generation-20 and retained generation 7–20 assets continue to resolve
and refresh through app-only tools.
The resource descriptor, `_meta.ui.resourceUri`, and compatibility
`openai/outputTemplate` must all name the same current URI.

`npm run release:check` reproduces the render and fails on content, digest,
metadata, snapshot, missing-resource, duplicate-URI, descriptor, or output
template drift. Do not edit generated manifests or snapshots by hand. A SemVer
change with identical cards preserves the URIs; a card or relevant metadata
change produces new URIs even before the next version bump.

A restart with an unchanged build does not require plugin metadata refresh.
After a UI or tool-metadata change, follow the OpenAI deployment order: sync and
build, restart the MCP server, select **Refresh** in ChatGPT Plugins, then test a
new conversation. Existing conversations may keep their cached descriptor, so
the supported compatibility resources remain part of the packaged build.
Ordinary saved settings, project, availability, and model-catalog changes do not
change stable `codex_task` contract v2 and require neither this release flow nor
another connection Refresh.

## App Server protocol compatibility

`release-manifest.json`'s `toolchain.codexCli` is the single supported-version
authority. Runtime App Server admission executes the configured Codex
executable with `--version` before starting each new worker generation and
fails closed on an unavailable, malformed, or different version. The MCP
backend remains independent from this experimental admission gate.

`app-server-schema.lock.json` stores only the supported-version metadata, file
counts, and aggregate SHA-256 fingerprints for the official experimental JSON
Schema and TypeScript generators. JSON objects are recursively canonicalized
because generated definition order is not stable; TypeScript line endings and
trailing whitespace are normalized for cross-platform comparison. Full
multi-megabyte generated trees are never committed.

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

### App Server canary and rollback gate

Do not switch the default backend merely because schema and fixture tests pass.
OpenAI documents App Server as experimental and unsupported for production
workloads. An operator canary requires explicit risk acceptance, no active
turns/approvals/input/background terminals at restart, the exact CLI/schema
check above, a real restart continuation, and two real turns that use different
allowed model/effort selections.

During the canary, inspect `codex_status` for catalog freshness, aggregate
worker RSS/FD, startup/crash/config/MCP health, retryable probe failures, and
orphaned-Agent count. Record both turns' requested/effective/actual selection
audits, any reroute reason, the stable session/thread continuation after an App
Server and bridge restart, and a summary-only cross-backend handoff. Exercise
command, file, permission, and user-input resolution—including cancel,
decline, session acceptance when advertised, automatic resolution, and expiry.
Rollback by restoring `CODEX_MCP_BRIDGE_DEFAULT_BACKEND=mcp-server` and
restarting. The setting applies only to new threads; existing App Server
threads stay pinned and are neither converted nor deleted.

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

The live canary consumes authenticated model capacity and is therefore a
manual release gate, not an ordinary fixture CI step. Attach the dated canary
record and the accountable operator's explicit experimental-risk acceptance to
the release or epic before changing the default backend. Schema compatibility,
fixture recovery tests, or a maintainer's code review do not substitute for
those two records.

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
- the supported architecture matrix and any bundled native artifacts are
  recorded (the initial target is Apple Silicon only);
- the quarantined-download first-launch path is tested on a clean Mac, including
  the per-app approval in **System Settings > Privacy & Security**; the
  documentation never asks users to disable Gatekeeper globally;
- installer/update rollback behavior is documented and tested; transactional
  LaunchAgent replacement remains covered by the automated suite.
- installer removal unloads and removes the per-user helper LaunchAgent without
  deleting the private dotenv, SQLite state, project registry, or Codex login;
- the release records whether the menu-bar UI itself opens at login separately
  from the helper's existing `RunAtLoad` server behavior.

The current `macos/build-app.sh` output is host-architecture and ad-hoc signed.
`macos/package-release.sh` is the separate public packaging boundary: it checks
the manifest version, minimum macOS version, exact arm64 architecture, app
signature, and DMG container, then emits a filename containing
`unnotarized`. It deliberately needs no Apple developer account, certificate,
App Store Connect key, or GitHub signing secret. Because Apple does not trust or
notarize this artifact, downloaded copies can require the user's explicit
per-app approval before first launch.

The initial distribution manifest intentionally supports Apple Silicon only.
Intel or universal packaging requires an explicit manifest change and a native
dependency/test matrix; it is not inferred from architecture-neutral Swift
source.

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
- `~/.codex-mcp-bridge` and its SQLite/legacy state files;
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
Use `npm run release:next-rc` after any candidate payload change and
`npm run release:promote` only after the final candidate passes every gate.
The promotion preserves the numeric version, records the source RC, and removes
the RC suffix. See [release-governance.md](release-governance.md) for the full
lifecycle and validation ladder.

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

Only a manual run on a matching `release/X.Y.Z` branch or an explicit push to
`main` starts `.github/workflows/ci.yml`; development pushes, release-branch
pushes, and pull requests run no Actions. The manual path accepts only an RC and
the `main` path accepts only a source-RC-backed stable promotion. The workflow:

1. runs the full Node.js server checks and production dependency audit;
2. builds the canonical npm tarball and its checksum;
3. builds the macOS app on an arm64 runner, ad-hoc signs the app and DMG, and
   verifies the version, minimum OS, architecture, signatures, and container;
4. assembles exactly those npm assets and the macOS DMG, rejecting undeclared
   files and writing deterministic aggregate checksums;
5. compares unpacked npm and macOS payloads with the named source RC before a
   stable publication, allowing only enumerated release/build/signature metadata;
6. refuses a repository mismatch or conflicting tag and skips an already
   published release rather than replacing it;
7. publishes all four assets together and marks only candidate-stage runs as
   GitHub prereleases.

The macOS job has no Apple signing or notarization secrets. Its public asset is
intentionally named
`Codex-MCP-Bridge-for-ChatGPT-<version>-macOS-arm64-unnotarized.dmg`, and the
release notes must repeat that limitation and the safe first-launch approval
path. A future move to Developer ID or notarization is a separate product and
account decision; the workflow must not silently change the trust model.

Development pushes stay on `dev` and do not start this workflow at all.
Never merge, fast-forward, cherry-pick, or push development work to `main`
unless the user explicitly instructs that specific promotion. Before that
promotion, prepare the planned unused RC and complete both physical
release-candidate smoke gates, including the clean-Mac Gatekeeper path.
