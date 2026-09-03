[CmdletBinding()]
param(
    [string]$ConfiguredCommand = $env:CODEX_MCP_BRIDGE_CODEX
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-ApplicationCommand([string]$Name) {
    if (Test-Path -LiteralPath $Name -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Name).ProviderPath
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }
    return $null
}

if ($ConfiguredCommand) {
    $configured = Resolve-ApplicationCommand $ConfiguredCommand
    if (-not $configured) {
        throw "CODEX_MCP_BRIDGE_CODEX does not resolve to an executable command: $ConfiguredCommand"
    }
    Write-Output $configured
    exit 0
}

# A global npm Codex install exposes codex.cmd, which starts Node and then the
# native Codex child. Prefer the native executable so version probes and
# managed shutdown do not depend on an intermediate Windows command shim.
$npm = Resolve-ApplicationCommand "npm.cmd"
if ($npm) {
    $npmRootOutput = @(& $npm root --global)
    if ($LASTEXITCODE -eq 0) {
        $npmRoot = $npmRootOutput |
            Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 } |
            Select-Object -Last 1
        if ($npmRoot) {
            $npmRoot = $npmRoot.Trim()
            $relativeExecutable = "vendor\x86_64-pc-windows-msvc\bin\codex.exe"
            $candidates = @(
                (Join-Path $npmRoot "@openai\codex\node_modules\@openai\codex-win32-x64\$relativeExecutable"),
                (Join-Path $npmRoot "@openai\codex-win32-x64\$relativeExecutable")
            )
            foreach ($candidate in $candidates) {
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    Write-Output (Resolve-Path -LiteralPath $candidate).ProviderPath
                    exit 0
                }
            }
        }
    }
}

foreach ($fallback in @("codex.exe", "codex.cmd")) {
    $resolved = Resolve-ApplicationCommand $fallback
    if ($resolved) {
        Write-Output $resolved
        exit 0
    }
}

throw "Codex CLI is required. Install it with npm so codex is available in PATH."
