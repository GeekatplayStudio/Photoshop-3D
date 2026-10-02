#!/bin/bash
# Geekatplay 3D Layers - Photoshop plugin installer for macOS.
#
# Double-click this file (or run: bash install-macos.command). Every step is printed:
#   1. Find Adobe's Unified Plugin Installer Agent (UPIA), part of the Creative Cloud app.
#   2. Get the plugin package (.ccx): a file passed as the first argument, a .ccx next to
#      this script, or the latest release from GitHub (checked against SHA256SUMS.txt).
#   3. Remove any installed copy. Your models, settings and API keys are NOT touched:
#      they live in ~/Library/Application Support/Geekatplay/3D Layers.
#   4. Install the package and confirm Photoshop has it registered.
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-macos.command | bash
# Uninstall:
#   bash install-macos.command --uninstall [--remove-data]
set -euo pipefail

REPO="GeekatplayStudio/Photoshop-3D"
PLUGIN_NAME="Geekatplay 3D Layers"
DATA_FOLDER="$HOME/Library/Application Support/Geekatplay/3D Layers"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() {
    printf '\n\033[31mPROBLEM: %s\033[0m\n' "$1"
    printf '\nHelp: https://github.com/%s/blob/main/docs/INSTALL.md#something-went-wrong\n' "$REPO"
    exit 1
}

UNINSTALL=0
REMOVE_DATA=0
CCX=""
VERSION=""
for arg in "$@"; do
    case "$arg" in
        --uninstall) UNINSTALL=1 ;;
        --remove-data) REMOVE_DATA=1 ;;
        --version=*) VERSION="${arg#--version=}" ;;
        *.ccx) CCX="$arg" ;;
        *) fail "Unknown argument: $arg" ;;
    esac
done

echo "Geekatplay 3D Layers - Photoshop plugin installer"
echo "https://github.com/$REPO"

step "Looking for Adobe's plugin installer (part of the Creative Cloud app)"
[ -x "$UPIA" ] || fail "Adobe's plugin installer was not found. Open the Creative Cloud desktop app (install it from https://creativecloud.adobe.com/apps/download/creative-cloud if needed), make sure Photoshop is installed, then run this again."
info "$UPIA"

remove_all() {
    local n=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if "$UPIA" --remove "$PLUGIN_NAME" 2>&1 | grep -q "Removal Successful"; then n=$((n + 1)); else break; fi
    done
    echo "$n"
}

if [ "$UNINSTALL" = 1 ]; then
    step "Removing $PLUGIN_NAME"
    n=$(remove_all)
    if [ "$n" -gt 0 ]; then info "Removed $n installed copies."; else info "It was not installed."; fi
    if [ "$REMOVE_DATA" = 1 ]; then
        step "Deleting your models, settings and API keys ($DATA_FOLDER)"
        rm -rf "$DATA_FOLDER" && info "Deleted."
    else
        info "Your models, settings and API keys were kept in $DATA_FOLDER (use --remove-data to delete them)."
    fi
    printf '\n\033[32mDone.\033[0m\n'
    exit 0
fi

step "Getting the plugin package"
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [ -z "$CCX" ] && [ -n "$SCRIPT_DIR" ]; then
    CCX="$(ls -t "$SCRIPT_DIR"/geekatplay-3d-layers*.ccx 2>/dev/null | head -n 1 || true)"
    [ -n "$CCX" ] && info "Using $CCX (found next to this script)"
fi

if [ -z "$CCX" ]; then
    if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"; else API="https://api.github.com/repos/$REPO/releases/latest"; fi
    info "Asking GitHub for the release: $API"
    RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: geekatplay-3d-layers-installer" "$API")" || fail "Could not reach GitHub. Check your internet connection and try again. You can also download the .ccx from https://github.com/$REPO/releases and double-click it."
    CCX_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*geekatplay-3d-layers-[0-9][^"]*\.ccx"' | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')"
    [ -n "$CCX_URL" ] || CCX_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.ccx"' | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')"
    [ -n "$CCX_URL" ] || fail "The latest release has no plugin file (.ccx)."
    SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*SHA256SUMS[^"]*"' | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/' || true)"
    TMP_DIR="$(mktemp -d -t geekatplay3d)"
    CCX="$TMP_DIR/$(basename "$CCX_URL")"
    info "Downloading $(basename "$CCX_URL")"
    curl -fsSL -o "$CCX" "$CCX_URL" || fail "The download failed. Please try again."
    if [ -n "$SUMS_URL" ]; then
        EXPECTED="$(curl -fsSL "$SUMS_URL" | grep " $(basename "$CCX")\$" | head -n 1 | awk '{print $1}' | tr 'A-F' 'a-f')"
        [ -n "$EXPECTED" ] || fail "SHA256SUMS.txt has no entry for $(basename "$CCX"); not installing an unverified file."
        ACTUAL="$(shasum -a 256 "$CCX" | awk '{print $1}')"
        [ "$EXPECTED" = "$ACTUAL" ] || fail "The downloaded file is damaged (checksum mismatch). Please run the installer again."
        info "SHA-256 verified: $ACTUAL"
    else
        info "Warning: this release has no SHA256SUMS.txt; installing without checksum verification."
    fi
fi

[ -f "$CCX" ] || fail "Plugin file not found: $CCX"

step "Removing any installed copy (your data stays in $DATA_FOLDER)"
n=$(remove_all)
if [ "$n" -gt 0 ]; then info "Removed $n older copies."; else info "No previous installation."; fi

step "Installing $(basename "$CCX")"
OUT="$("$UPIA" --install "$CCX" 2>&1 || true)"
info "$OUT"
echo "$OUT" | grep -q "Installation Successful" || {
    echo "$OUT" | grep -q -- "-204" && fail "Adobe's installer says the file is not a valid plugin (status -204). Please run the installer again to download a fresh copy."
    echo "$OUT" | grep -q -- "-411" && fail "No compatible Photoshop found. This plugin needs Photoshop 2025 (version 26) or newer. Open Photoshop once, then try again."
    fail "Adobe's installer could not install the plugin (see the message above). Try double-clicking the .ccx file instead: $CCX"
}

step "Checking that Photoshop has it registered"
# UPIA lists plugins per installed app ("3 extensions installed for Photoshop 2026 (ver 27.10.0)").
LISTED="$( ("$UPIA" --list all 2>&1 || true) | awk -v name="$PLUGIN_NAME" '
    /installed for/ { app = $0; sub(/.*installed for /, "", app); sub(/ 64 \(ver /, " (", app); sub(/ \(ver /, " (", app) }
    index($0, name) && !/installed for/ { n = split($0, f, " "); print "    " app ": version " f[n] }')"
if [ -n "$LISTED" ]; then echo "$LISTED"; else info "Adobe's installer does not list the plugin yet; restart Photoshop if it does not appear."; fi

printf '\n\033[30;42m Installed! \033[0m\n\n'
printf '\033[32m In Photoshop, open the menu:  Plugins > Geekatplay 3D Layers > 3D Layers\033[0m\n'
echo " (If it is not there yet, restart Photoshop.)"
echo
echo "Your models, settings and API keys: $DATA_FOLDER"
echo "The plugin checks GitHub for updates and offers them in its panel (Settings > Updates)."
