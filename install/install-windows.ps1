<#
.SYNOPSIS
    Installs (or updates, or uninstalls) Geekatplay 3D Layers for Photoshop on Windows.

.DESCRIPTION
    Every step is printed as it happens; nothing is hidden.

      1. Find Adobe's plugin installer ("Unified Plugin Installer Agent"), which comes with
         the Creative Cloud desktop app and is what Creative Cloud itself uses.
      2. Get the plugin package (.ccx):
           - the file passed with -Ccx, or
           - a .ccx next to this script, or
           - the latest release from https://github.com/GeekatplayStudio/Photoshop-3D
             (downloaded to %TEMP% and checked against SHA256SUMS.txt from the same release).
      3. Remove any installed copy (Adobe's installer keeps old versions registered otherwise).
         Your models, settings and API keys are NOT touched: they live in
         %APPDATA%\Geekatplay\3D Layers.
      4. Install the package and confirm Photoshop has it registered.

    Photoshop does not need to be closed; the plugin appears under
    Plugins > Geekatplay 3D Layers > 3D Layers.

    Ways to run it:
      - double-click install-windows.cmd (works on its own), or
      - paste into PowerShell:
          irm https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-windows.ps1 | iex
      - or run this file: .\install-windows.ps1 [-Ccx file.ccx] [-Version v0.1.0] [-Uninstall [-RemoveData]]

.PARAMETER Ccx
    Path to a .ccx file to install instead of downloading the latest release.

.PARAMETER Version
    Release tag to download (for example v0.1.0). Default: the latest release.

.PARAMETER Uninstall
    Remove the plugin. Add -RemoveData to also delete %APPDATA%\Geekatplay\3D Layers.
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
# GitHub needs TLS 1.2, which older Windows 10 PowerShell does not enable by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "GeekatplayStudio/Photoshop-3D"
$PluginName = "Geekatplay 3D Layers"
$DataFolder = Join-Path $env:APPDATA "Geekatplay\3D Layers"
$HelpUrl = "https://github.com/$Repo/blob/main/docs/INSTALL.md#something-went-wrong"
$UpiaCandidates = @(
    "$env:ProgramFiles\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
    "${env:ProgramFiles(x86)}\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
)
$FailMarker = "GEEKATPLAY_INSTALL_FAILED"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
# Prints the problem and stops. (No `exit` here: when pasted into PowerShell, exit would
# close the user's window before they can read the message.)
function Fail($text) { Write-Host "`nPROBLEM: $text" -ForegroundColor Red; throw $FailMarker }

function Invoke-Upia([string[]]$Arguments) {
    $output = & $script:Upia @Arguments 2>&1 | Out-String
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

function Get-ReleasePackage {
    $api = if ($Version) { "https://api.github.com/repos/$Repo/releases/tags/$Version" } else { "https://api.github.com/repos/$Repo/releases/latest" }
    Info "Asking GitHub for the newest version..."
    try {
        $release = Invoke-RestMethod -Uri $api -Headers @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "geekatplay-3d-layers-installer" }
    } catch {
        Fail "Could not reach GitHub ($($_.Exception.Message)). Check your internet connection and try again. You can also download the .ccx from https://github.com/$Repo/releases and double-click it."
    }
    $asset = $release.assets | Where-Object { $_.name -match '^geekatplay-3d-layers-[\d.]+.*\.ccx$' } | Select-Object -First 1
    if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -like "*.ccx" } | Select-Object -First 1 }
    if (-not $asset) { Fail "Release $($release.tag_name) has no plugin file (.ccx)." }

    $tempDir = Join-Path $env:TEMP "geekatplay-3d-layers"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $file = Join-Path $tempDir $asset.name
    Info "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB, version $($release.tag_name))..."
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
    } catch {
        Fail "The download failed ($($_.Exception.Message)). Please try again."
    }

    $sums = $release.assets | Where-Object { $_.name -match '^SHA256SUMS(\.txt)?$' } | Select-Object -First 1
    if ($sums) {
        $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
        if ($sumsText -is [byte[]]) { $sumsText = [System.Text.Encoding]::UTF8.GetString($sumsText) }
        $line = ($sumsText -split "`n") | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
        if (-not $line) { Fail "SHA256SUMS.txt has no entry for $($asset.name); not installing an unverified file." }
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
        if ($expected -ne $actual) { Fail "The downloaded file is damaged (checksum mismatch). Please run the installer again." }
        Info "Download checked: SHA-256 $actual"
    } else {
        Warn "This release has no SHA256SUMS.txt; installing without checksum verification."
    }
    return $file
}

function Main {
    Write-Host ""
    Write-Host " Geekatplay 3D Layers - Photoshop plugin installer " -ForegroundColor Black -BackgroundColor Cyan
    Write-Host " https://github.com/$Repo"

    Step "Looking for Adobe's plugin installer (part of the Creative Cloud app)"
    $script:Upia = $UpiaCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $script:Upia) {
        Fail "Adobe's plugin installer was not found. Open the Creative Cloud desktop app (install it from https://creativecloud.adobe.com/apps/download/creative-cloud if needed), make sure Photoshop is installed, then run this again."
    }
    Info "Found: $script:Upia"

    if ($Uninstall) {
        Step "Removing $PluginName from Photoshop"
        $n = Remove-AllCopies
        if ($n -gt 0) { Info "Removed." } else { Info "It was not installed." }
        if ($RemoveData) {
            Step "Deleting your models, settings and API keys ($DataFolder)"
            if (Test-Path $DataFolder) { Remove-Item -Recurse -Force $DataFolder; Info "Deleted." } else { Info "Nothing to delete." }
        } else {
            Info "Your models, settings and API keys were kept in $DataFolder"
        }
        Write-Host "`nDone: $PluginName was removed." -ForegroundColor Green
        return
    }

    Step "Getting the plugin"
    $package = $Ccx
    if (-not $package -and $PSScriptRoot) {
        $local = Get-ChildItem -Path $PSScriptRoot -Filter "geekatplay-3d-layers*.ccx" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($local) { $package = $local.FullName; Info "Using $package (found next to this installer)" }
    }
    if (-not $package) { $package = Get-ReleasePackage }
    if (-not (Test-Path $package)) { Fail "Plugin file not found: $package" }
    $package = (Resolve-Path $package).Path

    Step "Removing any older copy (your models, settings and keys are kept)"
    $n = Remove-AllCopies
    if ($n -gt 0) { Info "Removed the older copy." } else { Info "No older copy installed." }

    Step "Installing into Photoshop"
    $out = Invoke-Upia @("/install", $package)
    Info $out
    if ($out -notmatch "Installation Successful") {
        if ($out -match "-204") { Fail "Adobe's installer says the file is not a valid plugin (status -204). Please run the installer again to download a fresh copy." }
        if ($out -match "-411") { Fail "No compatible Photoshop found. This plugin needs Photoshop 2025 (version 26) or newer. Open Photoshop once, then try again." }
        Fail "Adobe's installer could not install the plugin (see the message above). Try double-clicking the .ccx file instead: $package"
    }

    Step "Checking that Photoshop sees it"
    # UPIA lists plugins per installed app ("3 extensions installed for Photoshop 2026 64 (ver 27.10.0)").
    $list = Invoke-Upia @("/list", "all")
    $app = ""
    $found = @()
    foreach ($line in ($list -split "`r?`n")) {
        if ($line -match "installed for (.+?)(?: 64)? \(ver ([\d.]+)\)") { $app = "$($Matches[1]) ($($Matches[2]))"; continue }
        if ($line -match "$([regex]::Escape($PluginName))\s+(\S+)\s*$") { $found += "${app}: version $($Matches[1])" }
    }
    if ($found) { $found | ForEach-Object { Info $_ } } else { Warn "Not listed yet. If the plugin does not appear in Photoshop, restart Photoshop." }

    Write-Host ""
    Write-Host " Installed! " -ForegroundColor Black -BackgroundColor Green
    Write-Host ""
    Write-Host " In Photoshop, open the menu:  Plugins > Geekatplay 3D Layers > 3D Layers" -ForegroundColor Green
    Write-Host " (Photoshop can stay open. If you don't see it, restart Photoshop.)"
    Write-Host ""
    Write-Host " Your models, settings and API keys are kept in: $DataFolder"
    Write-Host " The plugin tells you when an update is available (Settings > Updates)."
}

$code = 0
try {
    Main
} catch {
    if ("$_" -ne $FailMarker) { Write-Host "`nPROBLEM: $_" -ForegroundColor Red }
    Write-Host "Help: $HelpUrl" -ForegroundColor Yellow
    $code = 1
}
# Exit with a code only when started as a file or by install-windows.cmd; when pasted
# into a PowerShell window (irm | iex), `exit` would close that window.
if ($PSCommandPath -or $env:GEEKATPLAY_INSTALLER -eq "cmd") { exit $code }
