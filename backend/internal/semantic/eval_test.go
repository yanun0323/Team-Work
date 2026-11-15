package semantic

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/rs/zerolog"
)

// evalCase is one question of the fixed search benchmark: a hit is a result in one of paths whose text holds anchor.
type evalCase struct {
	id, cat, query string
	paths          []string
	anchor         string
}

var (
	uiLocales      = []string{"frontend/src/core/i18n.ts", "frontend/src/core/locales/ja.ts", "frontend/src/core/locales/ko.ts", "frontend/src/core/locales/zhHans.ts"}
	backendLocales = []string{"backend/internal/i18n/en.go", "backend/internal/i18n/ja.go", "backend/internal/i18n/ko.go", "backend/internal/i18n/zh_hans.go"}
)

// evalCases are fixed against commit d15b677: (a) Chinese for English code, (b) English for code, (c) exact names,
// (d) docs and interface text. Never change one to make a score better.
var evalCases = []evalCase{
	{"A1", "a", "把超過模型 token 上限的切塊再對半切開", []string{"backend/internal/semantic/chunk.go"}, "func (p piece) split("},
	{"A2", "a", "向量快取清掉很久沒用到的檔案", []string{"backend/internal/semantic/chunk.go"}, "func (v *vectors) sweep("},
	{"A3", "a", "關鍵字搜尋怎麼替每個切塊計分", []string{"backend/internal/semantic/search.go"}, "func (s *Service) keyword("},
	{"A4", "a", "檔案內容改變時讓舊向量失效並重新排入索引", []string{"backend/internal/semantic/index.go"}, "func (r *root) scan("},
	{"A5", "a", "記憶筆記向量的記憶體快取上限", []string{"backend/internal/semantic/memory.go"}, "func newNoteCache("},
	{"A6", "a", "終端機輸出只保留最後五千行", []string{"backend/internal/usecase/terminal_log.go"}, "terminalLogLines = 5000"},
	{"A7", "a", "Claude Code 子程序的環境變數怎麼設定", []string{"backend/internal/providers/claude/process.go"}, "func childEnvironment()"},
	{"A8", "a", "下載模型後逐一核對檔案的 SHA-256 校驗碼", []string{"backend/internal/semantic/download.go"}, `f.get(ctx, "CHECKSUMS.sha256"`},
	{"B1", "b", "fuse keyword and vector results by reciprocal rank", []string{"backend/internal/semantic/search.go"}, "func fuse("},
	{"B2", "b", "cut a file into chunks of whole lines for embedding", []string{"backend/internal/semantic/chunk.go"}, "func cut(text string)"},
	{"B3", "b", "leave secret files and lockfiles out of the index", []string{"backend/internal/semantic/files.go"}, "func excluded(rel string)"},
	{"B4", "b", "keep the tool's JSON result within 50 KiB by cutting results short", []string{"backend/internal/semantic/search.go"}, "func fit(res *Result)"},
	{"B5", "b", "list tracked and untracked files with git for indexing", []string{"backend/internal/semantic/files.go"}, "func list(ctx context.Context, root string)"},
	{"B6", "b", "log each model call's token usage", []string{"backend/internal/usecase/usage.go"}, "func (m meter) logCall("},
	{"B7", "b", "retry a model call while the provider is temporarily unavailable", []string{"backend/internal/usecase/run.go"}, "attempt == modelRetries"},
	{"B8", "b", "rank memory notes by meaning and fall back to keywords", []string{"backend/internal/semantic/memory.go"}, "func (s *Service) RankNotes("},
	{"C1", "c", "halvesUntil", []string{"backend/internal/semantic/chunk.go"}, "func halvesUntil("},
	{"C2", "c", "maxResultBytes", []string{"backend/internal/semantic/search.go"}, "maxResultBytes = 50 << 10"},
	{"C3", "c", "ENABLE_TOOL_SEARCH", []string{"backend/internal/providers/claude/process.go"}, `"ENABLE_TOOL_SEARCH=false"`},
	{"C4", "c", "keepsEscape", []string{"frontend/src/core/model.ts"}, "export const keepsEscape ="},
	{"C5", "c", "crewOrder", []string{"frontend/src/Pickers.tsx"}, "export const crewOrder ="},
	{"C6", "c", "boxKey", []string{"frontend/src/MentionBox.tsx"}, "export function boxKey("},
	{"C7", "c", "readText", []string{"backend/internal/semantic/files.go"}, "func readText(dir *os.Root, rel string)"},
	{"D1", "d", "「語意搜尋」開關的翻譯", uiLocales, "'語意搜尋': '"},
	{"D2", "d", "下載模型中的進度文字翻譯", uiLocales, "'下載模型中 {done} / {total} MB'"},
	{"D3", "d", "「這台 Mac 還沒有 git」錯誤訊息的翻譯", backendLocales, `"這台 Mac 還沒有 git`},
	{"D4", "d", "系統設定減少動態時雲影和海浪會不會停住", []string{"frontend/README.md"}, "系統設定減少動態時都會停住"},
	{"D5", "d", "辦公室收起後再打開，關著的時間最多補算多久", []string{"frontend/README.md"}, "最多兩分鐘"},
	{"D6", "d", "exec 腳本能呼叫哪些唯讀工具", []string{"backend/README.md"}, "**能呼叫什麼**"},
	{"D7", "d", "Immigration Office in the help page", []string{"frontend/src/HelpEn.tsx"}, "<dt>Immigration Office</dt>"},
}

// isShell is a text with no letter or digit in it.
func isShell(s string) bool {
	return !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) })
}

type evalRow struct {
	Mode, ID, Cat     string
	Rank              int // 0: not in the results
	Bytes, MaxHit, MS int
	MaxPart           int // the largest part of a long line given
	Shells, NonCore5  int
}

// TestSearchEval runs the fixed benchmark on a snapshot of the project, never on a work tree being changed:
//
//	SNAP=$(mktemp -d)/snap; git archive d15b677 | tar -x -C "$SNAP"; git -C "$SNAP" init -q; git -C "$SNAP" add -A
//	git -C "$SNAP" -c user.name=eval -c user.email=eval@local commit -qm snap
//	SEMANTIC_EVAL_ROOT=$SNAP go test -run TestSearchEval -v ./internal/semantic/
//
// It runs keyword search alone; SEMANTIC_EVAL_FAKE=1 adds the made-up model, which only shows the flow still works;
// SEMANTIC_REAL_HELPER and SEMANTIC_REAL_HOME add the real model. The home is written to, so give it a copy of the
// cache, never the app's own:
//
//	H=$(mktemp -d); mkdir -p $H/cache; cp -cR ~/.team-work/cache/semantic-search $H/cache/
//	env -u TMPDIR SEMANTIC_EVAL_ROOT=$SNAP SEMANTIC_REAL_HELPER="/Applications/Team Work.app/Contents/Helpers/semantic-helper" \
//		SEMANTIC_REAL_HOME=$H go test -run TestSearchEval -v -timeout 3h ./internal/semantic/
//
// SEMANTIC_EVAL_OUT writes the rows as JSON.
func TestSearchEval(t *testing.T) {
	root := os.Getenv("SEMANTIC_EVAL_ROOT")
	if root == "" {
		t.Skip("set SEMANTIC_EVAL_ROOT to a snapshot of the project to run the search benchmark")
	}
	root = canonical(root)
	var rows []evalRow

	// keyword: no model, the same ranking and checks the tool uses
	ks := New(Options{Log: zerolog.Nop()})
	r := newRoot(root)
	defer r.cancel()
	if _, err := r.scan(context.Background(), ks.log, "scan"); err != nil {
		t.Fatal(err)
	}
	rows = append(rows, evalMode(t, "keyword", func(q string) Result { return ks.keywordOnly(r, q, 10) })...)

	if os.Getenv("SEMANTIC_EVAL_FAKE") == "1" {
		s := newService(t, "", zerolog.InfoLevel, nil)
		s.Start(true, []string{root})
		s.waitState(t, StateReady)
		waitIndexedWithin(t, s, root, 10*time.Minute)
		rows = append(rows, evalMode(t, "fake", func(q string) Result { return evalSearch(t, s.Service, root, q) })...)
	}
	if helper, home := os.Getenv("SEMANTIC_REAL_HELPER"), os.Getenv("SEMANTIC_REAL_HOME"); helper != "" && home != "" {
		log := &sink{}
		s := New(Options{DataDir: home, Log: zerolog.New(log).Level(zerolog.InfoLevel), Platform: Detect(helper)})
		t.Cleanup(s.Close)
		start := time.Now()
		s.Start(true, []string{root})
		ts := &testService{Service: s, log: log}
		ts.waitStateWithin(t, StateReady, 3*time.Hour)
		waitIndexedWithin(t, ts, root, 3*time.Hour)
		t.Logf("real model ready and indexed in %s", time.Since(start))
		rows = append(rows, evalMode(t, "hybrid", func(q string) Result { return evalSearch(t, s, root, q) })...)
	}
	evalSummary(t, rows)
	if out := os.Getenv("SEMANTIC_EVAL_OUT"); out != "" {
		raw, _ := json.MarshalIndent(rows, "", " ")
		if err := os.WriteFile(out, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// keywordOnly is Search without vectors: keywords, fused, read again and fitted, as the tool gives them.
func (s *Service) keywordOnly(r *root, q string, limit int) Result {
	merged := fuse(s.keyword(r, q), nil, limit)
	hits, _, _, _ := s.verify(r, merged)
	res := Result{Mode: "keyword", Reason: "keyword search only", Results: hits}
	fit(&res)
	return res
}

func evalSearch(t *testing.T, s *Service, root, q string) Result {
	t.Helper()
	res, err := s.Search(context.Background(), Query{Cwd: root, Text: q})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != "hybrid" {
		t.Fatalf("%q: %s, %s", q, res.Mode, res.Reason)
	}
	return res
}

func waitIndexedWithin(t *testing.T, s *testService, dir string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		s.poke()
		s.mu.Lock()
		r := s.roots[canonical(dir)]
		s.mu.Unlock()
		if r != nil {
			if done, pending, _ := r.counts(); pending == 0 && done > 0 {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("never indexed")
}

func evalMode(t *testing.T, mode string, run func(string) Result) []evalRow {
	var rows []evalRow
	for _, c := range evalCases {
		start := time.Now()
		res := run(c.query)
		row := evalRow{Mode: mode, ID: c.id, Cat: c.cat, MS: int(time.Since(start).Milliseconds()), Bytes: jsonSize(res)}
		for i, h := range res.Results {
			row.MaxHit = max(row.MaxHit, len(h.Text))
			if h.Note != "" {
				row.MaxPart = max(row.MaxPart, len(h.Text))
			}
			if isShell(h.Text) {
				row.Shells++
			}
			if row.Rank == 0 && slices.Contains(c.paths, h.Path) && strings.Contains(h.Text, c.anchor) {
				row.Rank = i + 1
			}
			if i < 5 && notCode(h.Path) {
				row.NonCore5++
			}
		}
		rank := "-"
		if row.Rank > 0 {
			rank = fmt.Sprint(row.Rank)
		}
		t.Logf("EVAL\t%s\t%s\t%s\trank=%s\tbytes=%d\tms=%d\ttop=%v", mode, c.id, c.cat, rank, row.Bytes, row.MS, paths(res)[:min(3, len(res.Results))])
		rows = append(rows, row)
	}
	return rows
}

// evalSummary logs, per mode and category, Top-5 and Top-10 hits, MRR@10, JSON bytes, time, shells and non-code
// files in the Top-5.
func evalSummary(t *testing.T, rows []evalRow) {
	type key struct{ mode, cat string }
	groups := map[key][]evalRow{}
	var keys []key
	for _, r := range rows {
		for _, k := range []key{{r.Mode, r.Cat}, {r.Mode, "all"}} {
			if groups[k] == nil {
				keys = append(keys, k)
			}
			groups[k] = append(groups[k], r)
		}
	}
	t.Logf("SUMMARY\tmode\tcat\tn\ttop5\ttop10\tmrr10\tbytesMed\tbytesMax\thitMax\tmsMed\tmsP90\tpartMax\tshells\tnonCoreTop5")
	for _, k := range keys {
		g := groups[k]
		var top5, top10, shells, non int
		var mrr float64
		var bytes, ms []int
		hit, part := 0, 0
		for _, r := range g {
			if r.Rank > 0 && r.Rank <= 5 {
				top5++
			}
			if r.Rank > 0 && r.Rank <= 10 {
				top10++
				mrr += 1 / float64(r.Rank)
			}
			shells += r.Shells
			if r.Cat != "d" {
				non += r.NonCore5
			}
			bytes = append(bytes, r.Bytes)
			ms = append(ms, r.MS)
			hit = max(hit, r.MaxHit)
			part = max(part, r.MaxPart)
		}
		sort.Ints(bytes)
		sort.Ints(ms)
		t.Logf("SUMMARY\t%s\t%s\t%d\t%d\t%d\t%.3f\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d", k.mode, k.cat, len(g), top5, top10, mrr/float64(len(g)),
			bytes[len(bytes)/2], bytes[len(bytes)-1], hit, ms[len(ms)/2], ms[min(len(ms)-1, len(ms)*9/10)], part, shells, non)
	}
}
