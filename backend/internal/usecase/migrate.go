package usecase

import (
	"fmt"
	"slices"
	"strings"

	"github.com/yanun0323/mho-company/internal/model"
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
