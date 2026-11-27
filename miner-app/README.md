# KryptoMiner

Eine kleine Start-App, mit der du auf deinem eigenen PC Monero (XMR) minen kannst:
App starten, einmal die Wallet-Adresse eintragen, auf „Mining starten“ klicken.

## Was die App macht

- Lädt beim ersten Start den Open-Source-Miner [XMRig](https://github.com/xmrig/xmrig)
  von dessen offizieller GitHub-Seite und prüft die Prüfsumme des Downloads.
- Startet und stoppt den Miner im Hintergrund.
- Zeigt Hashrate, angenommene Shares, Laufzeit und (bei SupportXMR) dein Pool-Guthaben.
- Einstellungen: CPU-Auslastung, Pause bei PC-Benutzung oder im Akkubetrieb,
  Mining beim App-Start, App-Start bei der Anmeldung.

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
./build.sh
```

Die fertigen Programme liegen danach in `dist/`.
