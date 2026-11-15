package semantic

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// conceptEmbedder is a model that knows synonyms: a text points along every concept one of whose words it holds.
// It counts what it is sent, and fail or block, when set, stand in for a helper that errs or hangs.
type conceptEmbedder struct {
	mu       sync.Mutex
	batches  [][]string
	fail     error
	block    func(batch int) bool
	tooLong  string
	concepts [][]string
}

func (e *conceptEmbedder) embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error) {
	e.mu.Lock()
	e.batches = append(e.batches, slices.Clone(texts))
	n := len(e.batches)
	e.mu.Unlock()
	if !high {
		return nil, 0, errors.New("a memory search must go before indexing")
	}
	if e.fail != nil {
		return nil, 0, e.fail
	}
	if e.block != nil && e.block(n) {
		<-ctx.Done()
		return nil, 0, ctx.Err()
	}
	out := make([]embedded, len(texts))
	for i, t := range texts {
		if e.tooLong != "" && strings.Contains(t, e.tooLong) {
			out[i] = embedded{tokens: MaxTokens + 1, tooLong: true}
			continue
		}
		v := make([]float32, dim)
		for c, words := range e.concepts {
			for _, w := range words {
				if strings.Contains(t, w) {
					v[c] = 1
				}
			}
		}
		v[dim-1] = 0.01 // nothing is quite orthogonal
		normalize(v)
		out[i] = embedded{tokens: len(t), vec: v}
	}
	return out, 0, nil
}

// sent is every note text sent to the model so far, without the prefix; the queries are left out.
func (e *conceptEmbedder) sent() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, b := range e.batches {
		for _, t := range b {
			if strings.HasPrefix(t, memoryDocPrefix) {
				out = append(out, strings.TrimPrefix(t, memoryDocPrefix))
			}
		}
	}
	return out
}

var shipping = [][]string{{"上架", "發版", "release", "ship"}, {"npm", "套件"}, {"測試", "test"}}

func memoryService(t *testing.T) (*Service, *sink) {
	t.Helper()
	log := &sink{}
	s := New(Options{DataDir: t.TempDir(), Log: zerolog.New(log).Level(zerolog.DebugLevel), Platform: supported})
	t.Cleanup(s.Close)
	return s, log
}

func noteList(texts ...string) []Note {
	out := make([]Note, len(texts))
	for i, t := range texts {
		out[i] = Note{ID: fmt.Sprint("n", i), Text: t}
	}
	return out
}

// A Chinese sentence sharing no words with a note finds it by meaning; notes about something else are left out.
func TestNotesRankedByMeaning(t *testing.T) {
	s, log := memoryService(t)
	emb := &conceptEmbedder{concepts: shipping}
	notes := noteList("前端用 npm 管套件", "發版流程：bump 再 notarize", "部署前先跑 make test")
	ranked, ok := s.rankNotes(context.Background(), emb, true, "怎麼把新版本上架", notes)
	if !ok || !slices.Equal(ranked, []string{"n1"}) {
		t.Fatalf("%v %v", ranked, ok)
	}
	if q := emb.batches[0]; len(q) != 1 || q[0] != memoryQueryPrefix+"怎麼把新版本上架" {
		t.Fatalf("the query went as %q", q)
	}
	ev := log.events("semantic_memory_search")
	if len(ev) != 1 || ev[0]["mode"] != "hybrid" || ev[0]["notes"] != float64(3) || ev[0]["computed"] != float64(3) {
		t.Fatalf("%v", ev)
	}
	// neither the query nor any note reaches the log, at any level
	for _, secret := range []string{"上架", "npm", "notarize", "make test"} {
		if strings.Contains(log.String(), secret) {
			t.Fatalf("%q is in the log:\n%s", secret, log.String())
		}
	}
}

// Vectors are kept by the note's text: the next search sends only what is new or rewritten, never a note twice.
func TestNoteVectorsAreReused(t *testing.T) {
	s, log := memoryService(t)
	emb := &conceptEmbedder{concepts: shipping}
	notes := noteList("前端用 npm", "發版流程", "前端用 npm")
	if _, ok := s.rankNotes(context.Background(), emb, true, "上架", notes); !ok {
		t.Fatal("not ranked")
	}
	if got := emb.sent(); !slices.Equal(got, []string{"前端用 npm", "發版流程"}) {
		t.Fatalf("first search sent %v", got)
	}
	notes[1].Text = "release 走 make release"
	ranked, ok := s.rankNotes(context.Background(), emb, true, "上架", notes)
	if !ok || !slices.Equal(ranked, []string{"n1"}) {
		t.Fatalf("%v", ranked)
	}
	if got := emb.sent(); !slices.Equal(got, []string{"前端用 npm", "發版流程", "release 走 make release"}) {
		t.Fatalf("second search sent %v", got)
	}
	if ev := log.events("semantic_memory_search"); ev[1]["cached"] != float64(1) || ev[1]["computed"] != float64(1) {
		t.Fatalf("%v", ev[1])
	}
}

// Notes go to the model a few at a time; a search cut short keeps what it got, so the next one has less to do.
func TestNoteBatchesAreBoundedAndKept(t *testing.T) {
	s, _ := memoryService(t)
	s.noteBudget = 100 * time.Millisecond
	var texts []string
	for i := range 40 {
		texts = append(texts, fmt.Sprintf("note %d", i))
	}
	notes := noteList(texts...)
	// the query and the first batch of notes are answered; the second batch hangs
	emb := &conceptEmbedder{concepts: shipping, block: func(n int) bool { return n == 3 }}
	start := time.Now()
	if _, ok := s.rankNotes(context.Background(), emb, true, "note", notes); ok {
		t.Fatal("ranked although a batch never came back")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %s", d)
	}
	for _, b := range emb.batches {
		if len(b) > memoryBatch {
			t.Fatalf("a batch of %d", len(b))
		}
	}
	if s.notes.len() != memoryBatch {
		t.Fatalf("kept %d", s.notes.len())
	}
	emb = &conceptEmbedder{concepts: shipping}
	ranked, ok := s.rankNotes(context.Background(), emb, true, "note", notes)
	if !ok || len(ranked) != 40 || len(emb.sent()) != 40-memoryBatch {
		t.Fatalf("%d ranked, %d sent", len(ranked), len(emb.sent()))
	}
}

// The cache holds at most its size, dropping the least recently used; a search over more notes than it holds still
// ranks them all.
func TestNoteCacheIsBounded(t *testing.T) {
	c := newNoteCache(2)
	c.put("a", noteVector{tooLong: true})
	c.put("b", noteVector{tooLong: true})
	c.get("a")
	c.put("c", noteVector{tooLong: true})
	if _, ok := c.get("b"); ok || c.len() != 2 {
		t.Fatal("b was not the one dropped")
	}
	if _, ok := c.get("a"); !ok {
		t.Fatal("a, used last, was dropped")
	}
	s, _ := memoryService(t)
	s.notes = newNoteCache(3)
	emb := &conceptEmbedder{concepts: shipping}
	ranked, ok := s.rankNotes(context.Background(), emb, true, "上架", noteList("發版 1", "發版 2", "發版 3", "發版 4", "發版 5"))
	if !ok || len(ranked) != 5 || s.notes.len() != 3 {
		t.Fatalf("%v, cache %d", ranked, s.notes.len())
	}
}

// A note over the model's limit has no vector, is not sent again, and is left to keywords.
func TestNotesTooLongAreLeftToKeywords(t *testing.T) {
	s, log := memoryService(t)
	emb := &conceptEmbedder{concepts: shipping, tooLong: "TOOLONG"}
	huge := "發版 " + strings.Repeat("x", memoryNoteBytes)
	notes := noteList("發版 TOOLONG", huge, "發版流程")
	for range 2 {
		ranked, ok := s.rankNotes(context.Background(), emb, true, "上架", notes)
		if !ok || !slices.Equal(ranked, []string{"n2"}) {
			t.Fatalf("%v %v", ranked, ok)
		}
	}
	if got := emb.sent(); !slices.Equal(got, []string{"發版 TOOLONG", "發版流程"}) {
		t.Fatalf("sent %d notes: the huge one, or one again", len(got))
	}
	if ev := log.events("semantic_memory_search"); ev[1]["tooLong"] != float64(2) || ev[1]["computed"] != float64(0) {
		t.Fatalf("%v", ev[1])
	}
}

// Whenever vectors cannot be used, RankNotes says so at once, for keyword search, and never fails.
func TestRankNotesFallsBack(t *testing.T) {
	var nilService *Service
	if r, ok := nilService.RankNotes(context.Background(), "x", noteList("x")); ok || r != nil {
		t.Fatal("a nil service ranked")
	}
	off, offLog := memoryService(t)
	if _, ok := off.RankNotes(context.Background(), "x", noteList("x")); ok || offLog.String() != "" {
		t.Fatalf("an inactive service ranked or logged: %s", offLog.String())
	}
	cases := []struct {
		name, query, reason string
		ready               bool
		emb                 *conceptEmbedder
	}{
		{"not ready", "上架", "not_ready", false, &conceptEmbedder{}},
		{"bytes", strings.Repeat("字", maxQueryBytes), "query_too_long", true, &conceptEmbedder{}},
		{"tokens", "上架 TOOLONG", "query_too_many_tokens", true, &conceptEmbedder{tooLong: "TOOLONG"}},
		{"error", "上架", "embed_error", true, &conceptEmbedder{fail: errors.New("helper: kind=coreai domain=other code=7")}},
		{"timeout", "上架", "timeout", true, &conceptEmbedder{block: func(int) bool { return true }}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, log := memoryService(t)
			s.noteBudget = 50 * time.Millisecond
			r, ok := s.rankNotes(context.Background(), c.emb, c.ready, c.query, noteList("發版流程"))
			if ok || r != nil {
				t.Fatalf("ranked: %v", r)
			}
			ev := log.events("semantic_memory_search")
			if len(ev) != 1 || ev[0]["mode"] != "keyword" || ev[0]["reason"] != c.reason {
				t.Fatalf("%v", ev)
			}
		})
	}
	// cancelled by whoever asked: keyword at once too
	s, _ := memoryService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := s.rankNotes(ctx, &conceptEmbedder{block: func(int) bool { return true }}, true, "上架", noteList("x")); ok {
		t.Fatal("ranked after cancel")
	}
}

// Through the helper: memory searches rank notes while the code index stays exactly as it was, its files, counts,
// state, stored vectors and results untouched; searches that give up leave nothing queued behind.
func TestMemorySearchKeepsApartFromTheCodeIndex(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	if _, ok := s.RankNotes(context.Background(), "ledger", noteList("ledger")); ok {
		t.Fatal("ranked before the model was started")
	}
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	waitIndexed(t, s, repo)
	before, beforeRes, beforeFiles := s.Status(true), search(t, s, repo, "monthly ledger balance"), vectorFiles(t, s)

	notes := noteList("the monthly ledger balance is reconciled on Fridays", "forecast rain for tomorrow", "ledger")
	ranked, ok := s.RankNotes(context.Background(), "ledger balance reconciled monthly", notes)
	if !ok || len(ranked) == 0 || ranked[0] != "n0" || slices.Contains(ranked, "n1") {
		t.Fatalf("%v %v\n%s", ranked, ok, s.log.String())
	}
	if after := s.Status(true); after.State != before.State || after.Progress != before.Progress {
		t.Fatalf("status moved: %+v -> %+v", before, after)
	}
	if got := vectorFiles(t, s); got != beforeFiles {
		t.Fatalf("stored vectors: %d -> %d", beforeFiles, got)
	}
	if res := search(t, s, repo, "monthly ledger balance"); res.Mode != beforeRes.Mode || !slices.Equal(paths(res), paths(beforeRes)) {
		t.Fatalf("code search changed: %v -> %v", paths(beforeRes), paths(res))
	}

	// a slow helper: each search gives up within its budget, and what it asked for is dropped, not run later
	s.noteBudget = 30 * time.Millisecond
	t.Setenv("FAKE_DELAY", "200ms") // read by helpers started from now on
	h := s.currentHelper()
	h.mu.Lock()
	c := h.child
	h.child = nil
	h.mu.Unlock()
	c.close()
	within(t, 5*time.Second, "ten memory searches", func() {
		for i := range 10 {
			if _, ok := s.RankNotes(context.Background(), "something new", noteList(fmt.Sprint("new note ", i))); ok {
				t.Error("ranked although the helper was slower than the budget")
			}
		}
	})
	waiting := -1
	for deadline := time.Now().Add(5 * time.Second); waiting != 0 && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		h.mu.Lock()
		waiting = len(h.high) + len(h.low)
		h.mu.Unlock()
	}
	if waiting != 0 {
		t.Fatalf("%d requests still queued", waiting)
	}
}

func vectorFiles(t *testing.T, s *testService) int {
	t.Helper()
	n := 0
	filepath.WalkDir(filepath.Join(s.dir, "vectors"), func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}
