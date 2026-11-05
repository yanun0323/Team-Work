package repository

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// stubGit is where macOS keeps a stand-in for git. Without Apple's Command Line Tools behind it, each run of it
	// fails and asks the user to install them, so it is never run until they are there.
	stubGit        = "/usr/bin/git"
	gitTimeout     = 10 * time.Second
	installCommand = "xcode-select --install"
)

var gitVersion = regexp.MustCompile(`\d+\.\d+(\.\d+)?`)

// gitTool finds the git program. Once git has run it stays found; until then each use looks again, so installing it
// while the app runs is enough.
type gitTool struct {
	goos     string
	lookPath func(string) (string, error)
	// developerDir is where Apple's developer tools are, as `xcode-select -p` says.
	developerDir func(ctx context.Context) (string, error)
	isFile       func(path string) bool
	version      func(ctx context.Context, path string) (string, error)
	install      func(ctx context.Context) error

	mu       sync.Mutex
	found    string
	ver      string
	installs sync.Mutex
}

func newGitTool() *gitTool {
	return &gitTool{
		goos:     runtime.GOOS,
		lookPath: exec.LookPath,
		developerDir: func(ctx context.Context) (string, error) {
			out, err := exec.CommandContext(ctx, "xcode-select", "-p").Output()
			return strings.TrimSpace(string(out)), err
		},
		isFile: func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && !info.IsDir()
		},
		version: func(ctx context.Context, path string) (string, error) {
			out, err := exec.CommandContext(ctx, path, "--version").Output()
			return string(out), err
		},
		install: func(ctx context.Context) error {
			return exec.CommandContext(ctx, "xcode-select", "--install").Run()
		},
	}
}

// tool is the one git every repo command runs.
var tool = newGitTool()

// stubReady says whether macOS's stand-in for git has Apple's tools behind it, without running it.
func (t *gitTool) stubReady(ctx context.Context) bool {
	dir, err := t.developerDir(ctx)
	return err == nil && dir != "" && t.isFile(filepath.Join(dir, "usr", "bin", "git"))
}

// find gives the path of a git that runs, and its version.
func (t *gitTool) find(ctx context.Context) (string, string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.found != "" {
		return t.found, t.ver, true
	}
	path, err := t.lookPath("git")
	if err != nil {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if t.goos == "darwin" && path == stubGit && !t.stubReady(ctx) {
		return "", "", false
	}
	out, err := t.version(ctx, path)
	if err != nil {
		return "", "", false
	}
	t.found, t.ver = path, gitVersion.FindString(out)
	return t.found, t.ver, true
}

func noGit() error {
	return model.Errorf(model.CodeUnavailable, "這台 Mac 還沒有 git，請先安裝 Apple 的開發者工具")
}

// path gives the git to run, or the error to show while there is none.
func (t *gitTool) path(ctx context.Context) (string, error) {
	if path, _, ok := t.find(ctx); ok {
		return path, nil
	}
	return "", noGit()
}

func (t *gitTool) status(ctx context.Context) adapter.GitStatus {
	_, version, ok := t.find(ctx)
	return adapter.GitStatus{Installed: ok, Version: version, Installable: t.goos == "darwin"}
}

// start asks macOS to install its Command Line Tools, which bring git. It returns once Apple's own window is open: the
// install itself happens there, and the user may still cancel it.
func (t *gitTool) start(ctx context.Context) error {
	if !t.installs.TryLock() {
		return model.Errorf(model.CodeConflict, "正在開啟安裝視窗")
	}
	defer t.installs.Unlock()
	if _, _, ok := t.find(ctx); ok {
		return nil
	}
	if t.goos != "darwin" {
		return model.Errorf(model.CodeUnsupported, "請用這個系統的套件管理工具安裝 git")
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if err := t.install(ctx); err != nil {
		// it also fails when the window is already open, or the tools are there but git is not usable yet
		return model.Errorf(model.CodeUnavailable, "無法開啟安裝視窗，請到終端機執行：%s", installCommand)
	}
	return nil
}

// Tool says whether git can run here.
func (g *Git) Tool(ctx context.Context) adapter.GitStatus { return tool.status(ctx) }

// InstallTool opens Apple's window that installs git. Its caller answers for the user having asked for it.
func (g *Git) InstallTool(ctx context.Context) error { return tool.start(ctx) }
