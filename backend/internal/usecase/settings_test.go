package usecase_test

import (
	"context"
	"encoding/json"
	"go.yaml.in/yaml/v3"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func readSettings(t *testing.T, r *rig) model.Settings {
	t.Helper()
	snapshot, err := r.store.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var s model.Settings
	if err := json.Unmarshal(snapshot.Data, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func writeSettings(t *testing.T, r *rig, s model.Settings) {
	t.Helper()
	files := map[string]any{"provider.json": s.Providers, "preferences.yaml": s.Preferences}
	for id, v := range s.Teams {
		files["company/"+id+"/config.yaml"] = v
	}
	for id, v := range s.Replicas {
		files["company/"+v.TeamID+"/employee/"+id+".json"] = v
	}
	for id, v := range s.Blueprints {
		files["blueprints/"+id+".yaml"] = v
	}
	for id, v := range s.Workflows {
		files["workflows/"+id+".yaml"] = v
	}
	snapshot, err := r.store.LoadSettings(context.Background())
	// Invalid files from a prior validation test are replaced below.
	if err == nil {
		for path := range snapshot.Files {
			if _, ok := files[path]; !ok {
				if err := os.Remove(filepath.Join(r.data, path)); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	for rel, v := range files {
		raw, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(rel, ".yaml") {
			var value any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatal(err)
			}
			raw, err = yaml.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
		}
		path := filepath.Join(r.data, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSettingsFilesRoundTripAndRuntimeSeparation(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	memory := []model.MemoryEntry{{ID: "mem", Text: "keep this", Source: "user"}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	s := readSettings(t, r)
	team := s.Teams[r.team.ID]
	team.Name = "手改公司"
	s.Teams[r.team.ID] = team
	rep := s.Replicas[r.owner.ID]
	rep.Effort = "high"
	s.Replicas[r.owner.ID] = rep
	s.Blueprints[r.owner.BlueprintID].Prompt = "手改角色"
	writeSettings(t, r, s)
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	check := func() {
		w := r.world()
		if w.Teams[r.team.ID].Name != "手改公司" || w.Replicas[r.owner.ID].Effort != "high" || w.Blueprints[r.owner.BlueprintID].Prompt != "手改角色" {
			t.Fatal("settings were not installed")
		}
		if got := w.Replicas[r.owner.ID].Memory; len(got) != 1 || got[0].Text != "keep this" {
			t.Fatalf("memory lost: %v", got)
		}
	}
	check()
	docs, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if strings.Contains(string(d.Data), "手改公司") || strings.Contains(string(d.Data), "手改角色") {
			t.Fatalf("configuration in SQLite: %s", d.Kind)
		}
	}
	snapshot, err := r.store.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	raw := snapshot.Data
	for _, forbidden := range []string{"keep this", "sk-secret-1234", "keyHint", "signedIn", "hiredAt", "createdAt"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("runtime or secret in settings: %s", forbidden)
		}
	}
	r.e.Close()
	newEngine(t, r)
	check()
	name := "介面修改"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if readSettings(t, r).Replicas[r.owner.ID].Name != name {
		t.Fatal("UI write did not reach JSON")
	}
}

func TestSettingsConflictDoesNotBlockMemoryWrites(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	s := readSettings(t, r)
	original := s.Teams[r.team.ID].Name
	team := s.Teams[r.team.ID]
	team.Name = "external"
	s.Teams[r.team.ID] = team
	writeSettings(t, r, s)
	name := "UI"
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Name: &name}); err == nil || !strings.Contains(err.Error(), "外部修改") {
		t.Fatalf("expected conflict: %v", err)
	}
	if r.world().Teams[r.team.ID].Name != original || readSettings(t, r).Teams[r.team.ID].Name != "external" {
		t.Fatal("conflict overwrote a change")
	}
	memory := []model.MemoryEntry{{ID: "during-edit", Text: "still persisted"}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	if readSettings(t, r).Teams[r.team.ID].Name != "external" {
		t.Fatal("memory write overwrote JSON")
	}
	if len(r.world().Replicas[r.owner.ID].Memory) != 1 {
		t.Fatal("memory write was blocked")
	}
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsValidationIsAtomic(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	for _, tc := range []struct {
		name, field string
		edit        func(*model.Settings)
	}{
		{"delete company", "company/", func(s *model.Settings) { delete(s.Teams, r.team.ID) }},
		{"cycle", "workflows", func(s *model.Settings) {
			w := s.Workflows[r.flow.ID]
			w.Edges = append(w.Edges, model.WorkflowEdge{ID: "cycle", From: w.Nodes[1].ID, To: w.Nodes[0].ID})
		}},
		{"negative", "settings", func(s *model.Settings) { t := s.Teams[r.team.ID]; t.Settings.Retries = -1; s.Teams[t.ID] = t }},
		{"null blueprint", "blueprints", func(s *model.Settings) { s.Blueprints[r.owner.BlueprintID] = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := model.SettingsOf(r.world())
			team := s.Teams[r.team.ID]
			team.Name = "must not apply"
			s.Teams[r.team.ID] = team
			tc.edit(&s)
			writeSettings(t, r, s)
			if err := r.e.ReloadSettings(context.Background()); err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("%s: %v", tc.field, err)
			}
			if r.world().Teams[r.team.ID].Name != r.team.Name {
				t.Fatal("partial reload")
			}
		})
	}
	path := filepath.Join(r.data, "provider.json")
	for _, raw := range []string{`{`, `{"version":1,"apiKey":"not allowed"}`, `null`, `{ "version": 1 } {}`} {
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := r.e.ReloadSettings(context.Background()); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestMissingSettingsFailClosed(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	r.e.Close()
	if err := os.Remove(filepath.Join(r.data, "provider.json")); err != nil {
		t.Fatal(err)
	}
	store, err := repository.NewStore(r.data)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: repository.NewGit(r.data), Providers: r.fake, DataDir: r.data, Log: zerolog.Nop()})
	if err == nil || !strings.Contains(err.Error(), "遺失") {
		t.Fatalf("missing file recovered from stale SQLite data: %v", err)
	}
}

func TestReloadKeepsTaskSnapshotAndConversation(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		return call("ask_user", map[string]any{"prompt": "wait", "options": []string{"ok"}}), nil
	})
	task := r.task(r.flow.ID)
	r.wait("review", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Status == "review"
	})
	before := r.world().Tasks[task.ID].Workflow
	docsBefore, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s := readSettings(t, r)
	s.Workflows[r.flow.ID].Name = "new name"
	writeSettings(t, r, s)
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	after := r.world().Tasks[task.ID].Workflow
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Fatal("reload altered task workflow snapshot")
	}
	docsAfter, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, old := range docsBefore {
		if old.Kind != "conv" {
			continue
		}
		found := false
		for _, now := range docsAfter {
			if now.Kind == old.Kind && now.ID == old.ID {
				found = true
				if string(now.Data) != string(old.Data) {
					t.Fatal("reload changed conversation")
				}
			}
		}
		if !found {
			t.Fatal("reload deleted conversation")
		}
	}
	if r.world().Workflows[r.flow.ID].Name != "new name" {
		t.Fatal("shared workflow not updated")
	}
}

func TestImportYAMLAndKeepEditsAcrossRestart(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	s := readSettings(t, r)
	b := *s.Blueprints[r.owner.BlueprintID]
	b.ID, b.Name, b.Prompt = "bp-imported", "Imported", "custom prompt"
	s.Blueprints[b.ID] = &b
	w := *s.Workflows[r.flow.ID]
	w.ID, w.Name = "wf-imported", "Imported flow"
	s.Workflows[w.ID] = &w
	writeSettings(t, r, s)
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.world().Blueprints[b.ID] == nil || r.world().Workflows[w.ID] == nil {
		t.Fatal("YAML not imported")
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Blueprints[b.ID]; got == nil || got.Prompt != "custom prompt" {
		t.Fatal("restart changed import")
	}
	if _, err := os.Stat(filepath.Join(r.data, "company", r.team.ID, "config.yaml")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r.data, "company", r.team.ID, "employee", r.owner.ID+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r.data, "config", "settings.json")); !os.IsNotExist(err) {
		t.Fatal("combined settings file exists")
	}
}

// An employee whose blueprint is gone (one built in once, one a source no longer brings, one written by hand) stops
// nothing from loading: they are kept as they are, and a step they work asks the user to pick another blueprint.
func TestAnEmployeeWhoseBlueprintIsGoneWaitsForAnother(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	own := r.owner.BlueprintID
	s := readSettings(t, r)
	rep := s.Replicas[r.owner.ID]
	rep.BlueprintID = "preset-assistant"
	s.Replicas[rep.ID] = rep
	delete(s.Sources, usecase.OfficialSourceID) // as settings from before there was one
	writeSettings(t, r, s)
	r.e.Close()
	newEngine(t, r)
	w := r.world()
	if got := w.Replicas[r.owner.ID].BlueprintID; got != "preset-assistant" || w.Blueprints[got] != nil {
		t.Fatalf("blueprint %s", got)
	}
	if w.Sources[usecase.OfficialSourceID] == nil {
		t.Fatal("no official source")
	}
	task := r.task(r.flow.ID)
	w = r.wait("a question", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Review != nil
	})
	sub := subAt(w, task.ID, "整理需求")
	if sub.Review.Kind != enum.ReviewFailed || sub.Attempts != 1+w.Teams[r.team.ID].Settings.Retries || !strings.Contains(sub.Review.Prompt, "重新選擇藍圖") {
		t.Fatalf("attempts %d review %+v", sub.Attempts, sub.Review)
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{BlueprintID: &own}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResolveReview(sub.ID, "retry", ""); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
}

func TestAnEmployeeWhoseModelIsGoneStillStarts(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	high := "high"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Effort: &high}); err != nil {
		t.Fatal(err)
	}
	var provider string
	for id := range r.world().Providers {
		provider = id
	}
	// the provider stops offering the employee's model, as after changing its address or key
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "other-model"}}
	r.fake.mu.Unlock()
	if err := r.e.RefreshModels(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Replicas[r.owner.ID]; got.Model != "fake" || got.Effort != high {
		t.Fatalf("model %s effort %s", got.Model, got.Effort)
	}
	other := "other-model"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Model: &other}); err != nil {
		t.Fatal(err)
	}
	// a level is still checked against a model someone offers
	s := readSettings(t, r)
	rep := s.Replicas[r.owner.ID]
	rep.Effort = "nonsense"
	s.Replicas[rep.ID] = rep
	writeSettings(t, r, s)
	if err := r.e.ReloadSettings(context.Background()); err == nil || !strings.Contains(err.Error(), "effort") {
		t.Fatalf("accepted a level the model lacks: %v", err)
	}
}

func TestOlderFlowKeepsFirstOnAWorkStep(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	bea, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bea", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	s := readSettings(t, r)
	w := *s.Workflows[r.flow.ID]
	w.Nodes = append([]model.WorkflowNode{}, w.Nodes...)
	w.Nodes[0].ReplicaIDs, w.Nodes[0].Assignment = []string{bea.ID, r.owner.ID}, "everyone"
	s.Workflows[w.ID] = &w
	writeSettings(t, r, s)
	if err := r.e.ReloadSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	n := r.world().Workflows[w.ID].Nodes[0]
	if len(n.ReplicaIDs) != 1 || n.ReplicaIDs[0] != bea.ID || n.Assignment != "" {
		t.Fatalf("%+v", n)
	}
}

// What the API keeps has to load again: a flow the settings file would refuse is refused when it is saved.
func TestASavedFlowLoadsAgain(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	good := *r.flow
	cases := map[string]func(wf *model.Workflow){
		"empty edge id": func(wf *model.Workflow) { wf.Edges[0].ID = "" },
		"same edge id": func(wf *model.Workflow) {
			wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: wf.Edges[0].ID, From: "start", To: "end"})
		},
		"same ends": func(wf *model.Workflow) {
			wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: "e2", From: "start", To: "end"})
		},
		"unknown kind":      func(wf *model.Workflow) { wf.Nodes[0].Kind = "robot" },
		"unknown handoff":   func(wf *model.Workflow) { wf.Nodes[0].Handoff = "" },
		"unknown join mode": func(wf *model.Workflow) { wf.Nodes[1].Join = "some" },
	}
	for name, change := range cases {
		wf := *clonedFlow(&good)
		change(&wf)
		if err := r.e.SaveWorkflow(wf.ID, wf); err == nil {
			t.Errorf("%s: saved", name)
		}
	}
	wf := *clonedFlow(&good)
	wf.Name = "改過"
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	if got := r.world().Workflows[wf.ID]; got == nil || got.Name != "改過" {
		t.Fatalf("%+v", got)
	}
}

func clonedFlow(wf *model.Workflow) *model.Workflow {
	raw, _ := json.Marshal(wf)
	out := &model.Workflow{}
	json.Unmarshal(raw, out)
	return out
}
