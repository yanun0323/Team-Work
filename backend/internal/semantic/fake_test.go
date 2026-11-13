package semantic

import (
	"bufio"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"strings"
	"testing"
	"time"
	"unicode"
)

// TestMain lets this test binary stand in for semantic-helper: with SEMANTIC_FAKE_HELPER set it speaks the
// helper's protocol, with a made-up model. FAKE_MODE picks a failure to act out.
func TestMain(m *testing.M) {
	if os.Getenv("SEMANTIC_FAKE_HELPER") == "1" {
		fakeHelper()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeTokens counts one token per character, plus <bos> and <eos>: stricter than Gemma's, so cutting is exercised.
func fakeTokens(s string) int { return len([]rune(s)) + 2 }

// fakeVector is a bag of words: texts sharing words point the same way.
func fakeVector(s string) []float32 {
	v := make([]float32, dim)
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if w == "task" || w == "code" || w == "retrieval" || w == "query" || w == "title" || w == "none" || w == "text" {
			continue
		}
		h := fnv.New32a()
		h.Write([]byte(w))
		v[h.Sum32()%dim] += 1
	}
	var n float64
	for _, f := range v {
		n += float64(f * f)
	}
	if n == 0 {
		v[0] = 1
		return v
	}
	for i := range v {
		v[i] /= float32(math.Sqrt(n))
	}
	return v
}

func fakeHelper() {
	mode := os.Getenv("FAKE_MODE")
	out := bufio.NewWriter(os.Stdout)
	reply := func(v map[string]any) {
		raw, _ := json.Marshal(v)
		out.Write(append(raw, '\n'))
		out.Flush()
	}
	fmt.Fprintln(os.Stderr, `{"event":"start","pid":1}`)
	// what a framework might print: it quotes input, so it must never reach the log as is
	fmt.Fprintln(os.Stderr, "framework says: func leakedSecretCode() {}")
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 64<<20)
	embeds := 0
	_ = embeds
	for in.Scan() {
		var req struct {
			ID        int      `json:"id"`
			Op        string   `json:"op"`
			Texts     []string `json:"texts"`
			MaxTokens int      `json:"maxTokens"`
		}
		if json.Unmarshal(in.Bytes(), &req) != nil {
			continue
		}
		switch req.Op {
		case "load":
			if mode == "load_fail" {
				reply(map[string]any{"id": req.ID, "ok": false, "error": "cannot compile"})
				continue
			}
			if mode == "load_error_reply" {
				reply(map[string]any{"id": req.ID, "ok": false, "error": "cannot read func leakedReplyCode() {}"})
				continue
			}
			if mode == "load_error_text" {
				reply(map[string]any{"id": req.ID, "ok": false, "error": os.Getenv("FAKE_ERROR")})
				continue
			}
			reply(map[string]any{"id": req.ID, "ok": true, "loadSeconds": 0.01, "maxTokens": 2048, "dim": dim})
		case "validate":
			cos := 0.9999
			if mode == "validate_fail" {
				cos = 0.5
			}
			reply(map[string]any{"id": req.ID, "ok": true, "tokenizerSame": 3, "tokenizerCases": 3, "smokeCases": 2, "minCosine": cos, "threshold": 0.999, "dimensionsOK": true})
		case "memory":
			reply(map[string]any{"id": req.ID, "ok": true, "bytes": 1234})
		case "embed":
			embeds++
			if mode == "crash" {
				os.Exit(3)
			}
			// a failure quoting its input, then one that is only a type, domain and code
			query := len(req.Texts) == 1 && strings.HasPrefix(req.Texts[0], queryPrefix)
			if mode == "error_reply" && query {
				msg := "kind=coreai domain=other code=7"
				if once() {
					msg = "bad input: func leakedReplyCode() {}"
				}
				reply(map[string]any{"id": req.ID, "ok": false, "error": msg})
				continue
			}
			if mode == "error_text" && query {
				reply(map[string]any{"id": req.ID, "ok": false, "error": os.Getenv("FAKE_ERROR")})
				continue
			}
			// an indexing batch fails once, as a known kind of error
			if mode == "index_error_once" && !query && once() {
				reply(map[string]any{"id": req.ID, "ok": false, "error": "kind=coreai domain=other code=5"})
				continue
			}
			// the query's vector waits, FAKE_HELD saying so, until FAKE_RELEASE exists
			if mode == "hold_query" && query {
				os.WriteFile(os.Getenv("FAKE_HELD"), nil, 0o644)
				for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
					if _, err := os.Stat(os.Getenv("FAKE_RELEASE")); err == nil {
						break
					}
				}
			}
			if mode == "bad_frame" && once() {
				out.WriteString("{not json\n")
				out.Flush()
				continue
			}
			if d := os.Getenv("FAKE_DELAY"); d != "" {
				ms, _ := time.ParseDuration(d)
				time.Sleep(ms)
			}
			var results []map[string]any
			for _, t := range req.Texts {
				n := fakeTokens(t)
				if n > req.MaxTokens {
					results = append(results, map[string]any{"tokens": n, "tooLong": true})
					continue
				}
				results = append(results, map[string]any{"tokens": n, "vector": fakeVector(t)})
			}
			reply(map[string]any{"id": req.ID, "ok": true, "results": results})
		default:
			reply(map[string]any{"id": req.ID, "ok": false, "error": "unknown op"})
		}
	}
}

// once is true the first time any fake helper of the test asks, by FAKE_ONCE's file.
func once() bool {
	f, err := os.OpenFile(os.Getenv("FAKE_ONCE"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return false
	}
	f.Close()
	return true
}
