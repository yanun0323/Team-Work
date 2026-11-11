package usecase

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/model"
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
