package usecase

import (
	"fmt"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

// Where steps sit in a flow's drawing, as the frontend lays them out.
const (
	layoutDX = 240
	layoutDY = 200
)

const defaultFlowName = "預設任務流程"

type presetBlueprint struct {
	name, prompt string
	tools        []enum.Tool
	look         model.Look
}

var (
	readWrite = []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile}
	research  = []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch}
	build     = []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolWebSearch, enum.ToolRunCommand}
	verify    = []enum.Tool{enum.ToolReadFile, enum.ToolWriteFile, enum.ToolRunCommand}
)

func presetLook(skin, hair, shirt, pants, extra string) model.Look {
	return model.Look{Skin: skin, Hair: hair, Shirt: shirt, Pants: pants, Extra: extra}
}

var presetBlueprints = []presetBlueprint{
	{"PM", "你是專案經理。把目標拆成可以各自完成的工作，排好先後順序，標出風險與相依。\n不確定的地方提出來，不要自己假設。交接時寫清楚誰該做什麼、做到什麼程度算完成。", readWrite, presetLook("#f2c9a0", "#2b1d14", "#e0a030", "#3a3550", "none")},
	{"Product", "你是產品負責人。先弄清楚使用者是誰、要解決什麼問題，再寫規格。\n規格要有範圍、不做的事和可以驗證的驗收條件，不談實作細節。", research, presetLook("#e0ac7e", "#8a3b2a", "#d9577a", "#2d3550", "glasses")},
	{"Backend Engineer", "你是後端工程師。先讀懂現有架構再動手，沿用專案的慣例。\n改動要附測試，處理錯誤與邊界情況，提交前跑過測試。介面有變動時寫進交接。", build, presetLook("#c68a5a", "#1c1c1c", "#3f7d5a", "#2a2a33", "headset")},
	{"Frontend Engineer", "你是前端工程師。先看現有元件和樣式，能重用就不新寫。\n顧到鍵盤操作、對比和各種畫面寬度，也要處理載入中、空資料和錯誤狀態。提交前跑過測試和建置。", build, presetLook("#f2c9a0", "#c99a4a", "#4f7cff", "#2d3550", "cap")},
	{"QA", "你是測試工程師。照驗收條件逐項驗證，再試邊界與錯誤情況，實際執行而不是只讀程式。\n每個問題都寫下重現步驟、預期與實際結果。不修產品程式，只補測試。", verify, presetLook("#8d5a3b", "#1c1c1c", "#8a5fc7", "#3a3550", "sunglasses")},
}

type presetStep struct{ name, prompt string }

// presetFlows lists each flow's steps between its two ends, by layer: the steps of a layer run side by side, and
// each gets everything from the layer before.
var presetFlows = []struct {
	name   string
	layers [][]presetStep
}{
	{defaultFlowName, nil},
	{"功能開發", [][]presetStep{
		{{"撰寫規格", "把需求寫成規格：範圍、不做的事、驗收條件。"}},
		{{"拆解工作", "依規格拆成前端和後端的工作，定好兩邊之間的介面。"}},
		{{"後端開發", "依規格實作後端並附測試，小步提交。這次沒有後端工作就說明原因，直接交接。"}, {"前端開發", "依規格實作前端並附測試，小步提交。這次沒有前端工作就說明原因，直接交接。"}},
		{{"測試", "照驗收條件實際驗證，寫下每一條的結果和發現的問題。"}},
	}},
	{"修 Bug", [][]presetStep{
		{{"重現問題", "寫一個會失敗的測試重現問題，找不到重現方式就說明試過什麼。"}},
		{{"修正", "找出根本原因，讓失敗的測試通過，不改無關的程式。"}},
		{{"回歸測試", "跑完整測試，確認問題已修好，相關功能也沒有壞。"}},
	}},
	{"產品規劃", [][]presetStep{
		{{"討論需求", TalkPrompt}},
		{{"撰寫規格", "把討論的結論寫成規格，放進 docs/：範圍、不做的事、驗收條件。"}},
		{{"拆解工作", "把規格拆成可以各自完成的工作，排好順序，標出風險。"}},
	}},
}

func (b presetBlueprint) yaml() string {
	names := map[enum.Tool]string{enum.ToolReadFile: "read_file", enum.ToolWriteFile: "write_file", enum.ToolWebSearch: "web_search", enum.ToolRunCommand: "run_command"}
	tools := make([]string, len(b.tools))
	for i, t := range b.tools {
		tools[i] = names[t]
	}
	prompt := "  " + strings.ReplaceAll(b.prompt, "\n", "\n  ")
	return fmt.Sprintf("name: %s\nprompt: |\n%s\ntools: [%s]\n", b.name, prompt, strings.Join(tools, ", "))
}

// addPresets runs once per data folder, so what the user deletes stays deleted. A name already in use is left alone.
func (e *Engine) addPresets() {
	taken := map[string]bool{}
	for _, b := range e.w.Blueprints {
		taken[b.Name] = true
	}
	for _, p := range presetBlueprints {
		if taken[p.name] {
			continue
		}
		id := e.uid("bp")
		e.w.Blueprints[id] = &model.Blueprint{ID: id, Name: p.name, Prompt: p.prompt, Tools: p.tools, Skills: []model.SkillPack{}, Look: p.look,
			Source: model.BlueprintSource{Kind: "yaml", Text: p.yaml()}}
	}
	flows := map[string]bool{}
	for _, wf := range e.w.Workflows {
		flows[wf.Name] = true
	}
	for _, p := range presetFlows {
		if !flows[p.name] {
			e.presetFlow(p.name, p.layers)
		}
	}
	e.w.Presets = true
}

func (e *Engine) presetFlow(name string, layers [][]presetStep) {
	wf := e.newWorkflow(name)
	start, end := wf.Nodes[0], wf.Nodes[1]
	wf.Edges = nil
	prev := []string{start.ID}
	for i, layer := range layers {
		ids := make([]string, len(layer))
		for j, s := range layer {
			kind := enum.NodeWork
			if s.prompt == TalkPrompt {
				kind = enum.NodeTalk
			}
			ids[j] = e.uid("n")
			wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: ids[j], Kind: kind, Name: s.name, Prompt: s.prompt, ReplicaIDs: []string{},
				Assignment: enum.AssignFirstAvailable, Handoff: enum.HandoffAll, Join: enum.JoinAll,
				Pos: model.Point{X: (float64(j) - float64(len(layer)-1)/2) * layoutDX, Y: float64(i+1) * layoutDY}})
		}
		e.link(wf, prev, ids)
		prev = ids
	}
	e.link(wf, prev, []string{end.ID})
	wf.Nodes[1].Pos = model.Point{Y: float64(len(layers)+1) * layoutDY}
}

func (e *Engine) link(wf *model.Workflow, from, to []string) {
	for _, f := range from {
		for _, t := range to {
			wf.Edges = append(wf.Edges, model.WorkflowEdge{ID: e.uid("e"), From: f, To: t})
		}
	}
}
