package usecase_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// toolText is what the employee of a new chat is told a tool did.
func toolText(t *testing.T, r *rig, m *moves, name string, args map[string]any) model.Block {
	t.Helper()
	inChat(t, r, m, doing(name, args))
	return lastResult(t, r)
}

func TestHiddenBlueprintsAndFlowsAreUnknownToEmployees(t *testing.T) {
	t.Parallel()
	r, m := manageRig(t)
	bp, wf := r.owner.BlueprintID, r.flow.ID
	waiting, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "排好的", WorkflowID: wf, OwnerID: &r.owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	version := versionFrom(t, r, m, "read_blueprint", bp)
	flowVersion := versionFrom(t, r, m, "read_workflow", wf)
	if err := r.e.HideBlueprint(bp, true); err != nil {
		t.Fatal(err)
	}
	if err := r.e.HideWorkflow(wf, true); err != nil {
		t.Fatal(err)
	}

	if text := toolText(t, r, m, "list_blueprints", map[string]any{}).Text; strings.Contains(text, `"`+bp+`"`) {
		t.Fatal("a hidden blueprint is listed")
	}
	if text := toolText(t, r, m, "list_workflows", map[string]any{}).Text; strings.Contains(text, `"`+wf+`"`) {
		t.Fatal("a hidden flow is listed")
	}
	// told just what an id that is not there gets, so nothing gives away that it exists
	for name, pair := range map[string][2]map[string]any{
		"save_blueprint": {{"id": bp, "version": version, "prompt": "改"}, {"id": "bp-none", "version": version, "prompt": "改"}},
		"save_workflow":  {{"id": wf, "version": flowVersion, "name": "改"}, {"id": "wf-none", "version": flowVersion, "name": "改"}},
		"create_task":    {{"title": "新", "workflow_id": wf, "owner_id": r.owner.ID}, {"title": "新", "workflow_id": "wf-none", "owner_id": r.owner.ID}},
	} {
		hidden := toolText(t, r, m, name, pair[0])
		missing := toolText(t, r, m, name, pair[1])
		if !hidden.IsError || hidden.Text != missing.Text {
			t.Errorf("%s on a hidden one: %+v, on a missing one: %+v", name, hidden, missing)
		}
	}
	w := r.world()
	if len(w.Tasks) != 1 || w.Blueprints[bp].Prompt != "你是開發者" || w.Workflows[wf].Name != r.flow.Name {
		t.Fatalf("a hidden one was used or changed: %d tasks, %+v", len(w.Tasks), w.Blueprints[bp])
	}
	for _, c := range w.Chats {
		if c.Change != nil {
			t.Fatal("a change to a hidden one waits for the user")
		}
	}

	// what is already on them goes on: the employee on the hidden blueprint answered every chat above, and a task
	// on the hidden flow starts
	if err := r.e.ResumeTask(waiting.ID); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tasks[waiting.ID]; got.Paused || got.WorkflowID != wf {
		t.Fatalf("%+v", got)
	}
}

func TestHiddenCannotBePickedButStaysInUse(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	bp, wf := r.owner.BlueprintID, r.flow.ID
	other, err := r.e.CreateBlueprint(model.Blueprint{Name: "Other", Prompt: "另一個"})
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range []error{r.e.HideBlueprint(bp, true), r.e.HideBlueprint(other.ID, true), r.e.HideWorkflow(wf, true)} {
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: bp, Name: "Bo", Model: "fake"}); err == nil {
		t.Fatal("hired from a hidden blueprint")
	}
	if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "新", WorkflowID: wf, OwnerID: &r.owner.ID}); err == nil {
		t.Fatal("made a task on a hidden flow")
	}
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{BlueprintID: &other.ID}); err == nil {
		t.Fatal("moved an employee onto a hidden blueprint")
	}
	// one already on it keeps it through an edit, and the user still edits what is hidden
	name := "Ada Lovelace"
	if err := r.e.UpdateReplica(r.owner.ID, usecase.ReplicaPatch{Name: &name, BlueprintID: &bp}); err != nil {
		t.Fatal(err)
	}
	edited := *r.world().Blueprints[bp]
	edited.Prompt = "改過"
	if err := r.e.SaveBlueprint(bp, edited); err != nil {
		t.Fatal(err)
	}
	if err := r.e.HideBlueprint("preset-airport", true); err == nil {
		t.Fatal("hid the airport staff's blueprint")
	}

	// kept over a restart
	r.e.Close()
	newEngine(t, r)
	prefs := r.world().Preferences
	if !slices.Contains(prefs.HiddenBlueprints, bp) || !slices.Contains(prefs.HiddenWorkflows, wf) {
		t.Fatalf("%+v", prefs)
	}

	// shown again, it can be picked again; deleted, it leaves the list
	if err := r.e.HideWorkflow(wf, false); err != nil {
		t.Fatal(err)
	}
	if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "新", WorkflowID: wf, OwnerID: &r.owner.ID}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.DeleteBlueprint(other.ID, ""); err != nil {
		t.Fatal(err)
	}
	prefs = r.world().Preferences
	if len(prefs.HiddenWorkflows) != 0 || !slices.Equal(prefs.HiddenBlueprints, []string{bp}) {
		t.Fatalf("%+v", prefs)
	}
}
