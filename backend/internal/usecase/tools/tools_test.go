package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func args(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }

func TestWritingAllowsEditing(t *testing.T) {
	var names []string
	for _, tool := range For([]enum.Tool{enum.ToolWriteFile}, Env{}) {
		names = append(names, tool.Spec().Name)
	}
	if strings.Join(names, ",") != "write_file,edit_file" {
		t.Fatalf("%v", names)
	}
}

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
		if r := (Edit{}).Run(ctx, dir, args(map[string]any{"path": path, "edits": []map[string]string{{"old": "s", "new": "x"}}})); !r.IsError {
			t.Errorf("edit %s was allowed", path)
		}
	}
	if b, _ := os.ReadFile(secret); string(b) != "s" {
		t.Fatalf("the file outside changed: %q", b)
	}
	if r := (Read{Extra: []string{outside}}).Run(ctx, dir, args(map[string]string{"path": secret})); r.IsError {
		t.Fatalf("a skill folder could not be read: %s", r.Text)
	}
}

func TestALinkToAMissingFileOutsideIsRefused(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	os.Symlink(filepath.Join(outside, "new.txt"), filepath.Join(dir, "dangling"))
	os.Symlink("../"+filepath.Base(outside)+"/sub", filepath.Join(dir, "rel"))
	os.Symlink("inside.txt", filepath.Join(dir, "ok"))
	ctx := context.Background()
	for _, path := range []string{"dangling", "rel/x.txt"} {
		if r := (Write{}).Run(ctx, dir, args(map[string]string{"path": path, "content": "x"})); !r.IsError {
			t.Errorf("write %s was allowed", path)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) > 0 {
		t.Fatalf("a file was made outside: %v", entries)
	}
	if r := (Write{}).Run(ctx, dir, args(map[string]string{"path": "ok", "content": "in"})); r.IsError {
		t.Fatal(r.Text)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "inside.txt")); string(b) != "in" {
		t.Fatalf("a link inside was not written through: %q", b)
	}
}

func TestWriteNeedsContent(t *testing.T) {
	dir := t.TempDir()
	if r := (Write{}).Run(context.Background(), dir, args(map[string]string{"path": "a.txt"})); !r.IsError {
		t.Fatalf("%+v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err == nil {
		t.Fatal("an empty file was written")
	}
	if r := (Write{}).Run(context.Background(), dir, args(map[string]string{"path": "a.txt", "content": ""})); r.IsError {
		t.Fatalf("an empty content was refused: %s", r.Text)
	}
}

func TestReadSaysWhyItFailed(t *testing.T) {
	r := (Read{}).Run(context.Background(), t.TempDir(), args(map[string]string{"path": "missing.txt"}))
	if !r.IsError || !strings.Contains(r.Text, "no such file") {
		t.Fatalf("%+v", r)
	}
}

func TestReadGoesByLines(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1\n2\n3\n4\n5"), 0o644)
	read := func(offset, limit int) model.ToolResult {
		return (Read{}).Run(context.Background(), dir, args(map[string]any{"path": "a.txt", "offset": offset, "limit": limit}))
	}
	if r := read(0, 0); r.IsError || r.Text != "1\n2\n3\n4\n5" {
		t.Fatalf("whole: %+v", r)
	}
	if r := read(2, 2); r.IsError || r.Text != "2\n3\n\n[Showing lines 2-3 of 5. Use offset=4 to continue.]" {
		t.Fatalf("window: %q", r.Text)
	}
	if r := read(5, 0); r.IsError || r.Text != "5" {
		t.Fatalf("last: %q", r.Text)
	}
	if r := read(9, 0); !r.IsError {
		t.Fatalf("past the end: %+v", r)
	}

	var many strings.Builder
	for i := 1; i <= maxLines+5; i++ {
		fmt.Fprintf(&many, "%d\n", i)
	}
	os.WriteFile(filepath.Join(dir, "many.txt"), []byte(many.String()), 0o644)
	r := (Read{}).Run(context.Background(), dir, args(map[string]string{"path": "many.txt"}))
	if r.IsError || !strings.HasSuffix(r.Text, fmt.Sprintf("[Showing lines 1-%d of %d. Use offset=%d to continue.]", maxLines, maxLines+5, maxLines+1)) {
		t.Fatalf("line cap: %q", r.Text[len(r.Text)-100:])
	}

	os.WriteFile(filepath.Join(dir, "long.txt"), []byte(strings.Repeat("字", maxBytes)+"\nnext\n"), 0o644)
	r = (Read{}).Run(context.Background(), dir, args(map[string]string{"path": "long.txt"}))
	if r.IsError || !strings.Contains(r.Text, "[Line 1 is cut at 50KB.]") || !strings.Contains(r.Text, "Use offset=2") || !strings.HasPrefix(r.Text, "字") {
		t.Fatalf("long line: %q", r.Text[len(r.Text)-120:])
	}
	if text, _, _ := strings.Cut(r.Text, "\n"); !utf8Valid(text) {
		t.Fatal("a character was split")
	}
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "?") == s }

func TestReadLooksAtImages(t *testing.T) {
	dir := t.TempDir()
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 3)))
	good := buf.Bytes()
	os.WriteFile(filepath.Join(dir, "a.png"), good, 0o644)
	os.WriteFile(filepath.Join(dir, "named.txt"), good, 0o644)
	os.WriteFile(filepath.Join(dir, "broken.png"), append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 16)...), 0o644)
	os.WriteFile(filepath.Join(dir, "big.png"), append(slicesClone(good), make([]byte, maxImageBytes)...), 0o644)
	os.WriteFile(filepath.Join(dir, "other.bin"), []byte{0, 1, 2}, 0o644)
	os.WriteFile(filepath.Join(dir, "fake.png"), []byte("just text"), 0o644)
	read := func(path string) model.ToolResult {
		return (Read{}).Run(context.Background(), dir, args(map[string]string{"path": path}))
	}

	for _, path := range []string{"a.png", "named.txt"} { // what is inside decides, not the name
		r := read(path)
		if r.IsError || r.MimeType != "image/png" || r.Data != base64.StdEncoding.EncodeToString(good) || !strings.Contains(r.Text, path) || !strings.Contains(r.Text, "2 x 3") {
			t.Fatalf("%s: %+v", path, r)
		}
	}
	for _, path := range []string{"broken.png", "big.png", "other.bin"} {
		if r := read(path); !r.IsError || r.Data != "" {
			t.Fatalf("%s: %+v", path, r)
		}
	}
	if r := read("fake.png"); r.IsError || r.Text != "just text" || r.Data != "" {
		t.Fatalf("text named png: %+v", r)
	}
}

// Anthropic refuses a request with more than 20 images if any is over 2000 x 2000, so read_file scales big ones down.
func TestReadScalesLargeImagesDown(t *testing.T) {
	dir := t.TempDir()
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 3200, 2000)))
	os.WriteFile(filepath.Join(dir, "wide.png"), buf.Bytes(), 0o644)
	r := (Read{}).Run(context.Background(), dir, args(map[string]string{"path": "wide.png"}))
	raw, err := base64.StdEncoding.DecodeString(r.Data)
	if r.IsError || err != nil || r.MimeType != "image/png" || !strings.Contains(r.Text, "3200 x 2000") || !strings.Contains(r.Text, "scaled down to 2000 x 1250") {
		t.Fatalf("%v %+v", err, r.Text)
	}
	if cfg, err := png.DecodeConfig(bytes.NewReader(raw)); err != nil || cfg.Width != 2000 || cfg.Height != 1250 {
		t.Fatalf("%v %+v", err, cfg)
	}
}

func slicesClone(b []byte) []byte { return append([]byte(nil), b...) }

func TestEditReplacesExactText(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	edit := func(edits ...[2]string) model.ToolResult {
		var list []map[string]string
		for _, e := range edits {
			list = append(list, map[string]string{"old": e[0], "new": e[1]})
		}
		return (Edit{}).Run(context.Background(), dir, args(map[string]any{"path": "a.txt", "edits": list}))
	}

	os.WriteFile(path, []byte(bom+"one\r\ntwo\r\nthree\r\n"), 0o640)
	if r := edit([2]string{"one\ntwo", "1\n2"}, [2]string{"three", "3"}); r.IsError {
		t.Fatal(r.Text)
	}
	if b, _ := os.ReadFile(path); string(b) != bom+"1\r\n2\r\n3\r\n" {
		t.Fatalf("BOM or line ends were lost: %q", b)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode changed to %v", info.Mode().Perm())
	}

	os.WriteFile(path, []byte("a a b"), 0o644)
	for name, r := range map[string]model.ToolResult{
		"twice":   edit([2]string{"a", "x"}),
		"missing": edit([2]string{"z", "x"}),
		"empty":   edit([2]string{"", "x"}),
		"same":    edit([2]string{"b", "b"}),
		"overlap": edit([2]string{"a b", "x"}, [2]string{"b", "y"}),
	} {
		if !r.IsError {
			t.Errorf("%s: %+v", name, r)
		}
	}
	if b, _ := os.ReadFile(path); string(b) != "a a b" {
		t.Fatalf("a refused edit changed the file: %q", b)
	}
}

func TestCommandReportsFailureAndStops(t *testing.T) {
	dir := t.TempDir()
	if r := (Command{}).Run(context.Background(), dir, args(map[string]string{"command": "echo hi; exit 3"})); !r.IsError || r.Text != "hi\n[exit code 3]" {
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

func TestCommandKeepsLongOutputInAFile(t *testing.T) {
	for name, command := range map[string]string{
		"many lines": fmt.Sprintf("seq 1 %d", maxLines+500),
		"many bytes": "head -c 300000 /dev/zero | tr '\\0' 'x'; echo; echo end",
	} {
		r := (Command{}).Run(context.Background(), t.TempDir(), args(map[string]string{"command": command}))
		if r.IsError || !strings.HasPrefix(r.Text, "[Output cut to its last ") || len(r.Text) > maxBytes+200 {
			t.Fatalf("%s: %q", name, r.Text[:min(len(r.Text), 200)])
		}
		_, path, _ := strings.Cut(strings.SplitN(r.Text, "\n", 2)[0], "full output: ")
		full, err := os.ReadFile(strings.TrimSuffix(path, "]"))
		os.Remove(strings.TrimSuffix(path, "]"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := fmt.Sprintf("%d\n", maxLines+500)
		if name == "many bytes" {
			want = "end\n"
		}
		if !strings.HasSuffix(string(full), want) || !strings.HasSuffix(r.Text, want) || (name == "many lines" && !strings.HasPrefix(string(full), "1\n2\n")) {
			t.Fatalf("%s: the saved output is not whole", name)
		}
	}
}

// exaServer answers each search with the next of the given handlers, and counts the requests.
func exaServer(t *testing.T, answers ...http.HandlerFunc) (*Search, *atomic.Int32) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(n.Add(1)) - 1
		answers[min(i, len(answers)-1)](w, r)
	}))
	t.Cleanup(srv.Close)
	return &Search{Endpoint: srv.URL, Backoff: time.Millisecond}, &n
}

func answer(contentType, body string, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.Header().Set("Content-Type", contentType)
		w.Write([]byte(body))
	}
}

func status(code int, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(code)
	}
}

func rpc(text string, isError bool) string {
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []map[string]string{{"type": "text", "text": text}}, "isError": isError}})
	return string(raw)
}

func search(s *Search, query string) model.ToolResult {
	return s.Run(context.Background(), "", args(map[string]string{"query": query}))
}

func TestSearchReadsEitherAnswerFormat(t *testing.T) {
	for _, h := range []http.HandlerFunc{
		answer("application/json", rpc("found", false)),
		answer("text/event-stream", "event: message\ndata: "+rpc("found", false)+"\n\n"),
		answer("text/event-stream", "event: message\ndata: "+rpc("found", false)),
	} {
		s, _ := exaServer(t, h)
		if r := search(s, "q"); r.IsError || !strings.HasSuffix(r.Text, "\n\nfound") {
			t.Fatalf("%+v", r)
		}
	}
}

func TestSearchReportsTheFreeQuotaAndHoldsBack(t *testing.T) {
	s, n := exaServer(t, answer("application/json", rpc("You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.", false)))
	r := search(s, "q")
	if !r.IsError || !strings.Contains(r.Text, `"status":"rate_limited"`) {
		t.Fatalf("the quota notice went through as results: %+v", r)
	}
	tried := n.Load()
	if tried != 1 {
		t.Fatalf("searched %d times inside the cooldown", tried)
	}
	if r := search(s, "again"); !r.IsError || !strings.Contains(r.Text, "rate_limited") || n.Load() != tried {
		t.Fatalf("a search during the cooldown reached Exa: %+v", r)
	}
}

func TestSearchWaitsOutRetryAfter(t *testing.T) {
	s, n := exaServer(t, status(http.StatusTooManyRequests, "Retry-After", "0"), answer("application/json", rpc("found", false)))
	if r := search(s, "q"); r.IsError || !strings.HasSuffix(r.Text, "found") || n.Load() != 2 {
		t.Fatalf("%+v after %d requests", r, n.Load())
	}
}

func TestSearchRetriesOnlyWhatMayPass(t *testing.T) {
	s, n := exaServer(t, status(http.StatusBadGateway), status(http.StatusBadGateway), answer("application/json", rpc("found", false)))
	if r := search(s, "q"); r.IsError || n.Load() != 3 {
		t.Fatalf("%+v after %d requests", r, n.Load())
	}
	s, n = exaServer(t, status(http.StatusBadRequest))
	if r := search(s, "q"); !r.IsError || n.Load() != 1 {
		t.Fatalf("%+v after %d requests", r, n.Load())
	}
}

func TestSearchTellsErrorsFromResults(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"tool error": answer("application/json", rpc("bad query", true)),
		"rpc error":  answer("application/json", `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"x"}}`),
		"wrong id":   answer("application/json", `{"jsonrpc":"2.0","id":2,"result":{"content":[]}}`),
		"no result":  answer("application/json", `{"jsonrpc":"2.0","id":1}`),
		"html":       answer("text/html", "<html>"),
		"redirect":   status(http.StatusFound, "Location", "https://example.com"),
	} {
		s, _ := exaServer(t, h)
		if r := search(s, "q"); !r.IsError {
			t.Errorf("%s: %+v", name, r)
		}
	}
	s, _ := exaServer(t, answer("application/json", `{"jsonrpc":"2.0","id":1,"result":{"content":[]}}`))
	if r := search(s, "q"); r.IsError || !strings.Contains(r.Text, "No search results") {
		t.Fatalf("no hits: %+v", r)
	}
}

func TestSearchChecksItsArguments(t *testing.T) {
	s, n := exaServer(t, answer("application/json", rpc("found", false)))
	for _, raw := range []string{`{}`, `{"query":" "}`, `{"query":"q","max_results":11}`, `{"query":"q","extra":1}`, `{"query":"` + strings.Repeat("a", 4097) + `"}`} {
		if r := s.Run(context.Background(), "", json.RawMessage(raw)); !r.IsError {
			t.Errorf("%s: %+v", raw[:min(len(raw), 40)], r)
		}
	}
	if n.Load() != 0 {
		t.Fatal("a bad search reached Exa")
	}
}

func TestSearchCutsWithoutSplittingCharacters(t *testing.T) {
	s, _ := exaServer(t, answer("application/json", rpc(strings.Repeat("字", maxSearchOutput), false)))
	r := search(s, "q")
	if r.IsError || !utf8Valid(r.Text) || !strings.Contains(r.Text, "[Search results truncated.") || len(r.Text) > maxSearchOutput+300 {
		t.Fatalf("%d bytes, error %v", len(r.Text), r.IsError)
	}
}

func TestReadChecksWebP(t *testing.T) {
	dir := t.TempDir()
	good, _ := base64.StdEncoding.DecodeString("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==") // 1x1 lossless
	os.WriteFile(filepath.Join(dir, "a.webp"), good, 0o644)
	os.WriteFile(filepath.Join(dir, "broken.webp"), append([]byte("RIFF\x10\x00\x00\x00WEBPVP8 "), make([]byte, 8)...), 0o644)
	if r := (Read{}).Run(context.Background(), dir, args(map[string]string{"path": "a.webp"})); r.IsError || r.MimeType != "image/webp" || !strings.Contains(r.Text, "1 x 1") {
		t.Fatalf("%+v", r)
	}
	if r := (Read{}).Run(context.Background(), dir, args(map[string]string{"path": "broken.webp"})); !r.IsError || r.Data != "" {
		t.Fatalf("%+v", r)
	}
}

func TestLongCommandOutputCanBeReadBack(t *testing.T) {
	work, out := t.TempDir(), filepath.Join(t.TempDir(), "outputs", "task-1")
	list := For([]enum.Tool{enum.ToolReadFile, enum.ToolRunCommand}, Env{Output: out})
	read, command := list[0], list[1]
	r := command.Run(context.Background(), work, args(map[string]string{"command": fmt.Sprintf("seq 1 %d", maxLines+10)}))
	head, _, _ := strings.Cut(r.Text, "\n")
	_, path, ok := strings.Cut(head, "full output: ")
	path, _, _ = strings.Cut(path, ",")
	if r.IsError || !ok || filepath.Dir(path) != out || !strings.Contains(head, "readable with read_file") {
		t.Fatalf("%q", head)
	}
	if got := read.Run(context.Background(), work, args(map[string]any{"path": path, "limit": 2})); got.IsError || !strings.HasPrefix(got.Text, "1\n2\n") {
		t.Fatalf("the saved output could not be read: %+v", got)
	}
	if entries, _ := os.ReadDir(work); len(entries) != 0 {
		t.Fatal("the output landed in the work tree")
	}
}

func TestSearchLogsWithoutTheQuery(t *testing.T) {
	var logged bytes.Buffer
	s, _ := exaServer(t, status(http.StatusTooManyRequests, "Retry-After", "60"))
	s.Log = zerolog.New(&logged)
	search(s, "secret project name")
	search(s, "secret project name")
	text := logged.String()
	if strings.Contains(text, "secret") {
		t.Fatalf("the query was logged: %s", text)
	}
	for _, want := range []string{"web search attempt", "web search rate limited", "web search held back by cooldown"} {
		if !strings.Contains(text, want) {
			t.Errorf("no %q in %s", want, text)
		}
	}
}

func TestSearchCooldownOutlivesARestart(t *testing.T) {
	state := filepath.Join(t.TempDir(), "data", "search-cooldown.json")
	s, _ := exaServer(t, status(http.StatusTooManyRequests, "Retry-After", "60"))
	s.State = state
	search(s, "q")
	if info, err := os.Stat(state); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("not saved: %v", err)
	}
	again, n := exaServer(t, answer("application/json", rpc("found", false)))
	again.State = state
	if r := search(again, "q"); !r.IsError || !strings.Contains(r.Text, "rate_limited") || strings.Contains(r.Text, `"retry_after_seconds":null`) || n.Load() != 0 {
		t.Fatalf("a restart forgot the cooldown: %+v after %d requests", r, n.Load())
	}

	os.WriteFile(state, []byte(`{"until":"2000-01-01T00:00:00Z"}`), 0o600)
	later, n := exaServer(t, answer("application/json", rpc("found", false)))
	later.State = state
	if r := search(later, "q"); r.IsError || n.Load() != 1 {
		t.Fatalf("an old cooldown still held: %+v", r)
	}
}

func TestCommandShowsItsLastLinesWhileRunning(t *testing.T) {
	var shown []string
	r := (Command{}).RunStream(context.Background(), t.TempDir(), args(map[string]string{"command": "seq 1 30; sleep 0.3; echo last"}), func(s string) { shown = append(shown, s) })
	if r.IsError || len(shown) == 0 {
		t.Fatalf("%+v, shown %q", r, shown)
	}
	if lines := strings.Split(shown[0], "\n"); len(lines) != liveLines || lines[len(lines)-1] != "30" {
		t.Fatalf("first glimpse %q", shown[0])
	}
	if g := glimpse([]byte(strings.Repeat("字", liveBytes))); len(g) > liveBytes || !utf8Valid(g) {
		t.Fatalf("a long line: %d bytes", len(g))
	}
}
