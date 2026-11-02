package usecase_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
)

func TestTutorialIsKeptInItsOwnFile(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	yes := true
	if err := r.e.UpdateTutorial(model.TutorialPatch{Seeded: &yes, Done: []string{"provider", "company"}, Shown: []string{"provider"}}); err != nil {
		t.Fatal(err)
	}
	// lists only grow: a second window adding the same items changes nothing
	if err := r.e.UpdateTutorial(model.TutorialPatch{Done: []string{"company"}}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateTutorial(model.TutorialPatch{Done: []string{"../x"}}); err == nil {
		t.Fatal("accepted an invalid step id")
	}
	raw, err := os.ReadFile(filepath.Join(r.data, "tutorial.yaml"))
	if err != nil || !strings.Contains(string(raw), "seeded: true") || !strings.Contains(string(raw), "- company") {
		t.Fatalf("tutorial YAML: %s %v", raw, err)
	}
	newEngine(t, r)
	got := r.world().Tutorial
	if !got.Seeded || !slices.Equal(got.Done, []string{"provider", "company"}) || !slices.Equal(got.Shown, []string{"provider"}) {
		t.Fatalf("after restart: %+v", got)
	}
	if err := r.e.UpdateTutorial(model.TutorialPatch{Reset: true}); err != nil {
		t.Fatal(err)
	}
	if got := r.world().Tutorial; got.Seeded || len(got.Done) != 0 || got.Done == nil {
		t.Fatalf("after reset: %+v", got)
	}
}

func TestTutorialCountsChangingACopiedFlow(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	// saving a flow that was not copied is not it
	if err := r.e.SaveWorkflow(r.flow.ID, *r.flow); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r.world().Tutorial.Actions, "copyFlow") {
		t.Fatal("counted a flow that was not copied")
	}
	copied, err := r.e.DuplicateWorkflow(r.flow.ID)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r.world().Tutorial.Actions, "copyFlow") {
		t.Fatal("counted copying alone")
	}
	copied.Name = "改過的"
	if err := r.e.SaveWorkflow(copied.ID, *copied); err != nil {
		t.Fatal(err)
	}
	got := r.world().Tutorial
	if !slices.Contains(got.Actions, "copyFlow") || slices.Contains(got.Copies, copied.ID) {
		t.Fatalf("tutorial: %+v", got)
	}
}

func TestTutorialCountsSoundSettings(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"shadows": json.RawMessage(`false`)}); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r.world().Tutorial.Actions, "sound") {
		t.Fatal("counted a preference that is not about sound")
	}
	if err := r.e.UpdatePreferences(map[string]json.RawMessage{"musicVolume": json.RawMessage(`40`)}); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r.world().Tutorial.Actions, "sound") {
		t.Fatal("sound settings not counted")
	}
}
