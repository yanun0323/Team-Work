package usecase

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/repository"
)

func writeFile(t *testing.T, root, rel, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, rel), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

const reviewerFile = `name: Reviewer
prompt: Review the diff.
skills:
  - path: skills
    include: [review]
  - repo: cursor/plugins
    ref: main
    path: pstack
tools: [read_file, runCommand]
`

const shipFlow = `name: Ship
nodes:
  - id: build
    name: Build
    prompt: Build it.
    replicaIds: [r-9]
  - id: check
    name: Check
    prompt: Check it.
edges:
  - from: build
    to: check
`

// sourcedEngine is an engine with a store, whose git answers every repo with the newest version held in latest and
// keeps a folder for each version in dirs.
func sourcedEngine(t *testing.T, dirs map[string]string, latest *string) *Engine {
	t.Helper()
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine(context.Background(), Options{Store: store, Git: versionsAt{dirs: dirs, latest: latest}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close(); store.Close() })
	return e
}

type versionsAt struct {
	adapter.Git
	dirs   map[string]string
	latest *string
}

func (v versionsAt) Latest(context.Context, string, string) (string, error) { return *v.latest, nil }
func (v versionsAt) Fetch(_ context.Context, _, commit string) (string, error) {
	return v.dirs[commit], nil
}
func (v versionsAt) Cached(_, commit string) bool { return v.dirs[commit] != "" }

func TestASourceBringsItsBlueprintsAndFlows(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "skills/review")
	writeFile(t, root, "blueprints/reviewer.yaml", reviewerFile)
	writeFile(t, root, "blueprints/broken.yaml", "name: Broken\ntools: [fly]\n")
	writeFile(t, root, "blueprints/notes.txt", "not a blueprint")
	writeFile(t, root, "workflows/ship.yaml", shipFlow)
	latest := "p1"
	e := sourcedEngine(t, map[string]string{"p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	b := e.w.Blueprints[src.ID+"--reviewer"]
	if b == nil || b.Name != "Reviewer" || b.Prompt != "Review the diff." || !slices.Equal(b.Tools, []enum.Tool{enum.ToolReadFile, enum.ToolRunCommand}) {
		t.Fatalf("blueprint = %+v", b)
	}
	if p := b.Skills[0]; p.SourceID != src.ID || p.Path != "skills" || !slices.Equal(p.Include, []string{"review"}) {
		t.Errorf("a folder in the source reads the source itself: %+v", p)
	}
	repo := e.w.Sources[b.Skills[1].SourceID]
	if repo == nil || repo.Repo != "https://github.com/cursor/plugins" || repo.Ref != "main" || b.Skills[1].Path != "pstack" {
		t.Errorf("a repo named is kept as a source of its own: %+v, pack %+v", repo, b.Skills[1])
	}
	if repo != nil && repo.Commit != "p1" {
		t.Errorf("the repo it names got no version: %+v", repo)
	}
	if e.w.Blueprints[src.ID+"--broken"] != nil {
		t.Error("a blueprint with an unknown tool was read")
	}
	if problems := e.sourced[src.ID].Problems; len(problems) != 1 || !strings.HasPrefix(problems[0], "blueprints/broken.yaml: ") || !strings.Contains(problems[0], "fly") {
		t.Errorf("problems = %v", problems)
	}
	wf := e.w.Workflows[src.ID+"--ship"]
	if wf == nil || len(wf.Nodes) != 2 || len(wf.Edges) != 1 || wf.Edges[0].ID == "" {
		t.Fatalf("flow = %+v", wf)
	}
	if len(wf.Nodes[0].ReplicaIDs) != 0 || wf.Nodes[0].Kind != enum.NodeWork || wf.Nodes[1].Pos == wf.Nodes[0].Pos {
		t.Errorf("a step is worked by whoever each task picks, and placed: %+v", wf.Nodes)
	}
	s := model.SettingsOf(e.w)
	if s.Blueprints[b.ID] != nil || s.Workflows[wf.ID] != nil {
		t.Error("what a source brings is kept in the settings files")
	}
}

func TestWhatASourceBringsCannotBeChanged(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "blueprints/reviewer.yaml", reviewerFile)
	writeFile(t, root, "workflows/ship.yaml", shipFlow)
	latest := "p1"
	e := sourcedEngine(t, map[string]string{"p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	bp, wf := src.ID+"--reviewer", src.ID+"--ship"
	if err := e.SaveBlueprint(bp, model.Blueprint{Name: "Mine"}); err == nil {
		t.Error("a blueprint from a source was changed")
	}
	if err := e.DeleteBlueprint(bp, ""); err == nil {
		t.Error("a blueprint from a source was deleted")
	}
	if err := e.DeleteWorkflow(wf); err == nil {
		t.Error("a flow from a source was deleted")
	}
	copied, err := e.DuplicateWorkflow(wf)
	if err != nil || model.IsLockedID(copied.ID) {
		t.Errorf("a copy is the user's own: %+v, %v", copied, err)
	}
}

func TestADeletedSourceTakesWhatItBroughtUnlessSomeoneWorksByIt(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "skills/review")
	writeFile(t, root, "blueprints/reviewer.yaml", "name: Reviewer\nskills:\n  - path: skills\n")
	latest := "p1"
	e := sourcedEngine(t, map[string]string{"p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.doSettings(func() error {
		e.w.Replicas["r-1"] = &model.Replica{ID: "r-1", TeamID: "t-1", BlueprintID: src.ID + "--reviewer"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteSource(src.ID); err == nil {
		t.Fatal("a source was deleted while an employee works by its blueprint")
	}
	if err := e.doSettings(func() error { delete(e.w.Replicas, "r-1"); return nil }); err != nil {
		t.Fatal(err)
	}
	// its own blueprint reading its skills does not keep it
	if err := e.DeleteSource(src.ID); err != nil {
		t.Fatal(err)
	}
	if e.w.Blueprints[src.ID+"--reviewer"] != nil {
		t.Error("the blueprint stayed after its source went")
	}
}

func TestAnUpdateDroppingABlueprintLeavesItsEmployeesTheirOwn(t *testing.T) {
	was, is := t.TempDir(), t.TempDir()
	writeFile(t, was, "blueprints/reviewer.yaml", reviewerFile)
	writeFile(t, was, "blueprints/writer.yaml", "name: Writer\n")
	writeFile(t, is, "blueprints/writer.yaml", "name: Writer\nprompt: Write more.\n")
	writeFile(t, is, "workflows/ship.yaml", shipFlow)
	latest := "c1"
	e := sourcedEngine(t, map[string]string{"c1": was, "c2": is, "p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "git", Repo: "a/b"})
	if err != nil {
		t.Fatal(err)
	}
	reviewer, writer := src.ID+"--reviewer", src.ID+"--writer"
	if err := e.doSettings(func() error {
		e.w.Replicas["r-1"] = &model.Replica{ID: "r-1", TeamID: "t-1", Name: "Ann", BlueprintID: reviewer}
		e.w.Replicas["r-2"] = &model.Replica{ID: "r-2", TeamID: "t-1", Name: "Bo", BlueprintID: writer}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	latest = "c2"
	if err := e.CheckSource(context.Background(), src.ID); err != nil {
		t.Fatal(err)
	}
	changes, err := e.SourceUpdateChanges(context.Background(), src.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(changes.RemovedBlueprints, []string{"Reviewer"}) || len(changes.AddedBlueprints) != 0 ||
		!slices.Equal(changes.AddedWorkflows, []string{"Ship"}) || !slices.Equal(changes.Kept, []string{"r-1"}) {
		t.Errorf("changes = %+v", changes)
	}
	if err := e.ApplySource(context.Background(), src.ID); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	own := e.w.Blueprints[e.w.Replicas["r-1"].BlueprintID]
	if own == nil || own.Owner != "r-1" || own.Prompt != "Review the diff." || model.IsLockedID(own.ID) {
		t.Errorf("the employee keeps the blueprint as their own: %+v", own)
	}
	if e.w.Blueprints[reviewer] != nil || e.w.Workflows[src.ID+"--ship"] == nil {
		t.Error("the blueprints and flows are not those of the new version")
	}
	if r := e.w.Replicas["r-2"]; r.BlueprintID != writer || e.w.Blueprints[writer].Prompt != "Write more." {
		t.Errorf("an employee whose blueprint stays follows it: %+v", r)
	}
}

func TestTheAppsOwnFolderBringsNoBlueprints(t *testing.T) {
	e := &Engine{w: model.NewWorld(), dataDir: "/x/.team-work"}
	if e.readsSourced(model.Source{Kind: "local", Path: "/x/.team-work/"}) {
		t.Error("the app's own folder is read for blueprints")
	}
	if !e.readsSourced(model.Source{Kind: "local", Path: "/x/.agents/"}) || e.readsSourced(model.Source{Kind: "git", Repo: "r"}) {
		t.Error("another folder, or a repo with no version yet")
	}
}

func TestSourcedIDs(t *testing.T) {
	if got := model.SourceOfID("src-3--reviewer"); got != "src-3" {
		t.Errorf("source of = %q", got)
	}
	for _, id := range []string{"bp-3", "preset-a--b", "wf-1"} {
		if model.SourceOfID(id) != "" {
			t.Errorf("%s is read as from a source", id)
		}
	}
}

func TestWhatASourceBringsIsThereAgainAfterARestart(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	writeFile(t, root, "blueprints/reviewer.yaml", reviewerFile)
	latest := "p1"
	git := versionsAt{dirs: map[string]string{"p1": t.TempDir()}, latest: &latest}
	open := func() (*Engine, func()) {
		store, err := repository.NewStore(data)
		if err != nil {
			t.Fatal(err)
		}
		e, err := NewEngine(context.Background(), Options{Store: store, Git: git, DataDir: data, Log: zerolog.Nop()})
		if err != nil {
			t.Fatal(err)
		}
		return e, func() { e.Close(); store.Close() }
	}
	e, done := open()
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	done()
	e, done = open()
	defer done()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.w.Blueprints[src.ID+"--reviewer"] == nil {
		t.Error("the blueprint a folder brings is gone after a restart")
	}
}
