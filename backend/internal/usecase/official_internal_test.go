package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
)

const multilingualFile = `name:
  en: Planner
  zh: 規劃師
prompt:
  zh: 你負責規劃。
  ja: 計画を担当します。
comment: one comment for all
`

const multilingualFlow = `name:
  en: Ship
  zh: 出貨
nodes:
  - id: build
    name:
      en: Build
      zh: 建置
    prompt:
      en: Build it.
      zh: 建置它。
  - id: check
    name: Check
    prompt: Check it.
edges:
  - from: build
    to: check
`

// A source's file can write a text once, or once for each language: the app shows the language picked, then English,
// then the first written, and employees are told the English when there is one.
func TestSourcedTextsFollowTheLanguage(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "blueprints/planner.yaml", multilingualFile)
	writeFile(t, root, "blueprints/english.yaml", "name: {en: Writer, zh: 寫手}\nprompt: {zh: 你寫東西。, en: You write.}\n")
	writeFile(t, root, "workflows/ship.yaml", multilingualFlow)
	latest := "p1"
	e := sourcedEngine(t, map[string]string{"p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	planner, writer, ship := src.ID+"--planner", src.ID+"--english", src.ID+"--ship"
	check := func(language, name, prompt, flow, step, stepPrompt string) {
		t.Helper()
		e.mu.Lock()
		defer e.mu.Unlock()
		b, wf := e.w.Blueprints[planner], e.w.Workflows[ship]
		if b == nil || b.Name != name || b.Prompt != prompt || b.Comment != "one comment for all" {
			t.Fatalf("%s: blueprint %+v", language, b)
		}
		if wf == nil || wf.Name != flow || wf.Nodes[0].Name != step || wf.Nodes[0].Prompt != stepPrompt || wf.Nodes[1].Name != "Check" {
			t.Fatalf("%s: flow %+v", language, wf)
		}
	}
	check("zh", "規劃師", "你負責規劃。", "出貨", "建置", "建置它。")
	if err := e.SetLanguage(model.LanguageJa); err != nil {
		t.Fatal(err)
	}
	check("ja", "Planner", "計画を担当します。", "Ship", "Build", "Build it.")
	if err := e.SetLanguage(model.LanguageKo); err != nil {
		t.Fatal(err)
	}
	check("ko", "Planner", "你負責規劃。", "Ship", "Build", "Build it.")
	if err := e.SetLanguage(model.LanguageZh); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if got := e.agentRole(e.w.Blueprints[writer]); got != "You write." {
		t.Errorf("employees are told %q", got)
	}
	if got := e.agentRole(e.w.Blueprints[planner]); got != "你負責規劃。" {
		t.Errorf("with no English, employees are told %q", got)
	}
	if wf := e.agentFlow(e.w.Workflows[ship]); wf.Name != "Ship" || wf.Nodes[0].Name != "Build" || wf.Nodes[0].Prompt != "Build it." {
		t.Errorf("employees are told the flow %+v", wf)
	}
}

func TestASourcedTextInAnUnknownLanguageIsNotRead(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "blueprints/french.yaml", "name:\n  en: Writer\n  fr: Écrivain\n")
	writeFile(t, root, "blueprints/listed.yaml", "name: [Writer]\n")
	writeFile(t, root, "workflows/nameless.yaml", "name: {en: Ship, zh: ''}\nnodes: [{id: a, name: A}]\nedges: []\n")
	latest := "p1"
	e := sourcedEngine(t, map[string]string{"p1": t.TempDir()}, &latest)
	src, err := e.AddSource(context.Background(), NewSource{Kind: "local", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	problems, err := e.SourceProblems(src.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 3 || !strings.Contains(problems[0], "fr") || !strings.HasPrefix(problems[1], "blueprints/listed.yaml: ") ||
		!strings.HasPrefix(problems[2], "workflows/nameless.yaml: ") {
		t.Fatalf("problems = %v", problems)
	}
}

// officialFS is the copy of the official source the tests read, kept up by `make official-source`.
var officialFS = os.DirFS(filepath.Join("testdata", "official"))

func TestTheOfficialSourceCannotBeRemoved(t *testing.T) {
	latest := "p1"
	e := sourcedEngine(t, map[string]string{}, &latest)
	if err := e.DeleteSource(OfficialSourceID); err == nil {
		t.Fatal("removed the official source")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.w.Sources[OfficialSourceID] == nil {
		t.Fatal("the official source is gone")
	}
}

// downloads is a repo whose versions are folders, each downloaded on its first fetch; one in down cannot be.
type downloads struct {
	adapter.Git
	dirs   map[string]string
	here   map[string]bool
	down   map[string]bool
	latest *string
}

func (d downloads) Latest(context.Context, string, string) (string, error) { return *d.latest, nil }
func (d downloads) Fetch(_ context.Context, _, commit string) (string, error) {
	if d.down[commit] {
		return "", errors.New("could not download")
	}
	d.here[commit] = true
	return d.dirs[commit], nil
}
func (d downloads) Cached(_, commit string) bool { return d.here[commit] }

// The app has no copy of the official source: it has no version and brings nothing until the first check downloads
// it. A version that cannot be read is not moved to, and the one in use is downloaded again once it is gone from
// this computer, even with nothing newer.
func TestTheOfficialSourceIsDownloadedAndKeptAtAVersionRead(t *testing.T) {
	data, first, second := t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, first, "blueprints/assistant.yaml", "name: Assistant\n")
	writeFile(t, second, "blueprints/solo.yaml", "name: Solo\n")
	latest := "c1"
	git := downloads{dirs: map[string]string{"c1": first, "c2": second}, here: map[string]bool{}, down: map[string]bool{}, latest: &latest}
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
	state := func(e *Engine) (commit string, assistant, solo bool, update model.SourceUpdate) {
		e.mu.Lock()
		defer e.mu.Unlock()
		s := e.w.Sources[OfficialSourceID]
		if s.Update != nil {
			update = *s.Update
		}
		return s.Commit, e.w.Blueprints["team-work--assistant"] != nil, e.w.Blueprints["team-work--solo"] != nil, update
	}
	check := func(e *Engine) {
		if err := e.CheckSource(context.Background(), OfficialSourceID); err != nil {
			t.Fatal(err)
		}
	}
	e, done := open()
	if commit, assistant, _, _ := state(e); commit != "" || assistant {
		t.Fatalf("at %q before any check", commit)
	}
	check(e)
	if commit, assistant, _, _ := state(e); commit != "c1" || !assistant {
		t.Fatalf("at %q after the first check", commit)
	}
	// a newer version that cannot be downloaded is not moved to
	latest, git.down["c2"] = "c2", true
	check(e)
	if commit, assistant, _, update := state(e); commit != "c1" || !assistant || update.OK || update.Error == "" {
		t.Fatalf("at %q, update %+v", commit, update)
	}
	git.down["c2"] = false
	check(e)
	if commit, _, solo, _ := state(e); commit != "c2" || !solo {
		t.Fatalf("at %q once it can be downloaded", commit)
	}
	// the version in use goes from this computer: it starts without it, and the next check brings it back
	done()
	delete(git.here, "c2")
	e, done = open()
	defer done()
	if commit, _, solo, _ := state(e); commit != "c2" || solo {
		t.Fatalf("at %q, read a version not here", commit)
	}
	check(e)
	if commit, _, solo, update := state(e); commit != "c2" || !solo || !update.OK {
		t.Fatalf("at %q, update %+v after downloading it again", commit, update)
	}
}
