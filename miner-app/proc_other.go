//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

func hideWindow(cmd *exec.Cmd) {}

func stopProcess(p *os.Process) {
	_ = p.Signal(os.Interrupt)
	go func() {
		time.Sleep(5 * time.Second)
		_ = p.Kill()
	}()
}

func isAdmin() bool { return os.Geteuid() == 0 }

func relaunchElevated(mine bool) error {
	return errors.New("Starte die App auf diesem System selbst mit Administratorrechten (sudo).")
}

var (
	awakeMu  sync.Mutex
	awakeCmd *exec.Cmd
)

// setKeepAwake verhindert über ein Hilfsprogramm des Systems den Standby.
func setKeepAwake(on bool) {
	awakeMu.Lock()
	defer awakeMu.Unlock()
	if awakeCmd != nil {
		_ = awakeCmd.Process.Kill()
		_ = awakeCmd.Wait()
		awakeCmd = nil
	}
	if !on {
		return
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("caffeinate", "-i")
	} else {
		cmd = exec.Command("systemd-inhibit", "--what=sleep:idle", "--who=KryptoMiner",
			"--why=Mining läuft", "sleep", "infinity")
	}
	if cmd.Start() == nil {
		awakeCmd = cmd
	}
}
