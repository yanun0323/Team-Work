package usecase_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// woken says whether the owner's decision began with what the user wrote starting with text.
func woken(req model.ModelRequest, text string) bool {
	return len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "): "+text)
}

func lastBlock(req model.ModelRequest) model.Block {
	return req.Messages[len(req.Messages)-1].Content[0]
}

func (r *rig) ownerIdle(taskID string) *model.World {
	r.t.Helper()
	return r.wait("owner idle", func(w *model.World) bool { return w.Tasks[taskID].Coordination.OwnerState == model.OwnerIdle })
}

func (r *rig) tell(taskID, requestID, text string) {
	r.t.Helper()
	if _, err := r.e.SayToOwner(taskID, usecase.TaskMessage{RequestID: requestID, Text: text}); err != nil {
		r.t.Fatal(err)
	}
}

func TestOwnerCreatesATaskTheUserAskedFor(t *testing.T) {
	var flowID string
	var result model.Block
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		switch {
		case woken(req, "把那個問題另外開一個任務"):
			return ownerCall("create_task", map[string]any{"title": "修 Esc", "description": "選單按 Esc 會關掉整頁", "workflow_id": flowID}), nil
		case lastBlock(req).Name == "create_task":
			result = lastBlock(req)
			return say("開好了"), nil
		}
		return autoOwner(req), nil
	})
	flowID = r.flow.ID
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.ownerIdle(task.ID)
	r.tell(task.ID, "req-1", "把那個問題另外開一個任務")
	w := r.wait("the new task", func(w *model.World) bool {
		return slices.ContainsFunc(mapValues(w.Tasks), func(x *model.Task) bool { return x.Title == "修 Esc" })
	})
	r.ownerIdle(task.ID)
	var made *model.Task
	for _, x := range w.Tasks {
		if x.Title == "修 Esc" {
			made = x
		}
	}
	if made.TeamID != r.team.ID || !made.Paused || made.OwnerID == nil || *made.OwnerID != r.owner.ID {
		t.Fatalf("not waiting in to-do in the company, led by the owner: %+v", made)
	}
	if o := made.Origin; o == nil || o.Kind != "employee" || o.ID != r.owner.ID || o.Name != r.owner.Name || o.Depth != 1 {
		t.Fatalf("%+v", made.Origin)
	}
	if result.IsError || !strings.Contains(result.Text, made.ID) {
		t.Fatalf("%+v", result)
	}
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool {
		return a.Key == "taskCreated" && a.Args["taskId"] == made.ID && a.Args["title"] == "修 Esc" &&
			fmt.Sprint(a.Args["number"]) == fmt.Sprint(made.Number) && a.Args["owner"] == r.owner.Name
	}) {
		t.Fatalf("no line in the conversation: %+v", r.activity(task.ID))
	}
}

func TestOwnerCannotCreateATaskBeyondTheChainLimit(t *testing.T) {
	var flowID string
	var result model.Block
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		switch {
		case woken(req, "再開一個"):
			return ownerCall("create_task", map[string]any{"title": "太多層", "workflow_id": flowID}), nil
		case lastBlock(req).Name == "create_task":
			result = lastBlock(req)
			return say("不行"), nil
		}
		return say("待命"), nil
	})
	flowID = r.flow.ID
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "第三層", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID,
		Origin: &model.TaskOrigin{Kind: "employee", ID: r.owner.ID, Name: r.owner.Name, Depth: 3}})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.ownerIdle(task.ID)
	r.tell(task.ID, "req-1", "再開一個")
	r.wait("refused", func(*model.World) bool { return result.Name != "" })
	if !result.IsError || !strings.Contains(result.Text, "limit is 3") {
		t.Fatalf("%+v", result)
	}
	for _, x := range r.world().Tasks {
		if x.Title == "太多層" {
			t.Fatal("made beyond the limit")
		}
	}
}

func TestUserMergesFromTheOwnersCardAndHearsTheReportOnce(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		switch {
		case woken(req, "合併"):
			return ownerCall("submit_complete", map[string]any{"summary": "做完了，可以合併", "ask_merge": true}), nil
		case lastBlock(req).Name == "submit_complete" && !lastBlock(req).IsError:
			return say("做完了，可以合併（又說一次）"), nil
		}
		return autoOwner(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.ownerIdle(task.ID)
	card := func() *model.TaskQuestion {
		for _, q := range r.world().Tasks[task.ID].Coordination.Questions {
			if q.Kind == "merge" {
				return &q
			}
		}
		return nil
	}
	ask := func(requestID, text string) model.TaskQuestion {
		t.Helper()
		r.tell(task.ID, requestID, text)
		r.wait("the card", func(*model.World) bool { return card() != nil })
		r.ownerIdle(task.ID)
		q := card()
		if q.Audience != "user" || len(q.Options) != 2 || q.Options[0].ID != "merge" || q.Options[1].ID != "notYet" || q.ActivityID == "" {
			t.Fatalf("%+v", q)
		}
		if r.world().Tasks[task.ID].Stage != enum.StageAwaitMerge {
			t.Fatal("the card does not wait to be merged")
		}
		return *q
	}
	answer := func(requestID string, q model.TaskQuestion, option string) error {
		plan, control := versions(r.world().Tasks[task.ID])
		_, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: requestID, Action: "answer", QuestionID: q.ID, OptionID: option, PlanVersion: plan, ControlVersion: control})
		return err
	}

	// the report is posted once, though the owner said it again as its turn ended
	ask("req-1", "合併吧")
	reports := 0
	for _, a := range r.activity(task.ID) {
		if a.By == r.owner.ID && strings.HasPrefix(a.Text, "做完了，可以合併") {
			reports++
		}
	}
	if reports != 1 {
		t.Fatalf("reported %d times: %+v", reports, r.activity(task.ID))
	}

	// writing again takes the task back to work, and the card with it
	r.tell(task.ID, "req-2", "等等")
	if card() != nil {
		t.Fatal("the card stayed while the task went back to work")
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	r.ownerIdle(task.ID)

	// not yet: it keeps waiting, and the owner hears so
	q := ask("req-3", "合併好了")
	if err := answer("req-4", q, "notYet"); err != nil {
		t.Fatal(err)
	}
	r.ownerIdle(task.ID)
	if w := r.world(); w.Tasks[task.ID].Stage != enum.StageAwaitMerge || card() != nil {
		t.Fatalf("%s %+v", w.Tasks[task.ID].Stage, card())
	}
	heard := slices.ContainsFunc(ownerRequests(r), func(req model.ModelRequest) bool {
		return strings.Contains(req.Messages[0].Content[0].Text, "先不要")
	})
	if !heard {
		t.Fatal("the owner did not hear the user said not yet")
	}

	// merge: the user's press merges it
	q = ask("req-5", "合併！")
	if err := answer("req-6", q, "merge"); err != nil {
		t.Fatal(err)
	}
	r.wait("done", stage(task.ID, enum.StageDone))
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.From == "user" && a.QuestionID == q.ID && a.Text == "合併" }) {
		t.Fatal("the answer is not in the conversation")
	}
}

func mapValues[K comparable, V any](m map[K]V) []V {
	out := make([]V, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}
