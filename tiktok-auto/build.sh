#!/usr/bin/env bash
# Baut eine Folge komplett: ./build.sh episodes/ki_01.json
set -euo pipefail
EP="$1"; ID=$(python3 -c "import json,sys;print(json.load(open('$EP'))['id'])"); OUT="out/$ID"
PY="${TTS_PY:-python3}"; export PW_PATH="${PW_PATH:-/opt/node-tools/node_modules/playwright}"
export SSL_CERT_FILE="${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt}"
$PY tools/make_voice.py "$EP" "$OUT"
$PY tools/make_audio.py "$OUT/timeline.json" "$OUT/voice.wav" "$OUT/audio.wav"
node render/render.mjs "$OUT/timeline.json" "$OUT/video_silent.mp4" --html render/anim_illu.html
ffmpeg -v error -y -i "$OUT/video_silent.mp4" -i "$OUT/audio.wav" \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11" -ac 2 -c:v copy -c:a aac -b:a 192k -movflags +faststart -shortest "$OUT/$ID.mp4"
echo "Fertig: $OUT/$ID.mp4"
