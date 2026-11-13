package usecase_test

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// A blueprint employees were made from, in any company, is deleted by moving them all to another one in the same change.
func TestDeletingABlueprintInUseMovesItsEmployees(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		return call("submit_handoff", handoff), nil
	})
	ctx := context.Background()
	bp := r.owner.BlueprintID
	other, err := r.e.CreateTeam(ctx, usecase.NewTeam{Name: "另一間", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: other.ID, BlueprintID: bp, Name: "Bo", Model: "fake", Effort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	cy, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Cy", Model: "fake", Custom: &model.Blueprint{Prompt: "自己的"}})
	if err != nil {
		t.Fatal(err)
	}
	to, err := r.e.CreateBlueprint(model.Blueprint{Name: "Reviewer", Prompt: "你是審查者"})
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := r.e.CreateBlueprint(model.Blueprint{Name: "Hidden", Prompt: "藏起來"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.HideBlueprint(hidden.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := r.e.HideBlueprint(bp, true); err != nil { // a hidden one can still be deleted
		t.Fatal(err)
	}
	own := cy.BlueprintID
	before := r.world()

	// nothing changes when a check fails
	for _, c := range []struct{ name, id, to, code string }{
		{"no target", bp, "", model.CodeConflict},
		{"itself", bp, bp, model.CodeInvalid},
		{"missing", bp, "bp-none", model.CodeNotFound},
		{"own settings", bp, own, model.CodeNotFound},
		{"airport", bp, "preset-airport", model.CodeNotFound},
		{"hidden", bp, hidden.ID, model.CodeInvalid},
		{"delete own settings", own, to.ID, model.CodeNotFound},
		{"missing blueprint", "bp-none", to.ID, model.CodeNotFound},
		{"built-in", "preset-airport", to.ID, model.CodeConflict},
	} {
		err := r.e.DeleteBlueprint(c.id, c.to)
		projectCode(t, err, c.code)
		w := r.world()
		if w.Blueprints[bp] == nil || w.Blueprints[own] == nil || w.Blueprints["preset-airport"] == nil {
			t.Fatalf("%s: a blueprint was deleted", c.name)
		}
		for id, rep := range before.Replicas {
			if w.Replicas[id].BlueprintID != rep.BlueprintID {
				t.Fatalf("%s: %s was moved", c.name, rep.Name)
			}
		}
	}
	if err := r.e.DeleteBlueprint(bp, ""); err == nil || !strings.Contains(err.Error(), "還有員工是用這個藍圖建立的") {
		t.Fatalf("got %v", err)
	}

	if err := r.e.DeleteBlueprint(bp, to.ID); err != nil {
		t.Fatal(err)
	}
	w := r.world()
	if w.Blueprints[bp] != nil || slices.Contains(w.Preferences.HiddenBlueprints, bp) {
		t.Fatalf("the blueprint is still there: %+v", w.Preferences.HiddenBlueprints)
	}
	for _, id := range []string{r.owner.ID, bo.ID} {
		got, was := *w.Replicas[id], *before.Replicas[id]
		if got.BlueprintID != to.ID {
			t.Fatalf("%s is on %s", got.Name, got.BlueprintID)
		}
		got.BlueprintID = was.BlueprintID
		if a, b := copyOf(got), copyOf(was); !reflect.DeepEqual(a, b) {
			t.Fatalf("%s changed: %+v, was %+v", got.Name, got, was)
		}
	}
	if w.Replicas[cy.ID].BlueprintID != own || w.Blueprints[own] == nil {
		t.Fatal("someone on their own settings was moved")
	}
	// a second try finds nothing to delete
	projectCode(t, r.e.DeleteBlueprint(bp, to.ID), model.CodeNotFound)

	// work from now on is by the new blueprint
	r.task(r.flow.ID)
	r.wait("a step asked", func(*model.World) bool { return len(r.fake.requests()) > 0 })
	if system := r.fake.requests()[0].System; !strings.Contains(system, "你是審查者") || strings.Contains(system, "你是開發者") {
		t.Fatalf("not on the new blueprint:\n%s", system)
	}
}

// With no one on it, a blueprint is deleted as before, whatever to says.
func TestDeletingABlueprintNoOneUses(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say(""), nil })
	b, err := r.e.CreateBlueprint(model.Blueprint{Name: "Spare"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.DeleteBlueprint(b.ID, "bp-none"); err != nil {
		t.Fatal(err)
	}
	if r.world().Blueprints[b.ID] != nil {
		t.Fatal("not deleted")
	}
}
