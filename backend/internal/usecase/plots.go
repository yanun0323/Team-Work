package usecase

import (
	"slices"
	"sort"

	"github.com/yanun0323/mho-company/internal/model"
)

var buildingStyles = []string{"tower", "brick", "studio", "loft", "timber", "classic", "tech", "pagoda", "deco", "eco", "villa"}

// Keep these cell dimensions in step with frontend/src/layout.ts.
const plotCells = 16
const plotLimit = 512 // Bounds the dense terrain allocation in the renderer.

type plotRect struct{ x, z, w, d int }

var airportRect = plotRect{-20, -30, 40, 20}

func overlapsPlot(a, b plotRect, gap int) bool {
	return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.z < b.z+b.d+gap && b.z < a.z+a.d+gap
}

func (e *Engine) checkPlot(id string, p *model.Plot) error {
	bad := func() error { return model.Errorf(model.CodeInvalid, "公司位置或外觀不正確") }
	if p == nil || len(p.At) != 2 || !slices.Contains(buildingStyles, p.Style) {
		return bad()
	}
	x, z := p.At[0], p.At[1]
	if x < -plotLimit || x > plotLimit || z < -plotLimit || z > plotLimit {
		return bad()
	}
	r := plotRect{x, z, plotCells, plotCells}
	if overlapsPlot(r, airportRect, 2) {
		return bad()
	}
	others := []plotRect{airportRect}
	for key, t := range e.w.Teams {
		if key == id || t.Plot == nil {
			continue
		}
		o := plotRect{t.Plot.At[0], t.Plot.At[1], plotCells, plotCells}
		if overlapsPlot(r, o, 0) {
			return model.Errorf(model.CodeConflict, "公司用地不能重疊")
		}
		others = append(others, o)
	}
	// Each rectangle grows by six coast cells; the remaining sea gap is at most 24.
	for _, o := range others {
		gap := max(0, r.x-(o.x+o.w), o.x-(r.x+r.w), r.z-(o.z+o.d), o.z-(r.z+r.d))
		if gap <= 36 {
			return nil
		}
	}
	return bad()
}

func (e *Engine) defaultPlot() *model.Plot {
	p := &model.Plot{Style: buildingStyles[len(e.w.Teams)%len(buildingStyles)], Seed: uint32(e.w.Seq)}
	// Search from the origin outward; stored plots never move when a company closes.
	for radius := 0; radius <= plotLimit/18; radius++ {
		for z := -radius; z <= radius; z++ {
			for x := -radius; x <= radius; x++ {
				if max(x, -x, z, -z) != radius {
					continue
				}
				p.At = []int{x*18 - 8, z*18 - 8}
				if e.checkPlot("", p) == nil {
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
