package usecase

import (
	_ "embed"
	"encoding/json"
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

// presets.json holds what the app itself writes in every language, and the airport staff's blueprint, for the backend
// and the simulator alike.
//
//go:embed presets.json
var presetsJSON []byte

// presetText is one text in every language the app shows, by language code.
type presetText map[string]string

func (t presetText) in(language string) string {
	if text, ok := t[language]; ok {
		return text
	}
	return t[model.LanguageZh]
}

// is reports whether s is this text in any language.
func (t presetText) is(s string) bool {
	for _, text := range t {
		if s == text {
			return true
		}
	}
	return false
}

type presetStep struct {
	Name   presetText `json:"name"`
	Prompt presetText `json:"prompt"`
}

type presetBlueprint struct {
	ID     string      `json:"id"`
	Name   presetText  `json:"name"`
	Prompt presetText  `json:"prompt"`
	Tools  []enum.Tool `json:"tools"`
	Look   model.Look  `json:"look"`
}

var presets = func() (p struct {
	SkillFolders []string          `json:"skillFolders"`
	Start        presetStep        `json:"start"`
	End          presetStep        `json:"end"`
	Talk         presetText        `json:"talk"`
	Blueprints   []presetBlueprint `json:"blueprints"`
	// Looks are what a blueprint an employee makes can look like.
	Looks []model.Look `json:"looks"`
}) {
	if err := json.Unmarshal(presetsJSON, &p); err != nil {
		panic(err)
	}
	return p
}()

// Instructions the app wrote, in English like every instruction an employee receives. Start and End are templates
// for a flow's first and last steps: flows from before a flow could start and end anywhere began and ended with them.
var (
	StartPrompt = presets.Start.Prompt[model.LanguageEn]
	EndPrompt   = presets.End.Prompt[model.LanguageEn]
	TalkPrompt  = presets.Talk[model.LanguageEn]
)

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

// localizeFlow puts what the app itself wrote in any flow into a language: the instructions of discussions, and a
// step's name and instructions while they are still the Start or End template's. What a user wrote stays as written.
// Tasks' copies of a flow go through here too.
func localizeFlow(wf *model.Workflow, language string) {
	for i := range wf.Nodes {
		n := &wf.Nodes[i]
		switch {
		case n.Kind == enum.NodeTalk:
			n.Prompt = presets.Talk.in(language)
		case n.Kind == enum.NodeTask:
			n.Prompt = presets.Start.Prompt.in(language)
			fallthrough
		default:
			for _, fixed := range []presetStep{presets.Start, presets.End} {
				if fixed.Prompt.is(n.Prompt) {
					n.Prompt = fixed.Prompt.in(language)
				}
				if fixed.Name.is(n.Name) {
					n.Name = fixed.Name.in(language)
				}
			}
		}
	}
}

// installPresets puts the built-in blueprints into the world in the language picked. They live here, never in the
// settings files, and every flow follows the same language for what the app wrote in it. The blueprints and flows the
// app comes with are the official source's; only the airport staff's is built in.
func (e *Engine) installPresets() {
	folders := presetSkillFolders(e.w.Preferences)
	for _, p := range presets.Blueprints {
		e.w.Blueprints[p.ID] = p.in(e.w.Language, folders)
	}
	for _, wf := range e.w.Workflows {
		settleStarts(wf)
		settleStaff(wf)
		localizeFlow(wf, e.w.Language)
	}
}

// settleStarts turns the 整理需求 start of a flow from before a flow could start anywhere into a step like any other,
// keeping its name and instructions. Tasks' copies keep it as it was.
func settleStarts(wf *model.Workflow) {
	for i := range wf.Nodes {
		if wf.Nodes[i].Kind == enum.NodeTask {
			wf.Nodes[i].Kind = enum.NodeWork
		}
	}
}

// settleStaff keeps the first employee of a work step from before a work step had one, and drops how it chose
// among them. A discussion keeps them all: they hold it as a meeting.
func settleStaff(wf *model.Workflow) {
	for i := range wf.Nodes {
		n := &wf.Nodes[i]
		n.Assignment = ""
		if n.Kind != enum.NodeTalk && len(n.ReplicaIDs) > 1 {
			n.ReplicaIDs = n.ReplicaIDs[:1]
		}
	}
}

// crowdedStep names a work step given more than one employee, which only a discussion can have; "" when there is none.
func crowdedStep(wf *model.Workflow) string {
	for _, n := range wf.Nodes {
		if n.Kind != enum.NodeTalk && len(n.ReplicaIDs) > 1 {
			return n.Name
		}
	}
	return ""
}
