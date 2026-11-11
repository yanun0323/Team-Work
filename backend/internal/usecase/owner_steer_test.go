package usecase_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

const steerWords = "改用 B 方案"

// gate is a channel closed once, by whichever comes first: the test or its cleanup.
type gate struct {
	ch   chan struct{}
	once sync.Once
}

func newGate(t *testing.T) *gate {
	g := &gate{ch: make(chan struct{})}
	t.Cleanup(g.open)
	return g
}

func (g *gate) open() { g.once.Do(func() { close(g.ch) }) }

// hold keeps a model call waiting until g opens, letting other calls through meanwhile.
func (r *rig) hold(g *gate) {
	r.fake.mu.Unlock()
	<-g.ch
	r.fake.mu.Lock()
}

// told says whether the employee has been told what the owner said while they worked, and how many times.
func told(req model.ModelRequest) int {
	n := 0
	for _, m := range req.Messages {
		for _, b := range m.Content {
			if b.Type == enum.BlockText && strings.Contains(b.Text, "The task owner tells you while you work") && strings.Contains(b.Text, steerWords) {
				n++
			}
		}
	}
	return n
}

// steeringOwner tells the first step's run what steerWords say when the user asks, opening sent once the tool took
// it; otherwise it leads as autoOwner does. results gets each message_step result.
func steeringOwner(sent *gate, results *[]model.Block) func(model.ModelRequest) model.ModelReply {
	return func(req model.ModelRequest) model.ModelReply {
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1]
		if len(last.Content) > 0 && last.Content[0].Type == enum.BlockToolResult && last.Content[0].Name == "message_step" {
			*results = append(*results, last.Content[0])
			sent.open()
			return say("told")
		}
		if len(req.Messages) == 1 && strings.Contains(brief, "[user_message]") && strings.Contains(brief, "請插話") {
			for _, run := range readView(brief).runs {
				if run.node == "start" {
					return ownerCall("message_step", map[string]any{"sub_id": run.id, "text": steerWords})
				}
			}
		}
		return autoOwner(req)
	}
}

func steered(items []model.TaskActivity, subID string, ownerID string) bool {
	return hasActivity(items, func(a model.TaskActivity) bool {
		return a.Kind == "message" && a.From == "agent" && a.By == ownerID && a.SubID == subID && a.NodeID == "start" && a.Text == steerWords
	})
}

func undelivered(items []model.TaskActivity) bool {
	return hasActivity(items, func(a model.TaskActivity) bool { return a.Key == "messageUndelivered" })
}

func TestOwnerTellsARunAtWorkWhatItReadsAfterItsToolsWithoutStoppingIt(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	var heard model.ModelRequest
	r := newRig(t, nil)
	owner := steeringOwner(sent, &results)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) != "Clarify requirements" {
			return worker(req), nil
		}
		if told(req) > 0 {
			heard = req
			return worker(req), nil
		}
		if !lastIsResult(req) {
			r.hold(sent) // still at work when the owner speaks
			return call("run_command", map[string]any{"command": "true"}), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning
	})
	sub := subAt(w, task.ID, "整理需求")
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請插話"}); err != nil {
		t.Fatal(err)
	}
	// the run was still at work when it was told, and went on
	w = r.wait("told", func(w *model.World) bool { return steered(r.activity(task.ID), sub.ID, r.owner.ID) })
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if len(results) != 1 || results[0].IsError {
		t.Fatalf("%+v", results)
	}
	if told(heard) != 1 {
		t.Fatal("the employee never read what the owner said")
	}
	// right after the round of tool results it came in, marked as the owner's
	i := len(heard.Messages) - 1
	if heard.Messages[i].Role != enum.RoleUser || heard.Messages[i-1].Content[0].Type != enum.BlockToolResult || heard.Messages[i-1].Content[0].Name != "run_command" {
		t.Fatalf("%+v", heard.Messages[i-1:])
	}
	if s := r.world().SubTasks[sub.ID]; s.Status != enum.StatusComplete || s.RunGeneration != 1 {
		t.Fatalf("the run was stopped or started again: %+v", s)
	}
	if undelivered(r.activity(task.ID)) {
		t.Fatal("said it was not delivered")
	}
	// reading it woke nobody: the owner was woken by the user and the handoffs alone
	for _, req := range ownerRequests(r) {
		if len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[message_undelivered]") {
			t.Fatal("the owner was told about it")
		}
	}
}

func TestWhatTheOwnerSaidComesBeforeTheEmployeeIsToldToHandOff(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	var heard model.ModelRequest
	r := newRig(t, nil)
	owner := steeringOwner(sent, &results)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) != "Clarify requirements" {
			return worker(req), nil
		}
		if told(req) > 0 {
			heard = req
			return worker(req), nil
		}
		r.hold(sent)
		return say("我覺得差不多了"), nil // only talks, so the backend would tell them to hand off
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning
	})
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請插話"}); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if told(heard) != 1 {
		t.Fatal("the employee never read what the owner said")
	}
	last := heard.Messages[len(heard.Messages)-1]
	if !strings.Contains(last.Content[0].Text, steerWords) {
		t.Fatalf("%+v", last)
	}
	for _, m := range heard.Messages {
		if strings.Contains(m.Content[0].Text, "You have not handed off") {
			t.Fatal("told to hand off before reading what the owner said")
		}
	}
}

func TestARunThatEndsBeforeReadingIsReportedNotDelivered(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := steeringOwner(sent, &results)
	var late []model.Block
	var briefs []string
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			brief := req.Messages[0].Content[0].Text
			last := req.Messages[len(req.Messages)-1]
			if len(req.Messages) == 1 && strings.Contains(brief, "[message_undelivered]") {
				briefs = append(briefs, brief)
				// a run that handed off, or none of this task, is not told anything
				for _, run := range readView(brief).runs {
					if run.node == "start" {
						return ownerCall("message_step", map[string]any{"sub_id": run.id, "text": "還有一件事"}), nil
					}
				}
			}
			if len(late) == 0 && len(last.Content) > 0 && last.Content[0].Name == "message_step" && len(briefs) > 0 {
				late = append(late, last.Content[0])
				return ownerCall("message_step", map[string]any{"sub_id": "sub-9999", "text": "還有一件事"}), nil
			}
			if len(late) == 1 && len(last.Content) > 0 && last.Content[0].Name == "message_step" {
				late = append(late, last.Content[0])
				return ownerCall("read_task", map[string]any{}), nil // and on with the work
			}
			return owner(req), nil
		}
		if stepOf(req) == "Clarify requirements" && told(req) == 0 {
			r.hold(sent)
		}
		return worker(req), nil // hands off at once, without another round to read it in
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning
	})
	sub := subAt(w, task.ID, "整理需求")
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請插話"}); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	items := r.activity(task.ID)
	if !steered(items, sub.ID, r.owner.ID) || !hasActivity(items, func(a model.TaskActivity) bool {
		return a.Key == "messageUndelivered" && a.Kind == "event" && a.SubID == sub.ID && a.Args["step"] == "整理需求"
	}) {
		t.Fatalf("%+v", items)
	}
	if len(briefs) != 1 || !strings.Contains(briefs[0], steerWords) || !strings.Contains(briefs[0], "handed off before reading") {
		t.Fatalf("%q", briefs)
	}
	// handed off together, in one decision
	if !strings.Contains(briefs[0], "[employee_handoff]") {
		t.Fatalf("%q", briefs[0])
	}
	if len(late) != 2 || !late[0].IsError || !strings.Contains(late[0].Text, "return_step") || !late[1].IsError {
		t.Fatalf("%+v", late)
	}
}

func TestWhatTheOwnerSaidOutlivesARestartAndIsReadOnce(t *testing.T) {
	sent := newGate(t)
	var results []model.Block
	r := newRig(t, nil)
	owner := steeringOwner(sent, &results)
	var heard []int
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return owner(req), nil
		}
		if stepOf(req) == "Clarify requirements" && !lastIsResult(req) && told(req) == 0 {
			r.hold(sent)
			return call("run_command", map[string]any{"command": "sleep 30"}), nil // ends with the server, before reading it
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning
	})
	sub := subAt(w, task.ID, "整理需求")
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "請插話"}); err != nil {
		t.Fatal(err)
	}
	r.wait("the command to run", func(w *model.World) bool {
		s := w.SubTasks[sub.ID]
		return len(results) == 1 && len(s.Log) > 0 && strings.HasPrefix(s.Log[len(s.Log)-1].Text, "run_command")
	})
	r.e.Close()

	var recovery []string
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			brief := req.Messages[0].Content[0].Text
			if len(req.Messages) == 1 && strings.Contains(brief, "[recovery]") {
				recovery = append(recovery, brief)
			}
			if len(req.Messages) == 1 && strings.Contains(brief, "[user_answer]") {
				return ownerCall("dispatch_step", map[string]any{"sub_id": sub.ID, "instructions": "接著做"}), nil
			}
			return autoOwner(req), nil
		}
		if stepOf(req) == "Clarify requirements" {
			heard = append(heard, told(req))
		}
		return worker(req), nil
	})
	newEngine(t, r)
	w = r.wait("the user asked", func(w *model.World) bool { return len(w.Tasks[task.ID].Coordination.Questions) > 0 })
	c := w.Tasks[task.ID].Coordination
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "ok", Action: "answer", QuestionID: c.Questions[0].ID, OptionID: "confirmStopped", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if len(heard) == 0 || heard[0] != 1 {
		t.Fatalf("read %v times", heard)
	}
	if len(recovery) == 0 || !strings.Contains(strings.Join(recovery, ""), "has not read 1 of your messages") {
		t.Fatalf("%q", recovery)
	}
	if undelivered(r.activity(task.ID)) {
		t.Fatal("said it was not delivered")
	}
}
