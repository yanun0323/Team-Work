package usecase_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestProjectFilesAreReadOnlyInsideTheFolder(t *testing.T) {
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

	if text, err := r.e.ProjectFile(r.team.ID, "docs/plan.md"); err != nil || text != "# 計畫" {
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
