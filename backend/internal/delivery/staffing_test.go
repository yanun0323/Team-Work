package delivery

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/tower"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// island is one computer: its engine and its API.
func islandServer(t *testing.T) (*Server, *usecase.Engine) {
	t.Helper()
	data := t.TempDir()
	store, err := repository.NewStore(data)
	if err != nil {
		t.Fatal(err)
	}
	e, err := usecase.NewEngine(context.Background(), usecase.Options{Store: store, Git: offline{repository.NewGit(data)}, Providers: noModels{}, DataDir: data, Log: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close(); store.Close() })
	if _, err := e.AddProvider(context.Background(), usecase.NewProvider{Name: "p", Kind: "compatible", Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "k"}}); err != nil {
		t.Fatal(err)
	}
	return NewServer(e, claude, pickedFolder{}, repository.Terminals{}, []string{origin}, zerolog.Nop()), e
}

func replicasNamed(e *usecase.Engine, name string) []*model.Replica {
	raw, _ := e.Snapshot()
	w := model.NewWorld()
	_ = json.Unmarshal(raw, w)
	var out []*model.Replica
	for _, r := range w.Replicas {
		if r.Name == name {
			out = append(out, r)
		}
	}
	return out
}

// An employee on a paired computer is copied to this island's staffing agency through the tower, once however often
// the request comes; an island out of reach or not letting this one in copies nothing.
func TestCopyEmployeeFromAPairedIsland(t *testing.T) {
	there, thereEngine := islandServer(t)
	team, err := thereEngine.CreateTeam(context.Background(), usecase.NewTeam{Name: "遠方", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	bp, err := thereEngine.CreateBlueprint(model.Blueprint{Name: "Dev", Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	bo, err := thereEngine.Hire(usecase.NewReplica{TeamID: team.ID, BlueprintID: bp.ID, Name: "Bo", Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	receiver := pairedTower(t, offlineTower{})
	gateway := NewGateway(receiver, there.Handler())
	connect := func(transport tower.Transport) (*httptest.Server, *usecase.Engine) {
		here, hereEngine := islandServer(t)
		here.EnableTowers(pairedTower(t, transport))
		srv := httptest.NewServer(here.Handler())
		t.Cleanup(srv.Close)
		return srv, hereEngine
	}
	srv, hereEngine := connect(&lostResponseNetwork{handler: gateway})
	base := srv.URL + "/api/v1/towers/peers/peer/employees/" + bo.ID
	status, preview := send(t, "GET", base, "")
	if status != 200 || preview["name"] != "Bo" || preview["modelOk"] != true {
		t.Fatal(status, preview)
	}
	var first string
	for range 2 {
		status, body := send(t, "POST", base+"/copy", `{"skills":"source"}`, "Idempotency-Key", "copy-1")
		if status != 201 {
			t.Fatal(status, body)
		}
		id := body["replica"].(map[string]any)["id"].(string)
		if first == "" {
			first = id
		} else if id != first {
			t.Fatalf("copied again: %s and %s", first, id)
		}
	}
	if got := replicasNamed(hereEngine, "Bo"); len(got) != 1 || got[0].TeamID != model.StaffingID {
		t.Fatalf("here: %+v", got)
	}
	if got := replicasNamed(thereEngine, "Bo"); len(got) != 1 || got[0].ID != bo.ID || got[0].TeamID != team.ID {
		t.Fatalf("there: %+v", got)
	}
	// the copy works like any of the agency's: moved into a company here
	mine, err := hereEngine.CreateTeam(context.Background(), usecase.NewTeam{Name: "這裡", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if status, body := send(t, "POST", srv.URL+"/api/v1/replicas/"+first+"/move", `{"to":"`+mine.ID+`"}`); status != 201 || body["teamId"] != mine.ID {
		t.Fatal(status, body)
	}

	offline, offlineEngine := connect(offlineTower{})
	if status, body := send(t, "POST", offline.URL+"/api/v1/towers/peers/peer/employees/"+bo.ID+"/copy", `{}`, "Idempotency-Key", "x"); status != 502 {
		t.Fatal(status, body)
	}
	if got := replicasNamed(offlineEngine, "Bo"); len(got) != 0 {
		t.Fatalf("copied while offline: %+v", got)
	}

	if _, err := receiver.SetAllowed("peer", false); err != nil {
		t.Fatal(err)
	}
	denied, deniedEngine := connect(&lostResponseNetwork{handler: gateway})
	if status, body := send(t, "POST", denied.URL+"/api/v1/towers/peers/peer/employees/"+bo.ID+"/copy", `{}`, "Idempotency-Key", "y"); status != 403 || body["error"].(map[string]any)["code"] != "peer_denied" {
		t.Fatal(status, body)
	}
	if got := replicasNamed(deniedEngine, "Bo"); len(got) != 0 {
		t.Fatalf("copied while denied: %+v", got)
	}
}
