package usecase

import (
	"slices"

	"github.com/yanun0323/Team-Work/internal/model"
)

// The pier stands on the coast: the back rows of its ground (before it is turned) are the sea, its harbour, and
// nobody's land may come within landPadding of the way from there out to open sea (its lane), so the harbour always
// opens on the sea. Keep in step with QUAY_ROW and HARBOUR in frontend/src/sites.ts and dockLane, facesFrom and
// coastOf in frontend/src/layout.ts.
const quayRow = 9

// laneReach is how far out the lane off the pier's harbour reaches: as far as anything could ever stand.
const laneReach = 4096

// dockID is the pier's plot among the plots shown.
const dockID = "landmark:" + model.LandmarkDock

// dockSpot is the pier's ground: its corner, and the way it faces (model.Landmark.Face).
type dockSpot struct {
	at   []int
	face int
}

func grow(r plotRect, by int) plotRect {
	return plotRect{r.x - by, r.z - by, r.w + by*2, r.d + by*2}
}

// turnCell is where a cell of a plot-sized ground goes, turned q quarter turns so its back (-z) faces +x, then +z,
// then -x. Cells outside the ground turn with it.
func turnCell(q, x, z int) (int, int) {
	n := plotCells - 1
	switch ((q % 4) + 4) % 4 {
	case 1:
		return n - z, x
	case 2:
		return n - x, n - z
	case 3:
		return z, n - x
	}
	return x, z
}

// turnRect is a rectangle of a plot-sized ground's cells, turned as turnCell turns them.
func turnRect(q int, r plotRect) plotRect {
	ax, az := turnCell(q, r.x, r.z)
	bx, bz := turnCell(q, r.x+r.w-1, r.z+r.d-1)
	if q%2 != 0 {
		r.w, r.d = r.d, r.w
	}
	return plotRect{min(ax, bx), min(az, bz), r.w, r.d}
}

// backOf is the way the back of a plot-sized ground faces, turned q quarter turns.
func backOf(q int) (int, int) {
	switch ((q % 4) + 4) % 4 {
	case 1:
		return 1, 0
	case 2:
		return 0, 1
	case 3:
		return -1, 0
	}
	return 0, -1
}

// on is a rectangle of the ground's own cells, turned as the pier faces, in town cells.
func (d dockSpot) on(r plotRect) plotRect {
	t := turnRect(d.face, r)
	return plotRect{d.at[0] + t.x, d.at[1] + t.z, t.w, t.d}
}

func (d dockSpot) plot() plotRect { return plotRect{d.at[0], d.at[1], plotCells, plotCells} }

// harbour is the sea at the back of the pier's ground.
func (d dockSpot) harbour() plotRect { return d.on(plotRect{0, 0, plotCells, quayRow}) }

// coast is the land the pier has: its landward side, with landPadding of land beside and before it.
func (d dockSpot) coast() plotRect {
	return d.on(plotRect{-landPadding, quayRow, plotCells + landPadding*2, plotCells - quayRow + landPadding})
}

// lane is the harbour and on from it out to open sea.
func (d dockSpot) lane() plotRect {
	r := d.harbour()
	switch bx, bz := backOf(d.face); {
	case bx < 0:
		r.x -= laneReach
		r.w += laneReach
	case bx > 0:
		r.w += laneReach
	case bz < 0:
		r.z -= laneReach
		r.d += laneReach
	default:
		r.d += laneReach
	}
	return r
}

// facesFrom are the ways the pier may face with its corner at at, the likeliest first: its harbour away from the
// middle of the island.
func facesFrom(at []int) []int {
	cx, cz := at[0]+plotCells/2, at[1]+plotCells/2
	faces := []int{0, 1, 2, 3}
	away := func(q int) int {
		bx, bz := backOf(q)
		return bx*cx + bz*cz
	}
	slices.SortStableFunc(faces, func(a, b int) int { return away(b) - away(a) })
	return faces
}

// dock is where the pier stands, if it does.
func (e *Engine) dock() (dockSpot, bool) {
	l := e.w.Landmarks[model.LandmarkDock]
	if l == nil || len(l.At) != 2 {
		return dockSpot{}, false
	}
	return dockSpot{l.At, l.Face}, true
}

// dockLanes are the lanes no plot may come within landPadding of, but for the pier's own when it is what moves.
func (e *Engine) dockLanes(id string) []plotRect {
	if d, ok := e.dock(); ok && id != dockID {
		return []plotRect{d.lane()}
	}
	return nil
}

// dockFace is the way the pier would face with its corner at at, its lane clear of the reserved ground and of every
// other plot shown on land; false where no way is clear.
func (e *Engine) dockFace(at []int, land plotLand) (int, bool) {
	for _, q := range facesFrom(at) {
		if e.laneClear(dockSpot{at, q}.lane(), land) {
			return q, true
		}
	}
	return 0, false
}

// laneClear is whether nothing but the pier stands within landPadding of lane: no reserved ground, no plot shown.
func (e *Engine) laneClear(lane plotRect, land plotLand) bool {
	return !slices.ContainsFunc(e.reservedRects(), func(r plotRect) bool { return overlapsPlot(lane, r, landPadding) }) &&
		!slices.ContainsFunc(land.shown, func(s shownPlot) bool { return s.id != dockID && overlapsPlot(lane, s.rect, landPadding) })
}

// placeDock is where the pier may stand with its corner at at, and the way it faces there; false where it may not.
func (e *Engine) placeDock(at []int, land plotLand) (int, bool) {
	bad := func() error { return model.Errorf(model.CodeInvalid, "設施的位置不正確") }
	if e.checkSpotOnLand(dockID, at, land, bad, bad) != nil {
		return 0, false
	}
	return e.dockFace(at, land)
}

// settleDock keeps the pier on the coast: one saved before it faced open sea, or whose lane something now stands
// in, turns to a way that is clear, or moves to the first free spot that has one.
func (e *Engine) settleDock() {
	d, ok := e.dock()
	if !ok {
		return
	}
	land := e.currentPlotLand()
	if e.laneClear(d.lane(), land) {
		return
	}
	l := e.w.Landmarks[model.LandmarkDock]
	if q, ok := e.dockFace(d.at, land); ok {
		l.Face = q
		return
	}
	if at, q, ok := e.firstFreeDock(land); ok {
		l.At, l.Face = at, q
	}
}

// firstFreeDock is the first spot the pier could take, searched as firstFreePlot searches, and the way it faces.
func (e *Engine) firstFreeDock(land plotLand) ([]int, int, bool) {
	for radius := 0; radius <= plotLimit/18; radius++ {
		for z := -radius; z <= radius; z++ {
			for x := -radius; x <= radius; x++ {
				if max(x, -x, z, -z) != radius {
					continue
				}
				at := []int{x*18 - 8, z*18 - 8}
				if q, ok := e.placeDock(at, land); ok {
					return at, q, true
				}
			}
		}
	}
	return nil, 0, false
}
