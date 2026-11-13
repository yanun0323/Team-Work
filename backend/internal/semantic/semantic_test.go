package semantic

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// sink collects the log.
type sink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *sink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *sink) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// events are the semantic_ events logged, with their fields.
func (s *sink) events(name string) []map[string]any {
	var out []map[string]any
	for _, line := range strings.Split(s.String(), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil && m["message"] == name {
			out = append(out, m)
		}
	}
	return out
}

// modelServer serves made-up model files with a CHECKSUMS.sha256 that matches them.
type modelServer struct {
	*httptest.Server
	pin      string
	requests atomic.Int32
}

func newModelServer(t *testing.T, corrupt string) *modelServer {
	t.Helper()
	files := map[string]string{}
	var manifest strings.Builder
	for _, name := range assets {
		body := "content of " + name
		files[name] = body
		sum := sha256.Sum256([]byte(body))
		fmt.Fprintf(&manifest, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	if corrupt != "" {
		files[corrupt] = "tampered"
	}
	files["CHECKSUMS.sha256"] = manifest.String()
	sum := sha256.Sum256([]byte(manifest.String()))
	ms := &modelServer{pin: hex.EncodeToString(sum[:])}
	ms.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ms.requests.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Errorf("a sign-in was sent")
		}
		body, ok := files[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		if r.Method == http.MethodGet {
			w.Write([]byte(body))
		}
	}))
	t.Cleanup(ms.Close)
	return ms
}

var supported = Platform{OS: "27.0.1", Build: "TEST1", Chip: "Apple M5 Pro", Arm64: true}

type testService struct {
	*Service
	log    *sink
	server *modelServer
	data   string
}

func newService(t *testing.T, mode string, level zerolog.Level, change func(*Options)) *testService {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("semantic search runs only on macOS")
	}
	t.Setenv("SEMANTIC_FAKE_HELPER", "1")
	t.Setenv("FAKE_MODE", mode)
	t.Setenv("FAKE_ONCE", filepath.Join(t.TempDir(), "once"))
	log := &sink{}
	ms := newModelServer(t, "")
	data := t.TempDir()
	p := supported
	p.Helper = os.Args[0]
	o := Options{DataDir: data, Log: zerolog.New(log).Level(level), Platform: p, BaseURL: ms.URL + "/", Pin: ms.pin, Retry: time.Millisecond}
	if change != nil {
		change(&o)
	}
	s := New(o)
	t.Cleanup(s.Close)
	return &testService{Service: s, log: log, server: ms, data: data}
}

// waitState waits for a state and returns the states seen on the way.
func (s *testService) waitState(t *testing.T, want string) []string {
	t.Helper()
	var seen []string
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		st := s.Status(true)
		if len(seen) == 0 || seen[len(seen)-1] != st.State {
			seen = append(seen, st.State)
		}
		if st.State == want {
			return seen
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("state %s never came; saw %v\n%s", want, seen, s.log.String())
	return nil
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// codeMarker is a line of code that must never be in the log.
const codeMarker = "invoiceLedgerReconcile computes the monthly ledger balance"

// newRepo is a project with code, ignored notes, secrets, a lock file and a very long line.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	write(t, dir, ".gitignore", "AGENTS.md\nCONTEXT.md\nbuild/\n")
	write(t, dir, "ledger.go", "package main\n\n// "+codeMarker+"\nfunc invoiceLedgerReconcile() int { return 42 }\n")
	write(t, dir, "weather.go", "package main\n\n// forecast rain and sunshine for tomorrow\nfunc forecast() string { return \"rain\" }\n")
	write(t, dir, "docs/中文.md", "# 說明\n\n這個專案負責語意搜尋的索引與查詢。\n")
	write(t, dir, "AGENTS.md", "Agents: always run the penguin migration first.\n")
	write(t, dir, "CONTEXT.md", "Context: the walrus module owns billing.\n")
	write(t, dir, ".env", "API_TOKEN=hunter2supersecretvalue\n")
	write(t, dir, ".env.local", "API_TOKEN=hunter2supersecretvalue\n")
	write(t, dir, "config/secrets.yaml", "token: hunter2supersecretvalue\n")
	write(t, dir, "certs/server.pem", "-----BEGIN PRIVATE KEY----- hunter2supersecretvalue\n")
	write(t, dir, "package-lock.json", `{"name":"hunter2supersecretvalue"}`)
	write(t, dir, "node_modules/x/index.js", "hunter2supersecretvalue\n")
	write(t, dir, "build/out.js", "hunter2supersecretvalue\n")
	// one line far over the model's limit, every word in it findable
	var long strings.Builder
	for i := range 1500 {
		fmt.Fprintf(&long, "giraffe%d ", i)
	}
	write(t, dir, "long.txt", "first line\n"+long.String()+"\nlast line zebra\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "init")
	write(t, dir, "untracked.go", "package main\n// untracked koala helper\n")
	return dir
}

func search(t *testing.T, s *testService, dir, query string) Result {
	t.Helper()
	res, err := s.Search(context.Background(), Query{Cwd: dir, Text: query, Task: "task-1", Replica: "rep-1"})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func paths(res Result) []string {
	var out []string
	for _, h := range res.Results {
		out = append(out, h.Path)
	}
	return out
}

func TestSupportedOnlyOnMacOS27AppleSilicon(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	for _, c := range []struct {
		p    Platform
		want bool
	}{
		{Platform{OS: "27.0", Arm64: true, Helper: "/h"}, true},
		{Platform{OS: "28.1", Arm64: true, Helper: "/h"}, true},
		{Platform{OS: "26.4", Arm64: true, Helper: "/h"}, false},
		{Platform{OS: "13.3", Arm64: true, Helper: "/h"}, false},
		{Platform{OS: "27.0", Arm64: false, Helper: "/h"}, false}, // Intel, or Rosetta
		{Platform{OS: "27.0", Arm64: true, Helper: "/h", Missing: true}, false},
		{Platform{OS: "", Arm64: true, Helper: "/h"}, false},
	} {
		if got, why := c.p.Supported(); got != c.want || (!got && why == "") {
			t.Errorf("%+v: %v %q", c.p, got, why)
		}
	}
}

func TestNilServiceIsOff(t *testing.T) {
	var s *Service
	if s.Active() || s.Status(true).State != StateUnsupported || s.Status(true).Supported {
		t.Fatal("a nil service must be unsupported and off")
	}
	s.Start(true, nil)
	s.Changed("/x", "write_file")
	s.Forget("/x")
	s.Disable()
	s.Close()
}

func TestOffDownloadsAndStartsNothing(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(false, []string{repo})
	time.Sleep(100 * time.Millisecond)
	st := s.Status(false)
	if st.State != StateDisabled || st.Active || st.RequiresRestart || !st.Supported || st.Error != nil {
		t.Fatalf("%+v", st)
	}
	if s.Active() || s.server.requests.Load() != 0 {
		t.Fatalf("active %v, %d requests", s.Active(), s.server.requests.Load())
	}
	if len(s.log.events("semantic_helper_start")) != 0 || len(s.log.events("semantic_startup")) != 1 {
		t.Fatal(s.log.String())
	}
	if _, err := os.Stat(filepath.Join(s.data, "cache", "semantic-search")); !os.IsNotExist(err) {
		t.Fatalf("made the cache folder: %v", err)
	}
	if _, err := s.Search(context.Background(), Query{Cwd: repo, Text: "x"}); err == nil {
		t.Fatal("searched while off")
	}
	// turned on now: it waits for a restart and still starts nothing
	if st := s.Status(true); st.State != StateRestartRequired || !st.RequiresRestart || st.Active {
		t.Fatalf("%+v", st)
	}
	time.Sleep(50 * time.Millisecond)
	if s.server.requests.Load() != 0 || len(s.log.events("semantic_helper_start")) != 0 {
		t.Fatal("reading the status started something")
	}
}

func TestUnsupportedStaysOff(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, func(o *Options) { o.Platform.OS = "13.3" })
	s.Start(true, []string{newRepo(t)})
	time.Sleep(50 * time.Millisecond)
	if st := s.Status(true); st.State != StateUnsupported || st.Supported || st.Active {
		t.Fatalf("%+v", st)
	}
	if s.Active() || s.server.requests.Load() != 0 {
		t.Fatal("started on an unsupported Mac")
	}
	ev := s.log.events("semantic_startup")
	if len(ev) != 1 || ev[0]["supported"] != false || ev[0]["reason"] == "" {
		t.Fatal(s.log.String())
	}
}

func TestFullFlow(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	seen := s.waitState(t, StateReady)
	// downloading, compiling and indexing come in that order (a fast step may be too quick to see)
	order := []string{StateDisabled, StateDownloading, StateCompiling, StateIndexing, StateReady}
	last := -1
	for _, st := range seen {
		i := slices.Index(order, st)
		if i < last {
			t.Fatalf("states out of order: %v", seen)
		}
		last = i
	}
	st := s.Status(true)
	if !st.Active || st.Progress.PendingFiles != 0 || st.Progress.Chunks == 0 || st.Progress.TotalFiles == 0 || st.Progress.DownloadedBytes == 0 || st.Progress.TotalBytes == nil {
		t.Fatalf("%+v", st)
	}

	res := search(t, s, repo, "monthly ledger balance")
	if res.Mode != "hybrid" || res.PendingFiles != 0 || len(res.Results) == 0 || res.Results[0].Path != "ledger.go" {
		t.Fatalf("%+v", res)
	}
	if h := res.Results[0]; h.StartLine != 1 || !strings.Contains(h.Text, codeMarker) {
		t.Fatalf("%+v", h)
	}
	// ignored AGENTS.md and CONTEXT.md are in, by meaning and by keyword
	if got := paths(search(t, s, repo, "penguin migration")); !slices.Contains(got, "AGENTS.md") {
		t.Fatalf("AGENTS.md: %v", got)
	}
	if got := paths(search(t, s, repo, "walrus billing")); !slices.Contains(got, "CONTEXT.md") {
		t.Fatalf("CONTEXT.md: %v", got)
	}
	if got := paths(search(t, s, repo, "koala")); !slices.Contains(got, "untracked.go") {
		t.Fatalf("untracked: %v", got)
	}
	if got := paths(search(t, s, repo, "語意搜尋")); !slices.Contains(got, "docs/中文.md") {
		t.Fatalf("CJK: %v", got)
	}
	// secrets, settings, lock files, dependencies and ignored output are never searched
	for _, h := range search(t, s, repo, "hunter2supersecretvalue API_TOKEN").Results {
		if strings.Contains(h.Text, "hunter2supersecretvalue") {
			t.Fatalf("%+v", h)
		}
	}
	// the long line is cut into pieces, each one under the limit, and every part of it can be found
	for _, word := range []string{"giraffe3", "giraffe1499", "zebra"} {
		if got := paths(search(t, s, repo, word)); !slices.Contains(got, "long.txt") {
			t.Fatalf("%s: %v", word, got)
		}
	}
	r := s.roots[canonical(repo)]
	r.mu.Lock()
	long := r.files["long.txt"]
	if long == nil || long.pending || len(long.chunks) < 7 {
		t.Fatalf("long.txt: %+v", long)
	}
	for _, f := range []string{".env", ".env.local", "config/secrets.yaml", "certs/server.pem", "package-lock.json", "node_modules/x/index.js", "build/out.js"} {
		if r.files[f] != nil {
			t.Fatalf("%s is indexed", f)
		}
	}
	r.mu.Unlock()

	index := s.log.events("semantic_index")
	if len(index) == 0 || index[0]["splits"].(float64) == 0 || index[0]["computed"].(float64) == 0 {
		t.Fatalf("%v", index)
	}
	excludedBy := index[0]["excluded"].(map[string]any)
	if excludedBy["secret"].(float64) < 4 || excludedBy["lockfile"].(float64) != 1 || excludedBy["dependency_or_output"].(float64) < 1 {
		t.Fatalf("%v", excludedBy)
	}
	for _, name := range []string{"semantic_startup", "semantic_state", "semantic_download", "semantic_checksum", "semantic_helper_start",
		"semantic_compile", "semantic_validate", "semantic_helper_stderr", "semantic_batch", "semantic_index", "semantic_search", "semantic_memory"} {
		if len(s.log.events(name)) == 0 {
			t.Errorf("no %s", name)
		}
	}
	searchEv := s.log.events("semantic_search")[0]
	for _, field := range []string{"task", "replica", "cwd", "keyword", "vector", "merged", "verified", "dropped", "pendingFiles", "queueMs", "embedMs", "compareMs", "verifyMs"} {
		if _, ok := searchEv[field]; !ok {
			t.Errorf("semantic_search has no %s: %v", field, searchEv)
		}
	}
	assertNoCode(t, s.log.String())
	if strings.Contains(s.log.String(), "monthly ledger balance") {
		t.Fatal("the query is in the log above debug level")
	}

	// a warm start reuses the download and every vector
	s.Close()
	again := New(s.o)
	t.Cleanup(again.Close)
	again.Start(true, []string{repo})
	warm := &testService{Service: again, log: s.log, server: s.server}
	requests := s.server.requests.Load()
	warm.waitState(t, StateReady)
	if s.server.requests.Load() != requests {
		t.Fatal("downloaded again")
	}
	ev := s.log.events("semantic_index")
	if last := ev[len(ev)-1]; last["computed"].(float64) != 0 || last["cacheHits"].(float64) == 0 {
		t.Fatalf("%v", last)
	}
}

// assertNoCode checks that no file content and no secret is in the log.
func assertNoCode(t *testing.T, log string) {
	t.Helper()
	for _, s := range []string{codeMarker, "invoiceLedgerReconcile()", "hunter2supersecretvalue", "leakedSecretCode", "penguin migration", "giraffe1 ", "這個專案"} {
		if strings.Contains(log, s) {
			t.Fatalf("the log has %q", s)
		}
	}
	if !strings.Contains(log, `"redacted":true`) {
		t.Fatal("the helper's stray stderr line was not logged as redacted")
	}
}

func TestQueryOnlyAtDebug(t *testing.T) {
	s := newService(t, "", zerolog.DebugLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	search(t, s, repo, "monthly ledger balance")
	if q := s.log.events("semantic_search_query"); len(q) != 1 || q[0]["query"] != "monthly ledger balance" || q[0]["level"] != "debug" {
		t.Fatalf("%v", q)
	}
	rank := s.log.events("semantic_search_rank")
	if len(rank) == 0 || rank[0]["path"] != "ledger.go" || rank[0]["level"] != "debug" {
		t.Fatalf("%v", rank)
	}
	if len(s.log.events("semantic_split")) == 0 {
		t.Fatal("no semantic_split")
	}
	// even at debug, no code is written
	assertNoCode(t, s.log.String())
}

func TestEditsNeverHandOutOldContent(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	if got := paths(search(t, s, repo, "forecast rain sunshine")); len(got) == 0 || got[0] != "weather.go" {
		t.Fatalf("%v", got)
	}

	// write_file: the file is told at once; its old vectors stop being used before it is indexed again
	write(t, repo, "weather.go", "package main\n\n// count the penguins on the iceberg\nfunc penguins() int { return 7 }\n")
	s.Changed(filepath.Join(repo, "weather.go"), "write_file")
	res := search(t, s, repo, "forecast rain sunshine")
	for _, h := range res.Results {
		if strings.Contains(h.Text, "forecast") {
			t.Fatalf("old content handed out: %+v", h)
		}
	}
	if got := s.log.events("semantic_file_change"); len(got) == 0 || got[0]["source"] != "write_file" {
		t.Fatalf("%v", got)
	}
	s.waitState(t, StateReady)
	waitIndexed(t, s, repo)
	if got := paths(search(t, s, repo, "penguins iceberg")); len(got) == 0 || got[0] != "weather.go" {
		t.Fatalf("%v", got)
	}

	// run_command rewriting a file to the same size and putting the time back is still seen
	p := filepath.Join(repo, "ledger.go")
	info, _ := os.Stat(p)
	old, _ := os.ReadFile(p)
	changed := strings.Replace(string(old), "monthly ledger balance", "quarterly owl inventory", 1)
	changed = changed[:len(old)]
	time.Sleep(10 * time.Millisecond)
	cmd := exec.Command("sh", "-c", `printf '%s' "$1" > ledger.go`, "sh", changed)
	cmd.Dir = repo
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	os.Chtimes(p, info.ModTime(), info.ModTime())
	if after, _ := os.Stat(p); after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		t.Fatal("the test did not keep size and time")
	}
	// pretend the last look was long ago, so only the change time can tell
	r := s.roots[canonical(repo)]
	r.mu.Lock()
	r.scanned = time.Now().Add(time.Hour)
	r.mu.Unlock()
	s.Changed(repo, "run_command")
	res = search(t, s, repo, "monthly ledger balance")
	for _, h := range res.Results {
		if strings.Contains(h.Text, "monthly ledger balance") {
			t.Fatalf("old content handed out: %+v", h)
		}
	}
	// a new file not indexed yet: found by keyword, and the result says files are still waiting
	write(t, repo, "fresh.go", "package main\n// narwhal tusk measurements\n")
	res = search(t, s, repo, "narwhal tusk")
	if !slices.Contains(paths(res), "fresh.go") {
		t.Fatalf("%+v", res)
	}
	waitIndexed(t, s, repo)
	if got := paths(search(t, s, repo, "quarterly owl inventory")); len(got) == 0 || got[0] != "ledger.go" {
		t.Fatalf("%v", got)
	}
}

func TestPendingFilesAreReported(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	t.Setenv("FAKE_DELAY", "300ms")
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateIndexing)
	deadline := time.Now().Add(10 * time.Second)
	for s.Status(true).Progress.PendingFiles == 0 {
		if time.Now().After(deadline) {
			t.Fatal("never pending")
		}
		time.Sleep(time.Millisecond)
	}
	res := search(t, s, repo, "koala")
	if res.PendingFiles == 0 || !strings.Contains(res.Reason, "not indexed yet") || !slices.Contains(paths(res), "untracked.go") {
		t.Fatalf("%+v", res)
	}
}

func waitIndexed(t *testing.T, s *testService, dir string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		s.poke()
		if r := s.roots[canonical(dir)]; r != nil {
			if _, pending, _ := r.counts(); pending == 0 {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("never indexed")
}

func TestWorkTreesAreSeparateAndForgotten(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	tree := filepath.Join(t.TempDir(), "task-1")
	git(t, repo, "worktree", "add", "-q", "-b", "task-1", tree)
	write(t, tree, "only_here.go", "package main\n// capybara spa schedule\n")
	if got := paths(search(t, s, tree, "capybara spa")); !slices.Contains(got, "only_here.go") {
		t.Fatalf("%v", got)
	}
	if got := paths(search(t, s, repo, "capybara spa")); slices.Contains(got, "only_here.go") {
		t.Fatalf("the company's folder sees the work tree: %v", got)
	}
	waitIndexed(t, s, tree)
	if res := search(t, s, tree, "capybara spa"); res.Mode != "hybrid" || res.Results[0].Path != "only_here.go" {
		t.Fatalf("%+v", res)
	}
	// the work tree's vectors came from the shared cache: the same files cost nothing again
	before := s.Status(true).Progress.Chunks
	s.Forget(tree)
	ev := s.log.events("semantic_worktree_removed")
	if len(ev) != 1 || ev[0]["chunks"].(float64) == 0 {
		t.Fatalf("%v", ev)
	}
	if after := s.Status(true).Progress.Chunks; after >= before {
		t.Fatalf("chunks %d then %d", before, after)
	}
	if _, ok := s.roots[canonical(tree)]; ok {
		t.Fatal("the work tree is still indexed")
	}
	var treeIndex map[string]any
	for _, ev := range s.log.events("semantic_index") {
		if ev["root"] == canonical(tree) {
			treeIndex = ev
		}
	}
	if treeIndex == nil || treeIndex["computed"].(float64) > 2 || treeIndex["cacheHits"].(float64) == 0 {
		t.Fatalf("the work tree's same files were embedded again: %v", treeIndex)
	}
}

func TestForgetWhileIndexingWritesNothingBack(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	t.Setenv("FAKE_DELAY", "50ms")
	repo := newRepo(t)
	s.Start(true, nil)
	s.waitState(t, StateReady)
	search(t, s, repo, "koala") // starts indexing it
	time.Sleep(80 * time.Millisecond)
	r := s.roots[canonical(repo)]
	s.Forget(repo)
	time.Sleep(400 * time.Millisecond)
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.files) != 0 {
		t.Fatalf("a removed folder got %d files back", len(r.files))
	}
}

func TestKeywordWhenTheModelFails(t *testing.T) {
	cases := []struct {
		name, mode, code string
		change           func(*Options)
	}{
		{"download", "", "download_failed", func(o *Options) { o.BaseURL = "http://127.0.0.1:1/" }},
		{"checksum", "", "checksum_mismatch", func(o *Options) { o.Pin = strings.Repeat("0", 64) }},
		{"compile", "load_fail", "compile_failed", nil},
		{"validate", "validate_fail", "validation_failed", nil},
		{"crash", "crash", "helper_failed", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newService(t, c.mode, zerolog.InfoLevel, c.change)
			repo := newRepo(t)
			s.Start(true, []string{repo})
			s.waitState(t, StateError)
			st := s.Status(true)
			if st.Error == nil || st.Error.Code != c.code || st.Error.Log != "backend.log" || st.Error.Message == "" || st.Error.Stage == "" {
				t.Fatalf("%+v", st.Error)
			}
			res := search(t, s, repo, "monthly ledger balance")
			if res.Mode != "keyword" || res.Reason == "" || len(res.Results) == 0 || res.Results[0].Path != "ledger.go" {
				t.Fatalf("%+v", res)
			}
			errs := s.log.events("semantic_error")
			if len(errs) == 0 || errs[len(errs)-1]["stage"] == "" || errs[len(errs)-1]["next"] == "" {
				t.Fatalf("%v\n%s", errs, s.log.String())
			}
		})
	}
}

func TestHelperRestartsAfterABadReply(t *testing.T) {
	s := newService(t, "bad_frame", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	waitIndexed(t, s, repo)
	if len(s.log.events("semantic_helper_restart")) == 0 || len(s.log.events("semantic_helper_exit")) == 0 {
		t.Fatal(s.log.String())
	}
	if res := search(t, s, repo, "monthly ledger balance"); res.Mode != "hybrid" {
		t.Fatalf("%+v", res)
	}
}

func TestSearchesGoBeforeIndexing(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	t.Setenv("SEMANTIC_FAKE_HELPER", "1")
	t.Setenv("FAKE_DELAY", "40ms")
	log := &sink{}
	h := newHelper(os.Args[0], "/bundle", "", &logger{z: zerolog.New(log)})
	defer h.close()
	var mu sync.Mutex
	var order []string
	var wg sync.WaitGroup
	call := func(name string, high bool) {
		defer wg.Done()
		r := h.call(context.Background(), map[string]any{"op": "embed", "texts": []string{name}, "maxTokens": MaxTokens}, high)
		if r.err != nil {
			t.Error(r.err)
		}
		mu.Lock()
		order = append(order, name)
		mu.Unlock()
	}
	wg.Add(4)
	for i := range 3 {
		go call(fmt.Sprintf("index%d", i), false)
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(10 * time.Millisecond)
	go call("search", true)
	wg.Wait()
	if i := slices.Index(order, "search"); i > 1 {
		t.Fatalf("the search waited behind indexing: %v", order)
	}
}

func TestHelperCloseFailsWaitingCalls(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	t.Setenv("SEMANTIC_FAKE_HELPER", "1")
	t.Setenv("FAKE_DELAY", "200ms")
	h := newHelper(os.Args[0], "/bundle", "", &logger{z: zerolog.Nop()})
	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- h.call(context.Background(), map[string]any{"op": "embed", "texts": []string{"x"}, "maxTokens": MaxTokens}, false).err
		}()
	}
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	h.close()
	wg.Wait()
	close(errs)
	closed := 0
	for err := range errs {
		if errors.Is(err, errClosed) {
			closed++
		}
	}
	if closed == 0 || time.Since(start) > 6*time.Second {
		t.Fatalf("%d closed in %s", closed, time.Since(start))
	}
	if r := h.call(context.Background(), map[string]any{"op": "memory"}, true); !errors.Is(r.err, errClosed) {
		t.Fatal(r.err)
	}
}

func TestDisableStopsAtOnce(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	s.Disable()
	if s.Active() {
		t.Fatal("still active")
	}
	if st := s.Status(false); st.State != StateDisabled || st.Active {
		t.Fatalf("%+v", st)
	}
	// on again in the settings: a restart is needed
	if st := s.Status(true); st.State != StateRestartRequired {
		t.Fatalf("%+v", st)
	}
	exits := s.log.events("semantic_helper_exit")
	if len(exits) == 0 {
		t.Fatal("the helper did not stop")
	}
	var user *UserError
	if _, err := s.Search(context.Background(), Query{Cwd: repo, Text: "ledger"}); !errors.As(err, &user) || !strings.Contains(err.Error(), "grep") {
		t.Fatal(err)
	}
}

func TestSearchArguments(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	for _, q := range []Query{
		{Cwd: repo, Text: "  "},
		{Cwd: repo, Text: strings.Repeat("x", 4097)},
		{Cwd: repo, Text: "x", Limit: 21},
		{Cwd: repo, Text: "x", Limit: -1},
		{Cwd: "", Text: "x"},
		{Cwd: t.TempDir(), Text: "x"}, // not a Git work tree: no fallback to anything else
	} {
		var user *UserError
		if _, err := s.Search(context.Background(), q); !errors.As(err, &user) {
			t.Errorf("%+v: %v", q.Limit, err)
		}
	}
	// a query too long for the model is said so, not cut
	s.waitState(t, StateReady)
	res := search(t, s, repo, strings.Repeat("ledger ", 400))
	if res.Mode != "keyword" || !strings.Contains(res.Reason, "tokens") {
		t.Fatalf("%+v", res.Reason)
	}
}

func TestExcluded(t *testing.T) {
	for rel, want := range map[string]string{
		"main.go": "", "internal/secret_store.go": "", "AGENTS.md": "", "docs/credentials.md": "",
		".env": "secret", ".env.production": "secret", "a/.envrc": "secret", "keys/id_ed25519": "secret", "tls/server.key": "secret",
		"x.p12": "secret", "config/secrets.yml": "secret", "credentials.json": "secret", ".ssh/config": "secret", "home/.aws/config": "secret",
		"package-lock.json": "lockfile", "backend/go.sum": "lockfile", "yarn.lock": "lockfile", "Cargo.lock": "lockfile",
		"node_modules/a/b.js": "dependency_or_output", "dist/app.js": "dependency_or_output", "a/.git/HEAD": "dependency_or_output",
	} {
		if got := excluded(rel); got != want {
			t.Errorf("%s: %q, want %q", rel, got, want)
		}
	}
}

func TestCutCoversEveryByte(t *testing.T) {
	var b strings.Builder
	for i := range 100 {
		fmt.Fprintf(&b, "line %d 中文字\n", i)
	}
	b.WriteString(strings.Repeat("長", 3000) + "\n")
	b.WriteString("tail without newline")
	text := b.String()
	pieces := cut(text)
	var joined strings.Builder
	for _, p := range pieces {
		if len(p.body) > chunkBytes {
			t.Fatalf("piece of %d bytes", len(p.body))
		}
		joined.WriteString(p.body)
	}
	if joined.String() != text {
		t.Fatal("pieces do not add up to the file")
	}
	lines := splitLines(text)
	lineText := func(a, b int) string { return strings.Join(lines[a-1:b], "") }
	for _, p := range pieces {
		parts, ok := p.split(lineText)
		if !ok || parts[0].body+parts[1].body != p.body {
			t.Fatalf("split lost text at line %d", p.start)
		}
	}
	if _, ok := (piece{start: 1, end: 1, body: "長"}).split(lineText); ok {
		t.Fatal("split one character")
	}
}

func TestVectorKeyDependsOnEverything(t *testing.T) {
	if key("a") == key("b") || key(docPrefix+"x") == key(queryPrefix+"x") || len(key("a")) != 64 {
		t.Fatal("keys collide")
	}
}

func TestSweepKeepsWhatIsUsed(t *testing.T) {
	v := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	vec := make([]float32, dim)
	vec[0] = 1
	old, used, fresh := key("old"), key("used"), key("fresh")
	for _, k := range []string{old, used, fresh} {
		if err := v.put(k, vec); err != nil {
			t.Fatal(err)
		}
	}
	long := time.Now().Add(-40 * 24 * time.Hour)
	os.Chtimes(v.path(old), long, long)
	os.Chtimes(v.path(used), long, long)
	if n := v.sweep(30*24*time.Hour, map[string]bool{used: true}); n != 1 {
		t.Fatalf("removed %d", n)
	}
	if v.get(old) != nil || v.get(used) == nil || v.get(fresh) == nil {
		t.Fatal("removed the wrong vectors")
	}
}

func TestDownloadChecksEveryFile(t *testing.T) {
	ms := newModelServer(t, "model/tokenizer/tokenizer.json")
	dir := t.TempDir()
	log := &sink{}
	f := &fetcher{base: ms.URL + "/", client: http.DefaultClient, dir: dir, log: &logger{z: zerolog.New(log)}, pin: ms.pin}
	_, err := f.fetch(context.Background(), func(int64, int64, int, int) {})
	var de *downloadError
	if !errors.As(err, &de) || de.code != "checksum_mismatch" || de.file != "model/tokenizer/tokenizer.json" {
		t.Fatal(err)
	}
	if f.ready() != "" {
		t.Fatal("a model that failed its checksum is ready")
	}
	if _, err := os.Stat(filepath.Join(dir, Revision+".partial", "model", "tokenizer", "tokenizer.json")); !os.IsNotExist(err) {
		t.Fatal("the bad file was kept")
	}
	if ev := log.events("semantic_checksum"); len(ev) == 0 || ev[len(ev)-1]["ok"] != false {
		t.Fatal(log.String())
	}
	// the good files are kept for the next try
	good := newModelServer(t, "")
	good.pin = ms.pin
	f.base = good.URL + "/"
	if _, err := f.fetch(context.Background(), func(int64, int64, int, int) {}); err != nil {
		t.Fatal(err)
	}
	if f.ready() == "" {
		t.Fatal("not ready")
	}
}

func TestStderrIsRedacted(t *testing.T) {
	log := &sink{}
	forwardStderr(strings.NewReader(`{"event":"compile_done","seconds":1.5}`+"\n"+`{"event":"x","text":"let password = 1"}`+"\nplain text with code()\n"), 7, &logger{z: zerolog.New(log)})
	ev := log.events("semantic_helper_stderr")
	if len(ev) != 3 || ev[0]["helper"] == nil || ev[1]["redacted"] != true || ev[2]["redacted"] != true {
		t.Fatalf("%v", ev)
	}
	if strings.Contains(log.String(), "password") || strings.Contains(log.String(), "code()") {
		t.Fatal(log.String())
	}
}

func TestLeftoversOfAKilledHelperAreRemoved(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	cmd := exec.Command("true")
	cmd.Run()
	dead := cmd.Process.Pid
	base := filepath.Join(tmp, "com.apple.MetalPerformanceShadersGraph")
	mine := filepath.Join(base, fmt.Sprintf("mpsgraph-%d-2026-1", dead))
	other := filepath.Join(base, "mpsgraph-1-2026-1")
	os.MkdirAll(mine, 0o755)
	os.MkdirAll(other, 0o755)
	s := New(Options{DataDir: t.TempDir(), Log: zerolog.Nop(), Platform: supported})
	os.MkdirAll(s.dir, 0o755)
	raw, _ := json.Marshal(map[string]any{"pid": dead, "started": time.Now().Add(-time.Minute).Unix()})
	os.WriteFile(filepath.Join(s.dir, "helper.json"), raw, 0o644)
	s.removeLeftovers()
	if _, err := os.Stat(mine); !os.IsNotExist(err) {
		t.Fatal("the dead helper's folder is still there")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("another process's folder was removed")
	}
}
