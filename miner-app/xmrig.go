package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Die Adressen lassen sich für Tests per Umgebungsvariable überschreiben.
var (
	releaseURL = envOr("KRYPTOMINER_RELEASE_URL", "https://api.github.com/repos/xmrig/xmrig/releases/latest")
	httpClient = &http.Client{Timeout: 0}
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type Miner struct {
	mu        sync.Mutex
	dir       string // Datenordner der App
	phase     string // stopped | installing | running | error
	progress  int    // Download-Fortschritt in Prozent
	errMsg    string
	cmd       *exec.Cmd
	stopping  bool
	startedAt time.Time
	apiPort   int
	apiToken  string
	logs      []string
	version   string
	msr       string // "" | ok | failed
}

func (m *Miner) binPath() string {
	if p := os.Getenv("KRYPTOMINER_XMRIG"); p != "" {
		return p
	}
	name := "xmrig"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(m.dir, "xmrig", name)
}

func (m *Miner) logf(format string, a ...any) {
	line := time.Now().Format("15:04:05") + "  " + fmt.Sprintf(format, a...)
	m.mu.Lock()
	m.appendLog(line)
	m.mu.Unlock()
}

// appendLog erwartet, dass m.mu gehalten wird.
func (m *Miner) appendLog(line string) {
	m.logs = append(m.logs, line)
	if len(m.logs) > 300 {
		m.logs = m.logs[len(m.logs)-300:]
	}
}

func (m *Miner) fail(err error) {
	m.mu.Lock()
	m.phase = "error"
	m.errMsg = err.Error()
	m.appendLog(time.Now().Format("15:04:05") + "  FEHLER: " + err.Error())
	m.mu.Unlock()
}

// Start lädt den Miner bei Bedarf herunter und startet ihn.
func (m *Miner) Start(cfg Config) error {
	m.mu.Lock()
	if m.phase == "installing" || m.phase == "running" {
		m.mu.Unlock()
		return nil
	}
	m.phase = "installing"
	m.progress = 0
	m.errMsg = ""
	m.stopping = false
	m.mu.Unlock()

	go func() {
		if _, err := os.Stat(m.binPath()); err != nil {
			m.logf("Miner-Programm (XMRig) wird heruntergeladen …")
			if err := m.install(); err != nil {
				m.fail(fmt.Errorf("Download fehlgeschlagen: %w", err))
				return
			}
			m.logf("Download abgeschlossen und geprüft.")
		}
		if _, err := os.Stat(m.binPath()); err != nil {
			m.fail(errors.New("Das Miner-Programm fehlt nach dem Download. Vermutlich hat dein Virenschutz es gelöscht – siehe Hinweis unten."))
			return
		}
		if err := m.run(cfg); err != nil {
			m.fail(err)
		}
	}()
	return nil
}

func (m *Miner) run(cfg Config) error {
	port, err := freePort()
	if err != nil {
		return err
	}
	tok := make([]byte, 16)
	if _, err := rand.Read(tok); err != nil {
		return err
	}
	token := hex.EncodeToString(tok)

	args := []string{
		"-o", cfg.Pool,
		"-u", cfg.Wallet,
		"-p", cfg.Worker,
		"--rig-id", cfg.Worker,
		"--donate-level", "1",
		"--no-color",
		"--http-host", "127.0.0.1",
		"--http-port", fmt.Sprint(port),
		"--http-access-token", token,
	}
	switch cfg.Mode {
	case "quiet":
		args = append(args, "--cpu-max-threads-hint", "50", "--cpu-priority", "1")
	case "balanced":
		args = append(args, "--cpu-max-threads-hint", "75")
	default: // max: alle sinnvollen Threads, Vorrang vor anderen Programmen
		args = append(args, "--cpu-max-threads-hint", "100", "--cpu-priority", "3")
		if runtime.GOOS == "linux" {
			args = append(args, "--randomx-1gb-pages")
		}
	}
	if cfg.TLS {
		args = append(args, "--tls")
	}
	if cfg.PauseOnActive {
		args = append(args, "--pause-on-active=60")
	}
	if cfg.PauseOnBattery {
		args = append(args, "--pause-on-battery")
	}

	cmd := exec.Command(m.binPath(), args...)
	cmd.Dir = filepath.Dir(m.binPath())
	hideWindow(cmd)
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		pw.Close()
		return fmt.Errorf("Miner konnte nicht gestartet werden (%v). Häufigste Ursache: der Virenschutz blockiert XMRig – siehe Hinweis unten.", err)
	}

	m.mu.Lock()
	m.cmd = cmd
	m.phase = "running"
	m.startedAt = time.Now()
	m.apiPort = port
	m.apiToken = token
	m.msr = ""
	stopNow := m.stopping
	m.mu.Unlock()
	if stopNow {
		stopProcess(cmd.Process)
	}

	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r ")
			if line == "" {
				continue
			}
			low := strings.ToLower(line)
			m.mu.Lock()
			if strings.Contains(low, "msr") {
				if strings.Contains(low, "failed") {
					m.msr = "failed"
				} else if strings.Contains(low, "success") {
					m.msr = "ok"
				}
			}
			m.appendLog(line)
			m.mu.Unlock()
		}
	}()

	go func() {
		err := cmd.Wait()
		pw.Close()
		m.mu.Lock()
		defer m.mu.Unlock()
		ranFor := time.Since(m.startedAt)
		m.cmd = nil
		if m.stopping {
			m.phase = "stopped"
			m.appendLog(time.Now().Format("15:04:05") + "  Mining gestoppt.")
			return
		}
		m.phase = "error"
		m.errMsg = "Der Miner hat sich unerwartet beendet."
		if err != nil {
			m.errMsg += " (" + err.Error() + ")"
		}
		if ranFor < 15*time.Second {
			m.errMsg += " Prüfe Wallet-Adresse und Pool, und ob dein Virenschutz XMRig blockiert."
		}
		m.appendLog(time.Now().Format("15:04:05") + "  FEHLER: " + m.errMsg)
	}()
	return nil
}

func (m *Miner) Stop() {
	m.mu.Lock()
	m.stopping = true
	cmd := m.cmd
	if m.phase == "error" {
		m.phase = "stopped"
		m.errMsg = ""
	}
	m.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		stopProcess(cmd.Process)
	}
}

// StopAndWait beendet den Miner und wartet kurz, bis er wirklich weg ist.
func (m *Miner) StopAndWait() {
	m.Stop()
	for i := 0; i < 70; i++ {
		m.mu.Lock()
		done := m.cmd == nil
		m.mu.Unlock()
		if done {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

type MinerStats struct {
	Hashrate   [3]*float64 `json:"hashrate"` // 10 s, 60 s, 15 min
	Highest    *float64    `json:"highest"`
	SharesGood int64       `json:"sharesGood"`
	SharesAll  int64       `json:"sharesAll"`
	Pool       string      `json:"pool"`
	Connected  bool        `json:"connected"`
	Paused     bool        `json:"paused"`
	CPU        string      `json:"cpu"`
	Threads    int         `json:"threads"`
	Version    string      `json:"version"`
	Algo       string      `json:"algo"`
	HugePages  *int        `json:"hugePages"` // Anteil in Prozent, falls bekannt
}

// Stats fragt die lokale Schnittstelle des laufenden Miners ab.
func (m *Miner) Stats() *MinerStats {
	m.mu.Lock()
	port, token, phase := m.apiPort, m.apiToken, m.phase
	m.mu.Unlock()
	if phase != "running" {
		return nil
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/2/summary", port), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	var raw struct {
		Version   string          `json:"version"`
		Paused    bool            `json:"paused"`
		Algo      string          `json:"algo"`
		HugePages json.RawMessage `json:"hugepages"`
		Hashrate  struct {
			Total   []*float64 `json:"total"`
			Highest *float64   `json:"highest"`
		} `json:"hashrate"`
		Results struct {
			Good  int64 `json:"shares_good"`
			Total int64 `json:"shares_total"`
		} `json:"results"`
		Connection struct {
			Pool   string `json:"pool"`
			Uptime int64  `json:"uptime"`
		} `json:"connection"`
		CPU struct {
			Brand   string `json:"brand"`
			Threads int    `json:"threads"`
		} `json:"cpu"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw); err != nil {
		return nil
	}
	s := &MinerStats{
		Highest:    raw.Hashrate.Highest,
		SharesGood: raw.Results.Good,
		SharesAll:  raw.Results.Total,
		Pool:       raw.Connection.Pool,
		Connected:  raw.Connection.Uptime > 0,
		Paused:     raw.Paused,
		CPU:        strings.TrimSpace(raw.CPU.Brand),
		Threads:    raw.CPU.Threads,
		Version:    raw.Version,
		Algo:       raw.Algo,
	}
	var hp []int
	if json.Unmarshal(raw.HugePages, &hp) == nil && len(hp) == 2 && hp[1] > 0 {
		pct := hp[0] * 100 / hp[1]
		s.HugePages = &pct
	}
	for i := 0; i < 3 && i < len(raw.Hashrate.Total); i++ {
		s.Hashrate[i] = raw.Hashrate.Total[i]
	}
	return s
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// ---------- Download & Installation ----------

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

// assetSuffixes listet passende Dateiendungen in der bevorzugten Reihenfolge.
func assetSuffixes() []string {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return []string{"-windows-x64.zip", "-msvc-win64.zip", "-gcc-win64.zip"}
	case "windows/arm64":
		return []string{"-windows-arm64.zip"}
	case "linux/amd64":
		return []string{"-linux-static-x64.tar.gz"}
	case "darwin/amd64":
		return []string{"-macos-x64.tar.gz"}
	case "darwin/arm64":
		return []string{"-macos-arm64.tar.gz"}
	}
	return nil
}

func pickAsset(assets []releaseAsset, suffixes []string) *releaseAsset {
	for _, suf := range suffixes {
		for i := range assets {
			if strings.HasSuffix(assets[i].Name, suf) {
				return &assets[i]
			}
		}
	}
	return nil
}

func httpGet(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "kryptominer-launcher")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("Server antwortete mit %s", resp.Status)
	}
	return resp, nil
}

func (m *Miner) install() error {
	suffixes := assetSuffixes()
	if suffixes == nil {
		return fmt.Errorf("für %s/%s gibt es keinen fertigen Miner", runtime.GOOS, runtime.GOARCH)
	}
	resp, err := httpGet(releaseURL)
	if err != nil {
		return err
	}
	var rel struct {
		Tag    string         `json:"tag_name"`
		Assets []releaseAsset `json:"assets"`
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel)
	resp.Body.Close()
	if err != nil {
		return err
	}
	asset := pickAsset(rel.Assets, suffixes)
	sums := pickAsset(rel.Assets, []string{"SHA256SUMS"})
	if asset == nil || sums == nil || sums.Name != "SHA256SUMS" {
		return errors.New("in der aktuellen XMRig-Version wurde keine passende Datei gefunden")
	}

	// Prüfsumme holen
	resp, err = httpGet(sums.URL)
	if err != nil {
		return err
	}
	sumData, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if err != nil {
		return err
	}
	want := ""
	for _, line := range strings.Split(string(sumData), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset.Name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return errors.New("keine Prüfsumme für " + asset.Name + " gefunden")
	}

	// Archiv laden
	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(m.dir, "download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	resp, err = httpGet(asset.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	h := sha256.New()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 128*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := tmp.Write(buf[:n]); err != nil {
				return err
			}
			h.Write(buf[:n])
			done += int64(n)
			if total > 0 {
				m.mu.Lock()
				m.progress = int(done * 100 / total)
				m.mu.Unlock()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return errors.New("Prüfsumme stimmt nicht – Download wird verworfen")
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	dest := filepath.Join(m.dir, "xmrig")
	_ = os.RemoveAll(dest)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	if strings.HasSuffix(asset.Name, ".zip") {
		err = unzip(tmp.Name(), dest)
	} else {
		err = untar(tmp.Name(), dest)
	}
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.version = strings.TrimPrefix(rel.Tag, "v")
	m.mu.Unlock()
	return nil
}

// flatName entfernt den obersten Ordner des Archivs und verhindert Ausbrüche
// aus dem Zielordner.
func flatName(name string) string {
	name = path.Clean("/" + strings.ReplaceAll(name, `\`, "/"))
	parts := strings.Split(strings.TrimPrefix(name, "/"), "/")
	if len(parts) < 2 {
		return ""
	}
	return filepath.Join(parts[1:]...)
}

func writeFile(dest, rel string, r io.Reader, mode os.FileMode) error {
	target := filepath.Join(dest, rel)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode|0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(r, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func unzip(src, dest string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		rel := flatName(f.Name)
		if rel == "" || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = writeFile(dest, rel, rc, 0o755)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func untar(src, dest string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		rel := flatName(hdr.Name)
		if rel == "" {
			continue
		}
		if err := writeFile(dest, rel, tr, os.FileMode(hdr.Mode)&0o777); err != nil {
			return err
		}
	}
}
