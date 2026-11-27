//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// hideWindow verhindert, dass für Hilfsprozesse ein Konsolenfenster aufblitzt.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func stopProcess(p *os.Process) {
	_ = p.Kill()
}
