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

func TestSavedPresetPromptsAreRefreshed(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	const old = "找出根本原因，讓失敗的測試通過，不改無關的程式。"
	var flow *model.Workflow
	for _, wf := range r.world().Workflows {
		if wf.Name == "修 Bug" {
			flow = wf
		}
	}
	current := map[string]string{}
	for i := range flow.Nodes {
		n := &flow.Nodes[i]
		current[n.Name] = n.Prompt
		switch n.Name {
		case "修正":
			n.Prompt = old
		case "回歸測試":
			n.Prompt = "我自己改的"
		}
	}
	if err := r.e.SaveWorkflow(flow.ID, *flow); err != nil {
		t.Fatal(err)
	}
	newEngine(t, r)
	got := map[string]string{}
	for _, n := range r.world().Workflows[flow.ID].Nodes {
		got[n.Name] = n.Prompt
	}
	if got["修正"] != current["修正"] || got["修正"] == old {
		t.Fatalf("old prompt stayed: %q", got["修正"])
	}
	if got["回歸測試"] != "我自己改的" {
		t.Fatalf("edit lost: %q", got["回歸測試"])
	}
}

func TestOldDefaultFlowGetsAWorkStepOnce(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	var flow *model.Workflow
	for _, wf := range r.world().Workflows {
		if wf.Name == "預設任務流程" {
			flow = wf
		}
	}
	if len(flow.Nodes) != 3 {
		t.Fatalf("a new default flow has %d steps", len(flow.Nodes))
	}
	// the user takes the step out again: it must not come back
	plain := *r.flow
	plain.ID, plain.Name = flow.ID, flow.Name
	if err := r.e.SaveWorkflow(flow.ID, plain); err != nil {
		t.Fatal(err)
	}
	newEngine(t, r)
	if n := len(r.world().Workflows[flow.ID].Nodes); n != 2 {
		t.Fatalf("the removed step came back: %d", n)
	}
}

func TestOldDefaultFlowGetsAWorkStep(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return call("submit_handoff", handoff), nil })
	var flow *model.Workflow
	for _, wf := range r.world().Workflows {
		if wf.Name == "預設任務流程" {
			flow = wf
		}
	}
	plain := *r.flow
	plain.ID, plain.Name = flow.ID, flow.Name
	if err := r.e.SaveWorkflow(flow.ID, plain); err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	raw, err := jsonx.Marshal(map[string]any{"seq": 100000, "presets": true, "promptFiles": true})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.store.Apply(context.Background(), []model.Doc{{Kind: "meta", ID: "world", Data: raw}}, nil); err != nil {
		t.Fatal(err)
	}
	newEngine(t, r)
	got := r.world().Workflows[flow.ID]
	if len(got.Nodes) != 3 || got.Nodes[2].Name != "實作" || len(got.Edges) != 2 {
		t.Fatalf("%+v %+v", got.Nodes, got.Edges)
	}
	if err := r.e.SaveWorkflow(got.ID, *got); err != nil {
		t.Fatalf("the new step does not fit the flow: %v", err)
	}
}
