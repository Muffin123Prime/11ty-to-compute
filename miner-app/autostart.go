package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const (
	runKey      = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	runValue    = "KryptoMiner"
	macAgentID  = "local.kryptominer"
	desktopFile = "kryptominer.desktop"
)

func autostartFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "linux":
		return filepath.Join(home, ".config", "autostart", desktopFile), nil
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", macAgentID+".plist"), nil
	}
	return "", errors.New("Autostart wird auf diesem System nicht unterstützt")
}

func autostartEnabled() bool {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("reg", "query", runKey, "/v", runValue)
		hideWindow(cmd)
		return cmd.Run() == nil
	}
	p, err := autostartFile()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func setAutostart(on bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		var cmd *exec.Cmd
		if on {
			cmd = exec.Command("reg", "add", runKey, "/v", runValue, "/t", "REG_SZ",
				"/d", fmt.Sprintf(`"%s" --background`, exe), "/f")
		} else {
			if !autostartEnabled() {
				return nil
			}
			cmd = exec.Command("reg", "delete", runKey, "/v", runValue, "/f")
		}
		hideWindow(cmd)
		return cmd.Run()
	}
	p, err := autostartFile()
	if err != nil {
		return err
	}
	if !on {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	var content string
	if runtime.GOOS == "linux" {
		content = fmt.Sprintf("[Desktop Entry]\nType=Application\nName=KryptoMiner\nExec=\"%s\" --background\nX-GNOME-Autostart-enabled=true\n", exe)
	} else {
		content = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`, macAgentID, exe)
	}
	return os.WriteFile(p, []byte(content), 0o644)
}
