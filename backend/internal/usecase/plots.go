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

// staffingRect is the staffing agency's ground, past the airport's east end (STAFFING_LOT).
var staffingRect = plotRect{22, -30, 10, 10}

// reservedRects is ground no company stands on, with reservedGap cells of grass kept round it.
var reservedRects = []plotRect{airportRect, staffingRect}

const reservedGap = 2

func overlapsPlot(a, b plotRect, gap int) bool {
	return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.z < b.z+b.d+gap && b.z < a.z+a.d+gap
}

func onReserved(r plotRect) bool {
	for _, k := range reservedRects {
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

// shownPlots places every company's plot where the island shows it: as saved, unless it is on reserved
// ground (saved before that ground was kept), in which case it goes to the nearest spot clear of the
// reserved ground and of the other plots. The saved plot is left as it is. Companies go in the order they
// were founded. Keep in step with shownSpots in frontend/src/layout.ts.
func (e *Engine) shownPlots() []shownPlot {
	teams := make([]*model.Team, 0, len(e.w.Teams))
	for _, t := range e.w.Teams {
		if t.Plot != nil && len(t.Plot.At) == 2 {
			teams = append(teams, t)
		}
	}
	sort.Slice(teams, func(i, j int) bool {
		if teams[i].CreatedAt != teams[j].CreatedAt {
			return teams[i].CreatedAt < teams[j].CreatedAt
		}
		return teams[i].ID < teams[j].ID
	})
	out := make([]shownPlot, len(teams))
	var taken []plotRect
	for i, t := range teams {
		out[i] = shownPlot{t.ID, plotRect{t.Plot.At[0], t.Plot.At[1], plotCells, plotCells}}
		if !onReserved(out[i].rect) {
			taken = append(taken, out[i].rect)
		}
	}
	free := func(r plotRect) bool {
		if onReserved(r) {
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
		if !onReserved(saved) {
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
	return out
}

func (e *Engine) currentPlotLand() plotLand {
	shown := e.shownPlots()
	plots := make([]plotRect, len(shown))
	for i, s := range shown {
		plots[i] = s.rect
	}
	land := makePlotLand(plots)
	land.shown = shown
	return land
}

func (e *Engine) checkPlot(id string, p *model.Plot) error {
	return e.checkPlotOnLand(id, p, e.currentPlotLand())
}

func (e *Engine) checkPlotOnLand(id string, p *model.Plot, land plotLand) error {
	bad := func() error { return model.Errorf(model.CodeInvalid, "公司位置或外觀不正確") }
	if p == nil || len(p.At) != 2 || !slices.Contains(buildingStyles, p.Style) {
		return bad()
	}
	x, z := p.At[0], p.At[1]
	if x < -plotLimit || x > plotLimit || z < -plotLimit || z > plotLimit {
		return bad()
	}
	r := plotRect{x, z, plotCells, plotCells}
	if onReserved(r) {
		return bad()
	}
	for _, o := range land.shown {
		if o.id == id {
			continue
		}
		if overlapsPlot(r, o.rect, 0) {
			return model.Errorf(model.CodeConflict, "公司用地不能重疊")
		}
	}
	if land.containsExpanded(r) {
		return nil
	}
	return bad()
}

func (e *Engine) defaultPlot() *model.Plot {
	land := e.currentPlotLand()
	p := &model.Plot{Style: buildingStyles[len(e.w.Teams)%len(buildingStyles)], Seed: uint32(e.w.Seq)}
	// Search from the origin outward; stored plots never move when a company closes.
	for radius := 0; radius <= plotLimit/18; radius++ {
		for z := -radius; z <= radius; z++ {
			for x := -radius; x <= radius; x++ {
				if max(x, -x, z, -z) != radius {
					continue
				}
				p.At = []int{x*18 - 8, z*18 - 8}
				if e.checkPlotOnLand("", p, land) == nil {
					return p
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
