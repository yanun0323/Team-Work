package semantic

import (
	lru "container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	// memoryFormat keeps the vectors of memory notes apart from those of code: another input format, another key.
	memoryFormat = "eg2-memory-v1"
	// memoryQueryPrefix and memoryDocPrefix are the official EmbeddingGemma formats for search results, the task for
	// text that is not code.
	memoryQueryPrefix = "task: search result | query: "
	memoryDocPrefix   = "title: none | text: "
	// memoryBudget bounds the vector part of one memory search: the query and the notes not yet cached.
	memoryBudget = 5 * time.Second
	// memoryBatch is how many notes go to the model in one request, so a search waits for one short batch at a time.
	memoryBatch = 16
	// memoryCacheSize is how many note vectors are kept, about 12 MB; the least recently used go first.
	memoryCacheSize = 4096
	// memoryNoteBytes is past what any 2048 tokens can be: a longer note is never sent to the model.
	memoryNoteBytes = 64 << 10
	// memoryVectorLimit is how many notes, closest first, one search ranks by vector.
	memoryVectorLimit = 60
)

// Note is one memory note RankNotes may rank: only the notes the caller may read.
type Note struct {
	ID   string
	Text string
}

// RankNotes ranks notes by how close their meaning is to the query, closest first, keeping only those near the best,
// as semantic_search does. ok is false when vectors cannot be used here and now: off, unsupported, not ready, a
// query too long, a helper error or more than five seconds, so the caller searches by keyword alone. It never fails
// the search, logs neither the query nor the notes, and keeps the vectors of notes in memory only, apart from the
// index of code.
func (s *Service) RankNotes(ctx context.Context, query string, notes []Note) (ranked []string, ok bool) {
	if s == nil {
		return nil, false
	}
	s.mu.Lock()
	active, ready := s.active, s.ready
	s.mu.Unlock()
	if !active {
		return nil, false
	}
	return s.rankNotes(ctx, helperEmbedder{s}, ready, strings.TrimSpace(query), notes)
}

// memoryStats are what one memory search did, for the log.
type memoryStats struct {
	cached, computed, tooLong int
}

func (s *Service) rankNotes(ctx context.Context, emb embedder, ready bool, query string, notes []Note) ([]string, bool) {
	start := time.Now()
	var st memoryStats
	logged := func(mode, reason string) {
		s.log.info("semantic_memory_search").Str("mode", mode).Str("reason", reason).Int("notes", len(notes)).Int("cached", st.cached).
			Int("computed", st.computed).Int("tooLong", st.tooLong).Int64("ms", time.Since(start).Milliseconds()).Send()
	}
	keyword := func(reason string) ([]string, bool) {
		logged("keyword", reason)
		return nil, false
	}
	switch {
	case !ready:
		return keyword("not_ready")
	case query == "":
		return keyword("empty_query")
	case len(query) > maxQueryBytes:
		return keyword("query_too_long")
	case len(notes) == 0:
		logged("hybrid", "")
		return []string{}, true
	}
	ctx, cancel := context.WithTimeout(ctx, s.noteBudget)
	defer cancel()
	failed := func(err error) ([]string, bool) {
		reason := "embed_error"
		if errors.Is(err, context.DeadlineExceeded) {
			reason = "timeout"
		} else if ctx.Err() != nil {
			reason = "cancelled"
		}
		if reason == "embed_error" {
			s.log.warn("semantic_error").Str("stage", "memory_search").Str("reason", safeReason(err)).Str("next", "keyword_fallback").Send()
		}
		return keyword(reason)
	}
	out, _, err := emb.embed(ctx, []string{memoryQueryPrefix + query}, true)
	if err != nil {
		return failed(err)
	}
	if out[0].tooLong {
		return keyword("query_too_many_tokens")
	}
	qv := out[0].vec

	// the vectors this search uses, held here so a cache smaller than the notes cannot drop them midway
	vecs := make(map[string]noteVector, len(notes))
	keys := make([]string, len(notes))
	var missing []string // keys, each once
	texts := map[string]string{}
	for i, n := range notes {
		k := memoryKey(n.Text)
		keys[i] = k
		if _, seen := vecs[k]; seen {
			continue
		}
		if _, waiting := texts[k]; waiting {
			continue
		}
		if v, hit := s.notes.get(k); hit {
			vecs[k] = v
			st.cached++
			continue
		}
		if len(n.Text) > memoryNoteBytes {
			v := noteVector{tooLong: true}
			s.notes.put(k, v)
			vecs[k] = v
			st.computed++
			continue
		}
		texts[k] = n.Text
		missing = append(missing, k)
	}
	for batch := range slices.Chunk(missing, memoryBatch) {
		inputs := make([]string, len(batch))
		for i, k := range batch {
			inputs[i] = memoryDocPrefix + texts[k]
		}
		got, _, err := emb.embed(ctx, inputs, true)
		if err != nil {
			return failed(err)
		}
		// kept at once: a search cut short leaves the next one less to do
		for i, k := range batch {
			v := noteVector{vec: got[i].vec, tooLong: got[i].tooLong}
			s.notes.put(k, v)
			vecs[k] = v
			st.computed++
		}
	}
	type scored struct {
		id  string
		cos float32
	}
	found := make([]scored, 0, len(notes))
	for i, n := range notes {
		v := vecs[keys[i]]
		if v.tooLong {
			st.tooLong++
			continue
		}
		found = append(found, scored{n.ID, dot(qv, v.vec)})
	}
	slices.SortStableFunc(found, func(a, b scored) int {
		switch {
		case a.cos > b.cos:
			return -1
		case a.cos < b.cos:
			return 1
		}
		return 0
	})
	// ranks alone would give a far weaker match the same weight as a keyword hit: only ones near the best count
	if len(found) > 0 {
		floor := found[0].cos * vectorFloor
		found = slices.DeleteFunc(found, func(c scored) bool { return c.cos <= 0 || c.cos < floor })
	}
	ranked := make([]string, 0, min(len(found), memoryVectorLimit))
	for _, c := range found[:min(len(found), memoryVectorLimit)] {
		ranked = append(ranked, c.id)
	}
	logged("hybrid", "")
	return ranked, true
}

// memoryKey is a note's vector key: the model, its tokenizer, the memory format and the whole input.
func memoryKey(text string) string {
	h := sha256.New()
	for _, part := range []string{Revision, TokenizerSHA256, memoryFormat, memoryDocPrefix + text} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// noteVector is a note's vector, or that the note is over the model's limit and has none.
type noteVector struct {
	vec     []float32
	tooLong bool
}

// noteCache keeps note vectors in memory, at most max of them, dropping the least recently used. Keys are the
// notes' content, so a note written again is a new key and one removed is never asked for: nothing needs clearing.
type noteCache struct {
	mu  sync.Mutex
	max int
	ll  *lru.List
	m   map[string]*lru.Element
}

type noteEntry struct {
	key string
	v   noteVector
}

func newNoteCache(max int) *noteCache {
	return &noteCache{max: max, ll: lru.New(), m: map[string]*lru.Element{}}
}

func (c *noteCache) get(key string) (noteVector, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el := c.m[key]
	if el == nil {
		return noteVector{}, false
	}
	c.ll.MoveToFront(el)
	return el.Value.(*noteEntry).v, true
}

func (c *noteCache) put(key string, v noteVector) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el := c.m[key]; el != nil {
		el.Value.(*noteEntry).v = v
		c.ll.MoveToFront(el)
		return
	}
	c.m[key] = c.ll.PushFront(&noteEntry{key, v})
	for c.ll.Len() > c.max {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.m, last.Value.(*noteEntry).key)
	}
}

func (c *noteCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
