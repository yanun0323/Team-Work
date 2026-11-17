package delivery

import (
	"net/http/httptest"
	"testing"
)

func TestReplaceReplicaModelAPI(t *testing.T) {
	s, _ := islandServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	url := srv.URL + "/api/v1/replicas/replace-model"
	for _, body := range []string{`{`, `{}`, `{"from":"m","to":"m"}`, `{"from":"old","to":"missing"}`, `{"from":"old","to":"m","effort":"bad"}`} {
		if code, out := send(t, "POST", url, body); code != 400 || out["error"] == nil {
			t.Fatalf("%s: %d %v", body, code, out)
		}
	}
	if code, out := send(t, "POST", url, `{"from":"retired","to":"m"}`); code != 200 || out["changed"] != float64(0) {
		t.Fatal(code, out)
	}
}
