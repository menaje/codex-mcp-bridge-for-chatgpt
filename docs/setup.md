# Setup and settings

This guide covers the user-facing setup for Codex MCP Bridge for ChatGPT. Choose the path that matches the computer that will actually run Codex.

The guide follows the current `dev` branch. For a downloaded release, use the
documentation at its Git tag; the same product version can have newer features
on the development branch. After connecting, try the [first task](../README.md#try-your-first-task)
and [first reusable skill](skills.md#create-and-use-your-first-skill).

Conversation connections have an independent six-hour idle grace controlled by `CODEX_MCP_BRIDGE_THREAD_IDLE_MS` (`0` disables automatic release). Job results retain their existing separate six-hour/100-Job policy. See [connection lifetime, app handoff and retention](thread-lifecycle.md) for protection rules, persistent/ephemeral choices and restart recovery.

Official background:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect an MCP app to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Choose a setup path

| Computer and role | Setup path |
| --- | --- |
| Apple Silicon or Intel Mac running Codex | [macOS server mode](#macos-server-mode) |
| Mac monitoring and configuring another server | [macOS client mode](#macos-client-mode) |
| Windows or Linux running Codex | [Node.js server](#nodejs-server-on-windows-or-linux) |
| Mac managed entirely from a terminal | [Node.js server](#nodejs-server-on-windows-or-linux) |

Only the server computer runs the Bridge, Secure MCP Tunnel, and Codex. A macOS client connects to one saved server at a time and does not start those services locally.

## What you need

For a server computer:

- [Node.js 22 or later](https://nodejs.org/en/download)
- [Codex CLI](https://learn.chatgpt.com/docs/cli) installed and authenticated
- [`tunnel-client` and an OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#set-up-tunnel-client)
- the Tunnel runtime API key and Tunnel ID
- at least one existing project folder for Codex work
- ChatGPT Developer mode and permission to add the connection

For a client-only Mac:

- macOS 13 or later
- the native Codex MCP Bridge for ChatGPT app
- network access to the server over a private LAN or private VPN
- a fresh one-time pairing invitation copied from the server

A client-only Mac does not need a local Node.js, Codex CLI, Tunnel runtime key, or Tunnel ID for remote operation.

## macOS server mode

### 1. Install the app

Download the architecture-specific DMG from [GitHub Releases](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/releases):

- `arm64`: Apple Silicon Macs
- `x64`: Intel Macs

Move the app to Applications before enabling launch at login. The current build is ad-hoc signed and not notarized. If macOS blocks the first launch, open **System Settings → Privacy & Security** and approve this app once.

### 2. Select the server role

Open the app and keep **Run Server on This Mac** selected in **Settings → Connection**. In this role, the app owns the per-user helper, Bridge, Secure MCP Tunnel, and Codex runtime.

Closing the popover or Settings window does not stop the server. Choosing **Quit App** stops the app-managed server after checking for active work.

<p align="center">
  <img src="images/macos-app-roles-light-en.png" alt="English macOS settings in light appearance showing the local server role and the option to connect to an existing server" width="720">
</p>

### 3. Connect the Secure MCP Tunnel

The first-run connection screen checks the default private configuration:

```text
~/.config/codex-mcp-bridge/.env
```

If an existing valid configuration is found, the app reuses it without displaying the secret. Otherwise:

1. Use **Create Runtime API key** and **Create Tunnel** to open the corresponding OpenAI Platform pages.
2. Enter the Tunnel runtime API key and Tunnel ID. The Tunnel ID starts with `tunnel_`.
3. You may paste text containing both values and let the app extract them.
4. Select **Save and Connect Safely**.

The app stores these values only in the private runtime file. It does not move them into the macOS Keychain. The file must remain outside every registered project folder.

### 4. Choose your Codex installation and account

The Tunnel credential and Codex login are separate:

- the Tunnel runtime key connects the Bridge to the Secure MCP Tunnel;
- `codex login` authorizes the Codex CLI that performs project work.

Open **Settings → Codex Account & Installation**. Select an existing Codex
installation or explicitly install a Bridge-managed CLI, then choose:

- **Use existing Codex login** to use the selected CLI's existing home and login;
- **Separate ChatGPT login for the bridge** to sign in through Codex in a persistent Bridge profile;
- **Use an API key for the bridge** to use a separate profile with explicit API billing confirmation.

Preparing a connection, completing login, verifying its account and models,
and requesting application are separate steps. A running server keeps its
current connection until an explicit safe restart can apply the pending choice.
The Bridge does not initiate a login in the shared Codex home. See
[authentication connections](codex-auth-connections.md) for existing profiles,
storage ownership, and pending changes.

<p align="center">
  <img src="images/macos-codex-account-light-en.png" alt="English Codex Account and Installation settings showing the selected CLI and authentication connection choices" width="820">
</p>

### 5. Register a project

Open **Settings → Projects**, select **Add Project**, and choose an existing folder. The app registers the folder but never moves or deletes it.

There is no implicit default project. ChatGPT must select an exact registered project for each new Activity or fresh Agent context. This prevents work from starting in an unintended folder.

### 6. Confirm readiness

The menu-bar status distinguishes normal startup from a failure:

- **Checking connection**: the helper or Tunnel is still becoming ready;
- **Ready/Connected**: the Bridge and Tunnel are available;
- an orange or red message: follow the displayed recovery action or open the diagnostic logs.

## Connect the server to ChatGPT

Once the server reports that the Bridge and Tunnel are connected:

1. Associate the Tunnel with your target ChatGPT workspace in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Enable Developer mode in **ChatGPT Settings → Security and login**, then create a developer connection at [ChatGPT Plugins](https://chatgpt.com/plugins).
3. Choose **Connection → Tunnel** and select or enter the Tunnel ID configured on the server.
4. Choose **No Auth**. The loopback Bridge and Secure MCP Tunnel provide the transport boundary.
5. Open the connection in a new ChatGPT conversation.
6. Ask ChatGPT to open **Codex MCP Bridge for ChatGPT settings** or **Codex Dashboard** to verify the connection.

Refresh the ChatGPT connection after installing a Bridge release that changes its tools or cards. A normal app, server, Tunnel, or computer restart with the same build does not require Refresh.

Tunnel creation requires **Read + Manage** permission; selecting or running a
Tunnel requires **Read + Use**. Workspace policy can also limit Developer mode.
Follow the [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
if the configured Tunnel does not appear.

The steps above describe the default No Auth connection. For opt-in MCP Events,
use the [OAuth HTTP configuration](mcp-events-authentication.md#configure-the-opt-in-adapter)
and an OAuth developer-mode connection with a separately configured public login
provider. The bridge JWT adapter is implemented, but this provider setup and
actual ChatGPT Events acceptance remain pending. The app has no provider setup
form; its existing Tunnel runtime key is separate from the user's OAuth login.

The Dashboard switches between **This conversation** and **All conversations**, with
running work, response requests and problems summarized in the selected scope.
Open Dashboard for scoped work monitoring and Settings for configuration. GPT
asks for ordinary user input directly in the current ChatGPT conversation and
delivers a valid answer to the exact Codex question.

<p align="center">
  <img src="images/chatgpt-dashboard-light-en.png" alt="English ChatGPT Dashboard showing conversation scope, weekly usage, current work, and run history" width="645">
</p>

## macOS client mode

Client mode lets a Mac view the Dashboard and change shared settings on a server Mac without running another Bridge, Tunnel, or Codex process locally.

### 1. Prepare the server Mac

On the Mac already running the server:

1. Open **Settings → Connection**.
2. Enable **Manage This Server from Another Mac**.
3. The app fills in the current Mac name and a local HTTPS address automatically.
4. Use **Advanced Connection Settings** only when a private DNS or VPN address is required.
5. Select **Create and copy a new pairing invitation valid for 5 minutes**.

The invitation is the only value to copy. Do not copy the server address, server ID, or certificate fingerprint separately. The invitation includes them together, expires after five minutes, and works once.

<p align="center">
  <img src="images/macos-pairing-invitation-light-en.png" alt="English macOS server setting in light appearance for creating and copying a five-minute one-time pairing invitation" width="720">
</p>

### 2. Pair the client Mac

On the client:

1. Open **Settings → Connection**.
2. Select **Connect to Existing Server**.
3. Paste the invitation.
4. Enter a name that lets the server owner recognize this client device.
5. Verify and register the server, then confirm the switch to client mode.

If the client Mac was previously running its own server, the app first finishes or explicitly stops its local work before changing roles.

### 3. Use and switch saved servers

The client can retain multiple paired server profiles, but exactly one is active. Select a saved server from Connection settings or the menu-bar server picker to switch.

After switching:

- Dashboard data comes only from the newly selected server;
- General and Projects settings change that server;
- project paths refer to folders on that server, not the client Mac;
- quitting the client app never stops the remote server.

To add another server, use **Pair New Server**. The new-pairing form is hidden during ordinary use and appears only when there is no saved server or when you explicitly choose to add one.

### 4. Network and revocation

The server address must be reachable from the client. The app does not configure routers, public DNS, port forwarding, firewalls, or VPNs. Use this feature only on a private LAN or private VPN you control.

The client pins the server certificate and server ID from the invitation. The client credential is stored in that Mac's protected credential store. If a client is lost or should no longer connect, revoke it from the server's **Connection → Registered Devices** section.

See [Remote client mode](remote-client.md) for the complete security and lifecycle boundary.

## Node.js server on Windows or Linux

There is currently no native Windows or Linux app. These systems run the same Bridge as a Node.js service, with user settings and status available through the ChatGPT Settings and Dashboard cards. Complex user decisions can use a standalone HTML file that returns a summary to the conversation.

The following source installation works for a terminal-managed server:

```bash
git clone --branch dev https://github.com/menaje/codex-mcp-bridge-for-chatgpt.git
cd codex-mcp-bridge-for-chatgpt
npm ci
npm run build
```

Confirm Codex is available and sign in:

```bash
codex --version
codex app-server --help
codex login
```

### Linux or terminal-managed macOS configuration

Create a private runtime configuration outside all project folders:

```bash
mkdir -p "$HOME/.config/codex-mcp-bridge"
chmod 700 "$HOME/.config/codex-mcp-bridge"
cp .env.example "$HOME/.config/codex-mcp-bridge/.env"
chmod 600 "$HOME/.config/codex-mcp-bridge/.env"
```

Edit the file and set:

```dotenv
CONTROL_PLANE_API_KEY=sk-your-runtime-key
CONTROL_PLANE_TUNNEL_ID=tunnel_your_32_character_id
```

### Windows PowerShell configuration

Create the corresponding configuration under your user profile:

```powershell
$bridgeConfigDirectory = Join-Path $HOME ".config\codex-mcp-bridge"
New-Item -ItemType Directory -Force $bridgeConfigDirectory
Copy-Item .env.example (Join-Path $bridgeConfigDirectory ".env")
notepad (Join-Path $bridgeConfigDirectory ".env")
```

Set the same two `CONTROL_PLANE_*` values and save the file. Windows does not use the Unix `chmod` commands.

### Start the Node.js server

From the repository directory:

```bash
npm run bridge:secure
```

Keep the process running, or place it under a service manager appropriate for the operating system. Then complete [Connect the server to ChatGPT](#connect-the-server-to-chatgpt).

For loopback-only development without ChatGPT Tunnel access:

```bash
npm run bridge:local
```

The native remote-client listener and pairing UI are macOS-app features. A Windows or Linux Node.js server is normally managed through its terminal and the ChatGPT cards.

## Settings reference

Settings belong to the active Bridge server and are shared by every ChatGPT
conversation using it. The native app saves ordinary settings automatically;
the ChatGPT Settings card uses **Save settings**. Project operations apply
immediately. Server settings use an explicit save because they restart the runtime.

### Connection

Connection settings choose the role of the current Mac:

- **Run Server on This Mac** starts and owns the local helper, Bridge, Tunnel, and Codex runtime.
- **Connect to Existing Server** starts none of those services and targets one paired server.
- **Manage This Server from Another Mac** enables the private-network listener used by native clients.
- Pairing invitations register a new client device; Registered Devices can be revoked individually.

### Models & Execution: access policy

The Bridge applies the saved access strategy within the server's limits to new
tasks, continuations and forks. GPT does not select sandbox or approval policy:

- **Read only**: every new task is limited to inspection.
- **Bridge default**: use the default access level configured in the Bridge.
- **Always full access**: every new task requests full filesystem and network access.

This choice cannot exceed **Server → Maximum Allowed Access**. For example, selecting Always Full Access while the server ceiling is Read Only still produces read-only work.

### Models & Execution: model policy and speed

- **Fixed** chooses one model and reasoning level for new work.
- **Automatic** lets ChatGPT choose from either the visible catalog or an explicit allowlist.
- **Allow Ultra reasoning** exposes Ultra effort where supported. This setting does not gate all sub-agent delegation.
- **Processing speed** chooses Inherit conversation speed, Standard, Fast, or Ultrafast for new Jobs. Migrated settings retain Legacy behavior until you choose another mode. Faster processing can affect usage or charges, and requested speed is distinct from confirmed execution. See [speed choices and scope](processing-speed.md#choose-a-speed).
- **Refresh model list** reloads the currently available catalog.

Existing Agents keep execution context according to their continuation rules. Model availability can change with the installed Codex version and service catalog.

### Models & Execution: model descriptions

In Automatic mode, **Model descriptions** shows the official description of
each model. Select **Edit** to adjust the text ChatGPT uses when choosing a
model, then **Save description** or **Cancel**. This editor uses explicit save
in both the native app and the ChatGPT Settings card.

Saved text has a **User description** label. **View official description** shows
the current official text, and **Use official description** removes your
override. Saving empty text also restores it. The official model list keeps its
existing refresh behavior. Switching to Fixed retains your descriptions for
later use; a model temporarily missing from the list also keeps its saved text.

Use description history to compare saved text with the current description or
restore an older entry. Restoring creates a new history entry. See
[description history](model-selection.md#user-model-descriptions) for retention
and conflict handling.

### General and Models & Execution: storage, display, and history

- **App and card language** applies one explicit language to both surfaces. Automatic follows the Mac language in the app and the ChatGPT display language in cards, so they may differ.
- **Concurrent Agent jobs** limits how many jobs may run at once; it is not the number of registered Agents.
- **Launch Menu Bar App at Login**, in General, is local to the current Mac. It does not determine whether the background server remains running.
- **Conversation storage**, in General, chooses persistent or memory-only storage for new conversations. Persistent conversations can resume after the worker stops when their original Codex storage remains available.
- **Show bridge threads in Codex app** is a separate visibility preference. Actual app visibility also depends on the original store and native support; a Bridge-owned private store is not automatically the app's store. Neither setting rewrites older conversations. See [connection lifetime and app handoff](thread-lifecycle.md).
- **Run history retention**, in Models & Execution, keeps display history for 7, 30 (default), or 90 days, or indefinitely. Full result retention and connection idle time remain separate. Historical completion records keep their original retention rules; current Dashboard cards do not send results into chat. See [work history](work-history.md).
- **Result delivery** uses direct-wait for all new ordinary Jobs. The retired experiment preference is normalized once and no longer appears in Settings.

Admission is durable and asynchronous. ChatGPT repeats bounded exact Job waits, inspects current input after every non-terminal return, reviews the original result, and continues only already-approved work. Timeout or host abort ends the read, never the Job. A new question or approval stops continuation without automatically opening Dashboard. Open that card only on explicit user request; display refresh and management remain available without chat sends.

Retained legacy Jobs preserve their policy, identities, results and receipts. The [transition rules](issue-221-delivery-transition.md) distinguish unexecuted followups requiring explicit reapproval from executed B replay. Close old cards, deploy the server and current v5 resources together, and refresh connector discovery. If automatic continuation does not occur, recover the exact retained result in the originating conversation. The [#222 final evidence](audits/2026-10-03-issue-222-final-evidence.md) records tested host behavior without making it a guarantee for all hosts.

The macOS app's operational notifications and any explicit Activity-native
completion notification are separate local channels. They depend on macOS
notification permission, do not establish ChatGPT delivery, and are not
controlled by a Dashboard/completion checkbox. See [Card tools](card-tools.md).

Values above the normal concurrency range can increase CPU, memory, and API usage substantially.

### Projects

Each project has a display name and an existing absolute folder on the server computer. The Bridge validates the folder before admitting new work.

- Renaming a project changes only its display name.
- Relocating changes the registered folder without moving files.
- Archiving hides it from new task selection while preserving history.
- Restoring makes the same project identity selectable again.
- Deleting a registration never deletes the actual folder or prior work records.

Use the deleted-project recovery view to restore a removed registration when
available. Confirm that its folder still exists before using it again; recovery
does not recreate project files.

When settings are opened from a remote client, enter the absolute path as it exists on the selected server.

Do not place `.env`, credentials, or other common secret files inside a registered project. The Bridge intentionally blocks common secret filenames before starting work.

The scan is independent of Git: `.gitignore` does not exclude a path from this
check. Generated VS Code test runtimes should use the conventional
`.vscode-test/` directory or a cache outside the registered project instead of
an `artifacts/` subtree. The Bridge still scans ordinary `artifacts/`
directories because generated output can accidentally contain copied
credentials. A `.npmrc` is allowed only when it contains the narrowly recognized
non-credential settings used by generated VS Code language servers
(`legacy-peer-deps` and numeric `timeout`); unknown or authentication-related
settings remain blocked. When admission is refused, the error reports a bounded
list of project-relative paths without exposing the absolute project root.

### Server

The Server destination is available only on the Mac that owns the local server:

Codex execution uses the selected CLI through App Server. **Maximum Allowed Access** sets the server ceiling: Read Only, Workspace Write or Full Access. Changing it safely drains active work and restarts the server.

Installation, updates, authentication and migration from earlier releases are described in [Codex installations and updates](codex-runtimes.md).

## Where data is stored

Default server files are per-user:

```text
~/.config/codex-mcp-bridge/.env       Tunnel runtime configuration
~/.codex-mcp-bridge/state.sqlite      Stable Settings, projects, Agents, Activities, and jobs
~/.codex-mcp-bridge/telemetry.sqlite  Disposable transport diagnostics (no execution authority)
~/.codex-mcp-bridge/profiles/candidate/state.sqlite
                                      Release-candidate state
~/.codex-mcp-bridge/profiles/candidate/telemetry.sqlite
                                      Candidate transport diagnostics
~/.codex-mcp-bridge/profiles/development/state.sqlite
                                      Development/deprecated-build state
~/.codex-mcp-bridge/profiles/development/telemetry.sqlite
                                      Development transport diagnostics
```

This SQLite database is the durable authority for Bridge admission, permissions,
relationships, result storage and delivery receipts; there are no parallel
Settings, session, or Job JSON state files. Live Codex turn and worker facts
come from the App Server and execution owner, not from a historical database
`running` row. See [execution authority and evidence](execution-authority-and-evidence.md).
The packaged release stage selects
the default profile. `CODEX_MCP_BRIDGE_STATE_PROFILE` selects `stable`,
`candidate`, or `development`; an absolute
`CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` overrides it. Stop every owner before
deliberately pointing development or candidate code at stable state. See
[database schema and lifecycle](database-schema.md) for table ownership and the
[state upgrade and recovery runbook](state-upgrade-recovery.md) for profiles,
backups, restore, retention, and safe offline compaction.

Transport observations are best-effort diagnostics, not bridge state authority.
Production stores them in a separate `telemetry.sqlite` beside the selected state
database, so its lock, capacity, or filesystem failure cannot block operational
state. `CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE` may select another absolute
file, but it must not resolve to the operational state database. The telemetry
database can be deleted and rebuilt independently while the Bridge is stopped.

The macOS app also uses private helper/runtime files and, when remote management is enabled, a server identity and device registry. See [Native macOS app](macos-app.md#local-files-and-interfaces) and [Remote client mode](remote-client.md#server-files-and-lifecycle) for exact paths and permissions.

## Troubleshooting

### The app stays on Checking connection

This is normal briefly while the helper and Tunnel establish their control-plane connection. If it changes to an error, use the recovery action shown by the app and inspect **Diagnostic Logs**.

### Codex login is required even though the Dashboard has usage data

Bridge status and previously available usage information can load independently
from the current Codex CLI authentication check. Open **Codex Account &
Installation**, verify the selected connection, or prepare a separate Bridge
login if needed. Refresh status after verification.

### Codex login status cannot be checked while the Dashboard shows current usage

The login check starts a new process from the selected Codex installation. An existing execution worker can still obtain current usage when that saved executable path has disappeared. Open **Settings → Codex Account & Installation** and check the selected installation. If it is unavailable, explicitly select an available installation, then refresh status. Recent ChatGPT app versions bundle Codex at `ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`; older Bridge builds do not discover that path. Update Bridge if the current app-bundled installation is absent from the list. If the selected installation is available, inspect **Diagnostic Logs** for the account check error.

### A client cannot reach the server

Confirm that:

- remote management is enabled and the server app is running;
- both Macs can reach the advertised private address and port;
- the firewall or VPN allows that connection;
- the invitation is fresh and has not already been used;
- the server certificate or identity was not replaced after pairing.

### A project cannot be selected

The folder must exist on the server, be registered and active, and remain reachable under its saved absolute path. A remote client's local filesystem is never used to resolve a server project.

### ChatGPT still shows an older card or tool list

Install and start the new Bridge release first, then use Refresh on the ChatGPT developer-mode connection. Do not Refresh solely for a routine restart with the same build.

For advanced contract checks and operator diagnostics, continue with [ChatGPT integration](chatgpt-setup.md). For trust and exposure decisions, read the [security model](security.md).
