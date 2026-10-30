# PrivateCheats – Fabric-Client-Mod für Minecraft 26.3

Client-Mod für den eigenen privaten Server. Läuft nur beim Spieler, der Server braucht nichts.

## Download / Installation

1. Fabric Loader für Minecraft **26.3** installieren (https://fabricmc.net/use/installer/).
2. **Fabric API** für 26.3 herunterladen (https://modrinth.com/mod/fabric-api) und in den `mods`-Ordner legen.
3. `privatecheats-<version>.jar` aus dem GitHub-Release **minecraft-mod-latest** in den `mods`-Ordner legen.
4. Minecraft mit dem Fabric-Profil starten.

## Tasten (im Menü *Steuerung* änderbar)

| Taste | Funktion |
|-------|----------|
| X | X-Ray – nur Erze, Kisten, Spawner usw. werden gerendert (schaltet automatisch Fullbright mit ein) |
| N | Fullbright – alles hell (clientseitige Nachtsicht) |
| K | Fly – Fliegen wie im Kreativmodus (der Server braucht `allow-flight=true` in der `server.properties`, sonst kickt er) |
| V | ESP – Spieler und Mobs leuchten durch Wände |
| G | sendet `/gamemode creative` bzw. `/gamemode survival` – funktioniert nur, wenn ihr auf dem Server OP seid |

Oben links im Bild steht, welche Funktionen gerade aktiv sind.

## Config

Beim ersten Start wird `config/privatecheats.json` angelegt. Dort könnt ihr die X-Ray-Blockliste,
die Fluggeschwindigkeit und ESP-Optionen ändern. Die Liste wird bei jedem Einschalten von X-Ray neu geladen.

## Selbst bauen

```
cd minecraft-mod
./gradlew build
```
Die Datei liegt danach in `build/libs/`. Benötigt Java 25.
