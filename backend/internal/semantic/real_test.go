package semantic

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// TestRealModel runs the real helper and model on a real project, for checking on a Mac with macOS 27:
//
//	SEMANTIC_REAL_HELPER=<semantic-helper> SEMANTIC_REAL_HOME=<data folder> SEMANTIC_REAL_ROOT=<a Git work tree it may change> \
//	go test -run TestRealModel -v ./internal/semantic/
//
// It changes files in SEMANTIC_REAL_ROOT and puts them back with git checkout.
func TestRealModel(t *testing.T) {
	helper, home, root := os.Getenv("SEMANTIC_REAL_HELPER"), os.Getenv("SEMANTIC_REAL_HOME"), os.Getenv("SEMANTIC_REAL_ROOT")
	if helper == "" || home == "" || root == "" {
		t.Skip("set SEMANTIC_REAL_HELPER, SEMANTIC_REAL_HOME and SEMANTIC_REAL_ROOT to run the real model")
	}
	log := &sink{}
	s := New(Options{DataDir: home, Log: zerolog.New(log).Level(zerolog.InfoLevel), Platform: Detect(helper)})
	t.Cleanup(s.Close)
	start := time.Now()
	s.Start(true, []string{root})
	ts := &testService{Service: s, log: log}
	ts.waitStateWithin(t, StateReady, 30*time.Minute)
	t.Logf("ready in %s", time.Since(start))
	for _, ev := range []string{"semantic_compile", "semantic_validate", "semantic_index"} {
		for _, e := range log.events(ev) {
			t.Logf("%s %v", ev, e)
		}
	}
	timed := func(query string) Result {
		t0 := time.Now()
		res := search(t, ts, root, query)
		t.Logf("search %q: %s, mode %s, %d results, first %v", query, time.Since(t0), res.Mode, len(res.Results), paths(res)[:min(3, len(res.Results))])
		return res
	}
	timed("where does the backend decide which tools an employee is given")
	timed("how is the app restarted after a setting changes")
	if res := timed("驗證下載的模型檢查碼"); res.Mode != "hybrid" || len(res.Results) == 0 || res.Results[0].Path != "backend/internal/semantic/download.go" {
		t.Errorf("download.go is not first: %v", paths(res))
	}
	ev := log.events("semantic_search")
	t.Logf("last search %v", ev[len(ev)-1])

	t.Cleanup(func() {
		exec.Command("git", "-C", root, "checkout", "--", ".").Run()
		os.Remove(filepath.Join(root, "zz_semantic_probe.go"))
	})
	// write_file: a file rewritten is not handed out as it was
	target := filepath.Join(root, "backend/internal/usecase/tools/tools.go")
	if err := os.WriteFile(target, []byte("package tools\n\n// The tools were moved away.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.Changed(target, "write_file")
	for _, h := range timed("where does the backend decide which tools an employee is given").Results {
		if h.Path == "backend/internal/usecase/tools/tools.go" && strings.Contains(h.Text, "func For(") {
			t.Fatal("old content handed out after write_file")
		}
	}
	// run_command: a new file, searched by keyword until its vectors are ready, then by meaning too
	cmd := exec.Command("sh", "-c", "printf 'package probe\\n\\n// zebracorn ledger: counts striped unicorns in the stable\\nfunc Zebracorns() int { return 3 }\\n' > zz_semantic_probe.go")
	cmd.Dir = root
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	s.Changed(root, "run_command")
	res := timed("zebracorn")
	t.Logf("right after run_command: pending %d, reason %q", res.PendingFiles, res.Reason)
	if !slices.Contains(paths(res), "zz_semantic_probe.go") {
		t.Fatalf("new file not found by keyword: %v", paths(res))
	}
	deadline := time.Now().Add(time.Minute)
	for s.Status(true).Progress.PendingFiles > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := paths(timed("how many striped horses with a horn live in the barn")); !slices.Contains(got, "zz_semantic_probe.go") {
		t.Errorf("not found by meaning: %v", got)
	}
	assertNoCodeReal(t, log.String())
}

func (s *testService) waitStateWithin(t *testing.T, want string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st := s.Status(true)
		if st.State == want {
			return
		}
		if st.State == StateError {
			t.Fatalf("%+v\n%s", st.Error, s.log.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no %s", want)
}

func assertNoCodeReal(t *testing.T, log string) {
	t.Helper()
	for _, s := range []string{"func For(", "zebracorn ledger", "striped unicorns", "The tools were moved away"} {
		if strings.Contains(log, s) {
			t.Fatalf("the log has %q", s)
		}
	}
}

// recorder keeps every text sent to the model and what came back.
type recorder struct {
	embedder
	mu  sync.Mutex
	got []recorded
}

type recorded struct {
	text string
	out  embedded
}

func (r *recorder) embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error) {
	out, q, err := r.embedder.embed(ctx, texts, high)
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range out {
		r.got = append(r.got, recorded{texts[i], out[i]})
	}
	return out, q, err
}

// TestRealTokenLimits checks the model's real tokenizer at its limit, in a folder of its own:
//
//	SEMANTIC_REAL_HELPER=<semantic-helper> SEMANTIC_REAL_HOME=<data folder> go test -run TestRealTokenLimits -v ./internal/semantic/
//
// A line far over 2048 tokens is cut until every piece fits, and the pieces given vectors add up to the file; a
// query over the limit is refused, one under it is searched.
func TestRealTokenLimits(t *testing.T) {
	helper, home := os.Getenv("SEMANTIC_REAL_HELPER"), os.Getenv("SEMANTIC_REAL_HOME")
	if helper == "" || home == "" {
		t.Skip("set SEMANTIC_REAL_HELPER and SEMANTIC_REAL_HOME to run the real model")
	}
	log := &sink{}
	s := New(Options{DataDir: home, Log: zerolog.New(log).Level(zerolog.InfoLevel), Platform: Detect(helper)})
	t.Cleanup(s.Close)
	s.Start(true, nil)
	ts := &testService{Service: s, log: log}
	ts.waitStateWithin(t, StateReady, 30*time.Minute)

	repo := t.TempDir()
	git(t, repo, "init", "-q")
	var long strings.Builder
	salt := time.Now().UnixNano() % 1000003 // new text each run, so its vectors are computed, not found in the cache
	for i := range 2500 {
		fmt.Fprintf(&long, "%d ", int64(i)*7919+salt) // digits are a token each in Gemma: far over the limit, in one line
	}
	text := "first line\n" + long.String() + "\nlast line\n"
	write(t, repo, "long.txt", text)
	r := newRoot(canonical(repo))
	defer r.cancel()
	if _, err := r.scan(context.Background(), s.log, "scan"); err != nil {
		t.Fatal(err)
	}
	rec := &recorder{embedder: helperEmbedder{s}}
	st := &indexStats{}
	if _, err := r.indexPending(context.Background(), rec, s.cache, s.log, st); err != nil {
		t.Fatal(err)
	}
	seen := map[string]embedded{}
	tooLong := 0
	for _, g := range rec.got {
		seen[g.text] = g.out
		if g.out.tooLong {
			tooLong++
			if g.out.tokens <= MaxTokens {
				t.Fatalf("too long at %d tokens", g.out.tokens)
			}
		} else if g.out.tokens > MaxTokens || len(g.out.vec) != dim {
			t.Fatalf("a piece of %d tokens got a vector of %d", g.out.tokens, len(g.out.vec))
		}
	}
	if tooLong == 0 || st.splits == 0 {
		t.Fatalf("the long line was never over the limit: %d, %+v", tooLong, st)
	}
	// the cut again, in file order, by what the model said: every piece in the end has a vector, and they add up
	lines := splitLines(text)
	lineText := func(a, b int) string { return strings.Join(lines[a-1:b], "") }
	var joined strings.Builder
	var walk func(p piece)
	walk = func(p piece) {
		out, sent := seen[docPrefix+p.body]
		switch {
		case sent && out.tooLong:
			parts, ok := p.split(lineText)
			if !ok {
				t.Fatalf("line %d cannot be cut", p.start)
			}
			for _, q := range parts {
				walk(q)
			}
		case sent || s.cache.get(key(docPrefix+p.body)) != nil:
			joined.WriteString(p.body)
		default:
			t.Fatalf("a piece at line %d got no vector", p.start)
		}
	}
	for _, p := range cut(text) {
		walk(p)
	}
	if joined.String() != text {
		t.Fatal("the pieces given vectors do not add up to the file")
	}
	most := 0
	for _, g := range rec.got {
		if !g.out.tooLong {
			most = max(most, g.out.tokens)
		}
	}
	t.Logf("%d texts sent, %d over the limit, %d splits, largest piece %d tokens", len(rec.got), tooLong, st.splits, most)

	// queries: digits are a token each, so 3000 of them are over the limit in fewer than 4096 bytes
	search(t, ts, repo, "first line") // scans the folder, which then waits to be indexed
	waitIndexed(t, ts, repo)
	over, err := s.Search(context.Background(), Query{Cwd: repo, Text: strings.Repeat("7", 3000)})
	var user *UserError
	if !errors.As(err, &user) || !strings.Contains(err.Error(), "tokens") {
		t.Fatalf("a query over the limit: %v, %s %q", err, over.Mode, over.Reason)
	}
	t.Logf("over the limit: %v", err)
	res, err := s.Search(context.Background(), Query{Cwd: repo, Text: strings.Repeat("7", 1500)})
	if err != nil || res.Mode != "hybrid" {
		t.Fatalf("a query under the limit: %v %+v", err, res.Reason)
	}
	assertNoCodeReal(t, log.String())
	if strings.Contains(log.String(), fmt.Sprintf("%d %d", 7919+salt, 2*7919+salt)) {
		t.Fatal("file content in the log")
	}
}
