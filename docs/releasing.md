# Release manifest and main-branch release flow

`package.json` is the source of truth for the bridge/runtime and release
SemVer. `release-manifest.json` is authoritative for the remaining release
identity and policy, and its `release.version` is a synchronized mirror.
`npm run release:sync` copies the package version into the manifest;
`npm run release:check` rejects a mismatch. Its shape is fixed by
`release-manifest.schema.json` and validated again by the built-in-only
`scripts/release-manifest.mjs` command, so release checks do not depend on a
globally installed schema utility.

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
- the synchronized SemVer mirror, tag prefix, stable/prerelease channel, and release title;
- generated release-note policy and the v1 npm tarball/checksum asset contract.

## Skills distribution

Repository `skills/` is the source of truth. GitHub Release publishes
`codex-mcp-bridge-skills-<bridgeVersion>.zip` as the install/deployment
artifact, while the npm package is runtime-only and deliberately excludes
`skills/`.

For manifestVersion 1 compatibility, `release.assets` remains exactly
`["npm-tarball", "sha256"]`. The workflow derives the skills ZIP name from the
synchronized package version and uploads it as an additional release asset;
the v1 manifest contract is not widened.

Build an installable ZIP explicitly (the output file is intentionally chosen by
the caller):

```bash
npm run skills:package -- --output /tmp/codex-mcp-bridge-skills-0.3.0.zip
```

The archive has one predictable root directory and contains
`codex-mcp-bridge-skills-<bridgeVersion>/manifest.json` plus every source file
under `skills/`. The manifest records `bridgeVersion` from `package.json` and,
for each skill, its frontmatter `name`, the same release-derived SemVer as
`skillVersion`, and `skills/<name>/SKILL.md` path. Source skills omit a custom
frontmatter version: `npm run release:version` changes the package/release
version, and the skills packager applies that version automatically. Unreleased
skill edits therefore do not consume versions or require version-only changes.

`npm run skills:check` builds and inspects the archive in a temporary directory,
checks manifest paths and frontmatter, compares every ZIP entry with source,
and runs `npm pack --dry-run --json` to prove `skills/` is absent from the npm
tarball. ZIP file order, permissions, compression settings, and timestamp
(1980-01-01) are fixed for reproducible output from identical inputs. This check
is intentionally independent of `npm run release:check` and `npm run build`;
the GitHub release asset step invokes the skills packager explicitly.

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
generation 7–11 assets continue to resolve and refresh through app-only tools.
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
manifest. Main CI installs the exact manifest version and regenerates both
schema formats before build/test, so ordinary unit tests remain offline and
fixture-driven.

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

### Legacy runtime namespace

The following compatibility identifiers deliberately retain the bare
`codex-mcp-bridge` namespace and are not current product, repository, or npm
package names:

- the installed executable;
- the `CODEX_MCP_BRIDGE_*` environment prefix;
- the private `~/.config/codex-mcp-bridge/.env` runtime configuration path;
- `~/.codex-mcp-bridge` and its SQLite/legacy state files;
- the default tunnel profile;
- MCP App resource URIs and the conversation-scope HMAC namespace.

Renaming those values requires a separate credential, state, service, and UI
resource migration. A repository or package rename must not silently perform
that migration.

## Change a version

Run this on `dev`:

```bash
npm run release:version -- patch
npm run release:check
npm run check
```

`major`, `minor`, and exact SemVer values are also accepted:

```bash
npm run release:version -- 0.4.0-beta.1
```

The command changes `package.json` first, then synchronizes the manifest,
`package-lock.json`, `.codex-plugin/plugin.json`, and `.app.json` in one
operation. An exact prerelease version automatically sets the prerelease
channel; a normal version sets the stable channel.

If another manifest field is intentionally edited, run:

```bash
npm run release:sync
npm run release:check
```

Do not use `npm version` directly. `npm run build` and the main workflow reject
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

The bridge cannot force ChatGPT to replace a tool list already cached by a
conversation. If rediscovery is unavailable or retains the former descriptor,
record that limitation and use a new conversation. See
[`docs/chatgpt-setup.md`](chatgpt-setup.md) for the full checklist.

## GitHub workflow contract

Only a push to `main` starts `.github/workflows/ci.yml`. The workflow:

1. installs locked dependencies and the manifest-pinned Codex CLI, checks both
   App Server schema fingerprints, then runs the build, full test suite, and
   production dependency audit;
2. derives repository, tag, title, channel, and asset names from synchronized metadata;
3. refuses to release when the manifest repository differs from
   `GITHUB_REPOSITORY`;
4. skips an already published tag instead of replacing the release;
5. verifies npm produced the exact metadata-derived archive name and creates a
   deterministic skills ZIP from repository `skills/`;
6. creates that GitHub Release with the npm archive, its SHA-256 checksum, and
   `codex-mcp-bridge-skills-<bridgeVersion>.zip`.

Development pushes stay on `dev`. Never merge, fast-forward, cherry-pick, or
push development work to `main` unless the user explicitly instructs that
specific promotion. When instructed, first confirm that the manifest version
and release policy are ready to publish.
