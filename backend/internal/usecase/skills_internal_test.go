package usecase

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
)

func TestSkillsInFindsSkillsSortedIntoCategories(t *testing.T) {
	t.Parallel()
	// a pack like mattpocock/skills: skills/<category>/<skill>/SKILL.md, with folders the search must pass over
	root := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("skills/engineering/tdd/SKILL.md", "---\nname: tdd\ndescription: 先寫測試\n---\n")
	write("skills/engineering/tdd/nested/SKILL.md", "---\nname: nested\n---\n")
	write("skills/productivity/handoff/SKILL.md", "---\nname: handoff\n---\n")
	write("skills/engineering/README.md", "not a skill")
	write("skills/.hidden/secret/SKILL.md", "---\nname: secret\n---\n")
	write("skills/node_modules/dep/SKILL.md", "---\nname: dep\n---\n")
	write("skills/a/b/c/d/e/SKILL.md", "---\nname: too-deep\n---\n")

	var names []string
	for _, s := range skillsIn(root, "", nil, []string{}) {
		names = append(names, s.name)
	}
	if want := []string{"tdd", "handoff"}; !slices.Equal(names, want) {
		t.Fatalf("skills = %v, want %v", names, want)
	}
}

func TestSkillsInFallsBackToTheRoot(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "group", "review"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "group", "review", "SKILL.md"), []byte("---\nname: review\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := skillsIn(root, "", nil, nil); len(got) != 1 || got[0].name != "review" {
		t.Fatalf("skills = %+v, want review", got)
	}
}

func TestSkillsMarkedUserOnlyStayOutOfThePromptButAnswerToTheirName(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		path := filepath.Join(root, "skills", name, "SKILL.md")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("release", "---\nname: release\ndescription: 發布新版本\ndisable-model-invocation: true\n---\n\nPublish it.\n")
	// the same words in the body, not the frontmatter, mark nothing
	write("guide", "---\nname: guide\ndescription: 寫技能\n---\n\nSet disable-model-invocation: true\n")

	skills := skillsIn(root, "", nil, nil)
	prompt := skillsPrompt(skills)
	if strings.Contains(prompt, "release") {
		t.Fatalf("prompt lists the user-only skill:\n%s", prompt)
	}
	if !strings.Contains(prompt, "- guide: 寫技能") {
		t.Fatalf("prompt leaves out guide:\n%s", prompt)
	}
	if got := mentionedSkills("請用 $release 發布", skills); len(got) != 1 || !strings.Contains(got[0], "Publish it.") {
		t.Fatalf("$release = %q, want its instructions", got)
	}
	at := slices.IndexFunc(skills, func(s skill) bool { return s.name == "release" })
	if got := skillsPrompt(skills[at : at+1]); got != "" {
		t.Fatalf("prompt with only user-only skills = %q, want none", got)
	}
}

// fetchedRepo is a Git whose every repo is already fetched to dir.
type fetchedRepo struct {
	adapter.Git
	dir string
}

func (f fetchedRepo) Fetch(context.Context, string, string) (string, error) { return f.dir, nil }

func (f fetchedRepo) Cached(string, string) bool { return false }

func TestLoadSkillsReadsAFolderInTheRepo(t *testing.T) {
	t.Parallel()
	// a repo of plugins like cursor/plugins: <plugin>/skills/<skill>/SKILL.md
	root := t.TempDir()
	for _, rel := range []string{"pstack/skills/ship/SKILL.md", "other/skills/lint/SKILL.md"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.Dir(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, rel), []byte("---\nname: "+filepath.Base(filepath.Dir(rel))+"\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := &Engine{git: fetchedRepo{dir: root}}
	pack := func(path string) []packRoot {
		return []packRoot{{source: model.BlueprintSource{Kind: "git", Repo: "https://github.com/cursor/plugins", Path: path}}}
	}
	found, _, problems := e.loadSkills(context.Background(), pack("pstack/"))
	if len(problems) > 0 || len(found) != 1 || found[0].name != "ship" {
		t.Fatalf("skills = %+v, problems = %v, want ship alone", found, problems)
	}
	if found, _, problems := e.loadSkills(context.Background(), pack("../outside")); len(found) > 0 || len(problems) != 1 {
		t.Fatalf("a folder outside the repo gave skills = %+v, problems = %v", found, problems)
	}
}

func TestARepoCannotLinkOutOfItself(t *testing.T) {
	t.Parallel()
	outside, repo := t.TempDir(), t.TempDir()
	writeSkill(t, outside, "private")
	writeSkill(t, outside, "loose")
	os.WriteFile(filepath.Join(outside, "role.md"), []byte("secret role"), 0o644)
	writeSkill(t, repo, "skills/kept")
	os.Symlink(filepath.Join(outside, "private"), filepath.Join(repo, "skills", "private")) // a skill folder
	os.MkdirAll(filepath.Join(repo, "skills", "file"), 0o755)
	os.Symlink(filepath.Join(outside, "loose", "SKILL.md"), filepath.Join(repo, "skills", "file", "SKILL.md")) // a skill file
	os.Symlink("kept", filepath.Join(repo, "skills", "alias"))                                                 // inside: fine
	os.Symlink(outside, filepath.Join(repo, "out"))                                                            // a pack folder
	os.Symlink(filepath.Join(outside, "role.md"), filepath.Join(repo, "AGENTS.md"))

	e := &Engine{git: fetchedRepo{dir: repo}}
	pack := func(kind, path string) []packRoot {
		return []packRoot{{source: model.BlueprintSource{Kind: kind, Repo: "https://github.com/a/b", Path: path}}}
	}
	found, roots, _ := e.loadSkills(context.Background(), pack("git", ""))
	var names []string
	for _, s := range found {
		names = append(names, s.name)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"kept"}) { // alias is kept again, under the same name
		t.Fatalf("skills = %v", names)
	}
	for _, r := range roots {
		if !insideDir(repo, r) {
			t.Fatalf("a folder outside the repo became readable: %s", r)
		}
	}
	if found, _, problems := e.loadSkills(context.Background(), pack("git", "out")); len(found) > 0 || len(problems) != 1 {
		t.Fatalf("a pack folder linked out gave skills = %+v, problems = %v", found, problems)
	}
	if items := itemsAt(model.Source{Kind: "git"}, repo); len(items) != 2 {
		t.Fatalf("items = %+v", items)
	}
	if got, _ := e.ownPrompt(context.Background(), &model.BlueprintSource{Kind: "git", Repo: "https://github.com/a/b"}); got != "" {
		t.Fatalf("the role came from outside the repo: %q", got)
	}

	// a folder the user picked keeps its links
	local := []packRoot{{source: model.BlueprintSource{Kind: "local", Path: repo}}}
	if found, _, _ := e.loadSkills(context.Background(), local); len(found) != 3 {
		t.Fatalf("a local folder's links were dropped: %+v", found)
	}
}

func TestBlueprintSkillsNamesWhatEachPackBrings(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, name := range []string{"ship", "lint", "deploy"} {
		if err := os.MkdirAll(filepath.Join(root, "skills", name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "skills", name, "SKILL.md"), []byte("---\nname: "+name+"\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git := &model.BlueprintSource{Kind: "git", Repo: "https://github.com/a/b"}
	bp := &model.Blueprint{ID: "bp1", Skills: []model.SkillPack{
		{Source: git, Exclude: []string{"deploy"}},
		{Source: &model.BlueprintSource{Kind: "local", Path: filepath.Join(root, "missing")}, Exclude: []string{}},
	}}
	e := &Engine{git: fetchedRepo{dir: root}, w: &model.World{Blueprints: map[string]*model.Blueprint{"bp1": bp}}}
	got, err := e.BlueprintSkills(context.Background(), "bp1")
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got[0])
	if len(got) != 2 || !slices.Equal(got[0], []string{"lint", "ship"}) || len(got[1]) != 0 {
		t.Fatalf("skills = %q, want [lint ship] and none", got)
	}
}
