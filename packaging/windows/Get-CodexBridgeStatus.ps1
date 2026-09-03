[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8876,

    [string]$EnvFile = $(Join-Path $HOME ".config\codex-mcp-bridge\.env")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$healthUrl = "http://127.0.0.1:$Port/healthz"
$runtimeStatus = Join-Path (Split-Path -Parent $EnvFile) "run\launcher-status.json"
$health = $null
$launcher = $null

try {
    $health = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 5
} catch {
    $health = [pscustomobject]@{ healthy = $false; error = "Bridge health endpoint is unavailable." }
}
if (Test-Path -LiteralPath $runtimeStatus -PathType Leaf) {
    try {
        $launcher = Get-Content -LiteralPath $runtimeStatus -Raw | ConvertFrom-Json
    } catch {
        $launcher = [pscustomobject]@{ phase = "unknown"; error = "Launcher status is unreadable." }
    }
}

[pscustomobject]@{
    healthUrl = $healthUrl
    bridge = $health
    launcher = $launcher
}
