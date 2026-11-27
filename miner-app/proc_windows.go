//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
)

var (
	adminOnce sync.Once
	adminYes  bool
)

// isAdmin meldet, ob die App mit Administratorrechten läuft.
func isAdmin() bool {
	adminOnce.Do(func() {
		cmd := exec.Command("net", "session")
		hideWindow(cmd)
		adminYes = cmd.Run() == nil
	})
	return adminYes
}

// relaunchElevated startet die App über die Windows-Sicherheitsabfrage neu.
func relaunchElevated(mine bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := "'--takeover'"
	if mine {
		args += ",'--mine'"
	}
	ps := "Start-Process -FilePath '" + strings.ReplaceAll(exe, "'", "''") + "' -ArgumentList " + args + " -Verb RunAs"
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	hideWindow(cmd)
	if err := cmd.Run(); err != nil {
		return errors.New("Die Administratorrechte wurden nicht erteilt. Bestätige die Windows-Abfrage mit „Ja“.")
	}
	return nil
}

// hideWindow verhindert, dass für Hilfsprozesse ein Konsolenfenster aufblitzt.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func stopProcess(p *os.Process) {
	_ = p.Kill()
}
