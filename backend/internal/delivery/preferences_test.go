package delivery

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestPreferencesEndpoint(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	if code, body := send(t, "PATCH", api+"/settings/preferences", `{"shadows":false,"defaultTab":"crew"}`); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	for _, raw := range []string{`null`, `[]`, `{"shadows":null}`, `{"shadows":"false"}`, `{"defaultTab":"bogus"}`, `{"unknown":true}`} {
		if code, body := send(t, "PATCH", api+"/settings/preferences", raw); code != http.StatusBadRequest {
			t.Fatalf("%s: %d %v", raw, code, body)
		}
	}
	if code, _ := send(t, "PATCH", api+"/settings/preferences", `{"clouds":false}`); code != http.StatusNoContent {
		t.Fatal(code)
	}
	_, w := send(t, "GET", api+"/world", "")
	p := w["preferences"].(map[string]any)
	if p["shadows"] != false || p["clouds"] != false || p["defaultTab"] != "crew" || p["detail"] != true {
		t.Fatalf("%v", p)
	}
}

func TestCompanyPlotEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	folder, _ := json.Marshal(t.TempDir())
	code, team := send(t, "POST", api+"/teams", `{"name":"plot","folder":`+string(folder)+`,"plot":{"at":[-8,-8],"style":"villa","seed":123}}`)
	if code != http.StatusCreated {
		t.Fatalf("%d %v", code, team)
	}
	id := team["id"].(string)
	if code, body := send(t, "PATCH", api+"/teams/"+id, `{"plot":{"at":[10,10],"style":"brick","seed":321}}`); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	for _, plot := range []string{
		`{"at":[],"style":"villa","seed":1}`,
		`{"at":[1,2,3],"style":"villa","seed":1}`,
		`{"at":[1.5,2],"style":"villa","seed":1}`,
		`{"at":[-20,-30],"style":"villa","seed":1}`,
		`{"at":[100000,0],"style":"villa","seed":1}`,
		`{"at":[400,400],"style":"villa","seed":1}`,
		`{"at":[10,10],"style":"bogus","seed":1}`,
		`{"at":[10,10],"style":"villa","seed":-1}`,
	} {
		if code, body := send(t, "PATCH", api+"/teams/"+id, `{"plot":`+plot+`}`); code != http.StatusBadRequest {
			t.Fatalf("%s: %d %v", plot, code, body)
		}
	}
	folder, _ = json.Marshal(t.TempDir())
	if code, body := send(t, "POST", api+"/teams", `{"name":"overlap","folder":`+string(folder)+`,"plot":{"at":[10,10],"style":"villa","seed":1}}`); code != http.StatusConflict {
		t.Fatalf("%d %v", code, body)
	}
	if code, _ := send(t, "PATCH", api+"/teams/missing", `{"plot":{"at":[10,10],"style":"villa","seed":1}}`); code != http.StatusNotFound {
		t.Fatal(code)
	}
	_, w := send(t, "GET", api+"/world", "")
	p := w["teams"].(map[string]any)[id].(map[string]any)["plot"].(map[string]any)
	if p["style"] != "brick" || p["seed"] != float64(321) {
		t.Fatalf("failed requests changed plot: %v", p)
	}
}

func TestPlotMustFitExpandedIsland(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	folder, _ := json.Marshal(t.TempDir())
	// Nearest-edge distance allowed this before; its far edge exceeds land + 32.
	body := `{"name":"outside","folder":` + string(folder) + `,"plot":{"at":[52,-24],"style":"villa","seed":1}}`
	if code, response := send(t, "POST", api+"/teams", body); code != http.StatusBadRequest {
		t.Fatalf("%d %v", code, response)
	}
	body = `{"name":"inside","folder":` + string(folder) + `,"plot":{"at":[36,-24],"style":"villa","seed":1}}`
	code, team := send(t, "POST", api+"/teams", body)
	if code != http.StatusCreated {
		t.Fatalf("%d %v", code, team)
	}
	// Move relative to the island before the move, including the selected company's land.
	if code, response := send(t, "PATCH", api+"/teams/"+team["id"].(string), `{"plot":{"at":[68,-24],"style":"villa","seed":1}}`); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, response)
	}
}

func TestSoundPreferencesEndpoint(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	_, initial := send(t, "GET", api+"/world", "")
	defaults := initial["preferences"].(map[string]any)
	if defaults["musicVolume"] != float64(100) || defaults["effectsVolume"] != float64(100) {
		t.Fatalf("%v", defaults)
	}
	if code, body := send(t, "PATCH", api+"/settings/preferences", `{"musicVolume":0,"effectsVolume":100,"soundTakeoff":false,"soundLanding":false,"soundFlyover":false,"soundUI":false,"defaultAirportTab":"sound"}`); code != http.StatusNoContent {
		t.Fatalf("%d %v", code, body)
	}
	for _, raw := range []string{`{"musicVolume":-1}`, `{"musicVolume":101}`, `{"effectsVolume":-1}`, `{"effectsVolume":101}`, `{"musicVolume":2.5}`, `{"effectsVolume":"40"}`, `{"soundTakeoff":null}`, `{"soundLanding":0}`, `{"soundFlyover":"false"}`, `{"soundUI":[]}`} {
		if code, body := send(t, "PATCH", api+"/settings/preferences", raw); code != http.StatusBadRequest {
			t.Fatalf("%s: %d %v", raw, code, body)
		}
	}
	if code, _ := send(t, "PATCH", api+"/settings/preferences", `{"soundLanding":true}`); code != http.StatusNoContent {
		t.Fatal(code)
	}
	_, world := send(t, "GET", api+"/world", "")
	prefs := world["preferences"].(map[string]any)
	if prefs["musicVolume"] != float64(0) || prefs["effectsVolume"] != float64(100) || prefs["soundTakeoff"] != false || prefs["soundLanding"] != true || prefs["soundFlyover"] != false || prefs["soundUI"] != false || prefs["defaultAirportTab"] != "prefs" {
		t.Fatalf("%v", prefs)
	}
}

func TestMusicStyleAndNoticePreferences(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	_, initial := send(t, "GET", api+"/world", "")
	defaults := initial["preferences"].(map[string]any)
	if defaults["musicStyle"] != "chiptune" || defaults["soundNotice"] != true {
		t.Fatalf("%v", defaults)
	}
	for _, style := range []string{"piano", "ambient", "bossa", "chiptune"} {
		if code, body := send(t, "PATCH", api+"/settings/preferences", `{"musicStyle":"`+style+`","soundNotice":false}`); code != http.StatusNoContent {
			t.Fatalf("%d %v", code, body)
		}
	}
	for _, raw := range []string{`{"musicStyle":"unknown"}`, `{"musicStyle":null}`, `{"musicStyle":3}`, `{"soundNotice":null}`, `{"soundNotice":"false"}`} {
		if code, body := send(t, "PATCH", api+"/settings/preferences", raw); code != http.StatusBadRequest {
			t.Fatalf("%s: %d %v", raw, code, body)
		}
	}
	_, world := send(t, "GET", api+"/world", "")
	prefs := world["preferences"].(map[string]any)
	if prefs["musicStyle"] != "chiptune" || prefs["soundNotice"] != false || prefs["musicVolume"] != float64(100) {
		t.Fatalf("%v", prefs)
	}
}
