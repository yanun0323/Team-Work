package semantic

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A burst of changes to one folder runs one scan at a time, with at most one more after the one running, and a
// change after the last scan began is still scanned.
func TestBackgroundScansOfAFolderTakeTurns(t *testing.T) {
	r := newRoot(t.TempDir())
	defer r.cancel()
	var running, most, runs atomic.Int32
	release := make(chan struct{})
	scan := func() {
		now := running.Add(1)
		defer running.Add(-1)
		if now > most.Load() {
			most.Store(now)
		}
		runs.Add(1)
		<-release
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); r.background(scan) }()
	}
	wg.Wait()
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.bgMu.Lock()
		idle := !r.bgRunning
		r.bgMu.Unlock()
		if idle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("still scanning")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if most.Load() != 1 || runs.Load() < 1 || runs.Load() > 2 {
		t.Fatalf("%d at once, %d scans", most.Load(), runs.Load())
	}
	// once idle, the next change scans again
	before := runs.Load()
	done := make(chan struct{})
	r.background(func() { runs.Add(1); close(done) })
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("no scan after going idle")
	}
	if runs.Load() != before+1 {
		t.Fatal(runs.Load())
	}
}
