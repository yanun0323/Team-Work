package usecase_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// Tasks finished before the island grew landmarks grow the park when the server starts; the park is saved, kept as it
// is over the next restart, and the profile shows how far along its road it is, with every other landmark's.
func TestParkGrownOnStartAndKept(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if err := r.e.AddFinishedTasks(r.team.ID, 12); err != nil {
		t.Fatal(err)
	}
	if len(r.world().Landmarks) != 0 {
		t.Fatal("a park before the server started again")
	}

	r.e.Close()
	newEngine(t, r)
	park := r.world().Landmarks[model.LandmarkPark]
	if park == nil || park.Stage != 1 || len(park.At) != 2 || reflect.DeepEqual(park.At, r.team.Plot.At) {
		t.Fatalf("park: %+v", park)
	}
	stats, err := r.e.ProfileStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, road := range stats.Landmarks {
		kinds = append(kinds, road.Kind)
	}
	if want := []string{"park", "hill", "pond", "dock", "clock"}; !reflect.DeepEqual(kinds, want) {
		t.Fatalf("roads %v, want %v", kinds, want)
	}
	if want := (model.LandmarkRoad{Kind: model.LandmarkPark, Stage: 1, Value: 12, Steps: []int{10, 50, 200}}); !reflect.DeepEqual(stats.Landmarks[0], want) {
		t.Fatalf("park's road %+v, want %+v", stats.Landmarks[0], want)
	}
	// the tasks were made today: the first day in use
	if hill := stats.Landmarks[1]; hill.Value != 1 || hill.Stage != 0 || !reflect.DeepEqual(hill.Steps, []int{7, 30}) {
		t.Fatalf("hill's road %+v", hill)
	}

	r.e.Close()
	newEngine(t, r)
	if kept := r.world().Landmarks[model.LandmarkPark]; kept == nil || !reflect.DeepEqual(*kept, *park) {
		t.Fatalf("restart changed the park: %+v, was %+v", kept, park)
	}
}

// The third company founded brings the pier at once, on ground of its own, and the first chats count towards the
// fountain.
func TestDockGrowsWithCompanies(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if _, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "B", Folder: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if len(r.world().Landmarks) != 0 {
		t.Fatal("a pier with two companies")
	}
	third, err := r.e.CreateTeam(t.Context(), usecase.NewTeam{Name: "C", Folder: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	dock := r.world().Landmarks[model.LandmarkDock]
	if dock == nil || dock.Stage != 1 || reflect.DeepEqual(dock.At, third.Plot.At) {
		t.Fatalf("dock: %+v", dock)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	stats, err := r.e.ProfileStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pond := stats.Landmarks[2]; pond.Value != 1 {
		t.Fatalf("pond %+v", pond)
	}
}

// A landmark and the staffing agency are moved as a company is, onto clear ground only, and stay there over a
// restart; once moved, the staffing agency's ground is what companies keep clear of.
func TestLandmarkAndStaffingAgencyMove(t *testing.T) {
	t.Parallel()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	if err := r.e.AddFinishedTasks(r.team.ID, 12); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	newEngine(t, r)
	park := r.world().Landmarks[model.LandmarkPark]
	if park == nil {
		t.Fatal("no park")
	}
	code := func(err error) string {
		if m, ok := err.(*model.Error); ok {
			return m.Code
		}
		return ""
	}
	if err := r.e.MoveLandmark(model.LandmarkPark, r.team.Plot.At); code(err) != model.CodeConflict {
		t.Fatalf("park onto the company: %v", err)
	}
	if err := r.e.MoveLandmark(model.LandmarkPark, []int{0, -30}); code(err) != model.CodeInvalid {
		t.Fatalf("park onto the airport: %v", err)
	}
	if err := r.e.MoveLandmark(model.LandmarkHill, park.At); code(err) != model.CodeNotFound {
		t.Fatalf("a hill not grown yet: %v", err)
	}
	to := r.e.FreeSpot()
	if err := r.e.MoveLandmark(model.LandmarkPark, to); err != nil {
		t.Fatal(err)
	}
	// where the park was is free again
	if err := r.e.MoveLandmark(model.LandmarkPark, park.At); err != nil {
		t.Fatalf("back where it was: %v", err)
	}
	if err := r.e.MoveLandmark(model.LandmarkPark, to); err != nil {
		t.Fatal(err)
	}

	// the staffing agency, onto the company, the park or the airport, then onto clear ground beside them
	for _, at := range [][]int{r.team.Plot.At, to, {0, -30}, {600, 0}} {
		if err := r.e.MoveStaffing(at); err == nil {
			t.Fatalf("staffing agency moved onto %v", at)
		}
	}
	free := r.e.FreeSpot()
	if err := r.e.MoveStaffing(free); err != nil {
		t.Fatal(err)
	}
	if err := r.e.UpdateTeam(r.team.ID, usecase.TeamPatch{Plot: &model.Plot{At: free, Style: r.team.Plot.Style}}); err == nil {
		t.Fatal("a company moved onto the staffing agency")
	}
	r.e.Close()
	newEngine(t, r)
	w := r.world()
	if got := w.Places[model.PlaceStaffing]; got == nil || !reflect.DeepEqual(got.At, free) {
		t.Fatalf("staffing agency after a restart: %+v, want %v", got, free)
	}
	if got := w.Landmarks[model.LandmarkPark].At; !reflect.DeepEqual(got, to) {
		t.Fatalf("park after a restart at %v, want %v", got, to)
	}
	// and back where it always stood
	if err := r.e.MoveStaffing([]int{19, -33}); err != nil {
		t.Fatalf("staffing agency back where it stood: %v", err)
	}
}
