package usecase_test

import (
	"context"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/pkg/jsonx"
)

func TestFlowsSavedPerCompanyBecomeShared(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	r.e.Close()

	flow := func(id, team, name, prompt string) map[string]any {
		return map[string]any{"id": id, "teamId": team, "name": name, "edges": []any{},
			"nodes": []any{map[string]any{"id": id + "-n", "kind": "task", "name": "開始", "prompt": prompt, "replicaIds": []string{"gone"}}}}
	}
	teamDoc := func(id, name, def string) map[string]any {
		return map[string]any{"id": id, "name": name, "folder": "/x", "defaultWorkflowId": def, "branches": []string{}}
	}
	docs := map[[2]string]any{
		{"team", "old-a"}:     teamDoc("old-a", "甲", "old-1"),
		{"team", "old-b"}:     teamDoc("old-b", "乙", "old-2"),
		{"workflow", "old-1"}: flow("old-1", "old-a", "修 Bug", "一樣"),
		{"workflow", "old-2"}: flow("old-2", "old-b", "修 Bug", "一樣"),
		{"workflow", "old-3"}: flow("old-3", "old-a", "發布", "甲的做法"),
		{"workflow", "old-4"}: flow("old-4", "old-b", "發布", "乙的做法"),
	}
	var save []model.Doc
	for key, v := range docs {
		raw, err := jsonx.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		save = append(save, model.Doc{Kind: key[0], ID: key[1], Data: raw})
	}
	if err := r.store.Apply(context.Background(), save, nil); err != nil {
		t.Fatal(err)
	}

	newEngine(t, r)
	check := func() {
		t.Helper()
		w := r.world()
		named := map[string]*model.Workflow{}
		for _, wf := range w.Workflows {
			named[wf.Name] = wf
		}
		for _, want := range []string{"修 Bug", "發布（甲）", "發布（乙）"} {
			if named[want] == nil {
				t.Fatalf("no flow %s: %v", want, named)
			}
		}
		if len(named["修 Bug"].Nodes[0].ReplicaIDs) != 0 {
			t.Fatal("a shared flow still names staff")
		}
		if w.Teams["old-a"].DefaultWorkflowID != "old-1" || w.Teams["old-b"].DefaultWorkflowID != "old-1" {
			t.Fatalf("%s %s", w.Teams["old-a"].DefaultWorkflowID, w.Teams["old-b"].DefaultWorkflowID)
		}
	}
	check()
	// once only: the names stay as they are when the server starts again
	r.e.Close()
	newEngine(t, r)
	check()
}
