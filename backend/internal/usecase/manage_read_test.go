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

// listKeys runs a list tool in a chat and gives the fields of its rows.
func listKeys(t *testing.T, r *rig, m *moves, tool string) (rows []map[string]any, keys []string) {
	t.Helper()
	inChat(t, r, m, doing(tool, map[string]any{}))
	if err := json.Unmarshal([]byte(lastResult(t, r).Text), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatalf("%s listed nothing", tool)
	}
	for _, row := range rows {
		for k := range row {
			if !slices.Contains(keys, k) {
				keys = append(keys, k)
			}
		}
	}
	slices.Sort(keys)
	return rows, keys
}

func TestListsGiveOnlyWhatTellsItemsApart(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "排好的", Description: "很長的說明", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID}); err != nil {
		t.Fatal(err)
	}
	for tool, want := range map[string][]string{
		"list_tasks":      {"id", "number", "stage", "status", "title"},
		"list_blueprints": {"id", "name"},
		"list_workflows":  {"id", "name"},
		"list_employees":  {"id", "name"},
		"list_companies":  {"id", "name"},
		"list_providers":  {"id", "name"},
	} {
		if _, keys := listKeys(t, r, m, tool); !slices.Equal(keys, want) {
			t.Errorf("%s gives %v, want %v", tool, keys, want)
		}
	}

	// the airport's staff reach every company, so are told whose
	m.add(doing("list_tasks", map[string]any{}), doing("list_employees", map[string]any{}))
	a, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "fake", Text: "看"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("airport", chatDone(a.ID))
	for _, res := range lastResults(r) {
		var rows []map[string]any
		if err := json.Unmarshal([]byte(res.Text), &rows); err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 || rows[0]["teamId"] != r.team.ID {
			t.Errorf("%s: %s", res.Name, res.Text)
		}
	}
}

func TestReadToolsGiveItemsInFull(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	task, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "排好的", Description: "很長的說明", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	p := providerNamed(r.world(), "p")
	for _, tc := range []struct {
		tool, id string
		want     []string
	}{
		{"read_task", task.ID, []string{`"description":"很長的說明"`, `"workflowId":"` + r.flow.ID, `"steps":[`, `"ownerId":"` + r.owner.ID, `"paused":true`, "not led by an owner", `"驗收": not run yet`}},
		{"read_blueprint", r.owner.BlueprintID, []string{`"version":"`, `"prompt":"你是開發者"`, `"tools":["readFile"`, `"editable":true`}},
		{"read_workflow", r.flow.ID, []string{`"version":"`, `"nodes":[`, `"edges":[`, `"prompt":"`}},
		{"read_employee", r.owner.ID, []string{`"version":"`, `"teamId":"` + r.team.ID, `"model":"fake"`, `"blueprint":"Dev"`}},
		{"read_company", r.team.ID, []string{`"name":"公司"`, `"folder":"` + r.folder, `"targetBranch":`}},
		{"read_provider", p.ID, []string{`"version":"`, `"models":[`, `"keyHint":"1234"`, `"prices":`}},
	} {
		args := map[string]any{"id": tc.id}
		if tc.tool == "read_task" {
			args = map[string]any{"task_id": tc.id}
		}
		res := toolText(t, r, m, tc.tool, args)
		if res.IsError {
			t.Fatalf("%s: %s", tc.tool, res.Text)
		}
		for _, want := range tc.want {
			if !strings.Contains(res.Text, want) {
				t.Errorf("%s has no %s: %s", tc.tool, want, res.Text)
			}
		}
		if strings.Contains(res.Text, "sk-secret-1234") {
			t.Fatalf("%s shows a key", tc.tool)
		}
	}
}

func TestReadToolsTellUnknownAndUnreachableAlike(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	other, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "別家", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: r.owner.BlueprintID, Name: "Zed", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: other.ID, Title: "別家的任務", WorkflowID: r.flow.ID, OwnerID: &stranger.ID,
		Staff: map[string][]string{"start": {stranger.ID}, "end": {stranger.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := r.e.CreateBlueprint(model.Blueprint{Name: "藏起來", Tools: []enum.Tool{enum.ToolReadFile}})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.HideBlueprint(hidden.ID, true); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ tool, kind, id string }{
		{"read_task", "task", theirs.ID},
		{"read_task", "task", "task-999"},
		{"read_employee", "employee", stranger.ID},
		{"read_employee", "employee", "rep-999"},
		{"read_company", "company", other.ID},
		{"read_company", "company", "team-999"},
		{"read_blueprint", "blueprint", hidden.ID},
		{"read_blueprint", "blueprint", model.PresetPrefix + "airport"},
		{"read_blueprint", "blueprint", "bp-999"},
		{"read_workflow", "workflow", "wf-999"},
		{"read_provider", "provider", "prov-999"},
	} {
		args := map[string]any{"id": tc.id}
		if tc.tool == "read_task" {
			args = map[string]any{"task_id": tc.id}
		}
		res := toolText(t, r, m, tc.tool, args)
		if want := "no " + tc.kind + " " + tc.id; !res.IsError || res.Text != want {
			t.Errorf("%s %s: %+v, want the error %q", tc.tool, tc.id, res, want)
		}
	}

	// the airport's staff reach the other company
	m.add(doing("read_task", map[string]any{"task_id": theirs.ID}))
	a, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: "fake", Text: "看"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("airport", chatDone(a.ID))
	if res := lastResult(t, r); res.IsError || !strings.Contains(res.Text, "別家的任務") {
		t.Fatalf("%+v", res)
	}
}

func TestTheOwnerReadsTasksOfTheirCompanyWithReadTask(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var read []model.Block
	var sibling, theirs string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		if !isOwner(req) {
			return worker(req), nil
		}
		mu.Lock()
		defer mu.Unlock()
		switch last := lastBlock(req); {
		case last.Type == enum.BlockToolResult && last.Name == "read_task":
			read = append(read, last)
			return say("讀完"), nil
		case woken(req, "讀自己"):
			return ownerCall("read_task", map[string]any{}), nil
		case woken(req, "讀隔壁"):
			return ownerCall("read_task", map[string]any{"task_id": sibling}), nil
		case woken(req, "讀別家"):
			return ownerCall("read_task", map[string]any{"task_id": theirs}), nil
		}
		return say("待命"), nil
	})
	other, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "別家", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: r.owner.BlueprintID, Name: "Zed", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	made, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: other.ID, Title: "別家的任務", WorkflowID: r.flow.ID, OwnerID: &stranger.ID,
		Staff: map[string][]string{"start": {stranger.ID}, "end": {stranger.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	next, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "隔壁的任務", Description: "隔壁的說明", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	sibling, theirs = next.ID, made.ID
	mu.Unlock()

	task := r.ownerTask(r.flow.ID)
	r.ownerIdle(task.ID)
	for i, text := range []string{"讀自己", "讀隔壁", "讀別家"} {
		r.tell(task.ID, "req-"+text, text)
		r.wait("read", func(*model.World) bool { mu.Lock(); defer mu.Unlock(); return len(read) > i })
		r.ownerIdle(task.ID)
	}
	mu.Lock()
	defer mu.Unlock()
	if own := read[0]; own.IsError || !strings.Contains(own.Text, "## Plan") || !strings.Contains(own.Text, "# Conversation") || !strings.Contains(own.Text, ": 讀自己") {
		t.Fatalf("own task: %+v", own)
	}
	if next := read[1]; next.IsError || !strings.Contains(next.Text, "隔壁的說明") || !strings.Contains(next.Text, "not led by an owner") {
		t.Fatalf("a task of the same company: %+v", next)
	}
	if far := read[2]; !far.IsError || far.Text != "no task "+theirs {
		t.Fatalf("another company's task: %+v", far)
	}
}
