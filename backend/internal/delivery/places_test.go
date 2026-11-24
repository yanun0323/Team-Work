package delivery

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

// The staffing agency and the landmarks are moved by where their plot's corner goes; a landmark not grown yet is not
// found, and a spot that can't take it is refused.
func TestMoveStaffingAgencyAndLandmarks(t *testing.T) {
	here, engine := islandServer(t)
	srv := httptest.NewServer(here.Handler())
	t.Cleanup(srv.Close)
	if status, body := send(t, "PATCH", srv.URL+"/api/v1/landmarks/park", `{"at":[40,10]}`); status != 404 {
		t.Fatal("a park not grown yet:", status, body)
	}
	if status, body := send(t, "PATCH", srv.URL+"/api/v1/places/staffing", `{"at":[0,-30]}`); status != 400 {
		t.Fatal("onto the airport:", status, body)
	}
	if status, body := send(t, "PATCH", srv.URL+"/api/v1/places/staffing", `{"at":[-8,-8]}`); status >= 300 {
		t.Fatal(status, body)
	}
	raw, _ := engine.Snapshot()
	w := model.NewWorld()
	_ = json.Unmarshal(raw, w)
	if p := w.Places[model.PlaceStaffing]; p == nil || p.At[0] != -8 || p.At[1] != -8 {
		t.Fatalf("staffing agency at %+v", p)
	}
}
