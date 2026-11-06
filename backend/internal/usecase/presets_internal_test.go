package usecase

import (
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func officialFlow(t *testing.T, name string) sourcedFlow {
	t.Helper()
	for _, f := range sourcedFiles(officialFS, sourcedWorkflows) {
		if f.name == name {
			wf, err := readSourcedWorkflow(OfficialSourceID, f.name, f.raw)
			if err != nil {
				t.Fatal(err)
			}
			return wf
		}
	}
	t.Fatalf("no flow %s", name)
	return sourcedFlow{}
}

func TestLocalizeFlowLeavesStepsThatMovedInATaskCopy(t *testing.T) {
	// a task copied the bug fix flow and its first step was made a discussion there
	f := officialFlow(t, "bugfix")
	wf := clone(f.wf)
	f.localize(wf, model.LanguageZh)
	wf.Nodes[0].Kind, wf.Nodes[0].Name, wf.Nodes[0].Prompt = enum.NodeTalk, "討論需求", presets.Talk[model.LanguageZh]
	e := &Engine{w: model.NewWorld(), sourced: map[string]sourcedSet{OfficialSourceID: {Workflows: []sourcedFlow{f}}}}
	e.localize(wf, model.LanguageEn)
	if n := wf.Nodes[0]; n.Name != "討論需求" || n.Prompt != presets.Talk[model.LanguageEn] {
		t.Fatalf("%+v", n)
	}
	if n := wf.Nodes[1]; n.Name != "Fix" || !strings.HasPrefix(n.Prompt, "Find the root cause") {
		t.Fatalf("%+v", n)
	}
	if wf.Name != "Bug fix" {
		t.Fatal(wf.Name)
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

// Every built-in text, and every text of the official source's built-in copy, comes in every language the app can be
// set to.
func TestPresetsHaveEveryLanguage(t *testing.T) {
	texts := []presetText{presets.Start.Name, presets.Start.Prompt, presets.End.Name, presets.End.Prompt, presets.Talk}
	for _, b := range presets.Blueprints {
		texts = append(texts, b.Name, b.Prompt)
	}
	for _, text := range texts {
		for language := range languageNames {
			if text[language] == "" {
				t.Errorf("%s missing in %v", language, text[model.LanguageEn])
			}
		}
	}
	var official []sourcedText
	for _, f := range sourcedFiles(officialFS, sourcedBlueprints) {
		b, err := readSourcedBlueprint(OfficialSourceID, f.name, f.raw)
		if err != nil {
			t.Fatalf("%s: %v", f.name, err)
		}
		official = append(official, b.name, b.prompt)
	}
	for _, f := range sourcedFiles(officialFS, sourcedWorkflows) {
		wf, err := readSourcedWorkflow(OfficialSourceID, f.name, f.raw)
		if err != nil {
			t.Fatalf("%s: %v", f.name, err)
		}
		official = append(official, wf.name)
		for _, s := range wf.steps {
			official = append(official, s.name, s.prompt)
		}
	}
	if len(official) < 2*13+4 {
		t.Fatalf("%d texts", len(official))
	}
	for _, text := range official {
		for language := range languageNames {
			if strings.TrimSpace(text.texts[language]) == "" {
				t.Errorf("%s missing in %q", language, text.in(model.LanguageEn))
			}
		}
	}
}
