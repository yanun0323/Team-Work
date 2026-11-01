package usecase

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
)

// The same fixtures run against layoutTown/canPlace in the frontend tests.
func TestPlacementMatchesFrontendLandAndRules(t *testing.T) {
	raw, err := os.ReadFile("testdata/plot_placement.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Plots    [][]int `json:"plots"`
		Cols     int     `json:"cols"`
		Rows     int     `json:"rows"`
		LandHash uint32  `json:"landHash"`
		Samples  []struct {
			At    []int `json:"at"`
			Place bool  `json:"place"`
			Move  bool  `json:"move"`
		} `json:"samples"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, f := range fixtures {
		e := Engine{w: model.NewWorld()}
		for j, at := range f.Plots {
			id := string(rune('0' + j))
			e.w.Teams[id] = &model.Team{ID: id, Plot: &model.Plot{At: at, Style: "villa"}}
		}
		land := e.currentPlotLand()
		hash := uint32(2166136261)
		for _, cell := range land.cells {
			value := uint32(0)
			if cell {
				value = 1
			}
			hash = (hash ^ value) * 16777619
		}
		if land.cols != f.Cols || land.rows != f.Rows || hash != f.LandHash {
			t.Fatalf("fixture %d land mismatch: %dx%d hash %d, want %dx%d hash %d", i, land.cols, land.rows, hash, f.Cols, f.Rows, f.LandHash)
		}
		for _, sample := range f.Samples {
			plot := &model.Plot{At: sample.At, Style: "villa"}
			if got := e.checkPlotOnLand("", plot, land) == nil; got != sample.Place {
				t.Fatalf("fixture %d placement %v: %v, want %v", i, sample.At, got, sample.Place)
			}
			if len(f.Plots) > 0 {
				if got := e.checkPlotOnLand("0", plot, land) == nil; got != sample.Move {
					t.Fatalf("fixture %d move %v: %v, want %v", i, sample.At, got, sample.Move)
				}
			}
		}
	}
}
