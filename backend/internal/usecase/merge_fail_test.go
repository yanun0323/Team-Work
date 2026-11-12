package usecase_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// A merge git refuses because the project folder has changes not yet committed to a file the task also changed: the
// task waits to be merged again and nothing of the user's is touched, and the user, in the task's conversation, and
// the owner, in what it reads of the task, are told the merge failed, why, and which file is in the way.
func TestMergeRefusedByUncommittedChangesSaysWhyAndKeepsThem(t *testing.T) {
	var mu sync.Mutex
	var told string // what the owner was told of the task when the user asked it about the failed merge
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			if lastIsResult(req) {
				return call("submit_handoff", handoff), nil
			}
			return call("write_file", map[string]string{"path": "AGENTS.md", "content": "# rules\n\ntask version\n"}), nil
		}
		if woken(req, "為什麼合併失敗") {
			mu.Lock()
			told = req.Messages[0].Content[0].Text
			mu.Unlock()
			return say("看過了"), nil
		}
		reply := autoOwner(req)
		if reply.Content[0].Name == "submit_complete" {
			return ownerCall("submit_complete", map[string]any{"summary": "做完了", "ask_merge": true}), nil
		}
		return reply, nil
	})
	agents := filepath.Join(r.folder, "AGENTS.md")
	if err := os.WriteFile(agents, []byte("# rules\n\nfirst\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, r.folder, "add", "-A")
	gitOut(t, r.folder, "-c", "user.name=me", "-c", "user.email=me@x", "commit", "-m", "add AGENTS.md")

	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.ownerIdle(task.ID)

	// the user's own edit, not committed, in the project folder
	const mine = "my edit, not committed\n"
	if err := os.WriteFile(agents, []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	before := gitOut(t, r.folder, "status", "--porcelain")

	var card *model.TaskQuestion
	for _, q := range r.world().Tasks[task.ID].Coordination.Questions {
		if q.Kind == "merge" {
			card = &q
		}
	}
	if card == nil {
		t.Fatal("no card to merge with")
	}
	plan, control := versions(r.world().Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "req-merge", Action: "answer", QuestionID: card.ID, OptionID: "merge", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("the merge to fail", func(w *model.World) bool {
		x := w.Tasks[task.ID]
		return x.Stage == enum.StageAwaitMerge && x.Merge != nil && x.Merge.StartedAt == nil && len(x.Merge.Log) > 1
	})

	// kept: still waiting to be merged, the user's edit and nothing stashed
	got := w.Tasks[task.ID]
	if got.Stage != enum.StageAwaitMerge || got.DoneAt != nil {
		t.Errorf("stage %s, done at %v", got.Stage, got.DoneAt)
	}
	if raw, _ := os.ReadFile(agents); string(raw) != mine {
		t.Errorf("the user's edit was changed: %q", raw)
	}
	if after := gitOut(t, r.folder, "status", "--porcelain"); after != before {
		t.Errorf("git status went from %q to %q", before, after)
	}
	if stashed := gitOut(t, r.folder, "stash", "list"); stashed != "" {
		t.Errorf("something was stashed: %s", stashed)
	}

	// what failed is kept for the screen to say again, and the card to merge does not come back
	if f := got.Merge.Failure; f == nil || f.Kind != model.MergeUncommitted || len(f.Files) != 1 || f.Files[0] != "AGENTS.md" || f.Target == "" {
		t.Errorf("failure kept as %+v", got.Merge.Failure)
	}
	for _, q := range got.Coordination.Questions {
		if q.Kind == "merge" {
			t.Errorf("a card to merge is back: %+v", q)
		}
	}

	// the merge's own record names the file in the way
	last := got.Merge.Log[len(got.Merge.Log)-1].Text
	if !strings.Contains(last, "AGENTS.md") {
		t.Errorf("the merge log does not name the file in the way: %q", last)
	}

	// the conversation of a task its owner runs, the only record its sheet shows, says the merge failed and why
	said := false
	for _, a := range r.activity(task.ID) {
		said = said || strings.Contains(a.Text, "AGENTS.md") || strings.Contains(a.Key, "merge")
	}
	if !said {
		t.Errorf("the task's conversation says nothing of the failed merge: %+v", r.activity(task.ID))
	}

	// the owner, asked about it, reads the failure in the task as it is told
	r.tell(task.ID, "req-ask", "為什麼合併失敗")
	r.wait("the owner to be asked", func(*model.World) bool { mu.Lock(); defer mu.Unlock(); return told != "" })
	mu.Lock()
	ownerSaw := told
	mu.Unlock()
	if !strings.Contains(ownerSaw, "AGENTS.md") {
		t.Errorf("the owner is not told why the merge failed:\n%s", ownerSaw)
	}
}

// Once the user clears what was in the way, pressing merge again lands the work.
func TestMergeRefusedByUncommittedChangesSucceedsOnceCleared(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "Clarify requirements" && !lastIsResult(req) {
			return call("write_file", map[string]string{"path": "AGENTS.md", "content": "task version\n"}), nil
		}
		return call("submit_handoff", handoff), nil
	})
	agents := filepath.Join(r.folder, "AGENTS.md")
	os.WriteFile(agents, []byte("first\n"), 0o644)
	gitOut(t, r.folder, "add", "-A")
	gitOut(t, r.folder, "-c", "user.name=me", "-c", "user.email=me@x", "commit", "-m", "add AGENTS.md")
	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	os.WriteFile(agents, []byte("mine\n"), 0o644)
	_, events, cancel, err := r.e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.MergeTask(task.ID); err == nil { // pressed again while it merges
		t.Error("a second merge started while the first was under way")
	}
	w := r.wait("the merge to fail", func(w *model.World) bool {
		x := w.Tasks[task.ID]
		return x.Stage == enum.StageAwaitMerge && x.Merge != nil && x.Merge.StartedAt == nil
	})
	if raw, _ := os.ReadFile(agents); string(raw) != "mine\n" {
		t.Fatalf("the user's edit was changed: %q", raw)
	}
	if f := w.Tasks[task.ID].Merge.Failure; f == nil || f.Kind != model.MergeUncommitted {
		t.Fatalf("failure kept as %+v", f)
	}
	// the notice says it failed, not that the task can be merged
	for told := ""; told != "mergeFailed"; {
		select {
		case ev := <-events:
			if ev.Type == "notice" && ev.TaskID == task.ID {
				if told = ev.Kind; told != "mergeFailed" {
					t.Fatalf("noticed %s", told)
				}
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no notice that the merge failed")
		}
	}

	// work sent back and done again is new work: the old failure no longer says anything of it
	if err := r.e.ReturnTask(task.ID, "再做一次"); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge again", func(w *model.World) bool {
		x := w.Tasks[task.ID]
		return x.Stage == enum.StageAwaitMerge && x.Merge.Failure == nil
	})

	gitOut(t, r.folder, "checkout", "--", "AGENTS.md") // the user puts their edit aside themselves
	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w = r.wait("done", stage(task.ID, enum.StageDone))
	if f := w.Tasks[task.ID].Merge.Failure; f != nil {
		t.Errorf("the failure stayed after merging: %+v", f)
	}
	if raw, _ := os.ReadFile(agents); string(raw) != "task version\n" {
		t.Fatalf("AGENTS.md = %q", raw)
	}
}

// A merge git refuses with a path of another checkout, here the target branch checked out in a work tree of the
// user's own: neither the failure, its record nor the task's conversation shows that path, and git's reason stays.
func TestMergeFailureShowsNoPathOfAnotherCheckout(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			if lastIsResult(req) {
				return call("submit_handoff", handoff), nil
			}
			return call("write_file", map[string]string{"path": "a.txt", "content": "task\n"}), nil
		}
		reply := autoOwner(req)
		if reply.Content[0].Name == "submit_complete" {
			return ownerCall("submit_complete", map[string]any{"summary": "做完了", "ask_merge": true}), nil
		}
		return reply, nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.ownerIdle(task.ID)

	target := gitOut(t, r.folder, "branch", "--show-current")
	parent := filepath.Join(t.TempDir(), "PrivateClient")
	other := filepath.Join(parent, "another-tree")
	gitOut(t, r.folder, "checkout", "-q", "-b", "other")
	gitOut(t, r.folder, "worktree", "add", "-q", other, target)
	private := []string{parent}
	if real, err := filepath.EvalSymlinks(parent); err == nil {
		private = append(private, real)
	}

	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.wait("the merge to fail", func(w *model.World) bool {
		x := w.Tasks[task.ID]
		return x.Merge != nil && x.Merge.StartedAt == nil && x.Merge.Failure != nil
	})
	got := w.Tasks[task.ID]
	f := got.Merge.Failure
	if got.Stage != enum.StageAwaitMerge || f.Detail == "" || !strings.Contains(f.Detail, "another-tree") {
		t.Fatalf("stage %s, failure %+v", got.Stage, f)
	}
	shown := []string{f.Detail, f.Reason, f.Target, strings.Join(f.Files, " ")}
	for _, line := range got.Merge.Log {
		shown = append(shown, line.Text)
	}
	for _, a := range r.activity(task.ID) {
		if a.Key == "mergeFailed" {
			shown = append(shown, a.Text, fmt.Sprint(a.Args))
		}
	}
	for _, text := range shown {
		for _, p := range private {
			if strings.Contains(text, p) {
				t.Errorf("%q shows %s", text, p)
			}
		}
	}
}
