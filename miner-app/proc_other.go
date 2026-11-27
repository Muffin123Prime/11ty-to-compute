//go:build !windows

package main

import (
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
