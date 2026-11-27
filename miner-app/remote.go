package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// relayURL ist die Adresse der Handy-Seite. Sie wird beim Bauen gesetzt
// (-ldflags "-X main.relayURL=https://…") und lässt sich für Tests überschreiben.
var relayURL = ""

var priceURL = envOr("KRYPTOMINER_PRICE_URL", "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=eur")

func relayBase() string {
	return strings.TrimRight(envOr("KRYPTOMINER_RELAY", relayURL), "/")
}

func newRelayKey() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// relayID ist die öffentliche Kennung in der Handy-Adresse. Aus ihr lässt sich
// der geheime Schlüssel, mit dem die App Daten schreibt, nicht zurückrechnen.
func relayID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:32]
}

func remoteLink(cfg Config) string {
	if relayBase() == "" || cfg.RelayKey == "" {
		return ""
	}
	return relayBase() + "/#" + relayID(cfg.RelayKey)
}

// Tracker führt Buch über Gesamtlaufzeit und Verlauf und meldet den Stand
// an die Handy-Seite.
type Tracker struct {
	mu           sync.Mutex
	path         string
	TotalSeconds int64        `json:"totalSeconds"`
	History      [][2]float64 `json:"history"` // [Unix-Zeit, Hashrate]
	lastSample   time.Time
	eur          float64
	eurFetched   time.Time
	lastPushOK   time.Time
	lastPushErr  string
}

func loadTracker(dir string) *Tracker {
	t := &Tracker{path: filepath.Join(dir, "stats.json")}
	if data, err := os.ReadFile(t.path); err == nil {
		_ = json.Unmarshal(data, t)
	}
	return t
}

func (t *Tracker) save() {
	data, _ := json.Marshal(t)
	_ = os.WriteFile(t.path, data, 0o600)
}

func (t *Tracker) snapshot() (total int64, hist [][2]float64, eur float64, pushOK time.Time, pushErr string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.TotalSeconds, append([][2]float64(nil), t.History...), t.eur, t.lastPushOK, t.lastPushErr
}

func (t *Tracker) refreshPrice() {
	t.mu.Lock()
	due := time.Since(t.eurFetched) > 15*time.Minute
	if due {
		t.eurFetched = time.Now()
	}
	t.mu.Unlock()
	if !due {
		return
	}
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get(priceURL)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var raw struct {
		Monero struct {
			EUR float64 `json:"eur"`
		} `json:"monero"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&raw) != nil || raw.Monero.EUR <= 0 {
		return
	}
	t.mu.Lock()
	t.eur = raw.Monero.EUR
	t.mu.Unlock()
}

const tick = 10 * time.Second

// loop läuft, solange die App läuft.
func (t *Tracker) loop(a *App) {
	n := 0
	lastKey := ""
	for {
		time.Sleep(tick)
		n++
		st := a.miner.Stats()
		working := st != nil && st.Connected && !st.Paused
		t.mu.Lock()
		if working {
			t.TotalSeconds += int64(tick / time.Second)
		}
		if time.Since(t.lastSample) >= 5*time.Minute {
			t.lastSample = time.Now()
			rate := 0.0
			if working {
				for _, h := range []*float64{st.Hashrate[1], st.Hashrate[0]} {
					if h != nil {
						rate = *h
						break
					}
				}
			}
			t.History = append(t.History, [2]float64{float64(time.Now().Unix()), rate})
			if len(t.History) > 288 {
				t.History = t.History[len(t.History)-288:]
			}
		}
		if n%6 == 0 {
			t.save()
		}
		t.mu.Unlock()

		go t.refreshPrice()
		a.miner.mu.Lock()
		phase := a.miner.phase
		a.miner.mu.Unlock()
		key := fmt.Sprint(phase, working)
		if n%3 == 0 || key != lastKey {
			lastKey = key
			t.push(a, false)
		}
	}
}

// push sendet den aktuellen Stand an die Handy-Seite.
func (t *Tracker) push(a *App, offline bool) {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	base := relayBase()
	if base == "" || !cfg.Remote || cfg.RelayKey == "" {
		return
	}
	m := a.miner
	m.mu.Lock()
	phase := m.phase
	started := m.startedAt
	m.mu.Unlock()
	if offline {
		phase = "offline"
	}
	total, hist, eur, _, _ := t.snapshot()
	state := map[string]any{
		"phase":        phase,
		"worker":       cfg.Worker,
		"mode":         cfg.Mode,
		"totalSeconds": total,
		"history":      hist,
	}
	if eur > 0 {
		state["eur"] = eur
	}
	if phase == "running" {
		state["startedAt"] = started.Unix()
		if st := m.Stats(); st != nil {
			state["stats"] = st
		}
	}
	if b := a.balance.get(cfg); b != nil {
		state["balance"] = b
	}
	body, _ := json.Marshal(map[string]any{"key": cfg.RelayKey, "state": state})
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Post(base+"/api/push", "application/json", bytes.NewReader(body))
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		t.lastPushErr = "Keine Verbindung zur Handy-Seite"
		return
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.lastPushErr = fmt.Sprintf("Handy-Seite antwortet mit Fehler %d", resp.StatusCode)
		return
	}
	t.lastPushOK, t.lastPushErr = time.Now(), ""
}
