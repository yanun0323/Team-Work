package repository

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
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

// A tree once begun is made whole, even when what asked for it is cancelled meanwhile: git killed partway leaves the
// branch made and no tree on it, and whoever takes the step over cannot make one on the branch then.
func TestWorktreeIsFinishedWhenItsRunIsCancelled(t *testing.T) {
	folder := t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "one")
	g := NewGit(t.TempDir())
	dir := filepath.Join(t.TempDir(), "t1")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.Worktree(cancelled, folder, dir, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	if got := run(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "task/1" {
		t.Fatalf("the tree is on %q", got)
	}
	// whoever takes it over finds the tree there
	if err := g.Worktree(context.Background(), folder, dir, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
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

// What the app commits carries the user's own identity, never an employee's name: a project it handled shows no trace
// of who worked a step.
func TestCommitsCarryTheUsersIdentity(t *testing.T) {
	home := t.TempDir() // an empty home: what git can guess, or what the test sets, and nothing else
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	folder := t.TempDir()
	g := NewGit(t.TempDir())
	ctx := context.Background()
	if _, _, err := g.Prepare(ctx, folder); err != nil {
		t.Fatal(err)
	}
	run(t, folder, "config", "user.name", "Yanun User")
	run(t, folder, "config", "user.email", "yanun@example.com")
	dir := filepath.Join(t.TempDir(), "tree")
	if err := g.Worktree(ctx, folder, dir, "task/1", "master"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Commit(ctx, dir, "feat: work"); err != nil {
		t.Fatal(err)
	}
	for _, who := range []string{"%an", "%ae", "%cn", "%ce"} {
		got := run(t, dir, "show", "--no-patch", "--format="+who, "HEAD")
		if strings.Contains(got, "Ada") || strings.Contains(got, "mho-company") {
			t.Errorf("%s = %q, want the user's own", who, got)
		}
	}
	if name := run(t, dir, "show", "--no-patch", "--format=%an", "HEAD"); name != "Yanun User" {
		t.Fatalf("author = %q, want the name the repo sets", name)
	}
}

// A company made in a folder that is not a repo yet leaves the app's own files ignored from its first commit; in a
// repo the user already had, the rule is added but left for the user to commit.
func TestPrepareKeepsTheAppsFolderOutOfGit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	g := NewGit(t.TempDir())
	ctx := context.Background()

	fresh := t.TempDir()
	if _, initialized, err := g.Prepare(ctx, fresh); err != nil || !initialized {
		t.Fatalf("%v %v", initialized, err)
	}
	raw, err := os.ReadFile(filepath.Join(fresh, ".gitignore"))
	if err != nil || !strings.Contains(string(raw), ".team-work/") {
		t.Fatalf(".gitignore = %q, %v", raw, err)
	}
	if out := run(t, fresh, "status", "--porcelain"); out != "" {
		t.Fatalf("a new company's folder is dirty: %q", out)
	}
	if !strings.Contains(run(t, fresh, "ls-tree", "--name-only", "HEAD"), ".gitignore") {
		t.Fatal("the rule is not in the first commit")
	}
	// asking again writes nothing new
	if _, _, err := g.Prepare(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(filepath.Join(fresh, ".gitignore"))
	if strings.Count(string(raw2), ".team-work/") != 1 {
		t.Fatalf("the rule was added twice: %q", raw2)
	}
	// and the folder really is ignored
	if err := os.MkdirAll(filepath.Join(fresh, ".team-work"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fresh, ".team-work", "NOTES.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := run(t, fresh, "status", "--porcelain", "--untracked-files=all"); out != "" {
		t.Fatalf("the app's folder shows up: %q", out)
	}

	// a repo of the user's: the rule goes in uncommitted, and their own rules are kept
	mine := t.TempDir()
	run(t, mine, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(mine, ".gitignore"), []byte("build/"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, mine, "add", ".gitignore")
	run(t, mine, "-c", "user.name=u", "-c", "user.email=u@u", "commit", "-qm", "rules")
	if _, initialized, err := g.Prepare(ctx, mine); err != nil || initialized {
		t.Fatalf("%v %v", initialized, err)
	}
	raw3, _ := os.ReadFile(filepath.Join(mine, ".gitignore"))
	if !strings.HasPrefix(string(raw3), "build/") || !strings.Contains(string(raw3), ".team-work/") {
		t.Fatalf("the user's rules changed: %q", raw3)
	}
	if out := run(t, mine, "status", "--porcelain"); !strings.Contains(out, ".gitignore") {
		t.Fatalf("the rule was committed by the app: %q", out)
	}
	// a folder where the user committed the rule themselves is left alone entirely
	run(t, mine, "add", ".gitignore")
	run(t, mine, "-c", "user.name=u", "-c", "user.email=u@u", "commit", "-qm", "ignore the app")
	if _, _, err := g.Prepare(ctx, mine); err != nil {
		t.Fatal(err)
	}
	if out := run(t, mine, "status", "--porcelain"); out != "" {
		t.Fatalf("Prepare touched a folder it had nothing to add: %q", out)
	}
}

// A merge of the target branch names only that branch, worded as git words a merge of its own: no branch of the app's
// own shows in the history.
func TestMergeMessageNamesOnlyTheTarget(t *testing.T) {
	g, folder, dir := mergeRig(t)
	ctx := context.Background()
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "moved on")
	if conflict, err := g.MergeTarget(ctx, dir, "main"); err != nil || conflict {
		t.Fatalf("%v %v", conflict, err)
	}
	message := run(t, dir, "log", "--format=%s", "-1")
	if message != "Merge branch 'main'" {
		t.Fatalf("merge message = %q", message)
	}
}

// Where git has no identity of the user's to commit with, every commit the app makes says so with its own code, so
// the user is told to set one instead of an employee making one up.
func TestCommitWithoutAnIdentityAsksForTheUsers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	global := filepath.Join(home, ".gitconfig")
	if err := os.WriteFile(global, []byte("[user]\n\tuseConfigOnly = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	g := NewGit(t.TempDir())
	ctx := context.Background()
	noIdentity := func(what string, err error) {
		t.Helper()
		var known *model.Error
		if !errors.As(err, &known) || known.Code != model.CodeNoGitIdentity {
			t.Fatalf("%s: %v, want %s", what, err, model.CodeNoGitIdentity)
		}
	}

	_, _, err := g.Prepare(ctx, t.TempDir())
	noIdentity("a new repo", err)

	folder := t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "start")
	dir := filepath.Join(t.TempDir(), "tree")
	if err := g.Worktree(ctx, folder, dir, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "a.txt", "work\n")
	_, err = g.Commit(ctx, dir, "feat: work")
	noIdentity("a handoff", err)

	other := filepath.Join(t.TempDir(), "tree")
	if err := g.Worktree(ctx, folder, other, "task/2", "main"); err != nil {
		t.Fatal(err)
	}
	write(t, other, "b.txt", "mine\n")
	run(t, other, "add", "-A")
	run(t, other, "commit", "-q", "-m", "side")
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "moved on")
	_, err = g.MergeTarget(ctx, other, "main")
	noIdentity("a merge", err)
}
