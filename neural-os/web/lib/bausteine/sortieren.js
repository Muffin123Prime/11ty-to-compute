/**
 * bausteine/sortieren.js -- Reihenfolge per Ziehen und per Tastatur.
 *
 * Pointer Events statt HTML5-Drag-and-Drop: Das native Ziehen kennt auf dem
 * iPad keinen Finger (Safari liefert dort keine dragstart-Ereignisse fuer
 * Listenzeilen) und zeigt mit der Maus ein halbdurchsichtiges Geisterbild,
 * das man nicht gestalten kann. Hier wandert die Zeile selbst mit, die
 * anderen weichen ruhig aus, und losgelassen wird genau dort, wo die Luecke
 * ist.
 *
 * Nur der Griff startet das Ziehen (touch-action: none nur dort): Ueberall
 * sonst rollt der Finger die Seite wie gewohnt.
 *
 * Tastatur: Alt+↑/↓ auf dem Griff verschiebt um einen Platz.
 */

/**
 * @param {HTMLElement} liste    Container; jede Zeile traegt data-sort-index="i" (Platz in der Anzeige)
 * @param {(von:number, nach:number) => void} umordnen
 * @param {{ansage?:(satz:string)=>void}} [opts]
 */
export function sortierbarMachen(liste, umordnen, opts = {}) {
  const zeilen = () => [...liste.querySelectorAll(':scope > [data-sort-index]')];
  let zug = null;

  const aufraeumen = () => {
    for (const z of zeilen()) {
      z.style.transform = '';
      z.style.transition = '';
      z.classList.remove('is-zieht', 'is-weicht');
    }
    liste.classList.remove('is-sortiert');
    zug = null;
  };

  liste.addEventListener('pointerdown', (e) => {
    const griff = e.target.closest('[data-griff]');
    if (!griff || !liste.contains(griff) || e.button > 0) return;
    const zeile = griff.closest('[data-sort-index]');
    if (!zeile) return;
    e.preventDefault();
    e.stopPropagation();
    const alle = zeilen();
    const rects = alle.map((z) => z.getBoundingClientRect());
    const von = alle.indexOf(zeile);
    zug = { id: e.pointerId, von, nach: von, y0: e.clientY, rects, alle, zeile, hoehe: rects[von].height + gap(alle, rects) };
    try { griff.setPointerCapture(e.pointerId); } catch { /* aeltere Browser */ }
    zeile.classList.add('is-zieht');
    liste.classList.add('is-sortiert');
    for (const z of alle) if (z !== zeile) z.classList.add('is-weicht');
  });

  liste.addEventListener('pointermove', (e) => {
    if (!zug || e.pointerId !== zug.id) return;
    e.preventDefault();
    const dy = e.clientY - zug.y0;
    zug.zeile.style.transform = `translateY(${dy}px)`;
    const mitte = zug.rects[zug.von].top + zug.rects[zug.von].height / 2 + dy;
    let nach = zug.von;
    zug.rects.forEach((r, i) => {
      if (i === zug.von) return;
      const m = r.top + r.height / 2;
      if (i > zug.von && mitte > m) nach = Math.max(nach, i);
      if (i < zug.von && mitte < m) nach = Math.min(nach, i);
    });
    zug.nach = nach;
    zug.alle.forEach((z, i) => {
      if (i === zug.von) return;
      let s = 0;
      if (zug.von < nach && i > zug.von && i <= nach) s = -zug.hoehe;
      if (zug.von > nach && i < zug.von && i >= nach) s = zug.hoehe;
      z.style.transform = s ? `translateY(${s}px)` : '';
    });
  });

  const ende = (e) => {
    if (!zug || e.pointerId !== zug.id) return;
    const { von, nach } = zug;
    aufraeumen();
    if (von !== nach) {
      umordnen(von, nach);
      if (opts.ansage) opts.ansage(`Auf Platz ${nach + 1} verschoben.`);
    }
  };
  liste.addEventListener('pointerup', ende);
  liste.addEventListener('pointercancel', (e) => { if (zug && e.pointerId === zug.id) aufraeumen(); });
  // Ein Klick nach dem Ziehen soll keinen Haken setzen.
  liste.addEventListener('click', (e) => { if (e.target.closest('[data-griff]')) e.stopPropagation(); });

  liste.addEventListener('keydown', (e) => {
    const griff = e.target.closest('[data-griff]');
    if (!griff || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const zeile = griff.closest('[data-sort-index]');
    const alle = zeilen();
    const von = alle.indexOf(zeile);
    const nach = von + (e.key === 'ArrowUp' ? -1 : 1);
    e.preventDefault();
    e.stopPropagation();
    if (von < 0 || nach < 0 || nach >= alle.length) return;
    umordnen(von, nach);
    if (opts.ansage) opts.ansage(`Auf Platz ${nach + 1} verschoben.`);
  });
}

function gap(alle, rects) {
  if (alle.length < 2) return 0;
  return Math.max(0, rects[1].top - rects[0].bottom);
}

/** Das CSS fuer sortierbare Zeilen (von liste.js und checkliste.js benutzt). */
export const SORTIER_CSS = `
.bs-griff { display: inline-grid; place-items: center; flex: none; width: 26px; height: 32px; margin-left: -6px; padding: 0; color: var(--fg-subtle); background: none; border: 0; border-radius: var(--r-1); cursor: grab; touch-action: none; }
.bs-griff:hover { color: var(--fg-muted); background: var(--surface-3); }
.bs-griff:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-griff svg { width: 16px; height: 16px; }
.is-sortiert { user-select: none; -webkit-user-select: none; }
.is-sortiert .bs-griff { cursor: grabbing; }
[data-sort-index].is-weicht { transition: transform var(--dur-3) var(--ease); }
[data-sort-index].is-zieht { position: relative; z-index: 2; background: var(--surface-2); box-shadow: var(--shadow-2); border-radius: var(--r-2); }
@media (pointer: coarse) {
  .bs-griff { width: 40px; height: var(--tap-min); }
}
`;
