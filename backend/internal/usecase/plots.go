package usecase

import (
	"math"
	"slices"
	"sort"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Keep these in step with BUILDING_STYLES in frontend/src/layout.ts.
var buildingStyles = []string{
	"tower", "brick", "studio", "loft", "timber", "classic", "tech", "pagoda", "deco", "eco", "villa",
	"lighthouse", "hut", "castle", "canal", "glasshouse", "sweets",
}

// Keep these cell dimensions in step with frontend/src/layout.ts.
const plotCells = 16
const plotLimit = 512 // Bounds the dense terrain allocation in the renderer.

type plotRect struct{ x, z, w, d int }

var airportRect = plotRect{-20, -30, 40, 20}

// The staffing agency's paved ground is staffingCells a side, in the middle of a company-sized plot round it, by
// default past the airport's east end (STAFFING_SPOT and STAFFING_LOT). The user may move it (model.PlaceStaffing).
const staffingCells = 10
const staffingInset = (plotCells - staffingCells) / 2

var staffingSpot = []int{19, -33}

const reservedGap = 2

func overlapsPlot(a, b plotRect, gap int) bool {
	return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.z < b.z+b.d+gap && b.z < a.z+a.d+gap
}

// staffingLot is the staffing agency's paved ground with its plot's corner at spot.
func staffingLot(spot []int) plotRect {
	return plotRect{spot[0] + staffingInset, spot[1] + staffingInset, staffingCells, staffingCells}
}

// staffingAt is where the staffing agency's plot's corner is: where the user moved it, or where it always stood.
func (e *Engine) staffingAt() []int {
	if p := e.w.Places[model.PlaceStaffing]; p != nil && len(p.At) == 2 {
		return p.At
	}
	return staffingSpot
}

// reservedRects is ground no company stands on, with reservedGap cells of grass kept round it: the airport and the
// staffing agency's paving.
func (e *Engine) reservedRects() []plotRect {
	return []plotRect{airportRect, staffingLot(e.staffingAt())}
}

func onReserved(reserved []plotRect, r plotRect) bool {
	for _, k := range reserved {
		if overlapsPlot(r, k, reservedGap) {
			return true
		}
	}
	return false
}

type shownPlot struct {
	id   string
	rect plotRect
}

// standing is a plot on the island: a company's, or a ghost company's.
type standing struct {
	ID        string
	Plot      *model.Plot
	CreatedAt float64
}

// standings are every plot on the island, companies' and ghost companies' alike, in the order they were founded.
func (e *Engine) standings() []standing {
	all := make([]standing, 0, len(e.w.Teams)+len(e.w.Ghosts))
	for _, t := range e.w.Teams {
		if t.Plot != nil && len(t.Plot.At) == 2 {
			all = append(all, standing{t.ID, t.Plot, t.CreatedAt})
		}
	}
	for _, g := range e.w.Ghosts {
		if g.Plot != nil && len(g.Plot.At) == 2 {
			all = append(all, standing{g.ID, g.Plot, g.CreatedAt})
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt != all[j].CreatedAt {
			return all[i].CreatedAt < all[j].CreatedAt
		}
		return all[i].ID < all[j].ID
	})
	return all
}

// shownPlots places every plot where the island shows it: as saved, unless it is on reserved
// ground (saved before that ground was kept), in which case it goes to the nearest spot clear of the
// reserved ground and of the other plots. The saved plot is left as it is. Companies and ghost companies go in
// the order they were founded; the landmarks' ground comes last, never moved, and taken from the start. Keep in step
// with shownSpots in frontend/src/layout.ts.
func (e *Engine) shownPlots() []shownPlot {
	teams := e.standings()
	landmarks := e.landmarkPlots()
	reserved := e.reservedRects()
	out := make([]shownPlot, len(teams), len(teams)+len(landmarks))
	var taken []plotRect
	for _, l := range landmarks {
		taken = append(taken, l.rect)
	}
	for i, t := range teams {
		out[i] = shownPlot{t.ID, plotRect{t.Plot.At[0], t.Plot.At[1], plotCells, plotCells}}
		if !onReserved(reserved, out[i].rect) {
			taken = append(taken, out[i].rect)
		}
	}
	free := func(r plotRect) bool {
		if onReserved(reserved, r) {
			return false
		}
		for _, o := range taken {
			if overlapsPlot(r, o, reservedGap) {
				return false
			}
		}
		return true
	}
	for i := range out {
		saved := out[i].rect
		if !onReserved(reserved, saved) {
			continue
		}
		// ring by ring outward, the nearest by straight distance; on a tie the first found, row by row
		best, bestD := saved, math.MaxInt
		for r := 1; r*r <= bestD && r <= 1024; r++ {
			for dz := -r; dz <= r; dz++ {
				for dx := -r; dx <= r; dx++ {
					if max(dx, -dx, dz, -dz) != r {
						continue
					}
					c := plotRect{saved.x + dx, saved.z + dz, plotCells, plotCells}
					if d := dx*dx + dz*dz; d < bestD && free(c) {
						best, bestD = c, d
					}
				}
			}
		}
		out[i].rect = best
		taken = append(taken, best)
	}
	return append(out, landmarks...)
}

func (e *Engine) currentPlotLand() plotLand {
	shown := e.shownPlots()
	plots := make([]plotRect, 0, len(shown))
	for _, s := range shown {
		if s.id != dockID {
			plots = append(plots, s.rect)
		}
	}
	var docks []dockSpot
	if d, ok := e.dock(); ok {
		docks = append(docks, d)
	}
	land := makePlotLand(e.reservedRects(), plots, docks...)
	land.shown = shown
	return land
}

func (e *Engine) checkPlot(id string, p *model.Plot) error {
	return e.checkPlotOnLand(id, p, e.currentPlotLand())
}

func (e *Engine) checkPlotOnLand(id string, p *model.Plot, land plotLand) error {
	bad := func() error { return model.Errorf(model.CodeInvalid, "公司位置或外觀不正確") }
	if p == nil || !slices.Contains(buildingStyles, p.Style) {
		return bad()
	}
	return e.checkSpotOnLand(id, p.At, land, bad, func() error { return model.Errorf(model.CodeConflict, "公司用地不能重疊") })
}

// checkSpotOnLand is whether a company-sized plot with its corner at at may stand there, `id` being what is moved
// there, if anything: clear of the reserved ground, of every other plot shown and of the way out to sea off the pier's
// harbour, and on land or close enough to it.
func (e *Engine) checkSpotOnLand(id string, at []int, land plotLand, bad, overlap func() error) error {
	if len(at) != 2 {
		return bad()
	}
	x, z := at[0], at[1]
	if x < -plotLimit || x > plotLimit || z < -plotLimit || z > plotLimit {
		return bad()
	}
	r := plotRect{x, z, plotCells, plotCells}
	if onReserved(e.reservedRects(), r) {
		return bad()
	}
	for _, o := range land.shown {
		if o.id == id {
			continue
		}
		if overlapsPlot(r, o.rect, 0) {
			return overlap()
		}
	}
	for _, lane := range e.dockLanes(id) {
		if overlapsPlot(r, lane, landPadding) {
			return overlap()
		}
	}
	if land.containsExpanded(r) {
		return nil
	}
	return bad()
}

// MoveStaffing puts the staffing agency's plot's corner at at. Its paving keeps reservedGap cells of grass from the
// airport and from every plot shown, as theirs does from it, and stands on land or close enough to it, as a plot's
// does. The land it leaves goes back to the sea.
func (e *Engine) MoveStaffing(at []int) error {
	return e.do(func() error {
		bad := func() error { return model.Errorf(model.CodeInvalid, "移民署的位置不正確") }
		if len(at) != 2 {
			return bad()
		}
		x, z := at[0], at[1]
		if x < -plotLimit || x > plotLimit || z < -plotLimit || z > plotLimit {
			return bad()
		}
		lot := staffingLot(at)
		if overlapsPlot(lot, airportRect, reservedGap) {
			return bad()
		}
		land := e.currentPlotLand()
		for _, o := range land.shown {
			if overlapsPlot(lot, o.rect, reservedGap) {
				return model.Errorf(model.CodeConflict, "用地不能重疊")
			}
		}
		for _, lane := range e.dockLanes("") {
			if overlapsPlot(lot, lane, landPadding) {
				return model.Errorf(model.CodeConflict, "用地不能重疊")
			}
		}
		if !land.containsExpanded(lot) {
			return bad()
		}
		if e.w.Places == nil {
			e.w.Places = map[string]*model.Place{}
		}
		e.w.Places[model.PlaceStaffing] = &model.Place{ID: model.PlaceStaffing, At: []int{x, z}}
		return nil
	})
}

func (e *Engine) defaultPlot() *model.Plot {
	at := e.firstFreePlot()
	if at == nil {
		return nil
	}
	return &model.Plot{At: at, Style: buildingStyles[len(e.w.Teams)%len(buildingStyles)], Seed: uint32(e.w.Seq)}
}

// firstFreePlot is the corner of the first plot a new company could take, searched from the origin outward on a
// grid; nil with none. Stored plots never move when a company closes.
func (e *Engine) firstFreePlot() []int {
	land := e.currentPlotLand()
	p := &model.Plot{Style: buildingStyles[0]}
	for radius := 0; radius <= plotLimit/18; radius++ {
		for z := -radius; z <= radius; z++ {
			for x := -radius; x <= radius; x++ {
				if max(x, -x, z, -z) != radius {
					continue
				}
				p.At = []int{x*18 - 8, z*18 - 8}
				if e.checkPlotOnLand("", p, land) == nil {
					return p.At
				}
			}
		}
	}
	return nil
}

// Older company records get fresh defaults, never imported browser positions.
func (e *Engine) initializePlots() {
	ids := make([]string, 0, len(e.w.Teams))
	for id := range e.w.Teams {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if e.w.Teams[id].Plot == nil {
			e.w.Teams[id].Plot = e.defaultPlot()
		}
	}
}
