package usecase_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/semantic"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// What the user adds, rewrites or removes, in a company's memory or an employee's own, is what the very next
// search_memory gives and ranks: nothing old is kept for it.
func TestSearchMemorySeesWhatTheUserChanges(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	var mu sync.Mutex
	var given []string
	r.e.SetRankNotes(func(_ context.Context, _ string, notes []semantic.Note) ([]string, bool) {
		mu.Lock()
		defer mu.Unlock()
		given = nil
		var ids []string
		for _, n := range notes {
			given = append(given, n.Text)
			ids = append(ids, n.ID)
		}
		return ids, true
	})
	search := func() (string, []string) {
		t.Helper()
		mu.Lock()
		given = nil
		mu.Unlock()
		got := r.e.SearchMemory(r.team.ID, r.owner.ID, "怎麼上線")
		if got.IsError {
			t.Fatalf("%+v", got)
		}
		mu.Lock()
		defer mu.Unlock()
		return got.Text, slices.Clone(given)
	}

	note, err := r.e.AddCompanyNote(r.team.ID, "部署用 make deploy")
	if err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); !strings.Contains(text, "company ["+note.ID+", ") || !slices.Equal(seen, []string{"部署用 make deploy"}) {
		t.Fatalf("added: %q %v", text, seen)
	}
	if _, err := r.e.UpdateCompanyNote(r.team.ID, note.ID, "部署改用 make release"); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); !strings.Contains(text, "make release") || strings.Contains(text, "make deploy") || !slices.Equal(seen, []string{"部署改用 make release"}) {
		t.Fatalf("rewritten: %q %v", text, seen)
	}
	if err := r.e.DeleteCompanyNote(r.team.ID, note.ID); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); text != "No notes match." || len(seen) != 0 {
		t.Fatalf("removed: %q %v", text, seen)
	}

	own := []model.MemoryEntry{{ID: "mem-own", Text: "先讀再改", Source: "user", At: 86400}}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &own}); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); !strings.Contains(text, "yours [mem-own, ") || !slices.Equal(seen, []string{"先讀再改"}) {
		t.Fatalf("own added: %q %v", text, seen)
	}
	own[0].Text = "先跑測試再改"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &own}); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); !strings.Contains(text, "先跑測試再改") || strings.Contains(text, "先讀再改") || !slices.Equal(seen, []string{"先跑測試再改"}) {
		t.Fatalf("own rewritten: %q %v", text, seen)
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Memory: &[]model.MemoryEntry{}}); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); text != "No notes match." || len(seen) != 0 {
		t.Fatalf("own removed: %q %v", text, seen)
	}
}
