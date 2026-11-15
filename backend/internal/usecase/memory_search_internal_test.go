package usecase

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/semantic"
)

// ranker stands in for the model: it keeps what it was given and answers with pick of it, or keyword only when pick
// is nil.
type ranker struct {
	got  []semantic.Note
	pick func(notes []semantic.Note) []string
}

func (r *ranker) rank(_ context.Context, _ string, notes []semantic.Note) ([]string, bool) {
	r.got = slices.Clone(notes)
	if r.pick == nil {
		return nil, false
	}
	return r.pick(notes), true
}

func ids(notes []semantic.Note) []string {
	var out []string
	for _, n := range notes {
		out = append(out, n.ID)
	}
	return out
}

func searchAs(e *Engine, teamID, replicaID, query string) model.ToolResult {
	return e.searchMemoryTool(func() (string, *string) { return teamID, &replicaID }).Run(context.Background(), "", []byte(`{"query":`+quote(query)+`}`))
}

func quote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"` }

func resultIDs(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if i, j := strings.Index(line, "["), strings.Index(line, ","); i >= 0 && j > i {
			out = append(out, line[i+1:j])
		}
	}
	return out
}

// A Chinese sentence sharing no words with a note finds it by meaning, each line still marked company or yours.
func TestSearchMemoryFindsByMeaning(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Teams["A"].Memory = []model.MemoryEntry{{ID: "c1", Text: "發版流程：先 bump 版本再 make build sign notarize", Source: "work", At: 86400, By: "ada"}}
	e.w.Replicas["ada"].Memory = []model.MemoryEntry{{ID: "m1", Text: "改之前先讀測試", Source: "chat", At: 86400}}
	if got := searchAs(e, "A", "ada", "如何上架應用程式"); got.IsError || got.Text != "No notes match." {
		t.Fatalf("by keyword alone it is not found: %+v", got)
	}
	r := &ranker{pick: func([]semantic.Note) []string { return []string{"c1", "m1"} }}
	e.rankNotes = r.rank
	got := searchAs(e, "A", "ada", "如何上架應用程式")
	if got.IsError || got.Text != "company [c1, 1970-01-02, Ada] 發版流程：先 bump 版本再 make build sign notarize\nyours [m1, 1970-01-02, chat] 改之前先讀測試\n" {
		t.Fatalf("%q", got.Text)
	}
}

// An exact word keeps its note even when the model ranks others, and a note found both ways comes first.
func TestSearchMemoryFusesKeywordsAndMeaning(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Teams["A"].Memory = []model.MemoryEntry{
		{ID: "exact", Text: "run make notarize-dry before shipping", Source: "user", At: 86400},
		{ID: "close", Text: "ship releases through the pipeline", Source: "user", At: 86400},
		{ID: "both", Text: "notarize-dry needs the keychain profile; ship after it", Source: "user", At: 86400},
		{ID: "far", Text: "the frontend uses npm", Source: "user", At: 86400},
	}
	e.rankNotes = (&ranker{pick: func([]semantic.Note) []string { return []string{"both", "close"} }}).rank
	got := resultIDs(searchAs(e, "A", "ada", "notarize-dry").Text)
	if !slices.Equal(got, []string{"both", "exact", "close"}) {
		t.Fatalf("%v", got)
	}
}

// Keyword search alone, the same as before, when the model cannot rank: off, not ready, an error or too slow.
func TestSearchMemoryFallsBackToKeywords(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Teams["A"].Memory = []model.MemoryEntry{
		{ID: "a", Text: "Use npm for the frontend", Source: "user", At: 86400},
		{ID: "b", Text: "frontend tests", Source: "user", At: 86400},
		{ID: "c", Text: "Notarize with notarytool", Source: "user", At: 86400},
	}
	want := searchAs(e, "A", "ada", "npm frontend")
	if want.IsError || !slices.Equal(resultIDs(want.Text), []string{"a", "b"}) {
		t.Fatalf("%+v", want)
	}
	r := &ranker{}
	e.rankNotes = r.rank
	if got := searchAs(e, "A", "ada", "npm frontend"); got.IsError || got.Text != want.Text || len(r.got) != 3 {
		t.Fatalf("%+v", got)
	}
	if got := searchAs(e, "A", "ada", "docker"); got.IsError || got.Text != "No notes match." {
		t.Fatalf("%+v", got)
	}
}

// Only this company's notes and the caller's own reach the model or the result, whatever the model answers.
func TestSearchMemoryReadsOnlyWhatTheCallerMay(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Replicas["bo"] = &model.Replica{ID: "bo", TeamID: "A", Name: "Bo", Memory: []model.MemoryEntry{{ID: "bo1", Text: "Bo 的筆記", Source: "chat", At: 86400}}}
	e.w.Teams["A"].Memory = []model.MemoryEntry{{ID: "a1", Text: "A 的筆記", Source: "user", At: 86400}}
	e.w.Teams["B"].Memory = []model.MemoryEntry{{ID: "b1", Text: "B 的筆記", Source: "user", At: 86400}}
	e.w.Replicas["ada"].Memory = []model.MemoryEntry{{ID: "ada1", Text: "Ada 的筆記", Source: "chat", At: 86400}}
	r := &ranker{pick: func(n []semantic.Note) []string { return append(ids(n), "b1", "bo1") }}
	e.rankNotes = r.rank
	got := searchAs(e, "A", "ada", "筆記")
	if !slices.Equal(ids(r.got), []string{"a1", "ada1"}) {
		t.Fatalf("the model was given %v", ids(r.got))
	}
	if !slices.Equal(resultIDs(got.Text), []string{"a1", "ada1"}) || strings.Contains(got.Text, "B 的") || strings.Contains(got.Text, "Bo 的") {
		t.Fatalf("%q", got.Text)
	}
	// Ada's own notes go with her to B; A's stay in A
	got = searchAs(e, "B", "ada", "筆記")
	if !slices.Equal(ids(r.got), []string{"b1", "ada1"}) || !slices.Equal(resultIDs(got.Text), []string{"b1", "ada1"}) {
		t.Fatalf("in B: %v %q", ids(r.got), got.Text)
	}
}

// The model ranks with the engine's lock let go, so a slow search holds up no one.
func TestSearchMemoryRanksWithoutTheLock(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Teams["A"].Memory = []model.MemoryEntry{{ID: "a1", Text: "note", Source: "user", At: 86400}}
	locked := true
	e.rankNotes = func(context.Context, string, []semantic.Note) ([]string, bool) {
		if e.mu.TryLock() {
			locked = false
			e.mu.Unlock()
		}
		return nil, false
	}
	searchAs(e, "A", "ada", "note")
	if locked {
		t.Fatal("the lock was held while ranking")
	}
}

// What remember and forget change is what the very next search sees.
func TestSearchMemorySeesRememberAndForget(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	r := &ranker{pick: ids}
	e.rankNotes = r.rank
	ada := "ada"
	e.remember("A", &ada, scopeCompany, "部署走 make deploy", "work", "", "")
	e.remember("", &ada, scopeMine, "先讀再改", "work", "", "")
	company, own := e.w.Teams["A"].Memory[0].ID, e.w.Replicas["ada"].Memory[0].ID
	if got := resultIDs(searchAs(e, "A", "ada", "上線").Text); !slices.Equal(got, []string{company, own}) {
		t.Fatalf("%v", got)
	}
	e.forget("A", &ada, company)
	got := searchAs(e, "A", "ada", "上線")
	if !slices.Equal(ids(r.got), []string{own}) || strings.Contains(got.Text, company) {
		t.Fatalf("a forgotten note: %v %q", ids(r.got), got.Text)
	}
}

func TestSearchMemoryNeedsAQuery(t *testing.T) {
	t.Parallel()
	e := memoryWorld()
	e.w.Teams["A"].Memory = []model.MemoryEntry{{ID: "a1", Text: "note", Source: "user", At: 86400}}
	r := &ranker{pick: ids}
	e.rankNotes = r.rank
	for _, raw := range []string{`{"query":"  "}`, `{}`, `nope`} {
		got := e.searchMemoryTool(func() (string, *string) { id := "ada"; return "A", &id }).Run(context.Background(), "", []byte(raw))
		if !got.IsError || got.Text != "query is required" || r.got != nil {
			t.Fatalf("%s: %+v", raw, got)
		}
	}
}

// A Chinese sentence without spaces still finds, by keyword alone, notes sharing two characters in a row with it;
// whole words count for more.
func TestSearchMemoryKeywordsInChinese(t *testing.T) {
	t.Parallel()
	all := []model.MemoryEntry{
		{ID: "npm", Text: "前端用 npm"},
		{ID: "pair", Text: "設定頁可以開啟語意搜尋"},
		{ID: "word", Text: "語意搜尋怎麼設定：到設定頁"},
	}
	got := resultIDs(searchMemory(all, "語意搜尋怎麼設定", nil, memoryLine))
	if !slices.Equal(got, []string{"word", "pair"}) {
		t.Fatalf("%v", got)
	}
	if got := searchMemory(all, "打包發佈", nil, memoryLine); got != "No notes match." {
		t.Fatalf("%q", got)
	}
	if words, pairs := memoryTerms("Go測試 測試 a"); !slices.Equal(words, []string{"go測試", "測試", "a"}) || len(pairs) != 0 {
		t.Fatalf("%v %v", words, pairs)
	}
}

// Fused results are capped like keyword ones, saying how many more there are.
func TestSearchMemoryCapsFusedResults(t *testing.T) {
	t.Parallel()
	all := notes(memorySearchLimit+5, func(int) string { return "x" })
	var vector []string
	for _, m := range all {
		vector = append(vector, m.ID)
	}
	got := searchMemory(all, "zzz", vector, memoryLine)
	if strings.Count(got, "\n- [")+1 != memorySearchLimit || !strings.Contains(got, "5 more match") || !strings.HasPrefix(got, "- [mem-0,") {
		t.Fatalf("%s", got)
	}
}

// Distinct Han pairs must not turn embedding fallback into an unbounded keyword scan.
func TestSearchMemoryLongChineseQuery(t *testing.T) {
	e := memoryWorld()
	e.w.Teams["A"].Memory = notes(200, func(int) string { return strings.Repeat("一", 5500) })
	var query strings.Builder
	for a := rune(0x4e00); a < 0x4f00; a++ {
		for b := rune(0x5000); b < 0x5100; b++ {
			query.WriteRune(a)
			query.WriteRune(b)
		}
	}
	var sem *semantic.Service
	e.rankNotes = sem.RankNotes
	start := time.Now()
	got := searchAs(e, "A", "ada", query.String())
	t.Logf("%d query bytes, 200 notes: %s", query.Len(), time.Since(start))
	if !got.IsError || got.Text != "query is longer than 4096 bytes; shorten it" {
		t.Fatalf("oversized query was not rejected: error=%v, result bytes=%d", got.IsError, len(got.Text))
	}
}

// The byte limit applies before ranking, independently of model readiness, without changing keyword fallback
// at the boundary. In particular, it counts UTF-8 bytes rather than characters.
func TestSearchMemoryQueryLimit(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, query string
		tooLong     bool
	}{
		{"below", "npm " + strings.Repeat("x", 4091), false},
		{"boundary", "npm " + strings.Repeat("x", 4092), false},
		{"unicode boundary", "npm " + strings.Repeat("字", 1364), false},
		{"above", "npm " + strings.Repeat("x", 4093), true},
		{"unicode above", "npm " + strings.Repeat("字", 1365), true},
		{"many words", strings.Repeat("npm ", 4096), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := memoryWorld()
			e.w.Teams["A"].Memory = []model.MemoryEntry{{ID: "npm", Text: "Use npm", Source: "user", At: 86400}}
			called := false
			e.rankNotes = func(_ context.Context, query string, _ []semantic.Note) ([]string, bool) {
				called = true
				if query != tc.query {
					t.Fatal("query changed before ranking")
				}
				return nil, false
			}
			got := searchAs(e, "A", "ada", tc.query)
			if tc.tooLong {
				if !got.IsError || got.Text != "query is longer than 4096 bytes; shorten it" || called {
					t.Fatalf("oversized query: %+v, ranker called=%v", got, called)
				}
			} else if got.IsError || !slices.Equal(resultIDs(got.Text), []string{"npm"}) || !called {
				t.Fatalf("keyword fallback at boundary: %+v, ranker called=%v", got, called)
			}
		})
	}
}
