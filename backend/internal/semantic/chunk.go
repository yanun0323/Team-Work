package semantic

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// formatVersion changes whenever what is sent to the model changes, so old vectors are not reused.
	formatVersion = "eg2-code-v1"
	// docPrefix and queryPrefix are the official EmbeddingGemma formats for code retrieval. The document title is
	// always none: paths and line numbers stay out of the model's input.
	docPrefix   = "title: none | text: "
	queryPrefix = "task: code retrieval | query: "
	// MaxTokens is the most the model takes, <bos> and <eos> included.
	MaxTokens = 2048
	// chunkLines and chunkBytes bound a first cut; one too long for the model is cut again.
	chunkLines = 40
	chunkBytes = 4000
	dim        = 768
)

// piece is part of a file: lines start..end, 1-based and inclusive, and the text the model reads, which is those
// lines or, for a line too long on its own, part of it.
type piece struct {
	start, end int
	body       string
	lines      string // hash of the whole lines start..end, to tell whether they are still what was read
}

// key is the vector cache's key for a piece: the model, its tokenizer, the input format and the whole input.
func key(input string) string {
	h := sha256.New()
	for _, part := range []string{Revision, TokenizerSHA256, formatVersion, input} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func textHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:16])
}

// splitLines keeps each line's ending, so lines joined are the file again.
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.SplitAfter(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// cut makes the first pieces of a file: whole lines up to chunkLines or chunkBytes, and a line longer than
// chunkBytes in parts of its own. Every byte is in exactly one piece.
func cut(text string) []piece {
	lines := splitLines(text)
	var out []piece
	start := 0
	flush := func(end int) {
		if end > start {
			body := strings.Join(lines[start:end], "")
			out = append(out, piece{start: start + 1, end: end, body: body, lines: textHash(body)})
		}
		start = end
	}
	size := 0
	for i, line := range lines {
		if len(line) > chunkBytes {
			flush(i)
			for _, part := range halvesUntil(line, chunkBytes) {
				out = append(out, piece{start: i + 1, end: i + 1, body: part, lines: textHash(line)})
			}
			start, size = i+1, 0
			continue
		}
		if i-start >= chunkLines || size+len(line) > chunkBytes {
			flush(i)
			size = 0
		}
		size += len(line)
	}
	flush(len(lines))
	return out
}

// halvesUntil cuts s on character boundaries into parts of at most n bytes.
func halvesUntil(s string, n int) []string {
	var out []string
	for len(s) > n {
		at := n
		for at > 0 && !utf8.RuneStart(s[at]) {
			at--
		}
		out = append(out, s[:at])
		s = s[at:]
	}
	return append(out, s)
}

// split cuts a piece the model found too long in two: by lines, or a single line by characters. ok is false when it
// cannot be cut further (one character over the limit cannot happen with this tokenizer, but is not looped on).
func (p piece) split(lineText func(start, end int) string) ([]piece, bool) {
	if p.end > p.start {
		mid := p.start + (p.end-p.start+1)/2 - 1
		a, b := lineText(p.start, mid), lineText(mid+1, p.end)
		return []piece{{start: p.start, end: mid, body: a, lines: textHash(a)}, {start: mid + 1, end: p.end, body: b, lines: textHash(b)}}, true
	}
	if utf8.RuneCountInString(p.body) < 2 {
		return nil, false
	}
	at := len(p.body) / 2
	for !utf8.RuneStart(p.body[at]) {
		at--
	}
	if at == 0 {
		at = len(p.body) / 2
		for at < len(p.body) && !utf8.RuneStart(p.body[at]) {
			at++
		}
	}
	return []piece{{start: p.start, end: p.end, body: p.body[:at], lines: p.lines}, {start: p.start, end: p.end, body: p.body[at:], lines: p.lines}}, true
}

// vectors keeps every vector once on disk, by key, shared by every folder. A vector's file time is when it was last
// used, so ones nobody has needed for a long time can be removed.
type vectors struct {
	dir     string
	mu      sync.Mutex
	touched map[string]bool
}

func (v *vectors) path(k string) string { return filepath.Join(v.dir, k[:2], k+".f32") }

func (v *vectors) get(k string) []float32 {
	raw, err := os.ReadFile(v.path(k))
	if err != nil || len(raw) != dim*4 {
		return nil
	}
	out := make([]float32, dim)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	v.mu.Lock()
	first := !v.touched[k]
	v.touched[k] = true
	v.mu.Unlock()
	if first {
		now := time.Now()
		_ = os.Chtimes(v.path(k), now, now)
	}
	return out
}

func (v *vectors) put(k string, vec []float32) error {
	if len(vec) != dim {
		return errors.New("vector has the wrong size")
	}
	raw := make([]byte, dim*4)
	for i, f := range vec {
		binary.LittleEndian.PutUint32(raw[i*4:], math.Float32bits(f))
	}
	p := v.path(k)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	v.mu.Lock()
	v.touched[k] = true
	v.mu.Unlock()
	return os.Rename(tmp, p)
}

// sweep removes vectors unused for longer than age that no folder refers to now; it says how many it removed.
func (v *vectors) sweep(age time.Duration, inUse map[string]bool) int {
	removed := 0
	cutoff := time.Now().Add(-age)
	shards, _ := os.ReadDir(v.dir)
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(v.dir, shard.Name()))
		for _, f := range files {
			k := strings.TrimSuffix(f.Name(), ".f32")
			info, err := f.Info()
			if err != nil || inUse[k] || info.ModTime().After(cutoff) {
				continue
			}
			if os.Remove(filepath.Join(v.dir, shard.Name(), f.Name())) == nil {
				removed++
			}
		}
	}
	return removed
}

func normalize(vec []float32) bool {
	var sum float64
	for _, f := range vec {
		if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
			return false
		}
		sum += float64(f) * float64(f)
	}
	if sum == 0 {
		return false
	}
	n := float32(math.Sqrt(sum))
	for i := range vec {
		vec[i] /= n
	}
	return true
}

func dot(a, b []float32) float32 {
	var s float32
	for i := range a {
		s += a[i] * b[i]
	}
	return s
}
