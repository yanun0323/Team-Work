package repository

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// A repo is cloned once; each version read has a folder of its own that a later version leaves as it was, and a
// version already here is read with the repo gone.
func TestFetchClonesOnceAndKeepsEachVersion(t *testing.T) {
	upstream := t.TempDir()
	run(t, upstream, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(upstream, "a.md"), []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, upstream, "add", ".")
	run(t, upstream, "commit", "-qm", "one")
	first := run(t, upstream, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(upstream, "a.md"), []byte("two"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, upstream, "commit", "-qam", "two")
	second := run(t, upstream, "rev-parse", "HEAD")

	g := NewGit(t.TempDir())
	ctx := context.Background()
	dirOne, err := g.Fetch(ctx, upstream, first)
	if err != nil {
		t.Fatal(err)
	}
	dirTwo, err := g.Fetch(ctx, upstream, second)
	if err != nil {
		t.Fatal(err)
	}
	if dirOne == dirTwo {
		t.Fatal("two versions share a folder")
	}
	for dir, want := range map[string]string{dirOne: "one", dirTwo: "two"} {
		if raw, err := os.ReadFile(filepath.Join(dir, "a.md")); err != nil || string(raw) != want {
			t.Errorf("%s has %q, want %q", dir, raw, want)
		}
	}
	clones, _ := filepath.Glob(filepath.Join(g.cacheDir, "*", "repo.git"))
	if len(clones) != 1 {
		t.Errorf("clones = %v, want one", clones)
	}
	if err := os.RemoveAll(upstream); err != nil {
		t.Fatal(err)
	}
	if again, err := g.Fetch(ctx, upstream, first); err != nil || again != dirOne {
		t.Errorf("offline fetch = %q, %v; want %q", again, err, dirOne)
	}
}
