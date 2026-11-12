package usecase_test

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// ---------- a fake owner ----------

var ownerCallSeq atomic.Int64

// ownerCall is a tool call with an id of its own, as a provider gives each call.
func ownerCall(name string, args any) model.ModelReply {
	r := call(name, args)
	r.Content[0].ID = fmt.Sprintf("%s-%d", name, ownerCallSeq.Add(1))
	return r
}

func isOwner(req model.ModelRequest) bool {
	return strings.Contains(req.System, "You are the owner of a task")
}

type runView struct{ id, node, status, rest string }

// ownerView is the task as the owner's read_task tells it.
type ownerView struct {
	stage     string
	paused    bool
	nodes     []string
	from      map[string][]string
	runs      []runView
	questions []string // "id audience kind"
}

var (
	runLine      = regexp.MustCompile(`^- (sub-\d+) step (\S+) by [^:]*: (\w+)(.*)$`)
	nodeLine     = regexp.MustCompile(`^- (\S+) "`)
	edgeLine     = regexp.MustCompile(`^- (\S+) -> (\S+)`)
	questionLine = regexp.MustCompile(`^- (\S+) for the (\w+) \((\w+)\)`)
)

func readView(text string) ownerView {
	v := ownerView{from: map[string][]string{}}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "Stage: ") {
			v.stage, _, _ = strings.Cut(strings.TrimPrefix(line, "Stage: "), ",")
			v.paused = strings.Contains(line, "PAUSED")
		}
		if strings.HasPrefix(line, "#") {
			section = line
			continue
		}
		switch section {
		case "## Plan":
			if m := edgeLine.FindStringSubmatch(line); m != nil {
				v.from[m[2]] = append(v.from[m[2]], m[1])
			} else if m := nodeLine.FindStringSubmatch(line); m != nil {
				v.nodes = append(v.nodes, m[1])
			}
		case "## Step runs":
			if m := runLine.FindStringSubmatch(line); m != nil {
				v.runs = append(v.runs, runView{m[1], m[2], m[3], m[4]})
			}
		case "## Open questions":
			if m := questionLine.FindStringSubmatch(line); m != nil {
				v.questions = append(v.questions, m[1]+" "+m[2]+" "+m[3])
			}
		}
	}
	return v
}

func (r runView) counts() bool {
	return !strings.Contains(r.rest, "superseded") && !strings.Contains(r.rest, "cancelled")
}

func (v ownerView) accepted(node string) string {
	for _, r := range v.runs {
		if r.node == node && r.counts() && strings.Contains(r.rest, "review accepted") && !strings.Contains(r.rest, "needsRevalidation") {
			return r.id
		}
	}
	return ""
}

// autoOwner leads a task the plain way: it accepts every handoff and dispatches each step once the steps before it
// are accepted, then says the task is done. After each change it reads the task again.
func autoOwner(req model.ModelRequest) model.ModelReply {
	state := req.Messages[0].Content[0].Text
	last := req.Messages[len(req.Messages)-1]
	if len(last.Content) > 0 && last.Content[0].Type == enum.BlockToolResult {
		b := last.Content[len(last.Content)-1]
		if b.IsError {
			return say("could not: " + b.Text)
		}
		if b.Name != "read_task" {
			return ownerCall("read_task", map[string]any{})
		}
		state = b.Text
	}
	v := readView(state)
	for _, r := range v.runs {
		if r.status == "complete" && r.counts() && strings.Contains(r.rest, "review pending") {
			return ownerCall("review_step", map[string]any{"sub_id": r.id, "decision": "accept"})
		}
	}
	if v.paused || v.stage != "running" {
		return say("waiting for the user")
	}
	for _, r := range v.runs {
		if r.counts() && r.status != "complete" && !strings.Contains(r.rest, "run stopped") {
			return say("waiting for the work")
		}
	}
	for _, node := range v.nodes {
		if strings.HasPrefix(node, "meeting-") || v.accepted(node) != "" {
			continue
		}
		upstream := []string{}
		ready := true
		for _, from := range v.from[node] {
			id := v.accepted(from)
			ready = ready && id != ""
			upstream = append(upstream, id)
		}
		if ready {
			return ownerCall("dispatch_step", map[string]any{"node_id": node, "instructions": "Do the step " + node, "upstream_ids": upstream})
		}
	}
	return ownerCall("submit_complete", map[string]any{"summary": "All done."})
}

// worker hands off at once.
func worker(model.ModelRequest) model.ModelReply { return call("submit_handoff", handoff) }

// leading has the owner lead and every step do what work does.
func leading(work func(model.ModelRequest) model.ModelReply) func(model.ModelRequest) (model.ModelReply, error) {
	return func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		return work(req), nil
	}
}

func (r *rig) setReply(fn func(model.ModelRequest) (model.ModelReply, error)) {
	r.fake.mu.Lock()
	r.fake.reply = fn
	r.fake.mu.Unlock()
}

// ownerTask makes a task its owner leads and starts it.
func (r *rig) ownerTask(wfID string) *model.Task {
	r.t.Helper()
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", Description: "說明", WorkflowID: wfID, OwnerID: &r.owner.ID})
	if err != nil {
		r.t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		r.t.Fatal(err)
	}
	return r.world().Tasks[task.ID]
}

func (r *rig) activity(taskID string) []model.TaskActivity {
	r.t.Helper()
	page, err := r.e.TaskActivity(taskID, 0, 100, "")
	if err != nil {
		r.t.Fatal(err)
	}
	return page.Items
}

func hasActivity(items []model.TaskActivity, ok func(model.TaskActivity) bool) bool {
	return slices.ContainsFunc(items, ok)
}

func versions(t *model.Task) (*int, *int) {
	return &t.Coordination.PlanVersion, &t.Coordination.ControlVersion
}

func ownerRequests(r *rig) []model.ModelRequest {
	return slices.DeleteFunc(r.fake.requests(), func(req model.ModelRequest) bool { return !isOwner(req) })
}

// ---------- tests ----------

func TestOwnerLedTaskNeedsAnOwnerToStartAndDispatchesNothingBefore(t *testing.T) {
	r := newRig(t, leading(worker))
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "沒負責人", WorkflowID: r.flow.ID})
	if err != nil {
		t.Fatal(err)
	}
	if task.Orchestration != model.OrchestrationOwner || task.Coordination == nil || task.Coordination.PlanVersion != 1 || task.Coordination.StartedAt != nil {
		t.Fatalf("%+v", task)
	}
	if !slices.Contains(task.Coordination.Authorization.ReplicaIDs, r.owner.ID) {
		t.Fatalf("the staff the user picked are not allowed: %+v", task.Coordination.Authorization)
	}
	if err := r.e.ResumeTask(task.ID); err == nil || !strings.Contains(err.Error(), "負責人") {
		t.Fatalf("started without an owner: %v", err)
	}
	for _, s := range r.world().SubTasks {
		if s.TaskID == task.ID {
			t.Fatalf("a step was made before the task started: %+v", s)
		}
	}
	if err := r.e.UpdateTask(task.ID, usecase.TaskPatch{OwnerID: &r.owner.ID}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
}

func TestOwnerDispatchesEmployeesOnOtherModelsAndGatesEveryHandoff(t *testing.T) {
	r := newRig(t, leading(worker))
	ctx := t.Context()
	r.fake.mu.Lock()
	r.fake.models = []model.ModelSpec{{ID: "other"}}
	r.fake.mu.Unlock()
	if _, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "q", Kind: enum.ProviderCompatible, Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-other-9999"},
		Prices: map[string]model.ModelPrice{"other": {Input: 1, Output: 1}}}); err != nil {
		t.Fatal(err)
	}
	bob, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Bob", Model: "other"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "加功能", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID,
		Staff: map[string][]string{"end": {bob.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	end := subAt(w, task.ID, "驗收")
	start := subAt(w, task.ID, "整理需求")
	if end == nil || *end.ReplicaID != bob.ID || end.OwnerReview != model.ReviewAccepted || start.OwnerReview != model.ReviewAccepted {
		t.Fatalf("start %+v\nend %+v", start, end)
	}
	if !slices.Equal(end.UpstreamIDs, []string{start.ID}) || len(start.RoutedTo) != 0 {
		t.Fatalf("the flow routed by itself: %+v %+v", start, end)
	}
	if end.Instruction != "Do the step end" || end.PlanVersion != 1 {
		t.Fatalf("%+v", end)
	}
	models := map[string]string{}
	for _, req := range r.fake.requests() {
		switch {
		case isOwner(req):
			models["owner"] = req.Model
		case stepOf(req) == "Acceptance review":
			models["end"] = req.Model
			if !strings.Contains(req.Messages[0].Content[0].Text, "# Instructions from Ada, the task owner\nDo the step end") {
				t.Fatalf("the step was not told the owner's instructions: %s", req.Messages[0].Content[0].Text)
			}
		}
	}
	if models["owner"] != "fake" || models["end"] != "other" {
		t.Fatalf("%v", models)
	}
	items := r.activity(task.ID)
	for _, want := range []func(model.TaskActivity) bool{
		func(a model.TaskActivity) bool { return a.Key == "started" },
		func(a model.TaskActivity) bool {
			return a.Key == "dispatched" && a.SubID == end.ID && a.Args["step"] == "驗收" && a.Args["name"] == "Bob" && a.Args["owner"] == "Ada"
		},
		func(a model.TaskActivity) bool {
			return a.Kind == "handoff" && a.By == bob.ID && a.Name == "Bob" && a.SubID == end.ID && a.NodeID == "end"
		},
		func(a model.TaskActivity) bool { return a.Key == "accepted" && a.SubID == end.ID },
		func(a model.TaskActivity) bool {
			return a.Kind == "message" && a.By == r.owner.ID && a.Text == "All done."
		},
	} {
		if !hasActivity(items, want) {
			t.Fatalf("missing from the conversation: %+v", items)
		}
	}
	got := w.Tasks[task.ID]
	if got.Coordination.OwnerCostUSD <= 0 || got.Coordination.OwnerTokens <= 0 {
		t.Fatalf("the owner's use was not counted: %+v", got.Coordination)
	}
	// merging waits for the owner's decision to end
	r.wait("owner idle", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle })
	if err := r.e.MergeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("done", stage(task.ID, enum.StageDone))
	if r.world().Workflows[r.flow.ID].Nodes[1].ReplicaIDs[0] != r.owner.ID {
		t.Fatal("the shared flow changed")
	}
}

func TestHandoffWaitsForTheOwnerAndIsNotRoutedByTheFlow(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		// this owner only ever starts the first step, and says so
		if len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]") {
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		}
		return say("noted"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the handoff to be seen", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.OwnerReview == model.ReviewPending && w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle
	})
	if subAt(w, task.ID, "驗收") != nil || w.Tasks[task.ID].Stage != enum.StageRunning {
		t.Fatalf("the next step started without the owner: %+v", w.Tasks[task.ID])
	}
	// each decision starts from the brief alone
	var woken []model.ModelRequest
	for _, req := range ownerRequests(r) {
		if len(req.Messages) == 1 {
			woken = append(woken, req)
		}
	}
	if len(woken) != 2 || !strings.Contains(woken[1].Messages[0].Content[0].Text, "[employee_handoff]") {
		t.Fatalf("the owner was not woken once by the handoff: %d", len(woken))
	}
	if err := r.e.MergeTask(task.ID); err == nil {
		t.Fatal("merged a task the owner did not complete")
	}
}

func TestUserMessageReachesTheOwnerOnceAndIsAppliedWhenTakenUp(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			if strings.Contains(req.Messages[0].Content[0].Text, "改用 Go") {
				return say("收到，改用 Go"), nil
			}
			return say("待命"), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("owner idle", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle })
	in := usecase.TaskMessage{RequestID: "req-1", Text: "改用 Go"}
	first, err := r.e.SayToOwner(task.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if first.Operation.Status != model.OpReceived || first.Activity.From != "user" || first.Operation.MessageID != first.Activity.ID {
		t.Fatalf("%+v", first)
	}
	again, err := r.e.SayToOwner(task.ID, in)
	if err != nil || again.Operation.ID != first.Operation.ID || again.Activity.ID != first.Activity.ID {
		t.Fatalf("a request sent again was not the same: %+v %v", again, err)
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "req-1", Text: "別的"}); err == nil || !strings.Contains(err.Error(), "requestId") {
		t.Fatalf("a request id used for something else was taken: %v", err)
	}
	for _, bad := range []usecase.TaskMessage{{RequestID: "req-2", Text: "x", Mentions: []string{r.owner.ID}}, {RequestID: "req-3", Text: "x", SubID: "sub-1"}, {RequestID: "req-4"}, {Text: "x"}} {
		if _, err := r.e.SayToOwner(task.ID, bad); err == nil {
			t.Fatalf("taken: %+v", bad)
		}
	}
	r.wait("applied", func(w *model.World) bool {
		for _, op := range w.Tasks[task.ID].Coordination.Operations {
			if op.ID == first.Operation.ID {
				return op.Status == model.OpApplied
			}
		}
		return false
	})
	items := r.activity(task.ID)
	users := 0
	for _, a := range items {
		if a.From == "user" {
			users++
		}
	}
	if users != 1 || !hasActivity(items, func(a model.TaskActivity) bool { return a.By == r.owner.ID && a.Text == "收到，改用 Go" }) {
		t.Fatalf("%+v", items)
	}
	woken := 0
	for _, req := range ownerRequests(r) {
		if strings.Contains(req.Messages[0].Content[0].Text, "改用 Go") && len(req.Messages) == 1 {
			woken++
		}
	}
	if woken != 1 {
		t.Fatalf("the owner was woken %d times by one message", woken)
	}
	op, err := r.e.TaskOperation(task.ID, first.Operation.ID)
	if err != nil || op.Status != model.OpApplied {
		t.Fatalf("%+v %v", op, err)
	}
	// the conversation by page
	page, err := r.e.TaskActivity(task.ID, 0, 1, "")
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.Total != len(items) {
		t.Fatalf("%+v %v", page, err)
	}
	older, err := r.e.TaskActivity(task.ID, page.Items[0].Seq, 100, page.Version)
	if err != nil || len(older.Items) != len(items)-1 || older.Items[len(older.Items)-1].Seq != page.Items[0].Seq-1 {
		t.Fatalf("%+v %v", older, err)
	}
	if _, err := r.e.TaskActivity(task.ID, 0, 10, "999"); err == nil {
		t.Fatal("a stale version was read")
	}
	if _, err := r.e.TaskActivity(task.ID, 0, 101, ""); err == nil {
		t.Fatal("a page larger than allowed was read")
	}
	if a, err := r.e.TaskActivityEntry(task.ID, first.Activity.ID); err != nil || a.Text != "改用 Go" {
		t.Fatalf("%+v %v", a, err)
	}
}

func TestUserWritingMidDecisionStopsItsStaleChanges(t *testing.T) {
	var r *rig
	var taskID string
	wrote := false
	r = newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		if !wrote {
			// the user writes while the owner is deciding: what the owner decided before it no longer goes
			wrote = true
			go func() { _, _ = r.e.SayToOwner(taskID, usecase.TaskMessage{RequestID: "mid", Text: "先別動"}) }()
			time.Sleep(200 * time.Millisecond)
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		}
		return say("等你"), nil
	})
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	taskID = task.ID
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	w := r.wait("the next decision", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return len(ownerRequests(r)) >= 2 && c.OwnerState == model.OwnerIdle
	})
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID {
			t.Fatalf("a stale decision dispatched: %+v", s)
		}
	}
	second := ownerRequests(r)[1].Messages[0].Content[0].Text
	if !strings.Contains(second, "[task_started]") || !strings.Contains(second, "先別動") {
		t.Fatalf("the events were not taken up together: %s", second)
	}
}

func TestPauseStopsRunsAtOnceAndNothingStartsUntilResume(t *testing.T) {
	r := newRig(t, leading(func(req model.ModelRequest) model.ModelReply {
		if !lastIsResult(req) && stepOf(req) == "Clarify requirements" {
			return call("run_command", map[string]any{"command": "sleep 30"})
		}
		return worker(req)
	}))
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning && len(s.Log) > 2
	})
	sub := subAt(w, task.ID, "整理需求")
	op, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p1", Action: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	if op.Kind != "pause" || op.Status == model.OpReceived || !slices.Contains(op.AffectedSubIDs, sub.ID) {
		t.Fatalf("%+v", op)
	}
	w = r.wait("stopped", func(w *model.World) bool {
		s := w.SubTasks[sub.ID]
		for _, o := range w.Tasks[task.ID].Coordination.Operations {
			if o.ID == op.ID && o.Status == model.OpApplied {
				return s.ExecutionState == model.ExecStopped
			}
		}
		return false
	})
	if !w.Tasks[task.ID].Paused || w.SubTasks[sub.ID].Status != enum.StatusTodo {
		t.Fatalf("%+v", w.SubTasks[sub.ID])
	}
	// the same pause again is the same operation
	if again, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p1", Action: "pause"}); err != nil || again.ID != op.ID {
		t.Fatalf("%+v %v", again, err)
	}
	// talking goes on while paused, but nothing is dispatched
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "m1", Text: "先討論"}); err != nil {
		t.Fatal(err)
	}
	r.wait("the owner to take it up", func(w *model.World) bool {
		return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle && hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Text == "waiting for the user" })
	})
	time.Sleep(100 * time.Millisecond)
	w = r.world()
	if s := w.SubTasks[sub.ID]; s.ExecutionState != model.ExecStopped || s.Status != enum.StatusTodo {
		t.Fatalf("work went on while paused: %+v", s)
	}
	plan, control := versions(w.Tasks[task.ID])
	stale := *control - 1
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "r0", Action: "resume", PlanVersion: plan, ControlVersion: &stale}); err == nil {
		t.Fatal("resumed from a stale screen")
	}
	// the run goes on where it stopped once the user resumes
	r.setReply(leading(worker))
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "r1", Action: "resume", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if r.world().SubTasks[sub.ID].Status != enum.StatusComplete {
		t.Fatal("the stopped run was not the one to go on")
	}
}

func TestReturnKeepsHistoryAndMarksWhatWasBuiltOnIt(t *testing.T) {
	r := newRig(t, leading(worker))
	task := r.ownerTask(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	start, end := subAt(w, task.ID, "整理需求"), subAt(w, task.ID, "驗收")
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "b0", Action: "return", SubID: start.ID, PlanVersion: plan, ControlVersion: control}); err == nil {
		t.Fatal("returned without a reason")
	}
	op, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "b1", Action: "return", SubID: start.ID, Reason: "需求漏了", PlanVersion: plan, ControlVersion: control})
	if err != nil {
		t.Fatal(err)
	}
	w = r.wait("returned", func(w *model.World) bool {
		for _, o := range w.Tasks[task.ID].Coordination.Operations {
			if o.ID == op.ID {
				return o.Status == model.OpApplied
			}
		}
		return false
	})
	got := w.Tasks[task.ID]
	if !got.Paused || got.Stage != enum.StageRunning {
		t.Fatalf("%+v", got)
	}
	if s := w.SubTasks[start.ID]; s == nil || s.Validity != model.ValidSuperseded || s.Handoff == nil {
		t.Fatalf("the returned run was not kept: %+v", s)
	}
	if s := w.SubTasks[end.ID]; s == nil || s.Validity != model.ValidNeedsRevalidation {
		t.Fatalf("what was built on it was not marked: %+v", s)
	}
	var redo *model.SubTask
	for _, s := range w.SubTasks {
		if s.Rework != nil && s.Rework.From == start.ID {
			redo = s
		}
	}
	if redo == nil || redo.NodeID != "start" || redo.Rework.Reason != "需求漏了" || redo.Status != enum.StatusTodo || redo.StartedAt != nil {
		t.Fatalf("%+v", redo)
	}
	if err := r.e.MergeTask(task.ID); err == nil {
		t.Fatal("merged with work to check again")
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("redone", func(w *model.World) bool {
		s := w.SubTasks[redo.ID]
		return s.Status == enum.StatusComplete && s.OwnerReview == model.ReviewAccepted
	})
}

// A redo starts a conversation of its own, so it is told what its last attempt handed off and to fix only what the
// reason names, not to start over.
func TestRedoIsToldItsLastAttempt(t *testing.T) {
	r := newRig(t, leading(func(req model.ModelRequest) model.ModelReply {
		return call("submit_handoff", map[string]any{"goal": "寫出需求", "done": []string{"列了三條驗收"}, "open": []string{"效能未測"},
			"headline": "h", "did": []string{"x"}, "commit_message": "chore: step"})
	}))
	task := r.ownerTask(r.flow.ID)
	w := r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	start := subAt(w, task.ID, "整理需求")
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "b1", Action: "return", SubID: start.ID, Reason: "需求漏了", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	r.wait("paused", func(w *model.World) bool { return w.Tasks[task.ID].Paused })
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("redone", func(w *model.World) bool {
		for _, s := range w.SubTasks {
			if s.Rework != nil && s.Rework.From == start.ID {
				return s.Status == enum.StatusComplete
			}
		}
		return false
	})
	var first string
	for _, req := range r.fake.requests() {
		if !isOwner(req) && strings.Contains(req.Messages[0].Content[0].Text, "需求漏了") {
			first = req.Messages[0].Content[0].Text
			break
		}
	}
	for _, want := range []string{"# This step was sent back\nReason: 需求漏了", "# Your last attempt at this step (" + start.ID + ")", "Goal: 寫出需求",
		"Done:\n- 列了三條驗收", "Open:\n- 效能未測", "already in the working tree"} {
		if !strings.Contains(first, want) {
			t.Fatalf("the redo was not told %q:\n%s", want, first)
		}
	}
}

// Every step of an owner-led task can read any run of its own task in full, so a reviewer finds earlier handoffs
// without the owner pasting them; a run of another task stays out of reach.
func TestStepsReadRunsOfTheirOwnTask(t *testing.T) {
	r := newRig(t, leading(worker))
	other := r.ownerTask(r.flow.ID)
	w := r.wait("other done", stage(other.ID, enum.StageAwaitMerge))
	outside := subAt(w, other.ID, "整理需求").ID
	var inside string
	var results []string
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		if stepOf(req) == "Clarify requirements" {
			return worker(req), nil
		}
		if !slices.Contains(toolNames(req), "read_step") {
			t.Errorf("no read_step: %v", toolNames(req))
			return worker(req), nil
		}
		var got []string
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockToolResult && b.Name == "read_step" {
					got = append(got, b.Text)
				}
			}
		}
		switch len(got) {
		case 0:
			if m := regexp.MustCompile(`# Handoff from "[^"]+" \((sub-\d+)\)`).FindStringSubmatch(req.Messages[0].Content[0].Text); m != nil {
				inside = m[1]
			}
			return ownerCall("read_step", map[string]any{"sub_id": inside}), nil
		case 1:
			return ownerCall("read_step", map[string]any{"sub_id": outside}), nil
		}
		results = got
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if inside == "" || len(results) != 2 {
		t.Fatalf("%q %q", inside, results)
	}
	if !strings.Contains(results[0], "Step run "+inside) || !strings.Contains(results[0], `"goal":"g"`) {
		t.Fatalf("the run of its own task was not read: %s", results[0])
	}
	if !strings.Contains(results[1], "no step run "+outside) {
		t.Fatalf("a run of another task was read: %s", results[1])
	}
}

func TestQuestionsOnlyTheUserAnswersStayUntilAnswered(t *testing.T) {
	asked := false
	r := newRig(t, leading(func(req model.ModelRequest) model.ModelReply {
		if !asked {
			asked = true
			return call("ask_user", map[string]any{"prompt": "用哪個？", "options": []string{"A", "B"}})
		}
		return worker(req)
	}))
	task := r.ownerTask(r.flow.ID)
	w := r.wait("question", func(w *model.World) bool { return len(w.Tasks[task.ID].Coordination.Questions) == 1 })
	q := w.Tasks[task.ID].Coordination.Questions[0]
	if q.Audience != "user" || q.SubID == "" || q.Prompt != "用哪個？" || len(q.Options) != 2 || q.ActivityID == "" {
		t.Fatalf("%+v", q)
	}
	if err := r.e.ResolveReview(q.SubID, "opt1", ""); err == nil {
		t.Fatal("answered outside the task's conversation")
	}
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "a0", Action: "answer", QuestionID: q.ID, OptionID: "nope", PlanVersion: plan, ControlVersion: control}); err == nil {
		t.Fatal("an option that does not exist was taken")
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "a1", Action: "answer", QuestionID: q.ID, OptionID: "opt1", Note: "快", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "a2", Action: "answer", QuestionID: q.ID, OptionID: "opt1", PlanVersion: plan, ControlVersion: control}); err == nil {
		t.Fatal("answered twice")
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	found := false
	for _, req := range r.fake.requests() {
		for _, m := range req.Messages {
			for _, b := range m.Content {
				found = found || (b.Type == enum.BlockToolResult && b.Name == "ask_user" && strings.Contains(b.Text, "B") && strings.Contains(b.Text, "快"))
			}
		}
	}
	if !found {
		t.Fatal("the step did not get the answer")
	}
}

func TestEmployeesAskTheOwnerWhoAnswers(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			brief := req.Messages[0].Content[0].Text
			last := req.Messages[len(req.Messages)-1]
			if len(req.Messages) == 1 && strings.Contains(brief, "[employee_question]") {
				id := regexp.MustCompile(`asks you \((\S+)\)`).FindStringSubmatch(brief)[1]
				return ownerCall("answer_employee", map[string]any{"question_id": id, "answer": "用 B"}), nil
			}
			if len(req.Messages) > 1 && last.Content[0].Name == "answer_employee" {
				return say("answered"), nil
			}
			return autoOwner(req), nil
		}
		if !strings.Contains(fmt.Sprint(req.Messages), "The task owner answered") {
			for _, s := range req.Tools {
				if s.Name == "ask_owner" {
					return call("ask_owner", map[string]any{"question": "A 還是 B？"}), nil
				}
			}
			return say("no ask_owner"), nil
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	items := r.activity(task.ID)
	if !hasActivity(items, func(a model.TaskActivity) bool {
		return a.Kind == "question" && a.Text == "A 還是 B？" && a.QuestionID != ""
	}) ||
		!hasActivity(items, func(a model.TaskActivity) bool { return a.Kind == "message" && a.Text == "用 B" && a.By == r.owner.ID }) {
		t.Fatalf("%+v", items)
	}
}

func TestOwnerCannotUseOrAddEmployeesTheUserDidNotAllow(t *testing.T) {
	var stranger *model.Replica
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		last := req.Messages[len(req.Messages)-1]
		switch {
		case len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "replica_id": stranger.ID, "instructions": "go"}), nil
		case last.Content[0].Name == "dispatch_step" && last.Content[0].IsError:
			return ownerCall("ask_user", map[string]any{"prompt": "讓 Eve 加入？", "replica_ids": []string{stranger.ID}}), nil
		case last.Content[0].Name == "dispatch_step":
			return say("dispatched"), nil
		case len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[user_answer]"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "replica_id": stranger.ID, "instructions": "go"}), nil
		}
		return say("asked"), nil
	})
	var err error
	stranger, err = r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Eve", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the question", func(w *model.World) bool { return len(w.Tasks[task.ID].Coordination.Questions) == 1 })
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID {
			t.Fatalf("dispatched to someone not allowed: %+v", s)
		}
	}
	q := w.Tasks[task.ID].Coordination.Questions[0]
	if q.Kind != "approval" || !slices.Equal(q.ReplicaIDs, []string{stranger.ID}) {
		t.Fatalf("%+v", q)
	}
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "ok", Action: "answer", QuestionID: q.ID, OptionID: "approve", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("Eve works", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && *s.ReplicaID == stranger.ID
	})
	if !slices.Contains(w.Tasks[task.ID].Coordination.Authorization.ReplicaIDs, stranger.ID) {
		t.Fatal("the approval was not kept")
	}
}

func TestOwnerChangesThePlanWithinWhatWasAllowed(t *testing.T) {
	step := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		step++
		switch step {
		case 1:
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		case 2:
			return say("started"), nil
		}
		if len(req.Messages) == 1 { // woken by the handoff: drop a step that ran, then add one
			return ownerCall("revise_plan", map[string]any{"reason": "drop start", "nodes": []map[string]any{{"id": "end", "name": "驗收"}}, "edges": []any{}}), nil
		}
		last := req.Messages[len(req.Messages)-1].Content[0]
		if last.IsError && strings.Contains(last.Text, "整理需求") {
			return ownerCall("revise_plan", map[string]any{"reason": "add docs", "edges": []map[string]any{{"from": "start", "to": "end"}, {"from": "start", "to": "docs"}},
				"nodes": []map[string]any{{"id": "start", "name": "整理需求"}, {"id": "end", "name": "驗收"}, {"id": "docs", "name": "文件", "prompt": "write docs", "replica_ids": []string{r0ID}}}}), nil
		}
		return say("done"), nil
	})
	r0ID = r.owner.ID
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the plan to change", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.PlanVersion == 2 })
	got := w.Tasks[task.ID]
	if len(got.Workflow.Nodes) != 3 || got.Workflow.Nodes[2].ID != "docs" {
		t.Fatalf("%+v", got.Workflow)
	}
	if len(w.Workflows[r.flow.ID].Nodes) != 2 {
		t.Fatal("the shared flow changed")
	}
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool {
		return a.Key == "planChanged" && a.Args["reason"] == "add docs" && a.Args["added"] == "文件" && a.Args["linked"] == "整理需求 → 文件" &&
			fmt.Sprint(a.Args["version"]) == "2" && a.Args["owner"] == "Ada" && strings.Contains(a.Text, "整理需求 → 文件")
	}) {
		t.Fatalf("the change was not recorded as it was: %+v", r.activity(task.ID))
	}
}

var r0ID string

func TestBudgetStopsTheOwnerUntilTheUserAddsSome(t *testing.T) {
	r := newRig(t, leading(worker))
	team := r.world().Teams[r.team.ID]
	limit := 0.001
	if err := r.e.UpdateTeam(team.ID, usecase.TeamPatch{Settings: &model.TeamSettings{TimeoutMin: team.Settings.TimeoutMin, CostLimitUSD: limit, Retries: team.Settings.Retries}}); err != nil {
		t.Fatal(err)
	}
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the budget question", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return c.OwnerState == model.OwnerBlocked && c.BlockedReason == "budget" && len(c.Questions) == 1
	})
	q := w.Tasks[task.ID].Coordination.Questions[0]
	if q.Kind != "budget" || q.Audience != "user" {
		t.Fatalf("%+v", q)
	}
	if err := r.e.ResumeTask(task.ID); err == nil {
		t.Log("not paused, nothing to resume")
	}
	plan, control := versions(w.Tasks[task.ID])
	if err := r.e.UpdateTeam(team.ID, usecase.TeamPatch{Settings: &model.TeamSettings{TimeoutMin: team.Settings.TimeoutMin, CostLimitUSD: 100, Retries: team.Settings.Retries}}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "more", Action: "answer", QuestionID: q.ID, OptionID: "addBudget", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
}

func TestLongerRunsThanStopWaitAreUncertainAndBlockResuming(t *testing.T) {
	t.Cleanup(usecase.SetStopWait(50 * time.Millisecond))
	release := make(chan struct{})
	var held atomic.Bool
	r := newRig(t, nil)
	// after the rig's own cleanup is registered, so the held call ends before the engine waits for it
	t.Cleanup(func() { close(release) })
	r.setReply(func(req model.ModelRequest) (model.ModelReply, error) {
		if isOwner(req) {
			return autoOwner(req), nil
		}
		if !held.Swap(true) { // a model call that does not end when asked to
			r.fake.mu.Unlock()
			<-release
			r.fake.mu.Lock()
		}
		return worker(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning && held.Load()
	})
	sub := subAt(w, task.ID, "整理需求")
	op, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "p", Action: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	w = r.wait("uncertain", func(w *model.World) bool { return w.SubTasks[sub.ID].ExecutionState == model.ExecUncertain })
	c := w.Tasks[task.ID].Coordination
	if !slices.ContainsFunc(c.Operations, func(o model.TaskOperation) bool { return o.ID == op.ID && o.Status == model.OpUncertain }) {
		t.Fatalf("%+v", c.Operations)
	}
	i := slices.IndexFunc(c.Questions, func(q model.TaskQuestion) bool { return q.Kind == "recovery" })
	if i < 0 {
		t.Fatalf("%+v", c.Questions)
	}
	plan, control := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "go", Action: "resume", PlanVersion: plan, ControlVersion: control}); err == nil {
		t.Fatal("resumed with a run nobody can account for")
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "ok", Action: "answer", QuestionID: c.Questions[i].ID, OptionID: "confirmStopped", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
	w = r.world()
	for _, o := range w.Tasks[task.ID].Coordination.Operations {
		if o.ID == op.ID && o.Status != model.OpApplied {
			t.Fatalf("the pause stays %s once the user confirmed the run stopped", o.Status)
		}
	}
	plan, control = versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "go2", Action: "resume", PlanVersion: plan, ControlVersion: control}); err != nil {
		t.Fatal(err)
	}
}

func TestRestartKeepsWaitingMessagesAndCallsRunsUnderWayUncertain(t *testing.T) {
	r := newRig(t, leading(func(req model.ModelRequest) model.ModelReply {
		if !lastIsResult(req) && stepOf(req) == "Clarify requirements" {
			return call("run_command", map[string]any{"command": "sleep 30"})
		}
		return worker(req)
	}))
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the step to run", func(w *model.World) bool {
		s := subAt(w, task.ID, "整理需求")
		return s != nil && s.ExecutionState == model.ExecRunning && len(s.Log) > 2
	})
	sub := subAt(w, task.ID, "整理需求")
	r.e.Close()
	newEngine(t, r)
	w = r.world()
	if s := w.SubTasks[sub.ID]; s.ExecutionState != model.ExecUncertain || s.Status != enum.StatusTodo {
		t.Fatalf("a run that may have done anything was taken as not started: %+v", s)
	}
	if !slices.ContainsFunc(w.Tasks[task.ID].Coordination.Questions, func(q model.TaskQuestion) bool { return q.Kind == "recovery" && q.SubID == sub.ID }) {
		t.Fatal("the user was not asked about it")
	}
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID && s.ID != sub.ID {
			t.Fatalf("work was dispatched again: %+v", s)
		}
	}
	// what the user wrote and the conversation stay
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "after", Text: "還在嗎"}); err != nil {
		t.Fatal(err)
	}
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "started" }) {
		t.Fatal("the conversation was lost")
	}
}

func TestFactsKeepWhatTheUserSet(t *testing.T) {
	wrote := regexp.MustCompile(`The user wrote \((\S+)\): 不要改 API`)
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1].Content[0]
		switch {
		case len(req.Messages) == 1 && strings.Contains(brief, "The user wrote") && strings.Contains(brief, "隨便"):
			return ownerCall("record_task_fact", map[string]any{"kind": "decision", "text": "改 API", "supersedes": factID(brief)}), nil
		case len(req.Messages) == 1 && strings.Contains(brief, "The user wrote") && strings.Contains(brief, "不要改 API"):
			return ownerCall("record_task_fact", map[string]any{"kind": "constraint", "text": "不要改 API", "source_activity_ids": []string{wrote.FindStringSubmatch(brief)[1]}}), nil
		case len(req.Messages) > 1 && last.Name == "record_task_fact":
			return say(last.Text), nil
		}
		return say("ok"), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("idle", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle })
	res, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "c", Text: "不要改 API"})
	if err != nil {
		t.Fatal(err)
	}
	userEntry := res.Activity.ID
	w := r.wait("the fact", func(w *model.World) bool { return len(w.Tasks[task.ID].Coordination.Facts) == 1 })
	f := w.Tasks[task.ID].Coordination.Facts[0]
	if f.Kind != "constraint" || !slices.Equal(f.SourceActivityIDs, []string{userEntry}) {
		t.Fatalf("%+v", f)
	}
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "d", Text: "隨便"}); err != nil {
		t.Fatal(err)
	}
	r.wait("refused", func(w *model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return strings.Contains(a.Text, "使用者訂下的限制") })
	})
	if got := r.world().Tasks[task.ID].Coordination.Facts; len(got) != 1 {
		t.Fatalf("the user's constraint was overridden: %+v", got)
	}
	// every decision of the owner reads the constraints, however long the conversation
	last := ownerRequests(r)
	if !strings.Contains(last[len(last)-1].Messages[0].Content[0].Text, "[constraint] 不要改 API") {
		t.Fatal("the constraint was not in what the owner read")
	}
}

func factID(brief string) string {
	m := regexp.MustCompile(`- (fact-\d+) \[constraint\]`).FindStringSubmatch(brief)
	if m == nil {
		return ""
	}
	return m[1]
}

func TestOlderTasksKeepTheirWayAndRefuseTheNewOnes(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) { return worker(req), nil })
	task := r.task(r.flow.ID)
	if task.Orchestration != "" || task.Coordination != nil {
		t.Fatalf("%+v", task)
	}
	r.wait("await merge", stage(task.ID, enum.StageAwaitMerge))
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "x", Text: "hi"}); err == nil {
		t.Fatal("an older task took a message for an owner")
	}
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "x", Action: "pause"}); err == nil {
		t.Fatal("an older task took a control")
	}
	if _, err := r.e.TaskActivity(task.ID, 0, 0, ""); err == nil {
		t.Fatal("an older task has a conversation")
	}
	if err := r.e.ReturnTask(task.ID, "再做"); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerCannotDispatchAStepBeforeWhatItBuildsOnIsAccepted(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		last := req.Messages[len(req.Messages)-1].Content[0]
		switch {
		case len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "end", "instructions": "skip what comes before"}), nil
		case last.Name == "dispatch_step" && last.IsError:
			return say("refused: " + last.Text), nil
		}
		return say("idle"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the refusal", func(w *model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool {
			return strings.HasPrefix(a.Text, "refused: ") && strings.Contains(a.Text, "整理需求")
		})
	})
	if s := subAt(w, task.ID, "驗收"); s != nil {
		t.Fatalf("a step ran before the step it builds on, with the plan as it was: %+v", s)
	}
}

func TestOwnerFillsInTheAcceptedStepsBeforeWhenNotNamed(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1].Content[0]
		switch {
		case len(req.Messages) == 1 && strings.Contains(brief, "[task_started]"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		case len(req.Messages) == 1 && strings.Contains(brief, "[employee_handoff]") && strings.Contains(brief, "(start)"):
			return ownerCall("review_step", map[string]any{"sub_id": readView(brief).runs[0].id, "decision": "accept"}), nil
		case last.Name == "review_step" && strings.HasPrefix(last.Text, "accepted"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "end", "instructions": "check"}), nil
		}
		return say("ok"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the next step", func(w *model.World) bool { return subAt(w, task.ID, "驗收") != nil })
	start, end := subAt(w, task.ID, "整理需求"), subAt(w, task.ID, "驗收")
	if !slices.Equal(end.UpstreamIDs, []string{start.ID}) {
		t.Fatalf("the step does not build on the one before it: %v", end.UpstreamIDs)
	}
}

func TestRejectedHandoffKeepsTheTaskFromBeingDone(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1].Content[0]
		switch {
		case len(req.Messages) == 1 && strings.Contains(brief, "[task_started]"):
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		case len(req.Messages) == 1 && strings.Contains(brief, "[employee_handoff]"):
			return ownerCall("review_step", map[string]any{"sub_id": readView(brief).runs[0].id, "decision": "reject", "reason": "not done"}), nil
		case last.Name == "review_step":
			return ownerCall("submit_complete", map[string]any{"summary": "done"}), nil
		case last.Name == "submit_complete":
			return say("complete: " + last.Text), nil
		}
		return say("idle"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the owner to try", func(w *model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return strings.HasPrefix(a.Text, "complete: ") })
	})
	if w.Tasks[task.ID].Stage != enum.StageRunning {
		t.Fatalf("a task with a rejected handoff and a step never run was reported done: %s", w.Tasks[task.ID].Stage)
	}
	if err := r.e.MergeTask(task.ID); err == nil {
		t.Fatal("merged with a rejected handoff")
	}
}

// After submit_complete the owner is told to end without repeating the summary, and a model may then reply with
// nothing. The task is done; that reply must not show as the owner failing.
func TestNothingSaidAfterCompletingIsNoFailure(t *testing.T) {
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		if last := lastBlock(req); last.Name == "submit_complete" && !last.IsError {
			return model.ModelReply{}, nil
		}
		return autoOwner(req), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the owner to finish", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return w.Tasks[task.ID].Stage == enum.StageAwaitMerge && (c.OwnerState == model.OwnerIdle || c.OwnerState == model.OwnerFailed)
	})
	if s := w.Tasks[task.ID].Coordination.OwnerState; s != model.OwnerIdle {
		t.Fatalf("the owner is %s after completing", s)
	}
	if hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Key == "ownerFailed" }) {
		t.Fatal("an empty reply after completing was shown as the owner failing")
	}
}

func TestRunsFailingOneAfterAnotherStopTheOwner(t *testing.T) {
	var failures atomic.Int64
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			failures.Add(1)
			return model.ModelReply{}, fmt.Errorf("worker failure")
		}
		if len(req.Messages) > 1 {
			return say("idle"), nil
		}
		v := readView(req.Messages[0].Content[0].Text)
		if len(v.runs) == 0 {
			return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "go"}), nil
		}
		// a stubborn owner: the stopped run goes on, or the step is dispatched anew
		for i, s := range v.runs {
			if strings.Contains(s.rest, "run stopped") && s.counts() {
				if i%2 == 0 {
					return ownerCall("dispatch_step", map[string]any{"sub_id": s.id, "instructions": "again"}), nil
				}
				return ownerCall("dispatch_step", map[string]any{"node_id": "start", "instructions": "anew"}), nil
			}
		}
		return say("idle"), nil
	})
	task := r.ownerTask(r.flow.ID)
	w := r.wait("the owner to stop", func(w *model.World) bool {
		c := w.Tasks[task.ID].Coordination
		return c.OwnerState == model.OwnerBlocked && c.BlockedReason == "loop"
	})
	if !slices.ContainsFunc(w.Tasks[task.ID].Coordination.Questions, func(q model.TaskQuestion) bool { return q.Audience == "user" && q.Kind == "approval" }) {
		t.Fatal("the user was not asked")
	}
	seen := failures.Load()
	time.Sleep(300 * time.Millisecond)
	if failures.Load() != seen {
		t.Fatalf("failed runs went on being dispatched: %d then %d", seen, failures.Load())
	}
}

func TestRetryingAFailedDecisionSettlesIt(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return model.ModelReply{}, fmt.Errorf("failure") })
	task := r.ownerTask(r.flow.ID)
	failed := func(w *model.World) (model.TaskOperation, bool) {
		for _, o := range w.Tasks[task.ID].Coordination.Operations {
			if o.Kind == "retry" && o.Status == model.OpFailed {
				return o, true
			}
		}
		return model.TaskOperation{}, false
	}
	w := r.wait("failed", func(w *model.World) bool {
		_, ok := failed(w)
		return ok && w.Tasks[task.ID].Coordination.OwnerState == model.OwnerFailed
	})
	old, _ := failed(w)
	// failing again leaves one failure to retry
	p, c := versions(w.Tasks[task.ID])
	if _, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "retry-1", Action: "retry", OperationID: old.ID, PlanVersion: p, ControlVersion: c}); err != nil {
		t.Fatal(err)
	}
	w = r.wait("failed again", func(w *model.World) bool {
		o, err := r.e.TaskOperation(task.ID, old.ID)
		return err == nil && o.Status == model.OpFailed && w.Tasks[task.ID].Coordination.OwnerState == model.OwnerFailed
	})
	open := 0
	for _, o := range w.Tasks[task.ID].Coordination.Operations {
		if o.Kind == "retry" && o.Status != model.OpApplied {
			open++
		}
	}
	if open != 1 {
		t.Fatalf("%d retries left open: %+v", open, w.Tasks[task.ID].Coordination.Operations)
	}
	r.setReply(func(model.ModelRequest) (model.ModelReply, error) { return say("recovered"), nil })
	p, c = versions(w.Tasks[task.ID])
	op, err := r.e.ControlTask(task.ID, usecase.TaskControl{RequestID: "retry-2", Action: "retry", OperationID: old.ID, PlanVersion: p, ControlVersion: c})
	if err != nil {
		t.Fatal(err)
	}
	w = r.wait("applied", func(w *model.World) bool {
		o, err := r.e.TaskOperation(task.ID, op.ID)
		return err == nil && o.Status == model.OpApplied && w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle
	})
	for _, o := range w.Tasks[task.ID].Coordination.Operations {
		if o.Status == model.OpProcessing || o.Status == model.OpFailed || o.Status == model.OpReceived {
			t.Fatalf("an operation never settles once the retry worked: %+v", o)
		}
	}
}

func TestOwnerReadsAnEntryOfTheConversationInFull(t *testing.T) {
	long := strings.Repeat("x", 700) + "NEVER_DELETE_THIS"
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		brief := req.Messages[0].Content[0].Text
		last := req.Messages[len(req.Messages)-1].Content[0]
		switch {
		case len(req.Messages) == 1 && strings.Contains(brief, "[user_message]"):
			return ownerCall("read_task_history", map[string]any{"limit": 100}), nil
		case last.Name == "read_task_history":
			id := regexp.MustCompile(`read_task_entry (\S+) reads it all`).FindStringSubmatch(last.Text)
			if id == nil {
				return say("not clipped"), nil
			}
			return ownerCall("read_task_entry", map[string]any{"activity_id": id[1]}), nil
		}
		return say("idle"), nil
	})
	task := r.ownerTask(r.flow.ID)
	r.wait("idle", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.OwnerState == model.OwnerIdle })
	if _, err := r.e.SayToOwner(task.ID, usecase.TaskMessage{RequestID: "long", Text: long}); err != nil {
		t.Fatal(err)
	}
	r.wait("read", func(w *model.World) bool {
		return hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool { return a.Text == "idle" && a.Seq > 3 })
	})
	found := false
	for _, req := range ownerRequests(r) {
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockToolResult && b.Name == "read_task_entry" {
					found = true
					if !strings.Contains(b.Text, long) {
						t.Fatalf("the entry did not come back whole: %s", b.Text)
					}
				}
			}
		}
	}
	if !found {
		t.Fatal("the owner could not find a way to the whole entry")
	}
}

func TestRestaffingIsRecordedWithWhoGaveWayToWhom(t *testing.T) {
	var bob *model.Replica
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		if len(req.Messages) == 1 && strings.Contains(req.Messages[0].Content[0].Text, "[task_started]") {
			return ownerCall("revise_plan", map[string]any{"reason": "換人", "edges": []map[string]any{{"from": "start", "to": "end"}},
				"nodes": []map[string]any{{"id": "start", "name": "整理需求", "replica_ids": []string{r0ID}}, {"id": "end", "name": "驗收", "replica_ids": []string{r0ID}}}}), nil
		}
		return say("ok"), nil
	})
	r0ID = r.owner.ID
	var err error
	bob, err = r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.world().Replicas[r.owner.ID].BlueprintID, Name: "Bob", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "t", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Staff: map[string][]string{"end": {bob.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	r.wait("the plan to change", func(w *model.World) bool { return w.Tasks[task.ID].Coordination.PlanVersion == 2 })
	if !hasActivity(r.activity(task.ID), func(a model.TaskActivity) bool {
		return a.Key == "planChanged" && a.Args["restaffed"] == "驗收：Bob → Ada" && a.Args["linked"] == "" && a.Args["unlinked"] == "" && strings.Contains(a.Text, "驗收：Bob → Ada")
	}) {
		t.Fatalf("%+v", r.activity(task.ID))
	}
}
