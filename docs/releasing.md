# Release manifest and main-branch release flow

`release-manifest.json` is the only file that should be edited to change public
product or release identity. Its shape is fixed by
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
- GitHub owner and repository name;
- personal/local plugin identity, descriptions, developer, category,
  capabilities, starter prompts, and registered ChatGPT app connection;
- immutable Settings and Activity UI cache-key policy, hash algorithm and
  prefix length, retained-generation count, and required logical resources;
- SemVer version, tag prefix, stable/prerelease channel, and release title;
- generated release-note policy and the required npm tarball/checksum assets.

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

The server registers both the current URI and the configured retained previous
generation. This lets a ChatGPT descriptor cached during rollout resolve while
the new descriptor is being refreshed. The resource descriptor,
`_meta.ui.resourceUri`, and compatibility `openai/outputTemplate` must all name
the same current URI.

`npm run release:check` reproduces the render and fails on content, digest,
metadata, snapshot, missing-resource, duplicate-URI, descriptor, or output
template drift. Do not edit generated manifests or snapshots by hand. A SemVer
change with identical cards preserves the URIs; a card or relevant metadata
change produces new URIs even before the next version bump.

### Legacy runtime namespace

The following compatibility identifiers deliberately retain the bare
`codex-mcp-bridge` namespace and are not current product, repository, or npm
package names:

- the installed executable;
- the `CODEX_MCP_BRIDGE_*` environment prefix;
- `~/.codex-mcp-bridge` and its SQLite/legacy state files;
- macOS Keychain service names and the default tunnel profile;
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

The command changes the manifest and synchronizes `package.json`,
`package-lock.json`, `.codex-plugin/plugin.json`, and `.app.json` in one
operation. An exact prerelease version automatically sets the prerelease
channel; a normal version sets the stable channel.

If another manifest field is intentionally edited, run:

```bash
npm run release:sync
npm run release:check
```

Do not use `npm version` directly. `npm run build` and the main workflow reject
derived npm metadata that has drifted from the manifest.

## ChatGPT rollout and smoke test

For a UI or tool-contract change, use this order:

1. run `npm run release:sync`, `npm run release:check`, and `npm run check`;
2. deploy or restart the bridge so it serves current and retained UI URIs;
3. open the plugin detail in ChatGPT Developer mode and select **Refresh**;
4. verify the registered `codex_settings` output template equals the current
   Settings URI in `dist/ui-manifest.json`;
5. test Settings open, save, model-list refresh, and default restore in a new
   conversation, then check an existing conversation for cached metadata.

The bridge cannot force ChatGPT to replace a tool list already cached by a
conversation. If rediscovery is unavailable or retains the former descriptor,
record that limitation and use a new conversation. See
[`docs/chatgpt-setup.md`](chatgpt-setup.md) for the full checklist.

## GitHub workflow contract

Only a push to `main` starts `.github/workflows/ci.yml`. The workflow:

1. installs locked dependencies and runs the build, full test suite, and
   production dependency audit;
2. derives repository, tag, title, channel, and asset names from the manifest;
3. refuses to release when the manifest repository differs from
   `GITHUB_REPOSITORY`;
4. skips an already published tag instead of replacing the release;
5. verifies npm produced the exact manifest-derived archive name;
6. creates that GitHub Release with the archive and its SHA-256 checksum.

Development pushes stay on `dev`. Never merge, fast-forward, cherry-pick, or
push development work to `main` unless the user explicitly instructs that
specific promotion. When instructed, first confirm that the manifest version
and release policy are ready to publish.
