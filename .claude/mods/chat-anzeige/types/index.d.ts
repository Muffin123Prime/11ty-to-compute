export type ChatStatus = 'arbeitet' | 'wartet' | 'fertig' | 'beendet'

export type ChatEintrag = {
  /** Sitzungs-ID, zugleich der Dateiname. */
  id: string
  /** Erste Nachricht, gekuerzt. Leer bis zur ersten Nachricht. */
  name: string
  /** Letzter Teil des Arbeitsordners. */
  ordner: string
  /** Gesetztes Ziel (/goal oder vorgeschlagen und angenommen). */
  ziel: string | null
  status: ChatStatus
  /** Seit wann der Status gilt, ms seit Epoch. */
  seit: number
  /** Stand der Aufgabenliste (TodoWrite). */
  aufgaben: { gesamt: number; fertig: number; aktuell: string | null }
  /** Wann die aktuelle Aufgabenliste angelegt wurde, fuer die Restzeit. */
  aufgabenStart: number | null
  /** Letztes Lebenszeichen, ms seit Epoch. */
  aktualisiert: number
}

declare module 'claude-code' {
  interface PluginState {
    'chat-anzeige': { eigen: ChatEintrag | null; chats: ChatEintrag[]; ordnerPfad: string | null }
  }
}
