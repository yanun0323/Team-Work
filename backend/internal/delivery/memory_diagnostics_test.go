package delivery

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
	"testing/fstest"

	"github.com/rs/zerolog"
)

func TestMemoryDiagnosticsDisabled(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.Frontend(fstest.MapFS{"index.html": {Data: []byte("app")}})
	for _, path := range []string{"/api/v1/diagnostics/memory", "/api/v1/diagnostics/heap", "/debug/pprof/heap"} {
		r := httptest.NewRequest(http.MethodGet, "http://localhost"+path, nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", path, w.Code)
		}
	}
}

func TestMemoryDiagnostics(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableMemoryDiagnostics()
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/v1/diagnostics/memory")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got struct {
		PID            int              `json:"pid"`
		GoVersion      string           `json:"goVersion"`
		Goroutines     int              `json:"goroutines"`
		MemProfileRate int              `json:"memProfileRate"`
		Memory         runtime.MemStats `json:"memory"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || got.PID != os.Getpid() || got.GoVersion != runtime.Version() || got.Goroutines < 1 || got.MemProfileRate != runtime.MemProfileRate || got.Memory.HeapAlloc == 0 || got.Memory.Sys < got.Memory.HeapSys || got.Memory.HeapIdle < got.Memory.HeapReleased {
		t.Fatalf("invalid memory report: status=%d report=%+v", res.StatusCode, got)
	}
	if res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe response headers: %v", res.Header)
	}

	for _, query := range []string{"", "?gc=0", "?gc=1"} {
		t.Run("heap"+query, func(t *testing.T) {
			res, err := http.Get(srv.URL + "/api/v1/diagnostics/heap" + query)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/octet-stream" || res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("heap response: status=%d headers=%v", res.StatusCode, res.Header)
			}
			z, err := gzip.NewReader(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			defer z.Close()
			raw, err := io.ReadAll(z)
			if err != nil || !bytes.Contains(raw, []byte("inuse_space")) || !bytes.Contains(raw, []byte("alloc_space")) {
				t.Fatalf("missing heap profile sample types: %v", err)
			}
		})
	}
}

func TestMemoryDiagnosticsRejectInvalidRequests(t *testing.T) {
	s := NewServer(nil, nil, nil, nil, []string{origin}, zerolog.Nop())
	s.EnableMemoryDiagnostics()
	for _, tt := range []struct {
		name, path, peer, host, origin string
		status                         int
	}{
		{"remote peer", "/memory", "192.0.2.1:1234", "localhost", "", 403},
		{"missing peer", "/heap", "", "localhost", "", 403},
		{"bad host", "/memory", "127.0.0.1:1234", "evil.example", "", 403},
		{"bad origin", "/heap", "127.0.0.1:1234", "localhost", "https://evil.example", 403},
		{"unknown query", "/heap?seconds=10", "127.0.0.1:1234", "localhost", "", 400},
		{"bad gc", "/heap?gc=true", "127.0.0.1:1234", "localhost", "", 400},
		{"empty gc", "/heap?gc=", "127.0.0.1:1234", "localhost", "", 400},
		{"duplicate gc", "/heap?gc=0&gc=1", "127.0.0.1:1234", "localhost", "", 400},
		{"malformed query", "/heap?gc=%zz", "127.0.0.1:1234", "localhost", "", 400},
		{"memory is read only", "/memory?gc=1", "127.0.0.1:1234", "localhost", "", 400},
		{"IPv6 loopback", "/memory", "[::1]:1234", "[::1]:8787", origin, 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/diagnostics"+tt.path, nil)
			r.RemoteAddr, r.Host = tt.peer, tt.host
			r.Header.Set("Origin", tt.origin)
			// Forwarded headers must never turn a remote peer into a local one.
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tt.status, w.Body.String())
			}
			if tt.status >= 400 {
				var body struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.Code == "" {
					t.Fatalf("missing API error envelope: %s", w.Body.String())
				}
			}
		})
	}
	for _, path := range []string{"/api/v1/diagnostics/heap", "/api/v1/diagnostics/memory"} {
		r := httptest.NewRequest(http.MethodPost, "http://localhost"+path, nil)
		r.RemoteAddr = "127.0.0.1:1234"
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST %s: status=%d", path, w.Code)
		}
	}
}
