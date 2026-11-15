package usecase_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// disbandRig is a company with Ada (its owner, in the shared flow), Bo (with settings of his own) and Cy, each with a
// note of their own; Hal from the staffing agency who helps there; a note of the company's and a chat with Bo.
type disbandRig struct {
	*rig
	bo, cy, hal *model.Replica
	boBlueprint string
	chatID      string
}

func newDisbandRig(t *testing.T) disbandRig {
	t.Helper()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	d := disbandRig{rig: r}
	hire := func(in usecase.NewReplica) *model.Replica {
		t.Helper()
		x, err := r.e.Hire(in)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	d.bo = hire(usecase.NewReplica{TeamID: r.team.ID, Name: "Bo", Model: "fake", Effort: "high",
		Custom: &model.Blueprint{Prompt: "Bo 的設定", Tools: []enum.Tool{enum.ToolReadFile}}})
	d.cy = hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Cy", Model: "fake"})
	d.hal = hire(usecase.NewReplica{TeamID: model.StaffingID, BlueprintID: r.owner.BlueprintID, Name: "Hal", Model: "fake"})
	d.boBlueprint = d.bo.BlueprintID
	for _, x := range []*model.Replica{r.owner, d.bo, d.cy, d.hal} {
		r.e.Remember(x.ID, x.Name+" 自己的事")
	}
	r.e.RememberFor(r.team.ID, d.bo.ID, "公司的事")
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: d.bo.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	d.chatID = c.ID
	return d
}

// agency is who is at the staffing agency, by name.
func agency(w *model.World) map[string]*model.Replica {
	out := map[string]*model.Replica{}
	for _, r := range w.Replicas {
		if r.TeamID == model.StaffingID {
			out[r.Name] = r
		}
	}
	return out
}

// Closing a company moves those picked to the staffing agency, as new hires with their own notes and settings; the
// rest go, as do the company's notes and chats. Whoever helped from the agency is not touched. It stays so after a
// restart.
func TestDeletingACompanyMovesThosePickedToTheAgency(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name string
		keep func(d disbandRig) []string
		want []string
	}{
		{"none", func(disbandRig) []string { return nil }, nil},
		{"some", func(d disbandRig) []string { return []string{d.bo.ID, d.owner.ID} }, []string{"Ada", "Bo"}},
		{"all", func(d disbandRig) []string { return []string{d.cy.ID, d.bo.ID, d.owner.ID} }, []string{"Ada", "Bo", "Cy"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			d := newDisbandRig(t)
			before := d.world()
			if err := d.e.DeleteTeam(d.team.ID, c.keep(d)); err != nil {
				t.Fatal(err)
			}
			check := func(w *model.World) {
				t.Helper()
				if w.Teams[d.team.ID] != nil || w.Chats[d.chatID] != nil {
					t.Fatalf("the company or its chat is still there")
				}
				staff := agency(w)
				if len(staff) != len(c.want)+1 || len(w.Replicas) != len(c.want)+1 {
					t.Fatalf("at the agency: %v; everyone: %v", staff, w.Replicas)
				}
				if hal := w.Replicas[d.hal.ID]; hal == nil || !slices.Equal(hal.Memory, before.Replicas[d.hal.ID].Memory) {
					t.Fatalf("Hal changed: %+v", hal)
				}
				for _, name := range c.want {
					moved := staff[name]
					var old *model.Replica
					for _, x := range before.Replicas {
						if x.Name == name {
							old = x
						}
					}
					if moved == nil || moved.ID == old.ID || moved.Look != old.Look || moved.Model != old.Model || moved.Effort != old.Effort ||
						!slices.Equal(moved.Memory, old.Memory) || len(moved.Memory) != 1 {
						t.Fatalf("%s moved as %+v, was %+v", name, moved, old)
					}
				}
				if bo := staff["Bo"]; bo != nil {
					bp := w.Blueprints[bo.BlueprintID]
					if bp == nil || bp.Owner != bo.ID || bp.Prompt != "Bo 的設定" {
						t.Fatalf("Bo's own settings: %+v", bp)
					}
				}
				if w.Blueprints[d.boBlueprint] != nil {
					t.Fatal("Bo's old settings were left behind")
				}
				// flows keep no one who is gone, and do not pick up anyone new either
				for _, n := range w.Workflows[d.flow.ID].Nodes {
					for _, id := range n.ReplicaIDs {
						if w.Replicas[id] == nil || w.Replicas[id].TeamID == model.StaffingID {
							t.Fatalf("flow step %s names %s", n.ID, id)
						}
					}
				}
			}
			check(d.world())
			d.e.Close()
			d.store.Close()
			newEngine(t, d.rig)
			check(d.world())
		})
	}
}

// Anyone picked who is not one of the company's own fails it, and nothing changes: not the company, not its people,
// not whoever was named first.
func TestDeletingACompanyChecksWhoIsPickedFirst(t *testing.T) {
	t.Parallel()
	d := newDisbandRig(t)
	other := secondTeam(t, d.rig)
	var cy2 string
	for _, x := range d.world().Replicas {
		if x.TeamID == other.ID {
			cy2 = x.ID
		}
	}
	before := d.world()
	for _, c := range []struct {
		name string
		keep []string
		code string
	}{
		{"nobody", []string{d.bo.ID, "rep-nope"}, model.CodeInvalid},
		{"empty", []string{d.bo.ID, ""}, model.CodeInvalid},
		{"another company's", []string{d.bo.ID, cy2}, model.CodeInvalid},
		{"the agency's", []string{d.bo.ID, d.hal.ID}, model.CodeInvalid},
		{"twice", []string{d.bo.ID, d.cy.ID, d.bo.ID}, model.CodeInvalid},
	} {
		var e *model.Error
		if err := d.e.DeleteTeam(d.team.ID, c.keep); !errors.As(err, &e) || e.Code != c.code {
			t.Fatalf("%s: %v", c.name, err)
		}
		w := d.world()
		if w.Teams[d.team.ID] == nil || len(w.Replicas) != len(before.Replicas) || w.Replicas[d.bo.ID] == nil || w.Chats[d.chatID] == nil ||
			len(w.Teams[d.team.ID].Memory) != 1 || w.Blueprints[d.boBlueprint] == nil {
			t.Fatalf("%s changed the world", c.name)
		}
	}
	var e *model.Error
	if err := d.e.DeleteTeam("team-nope", nil); !errors.As(err, &e) || e.Code != model.CodeNotFound {
		t.Fatalf("no such company: %v", err)
	}
}

// A close the disk does not take changes nothing, then or after a restart.
func TestDeletingACompanyThatCannotBeSavedChangesNothing(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	bo, err := r.e.Hire(usecase.NewReplica{TeamID: r.team.ID, BlueprintID: r.owner.BlueprintID, Name: "Bo", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	r.e.Remember(bo.ID, "Bo 自己的事")
	before := r.world()
	disk.broken.Store(true)
	if err := r.e.DeleteTeam(r.team.ID, []string{bo.ID}); err == nil {
		t.Fatal("a close that was not saved went through")
	}
	same := func(w *model.World) {
		t.Helper()
		if w.Teams[r.team.ID] == nil || len(w.Replicas) != len(before.Replicas) || w.Replicas[bo.ID] == nil ||
			!slices.Equal(w.Replicas[bo.ID].Memory, before.Replicas[bo.ID].Memory) || len(agency(w)) != 0 {
			t.Fatalf("changed: %+v", w.Replicas)
		}
	}
	same(r.world())
	disk.broken.Store(false)
	reopen()
	same(r.world())
}
