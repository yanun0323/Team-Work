package usecase_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestAnEmployeeWorksOnSeveralTasksAtOnce(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		<-release
		return call("submit_handoff", handoff), nil
	})
	r.task(r.flow.ID)
	r.task(r.flow.ID)
	r.wait("both tasks to start", func(w *model.World) bool {
		on := 0
		for _, s := range w.SubTasks {
			if s.Status == enum.StatusProgressing && s.ReplicaID != nil && *s.ReplicaID == r.owner.ID {
				on++
			}
		}
		return on == 2
	})
}

func TestEmployeesAreToldTheyMayShareTheirFolder(t *testing.T) {
	const sign = "You may not be the only one changing these files"
	var mu sync.Mutex
	systems := []string{}
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		mu.Lock()
		defer mu.Unlock()
		systems = append(systems, req.System)
		return say("好"), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("chat reply", chatDone(c.ID))
	r.task(r.flow.ID)
	r.wait("a step to ask the model", func(*model.World) bool {
		mu.Lock()
		defer mu.Unlock()
		return len(systems) >= 2
	})
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(systems[0], sign) {
		t.Fatalf("chat: %q", systems[0])
	}
	if !strings.Contains(systems[1], "working on one step of a task") || !strings.Contains(systems[1], sign) {
		t.Fatalf("task: %q", systems[1])
	}
}
