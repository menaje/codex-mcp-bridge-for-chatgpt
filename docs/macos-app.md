# Native macOS menu bar app

The issue #44 implementation is a native SwiftUI/AppKit companion for Codex MCP
Bridge for ChatGPT. It intentionally does not embed the Settings or Dashboard
cards in a WebView. The existing ChatGPT cards and MCP tools remain the primary
remote interface and keep their current descriptors, schemas, resource URIs,
and cache contracts.

## Architecture

```text
MenuBarExtra and native Settings window
  -> versioned private helper socket
     -> per-user background helper
        -> existing secure persistent-stdio launcher
           -> tunnel-client
              -> existing TypeScript MCP bridge
                 -> versioned private companion socket
                    -> shared Dashboard/Settings application service
```

Swift never reads or writes the bridge SQLite database. The Settings card and
native Settings window both use the same revisioned service, including separate
`settingsRevision` and `registryRevision` compare-and-swap checks. Project
changes remain explicit add, rename, relocate, archive, restore, and delete
operations. The Dashboard remains read-only.

The native Dashboard uses the same progressive application-service contract as
the ChatGPT card. It publishes an `enrich: false` structural snapshot first,
then replaces or merges that page with a bounded `enrich: true` result in a
separate task. Structural RPC has a two-second client ceiling; enrichment has a
five-second transport ceiling while the bridge itself bounds runtime work to
1.2 seconds and usage to 800 ms. Refresh and pagination cancel stale
enrichment generations, and an enrichment failure leaves the structural view
visible. Swift does not issue App Server runtime probes itself.

The normal native UI is intentionally limited to that Dashboard and the
Settings card's General and Projects content. Tunnel setup, Codex browser login,
and profile repair appear in a separate first-run/connection-repair window
instead of becoming additional everyday Settings tabs.

The helper owns the app-managed bridge and tunnel process tree. Closing the
popover, Settings window, or menu bar UI leaves its LaunchAgent and runtime
running. Graceful stop/restart first blocks new Job admission, waits for active
Jobs and pending admissions, and then verifies every current retained App
Server Agent thread for background processes. It refuses to stop when a background
process exists or that impact cannot be confirmed. Force actions refresh and
show the active/background impact immediately before confirmation; they never
replay work or roll back filesystem changes. A process lock rejects a second launcher, and
unexpected exits use bounded exponential backoff before safe mode.
The lock stays in one canonical per-user namespace even when a CLI selects an
alternate dotenv. If the helper crashes while its detached runtime remains
healthy, the replacement helper adopts it only when the private lock owner,
fresh launcher status, companion protocol, and exact build identity all agree.
Otherwise it fails closed instead of starting a second process tree.
For an alternate dotenv, the helper also checks the previous env-adjacent lock
location so an already-running older CLI launcher is stopped explicitly before
the app can take ownership. New launchers hold both namespaces for that
migration case, closing the concurrent-start race with older launchers.
The helper accepts launcher readiness only when both the private bridge socket
and the Tunnel's control-plane readiness probe are current. Status from another
launcher PID, an older runtime build, an expired heartbeat, or a future-dated
record is treated as unavailable.

## First run and connection repair

The helper first inspects the existing runtime configuration. A valid file is
reused without rewriting it or asking for a key. If it is missing or invalid,
the native connection sheet accepts:

- the Secure MCP Tunnel runtime API key; and
- the Tunnel identifier (`tunnel_` followed by 32 lowercase letters or digits).

The only canonical default is:

```text
~/.config/codex-mcp-bridge/.env
```

`CODEX_MCP_BRIDGE_ENV_FILE` remains an explicit compatibility override. The
app-owned editor changes only `CONTROL_PLANE_API_KEY` and
`CONTROL_PLANE_TUNNEL_ID`, preserves every other entry and comment, and keeps
the existing value when a field is blank. The config directory and file must
be current-user-owned regular non-symlinks with `0700` and `0600` permissions.
Replacement is same-directory, validated, synced, and atomic.
If only those permissions are too broad, the repair sheet can restrict the
existing current-user-owned regular directory and file in place. It can also
repair an over-readable pre-existing configuration directory before the first
dotenv is created. It never follows a symlink or changes dotenv contents.
Automatic repair is limited to over-readable paths; group/world-writable paths
are rejected so an operator can inspect them before changing permissions
manually.

Configuration apply is one serialized operation: prepare the complete dotenv,
block new work, drain or explicitly force-stop the old runtime, atomically
commit, and require the new bridge and Tunnel to become ready. A failed new
startup restores the prior dotenv and runtime. A concurrent dotenv edit
detected before replacement aborts the commit without overwriting that edit and
restarts the unchanged runtime.
The helper and project-registry mutation path also reject any dotenv located
inside a registered project, including paths reached through symlinks.

The app uses the dedicated `codex-mcp-bridge-macos` Tunnel profile so a legacy
CLI profile is never overwritten during migration. An existing app-managed
profile is reused only when its Tunnel ID, transport, bridge command, runtime
build, Node executable, tunnel-client version, and recorded file digest all
match. Otherwise it is rebuilt before use. A separate
**Tunnel profile repair** action forces that rebuild after active work drains.
It does not change SQLite, projects, Settings, Codex authentication, or the
dotenv.

The app checks `codex login status` and starts `codex login` only after the user
selects the browser-login action. It does not inspect, copy, replace, delete, or
log out the shared Codex credential cache. In particular, missing ChatGPT login
never causes an API-key fallback. Explicit execution API-key selection remains
deferred to issue #29. In app-managed mode, `OPENAI_API_KEY` and `CODEX_API_KEY`
from an older dotenv or ambient process are not inherited by Codex children;
the existing CLI/dotenv launcher behavior outside app-managed mode remains
compatible.
Login state is polled independently from bridge health. A running bridge with a
missing or expired Codex login is shown as needing attention, never as healthy,
and the browser flow remains pending until a later check confirms authentication.
The app itself does not call Keychain for Tunnel credentials. `codex login
status` still follows the user's existing Codex credential-store configuration,
so any operating-system prompt caused by that external configuration belongs in
the physical release test rather than being claimed away by the Tunnel dotenv
contract.

After the tunnel is running, ChatGPT setup remains unchanged: enable Developer
mode, select the matching Secure MCP Tunnel, and connect it with `No Auth`.
Register the first project in either native Settings or the retained Settings
card.

## Local files and interfaces

- dotenv: `~/.config/codex-mcp-bridge/.env`
- helper socket: `~/.config/codex-mcp-bridge/run/helper.sock`
- bridge companion socket: `~/.config/codex-mcp-bridge/run/bridge.sock`
- launcher ownership lock: `~/.config/codex-mcp-bridge/run/launcher.lock`
- app Tunnel profile: `codex-mcp-bridge-macos`
- LaunchAgent label: `com.menaje.codex-mcp-bridge.helper`
- LaunchAgent plist: `~/Library/LaunchAgents/com.menaje.codex-mcp-bridge.helper.plist`

Both sockets live under a `0700` current-user directory and are created as
`0600`. The native client also verifies that the connected peer has the current
user's effective UID. They expose small allowlisted JSON-RPC contracts, not MCP
and not the old unauthenticated loopback HTTP control surface. Requests and responses are
bounded. Helper diagnostics retain at most 200 redacted lines.

The helper handshake is bound to the IPC protocol version and exact bundled
runtime build. Replacement of a reachable LaunchAgent drains its runtime before
the plist is changed, so a drain timeout leaves the installed helper and plist
in place for a later retry. If an incompatible helper cannot be reached while
its runtime lock still exists, automatic replacement fails closed instead of
interrupting an unobserved process tree.
LaunchAgent replacement is transactional: `bootout`, `bootstrap`, `kickstart`,
and new-helper readiness failures restore the previous plist and best-effort
restart the previous service. A fresh failed install removes its unusable plist. The
LaunchAgent also grants the helper 45 seconds to perform its bounded shutdown.

The Tunnel runtime key is not returned by status, written to UserDefaults or a
plist, passed in argv, copied to the pasteboard, or stored in helper logs. The
Tunnel ID is treated as a non-secret connection identifier and may be copied
for ChatGPT setup. No Keychain API is used for tunnel credentials.

Native Settings preserves the retained card's catalog-drift behavior. Saved
model/effort choices that are no longer selectable remain visible and labelled,
while an unrelated general-setting save omits an untouched model policy instead
of silently dropping or revalidating it. Automatic policy configures only the
allowed range; it stores no preferred/default/fallback pair, so new work must
supply one exact model and effort while continue/fork omission inherits the
retained thread. Loading, mutation, Dashboard,
authentication, runtime, and diagnostic failures keep independent UI state so
one successful poll cannot hide another failed action.
While the Settings window is open it refreshes the shared snapshot every ten
seconds. A newer card-side revision replaces an untouched form, but never
overwrites a locally edited draft. Conflicts retain the draft for review or
copying and require an explicit, confirmed reload before another save.

Runtime/Node discovery starts off the main actor so a slow or broken executable
cannot freeze the menu bar UI. Duplicate candidates are ignored and a candidate
that ignores normal termination is killed after the bounded probe timeout.

## Build and verification

Requirements are macOS 13+, Swift 5.9+, Node.js 22+, an installed authenticated
Codex CLI, and `tunnel-client` in a supported executable path.

```bash
npm run check
npm run macos:check
npm run test:progressive-browser
npm run macos:bundle
open "macos/build/Codex MCP Bridge for ChatGPT.app"
```

An opt-in cross-language contract smoke can decode a running bridge companion
with the production Swift client:

```bash
CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET=/private/path/bridge.sock \
  swift test --package-path macos --filter LiveCompanionTests
```

Repository development launches the helper directly. The built app installs a
per-user LaunchAgent and bundles the compiled TypeScript runtime plus production
Node dependencies. Node.js, Codex CLI, and `tunnel-client` currently remain
external prerequisites.

`macos/build-app.sh` produces a host-architecture, ad-hoc-signed development
bundle. Swift tests and release compilation run with strict concurrency and
warnings-as-errors. Before distributing it, complete the Developer
ID/notarization/installer-update rollback design, choose the
Node/Codex/tunnel-client bundling boundary,
verify Apple Silicon and Intel support, and run the physical accessibility,
appearance, sleep/wake, network-recovery, and helper-crash matrix listed in
[releasing.md](releasing.md).
