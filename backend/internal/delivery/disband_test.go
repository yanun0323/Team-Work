package delivery

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Closing a company names who moves to the staffing agency with keep, as often as there are people; a request
// without it, as before, lets everyone go. A wrong name fails it with nothing changed.
func TestDeleteTeamKeepsThosePicked(t *testing.T) {
	data := t.TempDir()
	srv, stop := serveData(t, data)
	api := srv.URL + "/api/v1"
	must := func(method, path string, input any, status int) map[string]any {
		t.Helper()
		raw := ""
		if input != nil {
			b, _ := json.Marshal(input)
			raw = string(b)
		}
		code, body := send(t, method, api+path, raw)
		if code != status {
			t.Fatalf("%s %s: %d %v", method, path, code, body)
		}
		return body
	}
	must("POST", "/providers", map[string]any{"name": "fake", "kind": "compatible", "login": map[string]any{"kind": "apiKey", "apiKey": "test"}}, http.StatusCreated)
	bp := must("POST", "/blueprints", map[string]any{"name": "dev", "prompt": "dev", "tools": []string{"readFile"}}, http.StatusCreated)
	company := func(name string, people ...string) (string, []string) {
		team := must("POST", "/teams", map[string]any{"name": name, "folder": t.TempDir()}, http.StatusCreated)
		var ids []string
		for _, p := range people {
			r := must("POST", "/replicas", map[string]any{"teamId": team["id"], "blueprintId": bp["id"], "name": p, "model": "m"}, http.StatusCreated)
			ids = append(ids, r["id"].(string))
		}
		return team["id"].(string), ids
	}
	a, staff := company("A", "Ada", "Bo")
	b, others := company("B", "Cy")
	hal := must("POST", "/replicas", map[string]any{"teamId": model.StaffingID, "blueprintId": bp["id"], "name": "Hal", "model": "m"}, http.StatusCreated)

	for _, q := range []string{"?keep=nope", "?keep=", "?keep=" + others[0], "?keep=" + hal["id"].(string), "?keep=" + staff[0] + "&keep=" + staff[0]} {
		if code, body := send(t, "DELETE", api+"/teams/"+a+q, ""); code != http.StatusBadRequest || noteError(body) != model.CodeInvalid {
			t.Fatalf("%s: %d %v", q, code, body)
		}
	}
	if code, body := send(t, "DELETE", api+"/teams/nope?keep="+staff[0], ""); code != http.StatusNotFound || noteError(body) != model.CodeNotFound {
		t.Fatalf("no such company: %d %v", code, body)
	}
	world := func() map[string]any {
		_, w := send(t, "GET", api+"/world", "")
		return w
	}
	if w := world(); w["teams"].(map[string]any)[a] == nil || len(w["replicas"].(map[string]any)) != 4 {
		t.Fatalf("a refused close changed things: %v", w["replicas"])
	}

	must("DELETE", "/teams/"+a+"?keep="+staff[1], nil, http.StatusNoContent)
	must("DELETE", "/teams/"+b, nil, http.StatusNoContent) // as before: no one picked, everyone goes
	stop()

	srv, stop = serveData(t, data)
	defer stop()
	_, w := send(t, "GET", srv.URL+"/api/v1/world", "")
	var names []string
	for id, raw := range w["replicas"].(map[string]any) {
		r := raw.(map[string]any)
		if r["teamId"] != model.StaffingID || id == staff[1] {
			t.Fatalf("left: %v", r)
		}
		names = append(names, r["name"].(string))
	}
	if len(names) != 2 || len(w["teams"].(map[string]any)) != 0 {
		t.Fatalf("after closing both: %v, companies %v", names, w["teams"])
	}
}
