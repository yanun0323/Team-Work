package usecase_test

import (
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// A first request with every tool on, in a company and at the airport, says what scripts resolve to only in exec's
// ALL_TOOLS, never in each tool: that note cost about a thousand tokens on every call. With -v it shows the request's
// size by part, in bytes; about 4 make a token of English.
func TestFirstTurnLeavesScriptDetailsToAllTools(t *testing.T) {
	t.Parallel()
	var got []model.ModelRequest
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		got = append(got, req)
		return say("好"), nil
	})
	bp := r.world().Blueprints[r.owner.BlueprintID]
	bp.Tools = []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch, enum.ToolRunCommand}
	if err := r.e.SaveBlueprint(bp.ID, *bp); err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	a, err := r.e.CreateAirportChat(usecase.NewAirportChat{Model: r.owner.Model, Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("airport reply", chatDone(a.ID))
	for i, name := range []string{"employee", "airport"} {
		req := got[i]
		if !hasExec(req) || len(scriptTools(req)) < 10 {
			t.Fatalf("%s: exec names %v", name, scriptTools(req))
		}
		descriptions, params := 0, 0
		for _, tool := range req.Tools {
			if tool.Name != "exec" && strings.Contains(tool.Description, "In exec scripts") {
				t.Fatalf("%s: %s says how scripts call it", name, tool.Name)
			}
			descriptions += len(tool.Description)
			params += len(tool.Parameters)
		}
		t.Logf("%s: %d tools, ~%d tokens: system %d, descriptions %d, params %d", name, len(req.Tools),
			(len(req.System)+descriptions+params)/4, len(req.System), descriptions, params)
	}
}
