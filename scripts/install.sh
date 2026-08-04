#!/usr/bin/env bash
#
# One-shot installer for macOS:
#   1. installs a launchd service so the widget helper runs at login
#   2. offers to store a Linear API key in the Keychain (optional)
#   3. copies every widget in widgets/ into Übersicht (via deploy.sh)
#
# Re-runnable (idempotent). Requires Node 18+.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_DIR/src/cli.js"
PORT="${WIDGET_HOST_PORT:-${CLAUDE_STATS_PORT:-4318}}"

LABEL="com.uebersicht-widgets.helper"
LEGACY_LABEL="com.claude-stats.helper" # pre-multi-widget layout

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found on PATH. Install Node 18+ first (e.g. 'brew install node')." >&2
  exit 1
fi

echo "==> Node:   $NODE_BIN"
echo "==> Helper: $CLI"
echo "==> Port:   $PORT"

# --- 1. launchd service ------------------------------------------------------
LOGDIR="$HOME/Library/Logs/uebersicht-widgets"
mkdir -p "$LOGDIR"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST="$PLIST_DIR/$LABEL.plist"

# Retire the single-widget service, so the two don't fight over the port.
LEGACY_PLIST="$PLIST_DIR/$LEGACY_LABEL.plist"
if [[ -f "$LEGACY_PLIST" ]]; then
  launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
  echo "==> Removed legacy service ($LEGACY_LABEL)"
fi

sed -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__CLI__#$CLI#g" \
    -e "s#__LOGDIR__#$LOGDIR#g" \
    -e "s#__PORT__#$PORT#g" \
    "$REPO_DIR/scripts/$LABEL.plist.template" > "$PLIST"

# Reload if already loaded.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "==> launchd service installed and started ($PLIST)"

# Give it a moment, then verify.
sleep 1
# Match the service marker, not merely "something answered": 4318 is the OTLP
# default, so a real collector — or a helper from another checkout — will happily
# reply and earn a green check while our service is dead in the logs.
HEALTH="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/health" || true)"
if [[ "$HEALTH" == *'"service":"uebersicht-widget-host"'* ]]; then
  echo "==> Helper is responding on port $PORT ✅"
  echo "    $HEALTH"
elif [[ -n "$HEALTH" ]]; then
  echo "==> Port $PORT is answering, but not with this helper — something else holds it." >&2
  echo "    $HEALTH" >&2
  echo "    Set WIDGET_HOST_PORT to a free port, or stop the other process." >&2
else
  echo "==> Helper not responding yet — check logs in $LOGDIR" >&2
fi

# --- 2. Linear API key (optional) --------------------------------------------
# The linear-stats provider needs a personal API key. Without one it makes no
# network call and the widget just shows a setup hint, so this is offered rather
# than required — and skipped entirely when there is no terminal to prompt on.
LINEAR_SERVICE="linear-stats" # must match KEYCHAIN_SERVICE in src/providers/linear-stats/credential.js

if security find-generic-password -s "$LINEAR_SERVICE" >/dev/null 2>&1; then
  echo "==> Linear API key already in the Keychain ($LINEAR_SERVICE)"
elif [[ -n "${LINEAR_API_KEY:-}" ]]; then
  echo "==> LINEAR_API_KEY is set in the environment — leaving the Keychain alone"
elif [[ -t 0 ]]; then
  echo
  echo "==> Linear widget (optional)"
  echo "    Create a personal API key at https://linear.app/settings/api"
  echo "    Note: a personal key carries your full Linear permissions."
  echo "    Press Return to skip."
  # -s so the key never appears on screen or in scrollback.
  read -rsp "    Linear API key: " LINEAR_KEY_INPUT || LINEAR_KEY_INPUT=""
  echo
  if [[ -n "$LINEAR_KEY_INPUT" ]]; then
    # `-w` last with no value: security reads the secret from stdin (prompting
    # twice) instead of taking it from argv, where any local process could read
    # it out of `ps`.
    printf '%s\n%s\n' "$LINEAR_KEY_INPUT" "$LINEAR_KEY_INPUT" |
      security add-generic-password -U -a "$USER" -s "$LINEAR_SERVICE" -w
    unset LINEAR_KEY_INPUT
    echo "==> Linear API key stored in the Keychain ($LINEAR_SERVICE)"
    # The helper reads the Keychain on its next poll, but it caches failures for
    # a minute — restart so the widget lights up now rather than shortly.
    launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  else
    echo "==> Skipped — the Linear widget will show a setup hint until a key is added."
  fi
else
  echo "==> No Linear API key found (non-interactive) — add one later by re-running this script."
fi

# --- 3. Übersicht widgets ----------------------------------------------------
"$REPO_DIR/scripts/deploy.sh"

echo
echo "Done."
echo "  • Add another widget:         ./scripts/new-widget.sh <id>"
echo "  • Live Claude Code telemetry: ./scripts/enable-telemetry.sh"
echo "  • Uninstall the service:      launchctl unload \"$PLIST\" && rm \"$PLIST\""
