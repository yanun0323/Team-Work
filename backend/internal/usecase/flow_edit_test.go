package usecase_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// editedFlow is a task's flow as the user changes it on the edit sheet: a copy they can change freely.
func editedFlow(t *model.Task) *model.Workflow {
	wf := t.Workflow
	wf.Nodes = slices.Clone(wf.Nodes)
	wf.Edges = slices.Clone(wf.Edges)
	for i := range wf.Nodes {
		wf.Nodes[i].ReplicaIDs = slices.Clone(wf.Nodes[i].ReplicaIDs)
	}
	return &wf
}

func codeOf(err error) string {
	var e *model.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func withDocs(t *model.Task, staff string) *model.Workflow {
	wf := editedFlow(t)
	wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: "docs", Kind: enum.NodeWork, Name: "文件", Prompt: "write docs", ReplicaIDs: []string{staff},
		Handoff: enum.HandoffAll, Join: enum.JoinAll})
	wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: "e-docs", From: "end", To: "docs"})
	return wf
}

func editActivity(r *rig, taskID string) *model.TaskActivity {
	items := r.activity(taskID)
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Key == "editedByUser" {
			return &items[i]
		}
	}
	return nil
}

func TestUserChangesTheFlowOfATaskNotStarted(t *testing.T) {
	r := newRig(t, leading(worker))
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	flowName := task.Workflow.Name
	wf := withDocs(task, r.owner.ID)
	wf.Nodes[0].Prompt = "a new start"
	plan, control := versions(task)
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: wf, PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	w := r.world()
	got := w.Tasks[task.ID]
	if len(got.Workflow.Nodes) != 3 || got.Workflow.Nodes[2].ID != "docs" || got.Workflow.Nodes[0].Prompt != "a new start" {
		t.Fatalf("%+v", got.Workflow)
	}
	if got.Coordination.PlanVersion != 2 {
		t.Fatalf("plan version %d", got.Coordination.PlanVersion)
	}
	if got.WorkflowID != "" || got.Workflow.Name != flowName+"（自訂）" {
		t.Fatalf("still named as the blueprint: %q %q", got.WorkflowID, got.Workflow.Name)
	}
	shared := w.Workflows[r.flow.ID]
	if len(shared.Nodes) != 2 || len(shared.Edges) != 1 || shared.Nodes[0].Prompt == "a new start" {
		t.Fatalf("the shared flow changed: %+v", shared)
	}
	a := editActivity(r, task.ID)
	if a == nil || a.Args["added"] != "文件" || a.Args["changed"] != "整理需求" || a.Args["linked"] != "驗收 → 文件" || a.Args["removed"] != "" ||
		!strings.Contains(a.Text, "驗收 → 文件") {
		t.Fatalf("the change was not listed: %+v", a)
	}
	// a second change keeps the name it has, not one more （自訂）
	again := editedFlow(r.world().Tasks[task.ID])
	again.Nodes[2].Name = "寫文件"
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: again}); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tasks[task.ID]; got.Workflow.Name != flowName+"（自訂）" || got.Workflow.Nodes[2].Name != "寫文件" {
		t.Fatalf("%+v", got.Workflow)
	}
}

func TestAFlowTheUserBreaksIsRefusedAndChangesNothing(t *testing.T) {
	r := newRig(t, leading(worker))
	bob, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Bob", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(wf *model.Workflow){
		"迴圈": func(wf *model.Workflow) {
			wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: "back", From: "end", To: "start"})
		},
		"名稱": func(wf *model.Workflow) { wf.Nodes[1].Name = "  " },
		"只能有一位員工": func(wf *model.Workflow) {
			wf.Nodes[1].ReplicaIDs = []string{r.owner.ID, bob.ID}
		},
		"沒有指派員工": func(wf *model.Workflow) { wf.Nodes[1].ReplicaIDs = nil },
	}
	for want, breakIt := range cases {
		wf := editedFlow(task)
		breakIt(wf)
		err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: wf})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: %v", want, err)
		}
		got := r.world().Tasks[task.ID]
		if got.Coordination.PlanVersion != 1 || len(got.Workflow.Edges) != 1 || got.Workflow.Nodes[1].Name != "驗收" || len(got.Workflow.Nodes[1].ReplicaIDs) != 1 ||
			got.WorkflowID != r.flow.ID {
			t.Fatalf("%s changed the task: %+v", want, got.Workflow)
		}
	}
}

func TestAStepThatRanStaysAndARunUnderWayKeepsItsInstructions(t *testing.T) {
	release := make(chan struct{})
	held := make(chan struct{}, 1)
	r := newRig(t, nil)
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		select {
		case held <- struct{}{}: // the first step's run, as the second waits for it
			<-release
		default:
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	<-held
	w := r.world()
	plan, control := versions(w.Tasks[task.ID])
	// the user saw the task before the step ran: what they send is refused, the task stays as it is
	stale := 0
	gone := editedFlow(w.Tasks[task.ID])
	gone.Nodes, gone.Edges = gone.Nodes[1:], nil
	err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: gone, PlanVersion: plan, ControlVersion: control})
	if err == nil || !strings.Contains(err.Error(), "已執行過的步驟「整理需求」不能移除") || codeOf(err) != model.CodeConflict {
		t.Fatalf("a step that ran was removed: %v", err)
	}
	if got := r.world().Tasks[task.ID]; len(got.Workflow.Nodes) != 2 || got.Coordination.PlanVersion != *plan {
		t.Fatalf("%+v", got.Workflow)
	}
	stale = *plan - 1
	wf := editedFlow(w.Tasks[task.ID])
	wf.Nodes[1].Prompt = "check it the new way"
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: wf, PlanVersion: &stale, ControlVersion: control}); codeOf(err) != model.CodeConflict {
		t.Fatalf("an old view was taken: %v", err)
	}
	wf.Nodes[0].Prompt = "start the new way"
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: wf, PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	close(release)
	w = r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	// employees read the steps the app named in English
	starts, ends := 0, ""
	for _, req := range r.fake.requests() {
		switch {
		case isOwner(req):
		case stepOf(req) == "Clarify requirements":
			starts++
			if strings.Contains(req.System, "start the new way") {
				t.Fatal("the run under way was given the new instructions")
			}
		case stepOf(req) != "":
			ends = req.System
		}
	}
	if starts != 1 || !strings.Contains(ends, "check it the new way") {
		t.Fatalf("starts %d, end:\n%s", starts, ends)
	}
	if s := subAt(w, task.ID, "整理需求"); s == nil || s.Cancelled {
		t.Fatalf("the run under way was stopped: %+v", s)
	}
	woke := false
	for _, req := range ownerRequests(r) {
		woke = woke || strings.Contains(req.Messages[0].Content[0].Text, "The user changed the plan's steps or links")
	}
	if !woke {
		t.Fatal("the owner was not told of the change")
	}
}

func TestChangingTheFlowOfATaskWaitingToMergeTakesItBackToWork(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		reply := autoOwner(req)
		if reply.Content[0].Name == "submit_complete" {
			return ownerCall("submit_complete", map[string]any{"summary": "All done.", "ask_merge": true}), nil
		}
		return reply, nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the merge card", func(w *model.World) bool {
		t := w.Tasks[task.ID]
		return t.Stage == enum.StageAwaitMerge && slices.ContainsFunc(t.Coordination.Questions, func(q model.TaskQuestion) bool { return q.Kind == "merge" })
	})
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: withDocs(w.Tasks[task.ID], r.owner.ID)}); err != nil {
		t.Fatal(err)
	}
	got := r.world().Tasks[task.ID]
	if got.Stage != enum.StageRunning || slices.ContainsFunc(got.Coordination.Questions, func(q model.TaskQuestion) bool { return q.Kind == "merge" }) {
		t.Fatalf("still waiting to merge: %s %+v", got.Stage, got.Coordination.Questions)
	}
	r.wait("the new step done and back to merging", func(w *model.World) bool {
		s := subAt(w, task.ID, "文件")
		return w.Tasks[task.ID].Stage == enum.StageAwaitMerge && s != nil && s.Status == enum.StatusComplete
	})
}

func TestTheFlowOfAnEndedOrOldStyleTaskCannotChange(t *testing.T) {
	r := newRig(t, leading(worker))
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "取消", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.CancelTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: withDocs(task, r.owner.ID)}); err == nil || !strings.Contains(err.Error(), "不能修改流程") {
		t.Fatalf("a cancelled task's flow changed: %v", err)
	}
	old, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "舊制", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Legacy: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateTask(old.ID, usecase.TaskPatch{Workflow: withDocs(old, r.owner.ID)}); err == nil || !strings.Contains(err.Error(), "舊制任務不能修改流程") {
		t.Fatalf("an old-style task's flow changed: %v", err)
	}
	if got := r.world().Tasks[old.ID]; len(got.Workflow.Nodes) != 2 {
		t.Fatalf("%+v", got.Workflow)
	}
}

func TestChangingOnlyWhoWorksAStepKeepsTheBlueprint(t *testing.T) {
	r := newRig(t, leading(worker))
	bob, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Bob", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "換人", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	wf := editedFlow(task)
	wf.Nodes[1].ReplicaIDs = []string{bob.ID}
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Workflow: wf}); err != nil {
		t.Fatal(err)
	}
	got := r.world().Tasks[task.ID]
	if got.WorkflowID != r.flow.ID || got.Workflow.Name != task.Workflow.Name || got.Workflow.Nodes[1].ReplicaIDs[0] != bob.ID {
		t.Fatalf("%q %+v", got.WorkflowID, got.Workflow)
	}
	if a := editActivity(r, task.ID); a == nil || a.Args["restaffed"] != "驗收：Ada → Bob" || a.Args["what"] != "who works the steps" {
		t.Fatalf("%+v", a)
	}
}
