package semantic

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// TestRealModel runs the real helper and model on a real project, for checking on a Mac with macOS 27:
//
//	SEMANTIC_REAL_HELPER=<semantic-helper> SEMANTIC_REAL_HOME=<data folder> SEMANTIC_REAL_ROOT=<a Git work tree it may change> \
//	go test -run TestRealModel -v ./internal/semantic/
//
// It changes files in SEMANTIC_REAL_ROOT and puts them back with git checkout.
func TestRealModel(t *testing.T) {
	helper, home, root := os.Getenv("SEMANTIC_REAL_HELPER"), os.Getenv("SEMANTIC_REAL_HOME"), os.Getenv("SEMANTIC_REAL_ROOT")
	if helper == "" || home == "" || root == "" {
		t.Skip("set SEMANTIC_REAL_HELPER, SEMANTIC_REAL_HOME and SEMANTIC_REAL_ROOT to run the real model")
	}
	log := &sink{}
	s := New(Options{DataDir: home, Log: zerolog.New(log).Level(zerolog.InfoLevel), Platform: Detect(helper)})
	t.Cleanup(s.Close)
	start := time.Now()
	s.Start(true, []string{root})
	ts := &testService{Service: s, log: log}
	ts.waitStateWithin(t, StateReady, 30*time.Minute)
	t.Logf("ready in %s", time.Since(start))
	for _, ev := range []string{"semantic_compile", "semantic_validate", "semantic_index"} {
		for _, e := range log.events(ev) {
			t.Logf("%s %v", ev, e)
		}
	}
	timed := func(query string) Result {
		t0 := time.Now()
		res := search(t, ts, root, query)
		t.Logf("search %q: %s, mode %s, %d results, first %v", query, time.Since(t0), res.Mode, len(res.Results), paths(res)[:min(3, len(res.Results))])
		return res
	}
	timed("where does the backend decide which tools an employee is given")
	timed("how is the app restarted after a setting changes")
	if res := timed("驗證下載的模型檢查碼"); res.Mode != "hybrid" || len(res.Results) == 0 || res.Results[0].Path != "backend/internal/semantic/download.go" {
		t.Errorf("download.go is not first: %v", paths(res))
	}
	ev := log.events("semantic_search")
	t.Logf("last search %v", ev[len(ev)-1])

	t.Cleanup(func() {
		exec.Command("git", "-C", root, "checkout", "--", ".").Run()
		os.Remove(filepath.Join(root, "zz_semantic_probe.go"))
	})
	// write_file: a file rewritten is not handed out as it was
	target := filepath.Join(root, "backend/internal/usecase/tools/tools.go")
	if err := os.WriteFile(target, []byte("package tools\n\n// The tools were moved away.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.Changed(target, "write_file")
	for _, h := range timed("where does the backend decide which tools an employee is given").Results {
		if h.Path == "backend/internal/usecase/tools/tools.go" && strings.Contains(h.Text, "func For(") {
			t.Fatal("old content handed out after write_file")
		}
	}
	// run_command: a new file, searched by keyword until its vectors are ready, then by meaning too
	cmd := exec.Command("sh", "-c", "printf 'package probe\\n\\n// zebracorn ledger: counts striped unicorns in the stable\\nfunc Zebracorns() int { return 3 }\\n' > zz_semantic_probe.go")
	cmd.Dir = root
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	s.Changed(root, "run_command")
	res := timed("zebracorn")
	t.Logf("right after run_command: pending %d, reason %q", res.PendingFiles, res.Reason)
	if !slices.Contains(paths(res), "zz_semantic_probe.go") {
		t.Fatalf("new file not found by keyword: %v", paths(res))
	}
	deadline := time.Now().Add(time.Minute)
	for s.Status(true).Progress.PendingFiles > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := paths(timed("how many striped horses with a horn live in the barn")); !slices.Contains(got, "zz_semantic_probe.go") {
		t.Errorf("not found by meaning: %v", got)
	}
	assertNoCodeReal(t, log.String())
}

func (s *testService) waitStateWithin(t *testing.T, want string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st := s.Status(true)
		if st.State == want {
			return
		}
		if st.State == StateError {
			t.Fatalf("%+v\n%s", st.Error, s.log.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no %s", want)
}

func assertNoCodeReal(t *testing.T, log string) {
	t.Helper()
	for _, s := range []string{"func For(", "zebracorn ledger", "striped unicorns", "The tools were moved away"} {
		if strings.Contains(log, s) {
			t.Fatalf("the log has %q", s)
		}
	}
}
