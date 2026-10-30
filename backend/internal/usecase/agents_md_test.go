package usecase_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/usecase"
	"github.com/yanun0323/mho-company/pkg/jsonx"
)

func writeAgents(t *testing.T, folder, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(folder, "AGENTS.md"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPromptFollowsAgentsFile(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	file := filepath.Join(r.folder, "AGENTS.md")
	prompt := func() string { return r.world().Teams[r.team.ID].Prompt }

	// a company starts with the file its project already has
	folder := t.TempDir()
	writeAgents(t, folder, "專案規則")
	team, err := r.e.CreateTeam(context.Background(), usecase.NewTeam{Name: "有檔案", Folder: folder})
	if err != nil {
		t.Fatal(err)
	}
	if team.Prompt != "專案規則" {
		t.Fatalf("%q", team.Prompt)
	}

	// no prompt, no file
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("a file appeared: %v", err)
	}
	// typing in the app writes the file
	text := "第一行\n第二行\n"
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Prompt: &text}); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != text {
		t.Fatalf("%q", raw)
	}
	// changes made outside the app come back
	writeAgents(t, r.folder, "外面改的")
	if err := r.e.RefreshPrompt(r.team.ID); err != nil {
		t.Fatal(err)
	}
	if prompt() != "外面改的" {
		t.Fatalf("%q", prompt())
	}
	// emptying keeps the file; deleting the file empties the prompt
	empty := ""
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Prompt: &empty}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(file); err != nil || info.Size() != 0 {
		t.Fatalf("%v %v", info, err)
	}
	writeAgents(t, r.folder, "還在")
	if err := r.e.RefreshPrompt(r.team.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := r.e.RefreshPrompt(r.team.ID); err != nil {
		t.Fatal(err)
	}
	if prompt() != "" {
		t.Fatalf("%q", prompt())
	}
}

func TestFailedPromptWriteChangesNothing(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	// a folder in the file's place can't be written
	if err := os.Mkdir(filepath.Join(r.folder, "AGENTS.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	text := "寫不進去"
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Prompt: &text}); err == nil {
		t.Fatal("no error")
	}
	if got := r.world().Teams[r.team.ID].Prompt; got != "" {
		t.Fatalf("%q", got)
	}
}

func TestEmployeeGetsTheLatestAgentsFile(t *testing.T) {
	var mu sync.Mutex
	var system string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		defer mu.Unlock()
		system = req.System
		return call("submit_handoff", handoff), nil
	})
	writeAgents(t, r.folder, "剛剛才改的規則")
	r.task(r.flow.ID)
	r.wait("the employee to start", func(*model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return system != ""
	})
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(system, "剛剛才改的規則") {
		t.Fatal(system)
	}
}

func TestSavedPromptsMoveToAgentsFiles(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	r.e.Close()
	has, none := t.TempDir(), t.TempDir()
	writeAgents(t, has, "專案自己的")
	doc := func(kind, id string, v map[string]any) model.Doc {
		raw, err := jsonx.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return model.Doc{Kind: kind, ID: id, Data: raw}
	}
	team := func(id, folder string) model.Doc {
		return doc("team", id, map[string]any{"id": id, "name": id, "folder": folder, "prompt": "舊的", "branches": []string{}})
	}
	save := []model.Doc{team("old-has", has), team("old-none", none), doc("meta", "world", map[string]any{"seq": 1000, "presets": true})}
	if err := r.store.Apply(context.Background(), save, nil); err != nil {
		t.Fatal(err)
	}
	newEngine(t, r)
	if raw, _ := os.ReadFile(filepath.Join(none, "AGENTS.md")); string(raw) != "舊的" {
		t.Fatalf("%q", raw)
	}
	w := r.world()
	if w.Teams["old-has"].Prompt != "專案自己的" || w.Teams["old-none"].Prompt != "舊的" {
		t.Fatalf("%q %q", w.Teams["old-has"].Prompt, w.Teams["old-none"].Prompt)
	}
}
