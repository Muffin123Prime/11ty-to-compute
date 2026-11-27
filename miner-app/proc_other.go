//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
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
