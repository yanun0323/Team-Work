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

// Removing a task's tree deletes its branch only when the task made that tree on it; a branch of the same name the
// user already had, or one a tree failed to be made on, stays.
func TestRemoveKeepsABranchTheTaskDidNotMake(t *testing.T) {
	folder := t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "one")
	run(t, folder, "branch", "task/1") // the user's own
	g := NewGit(t.TempDir())
	ctx := context.Background()
	trees := t.TempDir()

	// a task never started, and one whose tree could not be made on the taken name
	if err := g.Remove(ctx, folder, filepath.Join(trees, "never"), "task/1"); err != nil {
		t.Fatal(err)
	}
	if err := g.Worktree(ctx, folder, filepath.Join(trees, "clash"), "task/1", "main"); err == nil {
		t.Fatal("a tree was made on a branch that was already there")
	}
	if err := g.Remove(ctx, folder, filepath.Join(trees, "clash"), "task/1"); err != nil {
		t.Fatal(err)
	}
	run(t, folder, "rev-parse", "--verify", "refs/heads/task/1")

	// a task's own tree and branch both go
	dir := filepath.Join(trees, "own")
	if err := g.Worktree(ctx, folder, dir, "task/2", "main"); err != nil {
		t.Fatal(err)
	}
	if err := g.Remove(ctx, folder, dir, "task/2"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the tree is still there: %v", err)
	}
	if out := run(t, folder, "branch", "--list", "task/2"); out != "" {
		t.Fatalf("the task's branch stayed: %q", out)
	}
	run(t, folder, "rev-parse", "--verify", "refs/heads/task/1")
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
