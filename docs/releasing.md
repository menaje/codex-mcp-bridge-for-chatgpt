# Release manifest and main-branch release flow

`release-manifest.json` is the only file that should be edited to change public
product or release identity. Its shape is fixed by
`release-manifest.schema.json` and validated again by the built-in-only
`scripts/release-manifest.mjs` command, so release checks do not depend on a
globally installed schema utility.

## Canonical fields

The manifest controls:

- public display name and description;
- npm package name, retained executable name, and packaged file list;
- Node and npm versions used by local package metadata and GitHub Actions;
- GitHub owner and repository name;
- SemVer version, tag prefix, stable/prerelease channel, and release title;
- generated release-note policy and the required npm tarball/checksum assets.

The following runtime compatibility identifiers deliberately remain
`codex-mcp-bridge` and are not release-name fields:

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

The command changes the manifest and synchronizes `package.json` and
`package-lock.json` in one operation. An exact prerelease version automatically
sets the prerelease channel; a normal version sets the stable channel.

If another manifest field is intentionally edited, run:

```bash
npm run release:sync
npm run release:check
```

Do not use `npm version` directly. `npm run build` and the main workflow reject
derived npm metadata that has drifted from the manifest.

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

Development pushes stay on `dev`. Merge `dev` into `main` only when the
manifest version and release policy are ready to publish.
