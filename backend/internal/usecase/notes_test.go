package usecase_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestNotesLiveInTheCompanysFolder(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	file := filepath.Join(r.folder, ".team-work", "NOTES.md")
	if got, err := r.e.Notes(r.team.ID); err != nil || got != "" {
		t.Fatalf("%q %v", got, err)
	}
	// nothing to save, no file
	if err := r.e.SetNotes(r.team.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("a file appeared: %v", err)
	}
	if err := r.e.SetNotes(r.team.ID, "# 待辦\n- 買咖啡"); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != "# 待辦\n- 買咖啡" {
		t.Fatalf("%q", raw)
	}
	// edited outside the app
	if err := os.WriteFile(file, []byte("外面改的"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := r.e.Notes(r.team.ID); err != nil || got != "外面改的" {
		t.Fatalf("%q %v", got, err)
	}
	// emptying keeps the file
	if err := r.e.SetNotes(r.team.ID, ""); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(file); err != nil || info.Size() != 0 {
		t.Fatalf("%v %v", info, err)
	}
	if _, err := r.e.Notes("nope"); err == nil {
		t.Fatal("notes of no company")
	}
}
