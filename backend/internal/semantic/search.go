package semantic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// maxResultBytes bounds what one search hands the model, as the JSON it gets, like read_file.
	maxResultBytes = 50 << 10
	// maxQueryBytes bounds the search sentence.
	maxQueryBytes = 4096
	rrfK          = 60
	// vectorFloor is how close to the best vector match another must be to count, for memory notes.
	vectorFloor = 0.75
	// codeVectorFloor is the same for the files of a folder.
	codeVectorFloor = 0.75
	// notCodeWeight is what notCode files' fused scores are multiplied by when there are vector results.
	notCodeWeight = 0.8
	// segmentContext is how much of a long line is given on either side of the part of it that was found.
	segmentContext = 400
	// maxMergedLines keeps neighbouring results merged into one from growing without end.
	maxMergedLines = 200
)

// Query is one semantic_search call.
type Query struct {
	Cwd     string
	Text    string
	Limit   int
	Task    string
	Replica string
}

// Result is what the tool hands the model, as JSON.
type Result struct {
	Mode         string `json:"mode"`
	Reason       string `json:"reason"`
	PendingFiles int    `json:"pendingFiles"`
	Results      []Hit  `json:"results"`
}

type Hit struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Text      string `json:"text"`
	// Note says which bytes of a line text is, when it is not the whole line.
	Note string `json:"note,omitempty"`
	// from and lineLen place text in its line when it is part of one, as Note says; lineLen is 0 for whole lines.
	from, lineLen int
}

// partOf says text is part of line n, of size bytes, from its byte from on.
func (h *Hit) partOf(n, size, from int, text string) {
	h.Text, h.from, h.lineLen = text, from, size
	h.Note = fmt.Sprintf("line %d is %d bytes; text is its bytes %d to %d (from 0, end excluded); read_file shows the whole line", n, size, from, from+len(text))
}

// UserError is a problem with the call itself; the tool reports it as an error.
type UserError struct{ msg string }

func (e *UserError) Error() string { return e.msg }

// candidate is a range of a file found by keyword or vector, with the hash its lines had when found; col and size
// are the piece's, for part of a long line.
type candidate struct {
	path       string
	start, end int
	col, size  int
	lines      string
	score      float64
	vector     bool
	cos        float32
}

func (c candidate) rangeKey() string { return fmt.Sprintf("%s:%d:%d", c.path, c.start, c.end) }

// bestPerRange keeps, of a list best first, the first candidate of each range: the parts of one long line count
// once.
func bestPerRange(list []candidate) []candidate {
	seen := map[string]bool{}
	return slices.DeleteFunc(list, func(c candidate) bool {
		k := c.rangeKey()
		if seen[k] {
			return true
		}
		seen[k] = true
		return false
	})
}

// Search finds what in cwd is about the query: keywords in the files as they are now, and, once the model and the
// folder's vectors are ready, the closest vectors. A result is read again from the file and given only if its
// lines are still what was found. When vectors cannot be used the search is keyword only, saying why.
func (s *Service) Search(ctx context.Context, q Query) (Result, error) {
	q.Text = strings.TrimSpace(q.Text)
	switch {
	case q.Text == "":
		return Result{}, &UserError{"query is required"}
	case len(q.Text) > maxQueryBytes:
		return Result{}, &UserError{fmt.Sprintf("query is longer than %d bytes; shorten it", maxQueryBytes)}
	}
	if q.Limit == 0 {
		q.Limit = 10
	}
	if q.Limit < 1 || q.Limit > 20 {
		return Result{}, &UserError{"limit must be from 1 to 20"}
	}
	if !s.Active() {
		return Result{}, &UserError{"semantic search is turned off; use grep and read_file"}
	}
	if q.Cwd == "" {
		return Result{}, &UserError{"there is no working directory to search; use grep"}
	}
	start := time.Now()
	s.mu.Lock()
	r := s.rootLocked(q.Cwd)
	ready, state, failure := s.ready, s.state, s.err
	s.mu.Unlock()
	if r == nil {
		return Result{}, &UserError{"semantic search is turned off; use grep and read_file"}
	}
	s.log.debug("semantic_search_query").Str("task", q.Task).Str("replica", q.Replica).Str("query", q.Text).Send()
	if _, err := r.scan(ctx, s.log, "scan"); err != nil {
		s.log.warn("semantic_error").Str("stage", "search").Str("root", r.dir).Str("reason", safeReason(err)).Str("next", "report").Send()
		if errors.Is(err, errNotGit) {
			// not kept: nothing to index there, and nothing to look at again
			s.mu.Lock()
			if s.roots[r.dir] == r {
				delete(s.roots, r.dir)
			}
			s.mu.Unlock()
			r.cancel()
			return Result{}, &UserError{"the working directory is not a Git work tree, so it cannot be indexed; use grep"}
		}
		return Result{}, &UserError{"the working directory cannot be listed; use grep"}
	}
	s.poke()
	scanned := time.Since(start)

	res := Result{Mode: "keyword", Results: []Hit{}}
	var vector []candidate
	var queueT, embedT, compareT time.Duration
	_, pending, _ := r.counts()
	switch {
	case !ready && state == StateError && failure != nil:
		res.Reason = "semantic search failed (" + failure.Message + "), so this is keyword search only; details are in backend.log"
	case !ready:
		res.Reason = "the semantic index is being built (" + state + "), so this is keyword search only; grep works meanwhile"
	case pending > 0:
		// keywords alone; the reason is given once the files are counted again below
	default:
		var tokens int
		vector, queueT, embedT, compareT, tokens = s.vectorSearch(ctx, r, q, &res)
		if tokens > 0 {
			s.log.info("semantic_search").Str("task", q.Task).Str("replica", q.Replica).Str("cwd", r.dir).Str("result", "query_too_long").
				Int("tokens", tokens).Int64("ms", time.Since(start).Milliseconds()).Send()
			return Result{}, &UserError{fmt.Sprintf("the query is %d tokens, over the model's %d; shorten it", tokens, MaxTokens)}
		}
	}
	// a reason given above (not ready, failed, cancelled) stays; the ones below are only about files waiting
	given := res.Reason != ""
	waiting := func(pending int) {
		if given {
			return
		}
		if pending > 0 {
			res.Reason = fmt.Sprintf("the semantic index is being built (%d files not indexed yet), so this is keyword search only; grep works meanwhile", pending)
		} else {
			res.Reason = "a file changed during the search, so this is keyword search only; search again for semantic results, or use grep"
		}
	}
	// counted again after the vectors were compared, as a file changed while the query's vector was on its way waits
	// too: vectors of part of the folder would rank what is indexed above what is not, so keywords alone until it is
	// all in
	_, pending, _ = r.counts()
	if ready && pending > 0 {
		vector = nil
		waiting(pending)
	}
	keyword := s.keyword(r, q.Text)
	merged := fuse(keyword, vector, q.Limit)
	verifyStart := time.Now()
	hits, kept, dropped, changed := s.verify(r, merged)
	again := false
	if changed > 0 {
		// a file changed behind the index's back, found only now: what the vectors said of it is old, and the folder
		// waits for it. Once, keywords alone from the files as they are now, read again; a file changing again is
		// counted, not chased
		again = true
		_, pending, _ = r.counts()
		vector = nil
		waiting(pending)
		keyword = s.keyword(r, q.Text)
		merged = fuse(keyword, nil, q.Limit)
		var k, d int
		hits, k, d, changed = s.verify(r, merged)
		kept, dropped = kept+k, dropped+d
		if changed > 0 {
			_, pending, _ = r.counts()
			waiting(pending)
		}
	}
	if vector != nil {
		res.Mode = "hybrid"
	}
	if res.Mode == "keyword" && res.Reason == "" {
		res.Reason = "keyword search only"
	}
	res.PendingFiles = pending
	res.Results = hits
	fit(&res)
	verifyT := time.Since(verifyStart)

	s.log.info("semantic_search").Str("task", q.Task).Str("replica", q.Replica).Str("cwd", r.dir).Str("mode", res.Mode).
		Int("keyword", len(keyword)).Int("vector", len(vector)).Int("merged", len(merged)).Int("verified", kept).Int("dropped", dropped).
		Bool("verifiedAgain", again).Int("results", len(res.Results)).Int("pendingFiles", pending).Int64("scanMs", scanned.Milliseconds()).Int64("queueMs", queueT.Milliseconds()).
		Int64("embedMs", embedT.Milliseconds()).Int64("compareMs", compareT.Milliseconds()).Int64("verifyMs", verifyT.Milliseconds()).
		Int64("ms", time.Since(start).Milliseconds()).Send()
	if s.log.z.Debug().Enabled() {
		for i, c := range merged {
			if i >= 5 {
				break
			}
			s.log.debug("semantic_search_rank").Int("rank", i+1).Str("path", c.path).Int("start", c.start).Int("end", c.end).Float64("score", c.score).Float32("cosine", c.cos).Send()
		}
	}
	return res, nil
}

// vectorSearch compares the query with every ready chunk of the root. On failure it says why in res and returns nil;
// a query over the model's limit gives its token count instead, and nothing else.
func (s *Service) vectorSearch(ctx context.Context, r *root, q Query, res *Result) ([]candidate, time.Duration, time.Duration, time.Duration, int) {
	start := time.Now()
	out, queue, err := helperEmbedder{s}.embed(ctx, []string{queryPrefix + q.Text}, true)
	embedT := time.Since(start) - queue
	if err == nil && out[0].tooLong {
		return nil, queue, embedT, 0, out[0].tokens
	}
	if err != nil {
		if ctx.Err() != nil {
			res.Reason = "the search was cancelled before its vector was ready; keyword search only"
			return nil, queue, embedT, 0, 0
		}
		s.log.error("semantic_error").Str("stage", "search").Str("root", r.dir).Str("reason", safeReason(err)).Str("next", "keyword_fallback").Send()
		s.logMemory(nil)
		res.Reason = "semantic search failed, so this is keyword search only; details are in backend.log"
		return nil, queue, embedT, 0, 0
	}
	cmp := time.Now()
	qv := out[0].vec
	var found []candidate
	r.mu.Lock()
	for rel, f := range r.files {
		if f.pending {
			continue
		}
		for _, c := range f.chunks {
			found = append(found, candidate{path: rel, start: c.start, end: c.end, col: c.col, size: c.size, lines: c.lines, vector: true, cos: dot(qv, c.vec)})
		}
	}
	r.mu.Unlock()
	found = rankVectors(found, q.Limit*3)
	if found == nil {
		found = []candidate{}
	}
	return found, queue, embedT, time.Since(cmp), 0
}

// rankVectors sorts vector matches best first, ties in file order so a search ranks the same way each time, keeps
// each range's best part, at most limit of them, and only those near the best.
func rankVectors(found []candidate, limit int) []candidate {
	// ties in file order, so the same search ranks the same way
	sort.Slice(found, func(i, j int) bool {
		a, b := found[i], found[j]
		switch {
		case a.cos != b.cos:
			return a.cos > b.cos
		case a.path != b.path:
			return a.path < b.path
		case a.start != b.start:
			return a.start < b.start
		}
		return a.col < b.col
	})
	found = bestPerRange(found)
	if len(found) > limit {
		found = found[:limit]
	}
	// ranks alone would give a far weaker match the same weight as a keyword hit: only ones near the best count
	if len(found) > 0 {
		floor := found[0].cos * codeVectorFloor
		found = slices.DeleteFunc(found, func(c candidate) bool { return c.cos <= 0 || c.cos < floor })
	}
	return found
}

// stopWords are English words too common to look for, unless the query has nothing else.
var stopWords = toSet("a an and are as at be by do does for from how in is it its of on or that the this to was what when where which who why with")

// cjkStop are Chinese characters too common to look for: a pair of two of them is left out.
var cjkStop = []rune{
	'的', '了', '是', '在', '和', '與', '及', '或', '把', '被', '讓', '從', '到', '對', '為', '有', '也', '就', '都', '而',
	'之', '其', '這', '那', '個', '嗎', '呢', '吧', '啊', '怎', '麼', '什', '如', '何', '哪', '裡', '時', '會', '要', '能',
	'可', '以', '用', '中', '上', '下', '一', '不', '我', '你', '他', '它', '們', '該', '找', '給', '地', '得', '著',
}

func toSet(words string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(words) {
		out[w] = true
	}
	return out
}

// cjk is a character of Chinese, Japanese or Korean, written without spaces between words.
func cjk(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) || r == 'ー'
}

// terms are the words of a query worth looking for: words of two characters or more but common English ones, and
// for Chinese, Japanese and Korean, each pair of neighbouring characters but pairs of common ones. If nothing is
// left, the common ones are looked for after all.
func terms(q string) []string {
	seen := map[string]bool{}
	var out, common []string
	add := func(w string, stop bool) {
		if seen[w] {
			return
		}
		seen[w] = true
		if stop {
			common = append(common, w)
		} else {
			out = append(out, w)
		}
	}
	for _, field := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' }) {
		runes := []rune(field)
		for i := 0; i < len(runes); {
			j := i + 1
			for j < len(runes) && cjk(runes[j]) == cjk(runes[i]) {
				j++
			}
			seg := runes[i:j]
			if !cjk(seg[0]) {
				if len(seg) >= 2 {
					add(string(seg), stopWords[string(seg)])
				}
			} else {
				for k := 0; k+1 < len(seg); k++ {
					add(string(seg[k:k+2]), slices.Contains(cjkStop, seg[k]) && slices.Contains(cjkStop, seg[k+1]))
				}
			}
			i = j
		}
	}
	if len(out) == 0 {
		return common
	}
	return out
}

// short is a term matched only as a whole word, or as a part of a camelCase name: "to" in "go to" and "toOne", not
// in "toon" or "auto".
func short(t string) bool {
	return len(t) <= 3 && !strings.ContainsFunc(t, func(r rune) bool { return r >= utf8.RuneSelf })
}

func wordByte(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

func lowerOrDigit(b byte) bool { return b >= 'a' && b <= 'z' || b >= '0' && b <= '9' }

func upper(b byte) bool { return b >= 'A' && b <= 'Z' }

// asciiLower lowers ASCII letters alone, so every byte stays where it was.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if upper(c) {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

// wordCount counts the short term t in body as words: each found where a word or a camelCase part starts and ends.
// low is body with ASCII lowered.
func wordCount(body, low, t string) int {
	n := 0
	for i := 0; ; {
		at := strings.Index(low[i:], t)
		if at < 0 {
			return n
		}
		at += i
		end := at + len(t)
		starts := at == 0 || !wordByte(body[at-1]) || lowerOrDigit(body[at-1]) && upper(body[at])
		ends := end == len(body) || !wordByte(body[end]) || lowerOrDigit(body[end-1]) && upper(body[end])
		if starts && ends {
			n++
		}
		i = at + 1
	}
}

// pathWords are the words of a path, camelCase cut apart, with each file name whole: frontend/src/SemanticSearch.tsx
// is frontend, src, semantic, search, tsx and semanticsearch.
func pathWords(rel string) map[string]bool {
	var b strings.Builder
	for i := 0; i < len(rel); i++ {
		if i > 0 && lowerOrDigit(rel[i-1]) && upper(rel[i]) {
			b.WriteByte(' ')
		}
		b.WriteByte(rel[i])
	}
	out := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(b.String()), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		out[w] = true
	}
	name := path.Base(rel)
	out[strings.ToLower(strings.TrimSuffix(name, path.Ext(name)))] = true
	return out
}

const (
	// bm25K1 and bm25B are the usual BM25 settings, as mho's tool search uses.
	bm25K1 = 1.2
	bm25B  = 0.75
)

// keyword scores the pieces of every file in the root as it is now by BM25 over the query's terms, in one read of
// each file: a term found in few pieces counts for more than one found everywhere. A term that is a whole word of the
// path adds to pieces that hold some term, never alone. The parts of a long line count once.
func (s *Service) keyword(r *root, query string) []candidate {
	words := terms(query)
	phrase := strings.ToLower(strings.TrimSpace(query))
	if len(words) == 0 {
		return nil
	}
	r.mu.Lock()
	files := append([]string(nil), r.listing.files...)
	r.mu.Unlock()
	dir, err := os.OpenRoot(r.dir)
	if err != nil {
		return nil
	}
	defer dir.Close()
	type match struct {
		c      candidate
		tf     []int
		size   int
		phrase bool
		path   map[string]bool
	}
	var matches []match
	df := make([]int, len(words))
	pieces, total := 0, 0
	for _, rel := range files {
		data, why := readText(dir, rel)
		if why != "" {
			continue
		}
		text := string(data)
		lower := strings.ToLower(text)
		has := anyIn(lower, words)
		var inPath map[string]bool
		for _, p := range cut(text) {
			if shell(p.body) {
				continue
			}
			pieces++
			total += len(p.body)
			if !has {
				continue
			}
			body, low := strings.ToLower(p.body), asciiLower(p.body)
			var tf []int
			for i, w := range words {
				n := 0
				if short(w) {
					n = wordCount(p.body, low, w)
				} else {
					n = strings.Count(body, w)
				}
				if n > 0 {
					if tf == nil {
						tf = make([]int, len(words))
					}
					tf[i] = n
					df[i]++
				}
			}
			if tf == nil {
				continue
			}
			if inPath == nil {
				inPath = pathWords(rel)
			}
			matches = append(matches, match{
				c:      candidate{path: rel, start: p.start, end: p.end, col: p.col, size: p.size, lines: p.lines},
				tf:     tf,
				size:   len(p.body),
				phrase: len(words) > 1 && strings.Contains(body, phrase),
				path:   inPath,
			})
		}
	}
	if len(matches) == 0 {
		return nil
	}
	idf := make([]float64, len(words))
	for i := range words {
		idf[i] = math.Log(1 + (float64(pieces-df[i])+0.5)/(float64(df[i])+0.5))
	}
	avg := float64(total) / float64(pieces)
	found := make([]candidate, 0, len(matches))
	for _, m := range matches {
		score := 0.0
		for i, n := range m.tf {
			if n > 0 {
				tf := float64(n)
				score += idf[i] * tf * (bm25K1 + 1) / (tf + bm25K1*(1-bm25B+bm25B*float64(m.size)/avg))
			}
		}
		if m.phrase {
			score *= 1.5
		}
		for i, w := range words {
			if m.path[w] {
				score += 0.5 * idf[i]
			}
		}
		m.c.score = score
		found = append(found, m.c)
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].score > found[j].score })
	found = bestPerRange(found)
	if len(found) > 60 {
		found = found[:60]
	}
	return found
}

func anyIn(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// fuse ranks keyword and vector results together by reciprocal rank, keeping the best limit ranges. A range counts
// once in each list, however many parts of a long line it has there; the part kept is the one ranked higher. With
// vector results, files that are not code rank a little lower.
func fuse(keyword, vector []candidate, limit int) []candidate {
	type entry struct {
		c     candidate
		score float64
		rank  int
	}
	byRange := map[string]*entry{}
	var order []string
	add := func(list []candidate) {
		for rank, c := range bestPerRange(slices.Clone(list)) {
			k := c.rangeKey()
			e := byRange[k]
			if e == nil {
				e = &entry{c: c, rank: rank}
				byRange[k] = e
				order = append(order, k)
			} else if rank < e.rank {
				e.c.col, e.c.size, e.rank = c.col, c.size, rank
			}
			e.score += 1 / float64(rrfK+rank+1)
			if c.vector {
				e.c.cos = c.cos
			}
		}
	}
	add(keyword)
	add(vector)
	out := make([]candidate, 0, len(order))
	for _, k := range order {
		e := byRange[k]
		if len(vector) > 0 && notCode(e.c.path) {
			e.score *= notCodeWeight
		}
		e.c.score = e.score
		out = append(out, e.c)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// verify reads each result's file again, through the folder so nothing outside it is read: a range whose lines
// changed since it was found is dropped and its file indexed again. Ranges that touch in one file are merged, and
// rank where the best of them did. Of a line longer than chunkBytes, only the part found is given, with some of the
// line on either side. It returns the hits, how many ranges passed or not, and how many files were found changed.
func (s *Service) verify(r *root, found []candidate) ([]Hit, int, int, int) {
	type ranked struct {
		candidate
		rank int
	}
	type group struct {
		first int // rank of the best range in it
		parts []ranked
	}
	byFile := map[string][]ranked{}
	var files []string
	for i, c := range found {
		if byFile[c.path] == nil {
			files = append(files, c.path)
		}
		byFile[c.path] = append(byFile[c.path], ranked{c, i})
	}
	var groups []group
	kept, dropped, changed := 0, 0, 0
	read := map[string][]string{}
	dir, err := os.OpenRoot(r.dir)
	if err != nil {
		return []Hit{}, 0, len(found), 0
	}
	defer dir.Close()
	for _, rel := range files {
		list := byFile[rel]
		data, why := readText(dir, rel)
		var lines []string
		if why == "" {
			lines = splitLines(string(data))
		}
		read[rel] = lines
		var ok []ranked
		for _, c := range list {
			if why != "" || c.end > len(lines) || textHash(strings.Join(lines[c.start-1:c.end], "")) != c.lines ||
				c.size > 0 && c.col+c.size > len(lines[c.start-1]) {
				dropped++
				continue
			}
			kept++
			ok = append(ok, c)
		}
		if len(ok) < len(list) {
			changed++
			s.Changed(filepath.Join(r.dir, filepath.FromSlash(rel)), "scan")
		}
		sort.Slice(ok, func(i, j int) bool { return ok[i].start < ok[j].start })
		for _, c := range ok {
			if n := len(groups); n > 0 && groups[n-1].parts[0].path == rel && c.size == 0 {
				last := &groups[n-1]
				end := last.parts[len(last.parts)-1].end
				if last.parts[0].size == 0 && c.start <= end+1 && c.end-last.parts[0].start < maxMergedLines {
					last.parts = append(last.parts, c)
					last.first = min(last.first, c.rank)
					continue
				}
			}
			groups = append(groups, group{first: c.rank, parts: []ranked{c}})
		}
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if groups[i].first != groups[j].first {
			return groups[i].first < groups[j].first
		}
		return groups[i].parts[0].start < groups[j].parts[0].start
	})
	hits := []Hit{}
	for _, g := range groups {
		rel := g.parts[0].path
		// the very lines just checked, never anything kept from indexing
		lines := read[rel]
		start, end := g.parts[0].start, g.parts[0].end
		for _, c := range g.parts {
			end = max(end, c.end)
		}
		if end > len(lines) {
			continue
		}
		h := Hit{Path: rel, StartLine: start, EndLine: end, Text: strings.Join(lines[start-1:end], "")}
		if c := g.parts[0]; c.size > 0 && len(lines[start-1]) > chunkBytes {
			line := lines[start-1]
			from, to := max(0, c.col-segmentContext), min(len(line), c.col+c.size+segmentContext)
			for from < len(line) && !utf8.RuneStart(line[from]) {
				from++
			}
			for to < len(line) && !utf8.RuneStart(line[to]) {
				to--
			}
			h.partOf(start, len(line), from, line[from:to])
		}
		hits = append(hits, h)
	}
	return hits, kept, dropped, changed
}

// fitNote is what the reason gains when results were cut short or left out; fit keeps room for it.
const fitNote = "; %d results were cut short and %d left out to stay within 50 KiB, so read_file for the rest"

// minPrefix is the least room worth giving the start of a line that does not fit whole.
const minPrefix = 512

// fit keeps res, as the JSON the tool hands out, within maxResultBytes. A result that does not fit keeps as many of
// its first lines as do; one whose first line alone does not fit keeps the start of it, its note saying which bytes,
// or is left out when there is little room. The reason says so.
func fit(res *Result) {
	if jsonSize(res) <= maxResultBytes {
		return
	}
	hits := res.Results
	res.Results = []Hit{}
	used := jsonSize(res) + len(fmt.Sprintf(fitNote, len(hits), len(hits)))
	short, left := 0, 0
	for _, h := range hits {
		lines := splitLines(h.Text)
		// a hit's JSON is its fields with an empty text, plus each line escaped: escaping goes rune by rune
		sizes := make([]int, len(lines))
		for i, l := range lines {
			sizes[i] = jsonSize(l) - 2
		}
		total := 0
		for _, n := range sizes {
			total += n
		}
		kept := len(lines)
		for ; kept > 0; kept-- {
			empty := Hit{Path: h.Path, StartLine: h.StartLine, EndLine: h.StartLine + kept - 1, Note: h.Note}
			if used+jsonSize(empty)+total+1 <= maxResultBytes {
				break
			}
			total -= sizes[kept-1]
		}
		if kept == 0 {
			if p, ok := prefix(h, lines[0], maxResultBytes-used); ok {
				short++
				used += jsonSize(p) + 1
				res.Results = append(res.Results, p)
				continue
			}
			left++
			continue
		}
		if kept < len(lines) {
			short++
			h.EndLine = h.StartLine + kept - 1
			h.Text = strings.Join(lines[:kept], "")
		}
		used += jsonSize(h) + 1
		res.Results = append(res.Results, h)
	}
	if short+left > 0 {
		res.Reason += fmt.Sprintf(fitNote, short, left)
	}
	for len(res.Results) > 0 && jsonSize(res) > maxResultBytes { // never, unless the sizes above are wrong
		res.Results = res.Results[:len(res.Results)-1]
	}
}

// prefix is h cut to the longest start of its first line that fits in room bytes of JSON, if room is worth it.
func prefix(h Hit, first string, room int) (Hit, bool) {
	if room < minPrefix {
		return Hit{}, false
	}
	line, size, from := h.StartLine, len(first), 0
	if h.lineLen > 0 { // already part of a line
		size, from = h.lineLen, h.from
	}
	take := func(n int) Hit {
		for n > 0 && n < len(first) && !utf8.RuneStart(first[n]) {
			n--
		}
		p := Hit{Path: h.Path, StartLine: line, EndLine: line}
		p.partOf(line, size, from, first[:n])
		return p
	}
	// the longest n whose hit fits
	n := sort.Search(len(first)+1, func(n int) bool { return jsonSize(take(n))+1 > room }) - 1
	if n <= 0 {
		return Hit{}, false
	}
	p := take(n)
	if p.Text == "" {
		return Hit{}, false
	}
	return p, true
}

func jsonSize(v any) int {
	raw, _ := json.Marshal(v)
	return len(raw)
}

// notCode is a file of translations, help, tests or docs. With vectors, which bring such text up for any question
// in its language, it ranks a little lower; keyword search alone keeps it as is, as it is where interface text is
// found.
func notCode(rel string) bool {
	switch {
	case strings.HasPrefix(rel, "backend/internal/i18n/"), strings.HasPrefix(rel, "frontend/src/core/locales/"),
		rel == "frontend/src/core/i18n.ts", strings.HasPrefix(rel, "frontend/src/Help"),
		strings.HasSuffix(rel, "_test.go"), strings.HasSuffix(rel, ".test.ts"), strings.HasSuffix(rel, ".test.tsx"),
		strings.HasSuffix(rel, ".md"):
		return true
	}
	return false
}
