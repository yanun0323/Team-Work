package usecase_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/delivery"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// What the user adds, rewrites or removes through HTTP, in a company's memory or an employee's own, is what
// the very next search_memory gives and ranks. The ranker is a stand-in; vector cache tests live in semantic.
func TestSearchMemorySeesWhatTheUserChanges(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	// These routes only need the engine; no model, folder picker or terminal is called.
	srv := httptest.NewServer(delivery.NewServer(r.e, nil, nil, nil, nil, zerolog.Nop()).Handler())
	defer srv.Close()
	request := func(method, path string, body any, want int) []byte {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, srv.URL+"/api/v1"+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != want {
			t.Fatalf("%s %s: %d, want %d: %s", method, path, res.StatusCode, want, out)
		}
		return out
	}
	companyPath := "/teams/" + r.team.ID + "/memory"
	ownPath := "/replicas/" + r.owner.ID
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

	var note model.MemoryEntry
	raw := request("POST", companyPath, map[string]string{"text": "部署用 make deploy"}, http.StatusCreated)
	if err := json.Unmarshal(raw, &note); err != nil {
		t.Fatal(err)
	}
	if text, seen := search(); !strings.Contains(text, "company ["+note.ID+", ") || !slices.Equal(seen, []string{"部署用 make deploy"}) {
		t.Fatalf("added: %q %v", text, seen)
	}
	request("PATCH", companyPath+"/"+note.ID, map[string]string{"text": "部署改用 make release"}, http.StatusOK)
	if text, seen := search(); !strings.Contains(text, "make release") || strings.Contains(text, "make deploy") || !slices.Equal(seen, []string{"部署改用 make release"}) {
		t.Fatalf("rewritten: %q %v", text, seen)
	}
	request("DELETE", companyPath+"/"+note.ID, nil, http.StatusNoContent)
	if text, seen := search(); text != "No notes match." || len(seen) != 0 {
		t.Fatalf("removed: %q %v", text, seen)
	}

	own := []model.MemoryEntry{{ID: "mem-own", Text: "先讀再改", Source: "user", At: 86400}}
	request("PATCH", ownPath, map[string]any{"memory": own}, http.StatusNoContent)
	if text, seen := search(); !strings.Contains(text, "yours [mem-own, ") || !slices.Equal(seen, []string{"先讀再改"}) {
		t.Fatalf("own added: %q %v", text, seen)
	}
	own[0].Text = "先跑測試再改"
	request("PATCH", ownPath, map[string]any{"memory": own}, http.StatusNoContent)
	if text, seen := search(); !strings.Contains(text, "先跑測試再改") || strings.Contains(text, "先讀再改") || !slices.Equal(seen, []string{"先跑測試再改"}) {
		t.Fatalf("own rewritten: %q %v", text, seen)
	}
	request("PATCH", ownPath, map[string]any{"memory": []model.MemoryEntry{}}, http.StatusNoContent)
	if text, seen := search(); text != "No notes match." || len(seen) != 0 {
		t.Fatalf("own removed: %q %v", text, seen)
	}
}
