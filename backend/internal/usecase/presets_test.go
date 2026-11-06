package usecase_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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

// The blueprints and flows the app comes with are the official source's, there from the first start without the
// network: the built-in copy is read.
func TestPresets(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	w := r.world()
	if s := w.Sources[usecase.OfficialSourceID]; s == nil || s.Kind != "git" || s.Repo != "https://github.com/yanun0323/Team-Work-Source" || !s.AutoApply || s.Commit == "" {
		t.Fatalf("official source %+v", s)
	}
	names := map[string]string{}
	for id, b := range w.Blueprints {
		if model.SourceOfID(id) == usecase.OfficialSourceID {
			names[b.Name] = id
			if b.Source.Kind != "yaml" || !model.IsLockedID(id) {
				t.Fatalf("%s: %+v", b.Name, b.Source)
			}
		}
	}
	for _, want := range []string{"技術規劃", "產品規劃", "設計師", "後端工程師", "前端工程師", "測試工程師", "研究員", "程式審查員", "DevOps 工程師", "寫手", "通才", "Matt Pocock", "Poteto"} {
		if names[want] == "" {
			t.Fatalf("no blueprint %s: %v", want, names)
		}
	}
	if len(names) != 13 || w.Blueprints["preset-airport"] == nil {
		t.Fatalf("%v", names)
	}
	if !slices.Contains(w.Blueprints[names["設計師"]].Tools, enum.ToolRunCommand) {
		t.Fatal("the designer can't run commands")
	}
	for _, tool := range []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch, enum.ToolRunCommand} {
		for _, name := range []string{"通才"} {
			if !slices.Contains(w.Blueprints[names[name]].Tools, tool) {
				t.Fatalf("%s lacks %s", name, tool)
			}
		}
	}
	feature := presetFlowOf(t, w, "team-work--feature")
	if feature.Name != "功能開發" || len(feature.Nodes) != 3 || len(feature.Edges) != 2 {
		t.Fatalf("%+v", feature)
	}
	small := presetFlowOf(t, w, "team-work--small")
	if small.Name != "一般任務" || len(small.Nodes) != 1 || len(small.Edges) != 0 {
		t.Fatalf("%+v", small)
	}
	// a flow of one step still sends its edges as a list: the screens iterate it, and null breaks them
	if raw, err := json.Marshal(small); err != nil || !strings.Contains(string(raw), `"edges":[]`) {
		t.Fatalf("%s %v", raw, err)
	}
	bugfix := presetFlowOf(t, w, "team-work--bugfix")
	// a built-in flow starts with its first step, and only a last step fed by one step alone may send work back
	if n := bugfix.Nodes[1]; n.SendBack == nil || !*n.SendBack || bugfix.Nodes[0].SendBack != nil {
		t.Fatalf("%+v", bugfix.Nodes)
	}
	for _, n := range feature.Nodes[1:] {
		if n.SendBack == nil || *n.SendBack {
			t.Fatalf("%+v", n)
		}
	}
	for _, id := range []string{"team-work--small", "team-work--bugfix", "team-work--feature", "team-work--review"} {
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
	bp, wf := *w.Blueprints["team-work--architect"], *presetFlowOf(t, w, "team-work--feature")
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
	if _, err := r.e.CreateBlueprint(*w.Blueprints["preset-airport"]); err == nil {
		t.Error("made a blueprint that says it is built in")
	}
	// a copy takes what is shown, is the user's own, and does not change with the language
	c, err := r.e.DuplicateWorkflow(wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if model.IsLockedID(c.ID) || c.Name != "功能開發-1" {
		t.Fatalf("%s %s", c.ID, c.Name)
	}
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	w = r.world()
	if got := w.Workflows[c.ID]; got.Name != "功能開發-1" || got.Nodes[0].Name != "撰寫規格" {
		t.Fatalf("%s %+v", got.Name, got.Nodes[:1])
	}
	if got := presetFlowOf(t, w, wf.ID); got.Name != "Feature development" || got.Nodes[0].Name != "Write spec" {
		t.Fatalf("%+v", got)
	}
	if got := w.Blueprints[bp.ID]; got.Name != "Technical Planner" || strings.Contains(got.Prompt, "你是") {
		t.Fatalf("%+v", got)
	}
	// the files hold only what the user made, and a restart brings the built-in ones back in the language picked
	r.e.Close()
	newEngine(t, r)
	w = r.world()
	if w.Blueprints[bp.ID].Name != "Technical Planner" || w.Workflows[wf.ID].Name != "Feature development" {
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
	pm, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: "team-work--architect", Name: "Pam", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task := r.start(r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", WorkflowID: "team-work--bugfix", OwnerID: &pm.ID,
		Staff: map[string][]string{"reproduce": {pm.ID}, "fix": {pm.ID}}}))
	if task.Workflow.Nodes[0].Name != "重現問題" {
		t.Fatalf("the task shows %q", task.Workflow.Nodes[0].Name)
	}
	r.wait("the second step", func(*model.World) bool { return len(r.fake.requests()) > 1 })
	got := r.fake.requests()[1]
	for _, want := range []string{"company's technical planner", "# This step: Fix", "user reads in Traditional Chinese", "- Reproduce: "} {
		if !strings.Contains(got.System, want) {
			t.Errorf("no %q in:\n%s", want, got.System)
		}
	}
	if strings.Contains(got.System, "技術規劃") || strings.Contains(got.System, "修正") {
		t.Errorf("Chinese in:\n%s", got.System)
	}
	if !strings.Contains(got.Messages[0].Content[0].Text, `Handoff from "Reproduce"`) {
		t.Errorf("%s", got.Messages[0].Content[0].Text)
	}
	// a task under way shows the new language too
	if err := r.e.SetLanguage(model.LanguageEn); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tasks[task.ID].Workflow.Nodes[0].Name; got != "Reproduce" {
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
	if _, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: wf.ID}); err == nil {
		t.Fatal("a step with only someone from another company was staffed")
	}
	task := r.start(r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: wf.ID, Staff: map[string][]string{wf.Nodes[1].ID: {r.owner.ID}}}))
	for _, n := range task.Workflow.Nodes {
		if slices.Contains(n.ReplicaIDs, bo.ID) {
			t.Fatal("staff from another company came along")
		}
	}
	// the flow outlives a company, and companies on it move on when it goes
	if err := r.e.DeleteTeam(other.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Workflows[wf.ID]; got == nil || slices.Contains(got.Nodes[1].ReplicaIDs, bo.ID) {
		t.Fatal("the flow went with the company, or kept its people")
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
	w := r.world()
	found := 0
	for id, b := range w.Blueprints {
		if model.SourceOfID(id) != usecase.OfficialSourceID || id == "team-work--matt-pocock" || id == "team-work--poteto" {
			continue // these read their skills from GitHub
		}
		found++
		var paths []string
		for _, p := range b.Skills {
			s := w.Sources[p.SourceID]
			if s == nil || s.Kind != "local" || p.Include != nil {
				t.Fatalf("%s: %+v %+v", b.Name, p, s)
			}
			paths = append(paths, s.Path)
		}
		if !slices.Equal(paths, []string{"~/.agents/", "~/.team-work/", "~/.codex/", "~/.claude/"}) {
			t.Fatalf("%s: %v", b.Name, paths)
		}
	}
	if found != 11 {
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

// The Codex and Claude switches leave out the skills in those folders for every blueprint: the official source's,
// the user's own, and the airport staff's.
func TestPresetSkillFoldersFollowPreferences(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	home, _ := os.UserHomeDir()
	for _, dir := range []string{".agents", ".codex", ".claude"} {
		raw := []byte("---\nname: from-" + dir[1:] + "\ndescription: d\n---\n")
		if err := os.MkdirAll(filepath.Join(home, dir, "skills", "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, dir, "skills", "x", "SKILL.md"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, dir := range []string{".agents", ".codex", ".claude"} {
			os.RemoveAll(filepath.Join(home, dir))
		}
	})
	mine, err := r.e.CreateBlueprint(model.Blueprint{Name: "Mine", Skills: []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: "~/.codex/"}}}})
	if err != nil {
		t.Fatal(err)
	}
	read := func(id string) []string {
		t.Helper()
		packs, err := r.e.BlueprintSkills(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, names := range packs {
			out = append(out, names...)
		}
		return out
	}
	if got := read("team-work--architect"); !slices.Equal(got, []string{"from-agents", "from-codex", "from-claude"}) {
		t.Fatalf("default skills: %v", got)
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codexSkills": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	if got := read("team-work--architect"); !slices.Equal(got, []string{"from-agents", "from-claude"}) {
		t.Fatalf("without Codex: %v", got)
	}
	if got := read(mine.ID); len(got) != 0 {
		t.Fatalf("the user's own blueprint without Codex: %v", got)
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"codexSkills": json.RawMessage(`true`), "claudeSkills": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	if got := read("team-work--architect"); !slices.Equal(got, []string{"from-agents", "from-codex"}) {
		t.Fatalf("without Claude: %v", got)
	}
	if got := read("preset-airport"); slices.Contains(got, "from-claude") || !slices.Contains(got, "from-codex") {
		t.Fatalf("the airport staff without Claude: %v", got)
	}
	// the packs stay listed in their places
	if n := len(r.world().Blueprints["team-work--architect"].Skills); n != 4 {
		t.Fatalf("%d packs", n)
	}
}

func TestPresetsFromGitHubKeepTheirReposAsSources(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	want := map[string][2]string{
		"team-work--matt-pocock": {"https://github.com/mattpocock/skills", ""},
		"team-work--poteto":      {"https://github.com/cursor/plugins", "pstack"},
	}
	check := func() map[string]string {
		t.Helper()
		w := r.world()
		ids := map[string]string{}
		for id, repo := range want {
			b := w.Blueprints[id]
			if b == nil || len(b.Skills) != 1 {
				t.Fatalf("%s: %+v", id, b)
			}
			p := b.Skills[0]
			s := w.Sources[p.SourceID]
			if s == nil || s.Kind != "git" || s.Repo != repo[0] || s.Ref != "main" || p.Path != repo[1] || p.Include != nil {
				t.Fatalf("%s: %+v %+v", id, p, s)
			}
			ids[id] = s.ID
		}
		return ids
	}
	before := check()
	// the blueprint reads it, so it stays
	if err := r.e.DeleteSource(before["team-work--poteto"]); err == nil {
		t.Fatal("deleted a built-in blueprint's source")
	}
	// kept in the settings, so a restart finds the same one instead of adding another
	r.e.Close()
	newEngine(t, r)
	if after := check(); after["team-work--matt-pocock"] != before["team-work--matt-pocock"] || after["team-work--poteto"] != before["team-work--poteto"] {
		t.Fatalf("%v, then %v", before, after)
	}
}
