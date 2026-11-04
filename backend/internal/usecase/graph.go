package usecase

import (
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
)

func outEdges(wf *model.Workflow, id string) []model.WorkflowEdge {
	var out []model.WorkflowEdge
	for _, e := range wf.Edges {
		if e.From == id {
			out = append(out, e)
		}
	}
	return out
}

func inEdges(wf *model.Workflow, id string) []model.WorkflowEdge {
	var out []model.WorkflowEdge
	for _, e := range wf.Edges {
		if e.To == id {
			out = append(out, e)
		}
	}
	return out
}

func nodeOf(wf *model.Workflow, id string) *model.WorkflowNode {
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == id {
			return &wf.Nodes[i]
		}
	}
	return nil
}

// startsOf are the steps a flow starts with: those nothing hands on to. A task starts them all at once.
func startsOf(wf *model.Workflow) []*model.WorkflowNode {
	var out []*model.WorkflowNode
	for i := range wf.Nodes {
		if len(inEdges(wf, wf.Nodes[i].ID)) == 0 {
			out = append(out, &wf.Nodes[i])
		}
	}
	return out
}

// canSendBack is whether a step may be let send work back: a work step with one step before it, whose work goes
// only to this one, so redoing it holds up nothing else.
func canSendBack(wf *model.Workflow, id string) bool {
	n := nodeOf(wf, id)
	ins := inEdges(wf, id)
	return n != nil && n.Kind == enum.NodeWork && len(ins) == 1 && feedsOnly(wf, ins[0].From, id)
}

func canReach(wf *model.Workflow, from, to string) bool {
	seen := map[string]bool{}
	stack := []string{from}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id == to {
			return true
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		for _, e := range outEdges(wf, id) {
			stack = append(stack, e.To)
		}
	}
	return false
}

// feedsOnly is whether every path out of id passes through target, so it only exists to feed it.
func feedsOnly(wf *model.Workflow, id, target string) bool {
	if id == target {
		return false
	}
	seen := map[string]bool{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		outs := outEdges(wf, cur)
		if len(outs) == 0 {
			return false
		}
		for _, e := range outs {
			if e.To != target {
				stack = append(stack, e.To)
			}
		}
	}
	return true
}

// checkWorkflow refuses a flow that could not run: it has steps, every edge joins two of its nodes, and it has no
// cycle, so every step can be reached from a start.
func checkWorkflow(wf *model.Workflow) error {
	if len(wf.Nodes) == 0 {
		return model.Errorf(model.CodeInvalid, "任務藍圖至少要有一個步驟")
	}
	seen := map[string]bool{}
	for _, n := range wf.Nodes {
		if n.ID == "" || seen[n.ID] {
			return model.Errorf(model.CodeInvalid, "任務藍圖的節點 id 重複或是空的")
		}
		seen[n.ID] = true
	}
	for _, e := range wf.Edges {
		if !seen[e.From] || !seen[e.To] {
			return model.Errorf(model.CodeInvalid, "任務藍圖的連線接到不存在的節點")
		}
		if canReach(wf, e.To, e.From) {
			return model.Errorf(model.CodeInvalid, "任務藍圖不能有迴圈")
		}
	}
	return nil
}
