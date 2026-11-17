package usecase

import (
	"cmp"
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase/tools"
)

var topKey = regexp.MustCompile(`(?m)^  ([A-Za-z_]+)(\??): `)

// What every tool that gives scripts data returns has the keys its declared type says, so a script reads the fields it
// is told of; and its direct call shows the same.
func TestStructuredToolsReturnWhatTheyDeclare(t *testing.T) {
	e, _, task := logEngine(t)
	e.w.Teams["team1"] = &model.Team{ID: "team1", Name: "A", Folder: t.TempDir(), TargetBranch: "main"}
	task.TeamID, task.Number, task.Title = "team1", 1, "加功能"
	task.Workflow = model.Workflow{Nodes: []model.WorkflowNode{{ID: "n", Kind: enum.NodeWork, Name: "做"}}}
	e.w.SubTasks["s1"] = &model.SubTask{ID: "s1", TaskID: task.ID, NodeID: "n", ReplicaID: ptr("rep1"), Status: enum.StatusComplete}
	e.w.Blueprints["bp1"] = &model.Blueprint{ID: "bp1", Name: "Dev", Tools: []enum.Tool{enum.ToolReadFile}}
	e.w.Workflows["wf1"] = &model.Workflow{ID: "wf1", Name: "flow", Nodes: task.Workflow.Nodes}
	e.w.Replicas["rep1"] = &model.Replica{ID: "rep1", TeamID: "team1", Name: "Ada", BlueprintID: "bp1", Model: "m"}
	e.w.Providers["p1"] = &model.ModelProvider{ID: "p1", Name: "p", Kind: enum.ProviderCompatible, Models: []string{"m"}, Auth: model.ProviderAuth{Kind: "apiKey", KeyHint: "1234"}}
	e.w.Chats["chat1"] = &model.Chat{ID: "chat1", TeamID: "team1", ReplicaID: "rep1", Title: "t", Messages: []model.ChatMessage{{From: "user", Text: "hi"}}}
	e.addActivity(task, model.TaskActivity{Kind: "message", From: "user", Text: "hello"})
	all, _ := e.activities(task.ID)

	args := map[string]string{
		toolReadTask: `{"task_id":"t1"}`, toolReadBlueprint: `{"id":"bp1"}`, toolReadWorkflow: `{"id":"wf1"}`, toolReadEmployee: `{"id":"rep1"}`,
		toolReadCompany: `{"id":"team1"}`, toolReadProvider: `{"id":"p1"}`, toolReadChat: `{"id":"chat1"}`,
		toolReadTaskEntry: `{"activity_id":"` + all[0].ID + `"}`, toolReadStep: `{"sub_id":"s1"}`,
	}
	list := e.readingTools(manager{teamID: "team1"})
	list = append(list, e.ownerTools(&ownerRun{taskID: task.ID, r: &run{}})...)
	list = append(list, e.searchMemoryTool(func() (string, *string) { return "team1", ptr("rep1") }), e.readTerminalTool("team1"))
	args["search_memory"] = `{"query":"x"}`
	checked := map[string]bool{}
	for _, tool := range list {
		name := tool.Spec().Name
		st, ok := tool.(tools.Structured)
		if !ok {
			if sideBySide[name] {
				t.Fatalf("%s runs side by side in scripts but gives no data", name)
			}
			continue
		}
		raw := json.RawMessage(cmp.Or(args[name], `{}`))
		v, err := st.Structured(context.Background(), "", raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out, _ := json.Marshal(v)
		// the direct call shows the same: the JSON itself, or the text in it
		direct := tool.Run(context.Background(), "", raw)
		var withText struct{ Text *string }
		_ = json.Unmarshal(out, &withText)
		if direct.IsError || withText.Text == nil && direct.Text != string(out) || withText.Text != nil && direct.Text != *withText.Text {
			t.Fatalf("%s: direct %q, data %s", name, direct.Text, out)
		}
		declared := st.Returns()
		var obj map[string]any
		if strings.HasSuffix(declared, "[]") {
			var items []map[string]any
			if err := json.Unmarshal(out, &items); err != nil || len(items) == 0 {
				t.Fatalf("%s: %s %v", name, out, err)
			}
			obj = items[0]
		} else if err := json.Unmarshal(out, &obj); err != nil {
			t.Fatalf("%s: %s", name, out)
		}
		keys := map[string]bool{}
		for _, m := range topKey.FindAllStringSubmatch(declared, -1) {
			keys[m[1]] = true
			if _, ok := obj[m[1]]; !ok && m[2] == "" {
				t.Fatalf("%s: %s declared but missing from %s", name, m[1], out)
			}
		}
		for k := range obj {
			if !keys[k] {
				t.Fatalf("%s: %s returned but not declared in %s", name, k, declared)
			}
		}
		if strings.Contains(string(out), "sk-") {
			t.Fatalf("%s: %s", name, out)
		}
		checked[name] = true
	}
	want := []string{}
	for name := range sideBySide {
		// these are checked where they are made, in the tools package
		if !slices.Contains([]string{"read_file", "semantic_search", "web_search", "web_fetch"}, name) {
			want = append(want, name)
		}
	}
	for _, name := range want {
		if !checked[name] {
			t.Fatalf("%s not checked: %v", name, checked)
		}
	}
}
