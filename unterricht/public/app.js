/* Unterricht: hört mit, speichert Stunden, beantwortet Lehrerfragen.
   Alles Gesprochene bleibt als Text auf diesem Gerät (IndexedDB). Nur die
   letzten Minuten Text gehen zum eigenen Server, wenn eine Frage erkannt
   wird oder du auf "Jetzt antworten" drückst. */
(() => {
  "use strict";

  // ---------- Einstellungen --------------------------------------------------
  const STANDARD = {
    server: "",
    appKey: "",
    faecher: ["Mathe", "Deutsch", "Englisch", "Biologie", "Chemie", "Physik", "Geschichte", "Erdkunde", "Politik", "Kunst", "Musik", "Sport", "Religion", "Informatik"],
    klasse: "",
    schulform: "",
    name: "",
    antwortlaenge: "mittel",
    auto: true,
    websuche: true,
    ton: true,
    vibrieren: true,
    sprache: "de-DE",
    hinweisGesehen: false,
  };
  const ladeEinstellungen = () => {
    try {
      return { ...STANDARD, ...JSON.parse(localStorage.getItem("unterricht.einstellungen") || "{}") };
    } catch {
      return { ...STANDARD };
    }
  };
  let einst = ladeEinstellungen();
  const speichereEinstellungen = () => localStorage.setItem("unterricht.einstellungen", JSON.stringify(einst));

  // ---------- Speicher (IndexedDB) ------------------------------------------
  const db = (() => {
    let p;
    const oeffnen = () =>
      (p ||= new Promise((ok, nein) => {
        const r = indexedDB.open("unterricht", 1);
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore("stunden", { keyPath: "id" });
          s.createIndex("start", "start");
          s.createIndex("fach", "fach");
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => nein(r.error);
      }));
    const tx = async (modus, f) => {
      const d = await oeffnen();
      return new Promise((ok, nein) => {
        const t = d.transaction("stunden", modus);
        const s = t.objectStore("stunden");
        const req = f(s);
        t.oncomplete = () => ok(req?.result);
        t.onerror = () => nein(t.error);
        t.onabort = () => nein(t.error);
      });
    };
    return {
      alle: () => tx("readonly", (s) => s.getAll()).then((l) => (l || []).sort((a, b) => (a.start < b.start ? 1 : -1))),
      hole: (id) => tx("readonly", (s) => s.get(id)),
      speichere: (st) => tx("readwrite", (s) => s.put(st)),
      loesche: (id) => tx("readwrite", (s) => s.delete(id)),
      alleLoeschen: () => tx("readwrite", (s) => s.clear()),
    };
  })();

  // ---------- Sprachen --------------------------------------------------------
  const SPRACHEN = [
    ["de", "Deutsch", "de-DE"],
    ["en", "Englisch", "en-GB"],
    ["fr", "Französisch", "fr-FR"],
    ["es", "Spanisch", "es-ES"],
    ["it", "Italienisch", "it-IT"],
    ["tr", "Türkisch", "tr-TR"],
    ["ru", "Russisch", "ru-RU"],
  ];
  const spracheName = (code) => SPRACHEN.find((s) => s[0] === code)?.[1] || code;
  const erkennungsSprache = (code) => SPRACHEN.find((s) => s[0] === code)?.[2] || "de-DE";
  // Aus dem Fachnamen die Sprache der Lehrkraft raten (überschreibbar auf der Startseite).
  function spracheAusFach(fach) {
    const f = (fach || "").toLowerCase();
    if (/englis|english/.test(f)) return "en";
    if (/franz|français|french/.test(f)) return "fr";
    if (/spanis|español|spanish/.test(f)) return "es";
    if (/italien|italiano/.test(f)) return "it";
    if (/türk|turk/.test(f)) return "tr";
    if (/russ/.test(f)) return "ru";
    return "de";
  }

  // ---------- Hilfen ----------------------------------------------------------
  const $ = (sel, el = document) => el.querySelector(sel);
  function el(tag, attrs = {}, ...kinder) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kind of kinder.flat()) {
      if (kind == null || kind === false) continue;
      e.append(kind.nodeType ? kind : document.createTextNode(String(kind)));
    }
    return e;
  }
  function ersetze(parent, ...kinder) {
    parent.replaceChildren(...kinder.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
  }
  const zeit = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const datumText = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  };
  const uhrText = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const neueId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let meldungTimer;
  function meldung(text, dauer = 3500) {
    const m = $("#meldung");
    m.textContent = text;
    m.hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => (m.hidden = true), dauer);
  }

  // ---------- Server ----------------------------------------------------------
  const serverUrl = (pfad) => `${(einst.server || "").replace(/\/+$/, "")}${pfad}`;
  async function api(pfad, body) {
    const kopf = { "content-type": "application/json" };
    if (einst.appKey) kopf["x-app-key"] = einst.appKey;
    let r;
    try {
      r = await fetch(serverUrl(pfad), { method: body ? "POST" : "GET", headers: kopf, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Server nicht erreichbar. Stimmt die Adresse in den Einstellungen? Hast du Internet?");
    }
    let d;
    try {
      d = await r.json();
    } catch {
      throw new Error(`Server antwortet nicht mit JSON (Status ${r.status}).`);
    }
    if (!r.ok) throw new Error(d.fehler || `Fehler ${r.status}`);
    return d;
  }
  const profil = () => ({ klasse: einst.klasse, schulform: einst.schulform, name: einst.name, antwortlaenge: einst.antwortlaenge });

  // ---------- Signal ----------------------------------------------------------
  let audioCtx;
  function signal() {
    if (einst.vibrieren && navigator.vibrate) navigator.vibrate([80, 60, 80]);
    if (!einst.ton) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g).connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t);
      o.stop(t + 0.4);
    } catch {
      /* kein Ton möglich */
    }
  }

  // ---------- Frage-Erkennung (Vorfilter, spart Aufrufe) ----------------------
  const FRAGE_MUSTER = [
    /\?\s*$/,
    /^(wie|was|wer|wo|wann|warum|wieso|weshalb|welche[rsn]?|wozu|womit|wodurch|woran|wovon|worin|wohin|woher)\b/i,
    /\b(wie sieht|wie sehen|was ist|was sind|was bedeutet|was heißt|was passiert|was versteht man|was ergibt|was kommt (da )?raus|was fällt (euch|dir) (dazu )?ein|was wisst ihr|was wissen wir)\b/i,
    /\b(wer kann|wer weiß|wer möchte|wer hat|weiß (das )?jemand|weiß (das )?einer|kann (mir )?(das )?jemand|kann (mir )?(das )?einer|hat jemand (eine )?idee|hat jemand (eine )?ahnung|jemand (eine )?idee|ideen\b)/i,
    /\b(nenn(t|e)? (mir|uns)|erklär(t|e)?( mir| uns)?|beschreib(t|e)?( mir| uns)?|definier(t|e)?|zähl(t|e)? (mal )?auf|fass(t|e)? (mal )?zusammen|rechne(t)? (mal )?(aus|nach)|zeichne(t)?|überleg(t)? (mal|euch))\b/i,
    /\b(wie heißt|wie nennt man|wie viel|wieviel|wie groß|wie lange|wie schnell|wie schwer|wie funktioniert|wie lautet|wie rechnet man|wie kommt man|wie entsteht|wie wird|wie kann man|wie würde|wie berechnet|wofür steht|wofür braucht|woraus besteht|welche rolle)\b/i,
    /\b(stimmt das|richtig oder falsch|ja oder nein|oder nicht)\s*$/i,
    /\b(könnt ihr|kannst du|kann mir|könnte mir|wer von euch|sag mal|sagt mal|was meint ihr|was denkt ihr|was glaubt ihr|wisst ihr|habt ihr (eine )?idee|wie würdet ihr|was würdet ihr|fällt (euch|dir)|überlegt (mal|euch)|denkt (mal )?nach|schaut (mal|euch)|guckt (mal|euch)|wer traut sich|wer möchte|wer will|wer hat|wer erklärt|wer beschreibt|wer rechnet|wer liest)\b/i,
    // Englisch
    /^(who|what|where|when|why|how|which|whose|can anyone|can anybody|can someone|does anyone|does anybody|is there anyone|do you know|tell me|explain|describe|give me|name)\b/i,
    /\b(who can tell|who knows|what is|what are|what does|what do you|what did|what would|how do|how does|how many|how much|how would|why do|why does|why did|why is|anyone know|any ideas|what about|can you tell|tell me)\b/i,
    // Französisch
    /^(qui|que|qu'|quoi|où|quand|pourquoi|comment|quel|quelle|quels|quelles|est-ce que|qui peut|qui sait|dites-moi|expliquez|décrivez)\b/i,
    /\b(qui peut me dire|qui sait|qu'est-ce que|qu'est-ce qui|est-ce que|pourquoi est-ce|comment est-ce|combien de|quelqu'un sait|quelqu'un peut)\b/i,
    // Spanisch
    /^(quién|quien|qué|que|dónde|donde|cuándo|cuando|por qué|porque|cómo|como|cuál|cual|cuánto|cuanto|alguien sabe|alguien puede|decidme|explicad|describid)\b/i,
    /\b(quién puede|quién sabe|qué es|qué son|por qué|cómo se|cuántos|cuántas|alguien sabe|alguien puede|me puede decir)\b/i,
  ];
  const istFrage = (text) => FRAGE_MUSTER.some((m) => m.test(text.trim()));

  // ---------- Live-Zustand ----------------------------------------------------
  const live = {
    stunde: null, // die laufende Stunde (wird fortlaufend gespeichert)
    hoert: false,
    pausiert: false,
    rec: null,
    startMs: 0,
    pausenMs: 0, // aufsummierte Pausenzeit
    pauseSeitMs: 0,
    zwischen: "",
    letzteAnfrageMs: 0,
    letzteFrageText: "",
    laufend: 0, // Anzahl laufender Antwort-Anfragen
    wakeLock: null,
    timer: null,
    speicherTimer: null,
    neustarts: 0,
    zwischenstandLaeuft: false,
    zwischenstandTimer: null,
    zwischenstandSegmente: 0,
    waechterTimer: null,
    waechterLaeuft: false,
    waechterNochmal: false,
    waechterZuletztMs: 0,
    vorlaeufig: null, // Segment aus dem noch unfertigen Erkennungs-Text
    stabilTimer: null,
    waechterStand: 0, // Anzahl Segmente beim letzten Prüfen
    waechterText: "", // Statuszeile
    uebersetzTimer: null,
    uebersetzLaeuft: false,
    uebersetzFehler: "",
    recLaeuft: false,
    recZuletztMs: 0,
    wachhund: null,
    serverOk: null,
  };
  const liveSekunden = () => (live.startMs ? (Date.now() - live.startMs - live.pausenMs - (live.pauseSeitMs ? Date.now() - live.pauseSeitMs : 0)) / 1000 : 0);

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function recAnlegen() {
    const rec = new SR();
    rec.lang = erkennungsSprache(live.stunde?.sprache || "de");
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      live.recZuletztMs = Date.now();
      let zwischen = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0]?.transcript || "").trim();
        if (!text) continue;
        if (r.isFinal) segmentHinzu(text);
        else zwischen += (zwischen ? " " : "") + text;
      }
      live.zwischen = zwischen;
      vorlaeufigAktualisieren(zwischen);
      transkriptZeichnen();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        live.hoert = false;
        meldung("Kein Zugriff aufs Mikrofon. Bitte in den Browser-Einstellungen erlauben.", 6000);
        liveKopfZeichnen();
      } else if (e.error === "network") {
        meldung("Die Spracherkennung braucht Internet. Ich versuche es weiter.", 4000);
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        console.warn("Spracherkennung:", e.error);
      }
    };
    rec.onend = () => {
      live.recLaeuft = false;
      live.zwischen = "";
      if (live.hoert && !live.pausiert) {
        // Safari und Chrome beenden die Erkennung nach einer Weile von selbst:
        // einfach wieder starten, mit kleiner Pause, damit es nicht hämmert.
        live.neustarts++;
        setTimeout(() => {
          if (live.hoert && !live.pausiert) {
            try {
              rec.start();
            } catch {
              /* läuft schon */
            }
          }
        }, live.neustarts > 20 ? 1500 : 250);
      }
      liveKopfZeichnen();
    };
    rec.onstart = () => {
      live.recLaeuft = true;
      live.recZuletztMs = Date.now();
      liveKopfZeichnen();
    };
    return rec;
  }

  // Wachhund: Safari lässt die Erkennung manchmal ohne onend einschlafen.
  // Läuft sie angeblich, liefert aber seit 45 s nichts, oder läuft sie gar
  // nicht, obwohl sie soll, wird sie neu gestartet.
  function wachhundStarten() {
    clearInterval(live.wachhund);
    live.wachhund = setInterval(() => {
      if (!live.hoert || live.pausiert || !live.rec) return;
      const still = Date.now() - live.recZuletztMs > 45000;
      if (!live.recLaeuft || still) {
        try {
          live.rec.abort();
        } catch {
          /* egal */
        }
        live.recLaeuft = false;
        setTimeout(() => {
          if (!live.hoert || live.pausiert) return;
          try {
            live.rec.start();
          } catch {
            /* läuft schon */
          }
        }, 300);
      }
    }, 5000);
  }

  async function wakeLockHolen() {
    try {
      if ("wakeLock" in navigator && !live.wakeLock) {
        live.wakeLock = await navigator.wakeLock.request("screen");
        live.wakeLock.addEventListener("release", () => (live.wakeLock = null));
      }
    } catch {
      /* nicht erlaubt, egal */
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && live.hoert && !live.pausiert) wakeLockHolen();
    if (document.visibilityState === "hidden" && live.stunde) {
      clearTimeout(live.speicherTimer);
      db.speichere(live.stunde).catch(() => {});
    }
  });
  window.addEventListener("pagehide", () => {
    if (live.stunde) db.speichere(live.stunde).catch(() => {});
  });

  // Safari und Chrome liefern den endgültigen Text oft erst nach einer langen
  // Pause. Damit Übersetzung und Frage-Wächter nicht warten müssen, wird der
  // noch unfertige Text als vorläufiges Segment mitgeführt und laufend ersetzt.
  function vorlaeufigAktualisieren(zwischen) {
    const st = live.stunde;
    if (!st) return;
    const text = zwischen.trim();
    if (!text) return;
    if (!live.vorlaeufig || !st.transkript.includes(live.vorlaeufig)) {
      live.vorlaeufig = { t: Math.max(0, Math.round(liveSekunden())), text, vorlaeufig: true };
      st.transkript.push(live.vorlaeufig);
    } else if (live.vorlaeufig.text !== text) {
      live.vorlaeufig.text = text;
      delete live.vorlaeufig.de; // Übersetzung passt nicht mehr
    }
    // Nach 1,2 s ohne Änderung gilt der Text als stabil: dann übersetzen und auf Fragen prüfen.
    clearTimeout(live.stabilTimer);
    live.stabilTimer = setTimeout(() => {
      if (!live.vorlaeufig || live.stunde !== st) return;
      uebersetzungAnstossen(300);
      fragePruefen(live.vorlaeufig.text, true);
    }, 1200);
  }

  function segmentHinzu(text) {
    if (!live.stunde) return;
    const t = Math.max(0, Math.round(liveSekunden()));
    clearTimeout(live.stabilTimer);
    const v = live.vorlaeufig;
    live.vorlaeufig = null;
    if (v && live.stunde.transkript.includes(v)) {
      // Das vorläufige Segment wird zum endgültigen; Übersetzung bleibt, wenn der Text gleich blieb.
      if (v.text !== text) delete v.de;
      v.text = text;
      v.t = Math.min(v.t, t);
      delete v.vorlaeufig;
    } else {
      live.stunde.transkript.push({ t, text });
    }
    speichernBald();
    uebersetzungAnstossen();
    fragePruefen(text, false);
  }

  // Prüft neuen Text auf eine Frage: erst die schnellen Wortmuster, sonst der Wächter.
  function fragePruefen(text, vorlaeufig) {
    if (!einst.auto || !live.stunde) return;
    const tr = live.stunde.transkript;
    const letzter = tr.at(-1);
    const vor = tr.at(-2);
    const paar = vor && letzter && letzter.t - vor.t <= 8 ? `${vor.text} ${text}` : text;
    // Erst der neue Text allein, sonst zusammen mit dem Stück davor (zerschnittene Frage).
    const hinweis = istFrage(text) ? text : istFrage(paar) ? paar : null;
    if (hinweis) autoAntwort(hinweis);
    else waechterAnstossen(vorlaeufig);
  }

  // ---------- Live-Übersetzung ----------------------------------------------
  // Fremdsprachige Stunden: neue Stücke werden gesammelt und nach kurzer Pause
  // gebündelt übersetzt, damit die Übersetzung ein, zwei Sekunden hinterherläuft.
  function uebersetzungAnstossen(wartezeit = 700) {
    if (!live.stunde || live.stunde.sprache === "de") return;
    clearTimeout(live.uebersetzTimer);
    live.uebersetzTimer = setTimeout(uebersetzen, wartezeit);
  }
  async function uebersetzen() {
    const st = live.stunde;
    if (!st || st.sprache === "de" || live.uebersetzLaeuft) return;
    const offen = st.transkript.filter((s) => s.de === undefined).slice(-30);
    if (!offen.length) return;
    live.uebersetzLaeuft = true;
    offen.forEach((s) => (s.de = null)); // null = unterwegs
    transkriptZeichnen();
    try {
      const texte = offen.map((s) => s.text);
      const d = await api("/api/uebersetzung", { von: st.sprache, fach: st.fach, segmente: offen.map((s, i) => ({ id: `s${i}`, text: s.text })) });
      const nachId = new Map(d.uebersetzungen.map((u) => [u.id, u.text]));
      offen.forEach((s, i) => {
        // Hat sich der vorläufige Text inzwischen geändert, gilt die Übersetzung nicht mehr.
        if (s.text !== texte[i]) delete s.de;
        else s.de = nachId.get(`s${i}`) ?? d.uebersetzungen[i]?.text ?? "";
      });
      live.uebersetzFehler = "";
      speichernBald();
    } catch (e) {
      offen.forEach((s) => delete s.de); // beim nächsten Mal noch einmal versuchen
      live.uebersetzFehler = e.message;
    } finally {
      live.uebersetzLaeuft = false;
      transkriptZeichnen();
      if (live.stunde === st && st.transkript.some((s) => s.de === undefined)) {
        clearTimeout(live.uebersetzTimer);
        live.uebersetzTimer = setTimeout(uebersetzen, live.uebersetzFehler ? 8000 : 500);
      }
    }
  }

  // Sprache der Lehrkraft mitten in der Stunde wechseln: Erkennung neu starten,
  // ab jetzt (und für alles noch Unübersetzte) übersetzen.
  function spracheWechseln(code) {
    const st = live.stunde;
    if (!st || st.sprache === code) return;
    st.sprache = code;
    live.uebersetzFehler = "";
    if (code === "de") st.transkript.forEach((s) => { if (s.de === null) delete s.de; });
    if (live.rec) {
      try { live.rec.abort(); } catch { /* egal */ }
      live.rec = null;
      live.recLaeuft = false;
      if (live.hoert && !live.pausiert) {
        live.rec = recAnlegen();
        try { live.rec.start(); } catch { /* egal */ }
      }
    }
    speichernBald();
    liveKopfZeichnen();
    uebersetzungAnstossen();
    meldung(code === "de" ? "Ohne Übersetzung, Erkennung auf Deutsch." : `Erkennung auf ${spracheName(code)}, Übersetzung ins Deutsche läuft.`, 4000);
  }

  function speichernBald() {
    clearTimeout(live.speicherTimer);
    live.speicherTimer = setTimeout(() => live.stunde && db.speichere(live.stunde).catch(() => meldung("Speichern fehlgeschlagen.")), 800);
  }

  function letzteSegmente(sekunden = 150, mindestens = 8, hoechstens = 80) {
    const tr = live.stunde?.transkript || [];
    const jetzt = liveSekunden();
    let teil = tr.filter((s) => jetzt - s.t <= sekunden);
    if (teil.length < mindestens) teil = tr.slice(-mindestens);
    return teil.slice(-hoechstens);
  }

  // Zwei Fragen gelten als gleich, wenn sich ihre Wörter stark überschneiden.
  const woerter = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
  function aehnlich(a, b) {
    const A = woerter(a);
    const B = woerter(b);
    if (!A.size || !B.size) return false;
    let gleich = 0;
    for (const w of A) if (B.has(w)) gleich++;
    return gleich / Math.min(A.size, B.size) >= 0.6;
  }
  function schonGestellt(frage) {
    const kuerzlich = live.stunde.fragen.filter((f) => f.status !== "fehler" && liveSekunden() - f.t < 600);
    return kuerzlich.some((f) => aehnlich(f.frage, frage));
  }

  // Der Frage-Wächter: prüft alle paar Sekunden den neuen Text mit dem kleinen
  // Modell, unabhängig von den Wortmustern. Erkennt er eine Frage, kommt die
  // Antwort, ohne dass jemand drückt.
  const WAECHTER_MIN_ABSTAND_MS = 4000;
  function waechterStarten() {
    clearInterval(live.waechterTimer);
    live.waechterTimer = setInterval(() => waechterAnstossen(false), 15000); // Sicherheitsnetz
  }
  // Wird bei jedem neuen (auch vorläufigen) Text gerufen; läuft höchstens alle vier Sekunden.
  function waechterAnstossen() {
    if (!live.stunde || !einst.auto) return;
    if (live.waechterLaeuft) {
      live.waechterNochmal = true;
      return;
    }
    const wartezeit = WAECHTER_MIN_ABSTAND_MS - (Date.now() - live.waechterZuletztMs);
    clearTimeout(live.waechterWarten);
    if (wartezeit > 0) {
      live.waechterWarten = setTimeout(waechterPruefen, wartezeit);
      return;
    }
    waechterPruefen();
  }
  async function waechterPruefen() {
    const st = live.stunde;
    if (!st || !einst.auto || live.waechterLaeuft) return;
    const neue = st.transkript.length - live.waechterStand;
    const letzter = st.transkript.at(-1);
    if (neue < 1 && !(letzter?.vorlaeufig && letzter.text !== live.waechterLetzterText)) return;
    live.waechterLaeuft = true;
    live.waechterNochmal = false;
    live.waechterZuletztMs = Date.now();
    live.waechterStand = st.transkript.length;
    live.waechterLetzterText = letzter?.text || "";
    setzeWaechterText("prüft …");
    try {
      const d = await api("/api/frage", {
        fach: st.fach,
        sprache: st.sprache || "de",
        transkript: letzteSegmente(45, 3, 14),
        bisherige: st.fragen.filter((f) => f.status !== "fehler").slice(0, 8).map((f) => f.frage),
      });
      if (live.stunde !== st) return;
      if (d.frage_erkannt && d.frage) {
        if (schonGestellt(d.frage)) setzeWaechterText(`${zeit(liveSekunden())} schon beantwortet`);
        else {
          setzeWaechterText(`${zeit(liveSekunden())} ${d.art === "aufgabe" ? "Aufgabe" : "Frage"} erkannt`);
          live.letzteAnfrageMs = Date.now();
          live.letzteFrageText = d.frage;
          frageStellen({ modus: "auto", frage: d.frage, erkannt: true });
        }
      } else {
        setzeWaechterText(`${zeit(liveSekunden())} keine Frage`);
      }
    } catch (e) {
      setzeWaechterText(`Prüfung fehlgeschlagen: ${e.message}`);
    } finally {
      live.waechterLaeuft = false;
      if (live.waechterNochmal) waechterAnstossen();
    }
  }
  function setzeWaechterText(t) {
    live.waechterText = t;
    const el_ = liveTeile && $(".waechter", liveTeile.band);
    if (el_) el_.textContent = t;
  }

  async function autoAntwort(text) {
    const jetzt = Date.now();
    if (jetzt - live.letzteAnfrageMs < 5000) return; // nicht bei jedem Satz
    if (text === live.letzteFrageText || aehnlich(text, live.letzteFrageText) || schonGestellt(text)) return;
    live.letzteAnfrageMs = jetzt;
    live.letzteFrageText = text;
    live.waechterStand = live.stunde.transkript.length; // der Wächter muss das nicht noch einmal prüfen
    await frageStellen({ modus: "auto", hinweisText: text });
  }

  function kontextText() {
    const zs = live.stunde?.zwischenstand;
    if (!zs) return "";
    const teile = [zs.thema, zs.text];
    if (zs.kernpunkte?.length) teile.push(`Kernpunkte: ${zs.kernpunkte.join(" / ")}`);
    if (zs.begriffe?.length) teile.push(`Begriffe: ${zs.begriffe.map((b) => b.begriff).join(", ")}`);
    return teile.filter(Boolean).join("\n");
  }

  // Holt aus dem noch unvollständigen JSON den bisherigen Antworttext.
  function teilAntwort(text) {
    const m = text.match(/"antwort"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return "";
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\$/, "");
    }
  }

  async function frageStellen({ modus, frage = "", hinweisText = "", erkannt = false }) {
    if (!live.stunde) return;
    const st = live.stunde;
    const karte = { id: neueId(), t: Math.round(liveSekunden()), modus, frage: frage || hinweisText, antwort: "", kurz: "", erklaerung: "", bild: null, status: "wartet", erkannt };
    st.fragen.unshift(karte);
    live.laufend++;
    antwortenZeichnen();
    const body = {
      fach: st.fach,
      transkript: letzteSegmente(),
      frage,
      erkannt,
      modus,
      kontext: kontextText(),
      sprache: st.sprache || "de",
      bisherige: st.fragen.filter((f) => f.status === "fertig" && f.id !== karte.id).slice(0, 8).map((f) => f.frage),
      websuche: Boolean(einst.websuche),
      profil: profil(),
      stream: true,
    };
    try {
      const kopf = { "content-type": "application/json" };
      if (einst.appKey) kopf["x-app-key"] = einst.appKey;
      let r;
      try {
        r = await fetch(serverUrl("/api/antwort"), { method: "POST", headers: kopf, body: JSON.stringify(body) });
      } catch {
        throw new Error("Server nicht erreichbar. Stimmt die Adresse in den Einstellungen? Hast du Internet?");
      }
      if (!r.ok) {
        let f;
        try {
          f = (await r.json()).fehler;
        } catch {
          /* kein JSON */
        }
        throw new Error(f || `Fehler ${r.status}`);
      }
      let d = null;
      if (/text\/event-stream/.test(r.headers.get("content-type") || "")) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let rest = "";
        let bisher = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          rest += dec.decode(value, { stream: true });
          const teile = rest.split("\n\n");
          rest = teile.pop();
          for (const teil of teile) {
            const zeile = teil.split("\n").find((z) => z.startsWith("data:"));
            if (!zeile) continue;
            let ev;
            try {
              ev = JSON.parse(zeile.slice(5));
            } catch {
              continue;
            }
            if (ev.typ === "delta") {
              bisher += ev.delta;
              const text = teilAntwort(bisher);
              if (text && text !== karte.antwort) {
                karte.antwort = text;
                karte.status = "schreibt";
                antwortTextAktualisieren(karte);
              }
            } else if (ev.typ === "fertig") d = ev;
            else if (ev.typ === "fehler") throw new Error(ev.fehler);
          }
        }
        if (!d) throw new Error("Die Verbindung ist abgebrochen.");
      } else {
        d = await r.json();
      }
      if (!d.frage_erkannt) {
        if (modus === "auto") {
          st.fragen = st.fragen.filter((f) => f.id !== karte.id);
          setzeWaechterText(`${zeit(liveSekunden())} keine Frage`);
        } else {
          karte.status = "nichts";
          karte.antwort = "Ich habe gerade keine Frage der Lehrkraft gefunden. Tipp sie unten ein, dann beantworte ich sie.";
        }
      } else {
        Object.assign(karte, { status: "fertig", frage: d.frage || karte.frage, antwort: d.antwort, kurz: d.kurz || "", erklaerung: d.erklaerung || "", bild: d.bild || null, neu: true });
        setzeWaechterText(`${zeit(liveSekunden())} Antwort da`);
        signal();
      }
    } catch (e) {
      karte.status = "fehler";
      karte.antwort = e.message;
    } finally {
      live.laufend--;
      speichernBald();
      antwortenZeichnen();
    }
  }

  // Beim Streamen nur den Antworttext der einen Karte nachführen, nicht alles neu zeichnen.
  function antwortTextAktualisieren(karte) {
    const k = liveTeile && $(`[data-frage="${karte.id}"]`, liveTeile.antworten);
    if (!k) return antwortenZeichnen();
    let p = $(".antwort", k);
    if (!p) {
      p = el("p", { class: "antwort" });
      $(".frage", k)?.after(p);
      $(".lade", k)?.remove();
    }
    p.textContent = karte.antwort + " ▍";
  }

  // ---------- Zwischenstand (laufende Zusammenfassung) -------------------------
  const ZWISCHENSTAND_ALLE_MS = 4 * 60 * 1000;
  async function zwischenstandHolen(erzwungen = false) {
    const st = live.stunde;
    if (!st || live.zwischenstandLaeuft) return;
    const neue = st.transkript.length - live.zwischenstandSegmente;
    if (!erzwungen && (st.transkript.length < 8 || neue < 6)) return;
    if (st.transkript.length < 3) {
      if (erzwungen) meldung("Dafür ist noch zu wenig Text da.");
      return;
    }
    live.zwischenstandLaeuft = true;
    zwischenstandZeichnen();
    try {
      const d = await api("/api/zusammenfassung", { fach: st.fach, datum: st.datum, dauer: Math.round(liveSekunden()), transkript: st.transkript, laufend: true, profil: profil() });
      if (live.stunde !== st) return;
      st.zwischenstand = { thema: d.thema, text: d.zusammenfassung, kernpunkte: d.kernpunkte || [], fragen: d.fragen || [], hausaufgaben: d.hausaufgaben || [], begriffe: d.begriffe || [], stand: Math.round(liveSekunden()) };
      live.zwischenstandSegmente = st.transkript.length;
      speichernBald();
    } catch (e) {
      if (erzwungen) meldung(`Zwischenstand fehlgeschlagen: ${e.message}`, 5000);
    } finally {
      live.zwischenstandLaeuft = false;
      zwischenstandZeichnen();
      fragenSpalteZeichnen();
    }
  }

  // ---------- Live: Start / Pause / Ende --------------------------------------
  async function stundeStarten(fach, sprache = "de") {
    const start = new Date();
    live.stunde = {
      id: neueId(),
      fach,
      sprache,
      datum: start.toISOString().slice(0, 10),
      start: start.toISOString(),
      dauer: 0,
      transkript: [],
      fragen: [],
      zusammenfassung: null,
      zwischenstand: null,
      notizen: "",
    };
    live.startMs = Date.now();
    live.zwischenstandSegmente = 0;
    clearInterval(live.zwischenstandTimer);
    live.zwischenstandTimer = setInterval(() => zwischenstandHolen(false), ZWISCHENSTAND_ALLE_MS);
    live.waechterStand = 0;
    live.waechterText = "";
    live.waechterZuletztMs = 0;
    live.vorlaeufig = null;
    waechterStarten();
    live.pausenMs = 0;
    live.pauseSeitMs = 0;
    live.zwischen = "";
    live.letzteAnfrageMs = 0;
    live.letzteFrageText = "";
    live.neustarts = 0;
    await db.speichere(live.stunde);
    location.hash = "#live";
    hoerenStarten();
  }

  function hoerenStarten() {
    if (!SR) {
      meldung("Dieser Browser hat keine Spracherkennung. Auf dem iPhone/iPad Safari nehmen, sonst Chrome. Du kannst unten trotzdem mitschreiben.", 8000);
      live.hoert = false;
      liveKopfZeichnen();
      return;
    }
    live.hoert = true;
    live.pausiert = false;
    if (live.pauseSeitMs) {
      live.pausenMs += Date.now() - live.pauseSeitMs;
      live.pauseSeitMs = 0;
    }
    live.rec ||= recAnlegen();
    live.recZuletztMs = Date.now();
    try {
      live.rec.start();
    } catch {
      /* läuft schon */
    }
    wachhundStarten();
    wakeLockHolen();
    liveKopfZeichnen();
  }

  function hoerenPausieren() {
    live.pausiert = true;
    live.pauseSeitMs = Date.now();
    try {
      live.rec?.stop();
    } catch {
      /* egal */
    }
    live.zwischen = "";
    liveKopfZeichnen();
    transkriptZeichnen();
  }

  async function stundeBeenden() {
    if (!live.stunde) return;
    const st = live.stunde;
    live.hoert = false;
    live.pausiert = false;
    try {
      live.rec?.stop();
    } catch {
      /* egal */
    }
    live.rec = null;
    clearInterval(live.wachhund);
    clearTimeout(live.uebersetzTimer);
    clearTimeout(live.stabilTimer);
    clearTimeout(live.waechterWarten);
    // Ein noch vorläufiges Segment wird zum echten.
    st.transkript.forEach((s) => delete s.vorlaeufig);
    live.vorlaeufig = null;
    st.dauer = Math.round(liveSekunden());
    live.stunde = null;
    live.startMs = 0;
    clearInterval(live.timer);
    clearInterval(live.zwischenstandTimer);
    clearInterval(live.waechterTimer);
    document.body.classList.remove("gedimmt");
    try {
      live.wakeLock?.release();
    } catch {
      /* egal */
    }
    await db.speichere(st);
    location.hash = `#stunde/${st.id}`;
    if (st.transkript.length >= 3) zusammenfassen(st.id, true);
  }

  async function zusammenfassen(id, leise = false) {
    const st = await db.hole(id);
    if (!st) return;
    if (st.transkript.length < 3) {
      if (!leise) meldung("Dafür ist zu wenig Text da.");
      return;
    }
    st.zusammenfassungLaeuft = true;
    await db.speichere(st);
    if (location.hash === `#stunde/${id}`) zeigeStunde(id);
    try {
      const d = await api("/api/zusammenfassung", { fach: st.fach, datum: st.datum, dauer: st.dauer, transkript: st.transkript, profil: profil() });
      const frisch = await db.hole(id);
      frisch.zusammenfassung = {
        titel: d.titel,
        thema: d.thema,
        text: d.zusammenfassung,
        kernpunkte: d.kernpunkte || [],
        fragen: d.fragen || [],
        hausaufgaben: d.hausaufgaben || [],
        begriffe: d.begriffe || [],
        erstellt: new Date().toISOString(),
      };
      delete frisch.zusammenfassungLaeuft;
      await db.speichere(frisch);
      meldung("Zusammenfassung fertig.");
    } catch (e) {
      const frisch = await db.hole(id);
      if (frisch) {
        delete frisch.zusammenfassungLaeuft;
        await db.speichere(frisch);
      }
      meldung(`Zusammenfassung fehlgeschlagen: ${e.message}`, 6000);
    }
    if (location.hash === `#stunde/${id}`) zeigeStunde(id);
  }

  // ---------- Ansichten --------------------------------------------------------
  const app = $("#app");
  const navMarkieren = (name) => document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("aktiv", a.dataset.nav === name));

  async function serverPruefen() {
    try {
      const d = await api("/api/status");
      live.serverOk = d.schluessel ? true : "schluessel";
      live.anbieter = d;
    } catch {
      live.serverOk = false;
    }
    return live.serverOk;
  }
  function serverZeile() {
    const z = el("p", { class: "unter klein", style: "margin:0" });
    const setzen = () => {
      if (live.serverOk === true) ersetze(z, `Server verbunden · ${live.anbieter?.anbieterName || "KI"}`);
      else if (live.serverOk === "schluessel") ersetze(z, "Server erreichbar, aber ohne KI (Workers-AI-Binding oder Schlüssel fehlt). ", el("a", { href: "#einstellungen" }, "Einstellungen"));
      else if (live.serverOk === false) ersetze(z, "Kein Server erreichbar: Zuhören und Mitschreiben geht, Antworten nicht. ", el("a", { href: "#einstellungen" }, "Einstellungen"));
      else ersetze(z, el("span", { class: "lade" }), " Server wird geprüft …");
    };
    setzen();
    if (live.serverOk === null) serverPruefen().then(setzen);
    return z;
  }

  let gewaehltesFach = "";
  let gewaehlteSprache = "";
  function zeigeStart() {
    navMarkieren("start");
    app.classList.remove("breit");
    document.body.classList.remove("gedimmt");
    const kinder = [];
    if (!einst.hinweisGesehen) {
      kinder.push(
        el("div", { class: "karte", style: "max-width:560px;text-align:left" },
          el("h3", { style: "margin-top:0" }, "Bevor es losgeht"),
          el("p", {}, "Die App hört über das Mikrofon mit und schreibt den Unterricht als Text auf dieses Gerät. Sag deiner Lehrkraft Bescheid und frag, ob das für dich in Ordnung ist: Unterricht ohne Einverständnis aufzunehmen ist in Deutschland nicht erlaubt."),
          el("p", {}, "Wenn die Lehrkraft eine Frage stellt, bekommst du einen Vorschlag, den du laut vorlesen kannst. Lies ihn kurz, bevor du dich meldest: Die Spracherkennung verhört sich manchmal."),
          el("button", { class: "knopf primaer", onclick: () => { einst.hinweisGesehen = true; speichereEinstellungen(); zeigeStart(); } }, "Verstanden"),
        ),
      );
    }
    if (live.stunde) {
      kinder.push(
        el("div", { class: "karte", style: "max-width:420px" },
          el("div", { class: "reihe", style: "justify-content:center" }, el("span", { class: `punkt-klein ${live.pausiert ? "pause" : live.hoert ? "" : "aus"}`, style: "width:28px;height:28px" }), `Läuft gerade: ${live.stunde.fach}`),
          el("p", { class: "muted klein", style: "margin:8px 0" }, `seit ${uhrText(live.stunde.start)}, ${live.stunde.transkript.length} Sätze`),
          el("a", { class: "knopf primaer", href: "#live" }, "Zurück zur Stunde"),
        ),
      );
    }
    const eigenes = el("input", { placeholder: "anderes Fach …", value: einst.faecher.includes(gewaehltesFach) ? "" : gewaehltesFach, oninput: (e) => { gewaehltesFach = e.target.value.trim(); gewaehlteSprache = spracheAusFach(gewaehltesFach); chipsZeichnen(); } });
    const chips = el("div", { class: "chips" });
    const sprachChips = el("div", { class: "chips sprachen" });
    const chipsZeichnen = () => {
      ersetze(chips,
        einst.faecher.map((f) => el("button", { class: `chip${gewaehltesFach === f ? " aktiv" : ""}`, onclick: () => { gewaehltesFach = f; gewaehlteSprache = spracheAusFach(f); eigenes.value = ""; chipsZeichnen(); } }, f)),
        el("span", { class: `chip eingabe${gewaehltesFach && !einst.faecher.includes(gewaehltesFach) ? " aktiv" : ""}` }, eigenes),
      );
      const sprache = gewaehlteSprache || "de";
      ersetze(sprachChips,
        el("span", { class: "muted klein", style: "align-self:center;margin-right:4px" }, "Lehrkraft spricht:"),
        SPRACHEN.map(([code, name]) => el("button", { class: `chip klein${sprache === code ? " aktiv" : ""}`, onclick: () => { gewaehlteSprache = code; chipsZeichnen(); } }, name)),
        el("span", { class: "muted klein", style: "flex-basis:100%;text-align:center" }, sprache !== "de" ? `Mitschrift auf ${spracheName(sprache)}, dazu live die deutsche Übersetzung. Antworten kommen auf ${spracheName(sprache)}.` : "Spricht die Lehrkraft eine andere Sprache? Hier antippen, dann läuft die Live-Übersetzung. Geht auch später im Band."),
      );
    };
    chipsZeichnen();
    const punkt = el("button", {
      class: "punkt-gross",
      "aria-label": "Zuhören starten",
      disabled: Boolean(live.stunde),
      onclick: () => {
        if (!gewaehltesFach) return meldung("Erst oben das Fach antippen.");
        stundeStarten(gewaehltesFach, gewaehlteSprache || "de");
      },
    }, "Zuhören");
    kinder.push(
      el("div", { class: "start" },
        el("div", {}, el("h2", {}, "Welche Stunde?"), chips, sprachChips),
        punkt,
        serverZeile(),
        el("p", { class: "unter" }, SR ? "Fach wählen, auf den Punkt tippen. Dann hört die App zu, schreibt mit und meldet sich, wenn die Lehrkraft etwas fragt." : "Dieser Browser kann nicht zuhören. Auf iPhone und iPad Safari benutzen, am Computer Chrome oder Edge. Mitschreiben per Tastatur geht trotzdem."),
      ),
    );
    ersetze(app, ...kinder);
    db.alle().then((liste) => {
      if (!liste.length || (location.hash !== "#start" && location.hash !== "")) return;
      app.append(
        el("h2", {}, "Zuletzt"),
        el("div", { class: "liste" }, liste.slice(0, 3).map(stundenKarte)),
        el("a", { class: "knopf leise", href: "#archiv" }, "Alle Stunden →"),
      );
    });
  }

  function stundenKarte(st) {
    const titel = st.zusammenfassung?.titel || st.fach;
    return el("div", { class: "karte", onclick: () => (location.hash = `#stunde/${st.id}`) },
      el("div", { class: "reihe", style: "justify-content:space-between" },
        el("strong", {}, titel),
        el("span", { class: "tag" }, st.fach),
      ),
      el("div", { class: "muted klein" }, `${datumText(st.start)}, ${uhrText(st.start)} · ${zeit(st.dauer || 0)} · ${st.transkript.length} Sätze · ${st.fragen.filter((f) => f.status === "fertig").length} Antworten`),
      st.zusammenfassung?.thema ? el("div", { class: "klein", style: "margin-top:4px" }, st.zusammenfassung.thema) : null,
    );
  }

  // Live-Ansicht ----------------------------------------------------------------
  let liveTeile = null;
  function zeigeLive() {
    navMarkieren("start");
    if (!live.stunde) {
      location.hash = "#start";
      return;
    }
    app.classList.add("breit");
    document.body.classList.add("gedimmt");
    const band = el("div", { class: "live-band" });
    const links = el("div", {});
    const antworten = el("div", { class: "spalte" });
    const rechts = el("div", { class: "zwischenstand" });
    const eingabe = el("input", { class: "feld", placeholder: "Frage eintippen …", autocomplete: "off" });
    const leiste = el("div", { class: "leiste" },
      el("button", { class: "knopf", style: "min-height:50px;padding:0 20px", title: "Falls die Automatik etwas verpasst", onclick: () => frageStellen({ modus: "manuell" }) }, "Jetzt antworten"),
      el("form", { onsubmit: (e) => { e.preventDefault(); const v = eingabe.value.trim(); if (!v) return; eingabe.value = ""; frageStellen({ modus: "manuell", frage: v }); } },
        eingabe,
        el("button", { class: "knopf", type: "submit" }, "Fragen"),
      ),
    );
    liveTeile = { band, links, antworten, rechts };
    ersetze(app,
      band,
      el("div", { class: "spalten" },
        el("section", { class: "spalte-links" }, el("h2", {}, "Fragen und Aufgaben"), links),
        el("section", { class: "spalte-mitte" }, el("h2", {}, "Antworten zum Vorlesen"), antworten),
        el("section", { class: "spalte-rechts" }, el("h2", {}, "Stunde bisher"), rechts),
      ),
      leiste,
    );
    liveKopfZeichnen();
    transkriptZeichnen();
    antwortenZeichnen();
    fragenSpalteZeichnen();
    zwischenstandZeichnen();
    clearInterval(live.timer);
    live.timer = setInterval(() => {
      const z = liveTeile && $(".zeit", liveTeile.band);
      if (z) z.textContent = zeit(liveSekunden());
    }, 1000);
  }

  function liveKopfZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.band)) return;
    const zustand = !live.hoert ? "aus" : live.pausiert ? "pause" : "an";
    const text = zustand === "an" ? "hört zu" : zustand === "pause" ? "Pause" : SR ? "aus" : "nur Tippen";
    let liveText = $(".live-text", liveTeile.band);
    if (!liveText) liveText = el("div", { class: "live-text", "aria-live": "polite" });
    ersetze(liveTeile.band,
      el("button", {
        class: `punkt-klein ${zustand === "an" ? "" : zustand}`,
        "aria-label": zustand === "an" ? "Pause" : "Weiter",
        title: zustand === "an" ? "Tippen: Pause" : "Tippen: weiter zuhören",
        onclick: () => (zustand === "an" ? hoerenPausieren() : hoerenStarten()),
      }),
      liveText,
      el("div", { class: "live-meta" },
        el("strong", {}, live.stunde.fach, live.stunde.sprache && live.stunde.sprache !== "de" && spracheName(live.stunde.sprache) !== live.stunde.fach ? ` · ${spracheName(live.stunde.sprache)}` : ""),
        el("span", {}, `${text} · `, el("span", { class: "zeit" }, zeit(liveSekunden()))),
        el("span", { class: `waechter${einst.auto ? "" : " aus"}` }, einst.auto ? live.waechterText || "Wächter an" : "Wächter aus"),
        el("div", { class: "reihe", style: "gap:6px;margin-top:6px" },
          el("select", { class: "feld klein-select", title: "Sprache der Lehrkraft", onchange: (e) => spracheWechseln(e.target.value) },
            SPRACHEN.map(([code, name]) => el("option", { value: code, selected: (live.stunde.sprache || "de") === code }, code === "de" ? "Deutsch, keine Übersetzung" : `${name} → Deutsch`)),
          ),
          el("button", { class: `knopf klein${einst.auto ? " primaer" : ""}`, onclick: () => { einst.auto = !einst.auto; speichereEinstellungen(); liveKopfZeichnen(); } }, einst.auto ? "Automatik an" : "Automatik aus"),
          el("button", { class: "knopf klein", onclick: () => { if (confirm("Stunde beenden und zusammenfassen?")) stundeBeenden(); } }, "Beenden"),
        ),
      ),
    );
    transkriptZeichnen();
  }

  // Oben im Band: die letzten Sätze, der neueste weiß, davor grau, dazu das Halbfertige.
  // In fremdsprachigen Stunden darunter die deutsche Übersetzung.
  function transkriptZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.band)) return;
    const box = $(".live-text", liveTeile.band);
    if (!box) return;
    const st = live.stunde;
    const tr = st.transkript;
    const letzte = tr.slice(-4);
    const fremd = st.sprache && st.sprache !== "de";
    const original = el("div", { class: fremd ? "original" : "" },
      tr.length === 0 && !live.zwischen ? el("span", { class: "leer" }, live.hoert ? (fremd ? `Ich höre zu (${spracheName(st.sprache)}) … Sobald jemand spricht, steht hier der Text und darunter die Übersetzung.` : "Ich höre zu … Sobald jemand spricht, steht der Text hier.") : SR ? "Pause. Auf den Punkt tippen, um weiter zuzuhören." : "Keine Spracherkennung in diesem Browser.") : null,
      letzte.map((s, i) => el("span", { class: s.vorlaeufig ? "zwischen" : i === letzte.length - 1 ? "neu" : "alt" }, `${s.text} `)),
    );
    const uebersetzung = fremd && tr.length
      ? el("div", { class: "uebersetzung" },
          el("span", { class: "marke-de" }, "DE "),
          letzte.map((s, i) => el("span", { class: i === letzte.length - 1 ? "neu" : "alt" }, s.de ? `${s.de} ` : s.de === null || s.de === undefined ? "… " : "")),
          live.uebersetzFehler ? el("span", { class: "fehlerzeile" }, ` Übersetzung gerade nicht möglich: ${live.uebersetzFehler} (ich versuche es weiter)`) : null,
        )
      : null;
    ersetze(box, original, uebersetzung);
  }

  function fragenSpalteZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.links)) return;
    const st = live.stunde;
    const erkannte = st.fragen.filter((f) => f.status === "fertig");
    const zs = st.zwischenstand;
    const aufgaben = [...(zs?.hausaufgaben || [])];
    const lehrerFragen = zs?.fragen || [];
    ersetze(liveTeile.links,
      erkannte.length ? erkannte.map((f) => el("div", { class: "klein-karte", onclick: () => $(`[data-frage="${f.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }) }, el("div", { class: "wann" }, zeit(f.t)), f.frage)) : null,
      lehrerFragen.length ? [el("h3", {}, "Aus der Stunde"), lehrerFragen.map((f) => el("div", { class: "klein-karte aufgabe" }, el("strong", {}, f.frage), el("div", { class: "muted klein" }, f.antwort)))] : null,
      aufgaben.length ? [el("h3", {}, "Aufgaben und Termine"), aufgaben.map((a) => el("div", { class: "klein-karte aufgabe" }, a))] : null,
      !erkannte.length && !lehrerFragen.length && !aufgaben.length ? el("p", { class: "muted klein" }, "Hier sammeln sich die Fragen der Lehrkraft sowie Aufgaben und Termine.") : null,
    );
  }

  function zwischenstandZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.rechts)) return;
    const zs = live.stunde.zwischenstand;
    const knopf = el("button", { class: "knopf klein", disabled: live.zwischenstandLaeuft, onclick: () => zwischenstandHolen(true) }, live.zwischenstandLaeuft ? el("span", { class: "lade" }) : null, live.zwischenstandLaeuft ? " wird erstellt …" : zs ? "Aktualisieren" : "Jetzt erstellen");
    ersetze(liveTeile.rechts,
      zs
        ? [
            el("p", {}, el("strong", {}, zs.thema)),
            el("p", {}, zs.text),
            zs.kernpunkte?.length ? el("ul", {}, zs.kernpunkte.map((k) => el("li", {}, k))) : null,
            zs.begriffe?.length ? el("ul", {}, zs.begriffe.map((b) => el("li", {}, el("strong", {}, b.begriff), ": ", b.erklaerung))) : null,
            el("div", { class: "stand" }, `Stand ${zeit(zs.stand)}`),
          ]
        : el("p", { class: "muted klein" }, "Alle vier Minuten fasst Claude zusammen, was bisher dran war. Das Erste kommt nach ein paar Minuten."),
      el("div", { style: "margin-top:8px" }, knopf),
    );
  }

  function bildElement(bild) {
    if (!bild) return null;
    const img = el("img", { alt: bild.beschreibung || "Bild", loading: "lazy" });
    if (bild.typ === "svg" && bild.svg) img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bild.svg)}`;
    else if (bild.url) img.src = bild.url;
    else return null;
    const fig = el("figure", { class: "bild" }, img, el("figcaption", {}, [bild.beschreibung, bild.quelle ? ` (${bild.quelle})` : ""].join("")));
    img.onerror = () => ersetze(fig, el("figcaption", {}, "Das Bild konnte nicht geladen werden."));
    return fig;
  }

  function antwortKarte(f, st) {
    const klasse = `karte antwort-karte ${f.status === "wartet" || f.status === "schreibt" ? "wartet" : f.status === "fertig" ? "" : "nichts"}${f.neu ? " neu" : ""}${f.bild ? " mit-bild" : ""}`;
    if (f.neu) setTimeout(() => { f.neu = false; }, 4000);
    const entfernen = () => {
      st.fragen = st.fragen.filter((x) => x.id !== f.id);
      if (live.stunde === st) {
        speichernBald();
        antwortenZeichnen();
      } else db.speichere(st).then(() => zeigeStunde(st.id));
    };
    const kopf = el("div", { class: "kopfzeile" },
      el("span", { class: "tag" }, zeit(f.t)),
      f.erkannt || f.modus === "auto" ? el("span", { class: "tag" }, "automatisch") : el("span", { class: "tag" }, "auf Knopfdruck"),
      f.neu ? el("span", { class: "tag neu-tag" }, "neu") : null,
    );
    const frage = el("div", { class: "frage" },
      f.status === "wartet" ? el("span", { class: "lade" }) : null,
      f.frage ? f.frage : f.modus === "manuell" ? "Was will die Lehrkraft gerade wissen?" : "",
      f.status === "wartet" ? el("span", { class: "muted" }, " … ich überlege") : null,
      f.status === "schreibt" ? el("span", { class: "muted" }, " … schreibt") : null,
    );
    const text = el("div", { class: "text" },
      kopf,
      frage,
      f.status === "fehler" ? el("p", { class: "fehler" }, f.antwort) : f.antwort ? el("p", { class: "antwort" }, f.status === "schreibt" ? `${f.antwort} ▍` : f.antwort) : null,
      f.kurz && f.status === "fertig" ? el("p", { class: "kurz" }, el("span", { class: "muted" }, "Kurz: "), f.kurz) : null,
      f.erklaerung ? el("details", { class: "erklaerung" }, el("summary", {}, "Hintergrund für Rückfragen"), el("p", {}, f.erklaerung)) : null,
      el("div", { class: "fuss" },
        f.antwort && f.status === "fertig" ? el("button", { class: "knopf leise klein", onclick: () => navigator.clipboard?.writeText(f.antwort).then(() => meldung("Kopiert.")) }, "Kopieren") : null,
        f.status === "fehler" ? el("button", { class: "knopf klein", onclick: () => { entfernen(); frageStellen({ modus: f.modus, frage: f.frage || "", erkannt: Boolean(f.erkannt) }); } }, "Noch mal") : null,
        el("button", { class: "knopf leise klein", onclick: entfernen }, "Weg"),
      ),
    );
    return el("div", { class: klasse, dataset: { frage: f.id } }, text, bildElement(f.bild));
  }

  function antwortenZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.antworten)) return;
    const fragen = live.stunde.fragen;
    ersetze(liveTeile.antworten, 
      fragen.length ? fragen.map((f) => antwortKarte(f, live.stunde)) : el("div", { class: "leer-karte" }, el("div", { class: "lade" }), el("p", {}, "Die Automatik hört mit. Sobald die Lehrkraft eine Frage stellt, steht hier die Antwort zum Vorlesen, mit Bild, wenn es eins braucht."), el("p", { class: "muted klein" }, "Unten „Jetzt antworten“, falls sie etwas verpasst.")),
    );
    fragenSpalteZeichnen();
  }

  // Archiv ------------------------------------------------------------------------
  async function zeigeArchiv() {
    navMarkieren("archiv");
    app.classList.remove("breit");
    document.body.classList.remove("gedimmt");
    const liste = await db.alle();
    if (location.hash !== "#archiv") return;
    const faecher = [...new Set(liste.map((s) => s.fach))];
    const fachWahl = el("select", { class: "feld", style: "width:auto" }, el("option", { value: "" }, "Alle Fächer"), faecher.map((f) => el("option", { value: f }, f)));
    const anzahl = el("select", { class: "feld", style: "width:auto" }, [3, 5, 10, 20].map((n) => el("option", { value: n, selected: n === 5 }, `letzte ${n}`)));
    const frage = el("input", { class: "feld", placeholder: "z. B. Worum ging es letzte Woche in Bio?" });
    const ausgabe = el("div", {});
    const nachfragen = async (e) => {
      e.preventDefault();
      const q = frage.value.trim();
      if (!q) return;
      const auswahl = liste.filter((s) => !fachWahl.value || s.fach === fachWahl.value).slice(0, Number(anzahl.value));
      if (!auswahl.length) return meldung("Keine Stunden dafür gespeichert.");
      ersetze(ausgabe, el("div", { class: "karte" }, el("span", { class: "lade" }), " Ich schaue in die Stunden …"));
      try {
        const d = await api("/api/nachfrage", {
          frage: q,
          profil: profil(),
          stunden: auswahl.map((s) => ({
            fach: s.fach,
            datum: `${datumText(s.start)}`,
            titel: s.zusammenfassung?.titel || "",
            zusammenfassung: s.zusammenfassung ? `${s.zusammenfassung.thema}\n${s.zusammenfassung.text}` : "",
            kernpunkte: s.zusammenfassung?.kernpunkte || [],
            // Transkripte nur bei wenigen Stunden mitschicken, sonst wird es teuer
            transkript: auswahl.length <= 3 ? s.transkript : [],
          })),
        });
        ersetze(ausgabe, 
          el("div", { class: "karte antwort-karte" },
            el("div", { class: "frage" }, `Frage: ${q}`),
            el("p", { class: "antwort" }, d.antwort),
            d.quellen?.length ? el("p", { class: "erklaerung" }, `Aus: ${d.quellen.join("; ")}`) : null,
          ),
        );
      } catch (err) {
        ersetze(ausgabe, el("div", { class: "karte" }, `Fehler: ${err.message}`));
      }
    };
    const gefiltert = () => liste.filter((s) => !fachWahl.value || s.fach === fachWahl.value);
    const stundenListe = el("div", { class: "liste" });
    const listeZeichnen = () => ersetze(stundenListe, gefiltert().length ? gefiltert().map(stundenKarte) : el("p", { class: "muted" }, "Noch keine Stunden gespeichert."));
    fachWahl.addEventListener("change", listeZeichnen);
    listeZeichnen();
    ersetze(app, 
      el("h1", {}, "Deine Stunden"),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Frag deine Stunden"),
        el("form", { class: "spalte", onsubmit: nachfragen },
          frage,
          el("div", { class: "reihe" }, fachWahl, anzahl, el("button", { class: "knopf primaer", type: "submit" }, "Fragen")),
        ),
        ausgabe,
      ),
      el("h2", {}, "Alle Stunden"),
      stundenListe,
    );
  }

  async function zeigeStunde(id) {
    navMarkieren("archiv");
    app.classList.remove("breit");
    document.body.classList.remove("gedimmt");
    const st = await db.hole(id);
    if (location.hash !== `#stunde/${id}`) return;
    if (!st) {
      ersetze(app, el("p", {}, "Diese Stunde gibt es nicht mehr."), el("a", { class: "knopf", href: "#archiv" }, "Zu den Stunden"));
      return;
    }
    const z = st.zusammenfassung;
    const notizen = el("textarea", { class: "feld", placeholder: "Eigene Notizen zur Stunde …", onchange: async (e) => { st.notizen = e.target.value; await db.speichere(st); meldung("Notiz gespeichert."); } }, st.notizen || "");
    const kinder = [
      el("a", { class: "knopf leise", href: "#archiv" }, "← Alle Stunden"),
      el("h1", {}, z?.titel || st.fach),
      el("p", { class: "muted" }, `${st.fach}${st.sprache && st.sprache !== "de" ? ` (${spracheName(st.sprache)}, mit Übersetzung)` : ""} · ${datumText(st.start)}, ${uhrText(st.start)} · ${zeit(st.dauer || 0)}`),
    ];
    if (st.zusammenfassungLaeuft) kinder.push(el("div", { class: "karte" }, el("span", { class: "lade" }), " Claude fasst die Stunde zusammen …"));
    else if (z) {
      kinder.push(
        el("div", { class: "karte" },
          el("h3", { style: "margin-top:0" }, "Worum es ging"),
          el("p", {}, z.thema),
          el("p", {}, z.text),
          z.kernpunkte?.length ? [el("h3", {}, "Das Wichtigste"), el("ul", { class: "punkte" }, z.kernpunkte.map((k) => el("li", {}, k)))] : null,
          z.hausaufgaben?.length ? [el("h3", {}, "Hausaufgaben und Termine"), el("ul", { class: "punkte" }, z.hausaufgaben.map((k) => el("li", {}, k)))] : null,
          z.fragen?.length ? [el("h3", {}, "Fragen der Lehrkraft"), el("ul", { class: "punkte" }, z.fragen.map((f) => el("li", {}, el("strong", {}, f.frage), " ", f.antwort)))] : null,
          z.begriffe?.length ? [el("h3", {}, "Begriffe"), el("ul", { class: "punkte" }, z.begriffe.map((b) => el("li", {}, el("strong", {}, b.begriff), ": ", b.erklaerung)))] : null,
        ),
      );
    } else {
      kinder.push(el("div", { class: "karte" }, st.zwischenstand ? [el("p", {}, el("strong", {}, st.zwischenstand.thema)), el("p", {}, st.zwischenstand.text), el("p", { class: "muted klein" }, `Zwischenstand von ${zeit(st.zwischenstand.stand)}, noch keine Endzusammenfassung.`)] : el("p", {}, "Noch keine Zusammenfassung."), el("button", { class: "knopf primaer", onclick: () => zusammenfassen(id), disabled: st.transkript.length < 3 }, "Jetzt zusammenfassen")));
    }
    const antworten = st.fragen.filter((f) => f.status === "fertig" || f.status === "nichts");
    if (antworten.length) kinder.push(el("h2", {}, "Antworten in dieser Stunde"), el("div", { class: "spalte" }, antworten.map((f) => antwortKarte(f, st))));
    kinder.push(
      el("h2", {}, "Notizen"),
      notizen,
      el("details", {},
        el("summary", {}, `Mitschrift (${st.transkript.length} Sätze)`),
        el("div", { class: "transkript", style: "max-height:60vh" }, st.transkript.length ? st.transkript.map((s) => el("p", { class: "seg" }, el("time", {}, zeit(s.t)), s.text, s.de ? el("span", { class: "de" }, ` · ${s.de}`) : null)) : el("p", { class: "leer" }, "Leer.")),
      ),
      el("div", { class: "reihe abstand" },
        el("button", { class: "knopf", onclick: () => exportieren(st) }, "Als Text teilen"),
        z ? el("button", { class: "knopf", onclick: () => zusammenfassen(id) }, "Neu zusammenfassen") : null,
        el("button", { class: "knopf gefahr", onclick: async () => { if (confirm("Diese Stunde wirklich löschen?")) { await db.loesche(id); location.hash = "#archiv"; } } }, "Löschen"),
      ),
    );
    ersetze(app, ...kinder);
  }

  function exportText(st) {
    const z = st.zusammenfassung;
    const zeilen = [`${st.fach} – ${datumText(st.start)} ${uhrText(st.start)} (${zeit(st.dauer || 0)})`, ""];
    if (z) {
      zeilen.push(`# ${z.titel}`, z.thema, "", z.text, "");
      if (z.kernpunkte?.length) zeilen.push("Das Wichtigste:", ...z.kernpunkte.map((k) => `- ${k}`), "");
      if (z.hausaufgaben?.length) zeilen.push("Hausaufgaben und Termine:", ...z.hausaufgaben.map((k) => `- ${k}`), "");
      if (z.fragen?.length) zeilen.push("Fragen der Lehrkraft:", ...z.fragen.map((f) => `- ${f.frage} → ${f.antwort}`), "");
      if (z.begriffe?.length) zeilen.push("Begriffe:", ...z.begriffe.map((b) => `- ${b.begriff}: ${b.erklaerung}`), "");
    }
    const antworten = st.fragen.filter((f) => f.status === "fertig");
    if (antworten.length) zeilen.push("Antworten:", ...antworten.map((f) => `- [${zeit(f.t)}] ${f.frage}\n  ${f.antwort}${f.kurz ? `\n  Kurz: ${f.kurz}` : ""}`), "");
    if (st.notizen) zeilen.push("Notizen:", st.notizen, "");
    zeilen.push("Mitschrift:", ...st.transkript.map((s) => `[${zeit(s.t)}] ${s.text}${s.de ? `\n        DE: ${s.de}` : ""}`));
    return zeilen.join("\n");
  }

  async function exportieren(st) {
    const text = exportText(st);
    const name = `${st.datum}-${st.fach.replace(/[^\wäöüß-]+/gi, "_")}.txt`;
    if (navigator.share) {
      try {
        const datei = new File([text], name, { type: "text/plain" });
        if (navigator.canShare?.({ files: [datei] })) await navigator.share({ files: [datei], title: name });
        else await navigator.share({ title: name, text });
        return;
      } catch {
        /* abgebrochen oder nicht möglich: Download */
      }
    }
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // Einstellungen --------------------------------------------------------------------
  function zeigeEinstellungen() {
    navMarkieren("einstellungen");
    app.classList.remove("breit");
    document.body.classList.remove("gedimmt");
    const f = (name, attrs = {}) => el("input", { class: "feld", value: einst[name] ?? "", ...attrs, onchange: (e) => { einst[name] = e.target.value.trim(); speichereEinstellungen(); } });
    const schalter = (name, text) => el("label", { class: "schalter", style: "display:flex;margin:8px 0" }, el("input", { type: "checkbox", checked: einst[name], onchange: (e) => { einst[name] = e.target.checked; speichereEinstellungen(); } }), text);
    const faecher = el("textarea", { class: "feld", onchange: (e) => { einst.faecher = e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean); speichereEinstellungen(); } }, einst.faecher.join(", "));
    const status = el("span", { class: "muted klein" });
    const pruefen = async () => {
      ersetze(status, el("span", { class: "lade" }));
      try {
        const d = await api("/api/status");
        live.anbieter = d;
        status.textContent = d.schluessel ? `Server erreichbar · ${d.anbieterName} · Modell ${d.modell} · App-Schlüssel ${d.geschuetzt ? "nötig" : "nicht gesetzt"}` : "Server erreichbar, aber keine KI eingerichtet (Workers-AI-Binding oder Schlüssel fehlt).";
      } catch (e) {
        status.textContent = e.message;
      }
    };
    ersetze(app, 
      el("h1", {}, "Einstellungen"),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Server"),
        el("label", { class: "block" }, "Adresse"),
        f("server", { placeholder: "leer = gleiche Adresse wie die App", inputmode: "url" }),
        el("p", { class: "hinweis" }, "Nur nötig, wenn die App woanders liegt als der Worker. Normalerweise leer lassen."),
        el("label", { class: "block" }, "App-Schlüssel"),
        f("appKey", { type: "password", placeholder: "das APP_KEY-Passwort vom Worker" }),
        el("div", { class: "reihe abstand" }, el("button", { class: "knopf", onclick: pruefen }, "Verbindung prüfen"), status),
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Über dich"),
        el("p", { class: "hinweis" }, "Damit die Antworten zum Niveau passen."),
        el("label", { class: "block" }, "Klassenstufe"),
        f("klasse", { placeholder: "z. B. 9", inputmode: "numeric" }),
        el("label", { class: "block" }, "Schulform"),
        f("schulform", { placeholder: "z. B. Gymnasium" }),
        el("label", { class: "block" }, "Vorname (optional)"),
        f("name", { placeholder: "" }),
        el("label", { class: "block" }, "Antwortlänge"),
        el("select", { class: "feld", onchange: (e) => { einst.antwortlaenge = e.target.value; speichereEinstellungen(); } },
          [["kurz", "Kurz: ein Satz"], ["mittel", "Mittel: ein bis drei Sätze"], ["lang", "Lang: mit Begründung und Beispiel"]].map(([w, t]) => el("option", { value: w, selected: einst.antwortlaenge === w }, t)),
        ),
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Fächer"),
        el("p", { class: "hinweis" }, "Durch Komma getrennt, in dieser Reihenfolge auf der Startseite."),
        faecher,
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Zuhören"),
        schalter("auto", "Fragen automatisch erkennen und beantworten"),
        schalter("websuche", "Im Internet nachschlagen, wenn die KI sich nicht sicher ist (nur mit Claude als Anbieter)"),
        schalter("ton", "Kurzer Ton, wenn eine Antwort da ist"),
        schalter("vibrieren", "Vibrieren, wenn eine Antwort da ist"),
        el("p", { class: "hinweis" }, "Die Sprache der Lehrkraft wählst du beim Start jeder Stunde (bei Englisch, Französisch, Spanisch wird sie automatisch vorgeschlagen). Dann läuft die Mitschrift in dieser Sprache und darunter die deutsche Übersetzung."),
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Daten"),
        el("p", { class: "hinweis" }, "Alle Stunden liegen nur auf diesem Gerät. Zum Sichern jede Stunde als Text teilen."),
        el("button", { class: "knopf gefahr", onclick: async () => { if (confirm("Wirklich alle Stunden löschen?")) { await db.alleLoeschen(); meldung("Alles gelöscht."); } } }, "Alle Stunden löschen"),
      ),
    );
    pruefen();
  }

  // Router ------------------------------------------------------------------------
  // Einrichtungslink: https://…/#schluessel=PASSWORT speichert den App-Schlüssel
  // und die Server-Adresse von selbst, damit auf dem Gerät nichts getippt werden muss.
  function einrichtungsLink() {
    const m = (location.hash || "").match(/^#schluessel=([^&]+)/);
    if (!m) return false;
    einst.appKey = decodeURIComponent(m[1]);
    einst.server = "";
    einst.hinweisGesehen = einst.hinweisGesehen || false;
    speichereEinstellungen();
    history.replaceState(null, "", "#start");
    meldung("Eingerichtet. Jetzt noch „Zum Home-Bildschirm“ über das Teilen-Symbol.", 8000);
    return true;
  }
  function routen() {
    if (einrichtungsLink()) return routen();
    const h = location.hash || "#start";
    if (h === "#start") zeigeStart();
    else if (h === "#live") zeigeLive();
    else if (h === "#archiv") zeigeArchiv();
    else if (h.startsWith("#stunde/")) zeigeStunde(h.slice(8));
    else if (h === "#einstellungen") zeigeEinstellungen();
    else location.hash = "#start";
  }
  window.addEventListener("hashchange", routen);
  window.addEventListener("beforeunload", (e) => {
    if (live.stunde && live.hoert) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  routen();

  // Für Tests und zum Nachtragen von Hand: window.unterricht.einspeisen("…")
  window.unterricht = {
    einspeisen: (text) => { segmentHinzu(text); transkriptZeichnen(); },
    zwischen: (text) => { live.zwischen = text; vorlaeufigAktualisieren(text); transkriptZeichnen(); },
    zustand: () => ({ hoert: live.hoert, pausiert: live.pausiert, stunde: live.stunde }),
    zwischenstand: () => zwischenstandHolen(true),
    waechter: () => waechterPruefen(),
    uebersetzen,
    exportText,
    istFrage,
  };
})();
