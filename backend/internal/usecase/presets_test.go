package usecase_test

import (
	"context"
	"slices"
	"sync"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/usecase"
)

func TestPresets(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	w := r.world()
	names := map[string]string{}
	for id, b := range w.Blueprints {
		names[b.Name] = id
		if b.Source.Kind == "yaml" && b.Source.Text == "" {
			t.Fatalf("%s has no text", b.Name)
		}
	}
	for _, want := range []string{"PM", "Product", "Backend Engineer", "Frontend Engineer", "QA"} {
		if names[want] == "" {
			t.Fatalf("no blueprint %s: %v", want, names)
		}
	}

	team, err := r.e.CreateTeam(context.Background(), usecase.NewTeam{Name: "new", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	flows := map[string]*model.Workflow{}
	for _, wf := range r.world().Workflows {
		if flows[wf.Name] != nil {
			t.Fatalf("two flows named %s", wf.Name)
		}
		flows[wf.Name] = wf
	}
	for _, want := range []string{"預設任務流程", "功能開發", "修 Bug", "產品規劃"} {
		wf := flows[want]
		if wf == nil {
			t.Fatalf("no flow %s", want)
		}
		// saving runs the same checks as a flow drawn by hand
		if err := r.e.SaveWorkflow(wf.ID, *wf); err != nil {
			t.Fatalf("%s: %v", want, err)
		}
	}
	if len(flows["功能開發"].Edges) != 7 {
		t.Fatalf("%+v", flows["功能開發"].Edges)
	}
	if r.world().Teams[team.ID].DefaultWorkflowID != flows["預設任務流程"].ID {
		t.Fatal("the default flow changed")
	}
}

func TestDeletedPresetStaysDeleted(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	for id, b := range r.world().Blueprints {
		if b.Name == "QA" {
			if err := r.e.DeleteBlueprint(id); err != nil {
				t.Fatal(err)
			}
		}
	}
	r.e.Close()
	newEngine(t, r)
	for _, b := range r.world().Blueprints {
		if b.Name == "QA" {
			t.Fatal("QA came back")
		}
	}
}

func TestFlowsAreShared(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	ctx := context.Background()
	other, err := r.e.CreateTeam(ctx, usecase.NewTeam{Name: "other", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if other.DefaultWorkflowID != r.team.DefaultWorkflowID {
		t.Fatal("two companies should start on the same flow")
	}
	// someone from another company in a flow doesn't come along into this company's task
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	wf := *r.flow
	wf.Nodes = append([]model.WorkflowNode{}, wf.Nodes...)
	wf.Nodes[1].ReplicaIDs = []string{bo.ID}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	task := r.task(wf.ID)
	for _, n := range task.Workflow.Nodes {
		if slices.Contains(n.ReplicaIDs, bo.ID) {
			t.Fatal("staff from another company came along")
		}
	}
	// the flow outlives a company, and companies on it move on when it goes
	if err := r.e.DeleteTeam(other.ID); err != nil {
		t.Fatal(err)
	}
	if r.world().Workflows[wf.ID] == nil {
		t.Fatal("the flow went with the company")
	}
	if err := r.e.DeleteWorkflow(wf.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Teams[r.team.ID].DefaultWorkflowID; got == wf.ID || r.world().Workflows[got] == nil {
		t.Fatalf("default is %s", got)
	}
}

func TestThinkingLevelsComeFromTheProvider(t *testing.T) {
	var mu sync.Mutex
	var sent []string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, req.Effort)
		return call("submit_handoff", handoff), nil
	})
	if got := r.owner.Effort; got != model.ThinkingDefault {
		t.Fatalf("a new employee starts on %q", got)
	}
	bad, good := "max", "high"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &bad}); err == nil {
		t.Fatal("took a level the model does not report")
	}
	// the default sends no level
	r.task(r.flow.ID)
	r.wait("the employee to start", func(*model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return len(sent) > 0
	})
	mu.Lock()
	if sent[0] != "" {
		t.Fatalf("%q", sent[0])
	}
	mu.Unlock()
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &good}); err != nil {
		t.Fatal(err)
	}
	// a level that goes away falls back on the default
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake", Thinking: []string{"low"}}}
	r.fake.mu.Unlock()
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Replicas[r.owner.ID].Effort; got != model.ThinkingDefault {
		t.Fatalf("%q", got)
	}
}
