[CmdletBinding()]
param(
    [ValidateSet("Local", "Secure")]
    [string]$Mode = "Secure",

    [ValidateSet("ReadOnly", "AllowWrite", "WorkspaceWrite", "FullAccess")]
    [string]$Access = "ReadOnly",

    [ValidateRange(1, 65535)]
    [int]$Port = 8876,

    [string]$EnvFile,

    [string]$TunnelClient,

    [string]$InstallRoot = $(
        if ($env:LOCALAPPDATA) {
            Join-Path $env:LOCALAPPDATA "Codex MCP Bridge"
        } else {
            Join-Path $HOME "AppData\Local\Codex MCP Bridge"
        }
    )
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$archiveRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRelease = Join-Path $InstallRoot "release-manifest.json"
if (-not (Test-Path -LiteralPath $packageRelease -PathType Leaf)) {
    throw "The bridge is not installed. Run Install-CodexBridge.ps1 first."
}
$release = Get-Content -LiteralPath $packageRelease -Raw | ConvertFrom-Json
if ($release.target.transport -ne "http") {
    throw "This Windows package supports the HTTP transport only."
}

& (Join-Path $archiveRoot "Test-Prerequisites.ps1") -Mode $Mode | Out-Null

$packageRoot = Join-Path $InstallRoot "node_modules\$($release.package.name)"
$launcher = Join-Path $packageRoot "scripts\start-codex-mcp-bridge.mjs"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "The installed launcher is missing. Run Install-CodexBridge.ps1 again."
}

$launcherArguments = @(
    $launcher,
    "--mode", $Mode.ToLowerInvariant(),
    "--transport", "http",
    "--port", [string]$Port,
    "--require-built",
    "--reuse-profile"
)
if ($EnvFile) {
    $launcherArguments += @("--env-file", $EnvFile)
}
if ($TunnelClient) {
    $launcherArguments += @("--tunnel-client", $TunnelClient)
}
switch ($Access) {
    "AllowWrite" { $launcherArguments += "--allow-write" }
    "WorkspaceWrite" { $launcherArguments += "--write" }
    "FullAccess" { $launcherArguments += "--allow-full-access" }
}

Write-Host "Starting Codex MCP Bridge $($release.version) in $Mode mode."
Write-Host "Keep this window open and press Ctrl-C here for a managed shutdown."
& node.exe @launcherArguments
exit $LASTEXITCODE
