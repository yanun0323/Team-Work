package usecase_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// skillsRepo is a Git repo on this computer with a skill in it, on branch main; commit adds to it and gives the new
// version.
type skillsRepo struct {
	t   *testing.T
	dir string
}

func newSkillsRepo(t *testing.T, skills ...string) *skillsRepo {
	t.Helper()
	g := &skillsRepo{t: t, dir: t.TempDir()}
	g.git("init", "-q", "-b", "main")
	for _, name := range skills {
		g.write(filepath.Join("skills", name, "SKILL.md"), "---\nname: "+name+"\n---\n")
	}
	g.write("README.md", "repo")
	g.commit()
	return g
}

func (g *skillsRepo) git(args ...string) string {
	g.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = g.dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		g.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (g *skillsRepo) write(rel, text string) {
	g.t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(g.dir, rel)), 0o755); err != nil {
		g.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(g.dir, rel), []byte(text), 0o644); err != nil {
		g.t.Fatal(err)
	}
}

func (g *skillsRepo) commit() string {
	g.git("add", "-A")
	g.git("commit", "-q", "-m", "change")
	return g.git("rev-parse", "HEAD")
}

func skillsFrom(repo string) []map[string]any {
	return []map[string]any{{"source": map[string]any{"kind": "git", "repo": repo, "ref": "main"}}}
}

func sourceOf(w *model.World, repo string) *model.Source {
	for _, s := range w.Sources {
		if s.Kind == "git" && s.Repo == repo {
			return s
		}
	}
	return nil
}

// A repo an employee brings is read before it is kept, and kept at the version read; other sources, broken or not,
// are not read again.
func TestANewBlueprintKeepsTheRepoAtTheVersionRead(t *testing.T) {
	r, m := manageRig(t)
	// a source that cannot be read, already kept and waiting for a version, does not stop this one
	if _, err := r.e.CreateBlueprint(model.Blueprint{Name: "壞", Skills: []model.SkillPack{{Source: &model.BlueprintSource{Kind: "git", Repo: filepath.Join(t.TempDir(), "gone"), Ref: "main"}}}}); err != nil {
		t.Fatal(err)
	}
	repo := newSkillsRepo(t, "ship")
	head := repo.git("rev-parse", "HEAD")

	inChat(t, r, m, doing("save_blueprint", map[string]any{"name": "新藍圖", "skills": skillsFrom(repo.dir)}))
	res := lastResult(t, r)
	if res.IsError || !strings.Contains(res.Text, repo.dir+" main @ "+head[:7]) {
		t.Fatalf("%+v", res)
	}
	if s := sourceOf(r.world(), repo.dir); s == nil || s.Commit != head || s.Latest != head || !s.Upstream {
		t.Fatalf("source = %+v, want it at %s", s, head)
	}
}

func TestARepoThatCannotBeReadOrHasNoSkillsIsRefused(t *testing.T) {
	r, m := manageRig(t)
	for name, repo := range map[string]string{
		"no skills": newSkillsRepo(t).dir,
		"no repo":   filepath.Join(t.TempDir(), "gone"),
	} {
		before := r.world()
		inChat(t, r, m, doing("save_blueprint", map[string]any{"name": "新藍圖", "skills": skillsFrom(repo)}))
		if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, repo) || !strings.Contains(res.Text, "nothing was written") {
			t.Fatalf("%s: %+v", name, res)
		}
		w := r.world()
		if len(w.Blueprints) != len(before.Blueprints) || len(w.Sources) != len(before.Sources) {
			t.Fatalf("%s: blueprints %d → %d, sources %d → %d", name, len(before.Blueprints), len(w.Blueprints), len(before.Sources), len(w.Sources))
		}
	}
}

// The card names the repo and the version read; once agreed, that version is kept even when the repo moved on while
// it waited. Refused, nothing is kept.
func TestAChangeKeepsTheVersionTheCardShowed(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	repo := newSkillsRepo(t, "ship")
	head := repo.git("rev-parse", "HEAD")
	args := func() map[string]any {
		return map[string]any{"id": id, "version": versionFrom(t, r, m, "list_blueprints", id), "skills": skillsFrom(repo.dir)}
	}

	c := inChat(t, r, m, doing("save_blueprint", args()))
	w := r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if sourceOf(w, repo.dir) != nil {
		t.Fatal("kept before the user agreed")
	}
	if err := r.e.ResolveChatChange(c.ID, false, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after no", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if w := r.world(); sourceOf(w, repo.dir) != nil || len(w.Blueprints[id].Skills) != 0 {
		t.Fatalf("refused, yet kept: %+v", w.Blueprints[id].Skills)
	}

	c = inChat(t, r, m, doing("save_blueprint", args()))
	w = r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	shown := false
	for _, l := range w.Chats[c.ID].Change.Lines {
		shown = shown || (l.Field == "source" && l.Before == "" && l.After == repo.dir+" main @ "+head[:7])
	}
	if !shown {
		t.Fatalf("the card does not name the new source: %+v", w.Chats[c.ID].Change.Lines)
	}
	repo.write("skills/lint/SKILL.md", "---\nname: lint\n---\n")
	if newer := repo.commit(); newer == head {
		t.Fatal("the repo did not move on")
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after yes", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, head[:7]) {
		t.Fatalf("%+v", res)
	}
	w = r.world()
	if s := sourceOf(w, repo.dir); s == nil || s.Commit != head {
		t.Fatalf("source = %+v, want it at the version shown, %s", s, head)
	}
	if got := w.Blueprints[id].Skills; len(got) != 1 || got[0].SourceID != sourceOf(w, repo.dir).ID {
		t.Fatalf("skills = %+v", got)
	}
}

// The same repo kept at another version while the card waited is not overwritten, nor is the blueprint changed.
func TestARepoKeptElsewhileAtAnotherVersionStopsTheChange(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	repo := newSkillsRepo(t, "ship")
	version := versionFrom(t, r, m, "list_blueprints", id)
	c := inChat(t, r, m, doing("save_blueprint", map[string]any{"id": id, "version": version, "skills": skillsFrom(repo.dir)}))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })

	repo.write("skills/lint/SKILL.md", "---\nname: lint\n---\n")
	newer := repo.commit()
	if _, err := r.e.AddSource(context.Background(), usecase.NewSource{Kind: "git", Repo: repo.dir, Ref: "main"}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after yes", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "nothing was written") {
		t.Fatalf("%+v", res)
	}
	w := r.world()
	if s := sourceOf(w, repo.dir); s == nil || s.Commit != newer {
		t.Fatalf("source = %+v, want it left at %s", s, newer)
	}
	if len(w.Blueprints[id].Skills) != 0 {
		t.Fatalf("written: %+v", w.Blueprints[id].Skills)
	}
}
