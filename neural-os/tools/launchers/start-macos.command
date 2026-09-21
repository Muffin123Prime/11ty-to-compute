#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS - Starter für macOS
#
#  Wird beim Vorbereiten des Sticks als "Neural OS starten.command" in den
#  Stick-Ordner gelegt. Die Endung .command sorgt dafür, dass der Finder das
#  Skript beim Doppelklick im Terminal ausführt.
#
#  Zwei Eigenheiten von macOS, die hier abgefangen werden:
#   - Gatekeeper markiert alles, was von einem fremden Medium kommt, mit dem
#     Merkmal "com.apple.quarantine". Ein Doppelklick wird dann abgelehnt. Das
#     Merkmal wird unten vom mitgelieferten Node-Programm entfernt; für den
#     Starter selbst muss der Nutzer einmal Rechtsklick -> Öffnen wählen.
#   - Apple-Silicon-Macs führen x86_64-Programme über Rosetta aus. Fehlt die
#     arm64-Laufzeit, ist die x64-Laufzeit deshalb ein gültiger Ausweg.
#
#  POSIX sh, kein bash: /bin/sh ist auf jedem Mac vorhanden und dieser Starter
#  darf an nichts scheitern, was auf dem fremden Rechner fehlen könnte.
# ---------------------------------------------------------------------------
set -u

DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR" || exit 1

halt() {
  echo ""
  printf "Zum Schliessen dieses Fensters die Eingabetaste drücken ... "
  read -r _dummy 2>/dev/null || true
  exit "${1:-1}"
}

case "$(uname -m)" in
  arm64)  PLAT="darwin-arm64"; FALLBACK="darwin-x64" ;;
  x86_64) PLAT="darwin-x64";   FALLBACK="" ;;
  *)      PLAT="darwin-$(uname -m)"; FALLBACK="" ;;
esac

NODE="$DIR/runtime/$PLAT/node"
USED="$PLAT"
if [ ! -f "$NODE" ] && [ -n "$FALLBACK" ] && [ -f "$DIR/runtime/$FALLBACK/node" ]; then
  NODE="$DIR/runtime/$FALLBACK/node"
  USED="$FALLBACK (über Rosetta)"
fi

if [ ! -f "$NODE" ]; then
  # Letzter Ausweg: ein installiertes Node auf diesem Mac.
  SYSTEM_NODE=$(command -v node 2>/dev/null || true)
  SYSTEM_MAJOR=0
  if [ -n "$SYSTEM_NODE" ]; then
    SYSTEM_MAJOR=$("$SYSTEM_NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  if [ -n "$SYSTEM_NODE" ] && [ "$SYSTEM_MAJOR" -ge 20 ] 2>/dev/null; then
    NODE="$SYSTEM_NODE"
    USED="installiertes Node.js ($SYSTEM_MAJOR)"
    echo "Hinweis: Auf dem Stick liegt keine Laufzeit für $PLAT."
    echo "         Es wird das auf diesem Mac installierte Node.js benutzt."
    echo ""
  else
    echo ""
    echo "  Neural OS kann auf diesem Mac nicht starten."
    echo ""
    echo "  Es fehlt die Laufzeitumgebung für:  $PLAT"
    echo "  Gesucht wurde hier:                 $DIR/runtime/$PLAT/node"
    echo ""
    echo "  Der Stick wurde also auf einem Rechner mit einem anderen"
    echo "  Betriebssystem oder einer anderen Prozessorarchitektur vorbereitet."
    echo ""
    echo "  So legst du die fehlende Laufzeit nach:"
    echo "    1. Stick in einen Mac stecken, auf dem Neural OS schon läuft."
    echo "       Dort in der Seitenleiste den Bereich \"Stick\" öffnen (oder"
    echo "       g dann t), den Pfad des Sticks eintragen und unter \"Welche"
    echo "       Rechner der Stick starten kann\" bei diesem System auf"
    echo "       \"Jetzt kopieren\" klicken. Das braucht kein Internet."
    echo "    2. Oder: auf einem Rechner MIT Internet denselben Bereich öffnen"
    echo "       und dort die Laufzeit \"$PLAT\" holen; sie wird dann als"
    echo "       offizielles Node-Paket geladen und geprüft."
    echo "    3. Oder: Node.js ab Version 20 installieren (nodejs.org) und in"
    echo "       diesem Ordner ausführen:"
    echo "           node app/bin/neural-os.js start --open"
    echo ""
    halt 1
  fi
fi

if [ ! -f "$DIR/app/bin/neural-os.js" ]; then
  echo ""
  echo "  Der Programmordner \"app\" fehlt auf dem Stick oder ist unvollständig."
  echo "  Gesucht wurde:  $DIR/app/bin/neural-os.js"
  echo ""
  echo "  Das passiert, wenn der Stick während des Kopierens abgezogen wurde."
  echo "  Stecke ihn in den Rechner, auf dem du ihn vorbereitet hast, und rufe"
  echo "  dort im Bereich \"Stick\" erst \"Stick prüfen\" und dann"
  echo "  \"Nur Programm erneuern\" auf. Deine Daten in \"data\" sind davon"
  echo "  nicht betroffen - die werden beim Erneuern nie angefasst."
  echo ""
  halt 1
fi

# Gatekeeper: ohne das entfernte Quarantäne-Merkmal weigert sich macOS, das
# mitgelieferte Node zu starten ("kann nicht geöffnet werden, da der
# Entwickler nicht verifiziert werden kann"). Schlägt es fehl, ist das kein
# Grund abzubrechen - dann war meist gar kein Merkmal gesetzt.
if [ -x "$(command -v xattr || echo /usr/bin/xattr)" ] 2>/dev/null; then
  xattr -d com.apple.quarantine "$NODE" 2>/dev/null || true
  xattr -d com.apple.quarantine "$0" 2>/dev/null || true
fi

chmod +x "$NODE" 2>/dev/null || true

if ! "$NODE" -e '' >/dev/null 2>&1; then
  echo ""
  echo "  Die Laufzeit auf dem Stick liess sich nicht starten."
  echo "  ($NODE)"
  echo ""
  echo "  Mögliche Gründe:"
  echo "    - macOS hat das Programm blockiert. Öffne die Systemeinstellungen,"
  echo "      \"Datenschutz & Sicherheit\", und erlaube dort den Start."
  echo "    - Der Stick ist ohne Ausführungsrechte eingehängt. Kopiere dann den"
  echo "      ganzen Ordner auf den Schreibtisch und starte ihn von dort."
  echo ""
  halt 1
fi

echo ""
echo "  Neural OS wird gestartet ..."
echo ""
echo "  Laufzeit:  $USED"
echo "  Daten:     $DIR/data"
echo ""
echo "  Gleich öffnet sich dein Browser. Dieses Fenster bitte offen lassen -"
echo "  solange es offen ist, läuft Neural OS. Beenden mit Strg+C."
echo ""

NEURAL_OS_HOME="$DIR/data"
export NEURAL_OS_HOME

"$NODE" "$DIR/app/bin/neural-os.js" start --open
CODE=$?

if [ "$CODE" -ne 0 ]; then
  echo ""
  echo "  Neural OS wurde mit Fehler $CODE beendet."
  echo ""
  echo "  Versuche es im abgesicherten Modus (ohne eigene Erweiterungen):"
  echo "      \"$NODE\" \"$DIR/app/bin/neural-os.js\" start --safe"
  echo ""
  echo "  Hilft das nicht, steht in LIESMICH.txt, was du sonst tun kannst."
  halt "$CODE"
fi

echo ""
echo "  Neural OS wurde beendet."
halt 0
