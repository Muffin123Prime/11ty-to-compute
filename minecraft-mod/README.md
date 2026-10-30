# PrivateCheats – Fabric-Client-Mod für Minecraft 26.3

Client-Mod für den eigenen privaten Server. Läuft nur beim Spieler, der Server braucht nichts.

## Download / Installation

1. Fabric Loader für Minecraft **26.3** installieren (https://fabricmc.net/use/installer/).
2. **Fabric API** für 26.3 herunterladen (https://modrinth.com/mod/fabric-api) und in den `mods`-Ordner legen.
3. `privatecheats-<version>.jar` aus dem GitHub-Release **minecraft-mod-latest** in den `mods`-Ordner legen.
4. Minecraft mit dem Fabric-Profil starten.

## Menü

**Taste F6** öffnet das Mod-Menü (oben links im Spiel steht immer die aktuell gebundene Taste). Links stehen die Client-Cheats als Schalter, rechts die Server-Cheats.

Server-Cheats (Unsterblich, One-Hit, 1000 Herzen, Effekte, Items, Gamemode, Tag/Nacht) werden als
`/effect`-, `/attribute`-, `/give`- und `/gamemode`-Befehle an den Server geschickt. Das klappt nur, wenn ihr
auf eurem Server **OP** seid (`/op <name>` in der Server-Konsole). Ohne OP kann keine Client-Mod Leben oder
Schaden ändern, das entscheidet immer der Server.

## Tasten

Alle Tasten könnt ihr jederzeit ändern: *Optionen → Steuerung → Tastenbelegung*, Abschnitt **PrivateCheats**.

| Taste | Funktion |
|-------|----------|
| F6 | Mod-Menü öffnen |
| X | X-Ray – nur Erze, Kisten, Spawner usw. werden gerendert (schaltet automatisch Fullbright mit ein) |
| N | Fullbright – alles hell (clientseitige Nachtsicht) |
| K | Fly – Fliegen wie im Kreativmodus (der Server braucht `allow-flight=true` in der `server.properties`, sonst kickt er) |
| V | ESP – Spieler und Mobs leuchten durch Wände |
| B | Speed – schneller laufen (Multiplikator in der Config) |
| G | sendet `/gamemode creative` bzw. `/gamemode survival` – funktioniert nur, wenn ihr auf dem Server OP seid |

Oben links im Bild steht, welche Funktionen gerade aktiv sind.

## Config

Beim ersten Start wird `config/privatecheats.json` angelegt. Dort könnt ihr die X-Ray-Blockliste,
die Fluggeschwindigkeit, den Speed-Multiplikator und ESP-Optionen ändern. Die Liste wird bei jedem Einschalten von X-Ray neu geladen.

## Selbst bauen

```
cd minecraft-mod
./gradlew build
```
Die Datei liegt danach in `build/libs/`. Benötigt Java 25.
