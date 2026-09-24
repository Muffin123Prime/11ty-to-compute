#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS - Starter für Linux (auf dem Stick)
#
#  Doppelklick (oder ./"Neural OS starten.sh"): Neural OS startet im
#  Hintergrund, der Browser geht auf, das Fenster darf zu. Nur wenn etwas
#  nicht geht, steht hier der Grund in einem Satz, und das Fenster wartet
#  auf die Eingabetaste (docs/STICK-BAUPLAN.md, 2.4).
#
#  Zwei Aufbauten des Sticks, der neue zuerst: Inhalt/app, Inhalt/runtime
#  oder app, runtime direkt auf dem Stick. Welcher Datenordner gilt,
#  entscheidet die Markierung neural-os.portable, nicht dieser Starter;
#  er gibt keinen Datenordner vor.
#
#  POSIX sh, kein bash: der fremde Rechner hat vielleicht nur dash.
# ---------------------------------------------------------------------------
set -u

DIR=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1

halt() {
  echo ""
  printf "Zum Schließen die Eingabetaste drücken … "
  read -r _dummy 2>/dev/null || true
  exit 1
}

sage() {
  echo ""
  echo "  $1"
  halt
}

if [ -f "$DIR/Inhalt/app/bin/neural-os.js" ]; then
  INHALT="$DIR/Inhalt"
elif [ -f "$DIR/app/bin/neural-os.js" ]; then
  INHALT="$DIR"
else
  sage "Auf diesem Stick fehlt das Programm für Linux."
fi

case "$(uname -m)" in
  x86_64|amd64)  PLAT="linux-x64" ;;
  aarch64|arm64) PLAT="linux-arm64" ;;
  armv7l|armv7)  PLAT="linux-armv7l" ;;
  *)             PLAT="linux-$(uname -m)" ;;
esac
NODE="$INHALT/runtime/$PLAT/node"

if [ -f "$NODE" ]; then
  # FAT und exFAT speichern das Ausführbar-Bit nicht; setzen, wo es geht.
  [ -x "$NODE" ] || chmod +x "$NODE" 2>/dev/null || true
else
  # Letzter Ausweg: ein installiertes Node.js ab Version 20.
  NODE=$(command -v node 2>/dev/null || true)
  HAUPT_NODE=0
  if [ -n "$NODE" ]; then
    HAUPT_NODE=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  case "$HAUPT_NODE" in ''|*[!0-9]*) HAUPT_NODE=0 ;; esac
  if [ -z "$NODE" ] || [ "$HAUPT_NODE" -lt 20 ]; then
    sage "Auf diesem Stick fehlt das Programm für Linux."
  fi
fi

# Nicht annehmen, dass es geht - ausprobieren. Ein Stick, der mit "noexec"
# eingehängt ist, lässt kein Programm starten, egal welche Rechte es hat.
if ! "$NODE" -e '' >/dev/null 2>&1; then
  sage "Dieser Rechner lässt keine Programme vom Stick starten."
fi

# Weg vom Stick: Ein Arbeitsverzeichnis darauf hielte ihn beim Aushängen fest.
cd / 2>/dev/null || true

# Der Starter schreibt „Neural OS startet …“, startet den Dienst ohne
# Fenster, öffnet den Browser und endet. Läuft Neural OS schon, öffnet er nur
# den Browser. Scheitert etwas, steht der Grund schon da.
"$NODE" "$INHALT/app/bin/neural-os.js" start --hintergrund --open || halt
exit 0
