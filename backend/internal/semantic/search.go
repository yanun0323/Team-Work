package semantic

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	// maxResultBytes bounds the text one search hands the model, like read_file.
	maxResultBytes = 50 << 10
	// maxQueryBytes bounds the search sentence.
	maxQueryBytes = 4096
	rrfK          = 60
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
}

// UserError is a problem with the call itself; the tool reports it as an error.
type UserError struct{ msg string }

func (e *UserError) Error() string { return e.msg }

// candidate is a range of a file found by keyword or vector, with the hash its lines had when found.
type candidate struct {
	path       string
	start, end int
	lines      string
	score      float64
	vector     bool
	cos        float32
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
			return Result{}, &UserError{"the working directory is not a Git work tree, so it cannot be indexed; use grep"}
		}
		return Result{}, &UserError{"the working directory cannot be listed; use grep"}
	}
	s.poke()
	scanned := time.Since(start)

	keyword := s.keyword(r, q.Text)
	res := Result{Mode: "keyword", Results: []Hit{}}
	var vector []candidate
	var queueT, embedT, compareT time.Duration
	_, pending, _ := r.counts()
	switch {
	case !ready && state == StateError && failure != nil:
		res.Reason = "semantic search failed (" + failure.Message + "), so this is keyword search only; details are in backend.log"
	case !ready:
		res.Reason = "the semantic index is being built (" + state + "), so this is keyword search only; grep works meanwhile"
	default:
		vector, queueT, embedT, compareT = s.vectorSearch(ctx, r, q, &res)
		if vector != nil {
			res.Mode = "hybrid"
			if pending > 0 {
				res.Reason = fmt.Sprintf("%d files are not indexed yet; they were searched by keyword only", pending)
			}
		}
	}
	if res.Mode == "keyword" && res.Reason == "" {
		res.Reason = "keyword search only"
	}
	res.PendingFiles = pending
	merged := fuse(keyword, vector, q.Limit)
	verifyStart := time.Now()
	hits, kept, dropped := s.verify(r, merged)
	res.Results = hits
	verifyT := time.Since(verifyStart)

	s.log.info("semantic_search").Str("task", q.Task).Str("replica", q.Replica).Str("cwd", r.dir).Str("mode", res.Mode).
		Int("keyword", len(keyword)).Int("vector", len(vector)).Int("merged", len(merged)).Int("verified", kept).Int("dropped", dropped).
		Int("results", len(hits)).Int("pendingFiles", pending).Int64("scanMs", scanned.Milliseconds()).Int64("queueMs", queueT.Milliseconds()).
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

// vectorSearch compares the query with every ready chunk of the root. On failure it says why in res and returns nil.
func (s *Service) vectorSearch(ctx context.Context, r *root, q Query, res *Result) ([]candidate, time.Duration, time.Duration, time.Duration) {
	start := time.Now()
	out, queue, err := helperEmbedder{s}.embed(ctx, []string{queryPrefix + q.Text}, true)
	embedT := time.Since(start) - queue
	if err == nil && out[0].tooLong {
		res.Reason = fmt.Sprintf("the query is %d tokens, over the model's %d; it was searched by keyword only, shorten it for semantic search", out[0].tokens, MaxTokens)
		return nil, queue, embedT, 0
	}
	if err != nil {
		if ctx.Err() != nil {
			res.Reason = "the search was cancelled before its vector was ready; keyword search only"
			return nil, queue, embedT, 0
		}
		s.log.error("semantic_error").Str("stage", "search").Str("root", r.dir).Str("reason", safeReason(err)).Str("next", "keyword_fallback").Send()
		res.Reason = "semantic search failed, so this is keyword search only; details are in backend.log"
		return nil, queue, embedT, 0
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
			found = append(found, candidate{path: rel, start: c.start, end: c.end, lines: c.lines, vector: true, cos: dot(qv, c.vec)})
		}
	}
	r.mu.Unlock()
	sort.Slice(found, func(i, j int) bool { return found[i].cos > found[j].cos })
	if len(found) > q.Limit*3 {
		found = found[:q.Limit*3]
	}
	if found == nil {
		found = []candidate{}
	}
	return found, queue, embedT, time.Since(cmp)
}

// terms are the words of a query worth looking for.
func terms(q string) []string {
	seen := map[string]bool{}
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' }) {
		if len([]rune(w)) < 2 || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out
}

// keyword scores the pieces of every file in the root as it is now by how many of the query's words they hold.
func (s *Service) keyword(r *root, query string) []candidate {
	words := terms(query)
	phrase := strings.ToLower(query)
	if len(words) == 0 {
		return nil
	}
	r.mu.Lock()
	files := append([]string(nil), r.listing.files...)
	r.mu.Unlock()
	var found []candidate
	for _, rel := range files {
		data, why := readText(r.dir, rel)
		if why != "" {
			continue
		}
		lower := strings.ToLower(string(data))
		if !strings.Contains(lower, words[0]) && !anyIn(lower, words[1:]) {
			continue
		}
		pathLower := strings.ToLower(rel)
		for _, p := range cut(string(data)) {
			if p.body == "" {
				continue
			}
			body := strings.ToLower(p.body)
			distinct, count := 0, 0
			for _, w := range words {
				if n := strings.Count(body, w); n > 0 {
					distinct++
					count += n
				} else if strings.Contains(pathLower, w) {
					distinct++
				}
			}
			if distinct == 0 {
				continue
			}
			score := float64(distinct)*10 + float64(min(count, 20))
			if len(words) > 1 && strings.Contains(body, phrase) {
				score += 15
			}
			found = append(found, candidate{path: rel, start: p.start, end: p.end, lines: p.lines, score: score})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].score > found[j].score })
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

// fuse ranks keyword and vector results together by reciprocal rank, keeping the best limit ranges.
func fuse(keyword, vector []candidate, limit int) []candidate {
	type entry struct {
		c     candidate
		score float64
		parts []candidate
	}
	byRange := map[string]*entry{}
	var order []string
	add := func(list []candidate) {
		for rank, c := range list {
			k := fmt.Sprintf("%s:%d:%d", c.path, c.start, c.end)
			e := byRange[k]
			if e == nil {
				e = &entry{c: c}
				byRange[k] = e
				order = append(order, k)
			}
			e.score += 1 / float64(rrfK+rank+1)
			if c.vector {
				e.c.cos = c.cos
			}
			e.parts = append(e.parts, c)
		}
	}
	add(keyword)
	add(vector)
	out := make([]candidate, 0, len(order))
	for _, k := range order {
		e := byRange[k]
		e.c.score = e.score
		out = append(out, e.c)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// verify reads each result's file again: a range whose lines changed since it was found is dropped and its file
// indexed again. Ranges that touch in one file are merged. It returns the hits and how many ranges passed or not.
func (s *Service) verify(r *root, found []candidate) ([]Hit, int, int) {
	type group struct {
		first int // rank of the best range in it
		parts []candidate
	}
	byFile := map[string][]candidate{}
	rank := map[string]int{}
	for i, c := range found {
		if _, ok := rank[c.path]; !ok {
			rank[c.path] = i
		}
		byFile[c.path] = append(byFile[c.path], c)
	}
	var groups []group
	kept, dropped := 0, 0
	read := map[string][]string{}
	for rel, list := range byFile {
		data, why := readText(r.dir, rel)
		var lines []string
		if why == "" {
			lines = splitLines(string(data))
		}
		read[rel] = lines
		var ok []candidate
		for _, c := range list {
			if why != "" || c.end > len(lines) || textHash(strings.Join(lines[c.start-1:c.end], "")) != c.lines {
				dropped++
				continue
			}
			kept++
			ok = append(ok, c)
		}
		if len(ok) < len(list) {
			s.Changed(filepath.Join(r.dir, filepath.FromSlash(rel)), "scan")
		}
		sort.Slice(ok, func(i, j int) bool { return ok[i].start < ok[j].start })
		for _, c := range ok {
			if n := len(groups); n > 0 && groups[n-1].parts[0].path == rel {
				last := &groups[n-1]
				end := last.parts[len(last.parts)-1].end
				if c.start <= end+1 && c.end-last.parts[0].start < maxMergedLines {
					last.parts = append(last.parts, c)
					continue
				}
			}
			groups = append(groups, group{first: rank[rel], parts: []candidate{c}})
		}
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if groups[i].first != groups[j].first {
			return groups[i].first < groups[j].first
		}
		return groups[i].parts[0].start < groups[j].parts[0].start
	})
	hits := []Hit{}
	size := 0
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
		text := strings.Join(lines[start-1:end], "")
		if size+len(text) > maxResultBytes {
			break
		}
		size += len(text)
		hits = append(hits, Hit{Path: rel, StartLine: start, EndLine: end, Text: text})
	}
	return hits, kept, dropped
}
