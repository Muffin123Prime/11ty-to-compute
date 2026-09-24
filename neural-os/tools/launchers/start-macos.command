#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS - Starter für macOS (auf dem Stick)
#
#  Doppelklick im Finder: Neural OS startet im Hintergrund, der Browser geht
#  auf, und hier steht „Fertig. Dieses Fenster kann zu.“ Neural OS läuft
#  weiter, auch wenn dieses Fenster zugeht (⌘W). Nur wenn etwas nicht geht,
#  steht hier der Grund in einem Satz, und das Fenster wartet auf die
#  Eingabetaste (docs/STICK-BAUPLAN.md, 1.3 und 2.4).
#
#  Zwei Aufbauten des Sticks, der neue zuerst: Inhalt/app, Inhalt/runtime
#  oder app, runtime direkt auf dem Stick. Welcher Datenordner gilt,
#  entscheidet die Markierung neural-os.portable, nicht dieser Starter;
#  er gibt keinen Datenordner vor.
#
#  POSIX sh, kein bash: /bin/sh ist auf jedem Mac da.
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
  sage "Auf diesem Stick fehlt das Programm für den Mac."
fi

# Die mitgelieferte Node 22 verlangt macOS 11 oder neuer.
MACOS=$(sw_vers -productVersion 2>/dev/null || echo 0)
HAUPT=${MACOS%%.*}
case "$HAUPT" in ''|*[!0-9]*) HAUPT=0 ;; esac
if [ "$HAUPT" -lt 11 ]; then
  sage "Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer."
fi

# Apple-Chip: zuerst die eigene Laufzeit, sonst x64 über Rosetta.
case "$(uname -m)" in
  arm64) PLAT="darwin-arm64"; ERSATZ="darwin-x64" ;;
  *)     PLAT="darwin-x64";   ERSATZ="" ;;
esac
NODE="$INHALT/runtime/$PLAT/node"
if [ ! -f "$NODE" ] && [ -n "$ERSATZ" ] && [ -f "$INHALT/runtime/$ERSATZ/node" ]; then
  NODE="$INHALT/runtime/$ERSATZ/node"
fi

if [ -f "$NODE" ]; then
  # Gatekeeper: Alles von einem fremden Datenträger trägt das Merkmal
  # com.apple.quarantine, und dann verweigert macOS den Start der Laufzeit.
  # Rekursiv über alle Mac-Laufzeiten; kennt xattr -r nicht, wenigstens die
  # eine. Fehlt das Merkmal, ist das kein Fehler.
  xattr -dr com.apple.quarantine "$INHALT/runtime/darwin-"* 2>/dev/null \
    || xattr -d com.apple.quarantine "$NODE" 2>/dev/null \
    || true
  chmod +x "$NODE" 2>/dev/null || true
else
  # Letzter Ausweg: ein installiertes Node.js ab Version 20.
  NODE=$(command -v node 2>/dev/null || true)
  HAUPT_NODE=0
  if [ -n "$NODE" ]; then
    HAUPT_NODE=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  case "$HAUPT_NODE" in ''|*[!0-9]*) HAUPT_NODE=0 ;; esac
  if [ -z "$NODE" ] || [ "$HAUPT_NODE" -lt 20 ]; then
    sage "Auf diesem Stick fehlt das Programm für den Mac."
  fi
fi

# Nicht annehmen, dass es geht - ausprobieren.
if ! "$NODE" -e '' >/dev/null 2>&1; then
  sage "macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen."
fi

# Weg vom Stick: Ein Arbeitsverzeichnis darauf hielte ihn beim Auswerfen fest.
cd / 2>/dev/null || true

# Der Starter schreibt „Neural OS startet …“, startet den Dienst ohne
# Fenster, öffnet den Browser und endet mit „Fertig. Dieses Fenster kann zu.“
# Läuft Neural OS schon, öffnet er nur den Browser. Scheitert etwas, steht
# der Grund schon da.
"$NODE" "$INHALT/app/bin/neural-os.js" start --hintergrund --open || halt
exit 0
