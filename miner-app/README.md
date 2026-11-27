# KryptoMiner

Eine kleine Start-App, mit der du auf deinem eigenen PC Monero (XMR) minen kannst:
App starten, einmal die Wallet-Adresse eintragen, auf „Mining starten“ klicken.

## Was die App macht

- Lädt beim ersten Start den Open-Source-Miner [XMRig](https://github.com/xmrig/xmrig)
  von dessen offizieller GitHub-Seite und prüft die Prüfsumme des Downloads.
- Startet und stoppt den Miner im Hintergrund.
- Zeigt Hashrate, Verlauf, Laufzeit, angenommene Shares und (bei SupportXMR)
  Guthaben und Auszahlungen, auch grob in Euro.
- Drei Leistungsstufen; „Maximal“ nutzt die gesamte Rechenleistung. Unter Windows
  kann sich die App mit Administratorrechten neu starten, damit XMRig Huge Pages
  und das MSR-Feintuning nutzen kann.
- Handy-Seite: Die App meldet ihren Stand alle 30 Sekunden an eine kleine
  Website (`status-site/`). Der QR-Code in der App führt dorthin; die Seite ist
  von überall erreichbar. Die Wallet-Adresse wird nie übertragen.

Die Oberfläche öffnet sich im Browser unter `http://127.0.0.1:47821/` und ist nur
von deinem eigenen PC aus erreichbar.

## Benutzung (Windows)

1. `KryptoMiner.exe` doppelklicken. Der Browser öffnet die Oberfläche.
2. Monero-Adresse eintragen (eine Wallet bekommst du auf <https://www.getmonero.org/downloads/>).
3. „Mining starten“ klicken.

Zum Beenden oben rechts „App beenden“ klicken. Das Schließen des Browserfensters
beendet das Mining nicht.

## Gut zu wissen

- **Virenschutz:** Windows Defender und andere Scanner stufen Mining-Programme als
  „potenziell unerwünscht“ ein und löschen XMRig häufig. Lege dann eine Ausnahme
  für den Datenordner an (`%AppData%\KryptoMiner`; der genaue Pfad steht in der App
  unter „Hinweise und Hilfe“).
- **Ertrag:** Ein normaler PC verdient meist nur wenige Cent pro Tag, oft weniger
  als der Strom kostet.
- **Nur auf eigenen Geräten** verwenden, nicht auf Firmen-, Schul- oder Cloud-Rechnern.
- XMRig behält 1 % der Rechenzeit als Spende für seine Entwickler ein.

## Selbst bauen

Benötigt [Go](https://go.dev/dl/) ab Version 1.22, sonst nichts:

```sh
RELAY_URL=https://kryptominer-status.netlify.app ./build.sh
```

`RELAY_URL` ist die Adresse der Handy-Seite. Ohne sie wird die App ohne
Handy-Ansicht gebaut.

## Handy-Seite (`status-site/`)

Eine statische Seite mit zwei Netlify-Funktionen und Netlify Blobs als Speicher:
`POST /api/push` nimmt den Stand der App entgegen, `GET /api/status?id=…` liefert
ihn an die Seite. Die App weist sich mit einem geheimen Schlüssel aus; die Kennung
im Link ist dessen Prüfsumme, sodass der Link nur lesen, aber nicht schreiben kann.
In Netlify als Basisverzeichnis `miner-app/status-site` einstellen.

Die fertigen Programme liegen danach in `dist/`.
