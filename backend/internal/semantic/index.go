package semantic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// stamp tells quickly whether a file may have changed. The change time cannot be set back by writers, so a file
// rewritten to the same size and modification time still shows; a stamp within racy of the last look is read again.
type stamp struct {
	size              int64
	mtime, ctime, ino int64
}

const racy = 2 * time.Second

// chunk is an indexed piece with its vector.
type chunk struct {
	start, end int
	key        string
	lines      string
	vec        []float32
}

type fileState struct {
	stamp  stamp
	hash   string
	chunks []chunk
	// pending: the file's vectors are not ready; its old ones are not used.
	pending bool
	// skipped is why the model could not take it, after which it stops being pending; only keyword search finds it.
	skipped string
	// working: an indexing run has it; done or failed, it is set back.
	working bool
}

// root is one folder searched: a company's folder or a task's work tree, with its own paths, lines and
// fingerprints. Vectors live in the shared cache.
type root struct {
	dir    string
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	files   map[string]*fileState
	scanned time.Time
	failed  error // the folder cannot be listed
	listing listing
	splits  int
	// indexed: a full indexing run has finished at least once.
	indexed bool
}

func newRoot(dir string) *root {
	ctx, cancel := context.WithCancel(context.Background())
	return &root{dir: dir, ctx: ctx, cancel: cancel, files: map[string]*fileState{}}
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// scan brings the file list up to date with the folder as it is now; a file whose content changed loses its
// vectors at once and waits to be indexed again. It returns how many files changed.
func (r *root) scan(ctx context.Context, log *logger, source string) (int, error) {
	l, err := list(ctx, r.dir)
	var dir *os.Root
	if err == nil {
		dir, err = os.OpenRoot(r.dir)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.failed = err
		return 0, err
	}
	defer dir.Close()
	r.failed = nil
	r.listing = l
	last := r.scanned
	r.scanned = time.Now()
	present := map[string]bool{}
	changed := 0
	for _, rel := range l.files {
		present[rel] = true
		st, ok := statOf(filepath.Join(r.dir, filepath.FromSlash(rel)))
		f := r.files[rel]
		if f != nil && ok && st == f.stamp && time.Unix(0, st.ctime).Before(last.Add(-racy)) && time.Unix(0, st.mtime).Before(last.Add(-racy)) {
			continue
		}
		data, why := readText(dir, rel)
		hash := ""
		if why == "" {
			hash = hashBytes(data)
		}
		if f != nil && hash == f.hash && f.skipped == "" {
			f.stamp = st
			continue
		}
		if f == nil {
			f = &fileState{}
			r.files[rel] = f
		}
		f.stamp, f.hash, f.chunks, f.skipped = st, hash, nil, why
		f.pending = why == ""
		changed++
	}
	for rel := range r.files {
		if !present[rel] {
			delete(r.files, rel)
			changed++
		}
	}
	if changed > 0 && r.indexed {
		log.info("semantic_file_change").Str("root", r.dir).Str("source", source).Int("files", changed).Int("pending", r.pendingLocked()).Send()
	}
	return changed, nil
}

// touch marks a file just written by write_file or edit_file: its vectors stop being used at once.
func (r *root) touch(rel string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.files[rel]
	if f == nil {
		f = &fileState{}
		r.files[rel] = f
	}
	f.stamp, f.hash, f.chunks, f.skipped, f.pending = stamp{}, "", nil, "", true
	return true
}

func (r *root) pendingLocked() int {
	n := 0
	for _, f := range r.files {
		if f.pending {
			n++
		}
	}
	return n
}

// counts says how many files are indexed and waiting, and how many chunks can be searched.
func (r *root) counts() (done, pending, chunks int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range r.files {
		if f.pending {
			pending++
			continue
		}
		done++
		chunks += len(f.chunks)
	}
	return
}

// next picks a file waiting to be indexed, in path order, but none in skip.
func (r *root) next(skip map[string]bool) (string, string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var names []string
	for rel, f := range r.files {
		if f.pending && !f.working && !skip[rel] {
			names = append(names, rel)
		}
	}
	if len(names) == 0 {
		return "", "", false
	}
	sort.Strings(names)
	f := r.files[names[0]]
	f.working = true
	return names[0], f.hash, true
}

// embedder turns texts into vectors; tooLong says a text is over MaxTokens, with no vector.
type embedder interface {
	embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error)
}

type embedded struct {
	tokens  int
	tooLong bool
	vec     []float32
}

// indexStats are what one indexing run did, for the log.
type indexStats struct {
	files, chunks, hits, computed, splits, skipped int
}

// indexFile embeds one file as it is now and swaps its chunks in, unless it changed meanwhile or the folder was
// removed. hash is what the file held when it was picked; if it holds something else now, that is what is indexed.
// It always gives the file back: done, waiting again, or skipped.
func (r *root) indexFile(ctx context.Context, rel, hash string, emb embedder, cache *vectors, log *logger, st *indexStats) error {
	release := func() {
		r.mu.Lock()
		if f := r.files[rel]; f != nil {
			f.working = false
		}
		r.mu.Unlock()
	}
	if err := ctx.Err(); err != nil {
		release()
		return err
	}
	dir, err := os.OpenRoot(r.dir)
	if err != nil {
		release()
		return errRemoved
	}
	defer dir.Close()
	data, why := readText(dir, rel)
	if why != "" {
		// not text the model can take now; the next scan looks again
		r.mu.Lock()
		if f := r.files[rel]; f != nil {
			f.working, f.pending, f.skipped, f.hash, f.chunks = false, false, why, "", nil
		}
		r.mu.Unlock()
		return nil
	}
	if now := hashBytes(data); now != hash {
		// changed since it was picked: index what it is now, its old vectors already out of use
		r.mu.Lock()
		f := r.files[rel]
		if f == nil || r.ctx.Err() != nil {
			r.mu.Unlock()
			return errRemoved
		}
		f.hash, f.stamp, f.chunks, f.skipped, f.pending = now, stamp{}, nil, "", true
		r.mu.Unlock()
		hash = now
	}
	text := string(data)
	lines := splitLines(text)
	lineText := func(a, b int) string {
		s := ""
		for _, l := range lines[a-1 : b] {
			s += l
		}
		return s
	}
	work := cut(text)
	var done []chunk
	for len(work) > 0 {
		if err := ctx.Err(); err != nil {
			release()
			return err
		}
		var batch []piece
		var inputs []string
		var rest []piece
		for _, p := range work {
			k := key(docPrefix + p.body)
			if vec := cache.get(k); vec != nil {
				st.hits++
				done = append(done, chunk{start: p.start, end: p.end, key: k, lines: p.lines, vec: vec})
				continue
			}
			if len(batch) < 16 {
				batch = append(batch, p)
				inputs = append(inputs, docPrefix+p.body)
			} else {
				rest = append(rest, p)
			}
		}
		work = rest
		if len(batch) == 0 {
			continue
		}
		out, _, err := emb.embed(ctx, inputs, false)
		if err != nil {
			release()
			return err
		}
		for i, e := range out {
			p := batch[i]
			if e.tooLong {
				parts, ok := p.split(lineText)
				if !ok {
					log.warn("semantic_error").Str("stage", "index").Str("root", r.dir).Str("file", rel).Int("line", p.start).Str("reason", "a piece cannot be cut below the token limit").Str("next", "skip").Send()
					continue
				}
				st.splits++
				log.debug("semantic_split").Str("root", r.dir).Str("file", rel).Int("start", p.start).Int("end", p.end).Int("tokens", e.tokens).Send()
				work = append(work, parts...)
				continue
			}
			k := key(inputs[i])
			if err := cache.put(k, e.vec); err != nil {
				log.error("semantic_error").Str("stage", "index").Str("root", r.dir).Str("file", rel).Str("reason", "could not keep a vector: "+err.Error()).Str("next", "skip").Send()
			}
			st.computed++
			done = append(done, chunk{start: p.start, end: p.end, key: k, lines: p.lines, vec: e.vec})
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].start < done[j].start })
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.files[rel]
	if r.ctx.Err() != nil || f == nil {
		return errRemoved
	}
	f.working = false
	if f.hash != hash { // written again meanwhile: these vectors are for the old content
		return nil
	}
	if now, why := readText(dir, rel); why != "" || hashBytes(now) != hash {
		f.pending, f.chunks = true, nil
		f.stamp = stamp{}
		f.hash = ""
		return nil
	}
	f.chunks, f.pending = done, false
	st.files++
	st.chunks += len(done)
	return nil
}

var errRemoved = errors.New("the folder was removed")

// maxTries is how often one run picks the same file: one that keeps changing while it is indexed waits for the
// next run instead of holding this one up.
const maxTries = 3

// indexPending indexes the root's waiting files one by one, saying which file failed and why.
func (r *root) indexPending(ctx context.Context, emb embedder, cache *vectors, log *logger, st *indexStats) (string, error) {
	tries := map[string]int{}
	skip := map[string]bool{}
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		rel, hash, ok := r.next(skip)
		if !ok {
			return "", nil
		}
		if tries[rel]++; tries[rel] >= maxTries {
			skip[rel] = true
		}
		if err := r.indexFile(ctx, rel, hash, emb, cache, log, st); err != nil {
			return rel, err
		}
	}
}
