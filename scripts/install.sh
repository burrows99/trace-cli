#!/usr/bin/env bash
# install.sh — install trace-cli for use as a CLI, a library, and/or a Claude Code plugin.
#
# Usage:
#   scripts/install.sh                 # deps only (run via: node bin/trace … or npx)
#   scripts/install.sh --link          # + npm link → `trace` on PATH for any shell/agent
#   scripts/install.sh --plugin <dir>  # + register as a Claude Code plugin for project <dir>
#   scripts/install.sh --link --plugin <dir>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LINK=0; PLUGIN_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --link) LINK=1;;
    --plugin) PLUGIN_DIR="${2:?--plugin needs a target project directory}"; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done

echo "==> npm install (commander + source-map)"
npm install --no-audit --no-fund
chmod +x bin/trace

if [ "$LINK" = 1 ]; then
  echo "==> npm link (global \`trace\` on PATH)"
  npm link
fi

if [ -n "$PLUGIN_DIR" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "!! 'claude' CLI not found — skipping plugin registration." >&2
  else
    echo "==> registering Claude Code plugin marketplace from $ROOT"
    claude plugin marketplace add "$ROOT"
    echo "==> installing plugin 'trace@trace-oss'"
    claude plugin install trace@trace-oss
  fi
fi

echo
echo "Done. Verify with:"
echo "  trace --help                  # if linked or plugin-enabled"
echo "  node \"$ROOT/bin/trace\" --help  # always works"
