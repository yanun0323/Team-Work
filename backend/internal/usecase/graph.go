package usecase

import (
	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
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

func taskNodeOf(wf *model.Workflow) *model.WorkflowNode {
	for i := range wf.Nodes {
		if wf.Nodes[i].Kind == enum.NodeTask {
			return &wf.Nodes[i]
		}
	}
	return nil
}

// endNodeOf is the step a flow ends with (驗收): the last work step that hands on to nothing.
func endNodeOf(wf *model.Workflow) *model.WorkflowNode {
	for i := len(wf.Nodes) - 1; i >= 0; i-- {
		n := &wf.Nodes[i]
		if n.Kind == enum.NodeWork && len(outEdges(wf, n.ID)) == 0 {
			return n
		}
	}
	return nil
}

// isFixed tells 整理需求 and 驗收, which the task's owner works on instructions of their own.
func isFixed(wf *model.Workflow, id string) bool {
	if n := nodeOf(wf, id); n != nil && n.Kind == enum.NodeTask {
		return true
	}
	end := endNodeOf(wf)
	return end != nil && end.ID == id
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

// checkWorkflow refuses a flow that could not run: it starts at one task node, every edge joins two of
// its nodes, it has no cycle, and every node can be reached.
func checkWorkflow(wf *model.Workflow) error {
	starts := 0
	seen := map[string]bool{}
	for _, n := range wf.Nodes {
		if n.ID == "" || seen[n.ID] {
			return model.Errorf(model.CodeInvalid, "任務流程的節點 id 重複或是空的")
		}
		seen[n.ID] = true
		if n.Kind == enum.NodeTask {
			starts++
		}
	}
	if starts != 1 {
		return model.Errorf(model.CodeInvalid, "任務流程要剛好有一個任務節點")
	}
	for _, e := range wf.Edges {
		if !seen[e.From] || !seen[e.To] {
			return model.Errorf(model.CodeInvalid, "任務流程的連線接到不存在的節點")
		}
		if canReach(wf, e.To, e.From) {
			return model.Errorf(model.CodeInvalid, "任務流程不能有迴圈")
		}
	}
	start := taskNodeOf(wf)
	for _, n := range wf.Nodes {
		if !canReach(wf, start.ID, n.ID) {
			return model.Errorf(model.CodeInvalid, "節點「%s」接不到任務流程起點", n.Name)
		}
	}
	return nil
}
