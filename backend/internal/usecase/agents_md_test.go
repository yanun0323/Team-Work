package usecase_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
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

func TestGlobalPromptReachesEveryEmployee(t *testing.T) {
	var mu sync.Mutex
	systems := map[string]string{}
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		defer mu.Unlock()
		systems[req.Session] = req.System
		if len(req.Tools) > 0 && slices.ContainsFunc(req.Tools, func(s model.ToolSpec) bool { return s.Name == "submit_handoff" }) {
			return call("submit_handoff", handoff), nil
		}
		return say("好"), nil
	})
	file := filepath.Join(r.data, "AGENTS.md")
	if got, err := r.e.GlobalPrompt(); err != nil || got != "" {
		t.Fatalf("%q %v", got, err)
	}
	// nothing to save, no file
	if err := r.e.SetGlobalPrompt(""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("a file appeared: %v", err)
	}
	if err := r.e.SetGlobalPrompt("全域規則"); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != "全域規則" {
		t.Fatalf("%q", raw)
	}
	writeAgents(t, r.folder, "公司規則")

	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("the chat", chatDone(c.ID))
	r.task(r.flow.ID)
	r.wait("the task's employee", func(*model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return len(systems) > 1
	})
	mu.Lock()
	defer mu.Unlock()
	for session, system := range systems {
		g, co := strings.Index(system, "全域規則"), strings.Index(system, "公司規則")
		if g < 0 || co < g {
			t.Fatalf("%s: %s", session, system)
		}
	}
}

func TestGlobalPromptFollowsItsFile(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	if err := os.WriteFile(filepath.Join(r.data, "AGENTS.md"), []byte("外面改的"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := r.e.GlobalPrompt(); err != nil || got != "外面改的" {
		t.Fatalf("%q %v", got, err)
	}
	// emptying keeps the file, and an empty prompt adds no heading
	if err := r.e.SetGlobalPrompt(""); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(r.data, "AGENTS.md")); err != nil || info.Size() != 0 {
		t.Fatalf("%v %v", info, err)
	}
}

func inOrder(t *testing.T, system string, parts ...string) {
	t.Helper()
	at := 0
	for _, part := range parts {
		i := strings.Index(system[at:], part)
		if i < 0 {
			t.Fatalf("%q missing or out of order in:\n%s", part, system)
		}
		at += i + len(part)
	}
}

func TestPromptSectionsKeepTheirOrder(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if strings.Contains(req.System, "# This step: ") {
			return call("submit_handoff", handoff), nil
		}
		return say("好"), nil
	})
	if err := os.WriteFile(filepath.Join(r.data, "AGENTS.md"), []byte("全域內容"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeAgents(t, r.folder, "公司內容")
	memory := []model.MemoryEntry{{ID: "m", Text: "記憶內容", Source: "work", At: 86400}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &memory}); err != nil {
		t.Fatal(err)
	}
	shared := []string{"# Global rules\n全域內容", "# Company rules\n公司內容", "# Your role\n你是開發者", "# Your memory"}

	task := r.task(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	inOrder(t, r.fake.seen[0].System, append(append([]string{"@path", "user reads in", "submit_handoff", "When instructions in this prompt conflict"}, shared...), "# This step: ", "# Handoff")...)

	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	system := r.fake.seen[len(r.fake.seen)-1].System
	inOrder(t, system, append([]string{"@path", "user reads in", "When instructions in this prompt conflict"}, shared...)...)
	if strings.Contains(system, "This step,") {
		t.Fatalf("a chat has no step:\n%s", system)
	}
}
