#!/usr/bin/env python3
"""Tageslauf: nimmt das erste Thema mit Status 'bereit' aus themen.json, baut die Folge, lädt sie als TikTok-Entwurf hoch,
setzt den Status auf 'hochgeladen' und sichert themen.json per git.

  python3 tools/daily.py            # echter Lauf
  python3 tools/daily.py --dry      # baut, lädt nicht hoch, ändert nichts
  python3 tools/daily.py --next     # zeigt nur, was als Nächstes dran wäre

Rückgabewerte: 0 fertig, 3 kein Thema mit Status 'bereit' (dann muss erst eine Episode geschrieben werden), 1 Fehler.
"""
import datetime, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.normpath(os.path.join(HERE, ".."))
os.chdir(ROOT)
TH = "themen.json"
dry = "--dry" in sys.argv; only_next = "--next" in sys.argv
th = json.load(open(TH, encoding="utf-8"))
ready = [x for x in th["themen"] if x.get("status") == "bereit" and os.path.isfile(x.get("episode", ""))]
offen = [x for x in th["themen"] if x.get("status") == "offen"]
if not ready:
    print("Kein Thema mit Status 'bereit'.")
    if offen:
        o = offen[0]; print(f"Nächstes offenes Thema: {o['id']} ({th['genres'][o['genre']]['name']}): {o['thema']}")
    else:
        print("Auch keine offenen Themen. Bitte Themen in themen.json eintragen.")
    sys.exit(3)
x = ready[0]
print(f"Dran: {x['id']} ({th['genres'][x['genre']]['name']}): {x['thema']}  ->  {x['episode']}")
if only_next: sys.exit(0)
ep = json.load(open(x["episode"], encoding="utf-8")); out = f"out/{ep['id']}/{ep['id']}.mp4"
env = dict(os.environ, TTS_PY=os.environ.get("TTS_PY", os.path.expanduser("~/venv-tt/bin/python")),
           PW_PATH=os.environ.get("PW_PATH", "/opt/node-tools/node_modules/playwright"),
           SSL_CERT_FILE=os.environ.get("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt"))
r = subprocess.run(["./build.sh", x["episode"]], env=env)
if r.returncode or not os.path.isfile(out): sys.exit("Bau fehlgeschlagen")
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], capture_output=True, text=True).stdout.strip())
print(f"Video: {out}  {dur:.1f} s")
if dur > 45: print("WARNUNG: länger als 45 s, Regel verletzt")
cmd = ["python3", "upload/tiktok_upload.py", "upload", out, "--episode", x["episode"]] + ([] if dry else ["--send"])
up = subprocess.run(cmd, capture_output=True, text=True); print(up.stdout[-1500:], up.stderr[-800:])
if up.returncode: sys.exit("Upload fehlgeschlagen")
if dry: print("Testlauf, nichts geändert"); sys.exit(0)
m = re.search(r"publish_id: (\S+)", up.stdout)
x.update(status="hochgeladen", publish_id=m.group(1) if m else "?", datum=datetime.date.today().isoformat())
with open(TH, "w", encoding="utf-8") as f:
    json.dump(th, f, ensure_ascii=False, indent=1); f.write("\n")
subprocess.run(["git", "add", TH, x["episode"]])
subprocess.run(["git", "commit", "-q", "-m", f"Tageslauf: {x['id']} als TikTok-Entwurf hochgeladen"])
push = subprocess.run(["git", "push"], capture_output=True, text=True); print("git push:", "ok" if push.returncode == 0 else push.stderr[-300:])
print(f"FERTIG: {x['id']} hochgeladen, publish_id {x['publish_id']}")
