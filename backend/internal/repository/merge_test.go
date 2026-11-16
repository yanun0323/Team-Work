package repository

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// mergeRig is a project on main with a task's work tree on task/1 that changed a.txt and added new.txt.
func mergeRig(t *testing.T) (g *Git, folder, dir string) {
	t.Helper()
	folder = t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	write(t, folder, "a.txt", "one\n")
	write(t, folder, "b.txt", "one\n")
	run(t, folder, "add", "-A")
	run(t, folder, "commit", "-q", "-m", "one")
	g = NewGit(t.TempDir())
	dir = filepath.Join(t.TempDir(), "tree")
	if err := g.Worktree(context.Background(), folder, dir, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "a.txt", "task\n")
	write(t, dir, "new.txt", "task\n")
	run(t, dir, "add", "-A")
	run(t, dir, "commit", "-q", "-m", "task")
	return g, folder, dir
}

func write(t *testing.T, dir, name, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func blockedBy(t *testing.T, err error, kind string, files ...string) {
	t.Helper()
	var b *model.MergeBlocked
	if !errors.As(err, &b) {
		t.Fatalf("not told why: %v", err)
	}
	if b.Kind != kind || !slices.Equal(b.Files, files) {
		t.Fatalf("told %s %v, want %s %v (%v)", b.Kind, b.Files, kind, files, err)
	}
}

// Changes not committed in the project folder to files the task changed or added stop landing it, and are named;
// they stay as they were. One to a file the task left alone does not stop it.
func TestLandNamesWhatIsNotCommittedInTheWay(t *testing.T) {
	g, folder, _ := mergeRig(t)
	ctx := context.Background()
	write(t, folder, "a.txt", "mine\n")
	write(t, folder, "new.txt", "mine\n")
	write(t, folder, "b.txt", "mine too\n")
	err := g.Land(ctx, folder, "task/1", "main")
	blockedBy(t, err, model.MergeUncommitted, "a.txt", "new.txt")
	for name, want := range map[string]string{"a.txt": "mine\n", "new.txt": "mine\n", "b.txt": "mine too\n"} {
		if raw, _ := os.ReadFile(filepath.Join(folder, name)); string(raw) != want {
			t.Errorf("%s = %q", name, raw)
		}
	}

	run(t, folder, "checkout", "--", "a.txt")
	os.Remove(filepath.Join(folder, "new.txt"))
	if err := g.Land(ctx, folder, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(folder, "b.txt")); string(raw) != "mine too\n" {
		t.Errorf("b.txt = %q", raw)
	}
}

// A target branch that moved on since the task merged it in is told apart, checked out or not.
func TestLandTellsTheTargetMovedOn(t *testing.T) {
	for _, away := range []bool{false, true} {
		g, folder, _ := mergeRig(t)
		run(t, folder, "commit", "-q", "--allow-empty", "-m", "later")
		if away {
			run(t, folder, "checkout", "-q", "-b", "other")
		}
		blockedBy(t, g.Land(context.Background(), folder, "task/1", "main"), model.MergeMoved)
	}
}

// Merging a target branch that is not there, or one whose changes would overwrite files not committed in the work
// tree, says so.
func TestMergeTargetTellsWhyItCannot(t *testing.T) {
	g, folder, dir := mergeRig(t)
	ctx := context.Background()
	_, err := g.MergeTarget(ctx, dir, "nope")
	blockedBy(t, err, model.MergeNoTarget)

	write(t, folder, "b.txt", "main moved\n")
	run(t, folder, "commit", "-q", "-am", "main moved")
	write(t, dir, "b.txt", "left in the tree\n")
	_, err = g.MergeTarget(ctx, dir, "main")
	blockedBy(t, err, model.MergeWorktreeDirty, "b.txt")
	if raw, _ := os.ReadFile(filepath.Join(dir, "b.txt")); string(raw) != "left in the tree\n" {
		t.Errorf("b.txt = %q", raw)
	}
}

// Every file still marked as in conflict is named, not just the first.
func TestFinishMergeNamesEveryFileInConflict(t *testing.T) {
	g, _, dir := mergeRig(t)
	write(t, dir, "a.txt", "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n")
	write(t, dir, "b.txt", "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n")
	blockedBy(t, g.FinishMerge(context.Background(), dir), model.MergeUnresolved, "a.txt", "b.txt")
}

// The ignore rule the app added to a folder of the user's, and left uncommitted, does not stop a task that changed
// .gitignore too from landing: the app puts its own lines aside, lands, and adds back what is still missing. Lines of
// the user's own not committed still stop it, and are left as they were.
func TestLandCarriesTheAppsIgnoreRule(t *testing.T) {
	ctx := context.Background()
	rig := func(t *testing.T) (*Git, string) {
		folder := t.TempDir()
		run(t, folder, "init", "-q", "-b", "main")
		write(t, folder, ".gitignore", "build/\n")
		run(t, folder, "add", "-A")
		run(t, folder, "commit", "-q", "-m", "one")
		g := NewGit(t.TempDir())
		if _, _, err := g.Prepare(ctx, folder); err != nil { // adds the app's rule, uncommitted
			t.Fatal(err)
		}
		dir := filepath.Join(t.TempDir(), "tree")
		if err := g.Worktree(ctx, folder, dir, "task/1", "main"); err != nil {
			t.Fatal(err)
		}
		write(t, dir, ".gitignore", "build/\ndist/\n")
		run(t, dir, "add", "-A")
		run(t, dir, "commit", "-q", "-m", "task")
		return g, folder
	}

	t.Run("only the app's lines", func(t *testing.T) {
		g, folder := rig(t)
		if err := g.Land(ctx, folder, "task/1", "main"); err != nil {
			t.Fatal(err)
		}
		raw, _ := os.ReadFile(filepath.Join(folder, ".gitignore"))
		if want := "build/\ndist/\n.team-work/\n.team-work-save-*\n"; string(raw) != want {
			t.Fatalf(".gitignore = %q, want %q", raw, want)
		}
		if got := run(t, folder, "show", "HEAD:.gitignore"); got != "build/\ndist/" {
			t.Fatalf("the task's .gitignore did not land: %q", got)
		}
	})

	t.Run("a line of the user's too", func(t *testing.T) {
		g, folder := rig(t)
		raw, _ := os.ReadFile(filepath.Join(folder, ".gitignore"))
		mine := string(raw) + "tmp/\n"
		write(t, folder, ".gitignore", mine)
		blockedBy(t, g.Land(ctx, folder, "task/1", "main"), model.MergeUncommitted, ".gitignore")
		if raw, _ := os.ReadFile(filepath.Join(folder, ".gitignore")); string(raw) != mine {
			t.Fatalf("the user's .gitignore changed: %q", raw)
		}
	})
}

// Where the user had no .gitignore, the app's rule is a file of its own not tracked yet; a task adding .gitignore
// lands over it all the same, and the rule ends up in what landed.
func TestLandCarriesTheAppsIgnoreFileNotTrackedYet(t *testing.T) {
	ctx := context.Background()
	folder := t.TempDir()
	run(t, folder, "init", "-q", "-b", "main")
	run(t, folder, "commit", "-q", "--allow-empty", "-m", "one")
	g := NewGit(t.TempDir())
	if _, _, err := g.Prepare(ctx, folder); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "tree")
	if err := g.Worktree(ctx, folder, dir, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	write(t, dir, ".gitignore", "node_modules/\n")
	run(t, dir, "add", "-A")
	run(t, dir, "commit", "-q", "-m", "task")
	if err := g.Land(ctx, folder, "task/1", "main"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(folder, ".gitignore"))
	if want := "node_modules/\n.team-work/\n.team-work-save-*\n"; string(raw) != want {
		t.Fatalf(".gitignore = %q, want %q", raw, want)
	}
}
