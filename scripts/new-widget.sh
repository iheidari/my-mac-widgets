#!/usr/bin/env bash
#
# Scaffold a new widget: a data provider plus the Übersicht bundle that renders it.
#
#   ./scripts/new-widget.sh weather
#   ./scripts/new-widget.sh git-status --title "Git Status"
#
# Creates:
#   src/providers/<id>/index.js      the data source (served at /stats/<id>)
#   widgets/<id>.widget/index.jsx    the widget
#   widgets/<id>.widget/kit.jsx      symlink to the shared widget-kit
#
# Both are working out of the box — run `npm start` and `./scripts/deploy.sh <id>`.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL_DIR="$REPO_DIR/scripts/templates"
PORT="${WIDGET_HOST_PORT:-${CLAUDE_STATS_PORT:-4318}}"

ID="${1:-}"
shift || true
TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ID" ]]; then
  echo "Usage: ./scripts/new-widget.sh <id> [--title \"Nice Name\"]" >&2
  exit 1
fi

# The id becomes a URL segment and a folder name in two places — keep it boring.
if [[ ! "$ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Error: id must be lower-case kebab-case (e.g. 'git-status'), got '$ID'" >&2
  exit 1
fi

# The title is substituted into a single-quoted string, a double-quoted string and
# a template literal across the two templates, so no one escaping is right for all
# three. Reject what can't be embedded rather than emitting JS that won't parse.
if [[ "$TITLE" == *[\'\"\`\\$]* || "$TITLE" == *$'\n'* ]]; then
  echo "Error: title may not contain quotes, backslashes, \$ or newlines — got '$TITLE'" >&2
  exit 1
fi

# Default title: "git-status" -> "Git Status"
if [[ -z "$TITLE" ]]; then
  TITLE="$(echo "$ID" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"
fi

PROVIDER_DIR="$REPO_DIR/src/providers/$ID"
WIDGET_DIR="$REPO_DIR/widgets/$ID.widget"

for dir in "$PROVIDER_DIR" "$WIDGET_DIR"; do
  if [[ -e "$dir" ]]; then
    echo "Error: $dir already exists — pick another id or remove it first." >&2
    exit 1
  fi
done

# A title is free-form ("A/B Testing", "Foo & Bar"), and sed would read its `/`
# as a delimiter and its `&` as "the matched text". Escape both before
# substituting, or the scaffold half-writes and aborts under `set -e`.
sed_escape() { printf '%s' "$1" | sed -e 's/[&/\]/\\&/g'; }

render_tpl() {
  sed -e "s/__ID__/$(sed_escape "$ID")/g" -e "s/__TITLE__/$(sed_escape "$TITLE")/g" "$1" > "$2"
}

mkdir -p "$PROVIDER_DIR" "$WIDGET_DIR"
render_tpl "$TPL_DIR/provider.js.tmpl" "$PROVIDER_DIR/index.js"
render_tpl "$TPL_DIR/widget.jsx.tmpl" "$WIDGET_DIR/index.jsx"
ln -sfn ../../widget-kit/kit.jsx "$WIDGET_DIR/kit.jsx"

echo "==> Provider: src/providers/$ID/index.js"
echo "==> Widget:   widgets/$ID.widget/index.jsx"
echo
echo "Next:"
echo "  1. Fill in collect() in src/providers/$ID/index.js"
echo "  2. Restart the helper:  launchctl kickstart -k gui/\$UID/com.uebersicht-widgets.helper"
echo "     (or just: npm start)"
echo "  3. Check the payload:   curl -s http://127.0.0.1:$PORT/stats/$ID | head"
echo "  4. Deploy the widget:   ./scripts/deploy.sh $ID"
