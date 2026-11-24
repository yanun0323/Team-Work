package usecase

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func landmarkEngine() *Engine {
	return &Engine{w: model.NewWorld(), clock: func() float64 { return 42 }}
}

// stepsOf is the milestones of a landmark's road.
func stepsOf(kind string) []int {
	for _, s := range landmarkSteps {
		if s.kind == kind {
			return s.steps
		}
	}
	return nil
}

var parkSteps = stepsOf(model.LandmarkPark)

func finishTasks(e *Engine, n int) {
	for range n {
		id := fmt.Sprintf("task-%d", len(e.w.Tasks)+1)
		e.w.Tasks[id] = &model.Task{ID: id, Stage: enum.StageDone}
	}
}

// The park appears at the first milestone on the first free plot, grows with each one after, and never shrinks back
// or moves once there.
func TestParkGrowsWithFinishedTasks(t *testing.T) {
	t.Parallel()
	e := landmarkEngine()
	e.w.Teams["team-1"] = &model.Team{ID: "team-1", Plot: e.defaultPlot()}

	finishTasks(e, parkSteps[0]-1)
	e.growLandmarks()
	if len(e.w.Landmarks) != 0 {
		t.Fatalf("a park before its first milestone: %+v", e.w.Landmarks[model.LandmarkPark])
	}

	finishTasks(e, 1)
	free := e.firstFreePlot()
	e.growLandmarks()
	park := e.w.Landmarks[model.LandmarkPark]
	if park == nil || park.Stage != 1 || park.Kind != model.LandmarkPark || park.CreatedAt != 42 || !reflect.DeepEqual(park.At, free) {
		t.Fatalf("park: %+v, want stage 1 at %v", park, free)
	}
	if reflect.DeepEqual(park.At, e.w.Teams["team-1"].Plot.At) {
		t.Fatal("the park took the company's plot")
	}
	at := park.At

	finishTasks(e, parkSteps[2]-parkSteps[0])
	e.growLandmarks()
	if park.Stage != 3 || !reflect.DeepEqual(park.At, at) {
		t.Fatalf("grown park: %+v", park)
	}

	// the tasks that grew it go: it stays as it grew
	clear(e.w.Tasks)
	e.growLandmarks()
	if park.Stage != 3 {
		t.Fatalf("the park shrank: %+v", park)
	}
	if roads := e.landmarkRoads(); len(roads) != len(landmarkSteps) || roads[0].Kind != model.LandmarkPark || roads[0].Stage != 3 || roads[0].Value != 0 || !reflect.DeepEqual(roads[0].Steps, parkSteps) {
		t.Fatalf("roads: %+v", roads)
	}
}

// Each landmark goes by its own milestone: days in use (from the first model call too), chats and companies founded.
func TestLandmarksGrowByTheirOwnMilestones(t *testing.T) {
	t.Parallel()
	now := 1_000 * float64(daySeconds)
	e := &Engine{w: model.NewWorld(), clock: func() float64 { return now }}
	road := func(kind string) model.LandmarkRoad {
		for _, r := range e.landmarkRoads() {
			if r.Kind == kind {
				return r
			}
		}
		t.Fatalf("no road %s", kind)
		return model.LandmarkRoad{}
	}
	stage := func(kind string) int {
		if l := e.w.Landmarks[kind]; l != nil {
			return l.Stage
		}
		return 0
	}

	// days in use: from the first thing done, the first day counted
	if r := road(model.LandmarkHill); r.Value != 0 {
		t.Fatalf("days in use on a new island: %+v", r)
	}
	e.firstUse = now - 6*daySeconds
	if v := road(model.LandmarkHill).Value; v != 7 {
		t.Fatalf("days in use %d, want 7", v)
	}
	e.w.Tasks["task-1"] = &model.Task{ID: "task-1", CreatedAt: now - 29*daySeconds - 5}
	e.growLandmarks()
	if stage(model.LandmarkHill) != 2 || stage(model.LandmarkClock) != 0 {
		t.Fatalf("30 days in use: hill %d, clock %d", stage(model.LandmarkHill), stage(model.LandmarkClock))
	}
	e.w.Chats["chat-0"] = &model.Chat{ID: "chat-0", Messages: []model.ChatMessage{{At: now - 364*daySeconds, From: "agent"}}}
	e.growLandmarks()
	if stage(model.LandmarkClock) != 1 {
		t.Fatal("no clock tower after a year")
	}

	// chats
	for i := range 18 {
		id := fmt.Sprintf("chat-%d", i+1)
		e.w.Chats[id] = &model.Chat{ID: id, Messages: []model.ChatMessage{{At: now, From: "user"}, {At: now, From: "agent"}}}
	}
	e.growLandmarks()
	if stage(model.LandmarkPond) != 0 || road(model.LandmarkPond).Value != 19 {
		t.Fatalf("19 chats: pond %d", stage(model.LandmarkPond))
	}
	e.w.Chats["chat-19"] = &model.Chat{ID: "chat-19"}
	e.growLandmarks()
	if stage(model.LandmarkPond) != 1 {
		t.Fatal("no fountain after 20 chats")
	}

	// companies
	for i := range 3 {
		id := fmt.Sprintf("team-%d", i)
		e.w.Teams[id] = &model.Team{ID: id, Plot: e.defaultPlot()}
	}
	e.growLandmarks()
	if stage(model.LandmarkDock) != 1 {
		t.Fatal("no pier with three companies")
	}

	// every landmark on ground of its own, clear of the companies and of each other
	shown := e.shownPlots()
	for i, a := range shown {
		for _, b := range shown[i+1:] {
			if overlapsPlot(a.rect, b.rect, 0) {
				t.Fatalf("%s and %s overlap", a.id, b.id)
			}
		}
	}
	if n := len(e.landmarkPlots()); n != 4 {
		t.Fatalf("%d landmarks laid out, want 4", n)
	}
}

// A flower field grown before it was taken out of the island gives its ground back.
func TestFlowerFieldIsTakenAway(t *testing.T) {
	t.Parallel()
	e := landmarkEngine()
	e.w.Landmarks["flowers"] = &model.Landmark{Kind: "flowers", Stage: 1, At: []int{-8, 10}}
	e.growLandmarks()
	if _, ok := e.w.Landmarks["flowers"]; ok || len(e.landmarkPlots()) != 0 {
		t.Fatalf("landmarks %+v", e.w.Landmarks)
	}
	for _, r := range e.landmarkRoads() {
		if r.Kind == "flowers" {
			t.Fatal("a road for the flower field")
		}
	}
}

// The park's ground is kept as a company's plot is: no company or ghost company stands on it, and new ones are handed
// a place beside it.
func TestParkGroundIsKeptClear(t *testing.T) {
	t.Parallel()
	e := landmarkEngine()
	finishTasks(e, parkSteps[0])
	e.growLandmarks()
	park := e.w.Landmarks[model.LandmarkPark]
	if park == nil {
		t.Fatal("no park")
	}
	onPark := &model.Plot{At: park.At, Style: "villa"}
	if err := e.checkPlot("", onPark); errCode(err) != model.CodeConflict {
		t.Fatalf("a company on the park: %v", err)
	}
	half := &model.Plot{At: []int{park.At[0] + plotCells/2, park.At[1]}, Style: "villa"}
	if err := e.checkPlot("", half); errCode(err) != model.CodeConflict {
		t.Fatalf("a company half on the park: %v", err)
	}
	next := e.defaultPlot()
	if next == nil || overlapsPlot(plotRect{next.At[0], next.At[1], plotCells, plotCells}, plotRect{park.At[0], park.At[1], plotCells, plotCells}, 0) {
		t.Fatalf("a new company handed the park's ground: %+v", next)
	}
	// a company saved on the airport is shown clear of the park as well
	e.w.Teams["team-1"] = &model.Team{ID: "team-1", Plot: &model.Plot{At: []int{airportRect.x, airportRect.z}, Style: "villa"}}
	shown := e.shownPlots()
	if len(shown) != 2 || shown[1].id != "landmark:park" {
		t.Fatalf("shown: %+v", shown)
	}
	if overlapsPlot(shown[0].rect, shown[1].rect, reservedGap) || onReserved(e.reservedRects(), shown[0].rect) {
		t.Fatalf("company shown at %+v, park at %+v", shown[0].rect, shown[1].rect)
	}
	// and the island's land reaches round the park as round a plot
	land := e.currentPlotLand()
	if !land.containsExpanded(plotRect{park.At[0], park.At[1], plotCells, plotCells}) {
		t.Fatal("no land under the park")
	}
}

func errCode(err error) string {
	var e *model.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
