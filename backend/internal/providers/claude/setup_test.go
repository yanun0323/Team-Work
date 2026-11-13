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
	if err := NewSetup().Login(context.Background()); err == nil || !strings.Contains(err.Error(), "「登入 Claude」") {
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

func TestOwnConfigDirWinsOverTheUsers(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	own := filepath.Join(t.TempDir(), "link")
	real := t.TempDir()
	if err := os.Symlink(real, own); err != nil {
		t.Fatal(err)
	}
	if err := UseConfigDir(own); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { configDir = "" })
	want, _ := filepath.EvalSymlinks(real)
	if claudeDir() != want {
		t.Fatal(claudeDir(), want)
	}
	env, err := childEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, entry := range env {
		if strings.HasPrefix(entry, "CLAUDE_CONFIG_DIR=") {
			got = append(got, entry)
		}
	}
	if len(got) != 1 || got[0] != "CLAUDE_CONFIG_DIR="+want {
		t.Fatal(got)
	}
	if err := UseConfigDir("relative"); err == nil {
		t.Fatal("a relative folder must be refused")
	}
}

// Team Work keeps Claude Code's sign-in in a folder of its own, so a provider's sign-in runs Claude Code's own in
// the browser when it is signed out there, and only checks when it is signed in already.
func TestSignInRunsClaudesSignInOnlyWhenSignedOut(t *testing.T) {
	fakeClaude(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mark, logins := filepath.Join(dir, "signed-in"), filepath.Join(dir, "logins")
	script(t, `if [ "$1" = auth ]; then echo "$@" >> '`+logins+`'; [ -n "$FAIL_LOGIN" ] && exit 1; touch '`+mark+`'; exit 0; fi
[ -f '`+mark+`' ] || export MHO_TEST_CLAUDE_AUTH_ERROR=1
exec '`+executable+`' -test.run='^TestClaudeChild$'`)
	count := func() string {
		raw, _ := os.ReadFile(logins)
		return strings.TrimSpace(string(raw))
	}
	s := NewSetup()
	ctx := context.Background()
	if err := s.SignIn(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != "auth login --claudeai" {
		t.Fatalf("%q", count())
	}
	if err := s.SignIn(ctx); err != nil || count() != "auth login --claudeai" {
		t.Fatalf("signed in already, yet signed in again: %v %q", err, count())
	}

	_ = os.Remove(mark)
	t.Setenv("FAIL_LOGIN", "1")
	if err := s.SignIn(ctx); err == nil || !strings.Contains(err.Error(), "「登入 Claude」") {
		t.Fatalf("an unfinished sign-in: %v", err)
	}
}
