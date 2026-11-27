//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
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

var awakeCh = make(chan bool, 4)

func init() {
	// Windows merkt sich die Einstellung pro Thread. Deshalb läuft sie auf
	// einem eigenen, fest gebundenen Thread, der bis zum Ende der App lebt.
	go func() {
		runtime.LockOSThread()
		proc := syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")
		const esContinuous, esSystemRequired = 0x80000000, 0x00000001
		for on := range awakeCh {
			flags := uintptr(esContinuous)
			if on {
				flags |= esSystemRequired
			}
			_, _, _ = proc.Call(flags)
		}
	}()
}

// setKeepAwake verhindert, dass Windows von selbst in den Standby geht.
func setKeepAwake(on bool) { awakeCh <- on }
