package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// signals records the process groups a Jobs signals, and still signals them, so its own commands do stop.
type signals struct {
	mu   sync.Mutex
	sent []int
}

func (s *signals) watch(j *Jobs) {
	j.signal = func(pgid int, sig syscall.Signal) error {
		s.mu.Lock()
		s.sent = append(s.sent, pgid)
		s.mu.Unlock()
		return syscall.Kill(-pgid, sig)
	}
}

func (s *signals) reset() {
	s.mu.Lock()
	s.sent = nil
	s.mu.Unlock()
}

func (s *signals) list() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.sent...)
}

func waitEnded(t *testing.T, j *Jobs, scope string) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); !j.HasEnded(scope); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("it did not end")
		}
	}
}

// A command whose shell is done while what it started still runs is not done: it is still running, cannot be taken
// as ended, and it says it changed files only once all of it is over, with all its output.
func TestBackgroundCommandIsDoneOnlyWhenAllItStartedIs(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var changedSaw []bool // whether the late file was there when it was said to have changed
	jobs := &Jobs{}
	defer jobs.Close()
	late := filepath.Join(dir, "late.txt")
	for _, command := range []string{
		// what it started writes to its output after the shell is gone
		"(sleep 0.8; echo grand-out; echo late > late.txt) & echo parent-done",
		// what it started holds no output, and writes a file late
		"(sleep 0.8; echo late > late.txt) >/dev/null 2>&1 & echo parent-done",
	} {
		_ = os.Remove(late)
		r, err := jobs.Start(context.Background(), "a", dir, command, 0, t.TempDir(), func() {
			_, err := os.Stat(late)
			mu.Lock()
			changedSaw = append(changedSaw, err == nil)
			mu.Unlock()
		})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond) // the shell is long gone
		if got := jobs.Running("a"); len(got) != 1 || got[0] != r.ID {
			t.Fatalf("%s: running %v", command, got)
		}
		if jobs.HasEnded("a") {
			t.Fatalf("%s: ended while what it started runs", command)
		}
		s, _ := jobs.Status("a", r.ID)
		if s.State != JobRunning {
			t.Fatalf("%s: %+v", command, s)
		}
		w, err := jobs.Wait(context.Background(), "a", r.ID, 10*time.Second)
		if err != nil || w.State != JobExited || w.ExitCode != 0 || !strings.Contains(w.Output, "parent-done") {
			t.Fatalf("%s: %+v %v", command, w, err)
		}
		if strings.HasPrefix(command, "(sleep 0.8; echo grand-out") && !strings.Contains(w.Output, "grand-out") {
			t.Fatalf("lost what came late: %q", w.Output)
		}
		if b, _ := os.ReadFile(late); string(b) != "late\n" {
			t.Fatalf("%s: ended before the late write: %q", command, b)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(changedSaw) != 2 || !changedSaw[0] || !changedSaw[1] {
		t.Fatalf("changed heard before all of it was done: %v", changedSaw)
	}
}

// Kill and a timeout stop what a command started even after its shell is gone.
func TestKillAndTimeoutReachWhatOutlivedTheShell(t *testing.T) {
	dir := t.TempDir()
	jobs := &Jobs{}
	defer jobs.Close()
	r, err := jobs.Start(context.Background(), "a", dir, "sleep 30 >/dev/null 2>&1 & echo $! > k.pid", 0, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	kid := pidFrom(t, filepath.Join(dir, "k.pid"))
	time.Sleep(200 * time.Millisecond)
	k, err := jobs.Kill("a", r.ID)
	if err != nil || k.State != JobKilled {
		t.Fatalf("%+v %v", k, err)
	}
	waitGone(t, kid)

	r, err = jobs.Start(context.Background(), "a", dir, "sleep 30 >/dev/null 2>&1 & echo $! > t.pid", time.Second, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	tid := pidFrom(t, filepath.Join(dir, "t.pid"))
	w, _ := jobs.Wait(context.Background(), "a", r.ID, 10*time.Second)
	if w.State != JobTimedOut {
		t.Fatalf("%+v", w)
	}
	waitGone(t, tid)
}

func pidFrom(t *testing.T, path string) int {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		b, _ := os.ReadFile(path)
		var pid int
		for _, c := range strings.TrimSpace(string(b)) {
			pid = pid*10 + int(c-'0')
		}
		if pid > 0 && strings.TrimSpace(string(b)) != "" {
			return pid
		}
	}
	t.Fatalf("no pid in %s", path)
	return 0
}

// Once a command is over, its process group id is no longer its own: ending its scope or closing sends it nothing,
// and ending one scope signals none of another's.
func TestOverCommandsAreNotSignalledAgain(t *testing.T) {
	var sent signals
	jobs := &Jobs{}
	sent.watch(jobs)
	defer jobs.Close()
	dir := t.TempDir()
	done, err := jobs.Start(context.Background(), "a", dir, "true", 0, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	waitEnded(t, jobs, "a")
	other, err := jobs.Start(context.Background(), "b", dir, "sleep 30", 0, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Status("a", done.ID); err != nil {
		t.Fatal(err)
	}
	sent.reset()
	jobs.End("a")
	if got := sent.list(); len(got) != 0 {
		t.Fatalf("ending a scope whose command is over signalled %v", got)
	}
	if got := jobs.Running("b"); len(got) != 1 || got[0] != other.ID {
		t.Fatalf("another scope's command was touched: %v", got)
	}
	// the one of b is signalled once, as Close stops it; then nothing more
	jobs.Close()
	got := sent.list()
	if len(got) == 0 {
		t.Fatal("close did not stop what runs")
	}
	for _, g := range got {
		if g == 0 || g == 1 || g == -1 {
			t.Fatalf("%v", got)
		}
	}
	n := len(got)
	jobs.End("b")
	jobs.Close()
	if len(sent.list()) != n {
		t.Fatalf("signalled again after it was over: %v", sent.list())
	}
}

// A scope that ended takes no more commands: not one that started at the same time, not one asked for later, and
// none whose run was already stopped.
func TestEndedScopesStartNothing(t *testing.T) {
	dir := t.TempDir()
	jobs := &Jobs{}
	defer jobs.Close()
	jobs.End("a")
	if _, err := jobs.Start(context.Background(), "a", dir, "echo ran > after-end.txt", 0, "", nil); err == nil {
		t.Fatal("started in an ended scope")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := jobs.Start(ctx, "b", dir, "echo ran > cancelled.txt", 0, "", nil); err == nil {
		t.Fatal("started with its run stopped")
	}
	time.Sleep(200 * time.Millisecond)
	for _, name := range []string{"after-end.txt", "cancelled.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Fatalf("%s ran", name)
		}
	}

	// End coming while a start is under way waits for it, then stops what it started
	var sent signals
	sent.watch(jobs)
	inside, release := make(chan struct{}), make(chan struct{})
	jobs.started = func() {
		close(inside)
		<-release
	}
	type started struct {
		r   JobReport
		err error
	}
	got := make(chan started, 1)
	go func() {
		r, err := jobs.Start(context.Background(), "c", dir, "sleep 30 & echo $! > c.pid; wait", 0, "", nil)
		got <- started{r, err}
	}()
	<-inside
	jobs.started = nil
	ended := make(chan struct{})
	go func() { jobs.End("c"); close(ended) }()
	select {
	case <-ended:
		t.Fatal("End did not wait for the start under way")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	s := <-got
	<-ended
	if s.err != nil {
		t.Fatal(s.err)
	}
	if s.r.State != JobRunning || len(sent.list()) == 0 {
		t.Fatalf("%+v %v", s.r, sent.list())
	}
	// its group is gone, all of it
	if err := syscall.Kill(-sent.list()[0], 0); err != syscall.ESRCH {
		t.Fatalf("its group is still there: %v", err)
	}
	if got := jobs.Running("c"); len(got) != 0 {
		t.Fatalf("%v", got)
	}
	if _, err := jobs.Start(context.Background(), "c", dir, "true", 0, "", nil); err == nil {
		t.Fatal("started after the scope ended")
	}
}

// Many starts racing an End leave nothing running behind it.
func TestStartsRacingEndLeaveNothing(t *testing.T) {
	dir := t.TempDir()
	jobs := &Jobs{}
	defer jobs.Close()
	var wg sync.WaitGroup
	for i := range MaxJobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = jobs.Start(context.Background(), "a", dir, "sleep 30 & echo $! > p"+string(rune('0'+i))+".pid; wait", 0, "", nil)
		}()
	}
	jobs.End("a")
	wg.Wait()
	if got := jobs.Running("a"); len(got) != 0 {
		t.Fatalf("%v still running", got)
	}
	time.Sleep(200 * time.Millisecond)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		waitGone(t, pidFrom(t, filepath.Join(dir, e.Name())))
	}
}

// Looking at a command that ended does not take its end: it is still told once; waiting for it, or killing it, does.
func TestStatusLeavesTheEndToBeTold(t *testing.T) {
	jobs := &Jobs{}
	defer jobs.Close()
	dir := t.TempDir()
	r, err := jobs.Start(context.Background(), "a", dir, "echo hi", 0, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	waitEnded(t, jobs, "a")
	s, _ := jobs.Status("a", r.ID)
	if s.State != JobExited || !jobs.HasEnded("a") {
		t.Fatalf("%+v", s)
	}
	if shown := jobs.Show("a"); len(shown) != 1 {
		t.Fatalf("%+v", shown)
	}
	if ended := jobs.Ended("a"); len(ended) != 1 || ended[0].ID != r.ID || !ended[0].Shown {
		t.Fatalf("%+v", ended)
	}
	if len(jobs.Ended("a")) != 0 || len(jobs.Show("a")) != 0 {
		t.Fatal("told twice")
	}
	for _, act := range []string{"wait", "kill"} {
		r, _ := jobs.Start(context.Background(), "a", dir, "echo hi", 0, "", nil)
		waitEnded(t, jobs, "a")
		if act == "wait" {
			_, _ = jobs.Wait(context.Background(), "a", r.ID, 0)
		} else {
			_, _ = jobs.Kill("a", r.ID)
		}
		if jobs.HasEnded("a") {
			t.Fatalf("%s left the end to be told again", act)
		}
	}
}
