package usecase_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
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
	for _, want := range []string{"專案經理", "產品負責人", "設計師", "後端工程師", "前端工程師", "測試工程師"} {
		if names[want] == "" {
			t.Fatalf("no blueprint %s: %v", want, names)
		}
	}

	if !slices.Contains(w.Blueprints[names["設計師"]].Tools, enum.ToolRunCommand) {
		t.Fatal("the designer can't run commands")
	}

	flows := map[string]*model.Workflow{}
	for _, wf := range r.world().Workflows {
		if flows[wf.Name] != nil {
			t.Fatalf("two flows named %s", wf.Name)
		}
		flows[wf.Name] = wf
	}
	for _, want := range []string{"功能開發", "修 Bug", "產品規劃"} {
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
	if flows["預設任務流程"] != nil {
		t.Fatal("the plain default flow is back")
	}
}

func TestDeletedPresetStaysDeleted(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	for id, b := range r.world().Blueprints {
		if b.Name == "測試工程師" {
			if err := r.e.DeleteBlueprint(id); err != nil {
				t.Fatal(err)
			}
		}
	}
	r.e.Close()
	newEngine(t, r)
	for _, b := range r.world().Blueprints {
		if b.Name == "測試工程師" {
			t.Fatal("the preset came back")
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
	if r.world().Workflows[wf.ID] != nil {
		t.Fatal("the flow stayed")
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

func TestPresetsUseTheAgentFolders(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	found := 0
	for _, b := range r.world().Blueprints {
		if !slices.Contains([]string{"專案經理", "產品負責人", "設計師", "後端工程師", "前端工程師", "測試工程師"}, b.Name) {
			continue
		}
		found++
		var paths []string
		for _, p := range b.Skills {
			paths = append(paths, p.Source.Path)
			if p.Source.Kind != "local" || p.Include != nil {
				t.Fatalf("%s: %+v", b.Name, p)
			}
			if !strings.Contains(b.Source.Text, "- path: "+p.Source.Path+"\n") {
				t.Fatalf("%s's YAML leaves out %s:\n%s", b.Name, p.Source.Path, b.Source.Text)
			}
		}
		if !slices.Equal(paths, []string{"~/.agents/", "~/.codex/", "~/.claude/"}) {
			t.Fatalf("%s: %v", b.Name, paths)
		}
	}
	if found != 6 {
		t.Fatalf("%d presets", found)
	}
}

func TestRestartDoesNotRewritePresetEdits(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	var bp *model.Blueprint
	for _, b := range r.world().Blueprints {
		if b.Name == "專案經理" {
			bp = b
			break
		}
	}
	bp.Name, bp.Prompt = "PM", "my instructions"
	if err := r.e.SaveBlueprint(bp.ID, *bp); err != nil {
		t.Fatal(err)
	}
	wf := r.world().Workflows[r.flow.ID]
	wf.Nodes[0].Prompt = "讀懂任務，整理目標、範圍與驗收條件，交給下一個節點。"
	if err := r.e.SaveWorkflow(wf.ID, *wf); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Blueprints[bp.ID]; got.Name != "PM" || got.Prompt != "my instructions" {
		t.Fatal("restart rewrote blueprint")
	}
	if r.world().Workflows[wf.ID].Nodes[0].Prompt != wf.Nodes[0].Prompt {
		t.Fatal("restart rewrote node prompt")
	}
}

func TestCompatibleFallbackLevelsValidateReloadAndRun(t *testing.T) {
	var mu sync.Mutex
	var sent []string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		sent = append(sent, req.Effort)
		mu.Unlock()
		return call("submit_handoff", handoff), nil
	})
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake"}}
	r.fake.mu.Unlock()
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	for _, level := range []string{"none", "low", "medium", "high", "xhigh", "max", "default"} {
		if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &level}); err != nil {
			t.Fatalf("%s: %v", level, err)
		}
	}
	bad := "imaginary"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &bad}); err == nil {
		t.Fatal("accepted unknown level")
	}
	for _, level := range []string{"none", "max", "default"} {
		if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &level}); err != nil {
			t.Fatal(err)
		}
		if err := r.e.ReloadSettings(context.Background()); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		start := len(sent)
		mu.Unlock()
		task := r.task(r.flow.ID)
		r.wait("handoffs", stage(task.ID, enum.StageAwaitMerge))
		mu.Lock()
		want := level
		if level == "default" {
			want = ""
		}
		if len(sent) <= start {
			t.Error("no model request")
		}
		for _, got := range sent[start:] {
			if got != want {
				t.Errorf("%s sent %q", level, got)
			}
		}
		mu.Unlock()
	}
	// Metadata overrides the fallback, and refresh resets a now unsupported selection.
	max := "max"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &max}); err != nil {
		t.Fatal(err)
	}
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "fake", Thinking: []string{"low"}}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	if r.world().Replicas[r.owner.ID].Effort != "default" {
		t.Fatal("unsupported level was retained")
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &max}); err == nil {
		t.Fatal("fallback overrode reported levels")
	}
}
