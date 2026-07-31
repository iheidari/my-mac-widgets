#!/usr/bin/env bash
#
# Copy widgets from this repo into the Übersicht widgets folder.
#
#   ./scripts/deploy.sh                  # every widget in widgets/
#   ./scripts/deploy.sh claude-stats     # just one (with or without .widget)
#
# Übersicht runs the *copy* in its widgets folder, not the repo, so an edit here
# is invisible until this runs. Übersicht watches that folder and re-renders
# within a second or two.
#
# Each widget bundle contains a `kit.jsx` symlink to widget-kit/kit.jsx; we copy
# with -L so the deployed bundle is self-contained (Übersicht bundles each
# widget folder independently with browserify).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_DIR/widgets"

# The widgets folder is created the first time Übersicht launches. If it doesn't
# exist yet, create it — Übersicht will pick it up. Users can also point
# Übersicht at a custom folder (menu-bar icon → "Open Widgets Folder"); set
# UEBERSICHT_WIDGETS_DIR to deploy there instead.
UB_DIR="${UEBERSICHT_WIDGETS_DIR:-}"
if [[ -z "$UB_DIR" ]]; then
  # Handle a differently-normalized "Übersicht" folder name if one already exists.
  EXISTING="$(find "$HOME/Library/Application Support" -maxdepth 1 -type d -iname '*bersicht' 2>/dev/null | head -n1 || true)"
  UB_DIR="${EXISTING:-$HOME/Library/Application Support/Übersicht}/widgets"
fi
mkdir -p "$UB_DIR"

deploy_one() {
  local name="$1"
  local bundle="${name%.widget}.widget"
  local src="$SRC_DIR/$bundle"

  if [[ ! -d "$src" ]]; then
    echo "Error: no widget named '$bundle' in $SRC_DIR" >&2
    return 1
  fi

  rm -rf "${UB_DIR:?}/$bundle"
  cp -RL "$src" "$UB_DIR/"
  echo "==> $bundle -> $UB_DIR/$bundle"
}

if [[ $# -gt 0 ]]; then
  for name in "$@"; do deploy_one "$name"; done
else
  shopt -s nullglob
  found=0
  for src in "$SRC_DIR"/*.widget; do
    deploy_one "$(basename "$src")"
    found=1
  done
  if [[ $found -eq 0 ]]; then
    echo "No widgets found in $SRC_DIR — create one with ./scripts/new-widget.sh <name>" >&2
    exit 1
  fi
fi

echo
echo "Übersicht re-renders automatically. If nothing appears, use the menu-bar"
echo "icon → Refresh All. Not installed yet? https://tracesof.net/uebersicht/"
