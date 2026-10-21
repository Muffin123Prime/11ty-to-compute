#!/usr/bin/env bash
# Tageslauf in einer frischen Cloud-Sitzung: Umgebung herrichten, dann tools/daily.py.
set -euo pipefail
cd "$(dirname "$0")"
export SSL_CERT_FILE="${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt}"
export PW_PATH="${PW_PATH:-/opt/node-tools/node_modules/playwright}"
VENV="${HOME}/venv-tt"
if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c "import edge_tts, numpy, scipy, faster_whisper" 2>/dev/null; then
  python3 -m venv "$VENV" && "$VENV/bin/pip" install -q edge-tts numpy scipy faster-whisper
fi
export TTS_PY="$VENV/bin/python"
for v in TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET TIKTOK_REDIRECT_URI GEMINI_API_KEY; do
  [ -n "${!v:-}" ] || { echo "Fehlt: $v"; exit 1; }
done
[ -n "${TIKTOK_REFRESH_TOKEN:-}" ] || [ -f .secrets/tiktok_token.json ] || { echo "Fehlt: TIKTOK_REFRESH_TOKEN (oder .secrets/tiktok_token.json)"; exit 1; }
python3 tools/daily.py "$@"
