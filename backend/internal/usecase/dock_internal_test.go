package usecase

import (
	"fmt"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func dockEngine(t *testing.T, teams int) *Engine {
	t.Helper()
	e := landmarkEngine()
	for i := range teams {
		id := fmt.Sprintf("team-%d", i+1)
		e.w.Teams[id] = &model.Team{ID: id, Plot: e.defaultPlot(), CreatedAt: float64(i)}
	}
	return e
}

// isLand is whether the cell is land on the island as it stands.
func isLand(l plotLand, x, z int) bool {
	cx, cz := x+l.cols/2, z+l.rows/2
	return cx >= 0 && cz >= 0 && cx < l.cols && cz < l.rows && l.cells[l.index(x, z)]
}

// The pier grows on the coast: its harbour is sea, open on the sea beyond, its quay land; nothing stands in the way
// out to sea from it.
func TestDockStandsOnTheCoast(t *testing.T) {
	t.Parallel()
	e := dockEngine(t, 3)
	e.growLandmarks()
	l := e.w.Landmarks[model.LandmarkDock]
	if l == nil {
		t.Fatal("no pier with three companies")
	}
	d := dockSpot{l.At, l.Face}
	land := e.currentPlotLand()
	h := d.harbour()
	for z := h.z; z < h.z+h.d; z++ {
		for x := h.x; x < h.x+h.w; x++ {
			if isLand(land, x, z) {
				t.Fatalf("harbour cell %d,%d is land; pier %+v", x, z, l)
			}
		}
	}
	// the quay, the row in front of the harbour, is land, as is the way in
	quay := d.on(plotRect{0, quayRow, plotCells, plotCells - quayRow})
	for z := quay.z; z < quay.z+quay.d; z++ {
		for x := quay.x; x < quay.x+quay.w; x++ {
			if !isLand(land, x, z) {
				t.Fatalf("quay cell %d,%d is sea; pier %+v", x, z, l)
			}
		}
	}
	// past the harbour, out to the edge of the land, there is only sea
	bx, bz := backOf(d.face)
	mx, mz := h.x+h.w/2, h.z+h.d/2
	for step := 0; step < land.cols+land.rows; step++ {
		if isLand(land, mx+bx*step, mz+bz*step) {
			t.Fatalf("land at %d,%d out from the harbour; pier %+v", mx+bx*step, mz+bz*step, l)
		}
	}
	if !e.laneClear(d.lane(), land) {
		t.Fatal("something stands in the pier's lane")
	}
}

// No company may stand in the way out to sea from the pier, nor the staffing agency.
func TestNothingStandsInThePiersLane(t *testing.T) {
	t.Parallel()
	e := dockEngine(t, 3)
	e.growLandmarks()
	l := e.w.Landmarks[model.LandmarkDock]
	d := dockSpot{l.At, l.Face}
	bx, bz := backOf(d.face)
	// a plot's length out to sea beyond the harbour, on a line with the pier
	at := []int{l.At[0] + bx*(plotCells+landPadding), l.At[1] + bz*(plotCells+landPadding)}
	land := e.currentPlotLand()
	conflict := func() error { return model.Errorf(model.CodeConflict, "overlap") }
	bad := func() error { return model.Errorf(model.CodeInvalid, "bad") }
	if err := e.checkSpotOnLand("team-1", at, land, bad, conflict); err == nil {
		t.Fatalf("a company moved into the pier's lane at %v", at)
	}
	if err := e.MoveStaffing(at); err == nil {
		t.Fatalf("the staffing agency moved into the pier's lane at %v", at)
	}
	for _, plot := range e.w.Teams {
		if overlapsPlot(plotRect{plot.Plot.At[0], plot.Plot.At[1], plotCells, plotCells}, d.lane(), landPadding) {
			t.Fatalf("company at %v in the lane", plot.Plot.At)
		}
	}
	// a company founded after the pier keeps out of its lane too
	if at := e.firstFreePlot(); overlapsPlot(plotRect{at[0], at[1], plotCells, plotCells}, d.lane(), landPadding) {
		t.Fatalf("a new company handed a plot in the lane at %v", at)
	}
}

// A pier saved inside the island, before piers stood on the coast, goes to the coast the next time the island grows.
func TestOldDockMovesToTheCoast(t *testing.T) {
	t.Parallel()
	e := dockEngine(t, 3)
	e.growLandmarks()
	l := e.w.Landmarks[model.LandmarkDock]
	// three companies in a row from the middle: put the pier between them, its lane through one of them
	inside := []int{e.w.Teams["team-1"].Plot.At[0], e.w.Teams["team-1"].Plot.At[1] - plotCells - reservedGap}
	e.w.Landmarks[model.LandmarkDock] = &model.Landmark{Kind: l.Kind, Stage: l.Stage, At: inside, CreatedAt: l.CreatedAt}
	if e.laneClear(dockSpot{inside, 0}.lane(), e.currentPlotLand()) {
		t.Skip("the spot inside the island happens to face open sea")
	}
	e.growLandmarks()
	moved := e.w.Landmarks[model.LandmarkDock]
	if !e.laneClear(dockSpot{moved.At, moved.Face}.lane(), e.currentPlotLand()) {
		t.Fatalf("the pier still faces land: %+v", moved)
	}
	if moved.Stage != l.Stage {
		t.Fatalf("the pier's stage changed: %+v", moved)
	}
}

// Moving the pier turns it to face open sea there; it can't go where no way does.
func TestMoveDockTurnsIt(t *testing.T) {
	t.Parallel()
	e := dockEngine(t, 3)
	e.growLandmarks()
	land := e.currentPlotLand()
	// the first spot from the middle out where only a turn away from -z faces open sea
	var to []int
	var face int
	for radius := 1; radius <= 8 && to == nil; radius++ {
		for _, at := range [][]int{{radius*18 - 8, -8}, {-radius*18 - 8, -8}, {-8, radius*18 - 8}} {
			if q, ok := e.placeDock(at, land); ok && q != 0 {
				to, face = at, q
				break
			}
		}
	}
	if to == nil {
		t.Fatal("nowhere for the pier to turn")
	}
	if err := e.moveLandmark(model.LandmarkDock, to); err != nil {
		t.Fatal(err)
	}
	if l := e.w.Landmarks[model.LandmarkDock]; l.Face != face || l.At[0] != to[0] || l.At[1] != to[1] {
		t.Fatalf("moved pier %+v, want at %v facing %d", l, to, face)
	}
	// into the middle of the companies, where every way is land
	if err := e.moveLandmark(model.LandmarkDock, e.w.Teams["team-1"].Plot.At); err == nil {
		t.Fatal("the pier moved onto a company")
	}
}

// Turning a plot-sized ground a whole turn round brings every cell back, and its back faces each way in turn.
func TestTurnCell(t *testing.T) {
	t.Parallel()
	x, z := 3, 11
	for range 4 {
		x, z = turnCell(1, x, z)
	}
	if x != 3 || z != 11 {
		t.Fatalf("four quarter turns: %d,%d", x, z)
	}
	// the harbour, at the back, goes to the side its back faces
	for q := range 4 {
		h := dockSpot{[]int{0, 0}, q}.harbour()
		bx, bz := backOf(q)
		cx, cz := float64(h.x)+float64(h.w)/2-plotCells/2, float64(h.z)+float64(h.d)/2-plotCells/2
		if cx*float64(bx)+cz*float64(bz) <= 0 {
			t.Fatalf("turned %d, harbour %+v isn't at the back (%d,%d)", q, h, bx, bz)
		}
	}
}
