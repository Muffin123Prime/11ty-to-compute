#!/usr/bin/env python3
"""Synthetisiert Musikbett + Soundeffekte (lizenzfrei, selbst erzeugt) und mischt mit der Stimme."""
import json, subprocess, sys, wave
import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
tl_path, voice_wav, out_wav = sys.argv[1:4]
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
    "-ar", str(SR), "-ac", "1", "/tmp/voice_p.wav"], check=True)
with wave.open("/tmp/voice_p.wav") as w:
    v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
voice = np.zeros(N, dtype=np.float32); voice[: min(N, len(v))] = v[:N]

music = np.zeros(N, dtype=np.float32)
# Klangteppich: dunkle Akkord-Sinus mit langsamer Welle
pad = sum(np.sin(2 * np.pi * f * t + i) for i, f in enumerate([55, 55.25, 82.41, 110.2, 164.8, 220.4]))
pad *= (0.55 + 0.45 * np.sin(2 * np.pi * t / 9.0)) * 0.035
music += pad.astype(np.float32)

go_start = next(s["start"] for s in TL["scenes"] if s["id"] == "go")
# Pulsschlag (wird gegen Ende schneller)
b = 0.9
while b < D:
    per = 0.75 if b < go_start else 0.5
    tau = np.arange(int(0.5 * SR)) / SR
    k = np.sin(2 * np.pi * (45 * tau + 90 * (1 - np.exp(-25 * tau)) / 25)) * np.exp(-tau * 9) * (0.26 if b < go_start else 0.34)
    put(music, k.astype(np.float32), b); b += per
# Arpeggio (ab Sekunde 5 eingeblendet)
notes = [220.0, 261.63, 329.63, 392.0, 440.0, 523.25]
step = 0.375; b = 5.0; seq = 0
while b < D - 1:
    f = notes[int(rng.integers(0, len(notes)))] * (2 if (seq % 8 == 7) else 1)
    tau = np.arange(int(0.45 * SR)) / SR
    n_ = (np.sin(2 * np.pi * f * tau) + .3 * np.sin(4 * np.pi * f * tau)) * np.exp(-tau * 7) * 0.03 * min(1, (b - 5) / 4)
    put(music, n_.astype(np.float32), b); b += step; seq += 1

def boom(amp, dur=1.6, f0=38):
    tau = np.arange(int(dur * SR)) / SR
    x = np.sin(2 * np.pi * f0 * tau) * np.exp(-tau * 2.4)
    nz = lp(rng.standard_normal(len(tau)), 900) * np.exp(-tau * 7)
    return (amp * (x + 0.5 * nz)).astype(np.float32)
def whoosh(amp, dur=0.55, rising=True):
    tau = np.arange(int(dur * SR)) / SR; x = hp(lp(rng.standard_normal(len(tau)), 5500), 500)
    env = np.sin(np.pi * np.clip(tau / dur, 0, 1)) ** 2
    if not rising: env = env[::-1]
    return (amp * x * env).astype(np.float32)

fx = np.zeros(N, dtype=np.float32)
put(fx, boom(0.9, 2.2, 36), 0.28)                     # Einschlag zum Hook
put(fx, whoosh(0.55, 0.35), 0.0)
for sc in TL["scenes"][1:]:                            # Wischer vor jedem Schnitt
    put(fx, whoosh(0.35), max(0, sc["start"] - 0.35)); put(fx, boom(0.3, 0.7, 60), sc["start"])
for e in TL["events"]:
    if e["type"] == "stamp": put(fx, boom(0.7, 1.0, 70), e["t"])
    if e["type"] == "cta":
        put(fx, whoosh(0.5, 0.5, rising=False), e["t"] - 0.1); put(fx, boom(0.85, 2.0, 40), e["t"])

# Stimme senkt das Bett ab (Ducking)
env = lp(np.abs(voice), 8)
duck = 1 - 0.6 * np.clip(env / 0.07, 0, 1)
fade = np.clip((D - t) / 1.2, 0, 1)
mix = voice * 1.0 + music * duck * 1.0 * fade + fx * 0.8 * (0.35 + 0.65 * (1 - np.clip(env / 0.07, 0, 1)))
mix = mix / max(1.0, np.max(np.abs(mix)) / 0.92)
with wave.open(out_wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print("Audio fertig, %.1f s" % D)
