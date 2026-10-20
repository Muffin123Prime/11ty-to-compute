#!/usr/bin/env python3
"""Erzeugt Sprecherstimme (edge-tts) satzweise, misst Wortzeiten und schreibt timeline.json + voice.wav."""
import asyncio, json, os, subprocess, sys, wave, re
import numpy as np
import edge_tts

SR = 44100
PROXY = os.environ.get("HTTPS_PROXY")
ep_path, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
ep = json.load(open(ep_path, encoding="utf-8"))

def load_wav(path):
    with wave.open(path) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return a

async def synth(i, text):
    mp3 = f"{out}/s{i:02d}.mp3"
    last = None
    for attempt in range(4):
        try:
            comm = edge_tts.Communicate(text, ep["voice"], rate=ep.get("rate", "+0%"),
                                        pitch=ep.get("pitch", "+0Hz"), proxy=PROXY, boundary="WordBoundary")
            words = []
            with open(mp3, "wb") as f:
                async for ch in comm.stream():
                    if ch["type"] == "audio":
                        f.write(ch["data"])
                    elif ch["type"] == "WordBoundary":
                        words.append({"w": ch["text"], "s": ch["offset"] / 1e7, "d": ch["duration"] / 1e7})
            if os.path.getsize(mp3) > 1000:
                return mp3, words
        except Exception as e:
            last = e
            await asyncio.sleep(2)
    raise RuntimeError(f"TTS fehlgeschlagen: {last}")

async def main():
    results = []
    for i, s in enumerate(ep["sentences"]):
        results.append(await synth(i, s["text"]))
    return results

results = asyncio.run(main())

t = ep.get("start_offset", 0.5)
chunks = [np.zeros(int(t * SR), dtype=np.float32)]
sentences = []
for i, (s, (mp3, bwords)) in enumerate(zip(ep["sentences"], results)):
    wav = f"{out}/s{i:02d}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ac", "1", "-ar", str(SR), wav], check=True)
    a = load_wav(wav)
    thr = 0.012
    idx = np.where(np.abs(a) > thr)[0]
    lead = max(0, idx[0] - int(0.03 * SR)) if len(idx) else 0
    tail = min(len(a), idx[-1] + int(0.08 * SR)) if len(idx) else len(a)
    a = a[lead:tail]
    lead_s = lead / SR
    dur = len(a) / SR
    toks = s["text"].split()
    # Wortzeiten: aus Boundary-Daten, wenn Anzahl passt, sonst proportional zur Zeichenlaenge
    words = []
    if len(bwords) == len(toks):
        for tok, b in zip(toks, bwords):
            ws = max(0.0, b["s"] - lead_s)
            words.append({"w": tok, "s": ws, "e": ws + b["d"]})
    else:
        wts = [len(x) + 2 for x in toks]
        tot = sum(wts); acc = 0.0
        for tok, wt in zip(toks, wts):
            ws = dur * acc / tot; acc += wt
            words.append({"w": tok, "s": ws, "e": dur * acc / tot})
    for k, w in enumerate(words):  # lueckenlos machen
        if k + 1 < len(words):
            w["e"] = max(w["e"], min(words[k + 1]["s"], w["e"] + 0.2))
        w["s"] += t; w["e"] += t
    sentences.append({"text": s["text"], "scene": s["scene"], "accent": s.get("accent", []),
                      "event": s.get("event"), "start": t, "end": t + dur, "words": words,
                      "boundary_ok": len(bwords) == len(toks)})
    chunks.append(a)
    gap = s.get("gap_after", 0.22)
    chunks.append(np.zeros(int(gap * SR), dtype=np.float32))
    t += dur + gap

voice = np.concatenate(chunks)
total = len(voice) / SR + 1.4          # Nachlauf am Ende
voice = np.concatenate([voice, np.zeros(int(1.4 * SR), dtype=np.float32)])
with wave.open(f"{out}/voice.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(voice, -1, 1) * 32767).astype(np.int16).tobytes())

# Szenen aus aufeinanderfolgenden Saetzen
scenes = []
for i, s in enumerate(sentences):
    if scenes and scenes[-1]["id"] == s["scene"]:
        scenes[-1]["sentences"].append(i)
    else:
        scenes.append({"id": s["scene"], "sentences": [i]})
for k, sc in enumerate(scenes):
    first = sentences[sc["sentences"][0]]
    sc["start"] = 0.0 if k == 0 else max(0.0, first["start"] - 0.12)
    sc["end"] = total if k == len(scenes) - 1 else None
for k in range(len(scenes) - 1):
    scenes[k]["end"] = scenes[k + 1]["start"]

events = []
for i, s in enumerate(sentences):
    if s["event"] == "stamp":
        events.append({"type": "stamp", "t": s["end"] - 0.45})
    if s["event"] == "cta":
        events.append({"type": "cta", "t": s["start"] + 0.1})
tl = {"id": ep["id"], "series": ep["series"], "part": ep["part"], "title": ep["title"],
      "duration": total, "sentences": sentences, "scenes": scenes, "events": events}
json.dump(tl, open(f"{out}/timeline.json", "w", ensure_ascii=False and None or None, ) if False else open(f"{out}/timeline.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("Dauer gesamt: %.1f s" % total)
for s in sentences:
    print("%5.1f-%5.1f %s %s" % (s["start"], s["end"], "ok " if s["boundary_ok"] else "~  ", s["text"][:60]))
