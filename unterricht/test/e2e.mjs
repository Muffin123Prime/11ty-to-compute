// Durchlauf der Oberfläche im Browser gegen den Attrappen-Server:
//   node server.mjs --mock &   (Port 8787)
//   node test/e2e.mjs [screenshot-ordner]
// Braucht ein installiertes Playwright mit Chromium.
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const basis = process.env.BASIS || "http://localhost:8787";
const bilder = process.argv[2] || "";
if (bilder) mkdirSync(bilder, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE", colorScheme: "light" });
const page = await ctx.newPage();
page.on("pageerror", (e) => { console.error("Seitenfehler:", e.message); process.exitCode = 1; });
const foto = async (name) => bilder && (await page.screenshot({ path: `${bilder}/${name}.png`, fullPage: true }));

await page.goto(`${basis}/#start`);
await page.getByRole("button", { name: "Verstanden" }).click();
await page.getByText("Server verbunden.").waitFor({ timeout: 10000 });
await foto("1-start");

// Stunde starten (ohne echte Spracherkennung: Headless-Chromium hat keinen Dienst)
await page.getByRole("button", { name: "Zuhören starten" }).click();
await page.getByText("Erst oben das Fach antippen.").waitFor();
await page.getByRole("button", { name: "Chemie", exact: true }).click();
await page.getByRole("button", { name: "Zuhören starten" }).click();
await page.waitForURL(/#live/);
await page.evaluate(() => {
  window.unterricht.einspeisen("so heute machen wir weiter mit den molekülen");
  window.unterricht.einspeisen("wasser besteht aus wasserstoff und sauerstoff");
});
await page.waitForTimeout(300);
assert.match(await page.locator(".live-text").textContent(), /wasserstoff und sauerstoff/);
assert.equal(await page.locator(".antwort-karte").count(), 0, "ohne Frage keine Karte");

// Lehrerfrage → automatische Antwort mit Bild
await page.evaluate(() => window.unterricht.einspeisen("und wie sieht h2o aus wer kann mir das sagen"));
await page.locator(".antwort-karte .antwort").waitFor({ timeout: 10000 });
const antwort = await page.locator(".antwort-karte .antwort").first().textContent();
assert.match(antwort, /Sauerstoffatom/);
await page.locator(".antwort-karte img").first().waitFor();
assert.match(await page.locator(".antwort-karte .kurz").first().textContent(), /Kurz: Ein Sauerstoffatom/);
await page.getByText("Server verbunden.").or(page.locator(".live-band")).first().waitFor();
assert.match(await page.locator(".antwort-karte img").first().getAttribute("src"), /pubchem/);
await foto("2-live-antwort");
// linke Spalte zeigt die erkannte Frage
assert.match(await page.locator(".spalte-links").textContent(), /Wassermolekül/);

// Zwischenstand (rechte Spalte)
await page.evaluate(() => window.unterricht.zwischenstand());
await page.locator(".zwischenstand").getByText("Attrappen-Stunde", { exact: false }).or(page.locator(".zwischenstand").getByText("Beispielstunde")).first().waitFor({ timeout: 10000 });
assert.match(await page.locator(".spalte-links").textContent(), /Seite 42/);

// Eingetippte Frage
await page.getByPlaceholder(/Frage eintippen/).fill("Was ist ein Dipol?");
await page.getByRole("button", { name: "Fragen", exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll(".antwort-karte .antwort").length >= 2);
assert.match(await page.locator(".antwort-karte .frage").first().textContent(), /Was ist ein Dipol/);

// Beenden → Zusammenfassung
page.once("dialog", (d) => d.accept());
await page.getByRole("button", { name: "Beenden" }).click();
await page.waitForURL(/#stunde\//);
await page.getByText("Attrappen-Stunde").first().waitFor({ timeout: 10000 });
await page.getByText("Hausaufgaben und Termine").waitFor();
await foto("3-stunde");

// Archiv + Nachfrage
await page.goto(`${basis}/#archiv`);
await page.getByText("Attrappen-Stunde").first().waitFor();
await page.getByPlaceholder(/Worum ging es/).fill("Was war letzte Woche in Chemie?");
await page.getByRole("button", { name: "Fragen", exact: true }).click();
await page.getByText("Attrappen-Antwort zu deinen Stunden").waitFor({ timeout: 10000 });
await foto("4-archiv");

// Einstellungen: Verbindungsprüfung
await page.goto(`${basis}/#einstellungen`);
await page.getByText(/Server erreichbar/).waitFor({ timeout: 10000 });
await foto("5-einstellungen");

// Export-Text
const text = await page.evaluate(async () => {
  const r = indexedDB.open("unterricht", 1);
  const db = await new Promise((ok) => (r.onsuccess = () => ok(r.result)));
  const alle = await new Promise((ok) => { const q = db.transaction("stunden").objectStore("stunden").getAll(); q.onsuccess = () => ok(q.result); });
  return window.unterricht.exportText(alle[0]);
});
assert.match(text, /Mitschrift:/);
assert.match(text, /wie sieht h2o aus/);

// Frage-Vorfilter
const f = await page.evaluate(() => ["wie sieht h2o aus", "wer kann mir das sagen", "heute ist es kalt", "nennt mir drei beispiele", "das ergebnis ist vier"].map((t) => window.unterricht.istFrage(t)));
assert.deepEqual(f, [true, true, false, true, false]);

await browser.close();
console.log("e2e ok");
