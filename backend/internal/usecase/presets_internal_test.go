package usecase

import (
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestLocalizeFlowLeavesStepsThatMovedInATaskCopy(t *testing.T) {
	// a task copied the planning flow when its first step was a discussion; the flow has since changed its order
	var wf *model.Workflow
	for _, f := range presets.Flows {
		if f.ID == "preset-planning" {
			wf = f.in(model.LanguageZh)
		}
	}
	old := presetNodeID(wf.ID, 0, 0)
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == old {
			wf.Nodes[i].Kind, wf.Nodes[i].Name, wf.Nodes[i].Prompt = enum.NodeTalk, "討論需求", presets.Talk.Zh
		}
	}
	localizeFlow(wf, model.LanguageEn)
	for _, n := range wf.Nodes {
		switch n.ID {
		case old:
			if n.Name != "討論需求" || n.Prompt != presets.Talk.En {
				t.Fatalf("%+v", n)
			}
		case presetNodeID(wf.ID, 0, 1):
			if n.Name != "Spec discussion" {
				t.Fatalf("%+v", n)
			}
		}
	}
}
