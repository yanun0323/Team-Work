package usecase

import (
	"fmt"
	"slices"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
)

// shareFlows moves flows saved when each company had its own to the shared list. Flows with the same content
// become one; flows sharing a name but not their content keep apart, each named after its company. Flows name no
// staff any more, and tasks keep the copy they started with. owners holds the company of each old flow.
func (e *Engine) shareFlows(owners map[string]string) {
	ids := make([]string, 0, len(owners))
	for id := range owners {
		ids = append(ids, id)
	}
	slices.Sort(ids)

	contents := map[string][]string{} // name -> its different contents, first seen first
	kept := map[string]string{}       // name and content -> the flow that stays
	merged := map[string]string{}     // old flow -> the flow that stays
	for _, id := range ids {
		wf := e.w.Workflows[id]
		content := flowContent(wf)
		if !slices.Contains(contents[wf.Name], content) {
			contents[wf.Name] = append(contents[wf.Name], content)
		}
		key := wf.Name + "\x00" + content
		if kept[key] == "" {
			kept[key] = id
		}
		merged[id] = kept[key]
	}

	taken := map[string]bool{}
	for id := range e.w.Workflows {
		if _, old := owners[id]; !old {
			taken[e.w.Workflows[id].Name] = true
		}
	}
	for _, id := range ids {
		wf := e.w.Workflows[id]
		if merged[id] != id {
			delete(e.w.Workflows, id)
			continue
		}
		name := wf.Name
		if len(contents[wf.Name]) > 1 {
			if team := e.w.Teams[owners[id]]; team != nil {
				name = fmt.Sprintf("%s（%s）", wf.Name, team.Name)
			}
		}
		wf.Name = freeName(name, taken)
		taken[wf.Name] = true
		for i := range wf.Nodes {
			wf.Nodes[i].ReplicaIDs = []string{}
		}
	}
	for _, t := range e.w.Teams {
		if to, ok := merged[t.DefaultWorkflowID]; ok {
			t.DefaultWorkflowID = to
		}
	}
	for _, t := range e.w.Tasks {
		if to, ok := merged[t.WorkflowID]; ok {
			t.WorkflowID = to
		}
	}
}

// freeName is name, or name-2, -3… when it is taken.
func freeName(name string, taken map[string]bool) string {
	free := name
	for n := 2; taken[free]; n++ {
		free = fmt.Sprintf("%s-%d", name, n)
	}
	return free
}

// flowContent writes what a flow does, leaving out ids (each copy has its own), staff and where notes sit.
func flowContent(wf *model.Workflow) string {
	at := map[string]int{}
	var b strings.Builder
	for i, n := range wf.Nodes {
		at[n.ID] = i
		fmt.Fprintf(&b, "%q %q %q %q %q %q\n", n.Kind, n.Name, n.Prompt, n.Assignment, n.Handoff, n.Join)
	}
	edges := make([]string, len(wf.Edges))
	for i, x := range wf.Edges {
		edges[i] = fmt.Sprintf("%d %d %q", at[x.From], at[x.To], x.Condition)
	}
	slices.Sort(edges)
	return b.String() + strings.Join(edges, "\n")
}

// oldPresetPrompts maps each prompt the presets used to ship to the one replacing it.
var oldPresetPrompts = map[string]string{
	"根據上游節點的執行成果、以及下游節點的需求內容來進行討論":         TalkPrompt,
	"讀懂任務，整理目標、範圍與驗收條件，交給下一個節點。":           StartPrompt,
	"對照驗收條件檢查成果；符合就交給使用者，不符合就退回前一步重做。":     EndPrompt,
	"把需求寫成規格：範圍、不做的事、驗收條件。":                "根據上一步的整理，把需求寫成規格，放進 docs/，讓後面的人不用再問就能動手。\n\n規格要包含：要解決的問題、範圍、不做的事、主要流程、邊界與錯誤情況，以及可以逐條驗證的驗收條件。只寫要達成什麼，不談實作細節。\n\n交接時列出規格檔案的路徑，並把驗收條件原文帶給下一步。",
	"依規格拆成前端和後端的工作，定好兩邊之間的介面。":             "讀規格和相關程式，把工作拆成前端和後端兩份，並定好兩邊之間的介面（API 路徑、參數、回應和錯誤格式），讓兩邊可以同時開工，不用互相等。\n\n兩邊共用同一個工作目錄，所以要分清楚各自改哪些檔案，避免改到同一處。\n\n交接時分別寫出前端和後端要做的事、介面定義和先後限制。某一邊沒有工作就明說。把驗收條件原文帶給下一步。",
	"依規格實作後端並附測試，小步提交。這次沒有後端工作就說明原因，直接交接。": "照規格和上一步定好的介面實作後端。先讀現有架構，沿用專案的慣例，只改這次需要的部分，不要動前端的檔案。\n\n新增或修改的行為都要有測試，包含錯誤與邊界情況；交接前跑過測試，確認通過。\n\n交接時寫清楚做了什麼、怎麼驗證，以及介面有沒有變動。這次沒有後端工作就說明原因，直接交接。把驗收條件原文帶給下一步。",
	"依規格實作前端並附測試，小步提交。這次沒有前端工作就說明原因，直接交接。": "照規格和上一步定好的介面實作前端。先看現有元件和樣式，能重用就不新寫，只改這次需要的部分，不要動後端的檔案。\n\n要處理載入中、空資料和錯誤狀態。新增或修改的行為都要有測試；交接前跑過測試和建置，確認通過。\n\n交接時寫清楚做了什麼、怎麼驗證，以及介面有沒有變動。這次沒有前端工作就說明原因，直接交接。把驗收條件原文帶給下一步。",
	"照驗收條件實際驗證，寫下每一條的結果和發現的問題。":            "照驗收條件逐條實際驗證，不要只讀程式：跑測試和建置，也實際操作功能，再試邊界與錯誤情況。\n\n每一條都寫下通過或不通過，以及依據。發現問題時寫下重現步驟、預期與實際結果。這一步只驗證和補測試，不修改產品程式。\n\n交接時把每一條的結果、發現的問題和驗收條件原文帶給下一步。",
	"寫一個會失敗的測試重現問題，找不到重現方式就說明試過什麼。":        "根據任務描述重現問題：確認實際行為和預期行為，找出最小的重現步驟，再寫一個會因為這個問題而失敗的測試。這一步不修正問題。\n\n交接時寫清楚重現步驟、測試的位置、失敗訊息，以及你對原因的初步判斷（寫明只是判斷）。把驗收條件原文帶給下一步。\n\n試過仍無法重現時，寫下試過什麼、環境和結果；缺少資訊就用 ask_user 問使用者。",
	"找出根本原因，讓失敗的測試通過，不改無關的程式。":             "找出問題的根本原因，從原因修正，不要只處理表面症狀，也不要為了通過測試而改測試的預期。不改無關的程式，也不順手重構。\n\n修好後，上一步的測試要通過；也檢查其他地方有沒有同樣的問題。\n\n交接時寫清楚根本原因、改了什麼、為什麼這樣改、可能受影響的範圍。把驗收條件原文帶給下一步。",
	"跑完整測試，確認問題已修好，相關功能也沒有壞。":              "確認問題真的修好了：照重現步驟再走一次，並跑完整測試和建置。再實際檢查這次修改影響到的相關功能，確認沒有被改壞。\n\n任何失敗都要寫下重現步驟、預期與實際結果，並判斷是否和這次修改有關。這一步只驗證，不修改產品程式。\n\n交接時寫下每項檢查的結果，並把驗收條件原文帶給下一步。",
	"把討論的結論寫成規格，放進 docs/：範圍、不做的事、驗收條件。":    "把上一步討論的結論寫成規格，放進 docs/，不要加入討論中沒有談定的需求；沒談到但必須決定的地方，列為待確認。\n\n規格要包含：要解決的問題和對象、範圍、不做的事、主要流程、邊界與錯誤情況，以及可以逐條驗證的驗收條件。\n\n交接時列出規格檔案的路徑和待確認事項，並把驗收條件原文帶給下一步。",
	"把規格拆成可以各自完成的工作，排好順序，標出風險。":            "把規格拆成可以各自完成、各自驗證的工作，寫進 docs/。\n\n每項工作要寫：要做什麼、做到什麼程度算完成、依賴哪些工作。再排好先後順序，標出哪些可以同時進行，並列出風險和因應方式。這一步只做規劃，不寫產品程式。\n\n交接時列出文件路徑和最需要使用者決定的事，並把驗收條件原文帶給下一步。",
}

// refreshPresetPrompts gives saved flows the current preset prompts. A prompt the user edited matches nothing and
// stays, and tasks keep the copy they started with.
func (e *Engine) refreshPresetPrompts() {
	for _, wf := range e.w.Workflows {
		for i := range wf.Nodes {
			if next, old := oldPresetPrompts[wf.Nodes[i].Prompt]; old {
				wf.Nodes[i].Prompt = next
			}
		}
	}
}

// oldPresetBlueprintPrompts holds the prompts preset blueprints were saved with before they were written out in full.
var oldPresetBlueprintPrompts = map[string]string{
	"PM":                "你是專案經理。把目標拆成可以各自完成的工作，排好先後順序，標出風險與相依。\n不確定的地方提出來，不要自己假設。交接時寫清楚誰該做什麼、做到什麼程度算完成。",
	"Product":           "你是產品負責人。先弄清楚使用者是誰、要解決什麼問題，再寫規格。\n規格要有範圍、不做的事和可以驗證的驗收條件，不談實作細節。",
	"Backend Engineer":  "你是後端工程師。先讀懂現有架構再動手，沿用專案的慣例。\n改動要附測試，處理錯誤與邊界情況，提交前跑過測試。介面有變動時寫進交接。",
	"Frontend Engineer": "你是前端工程師。先看現有元件和樣式，能重用就不新寫。\n顧到鍵盤操作、對比和各種畫面寬度，也要處理載入中、空資料和錯誤狀態。提交前跑過測試和建置。",
	"QA":                "你是測試工程師。照驗收條件逐項驗證，再試邊界與錯誤情況，實際執行而不是只讀程式。\n每個問題都寫下重現步驟、預期與實際結果。不修產品程式，只補測試。",
}

// refreshPresetBlueprints brings saved preset blueprints up to date. One the user changed in any way stays as it is,
// and employees keep their blueprint, as it is the same one.
func (e *Engine) refreshPresetBlueprints() {
	for _, b := range e.w.Blueprints {
		if b.Prompt != oldPresetBlueprintPrompts[b.Name] || b.Prompt == "" || len(b.Skills) > 0 || b.Source.Kind != "yaml" {
			continue
		}
		for _, p := range presetBlueprints {
			if p.name == b.Name {
				b.Prompt, b.Skills, b.Source.Text = p.prompt, presetSkills(), p.yaml()
			}
		}
	}
}

// addWorkStep runs once per data folder, for a default flow saved when it had only its two ends. Afterwards a user
// who removes the step keeps it removed. Tasks keep the copy they started with.
func (e *Engine) addWorkStep() {
	for _, wf := range e.w.Workflows {
		if (wf.Name != defaultFlowName && wf.Name != "預設流程") || len(wf.Nodes) != 2 || len(wf.Edges) != 1 {
			continue
		}
		id := e.uid("n")
		wf.Nodes = append(wf.Nodes, model.WorkflowNode{ID: id, Kind: enum.NodeWork, Name: workStep.name, Prompt: workStep.prompt, ReplicaIDs: []string{},
			Assignment: enum.AssignFirstAvailable, Handoff: enum.HandoffAll, Join: enum.JoinAll, Pos: model.Point{Y: layoutDY}})
		wf.Nodes[1].Pos = model.Point{Y: 2 * layoutDY}
		to := wf.Edges[0].To
		wf.Edges[0].To = id
		e.link(wf, []string{id}, []string{to})
	}
	e.w.WorkStep = true
}
