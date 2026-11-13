package usecase_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestProjectFilesAreReadOnlyInsideTheFolder(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	outside := t.TempDir()
	for at, body := range map[string]string{
		filepath.Join(r.folder, "docs", "plan.md"): "# 計畫",
		filepath.Join(r.folder, "bin.dat"):         "a\x00b",
		filepath.Join(outside, "secret.txt"):       "x",
	} {
		if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(r.folder, "away")); err != nil {
		t.Fatal(err)
	}

	if text, err := r.e.ProjectFile(r.team.ID, "docs/plan.md"); err != nil || text.Text != "# 計畫" {
		t.Fatalf("%q %v", text, err)
	}
	for _, path := range []string{"../" + filepath.Base(outside) + "/secret.txt", outside + "/secret.txt", "away/secret.txt", "bin.dat", "docs", "nope.md"} {
		if _, err := r.e.ProjectFile(r.team.ID, path); err == nil {
			t.Errorf("%s was read", path)
		}
	}

	if at, err := r.e.ProjectFolder(r.team.ID, "docs/"); err != nil || !strings.HasSuffix(at, "docs") {
		t.Fatalf("%q %v", at, err)
	}
	if at, err := r.e.ProjectFolder(r.team.ID, ""); err != nil || at != r.folder {
		t.Fatalf("an empty path is the company's folder: %q %v", at, err)
	}
	for _, path := range []string{"away", "docs/plan.md", "../"} {
		if _, err := r.e.ProjectFolder(r.team.ID, path); err == nil {
			t.Errorf("%s was opened", path)
		}
	}
}

func TestChatSkillReadsTheSkillOfSomeoneInTheChat(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := filepath.Join(root, "skills", "tdd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: tdd\ndescription: 先寫測試\n---\n紅綠重構"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: root}}}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "用 $tdd"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))

	got, err := r.e.ChatSkill(context.Background(), c.ID, "tdd")
	if err != nil || got.Description != "先寫測試" || !strings.Contains(got.Text, "紅綠重構") || !strings.HasSuffix(got.Path, "SKILL.md") {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := r.e.ChatSkill(context.Background(), c.ID, "nope"); err == nil {
		t.Fatal("a skill nobody has was found")
	}
}

func TestCompanyChatReadsTheSkillsInTheCompanysFolder(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	dir := filepath.Join(r.folder, ".claude", "skills", "tdd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: tdd\ndescription: 專案的測試\n---\n紅綠重構"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "用 $tdd"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if system := r.fake.seen[0].System; !strings.Contains(system, "專案的測試") {
		t.Fatalf("the chat was not told the company's skill:\n%s", system)
	}
	got, err := r.e.ChatSkill(context.Background(), c.ID, "tdd")
	if err != nil || !strings.Contains(got.Text, "紅綠重構") {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestAirportChatUsesTheSkillsOfItsBlueprint(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".agents", "skills", "tdd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: tdd\ndescription: 先寫測試\n---\n紅綠重構"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		got = req
		return say("好"), nil
	})

	skills := r.e.AirportSkills(context.Background())
	if len(skills) != 1 || skills[0].Name != "tdd" || skills[0].Description != "先寫測試" {
		t.Fatalf("%+v", skills)
	}
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "用 $tdd"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	said := ""
	for _, b := range got.Messages[0].Content {
		said += b.Text
	}
	if !strings.Contains(said, "紅綠重構") {
		t.Fatalf("the skill did not come with the message: %s", said)
	}
	skill, err := r.e.ChatSkill(context.Background(), c.ID, "tdd")
	if err != nil || !strings.Contains(skill.Text, "紅綠重構") {
		t.Fatalf("%+v %v", skill, err)
	}
}

func TestAirportChatUsesEverySkill(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSkill := func(root, name, about string) {
		t.Helper()
		dir := filepath.Join(root, "skills", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: "+name+"\ndescription: "+about+"\n---\n"+about+"的做法"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeSkill(filepath.Join(home, ".agents"), "tdd", "全域的測試")
	employees, source := t.TempDir(), t.TempDir()
	writeSkill(employees, "tdd", "員工的測試")
	writeSkill(employees, "review", "審查")
	writeSkill(source, "deploy", "部署")
	writeSkill(employees, "secret", "沒被挑選的")

	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp := *r.world().Blueprints[r.owner.BlueprintID]
	bp.Skills = []model.SkillPack{{Source: &model.BlueprintSource{Kind: "local", Path: employees}, Include: []string{"tdd", "review"}}}
	if err := r.e.SaveBlueprint(bp.ID, bp); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.AddSource(context.Background(), usecase.NewSource{Kind: "local", Path: source}); err != nil {
		t.Fatal(err)
	}

	about := map[string]string{}
	for _, s := range r.e.AirportSkills(context.Background()) {
		about[s.Name] = s.Description
	}
	want := map[string]string{"tdd": "全域的測試", "review": "審查", "deploy": "部署", "secret": "沒被挑選的"}
	if len(about) != len(want) {
		t.Fatalf("%v", about)
	}
	for name, d := range want {
		if about[name] != d {
			t.Fatalf("%s: %q in %v", name, about[name], about)
		}
	}

	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "用 $deploy"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	system := r.fake.seen[0].System
	for _, d := range []string{"全域的測試", "審查", "部署", "沒被挑選的"} {
		if !strings.Contains(system, d) {
			t.Fatalf("the staff were not told %s:\n%s", d, system)
		}
	}
	if strings.Contains(system, "員工的測試") {
		t.Fatalf("a skill by a name already taken was told:\n%s", system)
	}
	for name, text := range map[string]string{"deploy": "部署的做法", "review": "審查的做法", "secret": "沒被挑選的的做法", "tdd": "全域的測試的做法"} {
		got, err := r.e.ChatSkill(context.Background(), c.ID, name)
		if err != nil || !strings.Contains(got.Text, text) {
			t.Fatalf("%s: %+v %v", name, got, err)
		}
	}
	if _, err := r.e.ChatSkill(context.Background(), c.ID, "nope"); err == nil {
		t.Fatal("a skill nobody has was found")
	}
}

func TestAirportFilesBrowseHomeOneFolderAtATime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, f := range []string{"Documents/plan.md", "Documents/Projects/a.go", "Downloads/x.zip", "notes.txt", ".secret/key"} {
		at := filepath.Join(home, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(home, "Documents"), filepath.Join(home, "Docs")); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	list := func(q string) string {
		files, err := r.e.SearchFiles(context.Background(), "", q)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range files {
			if f.Dir {
				out = append(out, f.Path+"/")
			} else {
				out = append(out, f.Path)
			}
		}
		return strings.Join(out, " ")
	}
	for q, want := range map[string]string{
		"":             "Docs/ Documents/ Downloads/ notes.txt",
		"do":           "Docs/ Documents/ Downloads/",
		"Documents/":   "Documents/Projects/ Documents/plan.md",
		"Documents/pl": "Documents/plan.md",
		".":            ".secret/",
		"../":          "",
		"/etc/":        "",
		"Nope/":        "",
	} {
		if got := list(q); got != want {
			t.Errorf("%q: got %q, want %q", q, got, want)
		}
	}

	// what a mention names opens from home too, and nothing outside it
	if text, err := r.e.ProjectFile("", "Documents/plan.md"); err != nil || text.Text != "x" {
		t.Fatalf("%q %v", text, err)
	}
	if folder, err := r.e.ProjectFolder("", "Docs"); err != nil || filepath.Base(folder) != "Documents" {
		t.Fatalf("%q %v", folder, err)
	}
	if folder, err := r.e.ProjectFolder("", ""); err != nil || folder != home {
		t.Fatalf("%q %v", folder, err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "out")); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../secret.txt", filepath.Join(outside, "secret.txt"), "out/secret.txt"} {
		if _, err := r.e.ProjectFile("", bad); err == nil {
			t.Errorf("%s was opened", bad)
		}
	}

	// and what is wrong says home, not the project folder the airport does not have
	if err := os.WriteFile(filepath.Join(home, "a.bin"), []byte{0, 1}, 0o644); err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]string{"nope.txt": "家目錄裡沒有 nope.txt", "a.bin": "a.bin 不是文字檔，請到 Finder 打開"} {
		if _, err := r.e.ProjectFile("", rel); err == nil || err.Error() != want {
			t.Errorf("%s: %v", rel, err)
		}
	}
	if _, _, err := r.e.ProjectImage("", "notes.txt"); err == nil || err.Error() != "notes.txt 不是圖片，請到 Finder 打開" {
		t.Errorf("image: %v", err)
	}
}

func TestAirportChatCanReadWhatTheUserNamesAtHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, "notes.txt"), []byte("在家裡的筆記"), 0o644); err != nil {
		t.Fatal(err)
	}
	var seen []model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		seen = append(seen, req)
		if len(seen) == 1 {
			return call("read_file", map[string]string{"path": filepath.Join(home, "notes.txt")}), nil
		}
		return say("好"), nil
	})
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "看 #notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	if !strings.Contains(seen[0].System, "home folder, "+home) {
		t.Fatalf("system: %s", seen[0].System)
	}
	last := seen[len(seen)-1].Messages
	result := last[len(last)-1].Content[0]
	if result.Type != enum.BlockToolResult || result.IsError || !strings.Contains(result.Text, "在家裡的筆記") {
		t.Fatalf("%+v", result)
	}
}
