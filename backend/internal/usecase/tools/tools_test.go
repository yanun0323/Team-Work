package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func args(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }

func TestFilesStayInsideTheWorkingDirectory(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	os.WriteFile(secret, []byte("s"), 0o644)
	os.Symlink(outside, filepath.Join(dir, "link"))
	ctx := context.Background()

	if r := (Write{}).Run(ctx, dir, args(map[string]string{"path": "a/b.txt", "content": "hi"})); r.IsError {
		t.Fatal(r.Text)
	}
	if r := (Read{}).Run(ctx, dir, args(map[string]string{"path": "a/b.txt"})); r.IsError || r.Text != "hi" {
		t.Fatalf("%+v", r)
	}
	for _, path := range []string{secret, "../" + filepath.Base(outside) + "/secret.txt", "link/secret.txt", "link/new/x.txt"} {
		if r := (Read{}).Run(ctx, dir, args(map[string]string{"path": path})); !r.IsError {
			t.Errorf("read %s was allowed", path)
		}
		if r := (Write{}).Run(ctx, dir, args(map[string]string{"path": path, "content": "x"})); !r.IsError {
			t.Errorf("write %s was allowed", path)
		}
	}
	if r := (Read{Extra: []string{outside}}).Run(ctx, dir, args(map[string]string{"path": secret})); r.IsError {
		t.Fatalf("a skill folder could not be read: %s", r.Text)
	}
}

func TestCommandReportsFailureAndStops(t *testing.T) {
	dir := t.TempDir()
	if r := (Command{}).Run(context.Background(), dir, args(map[string]string{"command": "echo hi; exit 3"})); !r.IsError || r.Text != "hi\n\n[exit code 3]" {
		t.Fatalf("%q", r.Text)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if r := (Command{}).Run(ctx, dir, args(map[string]string{"command": "sleep 30 & wait"})); !r.IsError {
		t.Fatal("a stopped command reported success")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the command kept running")
	}
}

func TestSearchReadsEitherAnswerFormat(t *testing.T) {
	for _, body := range []string{`{"result":{"content":[{"text":"found"}]}}`, "event: message\ndata: {\"result\":{\"content\":[{\"text\":\"found\"}]}}\n\n"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }))
		r := Search{Endpoint: srv.URL}.Run(context.Background(), "", args(map[string]string{"query": "q"}))
		srv.Close()
		if r.IsError || r.Text != "found" {
			t.Fatalf("%+v", r)
		}
	}
}
