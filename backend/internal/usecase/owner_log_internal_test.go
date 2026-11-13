package usecase

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

// logDisk keeps documents by kind and id, and counts the documents read one at a time.
type logDisk struct {
	adapter.Store
	rows     map[string][]byte
	reads    int
	failRead bool
}

func (s *logDisk) LoadDoc(_ context.Context, kind, id string) ([]byte, error) {
	s.reads++
	if s.failRead {
		return nil, errors.New("read failed")
	}
	raw, ok := s.rows[docKey(kind, id)]
	if !ok {
		return nil, errors.New("missing document")
	}
	return raw, nil
}

func (s *logDisk) Apply(_ context.Context, up, del []model.Doc, _ []model.SecretChange, _ ...model.SettingsChange) error {
	for _, d := range up {
		s.rows[docKey(d.Kind, d.ID)] = d.Data
	}
	for _, d := range del {
		delete(s.rows, docKey(d.Kind, d.ID))
	}
	return nil
}

func logEngine(t *testing.T) (*Engine, *logDisk, *model.Task) {
	t.Helper()
	disk := &logDisk{rows: map[string][]byte{}}
	e := &Engine{w: model.NewWorld(), store: disk, prev: map[string][]byte{}, dirty: map[string]bool{}, runs: map[string]*run{}, clock: func() float64 { return 1 }}
	task := &model.Task{ID: "t1", Orchestration: model.OrchestrationOwner, Coordination: &model.Coordination{PlanVersion: 1, ControlVersion: 1}}
	e.w.Tasks[task.ID] = task
	return e, disk, task
}

func say(e *Engine, task *model.Task, n int) {
	for range n {
		e.addActivity(task, model.TaskActivity{Kind: "message", From: "user", Text: "line"})
	}
}

func checkSeqs(t *testing.T, all []model.TaskActivity, n int) {
	t.Helper()
	if len(all) != n {
		t.Fatalf("%d entries, want %d", len(all), n)
	}
	for i, a := range all {
		if a.Seq != i+1 || a.ID != "t1-a"+strconv.Itoa(i+1) {
			t.Fatalf("entry %d is %+v", i, a)
		}
	}
}

func TestTaskConversationIsReadWhenNeededAndLetGoWhenSaved(t *testing.T) {
	t.Parallel()
	e, disk, task := logEngine(t)
	say(e, task, tailMost+8)
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	l := e.taskLogs[task.ID]
	if l.loaded || l.acts != nil {
		t.Fatal("an idle conversation stays in memory after it was saved")
	}
	if _, ok := disk.rows[docKey(kindTaskActs, task.ID)]; !ok {
		t.Fatal("the conversation was not saved apart from the log")
	}
	var logged map[string]any
	if err := jsonx.Unmarshal(disk.rows[docKey(kindTaskLog, task.ID)], &logged); err != nil || logged["activities"] != nil {
		t.Fatalf("the log still carries the whole conversation: %v", logged["activities"])
	}
	// adding needs no reading
	say(e, task, 1)
	if disk.reads != 0 {
		t.Fatal("adding an entry read the conversation")
	}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	all, err := e.activities(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkSeqs(t, all, tailMost+9)
	if disk.reads != 1 {
		t.Fatalf("read %d times", disk.reads)
	}
	// while the owner decides it stays
	e.runs[ownerKey(task.ID)] = &run{}
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	if !e.taskLogs[task.ID].loaded {
		t.Fatal("let go while the owner is deciding")
	}
	say(e, task, tailMost) // the tail goes to the conversation's document once it is long
	delete(e.runs, ownerKey(task.ID))
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	// after a restart it reads back whole and in order
	again, _, _ := logEngine(t)
	again.store = disk
	if err := again.loadLog(model.Doc{Kind: kindTaskLog, ID: task.ID, Data: disk.rows[docKey(kindTaskLog, task.ID)]}); err != nil {
		t.Fatal(err)
	}
	again.prev[docKey(kindTaskLog, task.ID)], again.prev[docKey(kindTaskActs, task.ID)] = nil, nil
	all, err = again.activities(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkSeqs(t, all, 2*tailMost+9)
	// a failed read is an error, and nothing is kept of it
	disk.failRead = true
	again.taskLogs[task.ID].acts, again.taskLogs[task.ID].loaded = nil, false
	if _, err := again.activities(task.ID); err == nil || again.taskLogs[task.ID].loaded {
		t.Fatal("a failed read became a conversation")
	}
}

func TestOlderLogsMoveTheirConversationToItsOwnDocument(t *testing.T) {
	t.Parallel()
	e, disk, task := logEngine(t)
	old := map[string]any{"activities": []model.TaskActivity{{ID: "t1-a1", Seq: 1, Kind: "message", Text: "one"}, {ID: "t1-a2", Seq: 2, Kind: "message", Text: "two"}},
		"operations": map[string]any{}, "requests": map[string]any{}, "events": map[string]any{}, "commands": map[string]any{}}
	raw, _ := jsonx.Marshal(old)
	if err := e.loadLog(model.Doc{Kind: kindTaskLog, ID: task.ID, Data: raw}); err != nil {
		t.Fatal(err)
	}
	e.prev[docKey(kindTaskLog, task.ID)] = nil
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	var logged map[string]any
	if err := jsonx.Unmarshal(disk.rows[docKey(kindTaskLog, task.ID)], &logged); err != nil || logged["activities"] != nil {
		t.Fatalf("not moved: %s", disk.rows[docKey(kindTaskLog, task.ID)])
	}
	all, err := e.activities(task.ID)
	if err != nil || len(all) != 2 || all[1].Text != "two" {
		t.Fatalf("%+v %v", all, err)
	}
	say(e, task, 1)
	all, _ = e.activities(task.ID)
	checkSeqs(t, all, 3)
}

func TestContinuingAStoppedRunWaitsForWhatTheCurrentPlanPutsBeforeIt(t *testing.T) {
	t.Parallel()
	e, _, task := logEngine(t)
	task.TeamID = "team"
	task.Coordination.Authorization.ReplicaIDs = []string{"r"}
	e.w.Replicas["r"] = &model.Replica{ID: "r", TeamID: "team"}
	task.Workflow.Nodes = []model.WorkflowNode{{ID: "before", Name: "new prerequisite"}, {ID: "work", Name: "work"}}
	task.Workflow.Edges = []model.WorkflowEdge{{From: "before", To: "work"}}
	s := &model.SubTask{ID: "s", TaskID: task.ID, NodeID: "work", ReplicaID: ptr("r"), Status: enum.StatusTodo, ExecutionState: model.ExecStopped, Validity: model.ValidCurrent, PlanVersion: 1}
	e.w.SubTasks[s.ID] = s
	task.Coordination.PlanVersion = 2 // the step it now waits for came in after it stopped

	if _, err := e.continueRun(task, s.ID, "go on"); err == nil {
		t.Fatalf("went on without the new prerequisite: %+v", s)
	}
	if s.ExecutionState != model.ExecStopped || s.PlanVersion != 1 || len(s.UpstreamIDs) != 0 {
		t.Fatalf("a refused continue changed the run: %+v", s)
	}

	b := &model.SubTask{ID: "b", TaskID: task.ID, NodeID: "before", ReplicaID: ptr("r"), Status: enum.StatusComplete, OwnerReview: model.ReviewAccepted, Validity: model.ValidCurrent}
	e.w.SubTasks[b.ID] = b
	if _, err := e.continueRun(task, s.ID, "go on"); err != nil {
		t.Fatal(err)
	}
	if s.ExecutionState != model.ExecQueued || s.PlanVersion != 2 || len(s.UpstreamIDs) != 1 || s.UpstreamIDs[0] != b.ID {
		t.Fatalf("continued run = %+v, want queued on plan 2 building on %s", s, b.ID)
	}
	// sending the prerequisite back now reaches the run that went on with it
	if deps := e.dependents(task, b); len(deps) != 1 || deps[0] != s.ID {
		t.Fatalf("dependents of the prerequisite = %v, want [%s]", deps, s.ID)
	}
}

func TestTheFailureGuardStopsQueuedWorkAndTheOwnerDispatching(t *testing.T) {
	t.Parallel()
	e, _, task := logEngine(t)
	task.TeamID, task.Stage = "team", enum.StageRunning
	task.Coordination.StartedAt = ptr(float64(1))
	task.Coordination.Authorization.ReplicaIDs = []string{"r"}
	e.w.Teams["team"] = &model.Team{ID: "team", Settings: model.TeamSettings{CostLimitUSD: 100}}
	e.w.Replicas["r"] = &model.Replica{ID: "r", TeamID: "team", Name: "worker", BlueprintID: "missing"}
	for i := 1; i <= maxOwnerFailures+1; i++ {
		id := strconv.Itoa(i)
		task.Workflow.Nodes = append(task.Workflow.Nodes, model.WorkflowNode{ID: id, Name: id, Kind: enum.NodeWork})
		e.w.SubTasks[id] = &model.SubTask{ID: id, TaskID: task.ID, NodeID: id, ReplicaID: ptr("r"), Status: enum.StatusTodo, ExecutionState: model.ExecQueued, Validity: model.ValidCurrent}
	}
	// independent branches were queued, and their employee's blueprint is gone: every start fails
	e.dispatchOwner(task)
	if task.Coordination.BlockedReason != "loop" {
		t.Fatal("the failure guard never engaged")
	}
	if n := e.taskLogs[task.ID].Failures; n != maxOwnerFailures {
		t.Fatalf("%d runs failed, want the guard to stop at %d", n, maxOwnerFailures)
	}
	last := e.w.SubTasks[strconv.Itoa(maxOwnerFailures+1)]
	if last.ExecutionState != model.ExecQueued {
		t.Fatalf("the run left in the queue = %+v, want it still queued", last)
	}
	if e.dispatchOwner(task) || last.ExecutionState != model.ExecQueued {
		t.Fatal("queued work started again before the user answered")
	}
	if err := e.mayDispatch(task); err == nil {
		t.Fatal("the owner may still dispatch while the guard waits for the user")
	}
}
