[CmdletBinding()]
param(
    [ValidateSet("Local", "Secure")]
    [string]$Mode = "Secure"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$archiveRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Get-Content -LiteralPath (Join-Path $archiveRoot "manifest.json") -Raw | ConvertFrom-Json

if ($env:OS -ne "Windows_NT") {
    throw "This package supports Windows only."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne "X64") {
    throw "This release supports Windows x64 only."
}

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$Name is required and must be available in PATH."
    }
    return $command.Source
}

$node = Require-Command "node"
$npm = Require-Command "npm"
$codex = Require-Command "codex"

$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v([0-9]+)\.') {
    throw "Could not read the installed Node.js version."
}
if ([int]$Matches[1] -lt [int]$release.prerequisites.nodeMajor) {
    throw "Node.js $($release.prerequisites.nodeMajor) or later is required; found $nodeVersion."
}

& $codex mcp-server --help *> $null
if ($LASTEXITCODE -ne 0) {
    throw "The installed Codex CLI does not provide codex mcp-server."
}

$tunnelClient = $null
if ($Mode -eq "Secure") {
    $tunnelClient = Require-Command "tunnel-client.exe"
    & $tunnelClient --version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not run tunnel-client."
    }
}

[pscustomobject]@{
    releaseVersion = $release.version
    architecture = "x64"
    transport = $release.target.transport
    node = $nodeVersion
    npm = $npm
    codex = $codex
    tunnelClient = $tunnelClient
}
