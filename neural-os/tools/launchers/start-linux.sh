#!/bin/sh
# ---------------------------------------------------------------------------
#  Neural OS - Starter für Linux
#
#  Wird beim Vorbereiten des Sticks als "Neural OS starten.sh" in den
#  Stick-Ordner gelegt.
#
#  Das Ausführbar-Bit ist auf einem Stick der Normalfall-Stolperstein: FAT und
#  exFAT speichern es gar nicht, und viele Systeme hängen Wechselmedien mit
#  "noexec" ein. Deshalb prüft dieser Starter beides - erst das Bit (und setzt
#  es notfalls selbst), dann ob sich das Programm wirklich ausführen lässt -
#  und erklärt den Unterschied, statt einen rohen "Permission denied"
#  durchzureichen.
#
#  POSIX sh, kein bash: der fremde Rechner hat vielleicht nur dash.
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
  x86_64|amd64)  PLAT="linux-x64" ;;
  aarch64|arm64) PLAT="linux-arm64" ;;
  armv7l|armv7)  PLAT="linux-armv7l" ;;
  *)             PLAT="linux-$(uname -m)" ;;
esac

NODE="$DIR/runtime/$PLAT/node"
USED="$PLAT"

if [ ! -f "$NODE" ]; then
  # Letzter Ausweg: ein installiertes Node auf diesem Rechner.
  SYSTEM_NODE=$(command -v node 2>/dev/null || true)
  SYSTEM_MAJOR=0
  if [ -n "$SYSTEM_NODE" ]; then
    SYSTEM_MAJOR=$("$SYSTEM_NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  if [ -n "$SYSTEM_NODE" ] && [ "$SYSTEM_MAJOR" -ge 20 ] 2>/dev/null; then
    NODE="$SYSTEM_NODE"
    USED="installiertes Node.js ($SYSTEM_MAJOR)"
    echo "Hinweis: Auf dem Stick liegt keine Laufzeit für $PLAT."
    echo "         Es wird das auf diesem Rechner installierte Node.js benutzt."
    echo ""
  else
    echo ""
    echo "  Neural OS kann auf diesem Rechner nicht starten."
    echo ""
    echo "  Es fehlt die Laufzeitumgebung für:  $PLAT"
    echo "  Gesucht wurde hier:                 $DIR/runtime/$PLAT/node"
    echo ""
    echo "  Der Stick wurde also auf einem Rechner mit einem anderen"
    echo "  Betriebssystem oder einer anderen Prozessorarchitektur vorbereitet."
    echo ""
    echo "  So legst du die fehlende Laufzeit nach:"
    echo "    1. Stick an einem Rechner mit Neural OS und Internet einstecken."
    echo "       Dort unter Einstellungen -> Stick noch einmal auf"
    echo "       \"Stick vorbereiten\" tippen und \"Erlauben\" wählen. Dein Wissen"
    echo "       auf dem Stick bleibt dabei, wie es ist."
    echo "    2. Oder: Node.js ab Version 20 installieren (nodejs.org) und in"
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
  echo "  Stecke ihn an einem Rechner mit Neural OS ein und tippe dort unter"
  echo "  Einstellungen -> Stick auf \"Stick vorbereiten\". Deine Daten in"
  echo "  \"data\" sind davon nicht betroffen - die werden dabei nie angefasst."
  echo ""
  halt 1
fi

# Fehlt das Ausführbar-Bit, selbst setzen. Auf FAT/exFAT schlägt das fehl oder
# bleibt wirkungslos - das ist kein Grund abzubrechen, sondern wird durch den
# Probelauf unten abgefangen.
if [ ! -x "$NODE" ]; then
  echo "Das Ausführbar-Bit fehlt; es wird gesetzt ..."
  chmod +x "$NODE" 2>/dev/null || true
fi

if ! "$NODE" -e '' >/dev/null 2>&1; then
  echo ""
  echo "  Die Laufzeit auf dem Stick liess sich nicht starten."
  echo "  ($NODE)"
  echo ""
  echo "  Der häufigste Grund: der Stick ist mit der Option \"noexec\""
  echo "  eingehängt. Dann darf von ihm grundsätzlich kein Programm starten,"
  echo "  egal welche Rechte die Datei hat."
  echo ""
  echo "  Was hilft:"
  echo "    - Den ganzen Ordner auf die Festplatte kopieren und von dort"
  echo "      starten. Deine Daten in \"data\" kommen dabei mit."
  echo "    - Oder den Stick neu einhängen:"
  echo "          sudo mount -o remount,exec \"$DIR\""
  echo "    - Oder Node.js ab Version 20 installieren und hier ausführen:"
  echo "          node app/bin/neural-os.js start --open"
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
echo "  solange es offen ist, läuft Neural OS. Zum Aufhören in Neural OS"
echo "  unter Einstellungen -> Stick auf \"Beenden & abziehen\" tippen."
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

# Sauber beendet: nicht mehr auf die Eingabetaste warten. Solange dieses
# Skript lebt, liegt sein Arbeitsverzeichnis auf dem Stick, und das System
# meldet ihn beim Auswerfen als "in Verwendung". Also weg vom Stick und Ende.
cd / 2>/dev/null || true
echo ""
echo "  Neural OS wurde beendet. Alles ist gespeichert."
echo "  Jetzt kannst du den Stick abziehen."
echo ""
exit 0
