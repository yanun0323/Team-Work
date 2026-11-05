package usecase

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
)

func writeSkill(t *testing.T, root, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, rel, "SKILL.md"), []byte("---\nname: "+filepath.Base(rel)+"\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Packs that wrote the same repo and branch into themselves share one source after adoption, which keeps the version
// of the pack that last updated successfully; the folder each read becomes the pack's own, and what they read stays.
func TestAdoptSourcesMergesTheSameRepo(t *testing.T) {
	git := func(path, commit string, at float64, ok bool) *model.BlueprintSource {
		return &model.BlueprintSource{Kind: "git", Repo: "https://github.com/cursor/plugins", Ref: "main", Path: path, Commit: commit, Latest: commit,
			Update: &model.SourceUpdate{At: at, OK: ok}}
	}
	w := model.NewWorld()
	w.Blueprints["bp-1"] = &model.Blueprint{ID: "bp-1", Skills: []model.SkillPack{{Source: git("pstack/", "old", 10, true), Exclude: []string{"lint"}}}}
	w.Blueprints["bp-2"] = &model.Blueprint{ID: "bp-2", Owner: "r-1", Skills: []model.SkillPack{
		{Source: git("", "new", 20, true), Include: []string{"ship"}},
		{Source: &model.BlueprintSource{Kind: "local", Path: "~/.agents/"}, Exclude: []string{}},
	}}
	w.Blueprints["bp-3"] = &model.Blueprint{ID: "bp-3", Skills: []model.SkillPack{{Source: git("", "failed", 30, false)}}}
	e := &Engine{w: w}
	e.adoptSources()
	if len(w.Sources) != 1+len(presets.SkillFolders) {
		t.Fatalf("sources = %+v, want the repo and the agents' folders", w.Sources)
	}
	repo := w.Sources[w.Blueprints["bp-1"].Skills[0].SourceID]
	if repo == nil || repo.Commit != "new" || repo.Ref != "main" {
		t.Fatalf("repo source = %+v, want the version of the last successful update", repo)
	}
	for _, id := range []string{"bp-2", "bp-3"} {
		if got := w.Blueprints[id].Skills[0].SourceID; got != repo.ID {
			t.Errorf("%s reads %q, want %q", id, got, repo.ID)
		}
	}
	p := w.Blueprints["bp-1"].Skills[0]
	if p.Source != nil || p.Path != "pstack" || !slices.Equal(p.Exclude, []string{"lint"}) {
		t.Errorf("pack = %+v, want the folder pstack and its picks kept", p)
	}
	if got := w.Blueprints["bp-2"].Skills[0].Include; !slices.Equal(got, []string{"ship"}) {
		t.Errorf("include = %v", got)
	}
	if local := w.Sources[w.Blueprints["bp-2"].Skills[1].SourceID]; local == nil || local.Kind != "local" || local.Path != "~/.agents/" {
		t.Errorf("local source = %+v", local)
	}
	// once more changes nothing
	before := len(w.Sources)
	e.adoptSources()
	if len(w.Sources) != before {
		t.Errorf("adopting twice made %d sources", len(w.Sources))
	}
}

// Read through the source it names, a pack reads the same skills as when the place was written into it.
func TestAdoptedPacksReadTheSameSkills(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"pstack/skills/ship", "pstack/skills/lint", "other/skills/deploy"} {
		writeSkill(t, root, rel)
	}
	w := model.NewWorld()
	bp := &model.Blueprint{ID: "bp-1", Skills: []model.SkillPack{
		{Source: &model.BlueprintSource{Kind: "git", Repo: "https://github.com/cursor/plugins", Path: "pstack", Commit: "c1"}, Exclude: []string{"lint"}},
		{Source: &model.BlueprintSource{Kind: "local", Path: root}, Include: []string{"deploy"}},
	}}
	w.Blueprints[bp.ID] = bp
	e := &Engine{w: w, git: fetchedRepo{dir: root}}
	names := func() []string {
		found, _, problems := e.loadSkills(context.Background(), e.packsOf(bp))
		if len(problems) > 0 {
			t.Fatal(problems)
		}
		var out []string
		for _, s := range found {
			out = append(out, s.name)
		}
		slices.Sort(out)
		return out
	}
	want := names()
	e.adoptSources()
	if got := names(); !slices.Equal(got, want) || !slices.Equal(want, []string{"deploy", "ship"}) {
		t.Fatalf("skills after = %v, before = %v", got, want)
	}
}

// fetchedVersions holds a folder for each version of a repo.
type fetchedVersions struct {
	adapter.Git
	dirs map[string]string
}

func (f fetchedVersions) Fetch(_ context.Context, _, commit string) (string, error) {
	return f.dirs[commit], nil
}

func TestSourceUpdateChangesNamesWhoIsAffected(t *testing.T) {
	was, is := t.TempDir(), t.TempDir()
	writeSkill(t, was, "skills/ship")
	writeSkill(t, was, "skills/lint")
	writeSkill(t, is, "skills/ship")
	writeSkill(t, is, "skills/deploy")
	w := model.NewWorld()
	w.Sources["src-1"] = &model.Source{ID: "src-1", Kind: "git", Repo: "https://github.com/a/b", Commit: "c1", Latest: "c2"}
	w.Blueprints["bp-all"] = &model.Blueprint{ID: "bp-all", Skills: []model.SkillPack{{SourceID: "src-1"}}}
	w.Blueprints["bp-ship"] = &model.Blueprint{ID: "bp-ship", Skills: []model.SkillPack{{SourceID: "src-1", Include: []string{"ship"}}}}
	w.Replicas["r-1"] = &model.Replica{ID: "r-1", BlueprintID: "bp-all"}
	w.Replicas["r-2"] = &model.Replica{ID: "r-2", BlueprintID: "bp-ship"}
	e := &Engine{w: w, git: fetchedVersions{dirs: map[string]string{"c1": was, "c2": is}}}
	got, err := e.SourceUpdateChanges(context.Background(), "src-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Added) != 1 || got.Added[0].Name != "deploy" || len(got.Removed) != 1 || got.Removed[0].Name != "lint" {
		t.Errorf("added %+v, removed %+v", got.Added, got.Removed)
	}
	if !slices.Equal(got.Blueprints, []string{"bp-all"}) || !slices.Equal(got.Replicas, []string{"r-1"}) {
		t.Errorf("affected blueprints %v, employees %v; the one that picked ship alone is not", got.Blueprints, got.Replicas)
	}
}

func TestItemsAtNamesEachSkillsFolder(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "pstack/skills/ship")
	writeSkill(t, root, "top")
	got := itemsAt(model.Source{Kind: "git"}, root)
	if len(got) != 2 || got[0].Path != "pstack/skills/ship" || got[0].Category != "pstack/skills" || got[1].Path != "top" || got[1].Category != "" {
		t.Fatalf("items = %+v", got)
	}
}

// newestVersion answers every repo with one version, held in a folder.
type newestVersion struct {
	fetchedVersions
	latest string
}

func (n newestVersion) Latest(context.Context, string, string) (string, error) { return n.latest, nil }

func TestPreviewSourceReadsTheNewestVersionWithoutKeepingIt(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "skills/eng/tdd")
	e := &Engine{w: model.NewWorld(), git: newestVersion{fetchedVersions{dirs: map[string]string{"c9": dir}}, "c9"}}
	got, err := e.PreviewSource(context.Background(), NewSource{Kind: "git", Repo: "a/b"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Commit != "c9" || len(got.Items) != 1 || got.Items[0].Category != "skills/eng" {
		t.Errorf("preview = %+v", got)
	}
	if len(e.w.Sources) != 0 {
		t.Errorf("sources = %v, want none kept by a preview", e.w.Sources)
	}
}

func TestAddSourceRefusesARepoWithNoSkills(t *testing.T) {
	e := &Engine{w: model.NewWorld(), git: newestVersion{fetchedVersions{dirs: map[string]string{"c9": t.TempDir()}}, "c9"}}
	if _, err := e.AddSource(context.Background(), NewSource{Kind: "git", Repo: "a/b"}); err == nil {
		t.Fatal("a repo with no skills was kept")
	}
	if len(e.w.Sources) != 0 {
		t.Errorf("sources = %v, want none", e.w.Sources)
	}
}

// latestIs answers every repo with the version held in at, which a test can move.
type latestIs struct {
	adapter.Git
	at *string
}

func (l latestIs) Latest(context.Context, string, string) (string, error) { return *l.at, nil }

func TestAnUpdateAppliedByItselfIsUnseenUntilOpened(t *testing.T) {
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	at := "c2"
	e, err := NewEngine(context.Background(), Options{Store: store, Git: latestIs{at: &at}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close(); store.Close() })
	var id string
	if err := e.doSettings(func() error {
		s := e.sourceFor(NewSource{Kind: "git", Repo: "https://github.com/a/b"})
		s.Commit, id = "c1", s.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	unseen := func() bool { e.mu.Lock(); defer e.mu.Unlock(); return e.w.Sources[id].Unseen }
	if err := e.CheckSource(context.Background(), id); err != nil || unseen() {
		t.Fatalf("a newer version waiting for the user is not an update applied: unseen %v, err %v", unseen(), err)
	}
	if err := e.SetSourceAutoApply(id, true); err != nil {
		t.Fatal(err)
	}
	at = "c3"
	if err := e.CheckSource(context.Background(), id); err != nil || !unseen() {
		t.Fatalf("applied by itself: unseen %v, err %v", unseen(), err)
	}
	if err := e.CheckSource(context.Background(), id); err != nil || !unseen() {
		t.Fatalf("checking again with nothing new keeps it unseen: %v, err %v", unseen(), err)
	}
	if err := e.SeeSource(id); err != nil || unseen() {
		t.Fatalf("opened: unseen %v, err %v", unseen(), err)
	}
}

// latestFails answers every repo with the error held in err.
type latestFails struct {
	adapter.Git
	err error
}

func (l latestFails) Latest(context.Context, string, string) (string, error) { return "", l.err }

// A check that fails only for now, like no network, keeps the upstream; only a repo or branch that is gone loses it.
func TestOnlyAGoneRepoLosesItsUpstream(t *testing.T) {
	gitErr := func(stderr string) error { return fmt.Errorf("git ls-remote: exit status 128: %s", stderr) }
	for name, c := range map[string]struct {
		err      error
		upstream bool
	}{
		"no network": {gitErr("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com"), true},
		"timeout":    {fmt.Errorf("git ls-remote: %w", context.DeadlineExceeded), true},
		"no repo":    {gitErr("remote: Repository not found."), false},
		"private":    {gitErr("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), false},
		"no branch":  {model.Errorf(model.CodeNotFound, "找不到版本 %s", "main"), false},
	} {
		data := t.TempDir()
		store, err := repository.NewStore(data)
		if err != nil {
			t.Fatal(err)
		}
		e, err := NewEngine(context.Background(), Options{Store: store, Git: latestFails{err: c.err}, DataDir: data, Log: zerolog.Nop()})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { e.Close(); store.Close() })
		var id string
		if err := e.doSettings(func() error {
			s := e.sourceFor(NewSource{Kind: "git", Repo: "https://github.com/a/b"})
			s.Commit, s.Upstream, id = "c1", true, s.ID
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := e.CheckSource(context.Background(), id); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		e.mu.Lock()
		s := clone(e.w.Sources[id])
		e.mu.Unlock()
		if s.Upstream != c.upstream || s.Update == nil || s.Update.OK || s.Commit != "c1" {
			t.Errorf("%s: upstream %v, update %+v, commit %q; want upstream %v, a failed update, c1 kept", name, s.Upstream, s.Update, s.Commit, c.upstream)
		}
	}
}
