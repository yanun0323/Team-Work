package semantic

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// keywordRoot is a Git folder of files, listed, for keyword search alone.
func keywordRoot(t *testing.T, files map[string]string) (*Service, *root) {
	t.Helper()
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	for rel, body := range files {
		write(t, repo, rel, body)
	}
	s := New(Options{Log: zerolog.Nop()})
	r := newRoot(canonical(repo))
	t.Cleanup(r.cancel)
	if _, err := r.scan(context.Background(), s.log, "scan"); err != nil {
		t.Fatal(err)
	}
	return s, r
}

func candidatePaths(list []candidate) []string {
	var out []string
	for _, c := range list {
		out = append(out, c.path)
	}
	return out
}

func TestTermsSplitting(t *testing.T) {
	got := terms("怎麼設定語意搜尋的門檻")
	for _, want := range []string{"設定", "語意", "搜尋", "門檻"} {
		if !slices.Contains(got, want) {
			t.Errorf("%v has no %s", got, want)
		}
	}
	if slices.Contains(got, "怎麼") {
		t.Errorf("%v keeps a pair of common characters", got)
	}
	for q, want := range map[string][]string{
		"API金鑰":                         {"api", "金鑰"},
		"where is the fuse in search":   {"fuse", "search"},
		"in on":                         {"in", "on"},
		"的了":                            {"的了"},
		"readText halvesUntil readText": {"readtext", "halvesuntil"},
		"x 中":                           nil,
	} {
		if got := terms(q); !slices.Equal(got, want) {
			t.Errorf("%q: %v, want %v", q, got, want)
		}
	}
}

// A term in few pieces counts for more than one in every piece.
func TestKeywordRareTermWins(t *testing.T) {
	files := map[string]string{"rare.md": "這一段說明門檻怎麼算。\n"}
	for i := range 30 {
		files[fmt.Sprintf("doc%02d.md", i)] = "設定在這裡，設定也在那裡，再一次設定。\n"
	}
	files["rare.md"] = "設定以後，門檻怎麼算在這一段。\n"
	s, r := keywordRoot(t, files)
	got := s.keyword(r, "設定門檻")
	if len(got) == 0 || got[0].path != "rare.md" {
		t.Fatalf("%v", candidatePaths(got))
	}
}

// Short words of the query count for nothing found only in a path, and a word of the path counts only whole.
func TestKeywordPathSubstringNoCredit(t *testing.T) {
	same := "package x\n\n// the index of every page\n"
	s, r := keywordRoot(t, map[string]string{
		"internal/semantic/plain.go": "package semantic\n\n// Plain holds nothing worth finding.\n",
		"semantic/index.go":          same,
		"other/b.go":                 same,
	})
	got := candidatePaths(s.keyword(r, "fuse in an index"))
	if slices.Contains(got, "internal/semantic/plain.go") {
		t.Fatalf("found by its path alone: %v", got)
	}
	if !slices.Equal(got, []string{"semantic/index.go", "other/b.go"}) {
		t.Fatalf("%v", got)
	}
}

func TestKeywordShortTermAtWordBoundary(t *testing.T) {
	for body, want := range map[string]int{
		"go to x": 1, "toOne": 1, "intoTo": 1, "TO be": 1, "to;to": 2,
		"toon": 0, "auto": 0, "TOKEN": 0, "x_to": 0, "to2": 0,
	} {
		if got := wordCount(body, asciiLower(body), "to"); got != want {
			t.Errorf("%q: %d, want %d", body, got, want)
		}
	}
	s, r := keywordRoot(t, map[string]string{"a.go": "// photon cartoon\n", "b.go": "// go to the store\n"})
	if got := candidatePaths(s.keyword(r, "to")); !slices.Equal(got, []string{"b.go"}) {
		t.Fatalf("%v", got)
	}
}

// longLine is one line of n bytes or so, made of filler words, with word at about byte at.
func longLine(n, at int, word string) string {
	var b strings.Builder
	for i := 0; b.Len() < n; i++ {
		if at >= 0 && b.Len() >= at {
			b.WriteString(word + " ")
			at = -1
			continue
		}
		fmt.Fprintf(&b, "w%d ", i%1000)
	}
	return b.String() + "\n"
}

// Every part of a long line holding the query is one range: it counts once in each list.
func TestLongLineCountsOncePerSource(t *testing.T) {
	var b strings.Builder
	for b.Len() < 26000 {
		b.WriteString("giraffe grazing ")
	}
	line := b.String() + "\n"
	s, r := keywordRoot(t, map[string]string{"long.md": "title\n" + line, "other.md": "a giraffe\n"})
	parts := 0
	for _, p := range cut("title\n" + line) {
		if p.start == 2 {
			parts++
		}
	}
	kw := s.keyword(r, "giraffe")
	n := 0
	for _, c := range kw {
		if c.path == "long.md" {
			n++
		}
	}
	if parts < 6 || n != 1 {
		t.Fatalf("%d parts, %d in the list", parts, n)
	}
	var vec []candidate
	for i := range 3 {
		vec = append(vec, candidate{path: "long.md", start: 2, end: 2, col: i * 4000, size: 4000, vector: true, cos: 0.9})
	}
	fused := fuse(kw, vec, 10)
	if fused[0].path != "long.md" || fused[0].score > 2/float64(rrfK+1)+1e-12 {
		t.Fatalf("%+v", fused[0])
	}
	if len(fused) != 2 {
		t.Fatalf("%v", candidatePaths(fused))
	}
}

// A long line found gives the part found, with some on either side, and leaves room for the rest.
func TestLongLineHitIsASegment(t *testing.T) {
	s := newService(t, "load_fail", zerolog.InfoLevel, nil)
	s.Start(true, nil)
	s.waitState(t, StateError)
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	line := longLine(26000, 20000, "quokka")
	write(t, repo, "long.md", "# title\n"+line+"end\n")
	for i := range 10 {
		write(t, repo, fmt.Sprintf("f%d.go", i), fmt.Sprintf("package f\n\n// quokka number %d\nfunc F%d() {}\n", i, i))
	}
	res, err := s.Search(context.Background(), Query{Cwd: repo, Text: "quokka", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(res); len(raw) > maxResultBytes {
		t.Fatalf("%d bytes", len(raw))
	}
	var long *Hit
	others := 0
	for i, h := range res.Results {
		if h.Path == "long.md" {
			long = &res.Results[i]
		} else if strings.Contains(h.Text, "quokka") {
			others++
		}
	}
	if long == nil || others != 10 {
		t.Fatalf("%v", paths(res))
	}
	at := strings.Index(line, long.Text)
	want := fmt.Sprintf("line 2 is %d bytes; text is its bytes %d to %d (from 0, end excluded); read_file shows the whole line", len(line), at, at+len(long.Text))
	if long.StartLine != 2 || long.EndLine != 2 || at < 0 || !strings.Contains(long.Text, "quokka") || len(long.Text) > chunkBytes+2*segmentContext ||
		long.Note != want || long.from != at {
		t.Fatalf("%d-%d, %d bytes at %d: %q", long.StartLine, long.EndLine, len(long.Text), at, long.Note)
	}
	// whole lines say nothing of bytes
	for _, h := range res.Results {
		if h.Path != "long.md" && h.Note != "" {
			t.Fatalf("%+v", h)
		}
	}
}

// limitEmbedder is the made-up model with its token limit.
type limitEmbedder struct{}

func (limitEmbedder) embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error) {
	out := make([]embedded, len(texts))
	for i, s := range texts {
		if n := fakeTokens(s); n > MaxTokens {
			out[i] = embedded{tokens: n, tooLong: true}
		} else {
			out[i] = embedded{tokens: n, vec: fakeVector(s)}
		}
	}
	return out, 0, nil
}

// Pieces with no letter or digit, from the first cut or from cutting again for the model, are never indexed; every
// letter of the file is still in some chunk.
func TestShellPiecesNeverIndexed(t *testing.T) {
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	first := strings.Repeat("a", 2100) + "\n"
	files := map[string]string{"x.go": first + "}\n", "only.go": "}\n\n  )\n", "pair.go": "func f() {\n\treturn\n}\n"}
	for rel, body := range files {
		write(t, repo, rel, body)
	}
	r := newRoot(canonical(repo))
	defer r.cancel()
	log := &logger{z: zerolog.Nop()}
	if _, err := r.scan(context.Background(), log, "scan"); err != nil {
		t.Fatal(err)
	}
	rec := &recorder{embedder: limitEmbedder{}}
	st := &indexStats{}
	if _, err := r.indexPending(context.Background(), rec, &vectors{dir: t.TempDir(), touched: map[string]bool{}}, log, st); err != nil {
		t.Fatal(err)
	}
	if st.splits == 0 {
		t.Fatal("nothing was cut again")
	}
	for _, g := range rec.got {
		if _, body, _ := strings.Cut(g.text, " | text: "); shell(body) {
			t.Fatalf("a shell went to the model: %q", g.text)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for rel, body := range files {
		f := r.files[rel]
		if f.pending {
			t.Fatalf("%s is still waiting", rel)
		}
		lines := splitLines(body)
		for _, c := range f.chunks {
			text := strings.Join(lines[c.start-1:c.end], "")
			if c.size > 0 {
				text = lines[c.start-1][c.col : c.col+c.size]
			}
			if shell(text) {
				t.Fatalf("%s:%d-%d is a shell", rel, c.start, c.end)
			}
		}
	}
	if n := len(r.files["only.go"].chunks); n != 0 {
		t.Fatalf("only.go has %d chunks", n)
	}
	x := r.files["x.go"].chunks
	covered := 0
	for _, c := range x {
		if c.start != 1 || c.end != 1 || c.col != covered {
			t.Fatalf("%+v", x)
		}
		covered += c.size
	}
	if covered != len(first) {
		t.Fatalf("%d of %d bytes", covered, len(first))
	}
}

func TestPiecesKnowWhereTheyAre(t *testing.T) {
	line := longLine(13000, -1, "") // three parts and a bit
	text := "a\n" + strings.Repeat("長", 2000) + "\n" + line
	lines := splitLines(text)
	lineText := func(a, b int) string { return strings.Join(lines[a-1:b], "") }
	var check func(p piece, depth int)
	check = func(p piece, depth int) {
		switch {
		case p.size > 0 && lines[p.start-1][p.col:p.col+p.size] != p.body:
			t.Fatalf("line %d at %d is not its body", p.start, p.col)
		case p.size == 0 && (p.col != 0 || lineText(p.start, p.end) != p.body):
			t.Fatalf("lines %d-%d are not its body", p.start, p.end)
		}
		if depth < 3 {
			if parts, ok := p.split(lineText); ok {
				for _, q := range parts {
					check(q, depth+1)
				}
			}
		}
	}
	segments := 0
	for _, p := range cut(text) {
		if p.size > 0 {
			segments++
		}
		check(p, 0)
	}
	if segments < 4 {
		t.Fatalf("%d parts of the long line", segments)
	}
	for s, want := range map[string]bool{"}\n": true, "": true, " ),;\n\t": true, "x": false, "}\n1": false, "中}": false} {
		if shell(s) != want {
			t.Errorf("%q: %v", s, !want)
		}
	}
}

// A result whose first line does not fit keeps as much of its start as does, saying which bytes; with little room
// left it is left out.
func TestFitKeepsAPrefixOfALongFirstLine(t *testing.T) {
	line := strings.Repeat("長x", 20000) + "\n"
	res := Result{Mode: "keyword", Reason: "keyword search only", Results: []Hit{
		{Path: "a.go", StartLine: 1, EndLine: 1, Text: "short\n"},
		{Path: "big.txt", StartLine: 3, EndLine: 3, Text: line},
	}}
	fit(&res)
	if len(res.Results) != 2 || jsonSize(res) > maxResultBytes || !strings.Contains(res.Reason, "1 results were cut short and 0 left out") {
		t.Fatalf("%d results, %d bytes, %q", len(res.Results), jsonSize(res), res.Reason)
	}
	h := res.Results[1]
	want := fmt.Sprintf("line 3 is %d bytes; text is its bytes 0 to %d (from 0, end excluded); read_file shows the whole line", len(line), len(h.Text))
	if !strings.HasPrefix(line, h.Text) || len(h.Text) < 20000 || h.Note != want || h.EndLine != 3 {
		t.Fatalf("%d bytes: %q", len(h.Text), h.Note)
	}

	// part of a line already: cut again from where it starts, after a result that leaves a little room
	filler := Hit{Path: "f.txt", StartLine: 1, EndLine: 1, Text: strings.Repeat("y", maxResultBytes-3000) + "\n"}
	seg := Hit{Path: "long.md", StartLine: 2, EndLine: 2}
	seg.partOf(2, 30000, 5000, strings.Repeat("z", 4800))
	res = Result{Mode: "keyword", Results: []Hit{filler, seg}}
	fit(&res)
	if len(res.Results) != 2 || jsonSize(res) > maxResultBytes {
		t.Fatalf("%d results, %d bytes", len(res.Results), jsonSize(res))
	}
	h = res.Results[1]
	if want := fmt.Sprintf("line 2 is 30000 bytes; text is its bytes 5000 to %d", 5000+len(h.Text)); len(h.Text) == 0 || len(h.Text) >= 4800 || !strings.HasPrefix(h.Note, want) {
		t.Fatalf("%d bytes: %q", len(h.Text), h.Note)
	}

	// no room worth giving: left out
	filler.Text = strings.Repeat("y", maxResultBytes-600) + "\n"
	res = Result{Mode: "keyword", Results: []Hit{filler, seg}}
	fit(&res)
	if len(res.Results) != 1 || !strings.Contains(res.Reason, "0 results were cut short and 1 left out") {
		t.Fatalf("%d results: %q", len(res.Results), res.Reason)
	}
}

// Ranges of one file merged or not rank where they were found, not where the file's best was.
func TestVerifyKeepsEachRangesRank(t *testing.T) {
	var a strings.Builder
	for i := range 60 {
		fmt.Fprintf(&a, "line %d\n", i+1)
	}
	s, r := keywordRoot(t, map[string]string{"a.go": a.String(), "b.go": "only\n"})
	lines := splitLines(a.String())
	at := func(rel string, n int, text string) candidate {
		return candidate{path: rel, start: n, end: n, lines: textHash(text)}
	}
	hits, kept, dropped, changed := s.verify(r, []candidate{at("a.go", 1, lines[0]), at("b.go", 1, "only\n"), at("a.go", 50, lines[49]), at("a.go", 2, lines[1])})
	if kept != 4 || dropped != 0 || changed != 0 {
		t.Fatal(kept, dropped, changed)
	}
	var got []string
	for _, h := range hits {
		got = append(got, fmt.Sprintf("%s:%d-%d", h.Path, h.StartLine, h.EndLine))
	}
	if !slices.Equal(got, []string{"a.go:1-2", "b.go:1-1", "a.go:50-50"}) {
		t.Fatalf("%v", got)
	}
}

// The same vectors rank the same way whatever order they were read in.
func TestRankVectorsIsStable(t *testing.T) {
	var base []candidate
	for i, p := range []string{"c.go", "a.go", "b.go", "a.go"} {
		base = append(base, candidate{path: p, start: i + 1, end: i + 1, vector: true, cos: 0.5})
	}
	base = append(base, candidate{path: "long.md", start: 9, end: 9, col: 4000, size: 4000, vector: true, cos: 0.6},
		candidate{path: "long.md", start: 9, end: 9, col: 0, size: 4000, vector: true, cos: 0.55})
	var first []string
	for range 20 {
		list := slices.Clone(base)
		rand.Shuffle(len(list), func(i, j int) { list[i], list[j] = list[j], list[i] })
		var got []string
		for _, c := range rankVectors(list, 30) {
			got = append(got, fmt.Sprintf("%s:%d@%d", c.path, c.start, c.col))
		}
		if first == nil {
			first = got
		} else if !slices.Equal(got, first) {
			t.Fatalf("%v then %v", first, got)
		}
	}
	if !slices.Equal(first, []string{"long.md:9@4000", "a.go:2@0", "a.go:4@0", "b.go:3@0", "c.go:1@0"}) {
		t.Fatalf("%v", first)
	}
}

// Two work trees with the same file share its vectors: the model reads its relative path, never the folder, and
// the log never has its text.
func TestCodeVectorsAreSharedAcrossWorkTrees(t *testing.T) {
	// a line over the made-up model's limit, so the file is cut again and the log says so
	body := "package pkg\n\n// " + codeMarker + "\nfunc invoiceLedgerReconcile() int { return 42 }\nvar x = \"" + strings.Repeat("q", 2100) + "\"\n"
	cache := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	out := &sink{}
	log := &logger{z: zerolog.New(out).Level(zerolog.DebugLevel)}
	var keys [][]string
	var sent [][]string
	var dirs []string
	for range 2 {
		repo := t.TempDir()
		git(t, repo, "init", "-q")
		write(t, repo, "pkg/a.go", body)
		r := newRoot(canonical(repo))
		defer r.cancel()
		if _, err := r.scan(context.Background(), log, "scan"); err != nil {
			t.Fatal(err)
		}
		rec := &recorder{embedder: limitEmbedder{}}
		if _, err := r.indexPending(context.Background(), rec, cache, log, &indexStats{}); err != nil {
			t.Fatal(err)
		}
		var k, s []string
		for _, c := range r.files["pkg/a.go"].chunks {
			k = append(k, c.key)
		}
		for _, g := range rec.got {
			if !g.out.tooLong { // ones over the limit have no vector to keep, so are asked about again
				s = append(s, g.text)
			}
		}
		keys, sent, dirs = append(keys, k), append(sent, s), append(dirs, repo)
	}
	if len(keys[0]) < 2 || !slices.Equal(keys[0], keys[1]) {
		t.Fatalf("%v", keys)
	}
	if len(sent[0]) == 0 || len(sent[1]) != 0 {
		t.Fatalf("the second work tree computed %d vectors", len(sent[1]))
	}
	for _, text := range sent[0] {
		_, piece, _ := strings.Cut(text, " | text: ")
		if text != docInput("pkg/a.go", piece) || strings.Contains(text, dirs[0]) || strings.Contains(text, dirs[1]) {
			t.Fatalf("sent %q", text[:min(80, len(text))])
		}
	}
	if l := out.String(); !strings.Contains(l, "pkg/a.go") || strings.Contains(l, codeMarker) || strings.Contains(l, "invoiceLedgerReconcile()") {
		t.Fatalf("the log: %s", l)
	}
}
