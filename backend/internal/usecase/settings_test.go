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
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	for _, tc := range []struct {
		name, field string
		edit        func(*model.Settings)
	}{
		{"reference", "blueprintId", func(s *model.Settings) { r := s.Replicas[r.owner.ID]; r.BlueprintID = "missing"; s.Replicas[r.ID] = r }},
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
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) {
		return call("ask_user", map[string]any{"prompt": "wait", "options": []any{}}), nil
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
