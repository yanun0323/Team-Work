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
	if err := s.Apply(ctx, nil, nil, nil, model.SettingsChange{After: raw}); err != nil {
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
	err = s.Apply(ctx, []model.Doc{{Kind: "task", ID: "never", Data: []byte(`{}`)}}, nil, nil, model.SettingsChange{Before: after, After: raw})
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
	for _, path := range []string{"../x", "blueprints/../x.yaml", "company/x/employee/../../x.json"} {
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
	if err := s.Apply(context.Background(), nil, nil, nil, model.SettingsChange{After: raw}); err != nil {
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
	if err := s.Apply(context.Background(), nil, nil, nil, model.SettingsChange{Before: before, After: raw}); err != nil {
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

func TestSettingsFromBeforeTheTutorialWasRemovedStillLoadAndLoseIt(t *testing.T) {
	ctx := context.Background()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := model.SettingsOf(model.NewWorld())
	raw, _ := json.Marshal(c)
	if err := s.Apply(ctx, nil, nil, nil, model.SettingsChange{After: raw}); err != nil {
		t.Fatal(err)
	}
	// as an older version left them: its progress in a file of its own, and its sound among the preferences
	prefs := filepath.Join(s.dataDir, "preferences.yaml")
	var lines []string
	old, _ := os.ReadFile(prefs)
	for _, line := range strings.Split(strings.TrimSpace(string(old)), "\n") {
		if !strings.HasPrefix(line, "soundTutorial:") {
			lines = append(lines, line)
		}
	}
	if err := os.WriteFile(prefs, []byte(strings.Join(append(lines, "soundTutorial: false"), "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tutorial := filepath.Join(s.dataDir, "tutorial.yaml")
	if err := os.WriteFile(tutorial, []byte("seeded: true\ndone: [provider]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := s.LoadSettings(ctx)
	if err != nil {
		t.Fatalf("older settings no longer load: %v", err)
	}
	if bytes.Contains(before.Data, []byte("utorial")) {
		t.Fatalf("the tutorial is still read: %s", before.Data)
	}
	// the next save leaves both out
	c.Preferences.Shadows = false
	raw, _ = json.Marshal(c)
	if err := s.Apply(ctx, nil, nil, nil, model.SettingsChange{Before: before, After: raw}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tutorial); !os.IsNotExist(err) {
		t.Fatalf("tutorial.yaml is still there: %v", err)
	}
	if got, _ := os.ReadFile(prefs); bytes.Contains(got, []byte("soundTutorial")) {
		t.Fatalf("preferences.yaml still has the tutorial's sound:\n%s", got)
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

func TestSourcesAreKeptInOneFileByID(t *testing.T) {
	c := model.Settings{Version: 1, Preferences: model.DefaultPreferences(), Providers: map[string]model.ProviderConfig{},
		Blueprints: map[string]*model.Blueprint{}, Workflows: map[string]*model.Workflow{},
		Sources: map[string]*model.Source{"src-1": {ID: "src-1", Kind: "git", Repo: "https://github.com/a/b", Ref: "main", Commit: "c1", AutoApply: true}}}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	files, err := splitSettings(raw)
	if err != nil {
		t.Fatal(err)
	}
	if files["sources.yaml"] == nil || bytes.Contains(files["sources.yaml"], []byte("id: src-1")) {
		t.Fatalf("sources.yaml:\n%s", files["sources.yaml"])
	}
	out, err := assemble(files)
	if err != nil {
		t.Fatal(err)
	}
	var got model.Settings
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if s := got.Sources["src-1"]; s == nil || *s != *c.Sources["src-1"] {
		t.Fatalf("sources = %+v", got.Sources)
	}
}

func TestPathIsTheIDOfCompaniesAndEmployees(t *testing.T) {
	c := model.Settings{Version: 1, Preferences: model.DefaultPreferences(), Providers: map[string]model.ProviderConfig{},
		Teams:    map[string]model.TeamConfig{"team-a": {ID: "team-a", Name: "a"}},
		Replicas: map[string]model.ReplicaConfig{"rep-a": {ID: "rep-a", TeamID: "team-a", Name: "a"}}}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	files, err := splitSettings(raw)
	if err != nil {
		t.Fatal(err)
	}
	company, employee := files["company/team-a/config.yaml"], files["company/team-a/employee/rep-a.json"]
	if company == nil || employee == nil {
		t.Fatalf("missing files: %v", files)
	}
	if bytes.HasPrefix(company, []byte("id:")) || bytes.Contains(company, []byte("\nid:")) {
		t.Fatalf("company file still has an id:\n%s", company)
	}
	if bytes.Contains(employee, []byte(`"id"`)) || bytes.Contains(employee, []byte(`"teamId"`)) {
		t.Fatalf("employee file still has its ids:\n%s", employee)
	}
	// Files written before this change still carry stale ids; the path wins.
	files["company/team-a/employee/rep-old.json"] = []byte(`{"id":"rep-x","teamId":"team-x","name":"old"}`)
	files["company/team-b/config.yaml"] = []byte("id: team-x\nname: b\n")
	out, err := assemble(files)
	if err != nil {
		t.Fatal(err)
	}
	var got model.Settings
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Teams["team-a"].ID != "team-a" || got.Teams["team-b"].ID != "team-b" || got.Replicas["rep-a"].TeamID != "team-a" ||
		got.Replicas["rep-old"].ID != "rep-old" || got.Replicas["rep-old"].TeamID != "team-a" {
		t.Fatalf("ids not from paths: %s", out)
	}
}

func TestMigrateTeamsToCompany(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("provider.json", "{}\n")
	write("teams/team-a/config.yaml", "id: team-a\nname: a\n")
	write("teams/team-a/replicas/rep-a.json", `{"id":"rep-a","teamId":"team-a","name":"a"}`)
	// An earlier run stopped after renaming one replicas folder.
	write("teams/team-b/config.yaml", "name: b\n")
	write("teams/team-b/employee/rep-b.json", `{"name":"b"}`)
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A batch left unfinished under the old paths still recovers.
	j, _ := json.Marshal(map[string][]byte{"teams/team-a/replicas/rep-a.json": []byte(`{"id":"rep-a","teamId":"team-a","name":"a"}`)})
	ja, _ := json.Marshal(map[string][]byte{"teams/team-a/replicas/rep-a.json": []byte(`{"name":"renamed"}`)})
	if err := s.db.Create(&settingsJournal{ID: 1, Before: j, After: ja}).Error; err != nil {
		t.Fatal(err)
	}
	s.Close()
	if s, err = NewStore(dir); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := os.Stat(filepath.Join(dir, "teams")); !os.IsNotExist(err) {
		t.Fatal("teams still exists")
	}
	snapshot, err := s.LoadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var got model.Settings
	if err := json.Unmarshal(snapshot.Data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Teams["team-a"].Name != "a" || got.Teams["team-b"].Name != "b" || got.Replicas["rep-a"].Name != "renamed" || got.Replicas["rep-b"].TeamID != "team-b" {
		t.Fatalf("not migrated: %s", snapshot.Data)
	}
}

func TestMigrateRefusesWhenBothFoldersExist(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{"teams/team-a", "company/team-a"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if s, err := NewStore(dir); err == nil {
		s.Close()
		t.Fatal("accepted both teams and company")
	}
}
