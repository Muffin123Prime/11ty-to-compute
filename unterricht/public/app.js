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
    auto: true,
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
  const profil = () => ({ klasse: einst.klasse, schulform: einst.schulform, name: einst.name });

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
  };
  const liveSekunden = () => (live.startMs ? (Date.now() - live.startMs - live.pausenMs - (live.pauseSeitMs ? Date.now() - live.pauseSeitMs : 0)) / 1000 : 0);

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function recAnlegen() {
    const rec = new SR();
    rec.lang = einst.sprache || "de-DE";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let zwischen = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0]?.transcript || "").trim();
        if (!text) continue;
        if (r.isFinal) segmentHinzu(text);
        else zwischen += (zwischen ? " " : "") + text;
      }
      live.zwischen = zwischen;
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
      liveKopfZeichnen();
    };
    return rec;
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
  });

  function segmentHinzu(text) {
    if (!live.stunde) return;
    const t = Math.max(0, Math.round(liveSekunden()));
    live.stunde.transkript.push({ t, text });
    speichernBald();
    if (einst.auto && istFrage(text)) autoAntwort(text);
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

  async function autoAntwort(text) {
    const jetzt = Date.now();
    if (jetzt - live.letzteAnfrageMs < 12000) return; // nicht bei jedem Satz
    if (text === live.letzteFrageText) return;
    live.letzteAnfrageMs = jetzt;
    live.letzteFrageText = text;
    await frageStellen({ modus: "auto", hinweisText: text });
  }

  async function frageStellen({ modus, frage = "", hinweisText = "" }) {
    if (!live.stunde) return;
    const karte = { id: neueId(), t: Math.round(liveSekunden()), modus, frage: frage || hinweisText, antwort: "", erklaerung: "", bild: null, status: "wartet" };
    live.stunde.fragen.unshift(karte);
    live.laufend++;
    antwortenZeichnen();
    try {
      const d = await api("/api/antwort", {
        fach: live.stunde.fach,
        transkript: letzteSegmente(),
        frage,
        modus,
        profil: profil(),
      });
      if (!d.frage_erkannt) {
        if (modus === "auto") {
          // Claude sagt: keine echte Frage. Karte wieder weg, kein Lärm.
          live.stunde.fragen = live.stunde.fragen.filter((f) => f.id !== karte.id);
        } else {
          karte.status = "nichts";
          karte.antwort = "Ich habe gerade keine Frage der Lehrkraft gefunden. Tipp sie unten ein, dann beantworte ich sie.";
        }
      } else {
        Object.assign(karte, { status: "fertig", frage: d.frage || karte.frage, antwort: d.antwort, erklaerung: d.erklaerung || "", bild: d.bild || null });
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

  // ---------- Live: Start / Pause / Ende --------------------------------------
  async function stundeStarten(fach) {
    const start = new Date();
    live.stunde = {
      id: neueId(),
      fach,
      datum: start.toISOString().slice(0, 10),
      start: start.toISOString(),
      dauer: 0,
      transkript: [],
      fragen: [],
      zusammenfassung: null,
      notizen: "",
    };
    live.startMs = Date.now();
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
    try {
      live.rec.start();
    } catch {
      /* läuft schon */
    }
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
    st.dauer = Math.round(liveSekunden());
    live.stunde = null;
    live.startMs = 0;
    clearInterval(live.timer);
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

  function zeigeStart() {
    navMarkieren("start");
    const kinder = [];
    if (!einst.hinweisGesehen) {
      kinder.push(
        el("div", { class: "karte" },
          el("h2", { style: "margin-top:0" }, "Bevor es losgeht"),
          el("p", {}, "Die App hört über das Mikrofon mit und schreibt den Unterricht als Text auf dieses Gerät. Sag deiner Lehrkraft Bescheid und frag, ob das für dich in Ordnung ist: Unterricht ohne Einverständnis aufzunehmen ist in Deutschland nicht erlaubt. Mit Text statt Tonaufnahme und nur für dich selbst bist du auf der sicheren Seite, wenn die Lehrkraft zugestimmt hat."),
          el("p", {}, "Wenn die Lehrkraft eine Frage stellt, bekommst du einen Vorschlag, den du laut vorlesen kannst. Lies ihn kurz, bevor du dich meldest: Die Spracherkennung verhört sich manchmal."),
          el("button", { class: "knopf primaer", onclick: () => { einst.hinweisGesehen = true; speichereEinstellungen(); zeigeStart(); } }, "Verstanden"),
        ),
      );
    }
    if (live.stunde) {
      kinder.push(
        el("div", { class: "karte" },
          el("div", { class: "status" }, el("span", { class: `punkt ${live.pausiert ? "pause" : live.hoert ? "an" : ""}` }), `Läuft gerade: ${live.stunde.fach}`),
          el("p", { class: "muted klein" }, `seit ${uhrText(live.stunde.start)}, ${live.stunde.transkript.length} Sätze`),
          el("a", { class: "knopf primaer", href: "#live" }, "Zurück zur Stunde"),
        ),
      );
    }
    kinder.push(el("h1", {}, "Welche Stunde ist jetzt?"));
    kinder.push(
      el("div", { class: "fach-raster" },
        einst.faecher.map((f) => el("button", { class: "knopf", onclick: () => stundeStarten(f), disabled: Boolean(live.stunde) }, f)),
      ),
    );
    const eigenes = el("input", { class: "feld", placeholder: "Anderes Fach oder Thema …" });
    kinder.push(
      el("form", { class: "reihe abstand", onsubmit: (e) => { e.preventDefault(); const v = eigenes.value.trim(); if (v) stundeStarten(v); } },
        eigenes,
        el("button", { class: "knopf", type: "submit", disabled: Boolean(live.stunde) }, "Starten"),
      ),
    );
    if (!SR) kinder.push(el("p", { class: "hinweis abstand" }, "Hinweis: Dieser Browser kann nicht zuhören. Auf iPhone und iPad bitte Safari benutzen, am Computer Chrome oder Edge."));
    ersetze(app, ...kinder);
    db.alle().then((liste) => {
      if (!liste.length || location.hash !== "#start" && location.hash !== "") return;
      const letzte = liste.slice(0, 3);
      app.append(
        el("h2", {}, "Zuletzt"),
        el("div", { class: "liste" }, letzte.map(stundenKarte)),
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
    const kopf = el("div", { class: "live-kopf" });
    const transkript = el("div", { class: "transkript", "aria-live": "polite" });
    const antworten = el("div", { class: "spalte" });
    const eingabe = el("input", { class: "feld", placeholder: "Frage eintippen, falls die Erkennung sie verpasst hat …", autocomplete: "off" });
    const mitschrift = el("input", { class: "feld", placeholder: SR ? "Gehörtes von Hand ergänzen …" : "Mitschrift eintippen (keine Spracherkennung) …", autocomplete: "off" });
    const autoSchalter = el("input", { type: "checkbox", checked: einst.auto, onchange: (e) => { einst.auto = e.target.checked; speichereEinstellungen(); } });
    const leiste = el("div", { class: "leiste" },
      el("button", { class: "knopf primaer gross", onclick: () => frageStellen({ modus: "manuell" }) }, "Jetzt antworten"),
      el("form", { onsubmit: (e) => { e.preventDefault(); const v = eingabe.value.trim(); if (!v) return; eingabe.value = ""; frageStellen({ modus: "manuell", frage: v }); } },
        eingabe,
        el("button", { class: "knopf", type: "submit" }, "Fragen"),
      ),
    );
    const notieren = el("form", { class: "reihe", style: "margin-top:8px", onsubmit: (e) => { e.preventDefault(); const v = mitschrift.value.trim(); if (!v) return; mitschrift.value = ""; segmentHinzu(v); transkriptZeichnen(); } },
      mitschrift,
      el("button", { class: "knopf", type: "submit" }, "Notieren"),
    );
    notieren.style.display = "flex";
    mitschrift.style.flex = "1";
    liveTeile = { kopf, transkript, antworten, autoSchalter };
    ersetze(app, kopf, el("h2", { style: "margin-top:4px" }, "Antworten"), antworten, el("h2", {}, "Mitschrift"), transkript, notieren, leiste);
    liveKopfZeichnen();
    transkriptZeichnen();
    antwortenZeichnen();
    clearInterval(live.timer);
    live.timer = setInterval(() => {
      const z = liveTeile && $(".zeit", liveTeile.kopf);
      if (z) z.textContent = zeit(liveSekunden());
    }, 1000);
  }

  function liveKopfZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.kopf)) return;
    const zustand = !live.hoert ? "aus" : live.pausiert ? "pause" : "an";
    const text = zustand === "an" ? "hört zu" : zustand === "pause" ? "Pause" : SR ? "aus" : "nur Tippen";
    ersetze(liveTeile.kopf,
      el("div", { class: "reihe", style: "justify-content:space-between" },
        el("div", { class: "status" }, el("span", { class: `punkt ${zustand === "an" ? "an" : zustand === "pause" ? "pause" : ""}` }), live.stunde.fach, el("span", { class: "muted" }, ` · ${text}`), el("span", { class: "zeit" }, ` ${zeit(liveSekunden())}`)),
        el("div", { class: "reihe", style: "gap:6px" },
          SR ? el("button", { class: "knopf", onclick: () => (live.pausiert || !live.hoert ? hoerenStarten() : hoerenPausieren()) }, live.pausiert || !live.hoert ? "Weiter" : "Pause") : null,
          el("button", { class: "knopf", onclick: () => { if (confirm("Stunde beenden und zusammenfassen?")) stundeBeenden(); } }, "Beenden"),
        ),
      ),
      el("label", { class: "schalter", style: "margin-top:6px" }, liveTeile.autoSchalter, "Fragen automatisch erkennen und beantworten"),
    );
  }

  function transkriptZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.transkript)) return;
    const box = liveTeile.transkript;
    const unten = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    const tr = live.stunde.transkript;
    const sichtbar = tr.slice(-120);
    ersetze(box, 
      tr.length === 0 && !live.zwischen ? el("p", { class: "leer" }, live.hoert ? "Ich höre zu … Sobald jemand spricht, erscheint der Text hier." : "Noch nichts aufgeschrieben.") : null,
      sichtbar.map((s) => el("p", { class: `seg${istFrage(s.text) ? " frage" : ""}` }, el("time", {}, zeit(s.t)), s.text)),
      live.zwischen ? el("p", { class: "seg zwischen" }, live.zwischen) : null,
    );
    if (unten) box.scrollTop = box.scrollHeight;
  }

  function bildElement(bild) {
    if (!bild) return null;
    const img = el("img", { alt: bild.beschreibung || "Bild", loading: "lazy" });
    if (bild.typ === "svg" && bild.svg) img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bild.svg)}`;
    else if (bild.url) img.src = bild.url;
    else return null;
    const fig = el("figure", { class: "bild", style: "margin:10px 0 0" }, img, el("figcaption", {}, [bild.beschreibung, bild.quelle ? ` (${bild.quelle})` : ""].join("")));
    img.onerror = () => ersetze(fig, el("figcaption", {}, "Das Bild konnte nicht geladen werden."));
    return fig;
  }

  function antwortKarte(f, st) {
    const klasse = `karte antwort-karte ${f.status === "wartet" ? "wartet" : f.status === "fertig" ? "" : "nichts"}`;
    return el("div", { class: klasse },
      el("div", { class: "frage" }, f.status === "wartet" ? el("span", {}, el("span", { class: "lade" }), " Ich überlege … ") : null, f.frage ? `Frage: ${f.frage}` : f.modus === "manuell" ? "Was will die Lehrkraft gerade wissen?" : ""),
      f.antwort ? el("p", { class: "antwort" }, f.antwort) : null,
      f.erklaerung ? el("p", { class: "erklaerung" }, f.erklaerung) : null,
      bildElement(f.bild),
      el("div", { class: "fuss" },
        el("span", { class: "tag" }, zeit(f.t)),
        f.antwort && f.status === "fertig" ? el("button", { class: "knopf leise klein", onclick: () => navigator.clipboard?.writeText(f.antwort).then(() => meldung("Kopiert.")) }, "Kopieren") : null,
        f.status === "fehler" ? el("button", { class: "knopf leise klein", onclick: () => { st.fragen = st.fragen.filter((x) => x.id !== f.id); frageStellen({ modus: f.modus, frage: f.modus === "manuell" && f.frage && !f.antwort.startsWith("Ich") ? f.frage : "" }); } }, "Noch mal") : null,
        el("button", { class: "knopf leise klein", onclick: () => { st.fragen = st.fragen.filter((x) => x.id !== f.id); speichernBald(); antwortenZeichnen(); if (!live.stunde) db.speichere(st).then(() => zeigeStunde(st.id)); } }, "Weg"),
      ),
    );
  }

  function antwortenZeichnen() {
    if (!liveTeile || !live.stunde || !document.contains(liveTeile.antworten)) return;
    const fragen = live.stunde.fragen;
    ersetze(liveTeile.antworten, 
      fragen.length ? fragen.map((f) => antwortKarte(f, live.stunde)) : el("p", { class: "muted" }, "Wenn die Lehrkraft etwas fragt, steht hier der Vorschlag. Oder drück „Jetzt antworten“."),
    );
  }

  // Archiv ------------------------------------------------------------------------
  async function zeigeArchiv() {
    navMarkieren("archiv");
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
      el("p", { class: "muted" }, `${st.fach} · ${datumText(st.start)}, ${uhrText(st.start)} · ${zeit(st.dauer || 0)}`),
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
      kinder.push(el("div", { class: "karte" }, el("p", {}, "Noch keine Zusammenfassung."), el("button", { class: "knopf primaer", onclick: () => zusammenfassen(id), disabled: st.transkript.length < 3 }, "Jetzt zusammenfassen")));
    }
    const antworten = st.fragen.filter((f) => f.status === "fertig" || f.status === "nichts");
    if (antworten.length) kinder.push(el("h2", {}, "Antworten in dieser Stunde"), el("div", { class: "spalte" }, antworten.map((f) => antwortKarte(f, st))));
    kinder.push(
      el("h2", {}, "Notizen"),
      notizen,
      el("details", {},
        el("summary", {}, `Mitschrift (${st.transkript.length} Sätze)`),
        el("div", { class: "transkript", style: "max-height:60vh" }, st.transkript.length ? st.transkript.map((s) => el("p", { class: "seg" }, el("time", {}, zeit(s.t)), s.text)) : el("p", { class: "leer" }, "Leer.")),
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
    if (antworten.length) zeilen.push("Antworten:", ...antworten.map((f) => `- [${zeit(f.t)}] ${f.frage}\n  ${f.antwort}`), "");
    if (st.notizen) zeilen.push("Notizen:", st.notizen, "");
    zeilen.push("Mitschrift:", ...st.transkript.map((s) => `[${zeit(s.t)}] ${s.text}`));
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
    const f = (name, attrs = {}) => el("input", { class: "feld", value: einst[name] ?? "", ...attrs, onchange: (e) => { einst[name] = e.target.value.trim(); speichereEinstellungen(); } });
    const schalter = (name, text) => el("label", { class: "schalter", style: "display:flex;margin:8px 0" }, el("input", { type: "checkbox", checked: einst[name], onchange: (e) => { einst[name] = e.target.checked; speichereEinstellungen(); } }), text);
    const faecher = el("textarea", { class: "feld", onchange: (e) => { einst.faecher = e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean); speichereEinstellungen(); } }, einst.faecher.join(", "));
    const status = el("span", { class: "muted klein" });
    const pruefen = async () => {
      ersetze(status, el("span", { class: "lade" }));
      try {
        const d = await api("/api/status");
        status.textContent = `Server erreichbar · Modell ${d.modell} · Anthropic-Schlüssel ${d.schluessel ? "vorhanden" : "FEHLT"} · App-Schlüssel ${d.geschuetzt ? "nötig" : "nicht gesetzt"}`;
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
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Fächer"),
        el("p", { class: "hinweis" }, "Durch Komma getrennt, in dieser Reihenfolge auf der Startseite."),
        faecher,
      ),
      el("div", { class: "karte" },
        el("h3", { style: "margin-top:0" }, "Zuhören"),
        schalter("auto", "Fragen automatisch erkennen und beantworten"),
        schalter("ton", "Kurzer Ton, wenn eine Antwort da ist"),
        schalter("vibrieren", "Vibrieren, wenn eine Antwort da ist"),
        el("label", { class: "block" }, "Sprache der Erkennung"),
        f("sprache", { placeholder: "de-DE" }),
        el("p", { class: "hinweis" }, "Für Englischunterricht en-GB oder en-US eintragen, danach die Stunde neu starten."),
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
  function routen() {
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
    zustand: () => ({ hoert: live.hoert, pausiert: live.pausiert, stunde: live.stunde }),
    exportText,
    istFrage,
  };
})();
