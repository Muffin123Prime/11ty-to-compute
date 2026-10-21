#!/usr/bin/env python3
"""TikTok Content Posting API: Anmelden, Video als Entwurf oder Direktpost hochladen, Status abfragen.

Standard ist ein Testlauf ohne Netzwerk. Erst mit --send wird wirklich gesendet.
Nötig: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI (Umgebungsvariablen).
Zugangstoken liegen in tiktok-auto/.secrets/tiktok_token.json (git-ignoriert).

  python3 upload/tiktok_upload.py auth-url
  python3 upload/tiktok_upload.py exchange <code aus der Rückleitungsseite>
  python3 upload/tiktok_upload.py upload out/ki_01/ki_01.mp4 --episode episodes/ki_01.json            (Testlauf)
  python3 upload/tiktok_upload.py upload out/ki_01/ki_01.mp4 --episode episodes/ki_01.json --send      (Entwurf)
  python3 upload/tiktok_upload.py status <publish_id>
"""
import argparse, json, math, os, sys, time, urllib.error, urllib.parse, urllib.request

API = "https://open.tiktokapis.com"
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.normpath(os.path.join(HERE, "..", ".secrets", "tiktok_token.json"))
SCOPES = os.environ.get("TIKTOK_SCOPES", "user.info.basic,video.upload")  # video.publish erst, wenn Direct Post in der App aktiv ist

def env(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"Fehlt: {name}. In den Einstellungen der Cloud-Umgebung eintragen und eine neue Sitzung starten.")
    return v

def http(method, url, headers=None, body=None, raw=False):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
            return data if raw else json.loads(data or b"{}")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        sys.exit(f"HTTP {e.code} von {url.split('?')[0]}: {txt[:600]}")

def token_request(fields):
    body = urllib.parse.urlencode(fields).encode()
    resp = http("POST", f"{API}/v2/oauth/token/", {"Content-Type": "application/x-www-form-urlencoded"}, body)
    if "access_token" not in resp:
        sys.exit(f"Token-Abruf fehlgeschlagen: {json.dumps(resp)[:400]}")
    resp["obtained_at"] = int(time.time())
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(resp, f)
    os.chmod(TOKEN_FILE, 0o600)
    return resp

def access_token():
    if os.path.exists(TOKEN_FILE):
        t = json.load(open(TOKEN_FILE))
    elif os.environ.get("TIKTOK_REFRESH_TOKEN"):
        t = {"refresh_token": os.environ["TIKTOK_REFRESH_TOKEN"], "obtained_at": 0, "expires_in": 0}
    else:
        sys.exit("Noch nicht angemeldet. Erst 'auth-url' und 'exchange' ausführen.")
    if time.time() > t.get("obtained_at", 0) + t.get("expires_in", 0) - 300:
        t = token_request({"client_key": env("TIKTOK_CLIENT_KEY"), "client_secret": env("TIKTOK_CLIENT_SECRET"),
                           "grant_type": "refresh_token", "refresh_token": t["refresh_token"]})
    return t["access_token"]

def api_post(path, token, payload):
    return http("POST", API + path, {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8"},
                json.dumps(payload).encode())

def cmd_auth_url(a):
    q = {"client_key": env("TIKTOK_CLIENT_KEY"), "scope": SCOPES, "response_type": "code",
         "redirect_uri": env("TIKTOK_REDIRECT_URI"), "state": "nachgehakt"}
    print("https://www.tiktok.com/v2/auth/authorize/?" + urllib.parse.urlencode(q))

def cmd_exchange(a):
    t = token_request({"client_key": env("TIKTOK_CLIENT_KEY"), "client_secret": env("TIKTOK_CLIENT_SECRET"),
                       "code": urllib.parse.unquote(a.code), "grant_type": "authorization_code",
                       "redirect_uri": env("TIKTOK_REDIRECT_URI")})
    print("Angemeldet. Berechtigungen:", t.get("scope"), "| Zugang gültig für", t.get("expires_in"), "s")

def caption_from(a):
    if a.caption:
        return a.caption
    if a.episode:
        ep = json.load(open(a.episode, encoding="utf-8"))
        return f"{ep['title']} #nachgehakt #ki #wissen"
    return "#nachgehakt"

def cmd_upload(a):
    if not os.path.isfile(a.video):
        sys.exit(f"Video nicht gefunden: {a.video}")
    size = os.path.getsize(a.video)
    chunk = size if size <= 64 * 1024 * 1024 else 32 * 1024 * 1024
    total = max(1, size // chunk)
    caption = caption_from(a)
    if len(caption) > 2200:
        sys.exit("Beschreibung länger als 2200 Zeichen")
    inbox = a.mode == "draft"
    path = "/v2/post/publish/inbox/video/init/" if inbox else "/v2/post/publish/video/init/"
    payload = {"source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": total}}
    if not inbox:
        payload["post_info"] = {"title": caption, "privacy_level": a.privacy, "disable_duet": False, "disable_comment": False,
                                "disable_stitch": False, "is_aigc": True}
    print(f"Modus: {'Entwurf (video.upload)' if inbox else 'Direktpost (video.publish)'}")
    print(f"Datei: {a.video}  {size / 1e6:.1f} MB in {total} Teil(en)")
    print(f"Beschreibung: {caption}")
    if not inbox:
        print(f"Sichtbarkeit: {a.privacy}   KI-Kennzeichnung: ja")
    if not a.send:
        print("\nTESTLAUF: nichts gesendet. Mit --send wirklich hochladen.")
        return
    token = access_token()
    if not inbox:
        info = api_post("/v2/post/publish/creator_info/query/", token, {})
        opts = info.get("data", {}).get("privacy_level_options", [])
        print("Erlaubte Sichtbarkeit laut TikTok:", opts)
        if a.privacy not in opts:
            sys.exit(f"Sichtbarkeit {a.privacy} ist für dieses Konto nicht erlaubt. Erlaubt: {opts}")
    resp = api_post(path, token, payload)
    if resp.get("error", {}).get("code") != "ok":
        sys.exit(f"Start fehlgeschlagen: {json.dumps(resp)[:500]}")
    d = resp["data"]; pid, url = d["publish_id"], d["upload_url"]
    data = open(a.video, "rb").read()
    for i in range(total):
        lo = i * chunk; hi = size if i == total - 1 else lo + chunk
        http("PUT", url, {"Content-Type": "video/mp4", "Content-Length": str(hi - lo),
                          "Content-Range": f"bytes {lo}-{hi - 1}/{size}"}, data[lo:hi], raw=True)
        print(f"Teil {i + 1}/{total} hochgeladen")
    print("publish_id:", pid)
    for _ in range(12):
        time.sleep(5)
        st = api_post("/v2/post/publish/status/fetch/", token, {"publish_id": pid}).get("data", {})
        print("Status:", st.get("status"), st.get("fail_reason", ""))
        if st.get("status") in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX", "FAILED"):
            break

def cmd_status(a):
    print(json.dumps(api_post("/v2/post/publish/status/fetch/", access_token(), {"publish_id": a.publish_id}), indent=1))

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
s = p.add_subparsers(dest="cmd", required=True)
s.add_parser("auth-url").set_defaults(f=cmd_auth_url)
x = s.add_parser("exchange"); x.add_argument("code"); x.set_defaults(f=cmd_exchange)
u = s.add_parser("upload"); u.add_argument("video"); u.add_argument("--caption"); u.add_argument("--episode")
u.add_argument("--mode", choices=["draft", "direct"], default="draft")
u.add_argument("--privacy", default="SELF_ONLY"); u.add_argument("--send", action="store_true"); u.set_defaults(f=cmd_upload)
t = s.add_parser("status"); t.add_argument("publish_id"); t.set_defaults(f=cmd_status)
a = p.parse_args(); a.f(a)
