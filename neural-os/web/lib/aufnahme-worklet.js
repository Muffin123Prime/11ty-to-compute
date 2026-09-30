/**
 * lib/aufnahme-worklet.js -- nimmt im Audio-Faden die Samples des Mikrofons
 * ab und schickt sie in Happen an die Seite (lib/sprechen.js baut daraus
 * WAV). Laeuft als AudioWorklet: eigene Datei aus derselben Quelle, weil
 * die Sicherheitsregel der App (script-src 'self') nichts anderes laedt.
 */

const HAPPEN = 4096;

class NosAufnahme extends AudioWorkletProcessor {
  constructor() {
    super();
    this.puffer = new Float32Array(HAPPEN);
    this.fuellung = 0;
    // Beim Anhalten: den angefangenen Happen auch noch schicken.
    this.port.onmessage = (e) => {
      if (e.data !== 'leeren' || !this.fuellung) return;
      this.port.postMessage(this.puffer.slice(0, this.fuellung));
      this.fuellung = 0;
    };
  }

  process(eingaenge) {
    const spur = eingaenge[0] && eingaenge[0][0];
    if (spur) {
      let i = 0;
      while (i < spur.length) {
        const n = Math.min(spur.length - i, HAPPEN - this.fuellung);
        this.puffer.set(spur.subarray(i, i + n), this.fuellung);
        this.fuellung += n;
        i += n;
        if (this.fuellung === HAPPEN) {
          this.port.postMessage(this.puffer);
          this.puffer = new Float32Array(HAPPEN);
          this.fuellung = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('nos-aufnahme', NosAufnahme);
