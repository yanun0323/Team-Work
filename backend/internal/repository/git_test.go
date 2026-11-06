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

// A ref names one branch or tag exactly: another branch ending in the same name, like changeset-release/main next to
// main, is not it, whichever ls-remote lists first.
func TestLatestReadsTheRefNamedExactly(t *testing.T) {
	upstream := t.TempDir()
	run(t, upstream, "init", "-q", "-b", "main")
	run(t, upstream, "commit", "-q", "--allow-empty", "-m", "one")
	release := run(t, upstream, "rev-parse", "HEAD")
	run(t, upstream, "branch", "changeset-release/main")
	run(t, upstream, "tag", "-a", "v1", "-m", "v1")
	run(t, upstream, "commit", "-q", "--allow-empty", "-m", "two")
	main := run(t, upstream, "rev-parse", "HEAD")

	g := NewGit(t.TempDir())
	for ref, want := range map[string]string{"main": main, "": main, "refs/heads/main": main, "changeset-release/main": release, "v1": release} {
		if got, err := g.Latest(context.Background(), upstream, ref); err != nil || got != want {
			t.Errorf("Latest(%q) = %q, %v; want %q", ref, got, err, want)
		}
	}
	if _, err := g.Latest(context.Background(), upstream, "release/main"); err == nil {
		t.Error("Latest found a branch that is not there")
	}
}

// A diff keeps every line in order, unchanged ones too, and has nothing to say about a file the base did not have.
func TestDiffKeepsEveryLine(t *testing.T) {
	folder := t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(folder, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.md", "one\n  two\nthree\n\nfive\n")
	run(t, folder, "add", "-A")
	run(t, folder, "commit", "-q", "-m", "base")
	base := run(t, folder, "rev-parse", "HEAD")
	write("a.md", "one\n  TWO\nthree\n\nfive\n@@ six\n")
	write("new.md", "fresh\n")
	run(t, folder, "add", "-A")
	run(t, folder, "commit", "-q", "-m", "change")
	head := run(t, folder, "rev-parse", "HEAD")
	g := NewGit(t.TempDir())
	ctx := context.Background()

	lines, err := g.Diff(ctx, folder, base, head, "a.md")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range lines {
		got = append(got, l.Op+":"+l.Text)
	}
	want := []string{"same:one", "del:  two", "add:  TWO", "same:three", "same:", "same:five", "add:@@ six"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q\nwant %q", got, want)
	}

	if lines, err := g.Diff(ctx, folder, base, head, "new.md"); err != nil || lines != nil {
		t.Fatalf("a new file compared: %v %v", lines, err)
	}
	if lines, err := g.Diff(ctx, folder, head, head, "a.md"); err != nil || len(lines) != 6 || lines[1].Text != "  TWO" || lines[5].Op != "same" {
		t.Fatalf("an unchanged file: %v %v", lines, err)
	}
	if _, err := g.Diff(ctx, folder, base, head, "gone.md"); err == nil {
		t.Fatal("a missing file compared")
	}
}
