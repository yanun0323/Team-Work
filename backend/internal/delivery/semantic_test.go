package delivery

import (
	"net/http"
	"testing"
)

// Without semantic search in this backend the status says unsupported, with every field there; the setting is a
// preference like the others, and a bad value is the usual invalid error.
func TestSemanticSearchStatus(t *testing.T) {
	srv := setup(t)
	code, body := send(t, http.MethodGet, srv.URL+"/api/v1/settings/semantic-search", "")
	if code != http.StatusOK || body["state"] != "unsupported" || body["supported"] != false || body["enabled"] != false || body["active"] != false ||
		body["requiresRestart"] != false || body["error"] != nil {
		t.Fatalf("%d %v", code, body)
	}
	progress, ok := body["progress"].(map[string]any)
	if !ok || progress["totalBytes"] != nil || len(progress) != 6 {
		t.Fatalf("%v", body["progress"])
	}
	if code, _ := send(t, http.MethodPatch, srv.URL+"/api/v1/settings/preferences", `{"semanticSearch":true}`, "Content-Type", "application/json", "Origin", origin); code != http.StatusNoContent {
		t.Fatalf("PATCH %d", code)
	}
	if _, body := send(t, http.MethodGet, srv.URL+"/api/v1/settings/semantic-search", ""); body["enabled"] != true || body["state"] != "unsupported" {
		t.Fatalf("%v", body)
	}
	for _, bad := range []string{`{"semanticSearch":null}`, `{"semanticSearch":"on"}`} {
		code, body := send(t, http.MethodPatch, srv.URL+"/api/v1/settings/preferences", bad, "Content-Type", "application/json", "Origin", origin)
		if code != http.StatusBadRequest || body["error"] == nil {
			t.Fatalf("%s: %d %v", bad, code, body)
		}
	}
}
