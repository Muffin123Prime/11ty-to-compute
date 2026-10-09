export type CacheDauer = 'auto' | '5m' | '1h'

export type CacheStand = {
  /** Start der letzten Anfrage im Hauptchat, ms seit Epoch. Ab da laeuft die Cache-Uhr. */
  letzteAnfrage: number | null
  /** Modell der letzten Anfrage, fuer den Preis beim Neu-Einlesen. */
  modell: string | null
  /** Laeuft gerade ein Zug im Hauptchat. */
  arbeitet: boolean
  /** Fuer diesen Cache-Zyklus schon gewarnt. */
  gewarnt: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-anzeige': { stand: CacheStand }
  }
}
