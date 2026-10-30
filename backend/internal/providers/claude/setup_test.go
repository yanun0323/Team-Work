package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// script makes a stand-in for the claude executable.
func script(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MHO_CLAUDE_EXECUTABLE", path)
	return path
}

func TestStatusWithoutClaudeCode(t *testing.T) {
	t.Setenv("MHO_CLAUDE_EXECUTABLE", filepath.Join(t.TempDir(), "gone"))
	got, err := NewSetup().Status(context.Background())
	if err != nil || got.Installed || got.SignedIn || got.Models == nil {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestStatusOfABrokenInstall(t *testing.T) {
	script(t, "exit 3")
	if _, err := NewSetup().Status(context.Background()); err == nil {
		t.Fatal("no error")
	}
}

func TestStatusSignedIn(t *testing.T) {
	fakeClaude(t)
	got, err := NewSetup().Status(context.Background())
	if err != nil || !got.Installed || !got.SignedIn || len(got.Models) == 0 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestInstallRunsTheScriptOnlyWhenMissing(t *testing.T) {
	target := filepath.Join(t.TempDir(), "claude")
	t.Setenv("MHO_CLAUDE_EXECUTABLE", target)
	mark := filepath.Join(t.TempDir(), "ran")
	s := &Setup{Script: "touch " + mark + "; printf '#!/bin/sh\\n' > " + target + "; chmod +x " + target}
	if err := s.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Fatal("installer did not run")
	}
	os.Remove(mark)
	if err := s.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("installed over a working copy")
	}
}

func TestInstallFailures(t *testing.T) {
	t.Setenv("MHO_CLAUDE_EXECUTABLE", filepath.Join(t.TempDir(), "gone"))
	if err := (&Setup{Script: "echo secret-output; exit 1"}).Install(context.Background()); err == nil || strings.Contains(err.Error(), "secret-output") {
		t.Fatal(err)
	}
	if err := (&Setup{Script: "true"}).Install(context.Background()); err == nil || !strings.Contains(err.Error(), "找不到") {
		t.Fatal(err)
	}
}

func TestStoppingStopsWhatItStarted(t *testing.T) {
	t.Setenv("MHO_CLAUDE_EXECUTABLE", filepath.Join(t.TempDir(), "gone"))
	mark := filepath.Join(t.TempDir(), "alive")
	s := &Setup{Script: "(sleep 2; touch " + mark + ") & wait"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := s.Install(ctx); err == nil {
		t.Fatal("no error")
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("the installer's children kept running")
	}
}

func TestOneAtATime(t *testing.T) {
	t.Setenv("MHO_CLAUDE_EXECUTABLE", filepath.Join(t.TempDir(), "gone"))
	s := &Setup{Script: "sleep 30"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Install(ctx) }()
	time.Sleep(100 * time.Millisecond)
	if err := s.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "正在") {
		t.Fatal(err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestLogin(t *testing.T) {
	seen := filepath.Join(t.TempDir(), "args")
	script(t, `echo "$@" > `+seen)
	if err := NewSetup().Login(context.Background()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(seen)
	if strings.TrimSpace(string(raw)) != "auth login --claudeai" {
		t.Fatalf("%q", raw)
	}

	script(t, "exit 1")
	if err := NewSetup().Login(context.Background()); err == nil || !strings.Contains(err.Error(), "claude auth login") {
		t.Fatal(err)
	}

	t.Setenv("MHO_CLAUDE_EXECUTABLE", filepath.Join(t.TempDir(), "gone"))
	if err := NewSetup().Login(context.Background()); err == nil {
		t.Fatal("logged in without Claude Code")
	}

	script(t, "exit 0")
	t.Setenv("ANTHROPIC_API_KEY", "x")
	if err := NewSetup().Login(context.Background()); err == nil || !strings.Contains(err.Error(), "ANTHROPIC_API_KEY") {
		t.Fatal(err)
	}
}
