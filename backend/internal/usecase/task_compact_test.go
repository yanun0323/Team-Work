package usecase_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// padded is a tool call long enough that three of them are worth summing up.
func padded(name string) model.ModelReply {
	return call(name, map[string]any{"path": "nope.txt", "pad": strings.Repeat("長", 20_000)})
}

func summed(req model.ModelRequest) bool {
	for _, b := range req.Messages[0].Content {
		if strings.Contains(b.Text, "摘要內容") {
			return true
		}
	}
	return false
}

// A step whose conversation grows past what the model reads is summed up and goes on, its instructions kept word for
// word, instead of failing and being retried with the same conversation.
func TestStepCompactsWhenTheModelSaysItIsTooLong(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var last model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		switch {
		case summarizing(req):
			return say("摘要內容"), nil
		case isOwner(req):
			return autoOwner(req), nil
		case summed(req):
			mu.Lock()
			last = req
			mu.Unlock()
			return worker(req), nil
		case len(req.Messages) >= 7:
			return model.ModelReply{}, model.Errorf(model.CodeContextOverflow, "太長")
		}
		return padded("read_file"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	mu.Lock()
	defer mu.Unlock()
	if len(last.Messages) != 3 || len(last.Messages[0].Content) < 2 || strings.Contains(last.Messages[0].Content[0].Text, "摘要內容") {
		t.Fatalf("not summed up after the instructions: %+v", last.Messages)
	}
	if last.Messages[1].Role != enum.RoleAssistant {
		t.Fatalf("the latest words were not kept: %+v", last.Messages)
	}
	compacted := false
	for _, s := range w.SubTasks {
		if s.TaskID != task.ID {
			continue
		}
		if s.Tokens == 0 {
			t.Fatalf("no tokens counted: %+v", s)
		}
		for _, l := range s.Log {
			compacted = compacted || l.Kind == enum.LogSystem && strings.Contains(l.Text, "摘要")
		}
	}
	if !compacted {
		t.Fatal("the step's log does not say it was summed up")
	}
}

// The owner's decision is summed up the same way, keeping its briefing, instead of failing.
func TestOwnerCompactsWhenTheModelSaysItIsTooLong(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var last model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		switch {
		case summarizing(req):
			return say("摘要內容"), nil
		case !isOwner(req):
			return worker(req), nil
		case !strings.Contains(req.Messages[0].Content[0].Text, "[task_started]"):
			return autoOwner(req), nil
		case summed(req):
			mu.Lock()
			last = req
			mu.Unlock()
			// what came after the summed-up calls, as if they had never been
			return autoOwner(model.ModelRequest{Messages: append(req.Messages[:1:1], req.Messages[3:]...)}), nil
		case len(req.Messages) >= 7:
			return model.ModelReply{}, model.Errorf(model.CodeContextOverflow, "太長")
		}
		return padded("read_task_history"), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	mu.Lock()
	defer mu.Unlock()
	if len(last.Messages) < 3 || !strings.Contains(last.Messages[0].Content[0].Text, "[task_started]") {
		t.Fatalf("the briefing was not kept: %+v", last.Messages)
	}
}
