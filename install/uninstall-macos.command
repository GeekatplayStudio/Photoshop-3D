#!/bin/bash
# Geekatplay 3D Layers - uninstaller for macOS.
# Removes the plugin from Photoshop. Your models, settings and API keys in
# ~/Library/Application Support/Geekatplay/3D Layers are kept; add --remove-data to delete them.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/install-macos.command" --uninstall "$@"
