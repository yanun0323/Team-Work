package claude

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// InstallScript is Anthropic's documented way to install: https://code.claude.com/docs/en/install
	InstallScript  = "curl -fsSL https://claude.ai/install.sh | bash"
	installTimeout = 10 * time.Minute
	loginTimeout   = 15 * time.Minute
	versionTimeout = 10 * time.Second
	killGrace      = 2 * time.Second
)

var versionNumber = regexp.MustCompile(`\d+\.\d+\.\d+\S*`)

// executable finds Claude Code. The installer's folder is looked at too: a server started before the
// install, or outside a login shell, does not have it on its PATH.
func executable() (string, bool) {
	if path := os.Getenv("MHO_CLAUDE_EXECUTABLE"); path != "" {
		info, err := os.Stat(path)
		return path, err == nil && !info.IsDir()
	}
	if path, err := exec.LookPath("claude"); err == nil {
		return path, true
	}
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".local", "bin", "claude")
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, true
		}
	}
	return "claude", false
}

// Status is where Claude Code stands on this computer.
type Status struct {
	Installed bool     `json:"installed"`
	Version   string   `json:"version,omitempty"`
	SignedIn  bool     `json:"signedIn"`
	Models    []string `json:"models"`
}

// Setup installs Claude Code and signs it in, one at a time: both are long and change this computer.
type Setup struct {
	// Script is what installing runs; only tests change it.
	Script string
	busy   sync.Mutex
}

// NewSetup installs with Anthropic's own script.
func NewSetup() *Setup { return &Setup{Script: InstallScript} }

// Status checks Claude Code without changing anything.
func (s *Setup) Status(ctx context.Context) (Status, error) {
	status := Status{Models: []string{}}
	path, found := executable()
	if !found {
		return status, nil
	}
	status.Installed = true
	versionCtx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()
	out, err := exec.CommandContext(versionCtx, path, "--version").Output()
	if err != nil {
		if ctx.Err() != nil {
			return status, ctx.Err()
		}
		return status, unavailable("Claude Code 無法執行，可能需要重新安裝")
	}
	status.Version = versionNumber.FindString(string(out))
	ids, _, err := discover(ctx)
	if err != nil && err.Error() == errLoggedOut().Error() {
		return status, nil
	}
	if err != nil {
		return status, err
	}
	status.SignedIn, status.Models = true, ids
	return status, nil
}

// run runs a long command in its own process group, so stopping it stops everything it started.
func run(ctx context.Context, env []string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killGrace
	return cmd.Run()
}

// Install runs the installer. Its caller answers for the user having agreed to it.
func (s *Setup) Install(ctx context.Context) error {
	if !s.busy.TryLock() {
		return &Error{Code: model.CodeConflict, Message: i18n.T("正在安裝或登入 Claude Code")}
	}
	defer s.busy.Unlock()
	if _, found := executable(); found {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	if err := run(ctx, os.Environ(), "bash", "-c", s.Script); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return unavailable("安裝逾時，請確認網路後再試一次")
		case ctx.Err() != nil:
			return ctx.Err()
		}
		return unavailable(i18n.T("安裝失敗，請確認網路後再試一次，或到終端機執行：%s", InstallScript))
	}
	if _, found := executable(); !found {
		return unavailable("安裝程式跑完了，但找不到 Claude Code，請到終端機執行 claude --version 確認")
	}
	return nil
}

// Login runs Claude Code's own sign-in, which opens the browser and keeps the credentials itself.
func (s *Setup) Login(ctx context.Context) error {
	if !s.busy.TryLock() {
		return &Error{Code: model.CodeConflict, Message: i18n.T("正在安裝或登入 Claude Code")}
	}
	defer s.busy.Unlock()
	path, found := executable()
	if !found {
		return &Error{Code: model.CodeConflict, Message: i18n.T("還沒安裝 Claude Code")}
	}
	// the same check every call makes, so a key in the environment cannot take over the sign-in
	env, err := childEnvironment()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	if err := run(ctx, env, path, "auth", "login", "--claudeai"); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return unavailable("登入逾時，請再試一次")
		case ctx.Err() != nil:
			return ctx.Err()
		}
		return rejected("登入沒有完成。可以到終端機執行 claude auth login，再回來重試")
	}
	return nil
}
