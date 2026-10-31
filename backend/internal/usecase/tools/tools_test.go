package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/mho-company/internal/model"
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

func TestReadLooksAtImages(t *testing.T) {
	dir := t.TempDir()
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 16)...)
	os.WriteFile(filepath.Join(dir, "a.png"), png, 0o644)
	os.WriteFile(filepath.Join(dir, "named.txt"), png, 0o644)
	os.WriteFile(filepath.Join(dir, "big.png"), append(png, make([]byte, maxImageBytes)...), 0o644)
	os.WriteFile(filepath.Join(dir, "other.bin"), []byte{0, 1, 2}, 0o644)
	os.WriteFile(filepath.Join(dir, "fake.png"), []byte("just text"), 0o644)
	read := func(path string) model.ToolResult {
		return (Read{}).Run(context.Background(), dir, args(map[string]string{"path": path}))
	}

	for _, path := range []string{"a.png", "named.txt"} { // what is inside decides, not the name
		r := read(path)
		if r.IsError || r.MimeType != "image/png" || r.Data != base64.StdEncoding.EncodeToString(png) || !strings.Contains(r.Text, path) {
			t.Fatalf("%s: %+v", path, r)
		}
	}
	if r := read("big.png"); !r.IsError || r.Data != "" {
		t.Fatalf("too large: %+v", r)
	}
	if r := read("other.bin"); !r.IsError || r.Data != "" {
		t.Fatalf("binary: %+v", r)
	}
	if r := read("fake.png"); r.IsError || r.Text != "just text" || r.Data != "" {
		t.Fatalf("text named png: %+v", r)
	}
}

func TestReadKeepsTheOffsetForText(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("0123456789"), 0o644)
	r := (Read{}).Run(context.Background(), dir, args(map[string]any{"path": "a.txt", "offset": 7}))
	if r.IsError || r.Text != "789" {
		t.Fatalf("%+v", r)
	}
}
