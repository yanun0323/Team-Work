package usecase_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestEnvironmentFailureStopsBeforeModelAndDoesNotCountAsFailedVerification(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	for name, text := range map[string]string{"package.json": `{}`, "package-lock.json": `{"lockfileVersion":3}`} {
		if err := os.WriteFile(filepath.Join(r.folder, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gitOut(t, r.folder, "add", ".")
	gitOut(t, r.folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "packages")
	task := r.task(r.flow.ID)
	w := r.wait("environment review", func(w *model.World) bool { s := subAt(w, task.ID, "整理需求"); return s != nil && s.Review != nil })
	s := subAt(w, task.ID, "整理需求")
	if s.Review.Kind != enum.ReviewFailed || s.Review.Reason != "environment" || s.Review.Prompt == "" || s.Attempts != 0 {
		t.Fatalf("wrong failure: %+v", s)
	}
	r.fake.mu.Lock()
	seen := len(r.fake.seen)
	r.fake.mu.Unlock()
	if seen != 0 {
		t.Fatal("model started despite missing environment")
	}
	// Fix the environment in this task, then use the same retry the UI offers.
	dir := filepath.Join(r.data, "cache", "worktrees", task.TeamID, task.ID)
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nmkdir -p node_modules\nprintf x >> node_modules/installs\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := r.e.ResolveReview(s.ID, "retry", ""); err != nil {
		t.Fatal(err)
	}
	r.wait("prepared task completes both steps", stage(task.ID, enum.StageAwaitMerge))
	raw, err := os.ReadFile(filepath.Join(dir, "node_modules/installs"))
	if err != nil || string(raw) != "x" {
		t.Fatalf("steps did not share prepared environment: %q %v", raw, err)
	}
}
