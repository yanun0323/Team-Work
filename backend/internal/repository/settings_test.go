package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestSettingsBatchRecoveryAndConflict(t *testing.T) {
	ctx := context.Background()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := model.SettingsOf(model.NewWorld())
	c.Blueprints["bp-test"] = &model.Blueprint{ID: "bp-test", Name: "before"}
	raw, _ := json.Marshal(c)
	if err := s.Apply(ctx, nil, nil, model.SettingsChange{After: raw}); err != nil {
		t.Fatal(err)
	}
	before, err := s.LoadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.dataDir, "blueprints", "bp-test.yaml")
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions %v %v", info, err)
	}
	c.Blueprints["bp-test"].Name = "after"
	c.Workflows["wf-test"] = &model.Workflow{ID: "wf-test", Name: "new"}
	raw, _ = json.Marshal(c)
	j, err := s.settingsWrite(model.SettingsChange{Before: before, After: raw})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(j).Error; err != nil {
		t.Fatal(err)
	}
	var files map[string][]byte
	if err := json.Unmarshal(j.After, &files); err != nil {
		t.Fatal(err)
	}
	// First file installed, second not yet installed: simulate an interrupted batch.
	if err := s.replaceFile("blueprints/bp-test.yaml", before.Files["blueprints/bp-test.yaml"], files["blueprints/bp-test.yaml"]); err != nil {
		t.Fatal(err)
	}
	after, err := s.LoadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.Files["workflows/wf-test.yaml"] == nil || !strings.Contains(string(after.Files["blueprints/bp-test.yaml"]), "after") {
		t.Fatal("batch not recovered")
	}
	var count int64
	if err := s.db.Model(&settingsJournal{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("journal remained %d %v", count, err)
	}
	// Recovery after all renames must also be idempotent.
	if err := s.db.Create(j).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadSettings(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("name: external\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = s.Apply(ctx, []model.Doc{{Kind: "task", ID: "never", Data: []byte(`{}`)}}, nil, model.SettingsChange{Before: after, After: raw})
	if err == nil || !strings.Contains(err.Error(), "外部修改") {
		t.Fatalf("expected conflict: %v", err)
	}
	docs, err := s.LoadDocs(ctx)
	if err != nil || len(docs) != 0 {
		t.Fatalf("conflict wrote runtime: %v", err)
	}
	if err := s.db.Create(j).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadSettings(ctx); err == nil {
		t.Fatal("recovery overwrote external file")
	}
	got, _ := os.ReadFile(path)
	if string(got) != "name: external\n" {
		t.Fatal("external edit lost")
	}
}

func TestSettingsRejectSymlinksAndPaths(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.dataDir, "provider.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadSettings(context.Background()); err == nil {
		t.Fatal("followed symlink")
	}
	for _, path := range []string{"../x", "blueprints/../x.yaml", "teams/x/replicas/../../x.json"} {
		if _, err := s.safePath(path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
}

func TestSettingsPreserveUnchangedYAMLComments(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := model.SettingsOf(model.NewWorld())
	c.Blueprints["b"] = &model.Blueprint{ID: "b", Name: "B"}
	raw, _ := json.Marshal(c)
	if err := s.Apply(context.Background(), nil, nil, model.SettingsChange{After: raw}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.dataDir, "blueprints", "b.yaml")
	old, _ := os.ReadFile(path)
	commented := append([]byte("# my comment\n"), old...)
	if err := os.WriteFile(path, commented, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := s.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c.Workflows["w"] = &model.Workflow{ID: "w", Name: "W"}
	raw, _ = json.Marshal(c)
	if err := s.Apply(context.Background(), nil, nil, model.SettingsChange{Before: before, After: raw}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(commented) {
		t.Fatal("unrelated save rewrote YAML")
	}
	for _, input := range []string{"id: b\nid: b\n", "id: b\n---\nid: c\n", "null\n"} {
		var bp model.Blueprint
		if err := decodeFile("blueprints/b.yaml", []byte(input), &bp); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestFileNameIsTheIDOfBlueprintsAndWorkflows(t *testing.T) {
	c := model.Settings{Version: 1, Preferences: model.DefaultPreferences(), Providers: map[string]model.ProviderConfig{},
		Blueprints: map[string]*model.Blueprint{"bp-a": {ID: "bp-a", Name: "a"}},
		Workflows:  map[string]*model.Workflow{"wf-a": {ID: "wf-a", Name: "a"}}}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	files, err := splitSettings(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"blueprints/bp-a.yaml", "workflows/wf-a.yaml"} {
		if bytes.HasPrefix(files[path], []byte("id:")) || bytes.Contains(files[path], []byte("\nid:")) {
			t.Fatalf("%s still has an id:\n%s", path, files[path])
		}
	}
	// A stale id left in a copied file loses to the file name.
	files["blueprints/copy.yaml"] = []byte("id: bp-a\nname: copy\n")
	out, err := assemble(files)
	if err != nil {
		t.Fatal(err)
	}
	var got model.Settings
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Blueprints["bp-a"].ID != "bp-a" || got.Workflows["wf-a"].ID != "wf-a" || got.Blueprints["copy"].ID != "copy" || got.Blueprints["copy"].Name != "copy" {
		t.Fatalf("ids not from file names: %s", out)
	}
}
