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
npm run macos:check
swift run --package-path macos CodexBridgeMenuBar
```

When run from the repository, the app starts the helper directly from the local
`dist` tree. A packaged app installs a per-user LaunchAgent that keeps the helper
alive when the popover or Settings window closes. Explicit **Quit App** stops the
runtime and boots that helper out for the current login session before the menu
bar process exits. It also stops an in-progress Codex browser-login process, and
the app remains open if pending Settings changes cannot be saved. The helper owns the existing bridge launcher,
the persistent-stdio Secure MCP Tunnel profile, crash backoff, and the versioned
private Unix sockets.
It uses the dedicated `codex-mcp-bridge-macos` Tunnel profile and one canonical
per-user launcher lock. A restarted helper can safely adopt a still-healthy
app-managed runtime instead of duplicating it.

The everyday Settings window contains General, Projects, and Server tabs backed
by the same application service as the retained Settings card. General changes
are debounced, serialized, and saved automatically; server backend and maximum
access remain an explicit apply-and-restart operation. Connection credentials,
Codex login, and Tunnel repair stay in a separate first-run/repair surface.
The General tab adds one native-only Mac control backed by
`SMAppService.mainApp`: whether the menu-bar UI opens at user login. Its state
comes from macOS, is not stored in `.env` or shared Settings, and does not stop
the background helper when disabled. Registration is opt-in from native
Settings rather than being enabled silently on first run.

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

Graceful stop and replacement wait for Jobs, then refuse to proceed if known
background processes remain or their state cannot be verified. Force actions
perform a fresh impact check and show active/background counts before the user
confirms. If LaunchAgent replacement fails after changing its plist, the prior
definition and service are restored.

The Settings window polls the shared revision while visible. Untouched values
follow changes from the retained Settings card; autosave preserves newer local
edits while one save is in flight, and a genuine external revision conflict
pauses autosave until an explicitly confirmed reload. The selected native UI
locale changes optimistically and is also sent to the Settings snapshot service.
Runtime discovery runs away from the menu-bar UI thread.

## Build an app bundle

```bash
./macos/build-app.sh
open "macos/build/Codex MCP Bridge for ChatGPT.app"
```

The current build is an ad-hoc-signed development artifact for the host
architecture. Node.js, Codex CLI, and `tunnel-client` remain managed external
prerequisites. Public packaging is a separate command and requires the exact
manifest-derived DMG filename:

```bash
npm run macos:package -- \
  --output release-assets/Codex-MCP-Bridge-for-ChatGPT-0.3.0-macOS-arm64-unnotarized.dmg
```

Public packaging intentionally uses ad-hoc signing and does not submit to Apple
notarization. It needs no Apple developer account, signing certificate, or
notarization secret. The packager validates the manifest version, minimum OS,
arm64 architecture, app signature, and DMG signature. The filename and release
notes state `unnotarized`; after downloading, a user may need to approve this
specific app in **System Settings > Privacy & Security**. Do not disable
Gatekeeper globally.

The initial manifest explicitly supports macOS 13+ on Apple Silicon. Intel and
universal packaging remain unsupported until a separate architecture/native
dependency matrix is implemented. Updater policy and the physical
accessibility, sleep/wake, and network-recovery checks remain release gates.
