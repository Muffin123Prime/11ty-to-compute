// KryptoMiner – eine kleine Start-App für Monero-Mining auf dem eigenen PC.
// Sie lädt den Open-Source-Miner XMRig, startet ihn im Hintergrund und zeigt
// den Status in einer lokalen Oberfläche im Browser an.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed ui/index.html
var indexHTML []byte

const listenAddr = "127.0.0.1:47821"

type Config struct {
	Wallet         string `json:"wallet"`
	Pool           string `json:"pool"`
	TLS            bool   `json:"tls"`
	Worker         string `json:"worker"`
	Threads        int    `json:"threads"` // CPU-Auslastung in Prozent
	PauseOnActive  bool   `json:"pauseOnActive"`
	PauseOnBattery bool   `json:"pauseOnBattery"`
	AutoMine       bool   `json:"autoMine"` // beim App-Start sofort minen
}

func defaultConfig() Config {
	return Config{
		Pool:           "pool.supportxmr.com:443",
		TLS:            true,
		Worker:         "mein-pc",
		Threads:        75,
		PauseOnBattery: true,
	}
}

var (
	reWallet = regexp.MustCompile(`^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$`)
	rePool   = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$`)
	reWorker = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

func (c *Config) validate() error {
	c.Wallet = strings.TrimSpace(c.Wallet)
	c.Pool = strings.TrimSpace(c.Pool)
	c.Worker = strings.TrimSpace(c.Worker)
	if !reWallet.MatchString(c.Wallet) {
		return errors.New("Das ist keine gültige Monero-Adresse. Sie beginnt mit 4 oder 8 und hat 95 Zeichen.")
	}
	if !rePool.MatchString(c.Pool) {
		return errors.New("Der Pool muss die Form adresse:port haben, z. B. pool.supportxmr.com:443.")
	}
	if !reWorker.MatchString(c.Worker) {
		return errors.New("Der Gerätename darf nur Buchstaben, Ziffern, - und _ enthalten (max. 32 Zeichen).")
	}
	if c.Threads < 10 {
		c.Threads = 10
	}
	if c.Threads > 100 {
		c.Threads = 100
	}
	return nil
}

type App struct {
	mu      sync.Mutex
	cfg     Config
	cfgPath string
	miner   *Miner
	balance *Balance
	quit    chan struct{}
}

func (a *App) loadConfig() {
	a.cfg = defaultConfig()
	data, err := os.ReadFile(a.cfgPath)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &a.cfg)
}

func (a *App) saveConfig() error {
	data, _ := json.MarshalIndent(a.cfg, "", "  ")
	return os.WriteFile(a.cfgPath, data, 0o600)
}

// ---------- Pool-Guthaben (nur SupportXMR) ----------

type Balance struct {
	mu      sync.Mutex
	wallet  string
	fetched time.Time
	Due     float64 `json:"due"`
	Paid    float64 `json:"paid"`
	ok      bool
}

var balanceURL = envOr("KRYPTOMINER_BALANCE_URL", "https://supportxmr.com/api/miner/%s/stats")

func (b *Balance) get(cfg Config) *Balance {
	if !strings.Contains(cfg.Pool, "supportxmr.com") || !reWallet.MatchString(cfg.Wallet) {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.wallet != cfg.Wallet {
		b.wallet, b.ok, b.fetched = cfg.Wallet, false, time.Time{}
	}
	if time.Since(b.fetched) > 5*time.Minute {
		b.fetched = time.Now()
		wallet := cfg.Wallet
		go func() {
			c := &http.Client{Timeout: 10 * time.Second}
			resp, err := c.Get(fmt.Sprintf(balanceURL, wallet))
			if err != nil {
				return
			}
			defer resp.Body.Close()
			var raw struct {
				Due  float64 `json:"amtDue"`
				Paid float64 `json:"amtPaid"`
			}
			if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw) != nil {
				return
			}
			b.mu.Lock()
			if b.wallet == wallet {
				b.Due, b.Paid, b.ok = raw.Due/1e12, raw.Paid/1e12, true
			}
			b.mu.Unlock()
		}()
	}
	if !b.ok {
		return nil
	}
	return &Balance{Due: b.Due, Paid: b.Paid}
}

// ---------- HTTP ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

// guard lässt nur Anfragen zu, die wirklich von der lokalen Oberfläche kommen.
func guard(next http.Handler) http.Handler {
	_, port, _ := net.SplitHostPort(listenAddr)
	hosts := map[string]bool{"127.0.0.1:" + port: true, "localhost:" + port: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hosts[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet {
			origin := r.Header.Get("Origin")
			if origin != "" && !hosts[strings.TrimPrefix(origin, "http://")] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleState(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()

	m := a.miner
	m.mu.Lock()
	state := map[string]any{
		"phase":     m.phase,
		"progress":  m.progress,
		"error":     m.errMsg,
		"logs":      append([]string(nil), m.logs...),
		"config":    cfg,
		"autostart": autostartEnabled(),
		"dataDir":   m.dir,
		"os":        runtime.GOOS,
	}
	if m.phase == "running" {
		state["uptime"] = int(time.Since(m.startedAt).Seconds())
	}
	m.mu.Unlock()

	if s := m.Stats(); s != nil {
		state["stats"] = s
	}
	if b := a.balance.get(cfg); b != nil {
		state["balance"] = b
	}
	writeJSON(w, 200, state)
}

func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Config
		Autostart *bool `json:"autostart"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil {
		writeErr(w, 400, errors.New("Ungültige Eingabe"))
		return
	}
	if err := in.Config.validate(); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.mu.Lock()
	a.cfg = in.Config
	err := a.saveConfig()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, fmt.Errorf("Einstellungen konnten nicht gespeichert werden: %v", err))
		return
	}
	if in.Autostart != nil {
		if err := setAutostart(*in.Autostart); err != nil {
			writeErr(w, 500, fmt.Errorf("Autostart konnte nicht geändert werden: %v", err))
			return
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) handleStart(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	if err := cfg.validate(); err != nil {
		writeErr(w, 400, err)
		return
	}
	_ = a.miner.Start(cfg)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) handleStop(w http.ResponseWriter, r *http.Request) {
	a.miner.Stop()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) handleQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]bool{"ok": true})
	select {
	case <-a.quit:
	default:
		close(a.quit)
	}
}

func post(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h(w, r)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hideWindow(cmd)
	_ = cmd.Start()
}

func main() {
	background := flag.Bool("background", false, "ohne Browserfenster starten (für den Autostart)")
	flag.Parse()
	url := "http://" + listenAddr + "/"

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		// Die App läuft schon – nur die Oberfläche öffnen.
		if !*background {
			openBrowser(url)
		}
		return
	}

	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	dir := envOr("KRYPTOMINER_DIR", filepath.Join(base, "KryptoMiner"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "Datenordner kann nicht angelegt werden:", err)
		os.Exit(1)
	}

	app := &App{
		cfgPath: filepath.Join(dir, "config.json"),
		miner:   &Miner{dir: dir, phase: "stopped"},
		balance: &Balance{},
		quit:    make(chan struct{}),
	}
	app.loadConfig()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(indexHTML)
	})
	mux.HandleFunc("/api/state", app.handleState)
	mux.HandleFunc("/api/config", post(app.handleConfig))
	mux.HandleFunc("/api/start", post(app.handleStart))
	mux.HandleFunc("/api/stop", post(app.handleStop))
	mux.HandleFunc("/api/quit", post(app.handleQuit))

	go func() { _ = http.Serve(ln, guard(mux)) }()

	cfg := app.cfg
	if cfg.AutoMine && cfg.validate() == nil {
		_ = app.miner.Start(cfg)
	}
	if !*background {
		openBrowser(url)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	select {
	case <-app.quit:
	case <-sig:
	}
	app.miner.StopAndWait()
}
