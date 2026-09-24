#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS – Probelauf für den Mac (Paket P, docs/STICK-BAUPLAN.md)
#
#  Ein Doppelklick beantwortet, was sich ohne Mac nicht prüfen lässt:
#  Gatekeeper, die Frage nach dem Wechseldatenträger, exFAT, x-Bit, Rosetta,
#  und ob ein Skript-.app vom Stick startet.
#
#  Diese Datei liegt byte-gleich an zwei Stellen: im Projektordner als
#  "Probelauf - Mac.command" (ohne vorbereiteten Stick) und als Vorlage
#  tools/launchers/probelauf-macos.command, die
#  "node tools/probelauf.js --auf-stick <Stick>" auf den Stick legt. Deshalb
#  sucht sie Skript und Node an beiden Orten, auf dem Stick zuerst.
#
#  POSIX sh, kein bash: /bin/sh gibt es auf jedem Mac, und ein Probelauf darf
#  an nichts scheitern, was auf dem fremden Rechner fehlen könnte.
# ---------------------------------------------------------------------------
set -u

HIER=$(cd -- "$(dirname -- "$0")" && pwd)
STARTER="$HIER/$(basename -- "$0")"

halt() {
  echo ""
  printf "Zum Schließen die Eingabetaste drücken … "
  read -r _egal 2>/dev/null || true
  exit 1
}

# Die mitgelieferte Node 22 verlangt macOS 11. Nur am Mac prüfen, damit die
# Datei zum Ausprobieren auch unter Linux läuft.
if [ "$(uname -s)" = "Darwin" ]; then
  VERSION=$(/usr/bin/sw_vers -productVersion 2>/dev/null || echo 0)
  HAUPT=${VERSION%%.*}
  case "$HAUPT" in ''|*[!0-9]*) HAUPT=0 ;; esac
  if [ "$HAUPT" -lt 11 ]; then
    echo "Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer."
    halt
  fi
fi

# Das Skript: Stick im neuen Aufbau, Stick im alten Aufbau, Projektordner.
SKRIPT=""
for S in "$HIER/Inhalt/probelauf.js" "$HIER/probelauf.js" "$HIER/tools/probelauf.js"; do
  if [ -f "$S" ]; then SKRIPT="$S"; break; fi
done
if [ -z "$SKRIPT" ]; then
  echo "Der Probelauf fehlt: probelauf.js wurde nicht gefunden."
  halt
fi

# Node wie der echte Starter: die Laufzeit auf dem Stick, auf Apple Silicon
# notfalls die x64-Laufzeit über Rosetta.
case "$(uname -m)" in
  arm64) EIGEN="darwin-arm64"; ANDERS="darwin-x64" ;;
  *)     EIGEN="darwin-x64";   ANDERS="" ;;
esac
NODE=""
for N in "$HIER/Inhalt/runtime/$EIGEN/node" "$HIER/runtime/$EIGEN/node"; do
  if [ -f "$N" ]; then NODE="$N"; break; fi
done
if [ -z "$NODE" ] && [ -n "$ANDERS" ]; then
  for N in "$HIER/Inhalt/runtime/$ANDERS/node" "$HIER/runtime/$ANDERS/node"; do
    if [ -f "$N" ]; then NODE="$N"; break; fi
  done
fi

# Kein Stick: wie "Neural OS starten.bat" im Projektordner. Erst node neben
# dieser Datei, dann ein entpackter node-v*-Ordner hier, eine Ebene höher
# oder in Downloads, zuletzt ein installiertes Node.
if [ -z "$NODE" ] && [ -f "$HIER/node" ]; then NODE="$HIER/node"; fi
if [ -z "$NODE" ]; then
  for D in "$HIER"/node-v* "$HIER"/../node-v* "$HOME"/Downloads/node-v*; do
    if [ -f "$D/bin/node" ]; then NODE="$D/bin/node"; break; fi
    if [ -f "$D/$(basename -- "$D")/bin/node" ]; then NODE="$D/$(basename -- "$D")/bin/node"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  for N in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$N" ] && [ -x "$N" ]; then NODE="$N"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  if [ -d "$HIER/Inhalt" ] || [ -d "$HIER/runtime" ]; then
    echo "Auf diesem Stick fehlt das Programm für den Mac."
  else
    echo "Node.js wurde nicht gefunden."
  fi
  halt
fi

# Vorher festhalten, was gleich geändert wird (Quarantäne, x-Bit). Sonst
# misst der Probelauf nur noch den Zustand nach dem Aufräumen.
q() { if /usr/bin/xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; then echo ja; else echo nein; fi; }
m() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null || echo "?"; }
VORHER="quarantaeneStarter=$(q "$STARTER");quarantaeneNode=$(q "$NODE");modusStarter=$(m "$STARTER");modusNode=$(m "$NODE")"

# Wie der echte Starter (Paket S): Quarantäne von der mitgebrachten Laufzeit
# nehmen und das x-Bit setzen. Ein installiertes Node bleibt unangetastet.
case "$NODE" in
  "$HIER"/*)
    /usr/bin/xattr -dr com.apple.quarantine "$(dirname -- "$NODE")" 2>/dev/null || true
    chmod +x "$NODE" 2>/dev/null || true
    ;;
esac

if ! "$NODE" -e '' >/dev/null 2>&1; then
  echo "macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen."
  halt
fi

echo "Probelauf startet …"
if "$NODE" "$SKRIPT" --start --ort "$HIER" --vorher "$VORHER"; then
  echo "Fertig. Dieses Fenster kann zu."
  exit 0
fi
halt
