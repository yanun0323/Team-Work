package usecase

import (
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestOnlyARunAtWorkCanBeToldSomethingAndTheRestSayWhatFits(t *testing.T) {
	e, _, task := logEngine(t)
	task.Workflow = model.Workflow{Nodes: []model.WorkflowNode{{ID: "w", Kind: enum.NodeWork, Name: "做"}, {ID: "m", Kind: enum.NodeTalk, Name: "會議"}}}
	at := func(fn func(s *model.SubTask)) *model.SubTask {
		s := &model.SubTask{ID: "sub-1", TaskID: task.ID, NodeID: "w", Status: enum.StatusProgressing, ExecutionState: model.ExecRunning}
		e.runs = map[string]*run{s.ID: {}}
		fn(s)
		return s
	}
	if err := e.mayMessage(task, at(func(*model.SubTask) {})); err != nil {
		t.Fatalf("a run at work was refused: %v", err)
	}
	for what, c := range map[string]struct {
		fn   func(s *model.SubTask)
		tool string
	}{
		"handed off": {func(s *model.SubTask) { s.Status, s.ExecutionState = enum.StatusComplete, "" }, "return_step"},
		"asking":     {func(s *model.SubTask) { s.Status, s.ExecutionState = enum.StatusReview, "" }, "answer_employee"},
		"stopped":    {func(s *model.SubTask) { s.Status, s.ExecutionState = enum.StatusTodo, model.ExecStopped }, "dispatch_step"},
		"stopping":   {func(s *model.SubTask) { s.Status, s.ExecutionState = enum.StatusTodo, model.ExecStopping }, "dispatch_step"},
		"uncertain":  {func(s *model.SubTask) { s.Status, s.ExecutionState = enum.StatusTodo, model.ExecUncertain }, "dispatch_step"},
		"queued": {func(s *model.SubTask) {
			s.Status, s.ExecutionState = enum.StatusTodo, model.ExecQueued
			e.runs = map[string]*run{}
		}, "等它開始"},
		"a meeting":  {func(s *model.SubTask) { s.NodeID = "m" }, "會議"},
		"superseded": {func(s *model.SubTask) { s.Validity = model.ValidSuperseded }, "取代"},
	} {
		err := e.mayMessage(task, at(c.fn))
		if err == nil || !strings.Contains(err.Error(), c.tool) {
			t.Errorf("%s: %v", what, err)
		}
	}
}

func TestWhatARunWasToldIsKeptUntilItIsReadAndThenReadOnce(t *testing.T) {
	e, _, task := logEngine(t)
	e.w.Conversations = map[string][]model.Message{"sub-1": {userText("start")}}
	s := &model.SubTask{ID: "sub-1", TaskID: task.ID, NodeID: "w"}
	other := &model.SubTask{ID: "sub-2", TaskID: task.ID, NodeID: "w"}
	l := e.editLog(task.ID)
	l.Steers = []pendingSteer{{SubID: "sub-1", Text: "一"}, {SubID: "sub-2", Text: "別人的"}, {SubID: "sub-1", Text: "二"}}
	// as saved and read back
	raw, err := jsonx.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.loadLog(model.Doc{ID: task.ID, Data: raw}); err != nil {
		t.Fatal(err)
	}
	if e.unreadSteers(task, s.ID) != 2 || e.unreadSteers(task, other.ID) != 1 {
		t.Fatalf("%+v", e.logOf(task.ID).Steers)
	}
	got := e.takeSteers(task, s)
	if len(got) != 2 || !strings.HasSuffix(got[0].Content[0].Text, "一") || !strings.HasSuffix(got[1].Content[0].Text, "二") || !strings.HasPrefix(got[0].Content[0].Text, steerSays) {
		t.Fatalf("%+v", got)
	}
	if conv := e.w.Conversations[s.ID]; len(conv) != 3 || !e.dirty[s.ID] {
		t.Fatalf("%+v", conv)
	}
	if again := e.takeSteers(task, s); again != nil || e.unreadSteers(task, other.ID) != 1 {
		t.Fatalf("read twice: %+v", again)
	}
}
