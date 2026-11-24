package usecase_test

import (
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// A paired computer's company stands on this island as a ghost: kept over a restart, once per company, on land of its
// own that companies founded later keep clear of; moved and taken away here alone.
func TestGhostCompanies(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	beside := &model.Plot{At: []int{r.team.Plot.At[0] + 18, r.team.Plot.At[1]}, Style: "castle", Seed: 7}

	if _, err := r.e.CreateGhost(usecase.NewGhost{PeerID: "peer-1", TeamID: "team-9", Name: "Acme", Plot: &model.Plot{At: r.team.Plot.At, Style: "castle"}}); codeOf(err) != model.CodeConflict {
		t.Fatalf("stood on a company's plot: %v", err)
	}
	for _, bad := range []usecase.NewGhost{
		{TeamID: "team-9", Name: "Acme", Plot: beside},
		{PeerID: "peer-1", Name: "Acme", Plot: beside},
		{PeerID: "peer-1", TeamID: "team-9", Name: "  ", Plot: beside},
		{PeerID: "peer-1", TeamID: "team-9", Name: "A\ncme", Plot: beside},
		{PeerID: "peer-1", TeamID: "team-9", Name: "Acme"},
		{PeerID: "peer-1", TeamID: "team-9", Name: "Acme", Plot: &model.Plot{At: beside.At, Style: "nope"}},
	} {
		if _, err := r.e.CreateGhost(bad); codeOf(err) != model.CodeInvalid {
			t.Fatalf("accepted %+v: %v", bad, err)
		}
	}

	g, err := r.e.CreateGhost(usecase.NewGhost{PeerID: " peer-1 ", TeamID: "team-9", Name: " Acme ", Plot: beside})
	if err != nil {
		t.Fatal(err)
	}
	if g.PeerID != "peer-1" || g.Name != "Acme" || !reflect.DeepEqual(g.Plot, beside) {
		t.Fatalf("ghost: %+v", g)
	}
	if _, err := r.e.CreateGhost(usecase.NewGhost{PeerID: "peer-1", TeamID: "team-9", Name: "Acme", Plot: &model.Plot{At: []int{beside.At[0] + 18, beside.At[1]}, Style: "hut"}}); codeOf(err) != model.CodeConflict {
		t.Fatalf("the same company twice: %v", err)
	}
	// companies founded later keep off its land
	if _, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "B", Folder: t.TempDir(), Plot: &model.Plot{At: beside.At, Style: "hut"}}); codeOf(err) != model.CodeConflict {
		t.Fatalf("a company founded on the ghost's land: %v", err)
	}
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Plot: &model.Plot{At: beside.At, Style: "hut"}}); codeOf(err) != model.CodeConflict {
		t.Fatalf("a company moved onto the ghost's land: %v", err)
	}

	moved := &model.Plot{At: []int{beside.At[0], beside.At[1] + 18}, Style: "castle", Seed: 7}
	name := "Acme 2"
	if err := r.e.UpdateGhost(g.ID, usecase.GhostPatch{Plot: moved, Name: &name}); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateGhost(g.ID, usecase.GhostPatch{Plot: &model.Plot{At: r.team.Plot.At, Style: "castle"}}); codeOf(err) != model.CodeConflict {
		t.Fatalf("moved onto a company: %v", err)
	}
	if err := r.e.UpdateGhost("ghost-0", usecase.GhostPatch{Name: &name}); codeOf(err) != model.CodeNotFound {
		t.Fatalf("changed a ghost not there: %v", err)
	}

	r.e.Close()
	newEngine(t, r)
	kept := r.world().Ghosts[g.ID]
	if kept == nil || kept.Name != "Acme 2" || !reflect.DeepEqual(kept.Plot, moved) || kept.TeamID != "team-9" {
		t.Fatalf("restart lost the ghost: %+v", kept)
	}
	if err := r.e.DeleteGhost(g.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.e.DeleteGhost(g.ID); codeOf(err) != model.CodeNotFound {
		t.Fatalf("deleted twice: %v", err)
	}
	r.e.Close()
	newEngine(t, r)
	if len(r.world().Ghosts) != 0 {
		t.Fatal("a ghost taken away came back")
	}
}
