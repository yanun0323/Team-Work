package repository

import (
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

// hangupGrace is how long a shell gets to end after a hangup before it is killed.
const hangupGrace = 2 * time.Second

// Terminals starts interactive zsh shells that load the user's own ~/.zshrc.
type Terminals struct{}

// Start runs a shell in dir, in a pseudo-terminal of the given size.
func (Terminals) Start(dir string, cols, rows uint16) (adapter.Terminal, error) {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, model.Errorf(model.CodeInvalid, "找不到資料夾 %s", dir)
	}
	path, err := exec.LookPath("zsh")
	if err != nil {
		return nil, model.Errorf(model.CodeUnavailable, "找不到 zsh")
	}
	cmd := exec.Command(path, "-il")
	cmd.Dir = dir
	cmd.Env = terminalEnv(os.Environ(), dir)
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, model.Errorf(model.CodeUnavailable, "無法啟動終端機")
	}
	t := &terminal{File: file, cmd: cmd, exited: make(chan struct{})}
	go func() { // ends with the shell, which Close guarantees
		_ = cmd.Wait()
		close(t.exited)
	}()
	return t, nil
}

// terminalEnv is the server's environment as a shell should see it. The server's own settings stay out, so
// that a `make dev` typed in the terminal starts as it would anywhere else, and so does what names the terminal
// the server was started from: macOS's zshrc would take this for Terminal.app and restore its session. An app
// opened from Finder has no locale, without which zsh garbles anything outside ASCII.
func terminalEnv(env []string, dir string) []string {
	out := make([]string, 0, len(env)+4)
	hasLocale := false
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		switch {
		case strings.HasPrefix(name, "TEAM_WORK_"), name == "PWD", name == "TERM", name == "COLORTERM",
			name == "TERM_PROGRAM", name == "TERM_PROGRAM_VERSION", name == "TERM_SESSION_ID":
			continue
		case name == "LANG", name == "LC_ALL", name == "LC_CTYPE":
			hasLocale = true
		}
		out = append(out, kv)
	}
	if !hasLocale {
		out = append(out, "LANG=en_US.UTF-8")
	}
	return append(out, "TERM=xterm-256color", "COLORTERM=truecolor", "PWD="+dir)
}

type terminal struct {
	*os.File
	cmd    *exec.Cmd
	exited chan struct{}
	once   sync.Once
}

func (t *terminal) Exited() <-chan struct{} { return t.exited }

func (t *terminal) Resize(cols, rows uint16) error {
	return pty.Setsize(t.File, &pty.Winsize{Cols: cols, Rows: rows})
}

// Close ends the shell and its jobs, as closing a terminal window does: the command in the foreground and the
// shell get a hangup, and the shell passes it on to its background jobs. What still runs in those two process
// groups after the grace period is killed. A job told to survive this, like one under nohup, does.
func (t *terminal) Close() error {
	t.once.Do(func() {
		groups := []int{t.cmd.Process.Pid}
		if fg, err := unix.IoctlGetInt(int(t.File.Fd()), unix.TIOCGPGRP); err == nil && fg > 0 && fg != groups[0] {
			groups = append(groups, fg)
		}
		signal := func(sig syscall.Signal) {
			for _, group := range groups {
				_ = syscall.Kill(-group, sig)
			}
		}
		signal(syscall.SIGHUP)
		t.waitExit()
		signal(syscall.SIGKILL)
		t.waitExit()
		_ = t.File.Close()
	})
	return nil
}

// waitExit gives the shell the grace period to end.
func (t *terminal) waitExit() {
	timer := time.NewTimer(hangupGrace)
	defer timer.Stop()
	select {
	case <-t.exited:
	case <-timer.C:
	}
}
