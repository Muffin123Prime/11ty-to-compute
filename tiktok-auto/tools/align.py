#!/usr/bin/env python3
"""Wortgenaue Zeiten fuer beliebige Sprecher-Audios (faster-whisper, lokal, kostenlos)."""
import difflib, re, subprocess
import numpy as np
_model = None
def _norm(w): return re.sub(r"[^a-zäöüß0-9]", "", w.lower())
def _load16k(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)
def align_words(wav_path, tokens, model_size="small"):
    """tokens: Woerter des Skripts. Rueckgabe: Liste {w,s,e} in Sekunden (relativ zum Audio)."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segs, _ = _model.transcribe(_load16k(wav_path), language="de", word_timestamps=True, vad_filter=False, beam_size=5)
    heard = [(w.word.strip(), w.start, w.end) for s in segs for w in s.words]
    a = [_norm(t) for t in tokens]; b = [_norm(h[0]) for h in heard]
    out = [None] * len(tokens)
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1): out[i1 + k] = (heard[j1 + k][1], heard[j1 + k][2])
        elif tag == "replace" and (i2 - i1) == (j2 - j1):
            for k in range(i2 - i1): out[i1 + k] = (heard[j1 + k][1], heard[j1 + k][2])
    # Luecken (nicht erkannte Woerter) zwischen bekannten Nachbarn gleichmaessig verteilen
    n = len(tokens); i = 0
    t_end = heard[-1][2] if heard else 0.0
    while i < n:
        if out[i] is None:
            j = i
            while j < n and out[j] is None: j += 1
            lo = out[i - 1][1] if i > 0 else 0.0
            hi = out[j][0] if j < n else t_end
            if hi <= lo: hi = lo + 0.2 * (j - i)
            step = (hi - lo) / (j - i)
            for k in range(i, j): out[k] = (lo + (k - i) * step, lo + (k - i + 1) * step)
            i = j
        else: i += 1
    return [{"w": tokens[k], "s": out[k][0], "e": out[k][1]} for k in range(n)]
