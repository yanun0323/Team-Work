package usecase_test

import (
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// queue answers each model call with the next reply put in it, then with a plain one; it keeps what each call asked.
type queue struct {
	mu      sync.Mutex
	replies []model.ModelReply
	seen    []model.ModelRequest
}

func (q *queue) next(req model.ModelRequest) (model.ModelReply, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.seen = append(q.seen, req)
	if len(q.replies) == 0 {
		return say("好"), nil
	}
	out := q.replies[0]
	q.replies = q.replies[1:]
	return out, nil
}

// talk runs one chat of speaker in company teamID, the model answering with replies in turn, and gives what it asked.
func (q *queue) talk(t *testing.T, r *rig, teamID, speaker string, replies ...model.ModelReply) []model.ModelRequest {
	t.Helper()
	q.mu.Lock()
	q.replies, q.seen = replies, nil
	q.mu.Unlock()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: teamID, ReplicaID: speaker, Text: "做事"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	q.mu.Lock()
	defer q.mu.Unlock()
	return slices.Clone(q.seen)
}

// toolResult is the result the model was given last in req.
func toolResult(req model.ModelRequest) (string, bool) {
	for _, b := range req.Messages[len(req.Messages)-1].Content {
		if b.Type == enum.BlockToolResult {
			return b.Text, b.IsError
		}
	}
	return "", false
}

// A company's notes are read and written by everyone working in it, the staffing agency's employees included, and
// by no one elsewhere; an employee's own go with them to every company.
func TestCompanyMemoryStaysInItsCompanyAndOwnMemoryTravels(t *testing.T) {
	t.Parallel()
	q := &queue{}
	r := newRig(t, q.next)
	b := secondTeam(t, r)
	hal, err := r.e.Hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Hal", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}

	// in A, the owner keeps a company note, twice; Hal keeps one of his own, twice
	q.talk(t, r, r.team.ID, r.owner.ID, call("remember", map[string]any{"text": "A 用 npm 管套件"}), call("remember", map[string]any{"text": "A 用 npm 管套件"}))
	q.talk(t, r, r.team.ID, hal.ID, call("remember", map[string]any{"text": "改之前先讀測試", "scope": "mine"}), call("remember", map[string]any{"text": "改之前先讀測試", "scope": "mine"}))
	w := r.world()
	a := w.Teams[r.team.ID].Memory
	if len(a) != 1 || a[0].By != r.owner.ID || len(w.Replicas[r.owner.ID].Memory) != 0 {
		t.Fatalf("company A = %+v", a)
	}
	if own := w.Replicas[hal.ID].Memory; len(own) != 1 || own[0].Text != "改之前先讀測試" || len(w.Teams[b.ID].Memory) != 0 {
		t.Fatalf("Hal's own = %+v", own)
	}
	aNote := a[0].ID

	// in A, Hal reads the company's note, by whom, and his own after it
	seen := q.talk(t, r, r.team.ID, hal.ID)
	system := seen[0].System
	company, mine := strings.Index(system, "# Company memory"), strings.Index(system, "# Your memory")
	if company < 0 || mine < company || !strings.Contains(system[company:mine], ", "+r.owner.Name+"] A 用 npm 管套件") || !strings.Contains(system[mine:], "改之前先讀測試") {
		t.Fatalf("Hal in A:\n%s", system)
	}

	// in B, Hal reads his own and not A's; he cannot forget A's note from there
	seen = q.talk(t, r, b.ID, hal.ID,
		call("search_memory", map[string]any{"query": "npm 測試"}),
		call("forget", map[string]any{"id": aNote}))
	system = seen[0].System
	if strings.Contains(system, "A 用 npm") || strings.Contains(system, "# Company memory") || !strings.Contains(system, "# Your memory") || !strings.Contains(system, "改之前先讀測試") {
		t.Fatalf("Hal in B:\n%s", system)
	}
	if found, _ := toolResult(seen[1]); strings.Contains(found, "npm") || !strings.Contains(found, "yours [") || !strings.Contains(found, "改之前先讀測試") {
		t.Fatalf("search in B: %q", found)
	}
	if text, isErr := toolResult(seen[2]); !isErr || !strings.Contains(text, "no note with id "+aNote) {
		t.Fatalf("forget in B: %q %v", text, isErr)
	}
	if got := r.world().Teams[r.team.ID].Memory; len(got) != 1 || got[0].ID != aNote {
		t.Fatalf("A's note after B tried to forget it: %+v", got)
	}

	// in A, the search finds both, each marked
	seen = q.talk(t, r, r.team.ID, hal.ID, call("search_memory", map[string]any{"query": "npm 測試"}))
	if found, _ := toolResult(seen[1]); !strings.Contains(found, "company ["+aNote+", ") || !strings.Contains(found, "yours [") {
		t.Fatalf("search in A: %q", found)
	}

	// someone who has left: their company note stays, by a former employee
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	r.e.RememberFor(r.team.ID, bo.ID, "A 的主分支是 main")
	r.e.Remember(bo.ID, "Bo 自己的習慣")
	if err := r.e.Fire(bo.ID, r.owner.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Teams[r.team.ID].Memory; len(got) != 2 || got[0].By != bo.ID {
		t.Fatalf("after Bo left: %+v", got)
	}
	seen = q.talk(t, r, r.team.ID, hal.ID)
	if !strings.Contains(seen[0].System, ", former employee] A 的主分支是 main") || strings.Contains(seen[0].System, "Bo 自己的習慣") {
		t.Fatalf("after Bo left:\n%s", seen[0].System)
	}

	// a company deleted takes its notes with it, and no one's own
	q.talk(t, r, b.ID, hal.ID, call("remember", map[string]any{"text": "B 的事"}))
	if got := r.world().Teams[b.ID].Memory; len(got) != 1 {
		t.Fatalf("company B = %+v", got)
	}
	if err := r.e.DeleteTeam(b.ID, nil); err != nil {
		t.Fatal(err)
	}
	w = r.world()
	if w.Teams[b.ID] != nil || len(w.Replicas[hal.ID].Memory) != 1 || len(w.Teams[r.team.ID].Memory) != 2 {
		t.Fatalf("after B was deleted: Hal's own %+v, A's %+v", w.Replicas[hal.ID].Memory, w.Teams[r.team.ID].Memory)
	}
}

// At the airport there is no company: no memory tools and no notes in the prompt.
func TestAirportChatKeepsNoNotes(t *testing.T) {
	t.Parallel()
	q := &queue{}
	r := newRig(t, q.next)
	r.e.Remember(r.owner.ID, "自己的事")
	r.e.RememberFor(r.team.ID, r.owner.ID, "公司的事")
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.seen) == 0 {
		t.Fatal("no model call")
	}
	req := q.seen[0]
	for _, tool := range req.Tools {
		if tool.Name == "remember" || tool.Name == "forget" || tool.Name == "search_memory" {
			t.Fatalf("the airport has %s", tool.Name)
		}
	}
	if strings.Contains(req.System, "# Company memory") || strings.Contains(req.System, "# Your memory") || strings.Contains(req.System, "的事") {
		t.Fatalf("the airport's prompt has notes:\n%s", req.System)
	}
}
