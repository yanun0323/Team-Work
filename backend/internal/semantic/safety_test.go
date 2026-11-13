package semantic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// within fails the test when f does not return in d.
func within(t *testing.T, d time.Duration, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s did not finish in %s", what, d)
	}
}

// A search while files wait to be indexed is keyword only, and says why: the index is being built, how many files
// wait, and that grep works.
func TestPendingSearchIsKeywordOnly(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	t.Setenv("FAKE_DELAY", "200ms")
	s.Start(true, nil)
	s.waitState(t, StateReady)
	repo := newRepo(t) // a root never seen: every file waits
	res := search(t, s, repo, "monthly ledger balance")
	if res.PendingFiles == 0 || res.Mode != "keyword" {
		t.Fatalf("%+v", res)
	}
	for _, want := range []string{"being built", fmt.Sprint(res.PendingFiles), "grep"} {
		if !strings.Contains(res.Reason, want) {
			t.Fatalf("reason %q has no %q", res.Reason, want)
		}
	}
	if len(res.Results) == 0 || res.Results[0].Path != "ledger.go" {
		t.Fatalf("%+v", res)
	}
	if ev := s.log.events("semantic_search"); ev[len(ev)-1]["vector"].(float64) != 0 {
		t.Fatalf("vectors were searched: %v", ev[len(ev)-1])
	}
}

// symlinkedParent makes repo/src, tracked by Git, a symlink to a folder outside the repo, whose a.txt holds body.
func symlinkedParent(t *testing.T, repo, body string) string {
	t.Helper()
	outside := t.TempDir()
	write(t, outside, "a.txt", body)
	if err := os.Rename(filepath.Join(repo, "src"), filepath.Join(repo, "moved-src")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(repo, "src")); err != nil {
		t.Fatal(err)
	}
	return outside
}

func trackedSrc(t *testing.T, body string) string {
	t.Helper()
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	write(t, repo, "src/a.txt", body)
	git(t, repo, "add", ".")
	return repo
}

// A tracked folder swapped for a symlink to somewhere else is never read through, by keyword or by vector.
func TestParentSymlinkNeverLeavesTheRoot(t *testing.T) {
	for _, mode := range []string{"load_fail", ""} {
		t.Run("mode="+mode, func(t *testing.T) {
			s := newService(t, mode, zerolog.InfoLevel, nil)
			s.Start(true, nil)
			if mode == "" {
				s.waitState(t, StateReady)
			} else {
				s.waitState(t, StateError)
			}
			repo := trackedSrc(t, "original\n")
			symlinkedParent(t, repo, "outsideSecretMarker\n")
			res := search(t, s, repo, "outsideSecretMarker")
			if mode == "" {
				waitIndexed(t, s, repo)
			}
			res2 := search(t, s, repo, "outsideSecretMarker")
			for _, h := range append(res.Results, res2.Results...) {
				if strings.Contains(h.Text, "outsideSecretMarker") {
					t.Fatalf("read outside the root: %+v", h)
				}
			}
			r := s.roots[canonical(repo)]
			r.mu.Lock()
			defer r.mu.Unlock()
			if f := r.files["src/a.txt"]; f != nil && len(f.chunks) > 0 {
				t.Fatal("indexed a file outside the root")
			}
		})
	}
}

// The folder is swapped after the file was found: indexing and the check before handing out refuse it, even when
// the outside file is the same text.
func TestParentSymlinkSwappedMidwayIsRefused(t *testing.T) {
	repo := trackedSrc(t, "same words\n")
	log := &logger{z: zerolog.Nop()}

	// indexing: scanned inside, swapped before it is read
	r := newRoot(canonical(repo))
	defer r.cancel()
	if _, err := r.scan(context.Background(), log, "scan"); err != nil {
		t.Fatal(err)
	}
	symlinkedParent(t, repo, "same words\n")
	st := &indexStats{}
	cache := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	within(t, 5*time.Second, "indexing", func() {
		if _, err := r.indexPending(context.Background(), stubEmbedder{}, cache, log, st); err != nil {
			t.Error(err)
		}
	})
	r.mu.Lock()
	if f := r.files["src/a.txt"]; f != nil && len(f.chunks) > 0 {
		t.Error("indexed through a symlinked folder")
	}
	r.mu.Unlock()

	// handing out: found inside, swapped before the check
	repo2 := trackedSrc(t, "same words\n")
	s := newService(t, "load_fail", zerolog.InfoLevel, nil)
	s.Start(true, nil)
	s.waitState(t, StateError)
	s.mu.Lock()
	r2 := s.rootLocked(repo2)
	s.mu.Unlock()
	if _, err := r2.scan(context.Background(), s.Service.log, "scan"); err != nil {
		t.Fatal(err)
	}
	found := s.keyword(r2, "same words")
	if len(found) == 0 {
		t.Fatal("not found inside")
	}
	symlinkedParent(t, repo2, "same words\n")
	if hits, _, dropped := s.verify(r2, found); len(hits) != 0 || dropped == 0 {
		t.Fatalf("handed out through a symlinked folder: %+v", hits)
	}
}

type stubEmbedder struct{ before func() }

func (e stubEmbedder) embed(ctx context.Context, texts []string, high bool) ([]embedded, time.Duration, error) {
	if e.before != nil {
		e.before()
	}
	out := make([]embedded, len(texts))
	for i, s := range texts {
		out[i] = embedded{tokens: fakeTokens(s), vec: fakeVector(s)}
	}
	return out, 0, nil
}

// A file changed between the scan and its indexing is indexed as it is now, not picked again and again.
func TestFileChangedAfterTheScanIsIndexedAsItIsNow(t *testing.T) {
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	write(t, repo, "a.txt", "original\n")
	r := newRoot(repo)
	defer r.cancel()
	log := &logger{z: zerolog.Nop()}
	if _, err := r.scan(context.Background(), log, "scan"); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "a.txt", "modified words\n")
	cache := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	within(t, 5*time.Second, "indexing", func() {
		if _, err := r.indexPending(context.Background(), stubEmbedder{}, cache, log, &indexStats{}); err != nil {
			t.Error(err)
		}
	})
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.files["a.txt"]
	if f.pending || len(f.chunks) != 1 || f.chunks[0].lines != textHash("modified words\n") {
		t.Fatalf("%+v", f)
	}
}

// A file rewritten every time it is embedded is given up on for this run, still waiting, never with old vectors.
func TestFileThatKeepsChangingLeavesTheRun(t *testing.T) {
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	write(t, repo, "a.txt", "version 0\n")
	write(t, repo, "b.txt", "steady file\n")
	r := newRoot(repo)
	defer r.cancel()
	log := &logger{z: zerolog.Nop()}
	if _, err := r.scan(context.Background(), log, "scan"); err != nil {
		t.Fatal(err)
	}
	n := 0
	emb := stubEmbedder{before: func() {
		n++
		write(t, repo, "a.txt", fmt.Sprintf("version %d\n", n))
	}}
	cache := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	within(t, 5*time.Second, "indexing", func() {
		if _, err := r.indexPending(context.Background(), emb, cache, log, &indexStats{}); err != nil {
			t.Error(err)
		}
	})
	if n > 20 {
		t.Fatalf("embedded %d times", n)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if a := r.files["a.txt"]; !a.pending || len(a.chunks) != 0 || a.working {
		t.Fatalf("a.txt %+v", a)
	}
	if b := r.files["b.txt"]; b.pending {
		t.Fatal("the steady file waited behind the changing one")
	}
}

// Cancelling stops indexing even for a file that changed since the scan.
func TestIndexingStopsWhenCancelled(t *testing.T) {
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	write(t, repo, "a.txt", "original\n")
	r := newRoot(repo)
	log := &logger{z: zerolog.Nop()}
	if _, err := r.scan(context.Background(), log, "scan"); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "a.txt", "modified\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cache := &vectors{dir: t.TempDir(), touched: map[string]bool{}}
	var err error
	within(t, 2*time.Second, "indexing", func() { _, err = r.indexPending(ctx, stubEmbedder{}, cache, log, &indexStats{}) })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if f := r.files["a.txt"]; !f.pending || f.working {
		t.Fatalf("%+v", f)
	}
}

// Turning off while a file keeps changing under indexing finishes in bounded time.
func TestDisableWhileAFileKeepsChanging(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	t.Setenv("FAKE_DELAY", "5ms")
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	defer func() {
		close(stop)
		wg.Wait()
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			write(t, repo, "weather.go", fmt.Sprintf("package main\n// forecast %d\n", i))
			s.Changed(filepath.Join(repo, "weather.go"), "write_file")
			time.Sleep(time.Millisecond)
		}
	}()
	time.Sleep(300 * time.Millisecond)
	within(t, 10*time.Second, "Disable", s.Disable)
}

// Only the helper's own diagnostics reach the log: known events and ops, with numbers where numbers belong.
func TestStderrOnlyKnownDiagnostics(t *testing.T) {
	lines := []string{
		`{"event":"start","pid":12,"memory":1000}`,
		`{"event":"compile_done","seconds":1.5,"prewarmSeconds":0.3,"memory":2000}`,
		`{"event":"error","op":"embed"}`,
		`{"event":"cleanup","folders":1,"bytes":300}`,
		`{"event":"func secretCode() {}"}`,
		`{"memory":{"code":"func secretCode() {}"}}`,
		`{"event":"error","op":"secretCode()"}`,
		`{"event":"start","pid":"secretCode"}`,
		`{"event":"start","memory":[1,"secretCode"]}`,
		`{"event":"exit","op":null}`,
		`"secretCode"`,
		`[1,2]`,
		`{}`,
		strings.Repeat("x", 200<<10), // longer than a line may be: it is skipped, and reading goes on
		`{"event":"exit"}`,
	}
	log := &sink{}
	forwardStderr(strings.NewReader(strings.Join(lines, "\n")+"\n"), 1, &logger{z: zerolog.New(log)})
	if strings.Contains(log.String(), "secretCode") || strings.Contains(log.String(), "xxxxxxxx") {
		t.Fatal(log.String())
	}
	ev := log.events("semantic_helper_stderr")
	if len(ev) != len(lines) {
		t.Fatalf("%d of %d lines logged\n%s", len(ev), len(lines), log.String())
	}
	for i, e := range ev {
		safe := i < 4 || i == len(lines)-1
		if (e["helper"] != nil) != safe || (e["redacted"] == true) == safe {
			t.Errorf("line %d: %v", i, e)
		}
	}
}

// An error the helper replies with never reaches the log as is: it could quote what it was given.
func TestHelperErrorRepliesStayOutOfTheLog(t *testing.T) {
	for _, mode := range []string{"error_reply", "load_error_reply"} {
		t.Run(mode, func(t *testing.T) {
			s := newService(t, mode, zerolog.DebugLevel, nil)
			repo := newRepo(t)
			s.Start(true, []string{repo})
			if mode == "load_error_reply" {
				s.waitState(t, StateError)
				if st := s.Status(true); strings.Contains(st.Error.Message, "leaked") {
					t.Fatalf("%+v", st.Error)
				}
			} else {
				s.waitState(t, StateReady)
				for range 2 {
					res := search(t, s, repo, "monthly ledger balance")
					if res.Mode != "keyword" || strings.Contains(res.Reason, "leaked") {
						t.Fatalf("%+v", res)
					}
				}
				if !strings.Contains(s.log.String(), "kind=coreai domain=other code=7") {
					t.Fatalf("the safe part of the error is not logged\n%s", s.log.String())
				}
			}
			if strings.Contains(s.log.String(), "leakedReplyCode") {
				t.Fatal(s.log.String())
			}
			if !strings.Contains(s.log.String(), "not logged") {
				t.Fatalf("the unlisted error is not noted\n%s", s.log.String())
			}
		})
	}
}

func TestHelperErrorText(t *testing.T) {
	for in, want := range map[string]string{
		// what the helper's errorKind gives (TestSwiftErrorKindsAreWhatGoLogs): fixed words and a code
		"kind=decoding domain=NSCocoaErrorDomain code=4864": "kind=decoding domain=NSCocoaErrorDomain code=4864",
		"kind=nserror domain=NSPOSIXErrorDomain code=2":     "kind=nserror domain=NSPOSIXErrorDomain code=2",
		"kind=coreai domain=other code=-3":                  "kind=coreai domain=other code=-3",
		"model is not loaded":                               "model is not loaded",
		// any other kind or domain, however plain, is not given
		"kind=secretName domain=NSCocoaErrorDomain code=1":        "kind=unlisted domain=NSCocoaErrorDomain code=1",
		"kind=coreai domain=secretName code=1":                    "kind=coreai domain=unlisted code=1",
		"Swift.DecodingError domain=NSCocoaErrorDomain code=4864": "an unlisted error (55 bytes, not logged)",
		"NSError domain=secret.name code=7":                       "an unlisted error (33 bytes, not logged)",
		"kind=coreai domain=other code=7 func":                    "an unlisted error (36 bytes, not logged)",
		"func leaked() { return x }":                              "an unlisted error (26 bytes, not logged)",
		"":                                                        "an unlisted error (0 bytes, not logged)",
	} {
		if got := helperErrorText(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}

// A helper writing frames nobody asked for, then exiting, is stopped in bounded time.
func TestCloseIsBoundedWhenTheHelperFloods(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	p := filepath.Join(t.TempDir(), "flood")
	os.WriteFile(p, []byte("#!/bin/sh\ni=0; while [ $i -lt 20 ]; do echo '{}'; i=$((i+1)); done\n"), 0o700)
	log := &sink{}
	c, err := startChild(p, &logger{z: zerolog.New(log)})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	within(t, 5*time.Second, "close", c.close)
	if len(log.events("semantic_helper_exit")) != 1 {
		t.Fatal(log.String())
	}
}

// A helper that ignores EOF and signals is still let go of in bounded time.
func TestCloseIsBoundedWhenTheHelperHangs(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	p := filepath.Join(t.TempDir(), "hang")
	os.WriteFile(p, []byte("#!/bin/sh\ntrap '' TERM\nexec 0<&-\nwhile :; do echo '{}'; sleep 0.01; done\n"), 0o700)
	c, err := startChild(p, &logger{z: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	within(t, 9*time.Second, "close", c.close)
}

// A query the model cannot take whole is refused, so the caller shortens it; it is never cut.
func TestOverlongQueryIsRefused(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	waitIndexed(t, s, repo)
	_, err := s.Search(context.Background(), Query{Cwd: repo, Text: strings.Repeat("a", 3000)})
	var user *UserError
	if !errors.As(err, &user) || !strings.Contains(err.Error(), "tokens") || !strings.Contains(err.Error(), "shorten") {
		t.Fatal(err)
	}
}

// The whole result, as the JSON the model gets, stays within 50 KiB, however much escaping its lines need.
func TestResultJSONStaysWithinTheLimit(t *testing.T) {
	s := newService(t, "load_fail", zerolog.InfoLevel, nil)
	s.Start(true, nil)
	s.waitState(t, StateError)
	repo := t.TempDir()
	git(t, repo, "init", "-q")
	write(t, repo, "quotes.txt", "needle "+strings.Repeat(`"`, 30000)+"\n")
	write(t, repo, "slashes.txt", "needle "+strings.Repeat(`\`, 20000)+"\n")
	var ctrl strings.Builder
	for i := range 400 {
		fmt.Fprintf(&ctrl, "needle %d \x01\x02\t<&> %s\n", i, strings.Repeat("\x1f", 20))
	}
	write(t, repo, "control.txt", ctrl.String())
	var many strings.Builder
	for i := range 3000 {
		fmt.Fprintf(&many, "needle line %d\n", i)
	}
	write(t, repo, "many.txt", many.String())
	write(t, repo, "small.txt", "needle small\n")
	res := search(t, s, repo, "needle")
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > maxResultBytes || !json.Valid(raw) {
		t.Fatalf("%d bytes", len(raw))
	}
	if len(res.Results) == 0 {
		t.Fatal("nothing fit")
	}
	for _, h := range res.Results {
		data, _ := os.ReadFile(filepath.Join(repo, h.Path))
		lines := splitLines(string(data))
		if h.EndLine < h.StartLine || strings.Join(lines[h.StartLine-1:h.EndLine], "") != h.Text {
			t.Fatalf("%s:%d-%d is not the file's lines", h.Path, h.StartLine, h.EndLine)
		}
	}
	if !strings.Contains(res.Reason, "50 KiB") {
		t.Fatalf("does not say results were left out: %q", res.Reason)
	}
}

// Many indexing batches waiting at once are warned about.
func TestQueueWarning(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	t.Setenv("SEMANTIC_FAKE_HELPER", "1")
	t.Setenv("FAKE_DELAY", "100ms")
	log := &sink{}
	h := newHelper(os.Args[0], "/bundle", "", &logger{z: zerolog.New(log)})
	defer h.close()
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for range queueWarn + 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.call(ctx, map[string]any{"op": "embed", "texts": []string{"x"}, "maxTokens": MaxTokens}, false)
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(log.events("semantic_queue_warning")) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	wg.Wait()
	if ev := log.events("semantic_queue_warning"); len(ev) != 1 || ev[0]["waiting"].(float64) < queueWarn {
		t.Fatalf("%v", ev)
	}
}

// Memory is logged when something goes wrong, not only when everything fails.
func TestMemoryIsLoggedOnErrors(t *testing.T) {
	s := newService(t, "error_reply", zerolog.InfoLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	before := len(s.log.events("semantic_memory"))
	search(t, s, repo, "monthly ledger balance") // the query's vector fails
	if len(s.log.events("semantic_memory")) <= before {
		t.Fatal(s.log.String())
	}
}

// A file changed while the query's vector is on its way is still waiting to be indexed when the vector comes back:
// the search is keyword only and says so, rather than ranking by vectors that leave the file out.
func TestChangeWhileTheQueryIsEmbeddedIsPending(t *testing.T) {
	for _, source := range []string{"write_file", "run_command"} {
		t.Run(source, func(t *testing.T) {
			s := newService(t, "hold_query", zerolog.InfoLevel, nil)
			gate := t.TempDir()
			held, release := filepath.Join(gate, "held"), filepath.Join(gate, "release")
			t.Setenv("FAKE_HELD", held)
			t.Setenv("FAKE_RELEASE", release)
			t.Setenv("FAKE_DELAY", "300ms") // the next indexing batch cannot finish before the search counts again
			defer os.WriteFile(release, nil, 0o644)
			repo := trackedSrc(t, "steady needle\n")
			s.Start(true, []string{repo})
			s.waitState(t, StateReady)
			waitIndexed(t, s, repo)

			type answer struct {
				res Result
				err error
			}
			done := make(chan answer, 1)
			go func() {
				res, err := s.Search(context.Background(), Query{Cwd: repo, Text: "needle"})
				done <- answer{res, err}
			}()
			deadline := time.Now().Add(5 * time.Second)
			for _, err := os.Stat(held); err != nil; _, err = os.Stat(held) {
				if time.Now().After(deadline) {
					t.Fatal("the query never reached the helper")
				}
				time.Sleep(time.Millisecond)
			}
			write(t, repo, "new.txt", "new needle content\n")
			s.Changed(filepath.Join(repo, "new.txt"), source)
			r := s.roots[canonical(repo)]
			for _, p, _ := r.counts(); p == 0; _, p, _ = r.counts() { // run_command looks again in the background
				if time.Now().After(deadline) {
					t.Fatal("the change was never seen")
				}
				time.Sleep(time.Millisecond)
			}
			os.WriteFile(release, nil, 0o644)
			var a answer
			select {
			case a = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the search did not finish")
			}
			if a.err != nil {
				t.Fatal(a.err)
			}
			res := a.res
			if res.Mode != "keyword" || res.PendingFiles == 0 || !strings.Contains(res.Reason, "being built") || !strings.Contains(res.Reason, "grep") {
				t.Fatalf("%+v", res)
			}
			if got := paths(res); !slices.Contains(got, "new.txt") || !slices.Contains(got, "src/a.txt") {
				t.Fatalf("%v", got)
			}
			ev := s.log.events("semantic_search")
			last := ev[len(ev)-1]
			if last["mode"] != "keyword" || last["vector"].(float64) != 0 || last["pendingFiles"].(float64) != float64(res.PendingFiles) {
				t.Fatalf("the log does not match the result: %v", last)
			}
		})
	}
}

// What the helper says went wrong is logged only as a known kind, domain and code: a domain or type name it does
// not know could be anything, input included, however plain it looks.
func TestHelperErrorDomainsStayOutOfTheLog(t *testing.T) {
	for i, msg := range []string{
		"NSError domain=leakedReplyCode.value code=7",
		"SemanticHelper.leakedReplyCode domain=SemanticHelper.leakedReplyCode code=7",
		"kind=leakedReplyCode domain=NSCocoaErrorDomain code=7",
		"kind=coreai domain=leakedReplyCode.value code=7",
	} {
		for _, mode := range []string{"load_error_text", "error_text"} {
			// not named after msg: the test's folders, which the log names, would hold it
			t.Run(fmt.Sprintf("%s/%d", mode, i), func(t *testing.T) {
				t.Setenv("FAKE_ERROR", msg)
				s := newService(t, mode, zerolog.DebugLevel, nil)
				repo := newRepo(t)
				s.Start(true, []string{repo})
				if mode == "load_error_text" {
					s.waitState(t, StateError)
					if st := s.Status(true); strings.Contains(st.Error.Message, "leaked") {
						t.Fatalf("%+v", st.Error)
					}
				} else {
					s.waitState(t, StateReady)
					if res := search(t, s, repo, "monthly ledger balance"); res.Mode != "keyword" || strings.Contains(res.Reason, "leaked") {
						t.Fatalf("%+v", res)
					}
				}
				if strings.Contains(s.log.String(), "leaked") {
					t.Fatal(s.log.String())
				}
				if !strings.Contains(s.log.String(), "code=7") && !strings.Contains(s.log.String(), "not logged") {
					t.Fatalf("nothing of the error is logged\n%s", s.log.String())
				}
			})
		}
	}
}

// The helper's errorKind (Swift) gives only what helperErrorText (Go) keeps whole: whatever is thrown, its type
// name, domain and message never come out.
func TestSwiftErrorKindsAreWhatGoLogs(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	if _, err := exec.LookPath("xcrun"); err != nil {
		t.Skip("no Xcode")
	}
	dir := t.TempDir()
	main := `import Foundation
struct leakedReplyCodeError: Error {}
struct EmbedderError: Error {}
enum leakedReplyCodeEnum: Error { case leakedReplyCodeCase }
let errors: [Error] = [
    NSError(domain: "leakedReplyCode.value", code: 7),
    NSError(domain: NSCocoaErrorDomain, code: 260, userInfo: [NSLocalizedDescriptionKey: "leakedReplyCode"]),
    leakedReplyCodeError(),
    leakedReplyCodeEnum.leakedReplyCodeCase,
    EmbedderError(),
    CocoaError(.fileNoSuchFile),
    POSIXError(.ENOENT),
    CancellationError(),
    DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "leakedReplyCode")),
]
for e in errors { print(errorKind(e)) }
`
	if err := os.WriteFile(filepath.Join(dir, "main.swift"), []byte(main), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	bin := filepath.Join(dir, "kinds")
	build := exec.CommandContext(ctx, "xcrun", "swiftc", "-swift-version", "5", "-module-cache-path", filepath.Join(dir, "cache"),
		"../../../macos/semantic-helper/Sources/semantic-helper/ErrorKind.swift", filepath.Join(dir, "main.swift"), "-o", bin)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	out, err := exec.CommandContext(ctx, bin).Output()
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSpace(string(out)), "\n")
	want := []string{
		"kind=nserror domain=other code=7",
		"kind=nserror domain=NSCocoaErrorDomain code=260",
		"kind=other domain=other code=1",
		"kind=other domain=other code=0",
		"kind=embedder domain=other code=1",
		"kind=nserror domain=NSCocoaErrorDomain code=4", // CocoaError and POSIXError are NSErrors when thrown
		"kind=nserror domain=NSPOSIXErrorDomain code=2",
		"kind=cancelled domain=other code=1",
		"kind=decoding domain=NSCocoaErrorDomain code=4864",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
	for _, line := range got {
		if helperErrorText(line) != line {
			t.Errorf("Go does not keep %q: %q", line, helperErrorText(line))
		}
	}
}

// Memory is logged on a timer, the helper's included.
func TestMemoryIsLoggedPeriodically(t *testing.T) {
	s := newService(t, "", zerolog.InfoLevel, func(o *Options) { o.MemoryEvery = 20 * time.Millisecond })
	s.Start(true, nil)
	s.waitState(t, StateReady)
	helperBytes := func() int {
		n := 0
		for _, e := range s.log.events("semantic_memory") {
			if e["helperBytes"] == float64(1234) {
				n++
			}
		}
		return n
	}
	before := helperBytes()
	deadline := time.Now().Add(5 * time.Second)
	for helperBytes() < before+3 {
		if time.Now().After(deadline) {
			t.Fatalf("%d timed memory lines\n%s", helperBytes()-before, s.log.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// An indexing batch that fails is logged with where and what happens next, memory with it, and is tried again.
func TestFailedIndexBatchIsRetried(t *testing.T) {
	s := newService(t, "index_error_once", zerolog.DebugLevel, nil)
	repo := newRepo(t)
	s.Start(true, []string{repo})
	s.waitState(t, StateReady)
	waitIndexed(t, s, repo)
	lines := strings.Split(s.log.String(), "\n")
	failed := -1
	for i, l := range lines {
		if strings.Contains(l, `"message":"semantic_error"`) && strings.Contains(l, `"stage":"index"`) && strings.Contains(l, `"next":"retry"`) &&
			strings.Contains(l, "kind=coreai domain=other code=5") && strings.Contains(l, `"root":`) && strings.Contains(l, `"file":`) {
			failed = i
			break
		}
	}
	if failed < 0 {
		t.Fatal(s.log.String())
	}
	if !slices.ContainsFunc(lines[failed:], func(l string) bool { return strings.Contains(l, `"message":"semantic_memory"`) }) {
		t.Fatal("no memory after the failure")
	}
	if got := paths(search(t, s, repo, "monthly ledger balance")); len(got) == 0 || got[0] != "ledger.go" {
		t.Fatalf("%v", got)
	}
	if ev := s.log.events("semantic_search"); ev[len(ev)-1]["mode"] != "hybrid" {
		t.Fatalf("%v", ev[len(ev)-1])
	}
	assertNoCode(t, s.log.String())
}
