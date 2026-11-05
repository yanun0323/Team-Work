package usecase

import (
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func TestLocalizeFlowLeavesStepsThatMovedInATaskCopy(t *testing.T) {
	// a task copied the bug fix flow when its first step was a discussion; the flow has since changed its order
	var wf *model.Workflow
	for _, f := range presets.Flows {
		if f.ID == "preset-bugfix" {
			wf = f.in(model.LanguageZh)
		}
	}
	old := presetNodeID(wf.ID, 0, 0)
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == old {
			wf.Nodes[i].Kind, wf.Nodes[i].Name, wf.Nodes[i].Prompt = enum.NodeTalk, "討論需求", presets.Talk[model.LanguageZh]
		}
	}
	localizeFlow(wf, model.LanguageEn)
	for _, n := range wf.Nodes {
		switch n.ID {
		case old:
			if n.Name != "討論需求" || n.Prompt != presets.Talk[model.LanguageEn] {
				t.Fatalf("%+v", n)
			}
		case presetNodeID(wf.ID, 1, 0):
			if n.Name != "Fix" {
				t.Fatalf("%+v", n)
			}
		}
	}
}

// A user's flow keeps the Start and End templates in whichever language is picked, from any language to any other.
func TestLocalizeFlowMovesTemplatesBetweenEveryLanguage(t *testing.T) {
	languages := []string{model.LanguageZh, model.LanguageEn, model.LanguageZhHans, model.LanguageJa, model.LanguageKo}
	for _, from := range languages {
		for _, to := range languages {
			wf := &model.Workflow{ID: "mine", Nodes: []model.WorkflowNode{
				{ID: "a", Kind: enum.NodeWork, Name: presets.Start.Name.in(from), Prompt: presets.Start.Prompt.in(from)},
				{ID: "b", Kind: enum.NodeTalk, Name: "my talk", Prompt: presets.Talk.in(from)},
			}}
			localizeFlow(wf, to)
			if wf.Nodes[0].Name != presets.Start.Name.in(to) || wf.Nodes[0].Prompt != presets.Start.Prompt.in(to) || wf.Nodes[1].Prompt != presets.Talk.in(to) {
				t.Errorf("%s to %s: %+v", from, to, wf.Nodes)
			}
			if wf.Nodes[1].Name != "my talk" {
				t.Errorf("%s to %s: the user's name changed to %q", from, to, wf.Nodes[1].Name)
			}
		}
	}
}

// Every built-in text comes in every language the app can be set to.
func TestPresetsHaveEveryLanguage(t *testing.T) {
	texts := []presetText{presets.Start.Name, presets.Start.Prompt, presets.End.Name, presets.End.Prompt, presets.Talk}
	for _, b := range presets.Blueprints {
		texts = append(texts, b.Name, b.Prompt)
	}
	for _, f := range presets.Flows {
		texts = append(texts, f.Name)
		for _, layer := range f.Layers {
			for _, s := range layer {
				texts = append(texts, s.Name)
				if !s.Talk {
					texts = append(texts, s.Prompt)
				}
			}
		}
	}
	for _, text := range texts {
		for language := range languageNames {
			if text[language] == "" {
				t.Errorf("%s missing in %v", language, text[model.LanguageEn])
			}
		}
	}
}
