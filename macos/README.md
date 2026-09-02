# Native macOS menu bar app

This directory contains the SwiftUI/AppKit companion for issue #44. It does not
embed the existing cards in a WebView. The Dashboard popover and Settings window
decode the same application-service snapshots used by the retained MCP cards.

## Development

Requirements:

- macOS 13 or later
- Swift 5.9 or later
- Node.js 22 or later
- an installed and authenticated Codex CLI
- `tunnel-client` available in `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, or `PATH`

```bash
npm run build
swift test --package-path macos
swift run --package-path macos CodexBridgeMenuBar
```

When run from the repository, the app starts the helper directly from the local
`dist` tree. A packaged app installs a per-user LaunchAgent that keeps the helper
alive when the menu bar UI exits. The helper owns the existing bridge launcher,
the persistent-stdio Secure MCP Tunnel profile, crash backoff, and the versioned
private Unix sockets.
It uses the dedicated `codex-mcp-bridge-macos` Tunnel profile and one canonical
per-user launcher lock. A restarted helper can safely adopt a still-healthy
app-managed runtime instead of duplicating it.

The everyday Settings window contains only the same General and Projects scope
as the retained Settings card. Connection credentials, Codex login, and Tunnel
repair stay in a separate first-run/repair surface.

## Local data and credentials

- Runtime dotenv: `~/.config/codex-mcp-bridge/.env`
- Optional override: `CODEX_MCP_BRIDGE_ENV_FILE`
- Helper socket: `~/.config/codex-mcp-bridge/run/helper.sock`
- Bridge snapshot socket: `~/.config/codex-mcp-bridge/run/bridge.sock`
- Existing bridge SQLite state remains unchanged and is never read by Swift.

The setup UI writes only `CONTROL_PLANE_API_KEY` and
`CONTROL_PLANE_TUNNEL_ID`. Existing comments, ordering, and unknown dotenv keys
are retained. The directory and file are validated as current-user-owned
`0700`/`0600` non-symlinks and replacement is atomic. Apply drains the old
runtime before commit and restores the old dotenv/runtime if new readiness
fails. Concurrent edits detected before replacement are not overwritten. A runtime dotenv inside a
registered project is rejected. The API key is never
stored in UserDefaults, a plist, Keychain, command arguments, logs, or the
pasteboard.
An existing regular current-user-owned dotenv with only overly broad
permissions can be restricted to `0700/0600` from the repair UI without
rewriting its contents. Group/world-writable paths are rejected from automatic
repair and must be inspected first.

Codex authentication remains the existing `codex login` cache. The app checks
`codex login status` and can start the browser login flow; it does not copy or
alter `~/.codex` credentials. Explicit API-key backend selection remains out of
scope until issue #29 defines that contract. App-managed Codex children do not
inherit `OPENAI_API_KEY` or `CODEX_API_KEY` merely because an older dotenv or
parent process contains one.
The menu status cannot report healthy while login is missing, and login status
continues to refresh after the browser flow starts.

## Build an app bundle

```bash
./macos/build-app.sh
open "macos/build/Codex MCP Bridge for ChatGPT.app"
```

The current build is an ad-hoc-signed development artifact for the host
architecture. Node.js, Codex CLI, and `tunnel-client` remain managed external
prerequisites. A release must still choose and validate the universal/runtime
bundling boundary, Developer ID signing, notarization, and updater policy before
distribution. The source is architecture-neutral, but this branch records only
Apple Silicon build verification; Intel packaging remains a release gate.
