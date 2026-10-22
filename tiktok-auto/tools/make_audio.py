#!/usr/bin/env python3
"""Synthetisiert Musikbett + Soundeffekte (lizenzfrei, selbst erzeugt) und mischt mit der Stimme."""
import json, subprocess, sys, wave
import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
tl_path, voice_wav, out_wav = sys.argv[1:4]
VP = out_wav + '.voice_p.wav'
TL = json.load(open(tl_path, encoding="utf-8"))
D = TL["duration"]; N = int(D * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(11)

def lp(x, f): return sosfilt(butter(2, f, "low", fs=SR, output="sos"), x)
def hp(x, f): return sosfilt(butter(2, f, "high", fs=SR, output="sos"), x)
def put(buf, sig, at):
    i = int(at * SR)
    if i >= len(buf): return
    j = min(len(buf), i + len(sig)); buf[i:j] += sig[: j - i]

# Stimme vorbereiten (ffmpeg: Hochpass, Kompression, leichte Praesenz)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", voice_wav, "-af",
    "highpass=f=80,acompressor=threshold=-21dB:ratio=3.2:attack=4:release=90,equalizer=f=2800:t=q:w=1:g=2.5,equalizer=f=160:t=q:w=1:g=2,loudnorm=I=-15:TP=-2",
    "-ar", str(SR), "-ac", "1", VP], check=True)
with wave.open(VP) as w:
    v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
voice = np.zeros(N, dtype=np.float32); voice[: min(N, len(v))] = v[:N]

music = np.zeros(N, dtype=np.float32)
# Klangteppich: weicher Drone, darueber ein leiser Puls (Herzschlag-Tempo), der zum Ende hin dichter wird
pad = sum(np.sin(2 * np.pi * f * t + i) for i, f in enumerate([55, 82.41, 110.2, 164.8, 220.4]))
pad *= (0.6 + 0.4 * np.sin(2 * np.pi * t / 11.0)) * 0.011
music += pad.astype(np.float32)
NEWS = TL.get("audio") == "news"
BPM = 120 if NEWS else 104; beat = 60.0 / BPM
if NEWS:   # Nachrichten-Signet: drei aufsteigende Toene, dann ein tiefer Akzent
    for k, (f, at) in enumerate([(440, 0.05), (554, 0.25), (659, 0.45)]):
        tau = np.arange(int(0.5 * SR)) / SR
        put(music, (0.09 * np.sin(2 * np.pi * f * tau) * np.exp(-tau * 5)).astype(np.float32), at)
    tau = np.arange(int(0.8 * SR)) / SR
    put(music, (0.12 * np.sin(2 * np.pi * 110 * tau) * np.exp(-tau * 4)).astype(np.float32), 0.65)
def sub_pulse(amp):
    tau = np.arange(int(0.26 * SR)) / SR
    return (amp * np.sin(2 * np.pi * 52 * tau) * np.exp(-tau * 14)).astype(np.float32)
def hat(amp):
    tau = np.arange(int(0.04 * SR)) / SR
    return (amp * hp(rng.standard_normal(len(tau)), 6000) * np.exp(-tau * 120)).astype(np.float32)
k = 0
while k * beat < D - 1.5:
    at = k * beat; grow = 0.55 + 0.45 * at / D       # Spannung steigt
    put(music, sub_pulse((0.045 if NEWS else 0.075) * grow * (1.0 if k % 2 == 0 else 0.7)), at)
    if k % 2 == 1: put(music, hat(0.014 * grow), at + beat / 2)
    k += 1

def pop(amp=0.07, f0=880):
    tau = np.arange(int(0.16 * SR)) / SR
    return (amp * np.sin(2 * np.pi * (f0 * tau - 900 * tau ** 2)) * np.exp(-tau * 30)).astype(np.float32)
def tick(amp=0.05):
    tau = np.arange(int(0.05 * SR)) / SR
    return (amp * hp(rng.standard_normal(len(tau)), 2500) * np.exp(-tau * 90)).astype(np.float32)
def soft_whoosh(amp=0.05, dur=0.5):
    tau = np.arange(int(dur * SR)) / SR; x = hp(lp(rng.standard_normal(len(tau)), 4500), 600)
    return (amp * x * np.sin(np.pi * np.clip(tau / dur, 0, 1)) ** 2).astype(np.float32)
def thump(amp=0.16):
    tau = np.arange(int(0.35 * SR)) / SR
    return (amp * np.sin(2 * np.pi * 95 * tau) * np.exp(-tau * 12)).astype(np.float32)
def boom(amp=0.14):
    tau = np.arange(int(0.7 * SR)) / SR
    return (amp * np.sin(2 * np.pi * (48 * tau + 30 * np.exp(-tau * 9))) * np.exp(-tau * 6)).astype(np.float32)
def chime(amp=0.05):
    tau = np.arange(int(0.9 * SR)) / SR
    return (amp * (np.sin(2 * np.pi * 880 * tau) + 0.6 * np.sin(2 * np.pi * 1320 * tau)) * np.exp(-tau * 4.5)).astype(np.float32)
def riser(amp=0.09, dur=2.6):
    tau = np.arange(int(dur * SR)) / SR; u = tau / dur
    noise = hp(lp(rng.standard_normal(len(tau)), 7000), 300) * 0.6
    tone = np.sin(2 * np.pi * (180 * tau + 260 * tau ** 2 / dur))      # steigender Ton
    return (amp * (noise + 0.5 * tone) * u ** 2).astype(np.float32)
def dissonant_hit(amp=0.15):
    tau = np.arange(int(0.9 * SR)) / SR
    return (amp * (np.sin(2 * np.pi * 110 * tau) + np.sin(2 * np.pi * 116.5 * tau) + 0.4 * np.sin(2 * np.pi * 73 * tau)) / 2.4 * np.exp(-tau * 4)).astype(np.float32)

# Einblendungen je Szene (Sekunden ab Szenenstart): leises Pop; Chat-Nachrichten: leises Tippen
OVERLAYS = {"hook": [0.5, 3.7], "question": [0.25], "turing": [0.0, 0.7, 1.9], "test": [0.0],
            "eliza": [0.15, 6.2], "chess": [0.4, 0.8], "go": [0.1, 1.0, 3.8]}
CHAT = {"eliza": [0.9, 2.1, 3.4, 4.7, 6.4]}
fx = np.zeros(N, dtype=np.float32)
for sc in TL["scenes"]:
    st = sc["start"]
    if sc is not TL["scenes"][0]:
        put(fx, soft_whoosh(0.09, 0.55), max(0, st - 0.35)); put(fx, boom(0.12), st)   # Szenenwechsel: Whoosh + weicher Bass
    for o in OVERLAYS.get(sc["id"], []):
        if st + o < (sc["end"] or D): put(fx, pop(), st + o)
    for o in CHAT.get(sc["id"], []):
        put(fx, tick(0.06), st + o); put(fx, tick(0.04), st + o + 0.09); put(fx, pop(0.05, 1100), st + o + 0.2)
scene_starts = {round(sc["start"], 2) for sc in TL["scenes"]}
for s_ in TL["sentences"]:
    if not any(abs(s_["start"] - x) < 0.3 for x in scene_starts):
        put(fx, soft_whoosh(0.035, 0.3), max(0, s_["start"] - 0.15))                      # Satzstart: kleiner Luftzug
    acc = {a.lower().strip(".,:;!?") for a in s_.get("accent", [])}
    for w in s_["words"]:
        if w["w"].lower().strip(".,:;!?") in acc:
            put(fx, pop(0.035, 620), w["s"])                                                  # betontes Wort: leiser Akzent
for e in TL["events"]:
    if e["type"] == "stamp": put(fx, thump(), e["t"]); put(fx, chime(0.04), e["t"] + 0.05)
    if e["type"] == "shock": put(fx, dissonant_hit(), e["t"])
    if e["type"] == "cta":
        put(fx, riser(), max(0, e["t"] - 2.6)); put(fx, boom(0.16), e["t"]); put(fx, chime(0.06), e["t"])

# Stimme senkt das Bett ab (Ducking)
env = lp(np.abs(voice), 8)
duck = 1 - 0.6 * np.clip(env / 0.07, 0, 1)
fade = np.clip((D - t) / 1.2, 0, 1)
mix = voice * 1.0 + music * duck * fade + fx * (0.5 + 0.5 * (1 - np.clip(env / 0.07, 0, 1)))
mix = mix / max(1.0, np.max(np.abs(mix)) / 0.92)
with wave.open(out_wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print("Audio fertig, %.1f s" % D)
