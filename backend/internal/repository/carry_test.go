package repository

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A task's tree starts with what git leaves out of the project folder, except what would reach back into the project
// or that the task's own rules would commit.
func TestWorktreeCarriesIgnoredFiles(t *testing.T) {
	source, dest := t.TempDir(), filepath.Join(t.TempDir(), "task")
	run(t, source, "init", "-q", "-b", "main")
	envFile(t, source, ".gitignore", ".env\nbuild/\n.tmp/\n.venv/\nnode_modules/\nlinks/\n.team-work/\n")
	envFile(t, source, "package.json", `{"name":"app"}`)
	envFile(t, source, "package-lock.json", `{"lockfileVersion":3}`)
	envFile(t, source, "app.txt", "tracked")
	run(t, source, "add", ".")
	run(t, source, "commit", "-qm", "initial")

	envFile(t, source, ".env", "secret")
	envFile(t, source, "build/out/bin", "built")
	envFile(t, source, ".tmp/keep.txt", "scratch")
	envFile(t, source, ".tmp/other/.git", "gitdir: /elsewhere")
	envFile(t, source, ".tmp/other/file", "another repo")
	envFile(t, source, ".venv/pyvenv.cfg", "home = /usr/bin")
	envFile(t, source, "node_modules/pkg/index.js", "pkg")
	envFile(t, source, ".team-work/NOTES.md", "notes")
	envFile(t, source, "links/target.txt", "t")
	if err := os.Symlink("target.txt", filepath.Join(source, "links/near")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(source, "app.txt"), filepath.Join(source, "links/far")); err != nil {
		t.Fatal(err)
	}
	// ignored here only, not by the rules the task's branch has: it would be committed with the task
	envFile(t, source, ".gitignore", ".env\nbuild/\n.tmp/\n.venv/\nnode_modules/\nlinks/\n.team-work/\nlocal.txt\n")
	envFile(t, source, "local.txt", "mine")

	g := NewGit(t.TempDir())
	if err := g.Worktree(context.Background(), source, dest, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	cow := canClone(context.Background(), source, dest, []string{"app.txt"})

	read := func(rel string) string {
		raw, err := os.ReadFile(filepath.Join(dest, rel))
		if err != nil {
			return "<missing>"
		}
		return string(raw)
	}
	if got := read(".env"); got != "secret" {
		t.Fatalf(".env = %q", got)
	}
	carried := map[string]string{"build/out/bin": "built", ".tmp/keep.txt": "scratch", "links/target.txt": "t", "links/near": "t"}
	for rel, want := range carried {
		if !cow {
			want = "<missing>" // without clones whole folders would cost their full size
		}
		if got := read(rel); got != want {
			t.Errorf("%s = %q, want %q", rel, got, want)
		}
	}
	for _, rel := range []string{".tmp/other", ".venv", "node_modules", ".team-work", "links/far", "local.txt"} {
		if _, err := os.Lstat(filepath.Join(dest, rel)); err == nil {
			t.Errorf("%s was carried", rel)
		}
	}
	if got := run(t, dest, "status", "--porcelain"); got != "" {
		t.Fatalf("carrying dirtied the task: %q", got)
	}

	envFile(t, dest, ".env", "changed")
	if raw, _ := os.ReadFile(filepath.Join(source, ".env")); string(raw) != "secret" {
		t.Fatalf("changing the task's copy changed the project: %q", raw)
	}
}

// A tree already made is left as it is: files the task deleted or changed are not brought back.
func TestWorktreeCarriesOnlyWhenMade(t *testing.T) {
	source, dest := t.TempDir(), filepath.Join(t.TempDir(), "task")
	run(t, source, "init", "-q", "-b", "main")
	envFile(t, source, ".gitignore", ".env\n")
	run(t, source, "add", ".")
	run(t, source, "commit", "-qm", "initial")
	envFile(t, source, ".env", "secret")
	g := NewGit(t.TempDir())
	if err := g.Worktree(context.Background(), source, dest, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dest, ".env")); err != nil {
		t.Fatal(err)
	}
	if err := g.Worktree(context.Background(), source, dest, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, ".env")); err == nil {
		t.Fatal("a tree already there was refilled")
	}
}

func TestAppOwned(t *testing.T) {
	for rel, want := range map[string]bool{".team-work": true, ".team-work/x": true, ".team-work-save-1": true, ".team-workx": false, "a/.team-work": false} {
		if got := appOwned(filepath.FromSlash(rel)); got != want {
			t.Errorf("appOwned(%q) = %v", rel, got)
		}
	}
}
