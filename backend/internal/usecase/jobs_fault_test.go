package usecase_test

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// These tests stop a step's or chat's background command while its process group cannot be looked up: it is killed,
// but nothing can say it is over. Until it can, it stays known as running, the work tree it writes to takes no other
// writer, and nothing is said stopped or ended; once the group can be looked up, it ends, told once.

// faultyEndWait is how long ending a scope waits for its commands while their groups cannot be looked up.
const faultyEndWait = 300 * time.Millisecond

// settleTime is how long a test watches for something that must not happen: well past faultyEndWait.
const settleTime = time.Second

const (
	leftLine    = "尚未確認結束"
	drainedLine = "背景指令已確認結束"
)

// faultyRig is a rig whose background commands' process groups cannot be looked up while the flag is set.
func faultyRig(t *testing.T) (*rig, *atomic.Bool) {
	t.Helper()
	r := newRig(t, nil)
	failing := new(atomic.Bool)
	r.e.FailJobLookups(failing, faultyEndWait)
	return r, failing
}

// grandCommand runs a sleeping grandchild in the background, its pid written to path.
func grandCommand(path string) string {
	return "sh -c 'sleep 60 & echo $! > " + path + "; wait'"
}

// pidSoon waits, from a fake model's reply, for a pid written to path; 0 when none comes.
func pidSoon(path string) int {
	for deadline := time.Now().Add(patience); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		b, _ := os.ReadFile(path)
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			return pid
		}
	}
	return 0
}

// logCount is how many lines of a step's log contain text.
func logCount(s *model.SubTask, text string) int {
	n := 0
	for _, l := range s.Log {
		if strings.Contains(l.Text, text) {
			n++
		}
	}
	return n
}

// heldWhileFailing checks, while groups cannot be looked up and long after the run stopped its commands, that the
// command is still known as running, its grandchild was stopped all the same, and no step's run made a model call
// since the count given.
func heldWhileFailing(t *testing.T, r *rig, grand int, steps *atomic.Int32, before int32) {
	t.Helper()
	waitDead(t, grand)
	time.Sleep(settleTime)
	if got := r.e.JobsRunning("sub:"); len(got) != 1 {
		t.Fatalf("the command not known to be over was forgotten: %v", got)
	}
	if n := steps.Load(); n != before {
		t.Fatalf("a writer ran (%d model calls of steps, %d before) while a command of the work tree was not known to be over", n, before)
	}
	left, over := 0, 0
	for _, s := range r.world().SubTasks {
		left, over = left+logCount(s, leftLine), over+logCount(s, drainedLine)
	}
	if left != 1 || over != 0 {
		t.Fatalf("%d lines say a command is left, %d say it is over", left, over)
	}
}

// An owner-led step that fails, with a retry left, is retried only once its commands are known to be over.
func TestOwnerRetryWaitsForCommandsNotKnownOver(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	pid := filepath.Join(t.TempDir(), "grand.pid")
	var steps atomic.Int32
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		if laterStep(req) {
			return worker(req), nil
		}
		switch steps.Add(1) {
		case 1:
			return background(grandCommand(pid)), nil
		case 2:
			pidSoon(pid)
			failing.Store(true)
			return model.ModelReply{}, model.Errorf(model.CodeInvalid, "模型壞了")
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	grand := pidIn(t, pid)
	w := r.wait("the failed run to leave its command", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Attempts == 1 && len(r.e.JobsRunning("sub:")) == 1
	})
	sub := subAt(w, task.ID, "整理需求")
	heldWhileFailing(t, r, grand, &steps, 2)
	w = r.world()
	if s := w.SubTasks[sub.ID]; s.RunGeneration != sub.RunGeneration || s.Status == enum.StatusProgressing || logCount(s, drainedLine) != 0 {
		t.Fatalf("retried, or said over, while its command was not known to be over: %+v", s)
	}
	failing.Store(false)
	w = r.wait("the retry to hand off", func(w *model.World) bool {
		s := w.SubTasks[sub.ID]
		return s.Status == enum.StatusComplete
	})
	if s := w.SubTasks[sub.ID]; s.RunGeneration != sub.RunGeneration+1 || logCount(s, drainedLine) != 1 {
		t.Fatalf("gen %d (was %d), %d over lines", s.RunGeneration, sub.RunGeneration, logCount(s, drainedLine))
	}
	if got := r.e.JobsRunning("sub:"); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}

// An owner-led step that fails with no retry left is told to the owner, but no writer starts again, whatever the
// owner dispatches, until its commands are known to be over.
func TestOwnerDispatchWaitsForAFailedRunsCommands(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	team := r.world().Teams[r.team.ID]
	if err := r.e.UpdateTeam(team.ID, usecase.TeamPatch{Settings: &model.TeamSettings{TimeoutMin: team.Settings.TimeoutMin, CostLimitUSD: team.Settings.CostLimitUSD, Retries: 0}}); err != nil {
		t.Fatal(err)
	}
	pid := filepath.Join(t.TempDir(), "grand.pid")
	var steps atomic.Int32
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		if laterStep(req) {
			return worker(req), nil
		}
		switch steps.Add(1) {
		case 1:
			return background(grandCommand(pid)), nil
		case 2:
			pidSoon(pid)
			failing.Store(true)
			return model.ModelReply{}, model.Errorf(model.CodeInvalid, "模型壞了")
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	grand := pidIn(t, pid)
	var failed *model.SubTask
	r.wait("the failed run to leave its command", func(w *model.World) bool {
		for _, s := range w.SubTasks {
			if s.TaskID == task.ID && s.Attempts == 1 && len(r.e.JobsRunning("sub:")) == 1 {
				failed = s
				return true
			}
		}
		return false
	})
	heldWhileFailing(t, r, grand, &steps, 2)
	if s := r.world().SubTasks[failed.ID]; s.ExecutionState != model.ExecStopped || logCount(s, drainedLine) != 0 {
		t.Fatalf("%+v", s)
	}
	failing.Store(false)
	r.wait("a run of the step to hand off", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Status == enum.StatusComplete
	})
	if s := r.world().SubTasks[failed.ID]; logCount(s, drainedLine) != 1 {
		t.Fatalf("%d over lines", logCount(s, drainedLine))
	}
}

// A step the owner stops, whose commands cannot be known to be over, is uncertain, not stopped; once the user says
// it stopped, the owner's next writer still waits until the commands are known to be over.
func TestOwnerStopWithCommandsNotKnownOver(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	pid := filepath.Join(t.TempDir(), "grand.pid")
	var steps atomic.Int32
	var stopSub atomic.Value
	stopSub.Store("")
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			if id := stopSub.Swap("").(string); id != "" {
				return ownerCall("stop_step", map[string]any{"sub_id": id, "reason": "停"}), nil
			}
			return autoOwner(req), nil
		}
		if laterStep(req) {
			return worker(req), nil
		}
		if steps.Add(1) == 1 {
			return background(grandCommand(pid)), nil
		}
		if lastIsResult(req) {
			return say("等它跑完"), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	grand := pidIn(t, pid)
	w := r.wait("the step to wait on its command", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning && steps.Load() == 2
	})
	sub := subAt(w, task.ID, "整理需求")
	failing.Store(true)
	stopSub.Store(sub.ID)
	r.tell(task.ID, "stop", "停掉它")
	w = r.wait("uncertain", func(w *model.World) bool { return w.SubTasks[sub.ID].ExecutionState == model.ExecUncertain })
	heldWhileFailing(t, r, grand, &steps, 2)
	w = r.world()
	if strings.Contains(sentText(model.ModelRequest{Messages: r.e.OwnerConversation(task.ID)}), "has stopped.") {
		t.Fatal("the owner was told the step stopped while its command was not known to be over")
	}
	c := w.Tasks[task.ID].Coordination
	i := slices.IndexFunc(c.Questions, func(q model.TaskQuestion) bool { return q.Kind == "recovery" && q.SubID == sub.ID })
	if i < 0 {
		t.Fatalf("%+v", c.Questions)
	}
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "ok", Action: "answer", QuestionID: c.Questions[i].ID, OptionID: "redo", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	heldWhileFailing(t, r, grand, &steps, 2)
	failing.Store(false)
	r.wait("the redo to hand off", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Status == enum.StatusComplete
	})
	if s := r.world().SubTasks[sub.ID]; logCount(s, drainedLine) != 1 {
		t.Fatalf("%d over lines", logCount(s, drainedLine))
	}
}

// A pause whose step's commands cannot be known to be over is not applied, nor said done; once the user says the
// run stopped and resumes, the step starts again only when the commands are known to be over.
func TestPauseWithCommandsNotKnownOver(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	pid := filepath.Join(t.TempDir(), "grand.pid")
	var steps atomic.Int32
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		if laterStep(req) {
			return worker(req), nil
		}
		if steps.Add(1) == 1 {
			return background(grandCommand(pid)), nil
		}
		if lastIsResult(req) {
			return say("等它跑完"), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	grand := pidIn(t, pid)
	w := r.wait("the step to wait on its command", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning && steps.Load() == 2
	})
	sub := subAt(w, task.ID, "整理需求")
	failing.Store(true)
	op, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p", Action: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	w = r.wait("uncertain", func(w *model.World) bool { return w.SubTasks[sub.ID].ExecutionState == model.ExecUncertain })
	heldWhileFailing(t, r, grand, &steps, 2)
	w = r.world()
	if hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "paused" }) {
		t.Fatal("said paused with every run stopped while a command was not known to be over")
	}
	c := w.Tasks[task.ID].Coordination
	if !slices.ContainsFunc(c.Operations, func(o model.TaskOperation) bool { return o.ID == op.ID && o.Status == model.OpUncertain }) {
		t.Fatalf("%+v", c.Operations)
	}
	i := slices.IndexFunc(c.Questions, func(q model.TaskQuestion) bool { return q.Kind == "recovery" })
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "ok", Action: "answer", QuestionID: c.Questions[i].ID, OptionID: "confirmStopped", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	plan, control = versions(r.world().Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "go", Action: "resume", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	heldWhileFailing(t, r, grand, &steps, 2)
	failing.Store(false)
	r.wait("the step to hand off", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Status == enum.StatusComplete
	})
	if s := r.world().SubTasks[sub.ID]; logCount(s, drainedLine) != 1 {
		t.Fatalf("%d over lines", logCount(s, drainedLine))
	}
}

// A step of a task its owner does not lead, retried after a failure, starts again only once the failed run's
// commands are known to be over: not as it fails, before the run has stopped them, nor after, while they cannot be
// looked up.
func TestLegacyRetryWaitsForTheFailedRunsCommands(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	pid := filepath.Join(t.TempDir(), "grand.pid")
	var steps atomic.Int32
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if laterStep(req) {
			return worker(req), nil
		}
		switch steps.Add(1) {
		case 1:
			return background(grandCommand(pid)), nil
		case 2:
			pidSoon(pid)
			failing.Store(true)
			return model.ModelReply{}, model.Errorf(model.CodeInvalid, "模型壞了")
		}
		return worker(req), nil
	})
	task := r.task(r.flow.ID)
	grand := pidIn(t, pid)
	r.wait("the failed run to leave its command", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.Attempts == 1 && len(r.e.JobsRunning("sub:")) == 1
	})
	heldWhileFailing(t, r, grand, &steps, 2)
	if s := subAt(r.world(), task.ID, "整理需求"); s.Status == enum.StatusProgressing {
		t.Fatalf("started again while its command was not known to be over: %+v", s)
	}
	failing.Store(false)
	w := r.wait("the task to finish", stage(task.ID, enum.StageAwaitMerge))
	if s := subAt(w, task.ID, "整理需求"); logCount(s, drainedLine) != 1 || steps.Load() != 3 {
		t.Fatalf("%d over lines, %d calls", logCount(s, drainedLine), steps.Load())
	}
}

// chatWithCommand starts a chat whose reply leaves a background command running, and returns it with the
// command's grandchild.
func chatWithCommand(t *testing.T, r *rig) (*model.Chat, int) {
	t.Helper()
	pid := filepath.Join(t.TempDir(), "grand.pid")
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if lastIsResult(req) {
			return say("在跑"), nil
		}
		return background(grandCommand(pid)), nil
	})
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "跑一下"})
	if err != nil {
		t.Fatal(err)
	}
	grand := pidIn(t, pid)
	r.wait("reply", chatDone(c.ID))
	return c, grand
}

// Deleting a chat whose command cannot be known to be over keeps it known as running, and its output, until it is.
func TestDeletingAChatKeepsCommandsNotKnownOver(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	c, grand := chatWithCommand(t, r)
	out := r.e.OutputRoot(c.ID)
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("no output kept: %v", err)
	}
	asked := len(r.fake.requests())
	failing.Store(true)
	if err := r.e.DeleteChat(c.ID); err != nil {
		t.Fatal(err)
	}
	waitDead(t, grand)
	time.Sleep(settleTime)
	if got := r.e.JobsRunning("chat:"); len(got) != 1 {
		t.Fatalf("forgotten while not known to be over: %v", got)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatal("its output went while the command was not known to be over")
	}
	failing.Store(false)
	for deadline := time.Now().Add(patience); ; time.Sleep(10 * time.Millisecond) {
		_, err := os.Stat(out)
		if len(r.e.JobsRunning("chat:")) == 0 && os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never over once its group could be looked up")
		}
	}
	if n := len(r.fake.requests()); n != asked {
		t.Fatalf("a deleted chat was woken: %d calls, %d before", n, asked)
	}
	if r.world().Chats[c.ID] != nil {
		t.Fatal("the chat came back")
	}
}

// Closing the engine while a chat's command cannot be known to be over keeps it known as running until it is.
func TestClosingKeepsCommandsNotKnownOver(t *testing.T) {
	t.Parallel()
	r, failing := faultyRig(t)
	_, grand := chatWithCommand(t, r)
	failing.Store(true)
	r.e.Close()
	waitDead(t, grand)
	if got := r.e.JobsRunning("chat:"); len(got) != 1 {
		t.Fatalf("forgotten at close while not known to be over: %v", got)
	}
	failing.Store(false)
	for deadline := time.Now().Add(patience); len(r.e.JobsRunning("chat:")) > 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("never over once its group could be looked up")
		}
	}
}
