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
	blockedBy(t, g.FinishMerge(context.Background(), dir, "Ada"), model.MergeUnresolved, "a.txt", "b.txt")
}
