# Native macOS remote client mode

The native macOS app has two roles:

- **Run a server on this Mac** owns the local helper, Bridge, Secure MCP Tunnel,
  Codex runtime, and browser-login flow.
- **Connect to an existing server** is a client only. It does not install, start,
  stop, repair, or inspect any of those local services.

Remote mode retains multiple paired server profiles for convenient switching,
but exactly one server is active. The Dashboard polls only that active server.
Switching profiles first finishes any pending Settings save, clears the old
snapshot, and binds subsequent reads and writes to the new server. Responses
that complete late from the prior profile are discarded.

## What settings mean

The active profile is the target for every setting shared with the ChatGPT
Settings card. General changes and project add, rename, relocate, archive,
restore, and delete operations therefore mutate the selected server's state.
An absolute project path entered by a remote client is a path on that server;
the server performs its normal validation and never treats it as a client-Mac
path.

The local runtime Server tab is hidden in client mode because backend selection,
maximum local access, Bridge replacement, Tunnel repair, and Codex login belong
to the Mac that owns the process tree. The **open the menu-bar app at login**
preference remains visible and affects only the client Mac. Quitting a remote
client cancels its polling and closes its windows; it never stops the selected
server.

## Pair a client

On the server Mac:

1. Keep the managed Bridge running and open **Settings > Connection**.
2. Turn on connections from other Macs. The app automatically uses this Mac's
   current name and local HTTPS address. Open **Advanced Connection Settings**
   only when clients must use a different private DNS name or VPN address.
3. Allow that TCP port only on a trusted private LAN or private VPN.
4. Click **Create and copy a new pairing invitation**. This is the only value
   that needs to be transferred to the client. It expires after five minutes
   and can be used once.

On the client Mac:

1. While still running in local-server mode, open **Settings > Connection** and
   click **Connect to an existing server**.
2. Paste the invitation, name the client device, and optionally name the saved
   profile. The invitation carries the endpoint, server identity, and pinned
   certificate information together; the address and server ID are never copied
   separately.
3. Click **Verify and Register Server**. The app completes pairing and saves the
   credential before it asks to stop this Mac's local server and switch roles.
   Cancelling that final confirmation leaves the local server running and keeps
   the paired server available for a later switch.

When the app is already in client mode, use **Pair New Server** to register
another server. Exactly one saved server remains active at a time; use
**Switch** or the menu-bar server picker to change it.

The client does not browse the network for servers. It uses the endpoint
embedded in the invitation. The server's automatic local-address suggestion
does not configure a router, public DNS, port forwarding, firewall rules, or a
VPN, so that endpoint must remain reachable from the client.

## Security boundary

Enabling remote management creates a persistent random server UUID and a
self-signed TLS identity. The invitation contains the exact certificate SHA-256
fingerprint and server UUID. The client accepts the self-signed certificate only
when the leaf certificate matches that fingerprint, sends the expected UUID on
every authenticated request, and rejects certificate or server replacement.

The pairing code is high entropy, short-lived, one-use, and invalidated after
five failed attempts. A successful pairing returns a distinct 256-bit device
credential once. The client stores it with the macOS Keychain's
`AfterFirstUnlockThisDeviceOnly` protection; UserDefaults stores only the server
profile. The server persists only the credential's SHA-256 verifier and exposes
each device separately for revocation. Tunnel credentials are unrelated and are
never sent through this protocol.

The remote allowlist contains Dashboard read, shared Settings read/write, and a
read-only runtime snapshot. It excludes remote-management configuration,
pairing creation, device revocation, runtime start/stop, login, Tunnel repair,
filesystem browsing, arbitrary MCP calls, and generic command execution.
Requests and responses are bounded, TLS 1.2 or later is required, and at most 32
devices may be registered.

Use this feature only across a network whose routing and endpoint ownership you
control. Certificate pinning authenticates the paired server even when private
DNS is used, but it does not make an intentionally exposed TCP port private or
provide denial-of-service protection.

## Server files and lifecycle

Remote management is currently hosted by the app-managed persistent-stdio
Bridge. The server endpoint is therefore available only while that Bridge is
running. Closing the server Mac's popover or Settings window leaves it running;
using **Quit App** on the server Mac stops it. The client app cannot restart a
stopped server.

By default the remote state is stored beside the Bridge state database:

```text
~/.codex-mcp-bridge/remote-management.json
~/.codex-mcp-bridge/remote-companion-cert.pem
~/.codex-mcp-bridge/remote-companion-key.pem
```

The directory must be owned by the current user with mode `0700`; all three
files must be regular, current-user-owned `0600` files. The state path can be
overridden for an operator-managed launch with
`CODEX_MCP_BRIDGE_REMOTE_STATE_FILE`; the certificate and key remain beside it.
Deleting or replacing the TLS identity changes the fingerprint and requires
every client to pair again. Revoke a lost client from the server's Connection
tab; deleting only the profile on that client does not revoke other devices.

## Verification

The normal Swift suite validates profile isolation, secret-free preferences,
server identity checks, and stale-response rejection:

```bash
npm run macos:check
```

An opt-in interoperability test accepts a fresh server invitation and exercises
real pinned HTTPS pairing plus an authenticated hello using the production Swift
client:

```bash
CODEX_MCP_BRIDGE_LIVE_REMOTE_INVITATION='<fresh invitation>' \
  swift test --package-path macos \
    --filter RemoteConnectionTests/testLivePinnedPairingWhenRequested
```
