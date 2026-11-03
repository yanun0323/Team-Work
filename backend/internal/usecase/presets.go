package usecase

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

// Where steps sit in a flow's drawing, as the frontend lays them out.
const (
	layoutDX = 240
	layoutDY = 200
)

// presets.json holds the built-in blueprints and flows in every language, for the backend and the simulator alike.
//
//go:embed presets.json
var presetsJSON []byte

type presetText struct {
	Zh string `json:"zh"`
	En string `json:"en"`
}

func (t presetText) in(language string) string {
	if language == model.LanguageEn {
		return t.En
	}
	return t.Zh
}

type presetStep struct {
	Name   presetText `json:"name"`
	Prompt presetText `json:"prompt"`
	Talk   bool       `json:"talk"`
}

type presetBlueprint struct {
	ID     string      `json:"id"`
	Name   presetText  `json:"name"`
	Prompt presetText  `json:"prompt"`
	Tools  []enum.Tool `json:"tools"`
	Look   model.Look  `json:"look"`
}

// presetFlow lists a flow's steps between its two ends, by layer: the steps of a layer run side by side, and each
// gets everything from the layer before.
type presetFlow struct {
	ID     string         `json:"id"`
	Name   presetText     `json:"name"`
	Layers [][]presetStep `json:"layers"`
}

var presets = func() (p struct {
	SkillFolders []string          `json:"skillFolders"`
	Start        presetStep        `json:"start"`
	End          presetStep        `json:"end"`
	Talk         presetText        `json:"talk"`
	Blueprints   []presetBlueprint `json:"blueprints"`
	Flows        []presetFlow      `json:"flows"`
}) {
	if err := json.Unmarshal(presetsJSON, &p); err != nil {
		panic(err)
	}
	return p
}()

// What the fixed steps are told, in English like every instruction an employee receives.
var (
	StartPrompt = presets.Start.Prompt.En
	EndPrompt   = presets.End.Prompt.En
	TalkPrompt  = presets.Talk.En
)

func presetNodeID(flow string, layer, step int) string {
	return fmt.Sprintf("%s-%d-%d", flow, layer, step)
}

// presetSkillFolders are the folders the built-in blueprints read skills from; the preferences can leave out the
// Codex and Claude ones.
func presetSkillFolders(prefs model.Preferences) []string {
	var out []string
	for _, path := range presets.SkillFolders {
		if (path == "~/.codex/" && !prefs.CodexSkills) || (path == "~/.claude/" && !prefs.ClaudeSkills) {
			continue
		}
		out = append(out, path)
	}
	return out
}

// projectPacks are a company's own skills, in the same folders as presetSkillFolders but inside dir, the folder its
// employees work in. Every blueprint reads them, ahead of its own packs, so a skill of the project wins over one by
// the same name elsewhere.
func projectPacks(dir string, prefs model.Preferences) []packRoot {
	var out []packRoot
	for _, path := range presetSkillFolders(prefs) {
		out = append(out, packRoot{source: model.BlueprintSource{Kind: "local", Path: filepath.Join(dir, strings.TrimPrefix(path, "~/"))}})
	}
	return out
}

func (p presetBlueprint) in(language string, folders []string) *model.Blueprint {
	skills := make([]model.SkillPack, len(folders))
	for i, path := range folders {
		skills[i] = model.SkillPack{Source: &model.BlueprintSource{Kind: "local", Path: path}, Exclude: []string{}}
	}
	return &model.Blueprint{ID: p.ID, Name: p.Name.in(language), Prompt: p.Prompt.in(language), Tools: p.Tools, Skills: skills, Look: p.Look,
		Source: model.BlueprintSource{Kind: model.SourcePreset}}
}

func (p presetFlow) in(language string) *model.Workflow {
	node := func(id string, kind enum.NodeKind, s presetStep, pos model.Point) model.WorkflowNode {
		return model.WorkflowNode{ID: id, Kind: kind, Name: s.Name.in(language), Prompt: s.Prompt.in(language), ReplicaIDs: []string{},
			Assignment: enum.AssignFirstAvailable, Handoff: enum.HandoffAll, Join: enum.JoinAll, Pos: pos}
	}
	start, end := p.ID+"-start", p.ID+"-end"
	wf := &model.Workflow{ID: p.ID, Name: p.Name.in(language), Nodes: []model.WorkflowNode{
		node(start, enum.NodeTask, presets.Start, model.Point{}),
		node(end, enum.NodeWork, presets.End, model.Point{Y: float64(len(p.Layers)+1) * layoutDY}),
	}}
	seq := 0
	link := func(from, to []string) {
		for _, f := range from {
			for _, t := range to {
				seq++
				wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: fmt.Sprintf("%s-e%d", p.ID, seq), From: f, To: t})
			}
		}
	}
	prev := []string{start}
	for i, layer := range p.Layers {
		ids := make([]string, len(layer))
		for j, s := range layer {
			ids[j] = presetNodeID(p.ID, i, j)
			kind := enum.NodeWork
			if s.Talk {
				kind, s.Prompt = enum.NodeTalk, presets.Talk
			}
			wf.Nodes = append(wf.Nodes, node(ids[j], kind, s, model.Point{X: (float64(j) - float64(len(layer)-1)/2) * layoutDX, Y: float64(i+1) * layoutDY}))
		}
		link(prev, ids)
		prev = ids
	}
	link(prev, []string{end})
	return wf
}

// localizeFlow puts what the app itself wrote in a flow into a language: all of a built-in flow, and in any flow the
// instructions of the fixed steps and discussions, and the two ends' names unless they were renamed by hand.
// What a user wrote stays as written. Tasks' copies of a flow go through here too.
func localizeFlow(wf *model.Workflow, language string) {
	steps := map[string]presetStep{}
	for _, f := range presets.Flows {
		if f.ID != wf.ID {
			continue
		}
		for i, layer := range f.Layers {
			for j, s := range layer {
				steps[presetNodeID(f.ID, i, j)] = s
			}
		}
		wf.Name = f.Name.in(language)
	}
	for i := range wf.Nodes {
		n := &wf.Nodes[i]
		// a task's copy from before the flow changed may hold another step at this place, so the name must match too
		if s, ok := steps[n.ID]; ok && (n.Name == s.Name.Zh || n.Name == s.Name.En) {
			n.Name, n.Prompt = s.Name.in(language), s.Prompt.in(language)
		}
		switch {
		case n.Kind == enum.NodeTalk:
			n.Prompt = presets.Talk.in(language)
		case isFixed(wf, n.ID):
			fixed := presets.End
			if n.Kind == enum.NodeTask {
				fixed = presets.Start
			}
			n.Prompt = fixed.Prompt.in(language)
			if n.Name == fixed.Name.Zh || n.Name == fixed.Name.En {
				n.Name = fixed.Name.in(language)
			}
		}
	}
}

// installPresets puts the built-in blueprints and flows into the world in the language picked. They live here, never in
// the settings files, and the user's own flows follow the same language for what the app wrote in them.
func (e *Engine) installPresets() {
	folders := presetSkillFolders(e.w.Preferences)
	for _, p := range presets.Blueprints {
		e.w.Blueprints[p.ID] = p.in(e.w.Language, folders)
	}
	for _, wf := range e.w.Workflows {
		localizeFlow(wf, e.w.Language)
	}
	for _, p := range presets.Flows {
		e.w.Workflows[p.ID] = p.in(e.w.Language)
	}
}

func isPresetBlueprint(id string) bool {
	for _, p := range presets.Blueprints {
		if p.ID == id {
			return true
		}
	}
	return false
}

// agentFlow is a flow as employees are told it: what the app wrote is always in English.
func agentFlow(wf *model.Workflow) *model.Workflow {
	c := clone(*wf)
	localizeFlow(&c, model.LanguageEn)
	return &c
}

// agentRole is a blueprint's prompt as employees are told it: a built-in one in English, a user's as written.
func agentRole(bp *model.Blueprint) string {
	for _, p := range presets.Blueprints {
		if p.ID == bp.ID {
			return p.Prompt.En
		}
	}
	return bp.Prompt
}
