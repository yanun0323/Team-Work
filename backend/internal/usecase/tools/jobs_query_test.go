package tools

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// events is what happened to a background command, in order: its group signalled, the folder said changed, the
// command said done.
type events struct {
	mu   sync.Mutex
	list []string
}

func (e *events) add(s string) {
	e.mu.Lock()
	e.list = append(e.list, s)
	e.mu.Unlock()
}

func (e *events) get() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.list)
}

// queried starts a command whose shell is done at once, leaving a process of its group behind, with the group's
// processes looked up by busy. It returns the id, the pid of what was left and the group.
func queried(t *testing.T, j *Jobs, ev *events, dir string) (string, int, int) {
	t.Helper()
	j.signal = func(pgid int, sig syscall.Signal) error {
		ev.add("kill")
		return syscall.Kill(-pgid, sig)
	}
	j.Done = func(string) { ev.add("done") }
	pidFile := filepath.Join(dir, "grand.pid")
	r, err := j.Start(context.Background(), "a", dir, "sleep 30 & echo $! > "+pidFile+"; echo out-before", 0, t.TempDir(), func() { ev.add("changed") })
	if err != nil {
		t.Fatal(err)
	}
	var grand int
	for deadline := time.Now().Add(5 * time.Second); grand == 0; time.Sleep(10 * time.Millisecond) {
		if b, err := os.ReadFile(pidFile); err == nil && strings.HasSuffix(string(b), "\n") {
			grand, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		}
		if time.Now().After(deadline) {
			t.Fatal("no pid")
		}
	}
	t.Cleanup(func() { _ = syscall.Kill(grand, syscall.SIGKILL) })
	j.mu.Lock()
	pgid := j.byID[r.ID].pgid
	j.mu.Unlock()
	return r.ID, grand, pgid
}

// When its process group cannot be looked up for a moment, a command whose shell is done is not taken as over: what
// is left of it is stopped first, and only once nothing is left is the folder said changed and the command done. It
// did not end by itself, so it is not reported as exiting well.
func TestAGroupThatCannotBeLookedUpIsStoppedBeforeItIsOver(t *testing.T) {
	dir := t.TempDir()
	var ev events
	var calls atomic.Int32
	j := &Jobs{}
	defer j.Close()
	var pgid atomic.Int32
	j.busy = func(g, except int) (bool, error) {
		if calls.Add(1) <= 3 {
			return false, errors.New("lookup failed")
		}
		return groupBusy(g, except)
	}
	id, grand, group := queried(t, j, &ev, dir)
	pgid.Store(int32(group))
	r, err := j.Wait(context.Background(), "a", id, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	got := ev.get()
	kill, changed, done := slices.Index(got, "kill"), slices.Index(got, "changed"), slices.Index(got, "done")
	if kill < 0 || changed < 0 || done < 0 || kill > changed || changed > done {
		t.Fatalf("not stopped, then said changed, then done: %v", got)
	}
	if r.State == JobExited || r.State == JobRunning {
		t.Fatalf("reported as %s: %s", r.State, r.Text())
	}
	if !strings.Contains(r.Output, "out-before") {
		t.Fatalf("output lost: %q", r.Output)
	}
	waitGone(t, grand)
}

// While its group cannot be looked up at all, a command stays running, stopped but not over: nothing is said changed
// or done, it cannot be taken as ended, and ending its scope leaves it known as running, so a hand-off still sees it.
// Once the group can be looked up again and nothing is left, it is over.
func TestAGroupThatCannotBeLookedUpStaysRunningUntilItCan(t *testing.T) {
	dir := t.TempDir()
	var ev events
	var failing atomic.Bool
	failing.Store(true)
	j := &Jobs{endWait: 300 * time.Millisecond}
	defer j.Close()
	j.busy = func(g, except int) (bool, error) {
		if failing.Load() {
			return false, errors.New("lookup failed")
		}
		return groupBusy(g, except)
	}
	id, grand, _ := queried(t, j, &ev, dir)
	waitGone(t, grand) // stopped, as nothing can say it is not still running
	time.Sleep(300 * time.Millisecond)
	if got := ev.get(); slices.Contains(got, "changed") || slices.Contains(got, "done") {
		t.Fatalf("over while its group could not be looked up: %v", got)
	}
	if r, _ := j.Status("a", id); r.State != JobRunning || j.HasEnded("a") {
		t.Fatalf("%+v", r)
	}
	if left := j.End("a"); !slices.Equal(left, []string{id}) {
		t.Fatalf("End says %v is left", left)
	}
	if got, under := j.Running("a"), j.RunningUnder(""); !slices.Equal(got, []string{id}) || !slices.Equal(under, []string{id}) {
		t.Fatalf("forgotten while not known to be over: %v %v", got, under)
	}
	failing.Store(false)
	for deadline := time.Now().Add(5 * time.Second); len(j.Running("a")) > 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("never over once its group could be looked up")
		}
	}
	got := ev.get()
	if c, d := slices.Index(got, "changed"), slices.Index(got, "done"); c < 0 || d < c || strings.Count(strings.Join(got, ","), "changed") != 1 {
		t.Fatalf("%v", got)
	}
}

// What /proc says of a process: its state and group, and whether a failure to read it means it is gone.
func TestProcStatIsReadWithItsName(t *testing.T) {
	state, group, err := procStat([]byte("42 (a) b (c)) S 1 77 77 0 -1"))
	if err != nil || state != "S" || group != "77" {
		t.Fatalf("%q %q %v", state, group, err)
	}
	for _, bad := range []string{"", "42 a S 1 77", "42 (a) S"} {
		if _, _, err := procStat([]byte(bad)); err == nil {
			t.Errorf("%q read", bad)
		}
	}
	if !procGone(fs.ErrNotExist) || !procGone(syscall.ESRCH) || !procGone(&fs.PathError{Op: "open", Err: syscall.ENOENT}) {
		t.Error("a process that is gone is not taken as gone")
	}
	if procGone(fs.ErrPermission) || procGone(syscall.EIO) || procGone(errors.New("x")) {
		t.Error("a failure to read is taken as the process being gone")
	}
}
