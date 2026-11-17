// Misch-Modus (Whisper) mit Chromiums Attrappen-Mikrofon gegen den Attrappen-Server:
//   node server.mjs --mock &   dann   node test/e2e-whisper.mjs
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
import assert from "node:assert/strict";
const basis = process.env.BASIS || "http://localhost:8787";
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ ...devices["iPad Pro 11 landscape"], permissions: ["microphone"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => { console.error("Seitenfehler:", e.message); process.exitCode = 1; });
await page.goto(`${basis}/#start`);
const v = page.getByRole("button", { name: "Verstanden" }); if (await v.count()) await v.click();
await page.getByRole("button", { name: "Englisch", exact: true }).first().click();
await page.getByText(/Lehrkraft wechselt zwischen Deutsch und Englisch/).click();
await page.getByRole("button", { name: "Zuhören starten" }).click();
await page.waitForURL(/#live/);
assert.match(await page.locator(".live-meta").textContent(), /Whisper/);
// nach ~6 s kommt das erste Stück beim Attrappen-Server an
await page.locator(".live-text .marke-de").first().waitFor({ timeout: 20000 });
await page.locator(".live-text .original").getByText("who can tell me why water is a dipole").waitFor({ timeout: 20000 });
await page.locator(".live-text .uebersetzung").getByText("[DE] who can tell me").waitFor({ timeout: 20000 });
console.log("Band:", (await page.locator(".live-text").textContent()).trim().slice(0, 200));
// Pause stoppt die Aufnahme
await page.locator(".punkt-klein").click();
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => window.unterricht.zustand().pausiert), true);
await browser.close();
console.log("e2e-whisper ok");
