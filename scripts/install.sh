#!/bin/bash
# Installs musebridge and muse-acp on this machine and optionally the BB plugin.
#
#   scripts/install.sh [--bin-dir DIR] [--no-plugin] [--dry-run]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="$HOME/.local/bin"
PLUGIN=1
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --no-plugin) PLUGIN=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
BIN_DIR="${BIN_DIR/#\~/$HOME}"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

say "Installing Muse bridge from $SRC"
run mkdir -p "$BIN_DIR"
for c in musebridge muse-acp; do
  if [ -e "$BIN_DIR/$c" ] && [ ! -L "$BIN_DIR/$c" ]; then
    say "  $BIN_DIR/$c exists and is not a link: moving it to $BIN_DIR/$c.bak"
    run mv "$BIN_DIR/$c" "$BIN_DIR/$c.bak"
  fi
  run ln -sfn "$SRC/bin/$c" "$BIN_DIR/$c"
done

if [ "$DRY" = 1 ]; then
  say "  [dry-run] npm install --no-audit --no-fund (in $SRC)"
else
  (cd "$SRC" && npm install --no-audit --no-fund)
fi

if [ "$PLUGIN" = 1 ]; then
  if command -v bb >/dev/null; then
    say "Installing the BB plugin from $SRC"
    run bb plugin install "$SRC" --yes
  else
    say "bb is not on PATH: install the plugin later with  bb plugin install $SRC"
  fi
fi

say "Linked $BIN_DIR/musebridge and $BIN_DIR/muse-acp"
