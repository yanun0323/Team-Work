package repository

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// fakeTool is a Mac whose git is at path, with Apple's tools at devDir ("" for none).
type fakeTool struct {
	*gitTool
	versions, installs int
}

func newFakeTool(goos, path, devDir string, versionErr error) *fakeTool {
	f := &fakeTool{}
	f.gitTool = &gitTool{
		goos: goos,
		lookPath: func(string) (string, error) {
			if path == "" {
				return "", errors.New("not found")
			}
			return path, nil
		},
		developerDir: func(context.Context) (string, error) {
			if devDir == "" {
				return "", errors.New("no developer directory")
			}
			return devDir, nil
		},
		isFile: func(p string) bool { return devDir != "" && p == devDir+"/usr/bin/git" },
		version: func(context.Context, string) (string, error) {
			f.versions++
			return "git version 2.39.5 (Apple Git-154)\n", versionErr
		},
		install: func(context.Context) error { f.installs++; return nil },
	}
	return f
}

func TestGitToolNeverRunsTheStubWithoutTheTools(t *testing.T) {
	f := newFakeTool("darwin", stubGit, "", nil)
	if s := f.status(context.Background()); s.Installed || !s.Installable {
		t.Fatalf("status = %+v", s)
	}
	if f.versions != 0 {
		t.Fatal("the stub ran, which opens Apple's install window")
	}
	var known *model.Error
	if _, err := f.path(context.Background()); !errors.As(err, &known) || known.Code != model.CodeUnavailable {
		t.Fatalf("path err = %v", err)
	}
}

func TestGitToolFindsGit(t *testing.T) {
	for name, f := range map[string]*fakeTool{
		"the stub with the tools behind it": newFakeTool("darwin", stubGit, "/Library/Developer/CommandLineTools", nil),
		"a git of its own":                  newFakeTool("darwin", "/opt/homebrew/bin/git", "", nil),
		"linux":                             newFakeTool("linux", "/usr/bin/git", "", nil),
	} {
		if s := f.status(context.Background()); !s.Installed || s.Version != "2.39.5" {
			t.Fatalf("%s: status = %+v", name, s)
		}
	}
}

func TestGitToolIsFoundOnceInstalledWhileRunning(t *testing.T) {
	f := newFakeTool("darwin", "/usr/local/bin/git", "", errors.New("broken"))
	if f.status(context.Background()).Installed {
		t.Fatal("a git that does not run counts as installed")
	}
	f.version = func(context.Context, string) (string, error) { f.versions++; return "git version 2.50.1", nil }
	if !f.status(context.Background()).Installed {
		t.Fatal("not found after installing")
	}
	before := f.versions
	f.status(context.Background())
	if f.versions != before {
		t.Fatal("a git once found is run again to be found")
	}
}

func TestGitToolInstall(t *testing.T) {
	ctx := context.Background()
	f := newFakeTool("darwin", stubGit, "", nil)
	if err := f.start(ctx); err != nil || f.installs != 1 {
		t.Fatalf("start: %v, installs %d", err, f.installs)
	}

	ready := newFakeTool("darwin", "/opt/homebrew/bin/git", "", nil)
	if err := ready.start(ctx); err != nil || ready.installs != 0 {
		t.Fatalf("installed already: %v, installs %d", err, ready.installs)
	}

	var known *model.Error
	linux := newFakeTool("linux", "", "", nil)
	if err := linux.start(ctx); !errors.As(err, &known) || known.Code != model.CodeUnsupported || linux.installs != 0 {
		t.Fatalf("linux: %v", err)
	}
	if linux.status(ctx).Installable {
		t.Fatal("linux says it can install git")
	}

	failing := newFakeTool("darwin", stubGit, "", nil)
	failing.install = func(context.Context) error { return errors.New("exit status 1") }
	if err := failing.start(ctx); !errors.As(err, &known) || known.Code != model.CodeUnavailable {
		t.Fatalf("failing: %v", err)
	}
}

// Asking twice at once opens Apple's window once.
func TestGitToolInstallsOneAtATime(t *testing.T) {
	f := newFakeTool("darwin", stubGit, "", nil)
	release, entered := make(chan struct{}), make(chan struct{})
	f.install = func(context.Context) error { f.installs++; close(entered); <-release; return nil }
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); _ = f.start(context.Background()) }()
	<-entered
	var known *model.Error
	if err := f.start(context.Background()); !errors.As(err, &known) || known.Code != model.CodeConflict {
		t.Fatalf("second start: %v", err)
	}
	close(release)
	wg.Wait()
	if f.installs != 1 {
		t.Fatalf("installs = %d", f.installs)
	}
}
