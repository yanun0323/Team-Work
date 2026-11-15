package tools

import (
	"context"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A start already admitted when its run is cancelled cannot disappear between Seal and Running: Seal waits for
// its registration, leaves it running for End, and refuses every later start, even with a fresh context.
func TestSealAccountsForAStartUnderWayAtCancellation(t *testing.T) {
	dir := t.TempDir()
	j := &Jobs{}
	inside, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); j.Close() })
	j.started = func() { close(inside); <-release }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		report JobReport
		err    error
	}
	started := make(chan result, 1)
	go func() {
		r, err := j.Start(ctx, "a", dir, "sleep 60 & echo $! > grand.pid; wait", 0, dir, nil)
		started <- result{r, err}
	}()
	<-inside
	cancel()
	sealing, sealed := make(chan struct{}), make(chan struct{})
	go func() { close(sealing); j.Seal("a"); close(sealed) }()
	<-sealing
	select {
	case <-sealed:
		t.Fatal("Seal returned before the admitted command was registered")
	case <-time.After(100 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	s := <-started
	<-sealed
	if s.err != nil {
		t.Fatal(s.err)
	}
	if got := j.Running("a"); !slices.Equal(got, []string{s.report.ID}) {
		t.Fatalf("Seal lost the command admitted before cancellation: %v", got)
	}
	grand := pidFrom(t, filepath.Join(dir, "grand.pid"))
	if err := syscall.Kill(grand, 0); err != nil {
		t.Fatalf("Seal stopped the command before End: %v", err)
	}
	if _, err := j.Start(context.Background(), "a", dir, "true", 0, dir, nil); err == nil {
		t.Fatal("started in a sealed scope")
	}
	if left := j.End("a"); len(left) != 0 {
		t.Fatalf("End left %v", left)
	}
	waitGone(t, grand)
	if got := j.Running("a"); len(got) != 0 {
		t.Fatalf("still running: %v", got)
	}
}
