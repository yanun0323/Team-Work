package delivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Checking on a paired computer learns what this one may do on its island, as it says now, for ghost companies to show.
func TestCheckLearnsWhatThePeerGrants(t *testing.T) {
	// the island checked on calls itself what the checker calls it
	dir := t.TempDir()
	writePeer(t, dir, map[string]any{"access": "operate"})
	raw, _ := os.ReadFile(filepath.Join(dir, "tower-private.json"))
	var saved map[string]any
	_ = json.Unmarshal(raw, &saved)
	saved["Me"].(map[string]any)["id"] = "peer"
	raw, _ = json.Marshal(saved)
	if err := os.WriteFile(filepath.Join(dir, "tower-private.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	receiver := openTower(t, dir, offlineTower{})
	sender := pairedTower(t, &lostResponseNetwork{handler: NewGateway(receiver, http.NotFoundHandler())})
	p, err := sender.Check(context.Background(), "peer")
	if err != nil || p.Status != "online" || p.Granted != "operate" {
		t.Fatal(p, err)
	}
	if _, err := receiver.SetAccess("peer", "view"); err != nil {
		t.Fatal(err)
	}
	if p, err = sender.Check(context.Background(), "peer"); err != nil || p.Granted != "view" {
		t.Fatal(p, err)
	}
}

// A ghost company is put up, moved and taken away on this computer alone, and only for a computer paired with it;
// the same paths are shut to a paired computer working this island from afar.
func TestGhostsLocalOnlyAndForPairedComputers(t *testing.T) {
	here, engine := islandServer(t)
	here.EnableTowers(pairedTower(t, offlineTower{}))
	srv := httptest.NewServer(here.Handler())
	t.Cleanup(srv.Close)
	at := func(x int) string { return `{"at":[` + strconv.Itoa(x) + `,10],"style":"castle","seed":3}` }

	if status, body := send(t, "POST", srv.URL+"/api/v1/ghosts", `{"peerId":"stranger","teamId":"team-1","name":"Acme","plot":`+at(40)+`}`); status != 400 {
		t.Fatal("a ghost of a computer not paired:", status, body)
	}
	status, body := send(t, "POST", srv.URL+"/api/v1/ghosts", `{"peerId":"peer","teamId":"team-1","name":"Acme","plot":`+at(40)+`}`)
	if status != 201 || body["peerId"] != "peer" || body["teamId"] != "team-1" {
		t.Fatal(status, body)
	}
	id := body["id"].(string)
	if status, body := send(t, "PATCH", srv.URL+"/api/v1/ghosts/"+id, `{"name":"Acme 2"}`); status != 204 {
		t.Fatal(status, body)
	}
	raw, _ := engine.Snapshot()
	w := model.NewWorld()
	_ = json.Unmarshal(raw, w)
	if g := w.Ghosts[id]; g == nil || g.Name != "Acme 2" {
		t.Fatalf("not renamed: %+v", g)
	}
	if status, _ := send(t, "DELETE", srv.URL+"/api/v1/ghosts/"+id, ""); status != 204 {
		t.Fatal(status)
	}
	if status, _ := send(t, "DELETE", srv.URL+"/api/v1/ghosts/"+id, ""); status != 404 {
		t.Fatal("deleted twice:", status)
	}

	g := NewGateway(pairedTower(t, offlineTower{}), here.Handler())
	for _, method := range []string{"POST", "PATCH", "DELETE"} {
		path := "/api/v1/ghosts"
		if method != "POST" {
			path += "/ghost-1"
		}
		if w := gatewayRequest(g, method, path, testToken, method, `{}`); w.Code != 403 || !strings.Contains(w.Body.String(), "remote_unavailable") {
			t.Fatal(method, w.Code, w.Body.String())
		}
	}
}
