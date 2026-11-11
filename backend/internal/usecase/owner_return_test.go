package usecase_test

import (
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// returningOwner sends the first step's run back when the user asks, putting what return_step says in results and
// opening sent once it has; otherwise it leads as autoOwner does.
func returningOwner(sent *gate, results *[]model.Block) func(model.ModelRequest) model.ModelReply {
	return func(req model.ModelRequest) model.ModelReply {
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1]
		if len(last.Content) > 0 && last.Content[0].Type == enum.BlockToolResult && last.Content[0].Name == "return_step" {
			*results = append(*results, last.Content[0])
			sent.open()
			return say("sent back")
		}
		if len(req.Messages) == 1 && strings.Contains(brief, "[user_message]") && strings.Contains(brief, "請退回") {
			for _, run := range readView(brief).runs {
				if run.node == "start" && run.counts() {
					return ownerCall("return_step", map[string]any{"sub_id": run.id, "reason": "需求漏了"})
				}
			}
		}
		return autoOwner(req)
	}
}

// waitSent waits for the owner to have read what return_step said, so results can be read.
func waitSent(t *testing.T, sent *gate) {
	t.Helper()
	select {
	case <-sent.ch:
	case <-time.After(10 * time.Second):
		t.Fatal("the owner never read what return_step said")
	}
}

// wrapUp says whether a run was asked to hand off because what it builds on is being sent back.
func wrapUp(req model.ModelRequest) bool {
	for _, m := range req.Messages {
		for _, b := range m.Content {
			if b.Type == enum.BlockText && strings.Contains(b.Text, "is being sent back to be redone") && strings.Contains(b.Text, "需求漏了") {
				return true
			}
		}
	}
	return false
}

func redoOf(w *model.World, subID string) *model.SubTask {
	for _, s := range w.SubTasks {
		if s.Rework != nil && s.Rework.From == subID {
			return s
		}
	}
	return nil
}

// endRunning starts an owner-led task and waits for its last step to be at work, its first accepted.
func endRunning(r *rig) (task *model.Task, start, end *model.SubTask) {
	task = r.ownerTask(r.flow.ID)
	w := r.wait("the last step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "驗收")
		return s != nil && s.ExecutionState == model.ExecRunning
	})
	return task, subAt(w, task.ID, "整理需求"), subAt(w, task.ID, "驗收")
}

// A run sent back while one built on it still works waits for that one to hand off what it found, then goes back.
func TestOwnerReturnWaitsForWhatIsBuiltOnItToHandOff(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := returningOwner(sent, &results)
	asked := false
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) != "Acceptance review" || asked {
			return worker(req), nil
		}
		if wrapUp(req) {
			asked = true
			return call("submit_handoff", map[string]any{"goal": "審查結論", "done": []string{"找到兩個問題"}, "headline": "h", "did": []string{"x"}, "commit_message": "chore: review"}), nil
		}
		if !lastIsResult(req) {
			r.hold(sent) // still at work when the owner sends the step before it back
		}
		return call("run_command", map[string]any{"command": "true"}), nil
	})
	task, start, end := endRunning(r)
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請退回"}); err != nil {
		t.Fatal(err)
	}
	w := r.wait("sent back", func(w *model.World) bool { return redoOf(w, start.ID) != nil })
	waitSent(t, sent)
	if len(results) != 1 || results[0].IsError || !strings.Contains(results[0].Text, "still working ("+end.ID+")") {
		t.Fatalf("%+v", results)
	}
	if !asked {
		t.Fatal("the run built on it was never asked to hand off")
	}
	got := w.SubTasks[end.ID]
	if got.Status != enum.StatusComplete || got.Handoff == nil || got.Handoff.Agent.Goal != "審查結論" {
		t.Fatalf("what it found was not kept: %+v", got)
	}
	if s := w.SubTasks[start.ID]; s.Validity != model.ValidSuperseded {
		t.Fatalf("%+v", s)
	}
	items := r.activity(task.ID)
	waiting, returned, checked := -1, -1, -1
	for i, a := range items {
		switch {
		case a.Key == "returnWaiting":
			waiting = i
		case a.Key == "returnedByOwner":
			returned = i
		case a.Key == "accepted" && a.SubID == end.ID:
			checked = i
		case a.Key == "messageUndelivered":
			t.Fatalf("the wrap-up was taken for the owner's words: %+v", a)
		}
	}
	if waiting < 0 || returned < waiting {
		t.Fatalf("waiting at %d, sent back at %d", waiting, returned)
	}
	// it needs checking again, unless the owner already has
	if got.Validity != model.ValidNeedsRevalidation && checked < returned {
		t.Fatalf("not marked to check again: %+v", got)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
}

// Nothing built on the run still working: it goes back at once, as before.
func TestOwnerReturnWithNothingWorkingOnItGoesAtOnce(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := returningOwner(sent, &results)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	start := subAt(w, task.ID, "整理需求")
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請退回"}); err != nil {
		t.Fatal(err)
	}
	r.wait("sent back", func(w *model.World) bool { return redoOf(w, start.ID) != nil })
	waitSent(t, sent)
	if len(results) != 1 || !strings.HasPrefix(results[0].Text, "sent back; the redo is ") {
		t.Fatalf("%+v", results)
	}
	if hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "returnWaiting" }) {
		t.Fatal("waited with nothing to wait for")
	}
}

// A run that does not hand off in time: the user is asked, can wait longer, and can have it stopped and sent back.
func TestOwnerReturnAsksTheUserWhenTheWaitIsLong(t *testing.T) {
	t.Cleanup(usecase.SetReturnWait(150 * time.Millisecond))
	sent, stuck := newGate(t), newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := returningOwner(sent, &results)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) == "Acceptance review" && !lastIsResult(req) && !strings.Contains(req.Messages[0].Content[0].Text, "# This step was sent back") {
			r.hold(stuck) // never gets past its first call
			return call("run_command", map[string]any{"command": "true"}), nil
		}
		return worker(req), nil
	})
	task, start, end := endRunning(r)
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請退回"}); err != nil {
		t.Fatal(err)
	}
	asked := func(w *model.World) *model.TaskQuestion {
		for _, q := range w.Tasks[task.ID].Coordination.Questions {
			if q.Kind == "approval" && q.SubID == start.ID && len(q.Options) == 2 && q.Options[0].ID == "returnNow" && q.Options[1].ID == "waitMore" {
				return &q
			}
		}
		return nil
	}
	w := r.wait("asked", func(w *model.World) bool { return asked(w) != nil })
	if redoOf(w, start.ID) != nil {
		t.Fatal("sent back before the user said")
	}
	answer := func(id, option string) {
		w := r.world()
		plan, control := versions(w.Tasks[task.ID])
		if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: id, Action: "answer", QuestionID: asked(w).ID, OptionID: option, PlanVersion: plan, ControlVersion: control}); err != nil {
			t.Fatal(err)
		}
	}
	first := asked(w).ID
	answer("a1", "waitMore")
	if q := asked(r.world()); q != nil {
		t.Fatalf("still asked: %+v", q)
	}
	w = r.wait("asked again", func(w *model.World) bool { q := asked(w); return q != nil && q.ID != first })
	if redoOf(w, start.ID) != nil {
		t.Fatal("waiting longer sent it back")
	}
	answer("a2", "returnNow")
	stuck.open() // the stopped call returns, and its run ends
	w = r.wait("sent back", func(w *model.World) bool {
		return redoOf(w, start.ID) != nil && w.SubTasks[end.ID].ExecutionState == model.ExecStopped
	})
	if asked(w) != nil {
		t.Fatal("the card stayed")
	}
	if got := w.SubTasks[end.ID]; got.Handoff != nil || got.Validity != model.ValidNeedsRevalidation {
		t.Fatalf("%+v", got)
	}
}

// Pausing while a send-back waits stops what it waits for and sends it back at once; the redo waits for the resume.
func TestPausingSendsAWaitingReturnBackAtOnce(t *testing.T) {
	sent, stuck := newGate(t), newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := returningOwner(sent, &results)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) == "Acceptance review" && !lastIsResult(req) {
			r.hold(stuck)
			return call("run_command", map[string]any{"command": "true"}), nil
		}
		return worker(req), nil
	})
	task, start, _ := endRunning(r)
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請退回"}); err != nil {
		t.Fatal(err)
	}
	r.wait("waiting", func(w *model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "returnWaiting" })
	})
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p1", Action: "pause"}); err != nil {
		t.Fatal(err)
	}
	stuck.open()
	w := r.wait("sent back", func(w *model.World) bool { return redoOf(w, start.ID) != nil })
	if redo := redoOf(w, start.ID); !w.Tasks[task.ID].Paused || redo.StartedAt != nil {
		t.Fatalf("the redo started while paused: %+v", redo)
	}
}
