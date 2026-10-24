#!/usr/bin/env python3
"""Erzeugt Sprecherstimme (edge-tts) satzweise, misst Wortzeiten und schreibt timeline.json + voice.wav."""
import asyncio, base64, json, os, re, subprocess, sys, urllib.request, wave
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from align import align_words

SR = 44100
PROXY = os.environ.get("HTTPS_PROXY")
ep_path, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
ep = json.load(open(ep_path, encoding="utf-8"))

def load_wav(path):
    with wave.open(path) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return a

def gemini_tts(i, text):
    """Google Gemini Sprachausgabe: steuerbar per Stil-Satz (z.B. rau, spannend). Braucht GEMINI_API_KEY."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY fehlt: in den Einstellungen der Umgebung hinterlegen")
    style = ep.get("style", "")
    import hashlib
    h = hashlib.sha1(f"{ep.get('gemini_voice')}|{style}|{ep.get('gemini_models')}|{text}".encode()).hexdigest()[:10]
    cache = f"{out}/s{i:02d}_gem_{h}.wav"   # Zwischenspeicher: gleiche Eingabe wird nicht neu angefragt
    if os.path.exists(cache):
        return cache
    prompt = f"{style}: {text}" if style else text
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": ep.get("gemini_voice", "Algenib")}}}}}
    last = None
    for model in ep.get("gemini_models", ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]):
        if model.startswith("gemini-3.8"):
            # Neue Schnittstelle: Text ist woertliches Transkript, Stil-Anweisung getrennt in speech_metadata
            url = "https://generativelanguage.googleapis.com/v1beta/interactions"
            b38 = {"model": model, "response_format": {"type": "audio"},
                   "generation_config": {"speech_config": [{"voice": ep.get("gemini_voice", "Algenib")}]},
                   "input": [{"type": "user_input", "content": [{"type": "text", "text": text,
                              "annotations": [{"type": "speech_metadata", "style": style}] if style else []}]}]}
            req = urllib.request.Request(url, data=json.dumps(b38).encode(),
                                         headers={"Content-Type": "application/json", "x-goog-api-key": key})
        else:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "x-goog-api-key": key})
        for attempt in range(8):
            try:
                resp = json.load(urllib.request.urlopen(req, timeout=180))
                if model.startswith("gemini-3.8"):
                    part = next(c for st in resp["steps"] for c in st.get("content", []) if c.get("type") == "audio")
                    part = {"data": part["data"], "mimeType": part.get("mime_type", part.get("mimeType", "audio/wav"))}
                else:
                    part = resp["candidates"][0]["content"]["parts"][0]["inlineData"]
                m = re.search(r"rate=(\d+)", part.get("mimeType", "")); rate = int(m.group(1)) if m else 24000
                data = base64.b64decode(part["data"])
                path = cache
                if data[:4] == b"RIFF":  # neuere Modelle (z.B. gemini-3.8-flash-tts) liefern fertige WAV-Dateien
                    open(path, "wb").write(data)
                else:                     # aeltere liefern rohes PCM (audio/L16)
                    with wave.open(path, "wb") as w:
                        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
                        w.writeframes(data)
                return path
            except Exception as e:
                last = e
                if '429' in str(e): break          # Tageskontingent erschoepft: naechstes Modell
                import time; time.sleep(3)
    raise RuntimeError(f"Gemini-Sprachausgabe fehlgeschlagen: {last}")

async def synth(i, text):
    if ep.get("provider") == "gemini":
        return await asyncio.to_thread(gemini_tts, i, text), []
    import edge_tts
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

def gemini_group(idxs):
    """Eine Anfrage fuer mehrere Saetze (spart Kontingent, gleichmaessigere Betonung); danach per Wortzeiten in Saetze schneiden."""
    sents = [ep["sentences"][i]["text"] for i in idxs]
    path = gemini_tts(idxs[0], " ".join(sents))
    if len(idxs) == 1:
        return [path]
    toks = [t for x in sents for t in x.split()]
    al = align_words(path, toks)
    bounds, k = [], 0
    for x in sents:
        n = len(x.split()); bounds.append((al[k]["s"], al[k + n - 1]["e"])); k += n
    cuts = []
    for j, (a, b) in enumerate(bounds):
        lo = 0.0 if j == 0 else (bounds[j - 1][1] + a) / 2
        hi = None if j == len(bounds) - 1 else (b + bounds[j + 1][0]) / 2
        cuts.append((lo, hi))
    outs = []
    for j, (i, (lo, hi)) in enumerate(zip(idxs, cuts)):
        cp = f"{out}/s{i:02d}_cut.wav"
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", path, "-ss", f"{lo:.3f}"] + (["-to", f"{hi:.3f}"] if hi else []) + [cp]
        subprocess.run(cmd, check=True); outs.append(cp)
    return outs

async def main():
    n = len(ep["sentences"])
    results = [None] * n
    if ep.get("provider") == "gemini" and (ep.get("group_by_scene") or ep.get("group_size")):
        if ep.get("group_size"):      # feste Anzahl Saetze pro Anfrage (spart Kontingent, eine Stimme aus einem Guss)
            k = int(ep["group_size"]); groups = [list(range(i, min(n, i + k))) for i in range(0, n, k)]
        else:                         # nach Szene gruppieren
            groups, cur = [], [0]
            for i in range(1, n):
                if ep["sentences"][i]["scene"] == ep["sentences"][i - 1]["scene"]: cur.append(i)
                else: groups.append(cur); cur = [i]
            groups.append(cur)
        for g in groups:
            for i, pth in zip(g, await asyncio.to_thread(gemini_group, g)):
                results[i] = (pth, [])
        return results
    for i, s in enumerate(ep["sentences"]):
        results[i] = await synth(i, s["text"])
    return results

results = asyncio.run(main())

t = ep.get("start_offset", 0.5)
chunks = [np.zeros(int(t * SR), dtype=np.float32)]
sentences = []
for i, (s, (mp3, bwords)) in enumerate(zip(ep["sentences"], results)):
    wav = f"{out}/s{i:02d}_raw.wav"
    tempo = float(ep.get("tempo", 1.0))  # Sprechtempo per ffmpeg (Tonhoehe bleibt gleich)
    af = ["-af", f"atempo={tempo}"] if tempo != 1.0 else []
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, *af, "-ac", "1", "-ar", str(SR), wav], check=True)
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
    if ep.get("align", "whisper") == "whisper":
        trim = f"{out}/s{i:02d}.wav"
        with wave.open(trim, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
        for tok, x in zip(toks, align_words(trim, toks)):
            words.append({"w": tok, "s": float(x["s"]), "e": float(x["e"])})
    elif len(bwords) == len(toks):
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
                      "boundary_ok": ep.get("align", "whisper") == "whisper" or len(bwords) == len(toks)})
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
    if sc["id"] in ep.get("scenes", {}): sc["visual"] = ep["scenes"][sc["id"]]   # generische Szene aus der Episodendatei
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
    if s["event"] and s["event"] not in ("stamp", "cta"):   # frei benennbare Ereignisse (z.B. shock) am Satzende
        events.append({"type": s["event"], "t": s["end"] - 0.35})
tl = {"id": ep["id"], "series": ep["series"], "part": ep["part"], "title": ep["title"], "label": ep.get("label", ep["series"]), "audio": ep.get("audio", "story"), "date": ep.get("date", ""), "look": ep.get("look", "illu"), "accent_color": ep.get("accent_color", "#111111"), "credits": (json.load(open(ep["credits_file"], encoding="utf-8")) if ep.get("credits_file") and os.path.exists(ep["credits_file"]) else ep.get("credits", {})),
      "duration": total, "sentences": sentences, "scenes": scenes, "events": events}
json.dump(tl, open(f"{out}/timeline.json", "w", ensure_ascii=False and None or None, ) if False else open(f"{out}/timeline.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("Dauer gesamt: %.1f s" % total)
for s in sentences:
    print("%5.1f-%5.1f %s %s" % (s["start"], s["end"], "ok " if s["boundary_ok"] else "~  ", s["text"][:60]))
