package usecase

import (
	"math"
	"slices"
	"sort"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

type landmarkStep struct {
	kind  string
	steps []int
}

// landmarkSteps are the milestones that grow each landmark, stage by stage, in the order the island lays them out.
// Keep in step with STEPS in frontend/src/core/landmarks.ts, which the simulator uses.
var landmarkSteps = []landmarkStep{
	// finished tasks: a small park, then medium, then large
	{model.LandmarkPark, []int{10, 50, 200}},
	// days in use: a hill, then a lookout on it
	{model.LandmarkHill, []int{7, 30}},
	// chats: a fountain, then a lake with a wooden bridge
	{model.LandmarkPond, []int{20, 100}},
	// companies: a pier, then boats moored at it
	{model.LandmarkDock, []int{3, 5}},
	// days in use: a clock tower
	{model.LandmarkClock, []int{365}},
}

// daySeconds is a day, for the days in use.
const daySeconds = 86400

// landmarkRoads are the island's landmarks, each with the milestones that grow it and how far along them the user
// has got. Called under the engine lock.
func (e *Engine) landmarkRoads() []model.LandmarkRoad {
	done, chats := 0, len(e.w.Chats)
	since := e.firstUse
	seen := func(at float64) {
		if at > 0 && (since == 0 || at < since) {
			since = at
		}
	}
	for _, t := range e.w.Tasks {
		seen(t.CreatedAt)
		if t.Stage == enum.StageDone {
			done++
		}
	}
	for _, c := range e.w.Chats {
		for _, m := range c.Messages {
			seen(m.At)
		}
	}
	values := map[string]int{
		model.LandmarkPark: done, model.LandmarkHill: daysSince(since, e.clock()), model.LandmarkPond: chats,
		model.LandmarkDock: len(e.w.Teams), model.LandmarkClock: daysSince(since, e.clock()),
	}
	out := make([]model.LandmarkRoad, len(landmarkSteps))
	for i, s := range landmarkSteps {
		out[i] = model.LandmarkRoad{Kind: s.kind, Value: values[s.kind], Steps: s.steps}
		if l := e.w.Landmarks[s.kind]; l != nil {
			out[i].Stage = l.Stage
		}
	}
	return out
}

// daysSince counts the days from since to now, both in Unix seconds, the first day included; 0 before any use. Keep
// in step with daysSince in frontend/src/Profile.tsx.
func daysSince(since, now float64) int {
	if since <= 0 {
		return 0
	}
	return max(1, int(math.Floor((now-since)/daySeconds))+1)
}

// reachedStage is how many of a road's steps its value has reached.
func reachedStage(r model.LandmarkRoad) int {
	n := 0
	for _, step := range r.Steps {
		if r.Value >= step {
			n++
		}
	}
	return n
}

// growLandmarks grows each landmark to the stage its milestones have reached, putting it on the island the first
// time, on the first free plot from the middle out. With no room for it, it waits for the next time. A landmark never
// shrinks back, though what grew it may go. Called under the engine lock, when the island starts and whenever a task
// is finished, the user says something in a chat or a company is founded; days in use are caught up then too.
func (e *Engine) growLandmarks() {
	// one of a kind no longer grown (the flower field) gives its ground back
	for kind := range e.w.Landmarks {
		if !slices.ContainsFunc(landmarkSteps, func(s landmarkStep) bool { return s.kind == kind }) {
			delete(e.w.Landmarks, kind)
		}
	}
	e.settleDock()
	for _, road := range e.landmarkRoads() {
		stage := reachedStage(road)
		if stage <= road.Stage {
			continue
		}
		if e.w.Landmarks == nil {
			e.w.Landmarks = map[string]*model.Landmark{}
		}
		l := e.w.Landmarks[road.Kind]
		if l == nil {
			l = &model.Landmark{Kind: road.Kind, CreatedAt: e.clock()}
			// the pier on the coast, facing open sea
			if road.Kind == model.LandmarkDock {
				at, face, ok := e.firstFreeDock(e.currentPlotLand())
				if !ok {
					continue
				}
				l.At, l.Face = at, face
			} else if l.At = e.firstFreePlot(); l.At == nil {
				continue
			}
			e.w.Landmarks[road.Kind] = l
		}
		l.Stage = stage
	}
}

// MoveLandmark puts a landmark's ground's corner at at, by the rules a company's plot moves by; it stays as grown. The
// pier turns to face open sea there, and may only go where some way does.
func (e *Engine) MoveLandmark(kind string, at []int) error {
	return e.do(func() error { return e.moveLandmark(kind, at) })
}

// moveLandmark is MoveLandmark, under the engine lock.
func (e *Engine) moveLandmark(kind string, at []int) error {
	l := e.w.Landmarks[kind]
	if l == nil {
		return model.Errorf(model.CodeNotFound, "找不到這個設施")
	}
	bad := func() error { return model.Errorf(model.CodeInvalid, "設施的位置不正確") }
	overlap := func() error { return model.Errorf(model.CodeConflict, "用地不能重疊") }
	land := e.currentPlotLand()
	if err := e.checkSpotOnLand("landmark:"+kind, at, land, bad, overlap); err != nil {
		return err
	}
	if kind == model.LandmarkDock {
		face, ok := e.dockFace(at, land)
		if !ok {
			return bad()
		}
		l.Face = face
	}
	l.At = []int{at[0], at[1]}
	return nil
}

// landmarkPlots are the landmarks' ground, by kind. Each stays where it first appeared or was moved to, which was
// clear of everything else, so nothing else is ever shown over it.
func (e *Engine) landmarkPlots() []shownPlot {
	out := make([]shownPlot, 0, len(e.w.Landmarks))
	for kind, l := range e.w.Landmarks {
		if len(l.At) == 2 {
			out = append(out, shownPlot{"landmark:" + kind, plotRect{l.At[0], l.At[1], plotCells, plotCells}})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}
