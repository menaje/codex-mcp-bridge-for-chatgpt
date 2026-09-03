# Windows server package

This package keeps the pre-macOS-app operating model: the bridge and Secure MCP
Tunnel run in the foreground from PowerShell. It does not install a Windows GUI
or background service.

## Requirements

- 64-bit Windows on x64
- Node.js 22 or later
- the Codex CLI in `PATH`, with `codex mcp-server` support and an existing login
- `tunnel-client` in `PATH` for ChatGPT Secure MCP Tunnel mode

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
