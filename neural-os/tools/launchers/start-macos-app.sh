#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS - Starter für macOS als Programm (Paket M)
#
#  Liegt auf dem Stick im Bündel „Neural OS starten - Mac.app“; der Finder
#  zeigt es als „Neural OS starten - Mac“. Doppelklick: kein Terminal-Fenster.
#  Neural OS startet im Hintergrund, der Browser geht auf. Geht etwas nicht,
#  steht der Grund in einem Dialog, der bis „OK“ offen bleibt
#  (docs/STICK-BAUPLAN.md, 1.3 und 2.13).
#
#  Notausgang, falls macOS das Programm nicht öffnet: im Ordner „Inhalt“
#  „Notstart - Mac“ doppelklicken -- derselbe Start im Terminal.
#
#  POSIX sh, kein bash: /bin/sh ist auf jedem Mac da.
# ---------------------------------------------------------------------------
set -u

# Contents/MacOS/<dieses Skript> -> das Bündel -> der Ordner, in dem es liegt.
APP=$(cd -- "$(dirname -- "$0")/../.." 2>/dev/null && pwd) || exit 1
DIR=$(dirname -- "$APP")

# Ein Satz in einem Dialog. Der Text geht als Argument hinein, nie in den
# Quelltext des AppleScripts: so stört kein Anführungszeichen darin.
sage() {
  osascript \
    -e 'on run argv' \
    -e 'display alert "Neural OS" message (item 1 of argv) as critical buttons {"OK"} default button "OK"' \
    -e 'end run' "$1" >/dev/null 2>&1 || true
  exit 1
}

# App Translocation: Ein Bündel mit Quarantäne-Merkmal startet macOS aus
# einer schreibgeschützten Kopie an anderem Ort -- dort ist kein Stick.
case "$APP" in
  */AppTranslocation/*)
    sage "macOS hat diesen Starter vom Stick getrennt. Auf dem Stick im Ordner „Inhalt“ „Notstart - Mac“ doppelklicken." ;;
esac

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
  # Gatekeeper: Was von einem fremden Datenträger kommt, kann das Merkmal
  # com.apple.quarantine tragen, und dann verweigert macOS den Start der
  # Laufzeit. Fehlt das Merkmal, ist das kein Fehler.
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

# Der Starter startet den Dienst ohne Fenster und öffnet den Browser; läuft
# Neural OS schon, öffnet er nur den Browser. Der Dienst selbst hängt an
# keiner Ausgabe hier (stdio ignore), also kehrt das sofort zurück, wenn er
# bereit ist. Scheitert es, steht der Grund in den letzten Zeilen.
AUSGABE=$("$NODE" "$INHALT/app/bin/neural-os.js" start --hintergrund --open 2>&1)
CODE=$?
if [ "$CODE" -ne 0 ]; then
  # Die Fortschrittszeilen („Neural OS startet …“) gehören nicht in den
  # Dialog; „Neural OS startet gerade; …“ ist dagegen ein Grund und bleibt.
  GRUND=$(printf '%s\n' "$AUSGABE" | sed -e '/^[[:space:]]*$/d' -e '/^Neural OS startet …/d' | tail -n 3)
  sage "${GRUND:-Neural OS ließ sich nicht starten.}"
fi
exit 0
