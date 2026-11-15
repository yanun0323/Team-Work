package usecase

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

// A command from another run of the same task blocks both commit tools and merge while its group cannot be
// confirmed empty. Active parallel branches and different tasks are not mistaken for abandoned writers.
func TestUnconfirmedTreeCommandsBlockCommitToolsAndMerge(t *testing.T) {
	e := codeModeEngine()
	e.jobs = &tools.Jobs{}
	var failing atomic.Bool
	failing.Store(true)
	e.jobs.FailLookups(&failing, 100*time.Millisecond)
	done := make(chan struct{})
	var changes atomic.Int32
	e.jobs.Done = func(string) { close(done) }
	t.Cleanup(func() { failing.Store(false); e.jobs.Close() })
	dir := t.TempDir()
	scope := "sub:old#1"
	j, err := e.jobs.Start(context.Background(), scope, dir, "sleep 60", 0, dir, func() { changes.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	old := &run{}
	e.drains = map[string]*drain{scope: {task: "task", sub: "old", r: old}}
	e.runs["old"] = old
	if e.treeBusy("task") {
		t.Fatal("active parallel branch treated as an abandoned writer")
	}
	delete(e.runs, "old")
	if !e.treeBusy("task") || e.treeBusy("other-task") {
		t.Fatal("gate does not follow the task of the stopped run")
	}
	if left := e.jobs.End(scope); !slices.Equal(left, []string{j.ID}) {
		t.Fatalf("End forgot %s: %v", j.ID, left)
	}
	e.drains[scope].exited = true
	if e.drained(scope) {
		t.Fatal("released an unconfirmed scope")
	}
	if changes.Load() != 0 {
		t.Fatal("Changed before confirmation")
	}
	select {
	case <-done:
		t.Fatal("Done before confirmation")
	default:
	}

	// A new sub, not just the old one, cannot commit this work tree. Nil git makes any accidental commit visible.
	in := subRun{taskID: "task", subID: "new"}
	for name, tool := range map[string]func(context.Context, string, json.RawMessage) model.ToolResult{
		"submit_handoff": e.submitHandoff(in), "send_back": e.sendBackTool(in),
	} {
		r := tool(context.Background(), dir, json.RawMessage(`{"goal":"check","headline":"check","commit_message":"test","reason":"check"}`))
		if !r.IsError || !strings.Contains(r.Text, j.ID) {
			t.Fatalf("%s did not refuse with the job id: %+v", name, r)
		}
	}
	task := &model.Task{ID: "task", Merge: &model.Merge{}}
	e.stepMerge(task)
	if task.Merge.StartedAt != nil {
		t.Fatal("merge started before confirmation")
	}

	failing.Store(false)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("never completed after lookup recovered")
	}
	if changes.Load() != 1 {
		t.Fatalf("Changed %d times", changes.Load())
	}
	if e.treeBusy("task") || !e.drained(scope) || len(e.drains) != 0 {
		t.Fatal("gate did not release after confirmation")
	}
	if e.drained(scope) {
		t.Fatal("released the same drain twice")
	}
	if refused := e.jobsRunning(in); refused != nil {
		t.Fatalf("commit gate stayed closed: %+v", refused)
	}
}
