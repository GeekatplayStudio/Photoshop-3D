<#
.SYNOPSIS
    Installs (or updates, or uninstalls) Geekatplay 3D Layers for Photoshop on Windows.

.DESCRIPTION
    Every step is printed as it happens; nothing is hidden.

      1. Find Adobe's Unified Plugin Installer Agent (UPIA), which ships with the
         Creative Cloud desktop app and is what Creative Cloud itself uses.
      2. Get the plugin package (.ccx):
           - the file passed with -Ccx, or
           - a .ccx next to this script, or
           - the latest release from https://github.com/GeekatplayStudio/Photoshop-3D
             (downloaded to %TEMP% and checked against SHA256SUMS.txt from the same release).
      3. Remove any installed copy (UPIA keeps old versions registered otherwise).
         Your models, settings and API keys are NOT touched: they live in
         %APPDATA%\Geekatplay\3D Layers.
      4. Install the package and confirm Photoshop has it registered.

    Photoshop does not need to be closed; the plugin appears under
    Plugins > Geekatplay 3D Layers > 3D Layers.

.PARAMETER Ccx
    Path to a .ccx file to install instead of downloading the latest release.

.PARAMETER Version
    Release tag to download (for example v0.1.0). Default: the latest release.

.PARAMETER Uninstall
    Remove the plugin. Add -RemoveData to also delete %APPDATA%\Geekatplay\3D Layers.

.EXAMPLE
    irm https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-windows.ps1 | iex

.EXAMPLE
    .\install-windows.ps1 -Ccx .\geekatplay-3d-layers-0.1.0.ccx
#>
[CmdletBinding()]
param(
    [string]$Ccx,
    [string]$Version,
    [switch]$Uninstall,
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = "GeekatplayStudio/Photoshop-3D"
$PluginName = "Geekatplay 3D Layers"
$DataFolder = Join-Path $env:APPDATA "Geekatplay\3D Layers"
$UpiaCandidates = @(
    "$env:ProgramFiles\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
    "${env:ProgramFiles(x86)}\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
)

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Fail($text) { Write-Host "`nERROR: $text" -ForegroundColor Red; exit 1 }

Write-Host "Geekatplay 3D Layers - Photoshop plugin installer" -ForegroundColor White
Write-Host "https://github.com/$Repo"

Step "Looking for Adobe's plugin installer (UPIA)"
$Upia = $UpiaCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Upia) {
    Fail "UPIA was not found. Install or update the Creative Cloud desktop app (https://creativecloud.adobe.com/apps/download/creative-cloud), then run this again. Alternatively double-click the .ccx file."
}
Info $Upia

function Invoke-Upia([string[]]$Arguments) {
    $output = & $Upia @Arguments 2>&1 | Out-String
    return $output.Trim()
}

function Remove-AllCopies {
    $removed = 0
    for ($i = 0; $i -lt 10; $i++) {
        $out = Invoke-Upia @("/remove", $PluginName)
        if ($out -notmatch "Removal Successful") { break }
        $removed++
    }
    return $removed
}

if ($Uninstall) {
    Step "Removing $PluginName"
    $n = Remove-AllCopies
    if ($n -gt 0) { Info "Removed $n installed cop$(if ($n -eq 1) { 'y' } else { 'ies' })." } else { Info "It was not installed." }
    if ($RemoveData) {
        Step "Deleting your models, settings and API keys ($DataFolder)"
        if (Test-Path $DataFolder) { Remove-Item -Recurse -Force $DataFolder; Info "Deleted." } else { Info "Nothing to delete." }
    } else {
        Info "Your models, settings and API keys were kept in $DataFolder (run with -RemoveData to delete them)."
    }
    Write-Host "`nDone." -ForegroundColor Green
    exit 0
}

Step "Getting the plugin package"
if (-not $Ccx) {
    $here = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
    if ($here) {
        $local = Get-ChildItem -Path $here -Filter "geekatplay-3d-layers*.ccx" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($local) { $Ccx = $local.FullName; Info "Using $Ccx (found next to this script)" }
    }
}

if (-not $Ccx) {
    $api = if ($Version) { "https://api.github.com/repos/$Repo/releases/tags/$Version" } else { "https://api.github.com/repos/$Repo/releases/latest" }
    Info "Asking GitHub for the release: $api"
    try {
        $release = Invoke-RestMethod -Uri $api -Headers @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "geekatplay-3d-layers-installer" }
    } catch {
        Fail "Could not read the release from GitHub ($($_.Exception.Message)). Check your internet connection, or download the .ccx from https://github.com/$Repo/releases and run: .\install-windows.ps1 -Ccx <file>"
    }
    $asset = $release.assets | Where-Object { $_.name -match '^geekatplay-3d-layers-[\d.]+.*\.ccx$' } | Select-Object -First 1
    if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -like "*.ccx" } | Select-Object -First 1 }
    if (-not $asset) { Fail "Release $($release.tag_name) has no .ccx file." }
    $tempDir = Join-Path $env:TEMP "geekatplay-3d-layers"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $Ccx = Join-Path $tempDir $asset.name
    Info "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 2)) MB) from release $($release.tag_name)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $Ccx -UseBasicParsing

    $sums = $release.assets | Where-Object { $_.name -match '^SHA256SUMS(\.txt)?$' } | Select-Object -First 1
    if ($sums) {
        $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
        if ($sumsText -is [byte[]]) { $sumsText = [System.Text.Encoding]::UTF8.GetString($sumsText) }
        $line = ($sumsText -split "`n") | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
        if (-not $line) { Fail "SHA256SUMS.txt has no entry for $($asset.name); refusing to install." }
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $Ccx).Hash.ToLower()
        if ($expected -ne $actual) { Fail "Checksum mismatch for $($asset.name) (expected $expected, got $actual). The download is corrupted; run the installer again." }
        Info "SHA-256 verified: $actual"
    } else {
        Write-Host "    Warning: this release has no SHA256SUMS.txt; installing without checksum verification." -ForegroundColor Yellow
    }
}

if (-not (Test-Path $Ccx)) { Fail "Package not found: $Ccx" }
$Ccx = (Resolve-Path $Ccx).Path

Step "Removing any installed copy (your data stays in $DataFolder)"
$n = Remove-AllCopies
if ($n -gt 0) { Info "Removed $n older cop$(if ($n -eq 1) { 'y' } else { 'ies' })." } else { Info "No previous installation." }

Step "Installing $([IO.Path]::GetFileName($Ccx))"
$out = Invoke-Upia @("/install", $Ccx)
Info $out
if ($out -notmatch "Installation Successful") {
    if ($out -match "-204") { Fail "UPIA rejected the package (status -204: not a valid .ccx). Download it again from https://github.com/$Repo/releases." }
    if ($out -match "-411") { Fail "UPIA found no compatible Photoshop (needs Photoshop 2025 / v26 or newer)." }
    Fail "Installation failed. See the UPIA output above, or double-click the .ccx file to install it through Creative Cloud."
}

Step "Checking that Photoshop has it registered"
$list = Invoke-Upia @("/list", "all")
$found = ($list -split "`n") | Where-Object { $_ -match [regex]::Escape($PluginName) }
if ($found) { $found | ForEach-Object { Info $_.Trim() } } else { Write-Host "    Warning: UPIA does not list the plugin yet; restart Photoshop if it does not appear." -ForegroundColor Yellow }

Write-Host "`nInstalled. In Photoshop open: Plugins > Geekatplay 3D Layers > 3D Layers" -ForegroundColor Green
Write-Host "Your models, settings and API keys: $DataFolder"
Write-Host "The plugin checks GitHub for updates and offers them in its panel (Settings > Updates)."
exit 0
