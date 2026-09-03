# Windows server package

This package keeps the pre-macOS-app operating model: the bridge and Secure MCP
Tunnel run in the foreground from PowerShell. It does not install a Windows GUI
or background service.

## Requirements

- 64-bit Windows on x64
- Node.js 22 or later
- Codex CLI 0.145.0 installed with npm, with an existing login
- `tunnel-client` in `PATH` for ChatGPT Secure MCP Tunnel mode

Visual Studio or C++ Build Tools are not required. The installer disables npm
install scripts and verifies the `better-sqlite3` Windows x64 binary shipped by
the pinned dependency before reporting success.

The launcher resolves npm's bundled native `codex.exe` instead of keeping the
intermediate `codex.cmd` process in the managed runtime tree. An explicit
`CODEX_MCP_BRIDGE_CODEX` value remains supported for custom installations.

Run the commands below from this extracted directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-Prerequisites.ps1 -Mode Secure
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-CodexBridge.ps1
notepad "$HOME\.config\codex-mcp-bridge\.env"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexBridge.ps1 -Mode Secure
```

The installer creates the dotenv only when it is absent, preserves an existing
file, and restricts the bridge configuration directory and dotenv ACL to the
current user and Windows SYSTEM. Replace the two commented
`CONTROL_PLANE_*` placeholders before Secure mode is started.

`Start-CodexBridge.ps1` stays in the foreground. Press `Ctrl-C` in that same
PowerShell window for a managed shutdown. In another window, inspect readiness
with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Get-CodexBridgeStatus.ps1
```

The first Windows release supports the HTTP Secure MCP Tunnel transport only.
The existing Settings, Dashboard, and Activity cards remain the user interface.
The package never contains a user dotenv, API key, Tunnel ID, SQLite database,
or Codex login cache.
