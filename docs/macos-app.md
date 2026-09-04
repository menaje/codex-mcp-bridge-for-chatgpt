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
ten-second transport ceiling while the bridge itself bounds runtime work to
six seconds and usage to 1.5 seconds. Matching last-known usage and runtime
evidence is included in later structural snapshots without an upstream call,
so polling does not temporarily clear process counts or reorder their rows.
Refresh and pagination cancel stale
enrichment generations, and an enrichment failure leaves the structural view
visible. Swift does not issue App Server runtime probes itself.

The native popover and both retained ChatGPT cards use the same presentation
rules. Active, recent, and idle sections are Activity-first with one or more
Agents nested below; an idle heading is explicitly the Agent's latest Activity,
not a current assignment. Project/conversation context appears once on the
Activity. Agent state, background processes, work time, and the latest actual
model/reasoning effort remain on every Agent even when sibling values match;
different next-run settings remain separately labelled per Agent. Active work
shows only accumulated work time; past work adds relative age and omits absolute
start, update, and end timestamps. The native UI never prints the private
compatibility session alias. Active and recent sections start open; idle starts
collapsed. A native Agent's retained-history label and chevron share one
full-width click target, and expanded history remains left-aligned with the rest
of the row. Same-Activity history omits the already visible Activity title;
distinct same-title Activities retain a neutral previous-Activity boundary, and
every historical turn keeps its own model/reasoning line or an unavailable label.

The normal native UI is intentionally limited to that Dashboard and the
Settings card's General and Projects content plus a small Server tab for the
backend and maximum access. General changes save automatically; the Server tab
keeps an explicit apply-and-restart confirmation because those values are stored
in the private dotenv and require runtime replacement. Tunnel setup, Codex
browser login, and profile repair appear in a separate first-run/connection-
repair window instead of becoming additional everyday Settings tabs.

The General tab also contains one native-only **Mac app** control for launching
the menu-bar UI at user login. It uses `SMAppService.mainApp` and reads the
system registration or approval state directly. It is not part of the shared
Settings revision, is not written to dotenv or UserDefaults, and does not change
the helper's background lifecycle. A system-denied item is shown as requiring
approval with an explicit path to the Login Items pane instead of being reported
as enabled. The app does not register itself silently; each Mac user enables the
login item explicitly from native Settings.

The helper owns the app-managed bridge and tunnel process tree. Closing the
popover or Settings window leaves its LaunchAgent and runtime running. The
explicit **Quit App** action is different: it stops the managed runtime, verifies
and removes captured descendant process groups, boots the helper LaunchAgent out
of the current login session, and only then terminates the menu bar app. Its plist
is preserved so reopening the app or starting the next user login can bootstrap
the helper again. A browser-login process started by the helper is tracked and its
process tree is also stopped during helper shutdown. Pending native Settings edits
must finish saving before quit; a save failure leaves the app open and reports the
problem instead of discarding the edit. Graceful quit/stop/restart first blocks new Job admission, waits
for active Jobs and pending admissions, and then verifies every current retained
App Server Agent thread for background processes. It refuses to stop when a background
process exists or that impact cannot be confirmed. **Quit App** refreshes that
impact first and starts graceful shutdown immediately when no work or background
process can be affected. It offers graceful and force choices only when work may
be interrupted or the impact cannot be confirmed. Force actions never replay
work or roll back filesystem changes. A process lock rejects a second launcher, and
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
seconds. General edits are coalesced for 450 ms and serialized with exact
settings-revision checks. A successful save rebases any newer local edits onto
the returned revision. A newer card-side revision replaces an untouched form,
but never overwrites a locally edited draft; a genuine conflict pauses autosave
and requires an explicit, confirmed reload. Language selection updates the
native locale immediately and the persisted preference continues to localize
the retained cards. English, Korean, Japanese, Simplified and Traditional
Chinese, Spanish, French, German, and Portuguese share one explicit preference.
Automatic follows the language of the host displaying each surface, while an
explicit selection keeps the app and cards on the same language. The user
concurrency preference defaults to 30 and accepts
direct numeric input up to the operator ceiling, which defaults to 100.

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

The helper LaunchAgent and the menu-bar login item are deliberately independent.
Disabling **Open menu-bar app at login** prevents only future UI launches; the
helper continues its existing `RunAtLoad` server behavior so ChatGPT connectivity
does not depend on the menu-bar process remaining open.

`macos/build-app.sh` produces an ad-hoc-signed development bundle by default;
Swift tests and release compilation run with strict concurrency and
warnings-as-errors. `macos/package-release.sh` is the publication boundary. It
verifies the manifest version/minimum OS/arm64 architecture, ad-hoc signs the
app and DMG, and requires the exact `unnotarized` filename. No Apple developer
account or signing/notarization secret is required. Since macOS cannot establish
an Apple trust chain for this artifact, a quarantined download may require
one-time approval for this app in **System Settings > Privacy & Security**; the
user must never be instructed to disable Gatekeeper globally.

Do not overwrite or replace the app bundle while it is running. Use **Quit
App** first and verify that the menu-bar app, helper, bridge, and tunnel have
stopped before copying a new bundle into place, then launch the replacement.
This keeps the helper's in-memory build identity aligned with the bundled
runtime it supervises.

The initial release manifest supports macOS 13+ on Apple Silicon only. Node.js,
Codex CLI, and `tunnel-client` remain explicit external prerequisites. Intel or
universal support and an automatic updater are outside the initial release
scope. Manual app replacement/rollback and the physical accessibility,
appearance, sleep/wake, network-recovery, and helper-crash matrix remain gates
listed in [releasing.md](releasing.md).
