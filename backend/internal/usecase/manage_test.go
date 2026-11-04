package usecase_test

import (
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// moves is a model that follows lists, one for chats and one for tasks: each call takes the next reply. A chat with
// nothing left to do says so and a task's step hands off.
type moves struct {
	mu    sync.Mutex
	chat  []func(model.ModelRequest) model.ModelReply
	tasks []func(model.ModelRequest) model.ModelReply
}

func (m *moves) reply(req model.ModelRequest) (model.ModelReply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list, rest := &m.tasks, call("submit_handoff", handoff)
	if strings.HasPrefix(req.Session, "chat") {
		list, rest = &m.chat, say("好")
	}
	if len(*list) == 0 {
		return rest, nil
	}
	next := (*list)[0]
	*list = (*list)[1:]
	return next(req), nil
}

func (m *moves) add(fn ...func(model.ModelRequest) model.ModelReply) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.chat = append(m.chat, fn...)
}

func (m *moves) addTask(fn ...func(model.ModelRequest) model.ModelReply) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tasks = append(m.tasks, fn...)
}

func doing(name string, args any) func(model.ModelRequest) model.ModelReply {
	return func(model.ModelRequest) model.ModelReply { return call(name, args) }
}

// together is one reply calling several tools.
func together(calls ...model.ModelReply) model.ModelReply {
	out := model.ModelReply{}
	for i, c := range calls {
		b := c.Content[0]
		b.ID = b.ID + "-" + string(rune('a'+i))
		out.Content = append(out.Content, b)
	}
	return out
}

func manageRig(t *testing.T) (*rig, *moves) {
	t.Helper()
	m := &moves{}
	return newRig(t, m.reply), m
}

// lastResults is what the model was last told its tools did, by tool name.
func lastResults(r *rig) []model.Block {
	seen := slices.DeleteFunc(r.fake.requests(), func(req model.ModelRequest) bool { return !strings.HasPrefix(req.Session, "chat") })
	if len(seen) == 0 {
		return nil
	}
	msgs := seen[len(seen)-1].Messages
	for i := len(msgs) - 1; i >= 0; i-- {
		if len(msgs[i].Content) > 0 && msgs[i].Content[0].Type == enum.BlockToolResult {
			return msgs[i].Content
		}
	}
	return nil
}

func lastResult(t *testing.T, r *rig) model.Block {
	t.Helper()
	got := lastResults(r)
	if len(got) == 0 {
		t.Fatal("the model was told nothing")
	}
	return got[len(got)-1]
}

func toolsOf(req model.ModelRequest) []string {
	names := []string{}
	for _, s := range req.Tools {
		names = append(names, s.Name)
	}
	return names
}

func startChat(t *testing.T, r *rig) *model.Chat {
	t.Helper()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "幫忙"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// versionFrom runs list_* in a chat and finds the version of one item.
func versionFrom(t *testing.T, r *rig, m *moves, tool, id string) string {
	t.Helper()
	inChat(t, r, m, doing(tool, map[string]any{}))
	var rows []struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(lastResult(t, r).Text), &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == id {
			return row.Version
		}
	}
	t.Fatalf("%s not in %s", id, tool)
	return ""
}

// inChat has the employee of a new chat make these moves, and waits for it to stop.
func inChat(t *testing.T, r *rig, m *moves, fn ...func(model.ModelRequest) model.ModelReply) *model.Chat {
	t.Helper()
	m.add(fn...)
	c := startChat(t, r)
	r.wait("reply", chatDone(c.ID))
	return c
}

func TestManageToolsFollowTheBlueprint(t *testing.T) {
	reading := []string{"list_tasks", "list_blueprints", "list_workflows", "list_employees", "list_companies", "list_providers"}
	writing := []string{"create_task", "update_task", "save_blueprint", "save_workflow", "save_provider"}
	for _, tc := range []struct {
		name         string
		tools        []enum.Tool
		read, change bool
	}{
		{"read_file", []enum.Tool{enum.ToolReadFile}, true, false},
		{"write_file", []enum.Tool{enum.ToolWriteFile}, true, true},
		{"run_command", []enum.Tool{enum.ToolRunCommand}, true, true},
		{"web_search", []enum.Tool{enum.ToolWebSearch}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := manageRig(t)
			bp, err := r.e.CreateBlueprint(model.Blueprint{Name: tc.name, Tools: tc.tools})
			if err != nil {
				t.Fatal(err)
			}
			hired, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: bp.ID, Name: "X", Model: "fake"})
			if err != nil {
				t.Fatal(err)
			}
			c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: hired.ID, Text: "嗨"})
			if err != nil {
				t.Fatal(err)
			}
			r.wait("reply", chatDone(c.ID))
			got := toolsOf(r.fake.requests()[0])
			for _, name := range reading {
				if slices.Contains(got, name) != tc.read {
					t.Errorf("%s: %v", name, got)
				}
			}
			for _, name := range writing {
				if slices.Contains(got, name) != tc.change {
					t.Errorf("%s: %v", name, got)
				}
			}
		})
	}
}

func TestAirportStaffHaveEveryManageTool(t *testing.T) {
	r, _ := manageRig(t)
	c, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "fake", Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	got := toolsOf(r.fake.requests()[0])
	for _, name := range []string{"list_tasks", "list_companies", "list_providers", "create_task", "update_task", "save_blueprint", "save_workflow", "save_provider"} {
		if !slices.Contains(got, name) {
			t.Errorf("%s: %v", name, got)
		}
	}
}

func TestDiscussionOnlyReads(t *testing.T) {
	r, _ := manageRig(t)
	wf := *r.flow
	wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: "talk", Kind: enum.NodeTalk, Name: "討論", ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll})
	wf.Edges = []model.WorkflowEdge{{ID: "e", From: wf.Nodes[0].ID, To: "talk"}, {ID: "e2", From: "talk", To: wf.Nodes[1].ID}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		if stepOf(req) == "討論" {
			return say("開始討論"), nil
		}
		return call("submit_handoff", handoff), nil
	}
	r.fake.mu.Unlock()
	task := r.task(wf.ID)
	r.wait("talk", func(w *model.World) bool { s := subAt(w, task.ID, "討論"); return s != nil && s.Talk != nil })
	for _, req := range r.fake.requests() {
		if stepOf(req) != "討論" {
			continue
		}
		got := toolsOf(req)
		if !slices.Contains(got, "list_tasks") || slices.Contains(got, "create_task") || slices.Contains(got, "save_workflow") {
			t.Fatalf("%v", got)
		}
	}
}

func TestCreatingABlueprintAndFlowTakesEffectAtOnce(t *testing.T) {
	r, m := manageRig(t)
	flow := map[string]any{"name": "新流程",
		"nodes": []map[string]any{{"id": "s", "kind": "task", "name": "開始"}, {"id": "a", "name": "做"}, {"id": "b", "name": "也做"}, {"id": "z", "name": "驗收"}},
		"edges": []map[string]any{{"from": "s", "to": "a"}, {"from": "s", "to": "b"}, {"from": "a", "to": "z"}, {"from": "b", "to": "z"}}}
	c := inChat(t, r, m,
		doing("save_blueprint", map[string]any{"name": "新藍圖", "prompt": "你是誰", "tools": []string{"readFile"}}),
		doing("save_workflow", flow))
	w := r.world()
	if w.Chats[c.ID].Change != nil {
		t.Fatal("creating asked for a confirmation")
	}
	var bp *model.Blueprint
	for _, b := range w.Blueprints {
		if b.Name == "新藍圖" {
			bp = b
		}
	}
	if bp == nil || bp.Source.Kind != "yaml" || !strings.Contains(bp.Source.Text, "read_file") || bp.Look.Skin == "" {
		t.Fatalf("%+v", bp)
	}
	var made *model.Workflow
	for _, wf := range w.Workflows {
		if wf.Name == "新流程" {
			made = wf
		}
	}
	if made == nil || len(made.Nodes) != 4 {
		t.Fatalf("%+v", made)
	}
	// an old-style start is a step like any other; a new last step that two steps feed cannot send work back
	for _, n := range made.Nodes {
		if n.Kind != enum.NodeWork || (n.ID == "z" && (n.SendBack == nil || *n.SendBack)) {
			t.Fatalf("%+v", n)
		}
	}
	// nobody on top of anybody, and each below what it follows
	spots := map[model.Point]bool{}
	y := map[string]float64{}
	for _, n := range made.Nodes {
		if spots[n.Pos] {
			t.Fatalf("two steps at %+v", n.Pos)
		}
		spots[n.Pos], y[n.ID] = true, n.Pos.Y
	}
	if y["a"] <= y["s"] || y["z"] <= y["a"] {
		t.Fatalf("%v", y)
	}
	// it runs
	task, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "跑", WorkflowID: made.ID, Staff: map[string][]string{"s": {r.owner.ID}, "a": {r.owner.ID}, "b": {r.owner.ID}, "z": {r.owner.ID}}, OwnerID: &r.owner.ID})
	if err != nil || task == nil {
		t.Fatal(err)
	}
}

func TestInvalidNewFlowIsRefusedAndLeavesNothing(t *testing.T) {
	r, m := manageRig(t)
	before := len(r.world().Workflows)
	inChat(t, r, m, doing("save_workflow", map[string]any{"name": "迴圈",
		"nodes": []map[string]any{{"id": "s", "kind": "task", "name": "開始"}, {"id": "a", "name": "A"}, {"id": "b", "name": "B"}},
		"edges": []map[string]any{{"from": "s", "to": "a"}, {"from": "a", "to": "b"}, {"from": "b", "to": "a"}}}))
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "迴圈") {
		t.Fatalf("%+v", res)
	}
	if got := len(r.world().Workflows); got != before {
		t.Fatalf("%d flows, was %d", got, before)
	}
	inChat(t, r, m, doing("save_blueprint", map[string]any{"name": "壞", "tools": []string{"fly"}}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
}

func TestListBlueprintsLeavesOutTheAirportStaff(t *testing.T) {
	r, m := manageRig(t)
	versionFrom(t, r, m, "list_blueprints", "preset-assistant")
	if strings.Contains(lastResult(t, r).Text, `"preset-airport"`) {
		t.Fatal("the airport staff's blueprint is listed")
	}
}

func TestChangingABlueprintWaitsForTheUserInAChat(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	version := versionFrom(t, r, m, "list_blueprints", id)
	// an employee adding to their own blueprint is no exception
	args := map[string]any{"id": id, "version": version, "prompt": "新角色", "tools": []string{"readFile", "writeFile", "runCommand", "webSearch"}}
	c := inChat(t, r, m, doing("save_blueprint", args))
	w := r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if got := w.Blueprints[id]; got.Prompt != "你是開發者" || len(got.Tools) != 3 {
		t.Fatalf("written before agreeing: %+v", got)
	}
	card := w.Chats[c.ID].Change
	fields := []string{}
	for _, l := range card.Lines {
		fields = append(fields, l.Field)
	}
	if !slices.Equal(fields, []string{"prompt", "tools"}) || card.Lines[0].Before != "你是開發者" || card.Lines[0].After != "新角色" {
		t.Fatalf("%+v", card.Lines)
	}

	// no: nothing changes, and the model goes on knowing
	if err := r.e.ResolveChatChange(c.ID, false, "不要"); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after no", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "refused") || !strings.Contains(res.Text, "不要") {
		t.Fatalf("%+v", res)
	}
	if got := r.world().Blueprints[id]; got.Prompt != "你是開發者" {
		t.Fatalf("%+v", got)
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err == nil {
		t.Fatal("answered a card that is gone")
	}

	// yes: written
	c = inChat(t, r, m, doing("save_blueprint", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply after yes", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if got := r.world().Blueprints[id]; got.Prompt != "新角色" || len(got.Tools) != 4 {
		t.Fatalf("%+v", got)
	}
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "agreed") {
		t.Fatalf("%+v", res)
	}
}

func TestChangingAFlowWaitsForTheUserInATaskAndSparesTasksUnderWay(t *testing.T) {
	r, m := manageRig(t)
	running, err := r.e.CreateWorkflow("共用流程")
	if err != nil {
		t.Fatal(err)
	}
	running.Nodes, running.Edges = slices.Clone(r.flow.Nodes), slices.Clone(r.flow.Edges)
	running.Nodes[1].Pos.Y = 400
	if err := r.e.SaveWorkflow(running.ID, *running); err != nil {
		t.Fatal(err)
	}
	version := versionFrom(t, r, m, "list_workflows", running.ID)
	start, end := running.Nodes[0], running.Nodes[1]
	m.addTask(doing("save_workflow", map[string]any{"id": running.ID, "version": version, "name": "改過的流程",
		"nodes": []map[string]any{{"id": start.ID}, {"id": "mid", "name": "中間"}, {"id": end.ID}},
		"edges": []map[string]any{{"from": start.ID, "to": "mid"}, {"from": "mid", "to": end.ID}}}))
	task := r.task(running.ID)
	w := r.wait("review", func(w *model.World) bool {
		for _, s := range w.SubTasks {
			if s.TaskID == task.ID && s.Review != nil && s.Review.Kind == enum.ReviewChange {
				return true
			}
		}
		return false
	})
	var sub *model.SubTask
	for _, s := range w.SubTasks {
		if s.TaskID == task.ID && s.Review != nil {
			sub = s
		}
	}
	if sub.Status != enum.StatusReview || sub.Review.Change.Workflow == nil {
		t.Fatalf("%+v", sub)
	}
	if got := w.Workflows[running.ID]; got.Name != "共用流程" || len(got.Nodes) != 2 {
		t.Fatalf("written before agreeing: %+v", got)
	}
	var added *model.ChangeLine
	for i, l := range sub.Review.Change.Lines {
		if l.Field == "node" && l.After == "中間" {
			added = &sub.Review.Change.Lines[i]
		}
	}
	if added == nil {
		t.Fatalf("%+v", sub.Review.Change.Lines)
	}
	if err := r.e.ResolveReview(sub.ID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	w = r.wait("the task to end", stage(task.ID, enum.StageAwaitMerge))
	got := w.Workflows[running.ID]
	if got.Name != "改過的流程" || len(got.Nodes) != 3 {
		t.Fatalf("%+v", got)
	}
	if nodeAt := got.Nodes[1]; nodeAt.Pos.Y <= got.Nodes[0].Pos.Y || got.Nodes[2].Pos != end.Pos {
		t.Fatalf("%+v", got.Nodes)
	}
	// the task under way keeps its copy, all the way to its end
	if tk := w.Tasks[task.ID]; tk.Workflow.Name != "共用流程" || len(tk.Workflow.Nodes) != 2 || subAt(w, task.ID, "中間") != nil {
		t.Fatalf("%+v", tk.Workflow)
	}
}

func TestChangeRefusedInATaskGoesOn(t *testing.T) {
	r, m := manageRig(t)
	bp := r.owner.BlueprintID
	version := versionFrom(t, r, m, "list_blueprints", bp)
	m.addTask(doing("save_blueprint", map[string]any{"id": bp, "version": version, "prompt": "改"}))
	task := r.task(r.flow.ID)
	w := r.wait("review", func(w *model.World) bool {
		s := subAt(w, task.ID, r.flow.Nodes[0].Name)
		return s != nil && s.Review != nil
	})
	sub := subAt(w, task.ID, r.flow.Nodes[0].Name)
	if err := r.e.ResolveReview(sub.ID, "nope", ""); err == nil {
		t.Fatal("an option that does not exist went through")
	}
	if err := r.e.ResolveReview(sub.ID, "reject", "太大"); err != nil {
		t.Fatal(err)
	}
	r.wait("the step to go on", func(w *model.World) bool { return w.SubTasks[sub.ID].Status == enum.StatusComplete })
	if got := r.world().Blueprints[bp]; got.Prompt != "你是開發者" {
		t.Fatalf("%+v", got)
	}
	found := false
	for _, req := range r.fake.requests() {
		for _, msg := range req.Messages {
			for _, b := range msg.Content {
				found = found || (b.Type == enum.BlockToolResult && b.Name == "save_blueprint" && strings.Contains(b.Text, "太大"))
			}
		}
	}
	if !found {
		t.Fatal("the model was not told")
	}
}

func TestCardsAreKeptOverARestart(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	version := versionFrom(t, r, m, "list_blueprints", id)
	c := inChat(t, r, m, doing("save_blueprint", map[string]any{"id": id, "version": version, "prompt": "改"}))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	r.e.Close()
	r.store.Close()
	newEngine(t, r)
	if r.world().Chats[c.ID].Change == nil {
		t.Fatal("the card did not survive")
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("written", func(w *model.World) bool { return w.Blueprints[id].Prompt == "改" })
}

func TestWhatCannotBeChangedIsRefused(t *testing.T) {
	r, m := manageRig(t)
	preset := model.PresetPrefix + "nothing"
	for id, b := range r.world().Blueprints {
		if model.IsPresetID(id) {
			preset = b.ID
		}
	}
	git, err := r.e.CreateBlueprint(model.Blueprint{Name: "Git", Source: model.BlueprintSource{Kind: "git", Repo: "https://example.com/x.git"}})
	if err != nil {
		t.Fatal(err)
	}
	var presetFlow string
	for id := range r.world().Workflows {
		if model.IsPresetID(id) {
			presetFlow = id
		}
	}
	for name, step := range map[string]func(model.ModelRequest) model.ModelReply{
		"built-in blueprint": doing("save_blueprint", map[string]any{"id": preset, "version": "x", "prompt": "改"}),
		"blueprint from Git": doing("save_blueprint", map[string]any{"id": git.ID, "version": "x", "prompt": "改"}),
		"built-in flow":      doing("save_workflow", map[string]any{"id": presetFlow, "version": "x", "name": "改"}),
		"stale blueprint":    doing("save_blueprint", map[string]any{"id": r.owner.BlueprintID, "version": "stale", "prompt": "改"}),
		"stale flow":         doing("save_workflow", map[string]any{"id": r.flow.ID, "version": "stale", "name": "改"}),
		"missing version":    doing("save_workflow", map[string]any{"id": r.flow.ID, "name": "改"}),
	} {
		c := inChat(t, r, m, step)
		if res := lastResult(t, r); !res.IsError {
			t.Errorf("%s went through: %+v", name, res)
		}
		if r.world().Chats[c.ID].Change != nil {
			t.Errorf("%s asked for a confirmation", name)
		}
	}
}

func TestEditWhileTheCardIsOpenIsNotOverwritten(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	version := versionFrom(t, r, m, "list_blueprints", id)
	c := inChat(t, r, m, doing("save_blueprint", map[string]any{"id": id, "version": version, "prompt": "員工改的"}))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	mine := *r.world().Blueprints[id]
	mine.Prompt = "使用者改的"
	if err := r.e.SaveBlueprint(id, mine); err != nil {
		t.Fatal(err)
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if got := r.world().Blueprints[id].Prompt; got != "使用者改的" {
		t.Fatal(got)
	}
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "nothing was written") {
		t.Fatalf("%+v", res)
	}
}

func TestSayingSomethingElseRefusesAndCopiesAndRewindsDropTheCard(t *testing.T) {
	r, m := manageRig(t)
	id := r.owner.BlueprintID
	version := versionFrom(t, r, m, "list_blueprints", id)
	args := map[string]any{"id": id, "version": version, "prompt": "改"}

	c := inChat(t, r, m, doing("save_blueprint", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	// a copy cannot agree for the original
	fork, err := r.e.HandOffChat(c.ID, 0, c.ReplicaID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.Change != nil {
		t.Fatal("the copy has the card")
	}
	if err := r.e.ResolveChatChange(fork.ID, true, ""); err == nil {
		t.Fatal("the copy agreed")
	}
	if err := r.e.SayInChat(c.ID, "先別改", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	if got := r.world().Blueprints[id].Prompt; got != "你是開發者" {
		t.Fatal(got)
	}
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "did not agree") {
		t.Fatalf("%+v", res)
	}

	c = inChat(t, r, m, doing("save_blueprint", args))
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if r.world().Chats[c.ID].Change != nil {
		t.Fatal("taking the message back left the card")
	}
}

// A reply can make a task and then stop to ask about a flow: on going on, the model must not be told to make it again.
func TestWhatRanBeforeAStopIsNotDoneAgain(t *testing.T) {
	r, m := manageRig(t)
	version := versionFrom(t, r, m, "list_workflows", r.flow.ID)
	before := len(r.world().Tasks)
	c := inChat(t, r, m, func(model.ModelRequest) model.ModelReply {
		return together(
			call("create_task", map[string]any{"title": "一起做", "workflow_id": r.flow.ID, "owner_id": r.owner.ID}),
			call("save_workflow", map[string]any{"id": r.flow.ID, "version": version, "name": "新名字"}),
			call("save_workflow", map[string]any{"id": r.flow.ID, "version": version, "name": "另一個"}),
		)
	})
	r.wait("card", func(w *model.World) bool { return w.Chats[c.ID].Change != nil })
	if got := len(r.world().Tasks); got != before+1 {
		t.Fatalf("%d tasks, was %d", got, before)
	}
	if err := r.e.ResolveChatChange(c.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	r.wait("reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && w.Chats[c.ID].Change == nil })
	got := lastResults(r)
	if len(got) != 3 {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(got[0].Text, "created task") || got[0].IsError {
		t.Fatalf("%+v", got[0])
	}
	if !strings.Contains(got[1].Text, "agreed") || got[1].IsError {
		t.Fatalf("%+v", got[1])
	}
	if !strings.Contains(got[2].Text, "interrupted") || !got[2].IsError {
		t.Fatalf("%+v", got[2])
	}
	if r.world().Workflows[r.flow.ID].Name != "新名字" {
		t.Fatal(r.world().Workflows[r.flow.ID].Name)
	}
}

func TestCreateTaskWaitsInTodoAndSaysWhereItCameFrom(t *testing.T) {
	r, m := manageRig(t)
	c := inChat(t, r, m, doing("create_task", map[string]any{"title": "新任務", "description": "內容", "workflow_id": r.flow.ID, "owner_id": r.owner.ID}))
	w := r.world()
	if w.Chats[c.ID].Change != nil {
		t.Fatal("it asked for a confirmation")
	}
	var made *model.Task
	for _, task := range w.Tasks {
		made = task
	}
	if made == nil || made.Stage != enum.StageRunning || made.Description != "內容" || !made.Paused || made.PausedAt != nil {
		t.Fatalf("%+v", made)
	}
	if o := made.Origin; o == nil || o.Kind != "chat" || o.ID != c.ID || o.Name != "Ada" || o.Depth != 0 {
		t.Fatalf("%+v", made.Origin)
	}
	// the task shows under the create_task line, and stays there for when the chat is opened again
	pinned := slices.IndexFunc(w.Chats[c.ID].Messages, func(m model.ChatMessage) bool { return slices.Contains(m.Tasks, made.ID) })
	if pinned < 0 || w.Chats[c.ID].Messages[pinned].From != "tool" || !strings.HasPrefix(w.Chats[c.ID].Messages[pinned].Text, "create_task ") {
		t.Fatalf("%+v", w.Chats[c.ID].Messages)
	}
	for _, s := range w.SubTasks {
		if s.Status != enum.StatusTodo {
			t.Fatalf("a step ran before the user started the task: %+v", s)
		}
	}
	if len(w.SubTasks) == 0 {
		t.Fatal("its first steps are missing")
	}
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "to-do") {
		t.Fatalf("%+v", res)
	}
	// what the user makes has no origin
	if mine := r.task(r.flow.ID); mine.Origin != nil {
		t.Fatalf("%+v", mine.Origin)
	}
}

func TestTaskTheUserMakesFromAChatShowsUnderItsLastMessage(t *testing.T) {
	r, m := manageRig(t)
	c := inChat(t, r, m)
	made, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "從對話", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, ChatID: c.ID})
	if err != nil {
		t.Fatal(err)
	}
	msgs := r.world().Chats[c.ID].Messages
	if last := msgs[len(msgs)-1]; !slices.Equal(last.Tasks, []string{made.ID}) {
		t.Fatalf("%+v", msgs)
	}
}

func TestCreateTaskAsksForMissingStaffInsteadOfPicking(t *testing.T) {
	r, m := manageRig(t)
	wf := *r.world().Workflows[r.flow.ID]
	wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: "mid", Kind: enum.NodeWork, Name: "中間", ReplicaIDs: []string{}, Handoff: enum.HandoffAll, Join: enum.JoinAll})
	wf.Nodes[0].ReplicaIDs = []string{}
	wf.Edges = []model.WorkflowEdge{{ID: "e1", From: wf.Nodes[0].ID, To: "mid"}, {ID: "e2", From: "mid", To: wf.Nodes[1].ID}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	inChat(t, r, m, doing("create_task", map[string]any{"title": "沒人做", "workflow_id": wf.ID}))
	res := lastResult(t, r)
	if !res.IsError || !strings.Contains(res.Text, "ask_user") || !strings.Contains(res.Text, "中間 (mid)") || !strings.Contains(res.Text, wf.Nodes[0].ID) {
		t.Fatalf("%+v", res)
	}
	if got := len(r.world().Tasks); got != 0 {
		t.Fatalf("%d tasks", got)
	}
	for name, args := range map[string]map[string]any{
		"no flow":       {"title": "x", "workflow_id": "nope"},
		"no title":      {"title": " ", "workflow_id": wf.ID, "owner_id": r.owner.ID, "staff": map[string][]string{"mid": {r.owner.ID}}},
		"unknown step":  {"title": "x", "workflow_id": wf.ID, "owner_id": r.owner.ID, "staff": map[string][]string{"nope": {r.owner.ID}}},
		"unknown owner": {"title": "x", "workflow_id": wf.ID, "owner_id": "nope", "staff": map[string][]string{"mid": {r.owner.ID}}},
	} {
		inChat(t, r, m, doing("create_task", args))
		if res := lastResult(t, r); !res.IsError {
			t.Errorf("%s: %+v", name, res)
		}
		if got := len(r.world().Tasks); got != 0 {
			t.Fatalf("%s: %d tasks", name, got)
		}
	}
	inChat(t, r, m, doing("create_task", map[string]any{"title": "有人做", "workflow_id": wf.ID, "owner_id": r.owner.ID, "staff": map[string][]string{"start": {r.owner.ID}, "mid": {r.owner.ID}}}))
	if res := lastResult(t, r); res.IsError {
		t.Fatalf("%+v", res)
	}
}

func TestCompaniesAreKeptApart(t *testing.T) {
	r, m := manageRig(t)
	other, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "別家", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: r.owner.BlueprintID, Name: "Zed", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := r.e.CreateTask(usecase.NewTask{TeamID: other.ID, Title: "別家的任務", WorkflowID: r.flow.ID, OwnerID: &stranger.ID,
		Staff: map[string][]string{"start": {stranger.ID}, "end": {stranger.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	for tool, hidden := range map[string]string{"list_tasks": "別家的任務", "list_employees": "Zed", "list_companies": "別家"} {
		inChat(t, r, m, doing(tool, map[string]any{}))
		if res := lastResult(t, r); strings.Contains(res.Text, hidden) {
			t.Errorf("%s shows %s: %s", tool, hidden, res.Text)
		}
	}
	inChat(t, r, m, doing("update_task", map[string]any{"task_id": theirs.ID, "title": "搶"}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
	if got := r.world().Tasks[theirs.ID].Title; got != "別家的任務" {
		t.Fatal(got)
	}
	inChat(t, r, m, doing("create_task", map[string]any{"team_id": other.ID, "title": "塞", "workflow_id": r.flow.ID, "owner_id": stranger.ID}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
	inChat(t, r, m, doing("create_task", map[string]any{"title": "塞", "workflow_id": r.flow.ID, "owner_id": stranger.ID}))
	if res := lastResult(t, r); !res.IsError {
		t.Fatalf("%+v", res)
	}
	if got := len(r.world().Tasks); got != 1 {
		t.Fatalf("%d tasks", got)
	}

	// the airport's staff reach both, and have to say which
	m.add(doing("list_tasks", map[string]any{}))
	a, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "fake", Text: "看"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("airport", chatDone(a.ID))
	if res := lastResult(t, r); !strings.Contains(res.Text, "別家的任務") {
		t.Fatalf("%+v", res)
	}
	m.add(doing("create_task", map[string]any{"title": "沒說哪家", "workflow_id": r.flow.ID, "owner_id": stranger.ID}))
	if err := r.e.SayInChat(a.ID, "建", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("airport", func(w *model.World) bool { return w.Chats[a.ID].ReplyAt == nil })
	if res := lastResult(t, r); !res.IsError || !strings.Contains(res.Text, "team_id") {
		t.Fatalf("%+v", res)
	}
	m.add(doing("create_task", map[string]any{"team_id": other.ID, "title": "機場建的", "workflow_id": r.flow.ID, "owner_id": stranger.ID,
		"staff": map[string][]string{"start": {stranger.ID}, "end": {stranger.ID}}}))
	if err := r.e.SayInChat(a.ID, "建", nil); err != nil {
		t.Fatal(err)
	}
	w := r.wait("task", func(w *model.World) bool { return len(w.Tasks) == 2 && w.Chats[a.ID].ReplyAt == nil })
	for _, task := range w.Tasks {
		if task.Title == "機場建的" && (task.TeamID != other.ID || task.Origin == nil || task.Origin.Kind != "airport") {
			t.Fatalf("%+v", task)
		}
	}
}

func TestTasksMadeByEmployeesStopAtTheDepthLimit(t *testing.T) {
	r, _ := manageRig(t)
	flow := r.flow.ID
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		// each task's first step makes the next task, and everything else hands on
		if lastIsResult(req) || stepOf(req) != "Clarify requirements" {
			return call("submit_handoff", handoff), nil
		}
		return call("create_task", map[string]any{"title": "接下去", "workflow_id": flow, "owner_id": r.owner.ID}), nil
	}
	r.fake.mu.Unlock()
	r.task(flow)
	w := r.wait("the chain to stop", func(w *model.World) bool {
		for _, task := range w.Tasks {
			// the user starts each task an employee makes
			if task.Paused {
				_ = r.e.ResumeTask(task.ID)
				return false
			}
			if task.Stage != enum.StageAwaitMerge {
				return false
			}
		}
		return len(w.Tasks) >= 4
	})
	if len(w.Tasks) != 4 {
		t.Fatalf("%d tasks", len(w.Tasks))
	}
	deepest := 0
	for _, task := range w.Tasks {
		if task.Origin != nil {
			deepest = max(deepest, task.Origin.Depth)
			if task.Origin.Kind != "employee" || task.Origin.ID != r.owner.ID {
				t.Fatalf("%+v", task.Origin)
			}
		}
	}
	if deepest != 3 {
		t.Fatalf("deepest %d", deepest)
	}
	told := false
	for _, req := range r.fake.requests() {
		for _, msg := range req.Messages {
			for _, b := range msg.Content {
				told = told || (b.Type == enum.BlockToolResult && b.IsError && strings.Contains(b.Text, "the limit is 3"))
			}
		}
	}
	if !told {
		t.Fatal("the model was not told why")
	}
}

func TestUpdateTaskTakesEffectAtOnceAndRefusesWhatCouldNotRun(t *testing.T) {
	r, m := manageRig(t)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	wf := *r.world().Workflows[r.flow.ID]
	wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: "mid", Kind: enum.NodeWork, Name: "中間", ReplicaIDs: []string{r.owner.ID}, Handoff: enum.HandoffAll, Join: enum.JoinAll})
	wf.Edges = []model.WorkflowEdge{{ID: "e1", From: wf.Nodes[0].ID, To: "mid"}, {ID: "e2", From: "mid", To: wf.Nodes[1].ID}}
	if err := r.e.SaveWorkflow(wf.ID, wf); err != nil {
		t.Fatal(err)
	}
	var taskID string
	m.addTask(func(model.ModelRequest) model.ModelReply {
		return call("update_task", map[string]any{"task_id": taskID, "title": "新標題", "description": "新內容", "owner_id": bo.ID, "staff": map[string][]string{"mid": {bo.ID}}})
	})
	r.fake.mu.Lock() // the step cannot ask the model until it knows the task's id
	task := r.task(wf.ID)
	taskID = task.ID
	r.fake.mu.Unlock()
	w := r.wait("the task to end", stage(task.ID, enum.StageAwaitMerge))
	got := w.Tasks[task.ID]
	if got.Title != "新標題" || got.Description != "新內容" || *got.OwnerID != bo.ID {
		t.Fatalf("%+v", got)
	}
	if s := subAt(w, task.ID, "中間"); s == nil || *s.ReplicaID != bo.ID {
		t.Fatalf("%+v", s)
	}
	text := func(req model.ModelRequest) string {
		raw, _ := json.Marshal(req.Messages)
		return req.System + string(raw)
	}
	seen := r.fake.requests()
	if first := text(seen[0]); !strings.Contains(first, "加功能") || strings.Contains(first, "新標題") {
		t.Fatal("the step under way was told something else")
	}
	later := false
	for _, req := range seen {
		later = later || stepOf(req) == "中間" && strings.Contains(text(req), "新標題") && strings.Contains(text(req), "新內容")
	}
	if !later {
		t.Fatal("the later step did not see the change")
	}
	for name, args := range map[string]map[string]any{
		"blank title":  {"task_id": task.ID, "title": " "},
		"no such step": {"task_id": task.ID, "staff": map[string][]string{"nope": {bo.ID}}},
		"nobody":       {"task_id": task.ID, "staff": map[string][]string{"mid": {}}},
		"stranger":     {"task_id": task.ID, "staff": map[string][]string{"mid": {"nobody"}}},
		"no owner":     {"task_id": task.ID, "owner_id": "nobody"},
		"no task":      {"task_id": "nope", "title": "x"},
		"no change":    {"task_id": task.ID},
	} {
		inChat(t, r, m, doing("update_task", args))
		if res := lastResult(t, r); !res.IsError {
			t.Errorf("%s: %+v", name, res)
		}
	}
	after := r.world().Tasks[task.ID]
	if after.Title != "新標題" || len(nodeStaff(after, "mid")) != 1 {
		t.Fatalf("%+v", after)
	}
}

func nodeStaff(t *model.Task, id string) []string {
	for _, n := range t.Workflow.Nodes {
		if n.ID == id {
			return n.ReplicaIDs
		}
	}
	return nil
}

// An employee's own settings are theirs alone: no one else is hired from them, and they go when the employee does.
func TestCustomEmployeeOwnsTheirSettings(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	custom := &model.Blueprint{Name: "ignored", Prompt: "你是寫手", Tools: []enum.Tool{enum.ToolReadFile}, From: r.owner.BlueprintID}
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Custom: custom})
	if err != nil {
		t.Fatal(err)
	}
	own := r.world().Blueprints[bo.BlueprintID]
	if own == nil || own.Owner != bo.ID || own.Name != "Bo" || own.Prompt != "你是寫手" || own.From != r.owner.BlueprintID {
		t.Fatalf("%+v", own)
	}
	if _, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: own.ID, Name: "Cy", Model: "fake"}); err == nil {
		t.Fatal("hired someone from another's own settings")
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{BlueprintID: &own.ID}); err == nil {
		t.Fatal("moved someone onto another's own settings")
	}
	// rewriting them keeps the same ones
	if err := r.e.UpdateReplica(bo.ID, usecase.ReplicaPatch{Custom: &model.Blueprint{Prompt: "改過"}}); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Replicas[bo.ID].BlueprintID; got != own.ID || r.world().Blueprints[got].Prompt != "改過" {
		t.Fatalf("%s %+v", got, r.world().Blueprints[got])
	}
	// back to a blueprint: their own go
	if err := r.e.UpdateReplica(bo.ID, usecase.ReplicaPatch{BlueprintID: &r.owner.BlueprintID}); err != nil {
		t.Fatal(err)
	}
	if r.world().Blueprints[own.ID] != nil {
		t.Fatal("their own settings outlived them")
	}
	if err := r.e.UpdateReplica(bo.ID, usecase.ReplicaPatch{Custom: &model.Blueprint{Prompt: "再一次"}}); err != nil {
		t.Fatal(err)
	}
	again := r.world().Replicas[bo.ID].BlueprintID
	if err := r.e.Fire(bo.ID, r.owner.ID); err != nil {
		t.Fatal(err)
	}
	if r.world().Blueprints[again] != nil {
		t.Fatal("their own settings outlived them")
	}
}
