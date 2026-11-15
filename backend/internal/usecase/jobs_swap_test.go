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
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// Unlike swapping a run with no background command, replacing a writer that still has one must wait for cleanup.
func TestSwappingAStepWaitsForItsCancelledBackgroundCommand(t *testing.T) {
	t.Parallel()
	r := newRig(t, nil)
	pid := filepath.Join(t.TempDir(), "grand.pid")
	waiting, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	calls := 0 // the fake serializes calls
	r.fake.replyContext = func(ctx context.Context, req model.ModelRequest) (model.ModelReply, error) {
		calls++
		switch calls {
		case 1:
			return background(grandCommand(pid)), nil
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
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task := r.task(r.flow.ID)
	grand := pidIn(t, pid)
	select {
	case <-waiting:
	case <-time.After(patience):
		t.Fatal("provider never waited")
	}
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{Staff: map[string][]string{"start": {bo.ID}}, Swap: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(patience):
		t.Fatal("provider never received cancellation")
	}
	if err := syscall.Kill(grand, 0); err != nil {
		t.Fatalf("command ended before cleanup: %v", err)
	}
	s := subAt(r.world(), task.ID, "整理需求")
	if s.Status == enum.StatusProgressing || logged(s, "start", map[string]any{"name": "Bo"}) {
		t.Fatalf("replacement writer started before the old command stopped: %+v", s)
	}
	once.Do(func() { close(release) })
	waitDead(t, grand)
	w := r.wait("replacement completes", stage(task.ID, enum.StageAwaitMerge))
	if s := subAt(w, task.ID, "整理需求"); *s.ReplicaID != bo.ID || !logged(s, "start", map[string]any{"name": "Bo"}) {
		t.Fatalf("replacement never started after cleanup: %+v", s)
	}
}
