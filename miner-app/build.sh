#!/bin/sh
# Baut die App für Windows, Linux und macOS in den Ordner dist/.
set -e
cd "$(dirname "$0")"
mkdir -p dist
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/KryptoMiner.exe .
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/kryptominer-linux .
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/kryptominer-mac .
ls -lh dist
