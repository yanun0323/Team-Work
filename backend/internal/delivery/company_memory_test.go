package delivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// serveData serves the data in folder data, as a restart would.
func serveData(t *testing.T, data string) (*httptest.Server, func()) {
	t.Helper()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: offline{repository.NewGit(data)}, Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()).Handler())
	return srv, func() { srv.Close(); e.Close(); store.Close() }
}

func teamMemory(t *testing.T, api, teamID string) []any {
	t.Helper()
	_, world := send(t, "GET", api+"/world", "")
	team, _ := world["teams"].(map[string]any)[teamID].(map[string]any)
	notes, ok := team["memory"].([]any)
	if !ok {
		t.Fatalf("company memory is not a list: %v", team["memory"])
	}
	return notes
}

func noteError(body map[string]any) any {
	e, _ := body["error"].(map[string]any)
	return e["code"]
}

// The user adds, rewrites and drops a company's notes one at a time, and they are still there after a restart.
func TestCompanyMemoryEndpoints(t *testing.T) {
	data := t.TempDir()
	srv, stop := serveData(t, data)
	api := srv.URL + "/api/v1"
	folder, _ := json.Marshal(t.TempDir())
	_, team := send(t, "POST", api+"/teams", `{"name":"公司","folder":`+string(folder)+`}`)
	id := team["id"].(string)
	if notes := teamMemory(t, api, id); len(notes) != 0 {
		t.Fatalf("a new company has notes: %v", notes)
	}

	code, a := send(t, "POST", api+"/teams/"+id+"/memory", `{"text":"  用 npm  "}`)
	if code != http.StatusCreated || a["text"] != "用 npm" || a["source"] != "user" || a["by"] != nil || a["id"] == "" || a["createdAt"] != a["at"] {
		t.Fatalf("%d %v", code, a)
	}
	_, b := send(t, "POST", api+"/teams/"+id+"/memory", `{"text":"主分支是 main"}`)
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/teams/" + id + "/memory", `{"text":"  "}`},
		{"POST", "/teams/" + id + "/memory", `{}`},
		{"PATCH", "/teams/" + id + "/memory/" + a["id"].(string), `{"text":""}`},
	} {
		if code, body := send(t, c.method, api+c.path, c.body); code != http.StatusBadRequest || noteError(body) != model.CodeInvalid {
			t.Fatalf("%s %s %s: %d %v", c.method, c.path, c.body, code, body)
		}
	}
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/teams/nope/memory", `{"text":"x"}`},
		{"PATCH", "/teams/nope/memory/" + a["id"].(string), `{"text":"x"}`},
		{"PATCH", "/teams/" + id + "/memory/nope", `{"text":"x"}`},
		{"DELETE", "/teams/nope/memory/" + a["id"].(string), ""},
		{"DELETE", "/teams/" + id + "/memory/nope", ""},
	} {
		if code, body := send(t, c.method, api+c.path, c.body); code != http.StatusNotFound || noteError(body) != model.CodeNotFound {
			t.Fatalf("%s %s: %d %v", c.method, c.path, code, body)
		}
	}

	code, edited := send(t, "PATCH", api+"/teams/"+id+"/memory/"+a["id"].(string), `{"text":"用 pnpm"}`)
	if code != http.StatusOK || edited["text"] != "用 pnpm" || edited["source"] != "user" || edited["by"] != nil || edited["id"] != a["id"] || edited["createdAt"] != a["createdAt"] || edited["at"].(float64) < edited["createdAt"].(float64) {
		t.Fatalf("%d %v", code, edited)
	}
	if code, _ := send(t, "DELETE", api+"/teams/"+id+"/memory/"+b["id"].(string), ""); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := send(t, "DELETE", api+"/teams/"+id+"/memory/"+b["id"].(string), ""); code != http.StatusNotFound {
		t.Fatalf("deleted twice: %d", code)
	}
	stop()

	srv, stop = serveData(t, data)
	defer stop()
	notes := teamMemory(t, srv.URL+"/api/v1", id)
	if len(notes) != 1 {
		t.Fatalf("after a restart: %v", notes)
	}
	if n := notes[0].(map[string]any); n["id"] != a["id"] || n["text"] != "用 pnpm" || n["source"] != "user" || n["by"] != nil {
		t.Fatalf("after a restart: %v", n)
	}
}
