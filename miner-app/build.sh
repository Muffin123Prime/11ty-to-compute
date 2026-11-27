#!/bin/sh
# Baut die App für Windows, Linux und macOS in den Ordner dist/.
set -e
cd "$(dirname "$0")"
mkdir -p dist
# Adresse der Handy-Seite (status-site/), z. B. RELAY_URL=https://mein-name.netlify.app ./build.sh
X="-X main.relayURL=${RELAY_URL:-}"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H windowsgui $X" -o dist/KryptoMiner.exe .
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "-s -w $X" -o dist/kryptominer-linux .
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w $X" -o dist/kryptominer-mac .
ls -lh dist
