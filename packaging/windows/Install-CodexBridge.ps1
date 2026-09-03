[CmdletBinding()]
param(
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
$releaseFile = Join-Path $archiveRoot "manifest.json"
$release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
$packageFile = Join-Path $archiveRoot $release.package.path

& (Join-Path $archiveRoot "Test-Prerequisites.ps1") -Mode Local | Out-Null
if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
    throw "The embedded npm package is missing: $packageFile"
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
& npm.cmd install --prefix $InstallRoot --omit=dev --no-audit --no-fund --no-package-lock $packageFile
if ($LASTEXITCODE -ne 0) {
    throw "npm could not install the bundled bridge package."
}

Copy-Item -LiteralPath $releaseFile -Destination (Join-Path $InstallRoot "release-manifest.json") -Force

$configDirectory = Join-Path $HOME ".config\codex-mcp-bridge"
$dotenv = Join-Path $configDirectory ".env"
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $dotenv)) {
    Copy-Item -LiteralPath (Join-Path $archiveRoot ".env.example") -Destination $dotenv
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
    $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    if ($Directory) {
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $current, $rights, $inheritance, $propagation, $allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $system, $rights, $inheritance, $propagation, $allow
    ))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

Set-PrivateAcl -Path $configDirectory -Directory $true
Set-PrivateAcl -Path $dotenv -Directory $false

Write-Host "Installed Codex MCP Bridge $($release.version) in $InstallRoot"
Write-Host "Runtime configuration: $dotenv"
Write-Host "Existing configuration values were preserved when the file already existed."
