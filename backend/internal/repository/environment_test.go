package repository

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func envFile(t *testing.T, root, name, text string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func envRepo(t *testing.T) (*Git, string, string) {
	t.Helper()
	source, dest := t.TempDir(), filepath.Join(t.TempDir(), "task")
	run(t, source, "init", "-q", "-b", "main")
	envFile(t, source, ".gitignore", "node_modules/\n.env\n")
	envFile(t, source, "frontend/package.json", `{"name":"app","version":"1.0.0"}`)
	envFile(t, source, "frontend/package-lock.json", `{"lockfileVersion":3,"packages":{"":{"name":"app","version":"1.0.0"}}}`)
	run(t, source, "add", ".")
	run(t, source, "commit", "-qm", "initial")
	g := NewGit(t.TempDir())
	if err := g.Worktree(context.Background(), source, dest, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	return g, source, dest
}

func fakeNPM(t *testing.T, body string) string {
	t.Helper()
	bin := t.TempDir()
	envFile(t, bin, "npm", "#!/bin/sh\n"+body+"\n")
	if err := os.Chmod(filepath.Join(bin, "npm"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return bin
}

func TestEnvironmentInstallsOnceAndRefreshesChangedLock(t *testing.T) {
	g, source, dest := envRepo(t)
	fakeNPM(t, `test "$*" = "ci --no-audit --no-fund" || exit 9
mkdir -p node_modules
printf x >> node_modules/installs`)
	for range 2 {
		if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dest, "frontend/node_modules/installs")
	raw, _ := os.ReadFile(path)
	if string(raw) != "x" {
		t.Fatalf("installed more than once: %q", raw)
	}
	envFile(t, dest, "frontend/package-lock.json", `{"lockfileVersion":3,"packages":{}}`)
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != "xx" {
		t.Fatalf("changed lock did not reinstall: %q", raw)
	}
	if got := run(t, dest, "status", "--porcelain"); got != "M frontend/package-lock.json" {
		t.Fatalf("setup dirtied tracked files: %q", got)
	}
}

func TestEnvironmentCopiesOnlyMatchingNPMAndKeepsIsolation(t *testing.T) {
	g, source, dest := envRepo(t)
	envFile(t, source, "frontend/node_modules/.package-lock.json", `{"lockfileVersion":3,"packages":{}}`)
	envFile(t, source, "frontend/node_modules/example/index.js", "original")
	envFile(t, source, ".env", "secret")
	fakeNPM(t, "exit 99") // copying must not need the network or npm
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	envFile(t, dest, "frontend/node_modules/example/index.js", "changed")
	raw, _ := os.ReadFile(filepath.Join(source, "frontend/node_modules/example/index.js"))
	if string(raw) != "original" {
		t.Fatal("task changed the source dependencies")
	}
	if _, err := os.Stat(filepath.Join(dest, ".env")); !os.IsNotExist(err) {
		t.Fatal("copied secrets")
	}
	if got := run(t, dest, "status", "--porcelain"); got != "" {
		t.Fatalf("copied dependencies are not ignored: %s", got)
	}
}

func TestEnvironmentRejectsUnignoredDependencies(t *testing.T) {
	g, source, dest := envRepo(t)
	envFile(t, dest, ".gitignore", ".env\n")
	fakeNPM(t, "mkdir -p node_modules; touch node_modules/should-not-exist")
	err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {})
	if err == nil {
		t.Fatal("prepared dependencies that could be committed")
	}
	if _, err := os.Stat(filepath.Join(dest, "frontend/node_modules")); !os.IsNotExist(err) {
		t.Fatal("installed before checking ignore rules")
	}
}

func TestEnvironmentFailedInstallIsRetried(t *testing.T) {
	g, source, dest := envRepo(t)
	fakeNPM(t, "mkdir -p node_modules; exit 17")
	err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "npm") {
		t.Fatalf("missing actionable failure: %v", err)
	}
	fakeNPM(t, "mkdir -p node_modules; touch node_modules/ready")
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "frontend/node_modules/ready")); err != nil {
		t.Fatal("partial install counted as ready")
	}
}

func TestEnvironmentDoesNotCopyExternalSymlinks(t *testing.T) {
	g, source, dest := envRepo(t)
	envFile(t, source, "frontend/node_modules/.package-lock.json", `{"lockfileVersion":3,"packages":{}}`)
	if err := os.Symlink(t.TempDir(), filepath.Join(source, "frontend/node_modules/external")); err != nil {
		t.Fatal(err)
	}
	fakeNPM(t, "mkdir -p node_modules; touch node_modules/installed")
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dest, "frontend/node_modules/external")); !os.IsNotExist(err) {
		t.Fatal("copied a link out of the task")
	}
}

func TestEnvironmentPlatformOptionalAndStaleInstallation(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "other-platform", true: "stale"}[stale], func(t *testing.T) {
			g, source, dest := envRepo(t)
			lock := `{"lockfileVersion":3,"packages":{"node_modules/foreign":{"version":"1","optional":true,"os":["not-this-os"]},"node_modules/example":{"version":"1"}}}`
			envFile(t, source, "frontend/package-lock.json", lock)
			envFile(t, dest, "frontend/package-lock.json", lock)
			hidden := `{"packages":{"node_modules/example":{"version":"1"}}}`
			if stale {
				hidden = `{"packages":{"node_modules/example":{"version":"0"}}}`
			}
			envFile(t, source, "frontend/node_modules/.package-lock.json", hidden)
			envFile(t, source, "frontend/node_modules/example/index.js", "ok")
			fakeNPM(t, "mkdir -p node_modules; touch node_modules/installed")
			if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
				t.Fatal(err)
			}
			_, err := os.Stat(filepath.Join(dest, "frontend/node_modules/installed"))
			if (err == nil) != stale {
				t.Fatalf("install = %v, stale = %v", err, stale)
			}
		})
	}
}

func TestEnvironmentManagerCommands(t *testing.T) {
	for _, tc := range []struct{ manager, lock, manifest, args string }{
		{"npm", "package-lock.json", `{}`, "ci --no-audit --no-fund"},
		{"pnpm", "pnpm-lock.yaml", `{"packageManager":"pnpm@10.0.0"}`, "install --frozen-lockfile"},
		{"yarn", "yarn.lock", `{"packageManager":"yarn@1.22.0"}`, "install --frozen-lockfile --non-interactive"},
		{"yarn", "yarn.lock", `{"packageManager":"yarn@4.0.0"}`, "install --immutable"},
	} {
		t.Run(tc.manager+tc.args, func(t *testing.T) {
			dir := t.TempDir()
			envFile(t, dir, "package.json", tc.manifest)
			manager, lock, args, err := packageCommand(dir, []string{tc.lock})
			if err != nil || manager != tc.manager || lock != tc.lock || strings.Join(args, " ") != tc.args {
				t.Fatalf("%s %s %v %v", manager, lock, args, err)
			}
		})
	}
}

func TestEnvironmentCancelledPreparationDoesNotInstall(t *testing.T) {
	g, source, dest := envRepo(t)
	fakeNPM(t, "mkdir -p node_modules")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.PrepareEnvironment(ctx, source, dest, func(string) {}); err == nil {
		t.Fatal("ignored cancellation")
	}
	if directoryExists(filepath.Join(dest, "frontend/node_modules")) {
		t.Fatal("installed after cancellation")
	}
}

func TestEnvironmentUsesRealNPMOffline(t *testing.T) {
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm is not installed")
	}
	g, source, dest := envRepo(t)
	// No dependencies and a private cache: exercise npm ci itself without network or changing the user's cache.
	t.Setenv("npm_config_cache", t.TempDir())
	t.Setenv("npm_config_offline", "true")
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if got := run(t, dest, "status", "--porcelain"); got != "" {
		t.Fatalf("npm changed tracked files: %s", got)
	}
}

func TestEnvironmentConcurrentStepsPrepareOnce(t *testing.T) {
	g, source, dest := envRepo(t)
	fakeNPM(t, "mkdir -p node_modules; printf x >> node_modules/installs")
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- g.PrepareEnvironment(context.Background(), source, dest, func(string) {}) }()
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dest, "frontend/node_modules/installs"))
	if string(raw) != "x" {
		t.Fatalf("concurrent install: %q", raw)
	}
}

func TestEnvironmentCloneFailureFallsBackToIndependentCopy(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("APFS clone flag is macOS-only")
	}
	g, source, dest := envRepo(t)
	envFile(t, source, "frontend/node_modules/.package-lock.json", `{"packages":{}}`)
	envFile(t, source, "frontend/node_modules/example/index.js", "original")
	bin := fakeNPM(t, "exit 99")
	envFile(t, bin, "cp", "#!/bin/sh\n[ \"$1\" = \"-cR\" ] && exit 1\nexec /bin/cp \"$@\"\n")
	if err := os.Chmod(filepath.Join(bin, "cp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := g.PrepareEnvironment(context.Background(), source, dest, func(string) {}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dest, "frontend/node_modules/example/index.js"))
	if err != nil || string(raw) != "original" {
		t.Fatalf("copy fallback: %q %v", raw, err)
	}
}
