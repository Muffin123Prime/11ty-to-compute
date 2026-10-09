#!/bin/bash
# Installiert die Claude-Code-Mods aus .claude/mods in jeder Cloud-Sitzung,
# damit /cache und /chats dort verfuegbar sind. Lokal passiert nichts.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

MODS="$CLAUDE_PROJECT_DIR/.claude/mods"
ZIEL="$HOME/.claude/skills"

mkdir -p "$ZIEL"
for mod in cache-anzeige chat-anzeige; do
  rm -rf "$ZIEL/$mod"
  cp -R "$MODS/$mod" "$ZIEL/$mod"
  echo "Mod installiert: $mod"
done
