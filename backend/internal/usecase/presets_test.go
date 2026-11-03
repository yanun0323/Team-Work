package usecase_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func presetFlowOf(t *testing.T, w *model.World, id string) *model.Workflow {
	t.Helper()
	wf := w.Workflows[id]
	if wf == nil {
		t.Fatalf("no flow %s", id)
	}
	return wf
}

func TestPresets(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	w := r.world()
	names := map[string]string{}
	for id, b := range w.Blueprints {
		if model.IsPresetID(id) {
			names[b.Name] = id
			if b.Source.Kind != model.SourcePreset {
				t.Fatalf("%s: %+v", b.Name, b.Source)
			}
		}
	}
	for _, want := range []string{"專案經理", "產品負責人", "設計師", "後端工程師", "前端工程師", "全端工程師", "測試工程師", "研究員", "程式審查員", "技術架構師", "資安工程師", "DevOps 工程師", "技術文件寫手", "資料分析師", "行銷文案", "特助"} {
		if names[want] == "" {
			t.Fatalf("no blueprint %s: %v", want, names)
		}
	}
	if !slices.Contains(w.Blueprints[names["設計師"]].Tools, enum.ToolRunCommand) {
		t.Fatal("the designer can't run commands")
	}
	for _, tool := range []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch, enum.ToolRunCommand} {
		for _, name := range []string{"特助", "全端工程師"} {
			if !slices.Contains(w.Blueprints[names[name]].Tools, tool) {
				t.Fatalf("%s lacks %s", name, tool)
			}
		}
	}
	feature := presetFlowOf(t, w, "preset-feature")
	if feature.Name != "功能開發" || len(feature.Edges) != 6 {
		t.Fatalf("%+v", feature)
	}
	small := presetFlowOf(t, w, "preset-small")
	if small.Name != "小功能" || len(small.Nodes) != 4 || len(small.Edges) != 3 {
		t.Fatalf("%+v", small)
	}
	for _, id := range []string{"preset-feature", "preset-small", "preset-bugfix", "preset-planning", "preset-review", "preset-refactor"} {
		// a copy goes through the same checks as a flow drawn by hand
		c, err := r.e.DuplicateWorkflow(id)
		if err != nil {
			t.Fatal(err)
		}
		if err := r.e.SaveWorkflow(c.ID, *c); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
}

func TestPresetsCannotChangeButCanBeCopied(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	w := r.world()
	bp, wf := *w.Blueprints["preset-pm"], *presetFlowOf(t, w, "preset-feature")
	for what, err := range map[string]error{
		"save blueprint":   r.e.SaveBlueprint(bp.ID, bp),
		"delete blueprint": r.e.DeleteBlueprint(bp.ID),
		"save flow":        r.e.SaveWorkflow(wf.ID, wf),
		"delete flow":      r.e.DeleteWorkflow(wf.ID),
	} {
		if err == nil {
			t.Errorf("%s went through", what)
		}
	}
	if _, err := r.e.CreateBlueprint(bp); err == nil {
		t.Error("made a blueprint that says it is built in")
	}
	// a copy takes what is shown, is the user's own, and does not change with the language
	c, err := r.e.DuplicateWorkflow(wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if model.IsPresetID(c.ID) || c.Name != "功能開發-1" {
		t.Fatalf("%s %s", c.ID, c.Name)
	}
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	w = r.world()
	if got := w.Workflows[c.ID]; got.Name != "功能開發-1" || got.Nodes[2].Name != "撰寫規格" || got.Nodes[0].Name != "Clarify requirements" {
		t.Fatalf("%s %+v", got.Name, got.Nodes[:3])
	}
	if got := presetFlowOf(t, w, wf.ID); got.Name != "Feature development" || got.Nodes[2].Name != "Write spec" {
		t.Fatalf("%+v", got)
	}
	if got := w.Blueprints[bp.ID]; got.Name != "Project Manager" || strings.Contains(got.Prompt, "你是") {
		t.Fatalf("%+v", got)
	}
	// the files hold only what the user made, and a restart brings the built-in ones back in the language picked
	r.e.Close()
	newEngine(t, r)
	w = r.world()
	if w.Blueprints[bp.ID].Name != "Project Manager" || w.Workflows[wf.ID].Name != "Feature development" {
		t.Fatal("restart lost the presets")
	}
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.world().Workflows[wf.ID] == nil || r.world().Blueprints[bp.ID] == nil {
		t.Fatal("reload lost the presets")
	}
}

// Whatever the user sees, employees are told a built-in blueprint and flow in English, with the language to reply in.
func TestEmployeesAreToldPresetsInEnglish(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	pm, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: "preset-pm", Name: "Pam", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", WorkflowID: "preset-bugfix", OwnerID: &pm.ID,
		Staff: map[string][]string{"preset-bugfix-0-0": {pm.ID}, "preset-bugfix-1-0": {pm.ID}, "preset-bugfix-2-0": {pm.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	if task.Workflow.Nodes[2].Name != "重現問題" {
		t.Fatalf("the task shows %q", task.Workflow.Nodes[2].Name)
	}
	r.wait("the second step", func(*model.World) bool { return len(r.fake.requests()) > 1 })
	got := r.fake.requests()[1]
	for _, want := range []string{"company's project manager", "# This step: Reproduce", "user reads in Traditional Chinese", "- Clarify requirements: "} {
		if !strings.Contains(got.System, want) {
			t.Errorf("no %q in:\n%s", want, got.System)
		}
	}
	if strings.Contains(got.System, "專案經理") || strings.Contains(got.System, "重現問題") {
		t.Errorf("Chinese in:\n%s", got.System)
	}
	if !strings.Contains(got.Messages[0].Content[0].Text, `Handoff from "Clarify requirements"`) {
		t.Errorf("%s", got.Messages[0].Content[0].Text)
	}
	// a task under way shows the new language too
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tasks[task.ID].Workflow.Nodes[2].Name; got != "Reproduce" {
		t.Fatalf("%q", got)
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
	for id, b := range r.world().Blueprints {
		if !model.IsPresetID(id) {
			continue
		}
		found++
		var paths []string
		for _, p := range b.Skills {
			paths = append(paths, p.Source.Path)
			if p.Source.Kind != "local" || p.Include != nil {
				t.Fatalf("%s: %+v", b.Name, p)
			}
		}
		if !slices.Equal(paths, []string{"~/.agents/", "~/.mho/", "~/.codex/", "~/.claude/"}) {
			t.Fatalf("%s: %v", b.Name, paths)
		}
	}
	if found != 16 {
		t.Fatalf("%d presets", found)
	}
}

func TestRestartKeepsTheUsersOwn(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	bp := r.world().Blueprints[r.owner.BlueprintID]
	bp.Name, bp.Prompt = "PM", "my instructions"
	if err := r.e.SaveBlueprint(bp.ID, *bp); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Blueprints[bp.ID]; got.Name != "PM" || got.Prompt != "my instructions" {
		t.Fatal("restart rewrote blueprint")
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
