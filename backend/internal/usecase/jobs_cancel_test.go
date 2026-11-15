package usecase_test

import (
	"context"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// Cancelling a provider need not return instantly. Until the old run reaches cleanup, its background command is
// still live; pausing and resuming a legacy task must not dispatch another writer into the same worktree.
func TestLegacyResumeWaitsForCancelledRunsBackgroundCleanup(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	pids := t.TempDir()
	waiting, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	calls := 0 // the script serializes Complete calls
	r.fake.replyContext = func(ctx context.Context, req model.ModelRequest) (model.ModelReply, error) {
		calls++
		switch calls {
		case 1:
			return background("sh -c 'sleep 60 & echo $! > " + filepath.Join(pids, "grand.pid") + "; wait'"), nil
		case 2:
			close(waiting)
			<-ctx.Done()
			close(cancelled)
			<-release
			return model.ModelReply{}, ctx.Err()
		default:
			return call("submit_handoff", handoff), nil
		}
	}
	task := r.task(r.flow.ID)
	grand := pidIn(t, filepath.Join(pids, "grand.pid"))
	select {
	case <-waiting:
	case <-time.After(patience):
		t.Fatal("provider never waited")
	}
	if err := r.e.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(patience):
		t.Fatal("provider never received cancellation")
	}
	if syscall.Kill(grand, 0) != nil {
		t.Fatal("background process ended before cleanup; this does not reproduce the race")
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	// ResumeTask settles dispatch synchronously; the old provider is still held at the barrier and cannot clean up.
	w := r.world()
	s := subAt(w, task.ID, "整理需求")
	if s.Status == enum.StatusProgressing && syscall.Kill(grand, 0) == nil {
		t.Fatalf("resumed writer %s while the cancelled run's background process %d is still alive", s.ID, grand)
	}
	once.Do(func() { close(release) })
	waitDead(t, grand)
	r.wait("resumed task completes", stage(task.ID, enum.StageAwaitMerge))
}
